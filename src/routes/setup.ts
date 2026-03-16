// ============================================================
// /setup — Operator configuration page
//
// GET  /setup  → HTML form (enter bot token + Scout API key + agent ID)
// POST /setup  → validate credentials, register Telegram webhook, save config
// ============================================================

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { bridgeConfigCollection } from "../adapters/ports/data.ts";
import { getTelegramBotInfo, setTelegramWebhook } from "../adapters/telegram.ts";
import { validateScoutApiKey } from "../adapters/scout.ts";

export const setupRouter = new Hono();

// ── GET /setup ─────────────────────────────────────────────────

setupRouter.get("/", async (c) => {
  const cfg = await bridgeConfigCollection.get().catch(() => null);
  const errorMsg = c.req.query("error");

  let statusBanner: string;
  if (errorMsg) {
    statusBanner = `<div class="banner error">❌ ${errorMsg}</div>`;
  } else if (cfg) {
    statusBanner = `<div class="banner success">✅ Bridge is configured — bot is live. You can update credentials below.</div>`;
  } else {
    statusBanner = `<div class="banner info">👋 Welcome! Set up your ScoutClaw Telegram Bridge below.</div>`;
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ScoutClaw Bridge — Setup</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #0f1117;
      color: #e2e8f0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      background: #1a1d2e;
      border: 1px solid #2d3148;
      border-radius: 16px;
      padding: 40px;
      width: 100%;
      max-width: 480px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    }
    .logo {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 32px;
    }
    .logo-icon {
      width: 42px; height: 42px;
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      border-radius: 10px;
      display: flex; align-items: center; justify-content: center;
      font-size: 20px;
    }
    .logo-text { line-height: 1; }
    .logo-name { font-size: 16px; font-weight: 700; color: #fff; }
    .logo-sub  { font-size: 12px; color: #64748b; margin-top: 3px; }
    h1 { font-size: 20px; font-weight: 600; color: #fff; margin-bottom: 6px; }
    p.subtitle { font-size: 14px; color: #64748b; margin-bottom: 28px; }
    .banner {
      padding: 12px 16px;
      border-radius: 8px;
      font-size: 13px;
      margin-bottom: 24px;
    }
    .banner.success { background: #052e16; border: 1px solid #166534; color: #4ade80; }
    .banner.info    { background: #0c1a3a; border: 1px solid #1e3a8a; color: #60a5fa; }
    .banner.error   { background: #2d0a0a; border: 1px solid #7f1d1d; color: #f87171; }
    .field { margin-bottom: 18px; }
    label {
      display: block;
      font-size: 12px;
      font-weight: 500;
      color: #94a3b8;
      margin-bottom: 6px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    input[type="text"], input[type="password"] {
      width: 100%;
      background: #0f1117;
      border: 1px solid #2d3148;
      border-radius: 8px;
      padding: 10px 14px;
      font-size: 14px;
      color: #e2e8f0;
      outline: none;
      transition: border-color 0.15s;
    }
    input:focus { border-color: #6366f1; }
    .hint { font-size: 11px; color: #475569; margin-top: 5px; }
    button[type="submit"] {
      width: 100%;
      background: #6366f1;
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 12px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s;
      margin-top: 8px;
    }
    button[type="submit"]:hover { background: #4f46e5; }
    button[type="submit"]:disabled { opacity: 0.6; cursor: not-allowed; }
    .footer { margin-top: 24px; text-align: center; font-size: 12px; color: #334155; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <div class="logo-icon">🦞</div>
      <div class="logo-text">
        <div class="logo-name">ScoutClaw</div>
        <div class="logo-sub">Telegram Bridge</div>
      </div>
    </div>

    <h1>Bridge Setup</h1>
    <p class="subtitle">Connect your Telegram bot to a Scout agent.</p>

    ${statusBanner}

    <form method="POST" action="/setup" id="setupForm">
      <div class="field">
        <label>Telegram Bot Token</label>
        <input
          type="password"
          name="telegram_bot_token"
          placeholder="123456:AAF..."
          value="${cfg ? "••••••••••••" : ""}"
          autocomplete="off"
          required
        />
        <div class="hint">From @BotFather on Telegram</div>
      </div>

      <div class="field">
        <label>Scout API Key</label>
        <input
          type="password"
          name="scout_api_key"
          placeholder="sk_live_..."
          value="${cfg ? "••••••••••••" : ""}"
          autocomplete="off"
          required
        />
        <div class="hint">From your scoutos.com account settings</div>
      </div>

      <div class="field">
        <label>Scout Agent ID</label>
        <input
          type="text"
          name="agent_template_id"
          placeholder="agent_xxxxxxxxxxxx"
          value="${cfg?.agent_template_id ?? ""}"
          autocomplete="off"
          required
        />
        <div class="hint">The agent users will interact with</div>
      </div>

      <div class="field">
        <label>Scout Base URL</label>
        <input
          type="text"
          name="scout_base_url"
          placeholder="https://api.scoutos.com"
          value="${cfg?.scout_base_url ?? "https://api.scoutos.com"}"
        />
        <div class="hint">Leave default unless using a custom Scout deployment</div>
      </div>

      <button type="submit" id="submitBtn">Save & Activate Bridge</button>
    </form>

    <div class="footer">ScoutClaw Bridge v0.1</div>
  </div>

  <script>
    document.getElementById('setupForm').addEventListener('submit', function() {
      document.getElementById('submitBtn').disabled = true;
      document.getElementById('submitBtn').textContent = 'Activating…';
    });
  </script>
</body>
</html>`;

  return c.html(html);
});

// ── POST /setup ────────────────────────────────────────────────

const setupSchema = z.object({
  telegram_bot_token: z.string().min(10),
  scout_api_key: z.string().min(8),
  agent_template_id: z.string().min(4),
  scout_base_url: z.string().url().optional().default("https://api.scoutos.com"),
});

setupRouter.post(
  "/",
  zValidator("form", setupSchema),
  async (c) => {
    const data = c.req.valid("form");

    // 1. Validate the Telegram bot token
    const botInfo = await getTelegramBotInfo(data.telegram_bot_token);
    if (!botInfo.ok) {
      return c.html(errorRedirect("Invalid Telegram bot token: " + (botInfo.description ?? "unknown")));
    }
    const botName = botInfo.result?.username ?? "bot";

    // 2. Validate the Scout API key
    const scoutCheck = await validateScoutApiKey(data.scout_api_key, data.scout_base_url);
    if (!scoutCheck.valid) {
      return c.html(errorRedirect("Invalid Scout API key: " + (scoutCheck.error ?? "unauthorized")));
    }

    // 3. Derive webhook URL from APP_URL env var
    const appUrl = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
    const webhookUrl = `${appUrl}/webhook/telegram`;

    // 4. Register webhook with Telegram
    const webhookResult = await setTelegramWebhook({
      botToken: data.telegram_bot_token,
      webhookUrl,
    });
    if (!webhookResult.ok) {
      return c.html(errorRedirect("Failed to register webhook: " + (webhookResult.description ?? "unknown")));
    }

    // 5. Save config to /_ports/data
    await bridgeConfigCollection.save({
      telegram_bot_token: data.telegram_bot_token,
      scout_api_key: data.scout_api_key,
      scout_base_url: data.scout_base_url,
      agent_template_id: data.agent_template_id,
      webhook_url: webhookUrl,
      configured_at: new Date().toISOString(),
    });

    console.log(`[setup] Bridge configured — bot @${botName}, webhook: ${webhookUrl}`);

    // 6. Show success page
    const successHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="refresh" content="3;url=/setup" />
  <title>ScoutClaw Bridge — Activated</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #0f1117;
      color: #e2e8f0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      background: #1a1d2e;
      border: 1px solid #2d3148;
      border-radius: 16px;
      padding: 40px;
      width: 100%;
      max-width: 480px;
      text-align: center;
    }
    .icon { font-size: 48px; margin-bottom: 20px; }
    h1 { font-size: 22px; font-weight: 700; color: #4ade80; margin-bottom: 10px; }
    p { font-size: 14px; color: #64748b; line-height: 1.6; }
    .detail { margin-top: 20px; background: #0f1117; border-radius: 8px; padding: 14px; text-align: left; font-size: 13px; }
    .detail div { margin-bottom: 6px; color: #94a3b8; }
    .detail span { color: #e2e8f0; font-weight: 500; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">🦞✅</div>
    <h1>Bridge Activated!</h1>
    <p>Your ScoutClaw Telegram Bridge is live.<br/>Redirecting back to setup…</p>
    <div class="detail">
      <div>Bot: <span>@${botName}</span></div>
      <div>Webhook: <span>${webhookUrl}</span></div>
      <div>Agent: <span>${data.agent_template_id}</span></div>
    </div>
  </div>
</body>
</html>`;

    return c.html(successHtml);
  }
);

// ── GET /setup/flush — drop pending Telegram updates ──────────
// Useful when the bot has a backlog of old queued messages to drain

setupRouter.get("/flush", async (c) => {
  const cfg = await bridgeConfigCollection.get().catch(() => null);
  if (!cfg) {
    return c.json({ ok: false, error: "Bridge not configured" }, 400);
  }

  // deleteWebhook with drop_pending_updates=true, then re-register
  const deleteRes = await fetch(
    `https://api.telegram.org/bot${cfg.telegram_bot_token}/deleteWebhook`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ drop_pending_updates: true }),
    }
  );
  const deleteData = await deleteRes.json() as { ok: boolean; description?: string };

  if (!deleteData.ok) {
    return c.json({ ok: false, error: "deleteWebhook failed: " + deleteData.description }, 500);
  }

  // Re-register webhook
  const setRes = await fetch(
    `https://api.telegram.org/bot${cfg.telegram_bot_token}/setWebhook`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: cfg.webhook_url, drop_pending_updates: true }),
    }
  );
  const setData = await setRes.json() as { ok: boolean; description?: string };

  console.log(`[setup] flush: deleteWebhook=${deleteData.ok}, setWebhook=${setData.ok}`);
  return c.json({
    ok: setData.ok,
    message: "Pending updates dropped, webhook re-registered",
    webhook_url: cfg.webhook_url,
  });
});

// Helper: redirect back to /setup with an error flash via query param
function errorRedirect(msg: string): string {
  return `<!DOCTYPE html>
<html><head><meta http-equiv="refresh" content="0;url=/setup?error=${encodeURIComponent(msg)}" /></head>
<body>Redirecting…</body></html>`;
}
