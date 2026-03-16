// ============================================================
// /_ports/data — MongoDB-style document store
//
// Collections:
//   bridge_config  — singleton app config (id: "config")
//   tg_users       — one per Telegram user who has hatched a ScoutClaw
//
// API:
//   POST   /{collection}         { document: { _id?, ...fields } }
//   GET    /{collection}/{id}
//   PUT    /{collection}/{id}    { document: {...} }
//   PATCH  /{collection}/{id}    { update: { $set: {...} } }
//   DELETE /{collection}/{id}
//   POST   /{collection}/find    { filter, sort, limit, skip }
// ============================================================

import { portsClient } from "./client.ts";
import type { BridgeConfig, TgUser, PendingInteraction } from "../../types.ts";

const BASE = "/data";

// ── Generic helpers ───────────────────────────────────────────

async function findOne<T>(collection: string, id: string): Promise<T | null> {
  try {
    const res = await portsClient.get<{ document: T; found: boolean }>(
      `${BASE}/${collection}/${id}`
    );
    if (res.found) return res.document;
    return null;
  } catch (err) {
    if (!String(err).includes("404")) throw err;
    return null;
  }
}

async function findMany<T>(
  collection: string,
  filter: Record<string, unknown> = {}
): Promise<T[]> {
  const res = await portsClient.post<{ documents: T[]; total: number }>(
    `${BASE}/${collection}/find`,
    { filter, limit: 500, skip: 0 }
  );
  return res.documents ?? [];
}

async function upsertOne<T extends { id: string }>(
  collection: string,
  doc: T
): Promise<T> {
  await portsClient.post<{ ok: boolean; id: string }>(`${BASE}/${collection}`, {
    document: { _id: doc.id, ...doc },
  });
  return doc;
}

async function updateOne<T extends { id: string }>(
  collection: string,
  id: string,
  patch: Partial<T>
): Promise<void> {
  await portsClient.patch<{ ok: boolean }>(`${BASE}/${collection}/${id}`, {
    update: { $set: patch },
  });
}

// ── bridge_config collection ──────────────────────────────────
// Singleton: always uses id = "config"

export const bridgeConfigCollection = {
  get: (): Promise<BridgeConfig | null> =>
    findOne<BridgeConfig>("bridge_config", "config"),

  save: (cfg: Omit<BridgeConfig, "id">): Promise<BridgeConfig> =>
    upsertOne<BridgeConfig>("bridge_config", { id: "config", ...cfg }),

  update: (patch: Partial<Omit<BridgeConfig, "id">>): Promise<void> =>
    updateOne<BridgeConfig>("bridge_config", "config", patch),
};

// ── tg_users collection ───────────────────────────────────────

function tgUserId(telegramUserId: number): string {
  return `tg_user_${telegramUserId}`;
}

export const tgUsersCollection = {
  findByTelegramId: (telegramUserId: number): Promise<TgUser | null> =>
    findOne<TgUser>("tg_users", tgUserId(telegramUserId)),

  findAll: (): Promise<TgUser[]> => findMany<TgUser>("tg_users"),

  save: (user: Omit<TgUser, "id">): Promise<TgUser> =>
    upsertOne<TgUser>("tg_users", {
      id: tgUserId(user.telegram_user_id),
      ...user,
    }),

  updateSession: (
    telegramUserId: number,
    patch: Partial<Pick<TgUser, "scout_session_id" | "last_active_at">>
  ): Promise<void> =>
    updateOne<TgUser>("tg_users", tgUserId(telegramUserId), patch),
};

// ── pending_interactions collection ──────────────────────────
// Tracks in-flight async Scout calls: session_id → chat context
// Stored with Scout session_id as the doc id.

export const pendingInteractionsCollection = {
  save: (p: PendingInteraction): Promise<PendingInteraction> =>
    upsertOne<PendingInteraction>("pending_interactions", p),

  get: (sessionId: string): Promise<PendingInteraction | null> =>
    findOne<PendingInteraction>("pending_interactions", sessionId),

  delete: (sessionId: string): Promise<void> =>
    portsClient
      .delete<{ ok: boolean }>(`${BASE}/pending_interactions/${sessionId}`)
      .then(() => undefined)
      .catch(() => undefined), // best-effort cleanup
};
