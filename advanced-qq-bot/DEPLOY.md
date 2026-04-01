# Production Deploy (PM2)

## 1) Server prerequisites

- Ubuntu/CentOS with Node.js 18+
- MySQL reachable from server
- NapCat reachable from server (usually localhost)

## 2) Prepare files

```bash
cd /opt
# your code should exist at /opt/advanced-qq-bot
cd /opt/advanced-qq-bot
cp .env.example .env
vi .env
```

Fill required values in `.env`:

- `QWEN_API_KEY`
- `NAPCAT_TOKEN`
- `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`

Useful token-cost knobs in `.env`:

- `MAX_HISTORY_CONTEXT_CHARS`, `MEMORY_INJECT_MAX_CHARS`
- `SHORT_REPLY_HISTORY_CHARS`, `SHORT_REPLY_MEMORY_CHARS`
- `ENABLE_FAST_REPLY`, `ENABLE_FEWSHOT`

## 3) One-click deploy

```bash
cd /opt/advanced-qq-bot
chmod +x deploy.sh
./deploy.sh
```

The script will:

- install production dependencies
- bootstrap tables/indexes (`npm run db:bootstrap`)
- run syntax checks
- start or reload PM2 app

## 4) Runtime commands

```bash
cd /opt/advanced-qq-bot
npm run pm2:logs
npm run pm2:reload
npm run pm2:stop
```

## 5) Auto-start after reboot (optional)

```bash
pm2 startup
pm2 save
```

Run the command printed by `pm2 startup` once with sudo.
