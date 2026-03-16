// ============================================================
// Telegram Bot API adapter
// ============================================================

/**
 * Send a text message to a Telegram chat
 */
export async function sendTelegramMessage(opts: {
  botToken: string;
  chatId: number;
  text: string;
  parseMode?: "Markdown" | "HTML";
}): Promise<void> {
  const { botToken, chatId, text, parseMode } = opts;
  const body: Record<string, unknown> = { chat_id: chatId, text };
  if (parseMode) body.parse_mode = parseMode;

  const res = await fetch(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    console.error(`[telegram] sendMessage failed: ${res.status} ${err}`);
  }
}

/**
 * Set the webhook URL for the bot so Telegram pushes updates to us
 */
export async function setTelegramWebhook(opts: {
  botToken: string;
  webhookUrl: string;
}): Promise<{ ok: boolean; description?: string }> {
  const { botToken, webhookUrl } = opts;
  const res = await fetch(
    `https://api.telegram.org/bot${botToken}/setWebhook`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: webhookUrl, drop_pending_updates: true }),
    }
  );
  return res.json() as Promise<{ ok: boolean; description?: string }>;
}

/**
 * Get basic info about the bot (used to validate token)
 */
export async function getTelegramBotInfo(botToken: string): Promise<{
  ok: boolean;
  result?: { id: number; first_name: string; username: string };
  description?: string;
}> {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
  return res.json() as Promise<{
    ok: boolean;
    result?: { id: number; first_name: string; username: string };
    description?: string;
  }>;
}

/**
 * Send a "typing..." action to show the bot is processing
 */
export async function sendTypingAction(opts: {
  botToken: string;
  chatId: number;
}): Promise<void> {
  const { botToken, chatId } = opts;
  await fetch(`https://api.telegram.org/bot${botToken}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
  });
}
