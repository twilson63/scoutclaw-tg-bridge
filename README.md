# ScoutClaw Telegram Bridge 🦞

A lightweight Telegram → Scout agent bridge. Users chat with a Telegram bot; messages are forwarded to a Scout AI agent and replies come back in Telegram.

## What it does

- Receives Telegram updates via webhook
- Routes messages to a [Scout](https://scoutos.live) agent session
- Streams replies back to the Telegram user
- Handles `/start`, `/reset`, `/status` commands
- Deduplicates updates across restarts
- Includes a `/setup` UI for operator configuration — no env file needed at runtime

## Architecture

```
Telegram user
    ↓  (HTTPS webhook)
scoutclaw-tg-bridge  (Hono / Node.js, hosted on scoutos.live)
    ↓  (Scout API)
Scout AI agent
    ↑
 reply streamed back → Telegram sendMessage
```

The bridge stores its config (bot token, Scout API key, allowed users) in the scoutos.live `_ports/data` service — no external database required.

## Deploy to scoutos.live

### Prerequisites

- A scoutos.live account with a subdomain slot
- `SCOUTOS_KEY` — your scoutos.live API key
- `SCOUTOS_DEPLOY_CODE` — your subdomain deploy code

### One-command deploy

```bash
export SCOUTOS_KEY=your_key_here
export SCOUTOS_DEPLOY_CODE=your_deploy_code_here
./deploy.sh
```

The script:
1. Builds a tarball (excluding `node_modules`, `.git`)
2. POSTs it to `https://scoutos.live/api/build`
3. Waits ~45s for the build to complete
4. Prints the health check result and setup URL

### First-time setup

After deploy, visit `https://scout-tg-bridge.scoutos.live/setup` and enter:

| Field | Description |
|-------|-------------|
| Telegram Bot Token | From [@BotFather](https://t.me/BotFather) — `7123456789:AAF...` |
| Scout API Key | From your Scout dashboard |
| Scout Agent / Flow ID | The agent or flow to route messages to |
| Allowed Telegram user IDs | Comma-separated list (leave blank to allow everyone) |

Hitting Save will validate the credentials and register the Telegram webhook automatically.

### Useful endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Health check — returns `{"status":"ok"}` |
| `GET /setup` | Operator config UI |
| `GET /flush` | Drop pending Telegram updates + re-register webhook |
| `POST /webhook/telegram` | Telegram webhook receiver (set automatically by `/setup`) |

## Local development

```bash
npm install
cp .env.example .env   # add PORT, APP_URL if needed
npm run dev
```

Expose with [ngrok](https://ngrok.com) or similar, then point your bot's webhook to `https://your-tunnel.ngrok.io/webhook/telegram`.

## Environment variables

These are only needed for deploy — runtime config lives in `/setup`.

| Variable | Required | Description |
|----------|----------|-------------|
| `SCOUTOS_KEY` | ✅ deploy | scoutos.live API key |
| `SCOUTOS_DEPLOY_CODE` | ✅ deploy | Deploy code for the subdomain |
| `PORT` | optional | HTTP port (default `3000`) |
| `APP_URL` | optional | Public URL (default `https://scout-tg-bridge.scoutos.live`) |

## Tech stack

- [Hono](https://hono.dev) — fast web framework
- [@hono/node-server](https://github.com/honojs/node-server) — Node.js adapter
- TypeScript + tsx
- scoutos.live `_ports/data` for persistent config storage

## License

MIT
