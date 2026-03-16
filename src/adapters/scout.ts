// ============================================================
// Scout agent adapter
// Calls /_ports/agents for agent-to-agent comms (on scoutos.live)
// Falls back to direct api.scoutos.com in local dev
//
// Scout interact endpoint: POST /world/{agent_id}/_interact_sync
// ============================================================

import type { ScoutInteractResponse } from "../types.ts";

const PORTS_URL = process.env.SCOUT_PORTS_URL ?? "http://127.0.0.1:3101/_ports";
const SCOUT_APP_JWT = process.env.SCOUT_APP_JWT ?? "";

/**
 * Attempt to validate a Scout API key.
 * Best-effort — if the check endpoint is unavailable we allow through.
 * Real validation happens on the first agent call.
 */
export async function validateScoutApiKey(
  apiKey: string,
  scoutBaseUrl = "https://api.scoutos.com"
): Promise<{ valid: boolean; error?: string }> {
  // A key that doesn't even look like a Scout key is obviously wrong
  if (!apiKey || apiKey.length < 8) {
    return { valid: false, error: "API key too short" };
  }

  // Try a lightweight call — list agents or hit /health
  // If the endpoint 404s that's fine (key format looks valid), only hard fail on 401/403
  try {
    const res = await fetch(`${scoutBaseUrl}/v2/apps`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.status === 401 || res.status === 403) {
      return { valid: false, error: "Invalid or unauthorized API key" };
    }
    // 200, 404, 422 etc — key is likely valid, endpoint may differ
    return { valid: true };
  } catch (_err) {
    // Network issue — allow through, agent call will fail clearly later
    console.warn("[scout] validateScoutApiKey network error, allowing through");
    return { valid: true };
  }
}

/**
 * Call a Scout agent directly via the Scout API.
 *
 * Scout endpoint: POST /world/{agent_id}/_interact_sync
 * Body: { messages: [{role, content}], session_id: "<id>" }
 */
export async function callScoutAgent(opts: {
  agentId: string;
  message: string;
  sessionId: string;
  scoutApiKey: string;
  scoutBaseUrl?: string;
}): Promise<ScoutInteractResponse> {
  const { agentId, message, sessionId, scoutApiKey, scoutBaseUrl = "https://api.scoutos.com" } = opts;

  console.log(`[scout] calling agent=${agentId} session=${sessionId.slice(0, 20)} base=${scoutBaseUrl}`);

  const body = {
    messages: [{ role: "user", content: message }],
    session_id: sessionId,
  };

  // 55-second timeout — Telegram gives up after 60s
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 55_000);

  let res: Response;
  try {
    res = await fetch(`${scoutBaseUrl}/world/${agentId}/_interact_sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${scoutApiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Scout API call failed: ${res.status} ${text}`);
  }

  // Check for session_id in response headers
  const headerSessionId = res.headers.get("x-session-id") ?? res.headers.get("session-id");

  const data = await res.json() as unknown;
  console.log(`[scout] response type=${Array.isArray(data) ? "array" : typeof data} headerSessionId=${headerSessionId} raw=${JSON.stringify(data).slice(0, 400)}`);

  // Scout returns an array of message objects: [{role, content, ...}, ...]
  // Find the last assistant message
  if (Array.isArray(data)) {
    const messages = data as Array<{ role: string; content: string; session_id?: string }>;
    const lastAssistant = [...messages].reverse().find(m => m.role === "assistant");
    const text = lastAssistant?.content?.trim() ?? "(no response)";
    // Try to extract session_id from last message, then headers, then fall back to input
    const returnedSessionId =
      lastAssistant?.session_id ??
      headerSessionId ??
      sessionId;
    console.log(`[scout] array path: assistant="${text.slice(0, 80)}" session=${returnedSessionId.slice(0, 20)}`);
    return { output: text, session_id: returnedSessionId };
  }

  // Fallback: object-style response
  const obj = data as Record<string, unknown>;
  const outputs = obj.outputs as Record<string, unknown> | undefined;
  const text =
    (outputs?.output as string) ??
    (outputs?.response as string) ??
    (outputs?.text as string) ??
    (obj.output as string) ??
    (obj.text as string) ??
    "(no response)";

  const returnedSessionId =
    (obj.session_id as string) ??
    headerSessionId ??
    sessionId;

  console.log(`[scout] object path: text="${text.slice(0, 80)}" session=${returnedSessionId.slice(0, 20)}`);

  return {
    output: text,
    session_id: returnedSessionId,
  };
}

/**
 * Start an async Scout agent interaction.
 *
 * Scout endpoint: POST /v1/agents/{agent_id}/interact
 * Body: { message, callback_url, session_id? }
 * Returns 202 with { session_id, events_url }
 */
export async function callScoutAgentAsync(opts: {
  agentId: string;
  message: string;
  sessionId: string;
  callbackUrl: string;
  scoutApiKey: string;
  scoutBaseUrl?: string;
}): Promise<{ session_id: string; events_url: string }> {
  const { agentId, message, sessionId, callbackUrl, scoutApiKey, scoutBaseUrl = "https://api.scoutos.com" } = opts;

  console.log(`[scout] async start agent=${agentId} session=${sessionId.slice(0, 20)}`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15_000); // short — just starting the job

  let res: Response;
  try {
    res = await fetch(`${scoutBaseUrl}/v1/agents/${agentId}/interact`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${scoutApiKey}`,
      },
      body: JSON.stringify({
        message,
        callback_url: callbackUrl,
        session_id: sessionId,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (res.status !== 202 && !res.ok) {
    const text = await res.text();
    throw new Error(`Scout async start failed: ${res.status} ${text}`);
  }

  const data = await res.json() as { session_id?: string; events_url?: string };
  console.log(`[scout] async started session=${data.session_id} events=${data.events_url}`);

  return {
    session_id: data.session_id ?? sessionId,
    events_url: data.events_url ?? "",
  };
}

/**
 * Fetch the result of a completed async Scout interaction from its events URL.
 * Returns the last assistant message text.
 */
export async function fetchScoutAsyncResult(opts: {
  eventsUrl: string;
  scoutApiKey: string;
}): Promise<string> {
  const { eventsUrl, scoutApiKey } = opts;

  console.log(`[scout] fetching async result from ${eventsUrl}`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15_000);

  let res: Response;
  try {
    res = await fetch(eventsUrl, {
      headers: { Authorization: `Bearer ${scoutApiKey}` },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Scout events fetch failed: ${res.status} ${text}`);
  }

  const data = await res.json() as unknown;
  console.log(`[scout] events type=${Array.isArray(data) ? "array" : typeof data} raw=${JSON.stringify(data).slice(0, 300)}`);

  // Events may be an array of message objects (same as _interact_sync)
  if (Array.isArray(data)) {
    const messages = data as Array<{ role: string; content: string }>;
    const lastAssistant = [...messages].reverse().find(m => m.role === "assistant");
    return lastAssistant?.content?.trim() ?? "(no response)";
  }

  // Or a wrapper object with messages/events array inside
  const obj = data as Record<string, unknown>;
  const inner = (obj.messages ?? obj.events ?? obj.data) as unknown;
  if (Array.isArray(inner)) {
    const lastAssistant = [...inner as Array<{ role: string; content: string }>]
      .reverse().find(m => m.role === "assistant");
    return lastAssistant?.content?.trim() ?? "(no response)";
  }

  // Plain text or output field
  return (obj.output as string) ?? (obj.text as string) ?? "(no response)";
}

/**
 * Generate a new unique session ID.
 */
export function newSessionId(): string {
  return `sess_${crypto.randomUUID()}`;
}
