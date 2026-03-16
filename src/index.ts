// ============================================================
// ScoutClaw Telegram Bridge — Hono server
// Node.js runtime, scoutos.live deployment
//
// Root cause of the gzip 415/500 bug:
//   @hono/node-server passes rawHeaders (not headers) to
//   new Request(url, { body: stream, headers: rawHeaders }).
//   undici (Node.js 20 fetch) sees Content-Encoding: gzip in headers
//   and tries to auto-decompress the body stream. When we've already
//   consumed the stream to gunzip it, the stream is empty/ended and
//   undici crashes with "Cannot read properties of undefined (reading 'length')".
//
// Fix: intercept at raw HTTP level, decompress, rebuild rawHeaders
// without Content-Encoding, and pass a PassThrough stream with the
// decompressed bytes to @hono/node-server.
// ============================================================

import http from "node:http";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { PassThrough } from "node:stream";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { getRequestListener } from "@hono/node-server";
import { setupRouter } from "./routes/setup.ts";
import { webhookRouter } from "./routes/webhook.ts";
import { bridgeConfigCollection } from "./adapters/ports/data.ts";

const gunzipAsync = promisify(gunzip);

const app = new Hono();

// ── Middleware ─────────────────────────────────────────────────

app.use("*", logger());
app.use("*", cors());

// ── Health ─────────────────────────────────────────────────────

app.get("/health", (c) =>
  c.json({
    status: "ok",
    service: "scoutclaw-tg-bridge",
    version: "0.1.0",
    timestamp: new Date().toISOString(),
  })
);

// ── Setup page ─────────────────────────────────────────────────

app.route("/setup", setupRouter);

// ── Telegram webhook ───────────────────────────────────────────

app.route("/webhook", webhookRouter);

// ── Flush — drop all pending Telegram updates ──────────────────

app.get("/flush", async (c) => {
  const cfg = await bridgeConfigCollection.get().catch(() => null);
  if (!cfg) return c.json({ ok: false, error: "Bridge not configured" }, 400);

  const del = await fetch(`https://api.telegram.org/bot${cfg.telegram_bot_token}/deleteWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ drop_pending_updates: true }),
  }).then(r => r.json()) as { ok: boolean };

  const set = await fetch(`https://api.telegram.org/bot${cfg.telegram_bot_token}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: cfg.webhook_url, drop_pending_updates: true }),
  }).then(r => r.json()) as { ok: boolean };

  console.log(`[flush] deleteWebhook=${del.ok} setWebhook=${set.ok}`);
  return c.json({ ok: del.ok && set.ok, message: "Queue flushed, webhook re-registered" });
});

// ── Root redirect ──────────────────────────────────────────────

app.get("/", (c) => c.redirect("/setup"));

// ── 404 / error handlers ───────────────────────────────────────

app.notFound((c) => c.json({ error: "Not found" }, 404));

app.onError((err, c) => {
  console.error("[app] Unhandled error:", err);
  return c.json({ error: "Internal server error", message: err.message }, 500);
});

// ── Raw HTTP server with gzip pre-decompression ────────────────
//
// For gzip-encoded bodies we:
//  1. Buffer + decompress before @hono/node-server sees the request
//  2. Build new rawHeaders WITHOUT Content-Encoding
//  3. Provide the decompressed bytes via a PassThrough stream
//  4. Pass this synthetic IncomingMessage to the Hono listener

const honoListener = getRequestListener(app.fetch);
const port = parseInt(process.env.PORT ?? "3000", 10);

// ── Request log (last 10) — exposed via /webhook/debug ─────────
export const recentRequests: Array<{
  ts: string;
  method: string;
  path: string;
  contentEncoding: string | null;
  contentType: string | null;
  contentLength: string | null;
  bodyFirstBytes: string;  // first 8 bytes as hex
  status: number;          // HTTP response status (filled after response)
}> = [];

function logRequest(req: http.IncomingMessage, res: http.ServerResponse, bodyFirstBytes = ""): void {
  const entry = {
    ts: new Date().toISOString(),
    method: req.method ?? "?",
    path: req.url ?? "?",
    contentEncoding: req.headers["content-encoding"] ?? null,
    contentType: req.headers["content-type"] ?? null,
    contentLength: req.headers["content-length"] ?? null,
    bodyFirstBytes,
    status: 0, // filled in after response
  };
  recentRequests.unshift(entry);
  if (recentRequests.length > 10) recentRequests.pop();

  // Capture response status code after it's written
  const origWriteHead = res.writeHead.bind(res);
  (res as unknown as Record<string, unknown>).writeHead = (statusCode: number, ...args: unknown[]) => {
    entry.status = statusCode;
    console.log(`[server] ${entry.method} ${entry.path} enc=${entry.contentEncoding ?? "none"} len=${entry.contentLength ?? "?"} → ${statusCode}`);
    return (origWriteHead as (...a: unknown[]) => http.ServerResponse)(statusCode, ...args);
  };
}

function stripContentEncoding(rawHeaders: string[], decompressedLength: number): string[] {
  const result: string[] = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const key = rawHeaders[i];
    const val = rawHeaders[i + 1];
    const keyLower = key.toLowerCase();
    if (keyLower === "content-encoding") continue;  // strip
    if (keyLower === "content-length") {
      result.push(key, String(decompressedLength));   // update length
      continue;
    }
    result.push(key, val);
  }
  // Add content-length if it wasn't present
  if (!result.some((v, i) => i % 2 === 0 && v.toLowerCase() === "content-length")) {
    result.push("Content-Length", String(decompressedLength));
  }
  return result;
}

const server = http.createServer(async (req, res) => {
  const enc = req.headers["content-encoding"];

  if (enc && (enc.includes("gzip") || enc.includes("deflate"))) {
    // 1. Buffer the full compressed body
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of req) chunks.push(chunk as Buffer);
    } catch (err) {
      console.error("[server] body read error:", err);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false }));
      return;
    }
    const compressed = Buffer.concat(chunks);
    logRequest(req, res, compressed.slice(0, 8).toString("hex"));

    // 2. Decompress
    let decompressed = compressed;
    try {
      decompressed = await gunzipAsync(compressed);
      console.log(`[server] gunzip ${compressed.length}b → ${decompressed.length}b`);
    } catch (err) {
      console.warn("[server] gunzip failed, using raw bytes:", String(err));
    }

    // 3. Build new rawHeaders without Content-Encoding
    const newRawHeaders = stripContentEncoding(req.rawHeaders, decompressed.length);

    // 4. Build matching headers object from newRawHeaders
    const newHeaders: Record<string, string> = {};
    for (let i = 0; i < newRawHeaders.length; i += 2) {
      newHeaders[newRawHeaders[i].toLowerCase()] = newRawHeaders[i + 1];
    }

    // 5. Create a PassThrough stream carrying the decompressed bytes
    const body = new PassThrough();
    body.end(decompressed);

    // 6. Attach IncomingMessage-compatible properties
    const fakeReq = Object.assign(body, {
      method:           req.method,
      url:              req.url,
      headers:          newHeaders,
      rawHeaders:       newRawHeaders,
      socket:           req.socket,
      connection:       req.socket,   // alias
      httpVersion:      req.httpVersion,
      httpVersionMajor: req.httpVersionMajor,
      httpVersionMinor: req.httpVersionMinor,
      complete:         true,
      aborted:          false,
    });

    await honoListener(fakeReq as unknown as http.IncomingMessage, res);
  } else {
    // No compression — log and pass through as normal
    logRequest(req, res, "");
    // Wrap honoListener to catch any unhandled throws and ensure 200 is returned
    try {
      await honoListener(req, res);
    } catch (err) {
      console.error("[server] honoListener threw:", err);
      if (!res.headersSent) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      }
    }
  }
});

// Catch unhandled async errors on the server itself
server.on("error", (err) => {
  console.error("[server] HTTP server error:", err);
});

server.listen(port, () => {
  console.log(`[scoutclaw-tg-bridge] Listening on port ${port}`);
});
