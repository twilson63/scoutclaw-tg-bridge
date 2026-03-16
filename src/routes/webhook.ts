// ============================================================
// POST /webhook/telegram
//
// Receives Telegram Bot API update payloads and routes them:
//   /start           → hatch flow (validate API key or greet returning user)
//   /reset           → clear session (start fresh conversation)
//   /status          → show user info
//   anything else    → forward to Scout agent, reply with response
// ============================================================

import { Hono } from "hono";
import type { TgUpdate, TgMessage, BridgeConfig } from "../types.ts";
import { bridgeConfigCollection, tgUsersCollection } from "../adapters/ports/data.ts";
import { callScoutAgent, newSessionId } from "../adapters/scout.ts";
import { sendTelegramMessage, sendTypingAction } from "../adapters/telegram.ts";
import { portsClient } from "../adapters/ports/client.ts";

const APP_URL = process.env.APP_URL ?? "https://scout-tg-bridge.scoutos.live";

export const webhookRouter = new Hono();

// ── In-memory config cache ────────────────────────────────────
// Keeps the last successfully loaded config so a transient DB failure
// doesn't cause complete silence (we still have the bot token).
let cachedConfig: BridgeConfig | null = null;

async function getConfig(): Promise<BridgeConfig | null> {
  try {
    const cfg = await bridgeConfigCollection.get();
    if (cfg) {
      cachedConfig = cfg; // refresh cache on every successful load
      return cfg;
    }
  } catch (err) {
    console.error("[webhook] Config load failed:", err);
  }
  if (cachedConfig) {
    console.warn("[webhook] Using cached config (DB load failed)");
    return cachedConfig;
  }
  return null;
}

// ── In-memory dedup set (fast, same-process) ──────────────────
// Backed by /_ports/data for cross-restart / multi-container dedup.
// (/_ports/cache reads were returning found:false so we use data store instead.)
const processedUpdates = new Set<number>();

async function markProcessed(updateId: number): Promise<boolean> {
  if (processedUpdates.has(updateId)) return false;
  processedUpdates.add(updateId);
  if (processedUpdates.size > 1000) {
    const first = processedUpdates.values().next().value;
    if (first !== undefined) processedUpdates.delete(first);
  }
  // Persist to data store so cross-restart / multi-container dedup works
  try {
    await portsClient.post("/data/processed_updates", {
      document: {
        _id: `upd_${updateId}`,
        update_id: updateId,
        processed_at: new Date().toISOString(),
      },
    });
  } catch {
    // Non-fatal — in-memory dedup still protects this process
  }
  return true;
}

async function isAlreadyProcessed(updateId: number): Promise<boolean> {
  if (processedUpdates.has(updateId)) return true;
  try {
    const res = await portsClient.get<{ found: boolean }>(`/data/processed_updates/upd_${updateId}`);
    if (res.found) {
      processedUpdates.add(updateId);
      return true;
    }
  } catch {
    // Not found or error — treat as not processed
  }
  return false;
}

// ── POST /webhook/telegram ─────────────────────────────────────
// Bodies arrive pre-decompressed by the raw HTTP layer in index.ts.

webhookRouter.post("/telegram", async (c) => {
  let update: TgUpdate;
  try {
    update = await c.req.json<TgUpdate>();
  } catch (err) {
    console.error("[webhook] Failed to parse request body:", err);
    // Return 200 to stop Telegram retrying an unparseable payload
    return c.json({ ok: true });
  }

  // Deduplicate — Telegram retries with the same update_id on failures
  if (await isAlreadyProcessed(update.update_id)) {
    console.log(`[webhook] skipping duplicate update_id=${update.update_id}`);
    return c.json({ ok: true });
  }
  await markProcessed(update.update_id);

  // Fire and forget — ACK immediately, process async
  handleUpdate(update).catch((err) =>
    console.error("[webhook] Unhandled error in handleUpdate:", err)
  );

  return c.json({ ok: true });
});

// ── Core update handler ────────────────────────────────────────

async function handleUpdate(update: TgUpdate): Promise<void> {
  const msg = update.message;
  if (!msg || !msg.text || !msg.from) return; // ignore non-text / system messages

  const chatId = msg.chat.id;
  const fromId = msg.from.id;
  const text = msg.text.trim();

  console.log(`[webhook] update from=${fromId} chat=${chatId} text="${text.slice(0, 60)}"`);

  // Load bridge config (with in-memory fallback)
  const cfg = await getConfig();
  if (!cfg) {
    console.error("[webhook] No bridge config found in data store or cache — cannot reply");
    return;
  }

  console.log(`[webhook] config loaded, agent=${cfg.agent_template_id}`);
  const botToken = cfg.telegram_bot_token;

  // Route commands
  if (text === "/start") {
    await handleStart(botToken, chatId, fromId, msg, cfg.agent_template_id);
    return;
  }

  if (text === "/reset") {
    await handleReset(botToken, chatId, fromId);
    return;
  }

  if (text === "/status") {
    await handleStatus(botToken, chatId, fromId);
    return;
  }

  // All other messages → forward to agent
  await handleAgentMessage(botToken, chatId, fromId, text, cfg);
}

// ── /start — hatch or greet ────────────────────────────────────

async function handleStart(
  botToken: string,
  chatId: number,
  fromId: number,
  msg: TgMessage,
  agentTemplateId: string
): Promise<void> {
  await sendTypingAction({ botToken, chatId });
  console.log(`[handleStart] looking up user fromId=${fromId}`);
  const existing = await tgUsersCollection.findByTelegramId(fromId);
  console.log(`[handleStart] user lookup done, existing=${!!existing}`);

  if (existing) {
    await reply(botToken, chatId,
      `Welcome back! 🦞 Your ScoutClaw is ready.\n\nJust send me a message to continue our conversation.`
    );
    return;
  }

  console.log(`[handleStart] hatching new user`);
  // New user — hatch their ScoutClaw
  await reply(botToken, chatId,
    `👋 Hey ${msg.from?.first_name ?? "there"}!\n\n` +
    `🦞 *Hatching your ScoutClaw…*\n\n` +
    `I'm connecting you to your personal Scout agent. One moment!`,
    "Markdown"
  );

  await sendTypingAction({ botToken, chatId });

  try {
    // Provision: create a fresh session for this user
    const sessionId = newSessionId();

    // Save user record
    await tgUsersCollection.save({
      telegram_user_id: fromId,
      telegram_username: msg.from?.username,
      telegram_first_name: msg.from?.first_name,
      scout_agent_id: agentTemplateId,   // all users share the same agent; session scopes them
      scout_session_id: sessionId,
      hatched_at: new Date().toISOString(),
      last_active_at: new Date().toISOString(),
    });

    await reply(botToken, chatId,
      `✅ *Your ScoutClaw is hatched!*\n\n` +
      `You're now connected to your personal Scout agent. Just type a message to get started.\n\n` +
      `Commands:\n` +
      `• /reset — start a fresh conversation\n` +
      `• /status — show your agent info`,
      "Markdown"
    );
  } catch (err) {
    console.error("[webhook] Hatch failed:", err);
    await reply(botToken, chatId,
      `❌ Sorry, I couldn't hatch your ScoutClaw right now. Please try again in a moment.`
    );
  }
}

// ── /reset — clear session ─────────────────────────────────────

async function handleReset(
  botToken: string,
  chatId: number,
  fromId: number
): Promise<void> {
  const user = await tgUsersCollection.findByTelegramId(fromId);
  if (!user) {
    await reply(botToken, chatId, `You haven't hatched a ScoutClaw yet. Send /start to get going!`);
    return;
  }

  const newSess = newSessionId();
  await tgUsersCollection.updateSession(fromId, {
    scout_session_id: newSess,
    last_active_at: new Date().toISOString(),
  });

  await reply(botToken, chatId,
    `🔄 *Fresh start!* I've reset your conversation.\n\nYour next message starts a brand new session.`,
    "Markdown"
  );
}

// ── /status — show info ────────────────────────────────────────

async function handleStatus(
  botToken: string,
  chatId: number,
  fromId: number
): Promise<void> {
  const user = await tgUsersCollection.findByTelegramId(fromId);
  if (!user) {
    await reply(botToken, chatId, `No ScoutClaw yet — send /start to hatch one!`);
    return;
  }

  const hatchedDate = new Date(user.hatched_at).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric"
  });

  await reply(botToken, chatId,
    `🦞 *Your ScoutClaw*\n\n` +
    `Agent: \`${user.scout_agent_id}\`\n` +
    `Session: \`${user.scout_session_id.slice(0, 16)}…\`\n` +
    `Hatched: ${hatchedDate}\n\n` +
    `Send /reset to start a fresh conversation.`,
    "Markdown"
  );
}

// ── Agent message handler (sync Scout interaction) ────────────
//
// Telegram is already ACK'd before this runs (fire-and-forget above),
// so we can take up to ~55s here without hitting Telegram's timeout.

async function handleAgentMessage(
  botToken: string,
  chatId: number,
  fromId: number,
  text: string,
  cfg: BridgeConfig
): Promise<void> {
  console.log(`[webhook] handleAgentMessage start fromId=${fromId} chat=${chatId}`);
  try {
    const user = await tgUsersCollection.findByTelegramId(fromId);
    if (!user) {
      console.warn(`[webhook] user not found fromId=${fromId}`);
      await reply(botToken, chatId, `Send /start first to hatch your ScoutClaw! 🦞`);
      return;
    }

    if (!user.scout_session_id) {
      console.warn(`[webhook] no session_id for fromId=${fromId}`);
      await reply(botToken, chatId, `⚠️ Session missing — send /reset to get a fresh session.`);
      return;
    }

    console.log(`[webhook] calling agent=${user.scout_agent_id} session=${user.scout_session_id.slice(0, 20)}`);

    // Fire-and-forget typing indicator — never let it block or throw
    sendTypingAction({ botToken, chatId }).catch((e) =>
      console.warn("[webhook] sendTypingAction failed (non-fatal):", e)
    );

    const { output } = await callScoutAgent({
      agentId: user.scout_agent_id,
      message: text,
      sessionId: user.scout_session_id,
      scoutApiKey: cfg.scout_api_key,
      scoutBaseUrl: cfg.scout_base_url,
    });

    // Non-fatal: update last_active timestamp, don't block reply on it
    tgUsersCollection.updateSession(fromId, {
      last_active_at: new Date().toISOString(),
    }).catch((e) => console.warn("[webhook] updateSession failed (non-fatal):", e));

    // Guard against empty/whitespace output from Scout
    const safeOutput = output?.trim() || "🤔 (got an empty response — try again)";
    console.log(`[webhook] agent responded session=${user.scout_session_id.slice(0, 20)} output="${safeOutput.slice(0, 80)}"`);
    await reply(botToken, chatId, safeOutput);

  } catch (err) {
    console.error("[webhook] handleAgentMessage error:", err);
    await reply(botToken, chatId, `⚠️ My brain hit a snag. Try again in a moment!`);
  }
}


// ── GET /webhook/debug — data layer health check ──────────────

webhookRouter.get("/debug", async (c) => {
  // Import recent request log from server layer
  let recentRequests: unknown[] = [];
  try {
    const { recentRequests: rr } = await import("../index.ts");
    recentRequests = rr;
  } catch { /* not available in all contexts */ }

  const results: Record<string, unknown> = {
    cachedConfig: cachedConfig ? "present" : "null",
    processedUpdatesCount: processedUpdates.size,
    recentRequests,
  };

  // Test config load
  try {
    const cfg = await bridgeConfigCollection.get();
    results.configLoad = cfg ? "ok" : "null (not configured)";
    if (cfg) {
      results.agentId = cfg.agent_template_id;
      results.webhookUrl = cfg.webhook_url;
      results.scoutBaseUrl = cfg.scout_base_url;
    }
  } catch (err) {
    results.configLoad = `ERROR: ${String(err)}`;
  }

  // Test user count
  try {
    const users = await tgUsersCollection.findAll();
    results.userCount = users.length;
  } catch (err) {
    results.userCount = `ERROR: ${String(err)}`;
  }

  // Test cache write/read (show raw response to diagnose field name)
  let loadedCfg: typeof cachedConfig = null;
  try {
    const writeRes = await portsClient.post<Record<string, unknown>>("/cache/debug_test", { value: "ok", ttl: 60 });
    const cached = await portsClient.get<Record<string, unknown>>("/cache/debug_test");
    results.cacheWriteResponse = writeRes;
    results.cacheReadResponse = cached;
    results.cacheTest = "write+read ok";
  } catch (err) {
    results.cacheTest = `ERROR: ${String(err)}`;
  }

  // Capture the loaded config for Scout test below
  try {
    loadedCfg = await bridgeConfigCollection.get();
  } catch (_) { /* already tested above */ }

  // Test Scout API call (timed)
  try {
    const cfg = loadedCfg;
    if (cfg) {
      const start = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const scoutRes = await fetch(
          `${cfg.scout_base_url}/world/${cfg.agent_template_id}/_interact_sync`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${cfg.scout_api_key}`,
            },
            body: JSON.stringify({
              messages: [{ role: "user", content: "ping" }],
              session_id: "sess_debug_test",
            }),
            signal: controller.signal,
          }
        );
        clearTimeout(timer);
        const elapsed = Date.now() - start;
        const body = await scoutRes.text();
        // Parse and find last assistant message
        let lastAssistantContent = "(parse error)";
        let messageCount = 0;
        try {
          const parsed = JSON.parse(body);
          if (Array.isArray(parsed)) {
            messageCount = parsed.length;
            const assistants = parsed.filter((m: { role: string }) => m.role === "assistant");
            const last = assistants[assistants.length - 1] as { content?: string } | undefined;
            lastAssistantContent = last?.content?.trim() ?? "(no assistant message)";
          }
        } catch { /* ignore */ }
        results.scoutApiTest = {
          status: scoutRes.status,
          elapsed_ms: elapsed,
          message_count: messageCount,
          last_assistant: lastAssistantContent.slice(0, 300),
        };
      } catch (e) {
        clearTimeout(timer);
        results.scoutApiTest = `ERROR after ${Date.now() - start}ms: ${String(e)}`;
      }
    } else {
      results.scoutApiTest = "skipped (no config cached yet)";
    }
  } catch (err) {
    results.scoutApiTest = `ERROR: ${String(err)}`;
  }

  // Test Telegram bot token + webhook registration status
  try {
    if (loadedCfg) {
      const tgCtrl = new AbortController();
      const tgTimer = setTimeout(() => tgCtrl.abort(), 10_000);
      try {
        const [meRes, hookRes] = await Promise.all([
          fetch(`https://api.telegram.org/bot${loadedCfg.telegram_bot_token}/getMe`, { signal: tgCtrl.signal }),
          fetch(`https://api.telegram.org/bot${loadedCfg.telegram_bot_token}/getWebhookInfo`, { signal: tgCtrl.signal }),
        ]);
        clearTimeout(tgTimer);
        const meData = await meRes.json() as { ok: boolean; result?: { username: string } };
        const hookData = await hookRes.json() as {
          ok: boolean;
          result?: { url: string; pending_update_count: number; last_error_message?: string; last_error_date?: number };
        };
        results.telegramBotTest = meData.ok ? `ok — @${meData.result?.username}` : `FAILED: ${JSON.stringify(meData)}`;
        if (hookData.ok && hookData.result) {
          results.telegramWebhook = {
            url: hookData.result.url || "(none — not registered!)",
            pending: hookData.result.pending_update_count,
            lastError: hookData.result.last_error_message ?? null,
            lastErrorAt: hookData.result.last_error_date
              ? new Date(hookData.result.last_error_date * 1000).toISOString()
              : null,
          };
        }
      } catch (e) {
        clearTimeout(tgTimer);
        results.telegramBotTest = `ERROR: ${String(e)}`;
      }
    } else {
      results.telegramBotTest = "skipped (no config)";
    }
  } catch (err) {
    results.telegramBotTest = `ERROR: ${String(err)}`;
  }

  return c.json(results);
});

// ── Utility ────────────────────────────────────────────────────

async function reply(
  botToken: string | null,
  chatId: number,
  text: string,
  parseMode?: "Markdown" | "HTML"
): Promise<void> {
  if (!botToken) {
    console.error("[webhook] Cannot reply — no bot token");
    return;
  }
  await sendTelegramMessage({ botToken, chatId, text, parseMode });
}
