#!/bin/bash
# Deploy ScoutClaw Telegram Bridge to scoutos.live
# Usage: ./deploy.sh

set -e

SUBDOMAIN="scout-tg-bridge"
DEPLOY_CODE="${SCOUTOS_DEPLOY_CODE:?SCOUTOS_DEPLOY_CODE env var required}"
DEPLOY_KEY="${SCOUTOS_KEY:?SCOUTOS_KEY env var required}"

echo "🦞 Deploying ScoutClaw Telegram Bridge to ${SUBDOMAIN}.scoutos.live..."

# Build tarball (exclude node_modules)
cd "$(dirname "$0")"
tar -czf /tmp/${SUBDOMAIN}.tar.gz \
  --exclude='node_modules' \
  --exclude='.git' \
  .

RESPONSE=$(curl -s -X POST \
  "https://scoutos.live/api/build?subdomain=${SUBDOMAIN}&code=${DEPLOY_CODE}" \
  -H "Authorization: Bearer ${DEPLOY_KEY}" \
  --data-binary @/tmp/${SUBDOMAIN}.tar.gz)

echo "Response: ${RESPONSE}"

BUILD_ID=$(echo "$RESPONSE" | grep -o '"buildId":"[^"]*"' | cut -d'"' -f4)
if [ -n "$BUILD_ID" ]; then
  echo ""
  echo "Build queued: ${BUILD_ID}"
  echo "Waiting for deployment..."
  sleep 45
  STATUS=$(curl -s "https://scoutos.live/api/build/${BUILD_ID}/status" \
    -H "Authorization: Bearer ${DEPLOY_KEY}" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)
  echo "Status: ${STATUS}"
fi

echo ""
echo "Health: $(curl -s https://${SUBDOMAIN}.scoutos.live/health | grep -o '"status":"[^"]*"')"
echo "Setup:  https://${SUBDOMAIN}.scoutos.live/setup"
