// ============================================================
// ScoutClaw Telegram Bridge — Core types
// ============================================================

/**
 * Singleton config set via /setup.
 * One row per deployment.
 */
export interface BridgeConfig {
  id: "config";                   // always "config" — singleton
  telegram_bot_token: string;     // e.g. "123456:AAF..."
  scout_api_key: string;          // e.g. "sk_live_..."
  scout_base_url: string;         // e.g. "https://api.scoutos.com"
  agent_template_id: string;      // Scout agent to clone per user (or call directly)
  webhook_url: string;            // e.g. "https://scout-tg-bridge.scoutos.live/webhook/telegram"
  configured_at: string;          // ISO timestamp
}

/**
 * One row per Telegram user who has hatched a ScoutClaw.
 */
export interface TgUser {
  id: string;                     // "tg_user_{telegram_user_id}"
  telegram_user_id: number;       // Telegram numeric user ID
  telegram_username?: string;     // Optional @handle
  telegram_first_name?: string;
  scout_agent_id: string;         // Provisioned agent ID on ScoutOS
  scout_session_id: string;       // Conversation session for continuity
  hatched_at: string;             // ISO timestamp
  last_active_at: string;         // ISO timestamp
}

// ── Telegram Bot API types (minimal) ─────────────────────────

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

export interface TgMessage {
  message_id: number;
  from?: TgUser_TG;
  chat: { id: number; type: string };
  text?: string;
  date: number;
}

export interface TgUser_TG {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

// ── Scout Agent API types ─────────────────────────────────────

export interface ScoutInteractRequest {
  message: string;
  session_id?: string;
}

export interface ScoutInteractResponse {
  output?: string;
  text?: string;
  session_id?: string;
  error?: string;
}

/**
 * Tracks an in-flight async Scout interaction so the callback
 * can route the response back to the right Telegram chat.
 */
export interface PendingInteraction {
  id: string;            // Scout session_id (returned from 202 response)
  chat_id: number;       // Telegram chat to reply to
  telegram_user_id: number;
  started_at: string;    // ISO timestamp
}
