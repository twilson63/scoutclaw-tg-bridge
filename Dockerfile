# ─────────────────────────────────────────────────────────
# Stage 1: Install dependencies
# ─────────────────────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

COPY package.json ./
RUN npm install --production=false

# ─────────────────────────────────────────────────────────
# Stage 2: Runtime
# ─────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production
ENV PORT=3000
ENV APP_URL=https://scout-tg-bridge.scoutos.live

EXPOSE 3000

# Run as non-root user (required by scoutos.live)
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

CMD ["node_modules/.bin/tsx", "src/index.ts"]
