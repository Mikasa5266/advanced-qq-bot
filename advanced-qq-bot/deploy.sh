#!/usr/bin/env bash
set -euo pipefail

APP_NAME="advanced-qq-bot"
APP_DIR="/opt/advanced-qq-bot"

if ! command -v node >/dev/null 2>&1; then
  echo "[ERR] node not found. Install Node.js 18+ first."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "[ERR] npm not found."
  exit 1
fi

if ! command -v pm2 >/dev/null 2>&1; then
  echo "[INFO] pm2 not found, installing globally..."
  npm install -g pm2
fi

if [ ! -d "$APP_DIR" ]; then
  echo "[ERR] APP_DIR not found: $APP_DIR"
  exit 1
fi

cd "$APP_DIR"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "[WARN] .env was missing. Created from .env.example, please edit it first."
  exit 1
fi

mkdir -p logs

npm ci --omit=dev
npm run db:bootstrap
npm run check

pm2 startOrReload ecosystem.config.cjs --env production
pm2 save

echo "[OK] deploy finished. Check logs with: pm2 logs $APP_NAME"
