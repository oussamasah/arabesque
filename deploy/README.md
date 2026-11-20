# Production on the VPS (cafe.hidevai.com)

Layout on the server:

| Path | Content |
|---|---|
| `/opt/cafe/app` | git clone of this repository + `.env` (secrets, `chmod 600`) |
| `/opt/cafe/backups` | nightly database dumps (30 days) |
| Docker project `cafe` | `cafe-app-1` (Next.js) and `cafe-db-1` (PostgreSQL 16, private network only) |

The app container joins the existing Caddy network `cinify_default` with the alias `cafe-app`; Caddy (`cinify-caddy-1`) serves `cafe.hidevai.com` with automatic HTTPS (block in `deploy/cafe.caddy`).

> The Caddyfile lives in the cinify release folder (`/opt/cinify/releases/<sha>/Caddyfile`). After a new cinify release, re-add the `cafe.hidevai.com` block (like the `wessarticles` block) and reload Caddy.

## First install

```sh
mkdir -p /opt/cafe && cd /opt/cafe
git clone https://github.com/oussamasah/arabesque.git app && cd app
# secrets (never commit this file)
P=$(openssl rand -hex 24)
cat > .env <<EOF
POSTGRES_PASSWORD=$P
DATABASE_URL=postgres://cafe:$P@db:5432/cafe
SESSION_SECRET=$(openssl rand -hex 32)
TOTP_ENCRYPTION_KEY=$(openssl rand -hex 32)
CRON_SECRET=$(openssl rand -hex 24)
TELEGRAM_BOT_TOKEN=
TZ=Africa/Tunis
EOF
chmod 600 .env
docker compose up -d --build
# catalogue (products, prices, images, stock items, recipes)
docker compose exec app node scripts/import-products.mjs
docker compose exec app node scripts/import-recipes.mjs
docker compose exec app node scripts/set-gobelet-addon.mjs
```

> **Never change `TOTP_ENCRYPTION_KEY`** after the first start (it encrypts the 2FA secret and the ticket tokens).

## Update to a new version

```sh
cd /opt/cafe/app && git pull && docker compose up -d --build
```
Database migrations run automatically at startup.

## Scheduled jobs (root crontab)

```cron
5 * * * *  . /opt/cafe/app/.env; curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://cafe.hidevai.com/api/cron/checks >/dev/null
0 7 * * *  . /opt/cafe/app/.env; curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://cafe.hidevai.com/api/cron/daily >/dev/null
30 3 * * * sh /opt/cafe/app/deploy/backup.sh
```

## Restore a backup

```sh
gunzip -c /opt/cafe/backups/cafe-YYYY-MM-DD-HHMM.sql.gz | docker compose exec -T db psql -U cafe -d cafe
```
