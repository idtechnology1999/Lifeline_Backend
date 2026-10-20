# Deploying Lifeline API to a VPS

One Ubuntu 24.04 VPS runs everything: the API (Node 24), PostgreSQL 17 +
PostGIS, Redis and the uploaded files. Backups are encrypted and copied off
the server every night.

```
phones / admin ──HTTPS──▶ nginx ──▶ lifeline-api (Node, :8000) ──▶ PostgreSQL + PostGIS
                                         │  └─▶ Redis (rate limits, Socket.IO)
                                         └─▶ /srv/lifeline-data/storage (private files)
nightly: scripts/backup.sh ──age-encrypted──▶ off-site storage (rclone)
```

## 1. Packages

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git nginx redis-server postgresql-common age rclone ufw
sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
sudo apt install -y postgresql-17 postgresql-17-postgis-3
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt install -y nodejs
```

Redis: keep it on localhost (the default `bind 127.0.0.1 -::1`).

## 2. Database

```bash
sudo -u postgres psql <<'SQL'
CREATE ROLE lifeline LOGIN PASSWORD 'a-long-random-password';
CREATE DATABASE lifeline OWNER lifeline;
\c lifeline
CREATE EXTENSION postgis;
SQL
```

PostgreSQL only listens on localhost by default; leave it that way.

## 3. App

```bash
sudo useradd --system --create-home --home-dir /srv/lifeline lifeline
sudo mkdir -p /srv/lifeline-data/storage && sudo chown -R lifeline: /srv/lifeline-data
sudo chmod 700 /srv/lifeline-data/storage
sudo -iu lifeline
git clone <your repo> /srv/lifeline/lifeline-api && cd /srv/lifeline/lifeline-api
cp .env.example .env && chmod 600 .env   # then fill it in (below)
npm ci && npx prisma generate && npm run build
npx prisma migrate deploy
npx prisma db seed                       # settings + first admin (NODE_ENV=production skips demo data)
```

`.env` for production:

```
NODE_ENV=production
PORT=8000
HOST=127.0.0.1
APP_URL=https://api.example.com
APP_KEY=<node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))">
APP_DEBUG=false
DATABASE_URL=postgresql://lifeline:<password>@127.0.0.1:5432/lifeline
REDIS_URL=redis://127.0.0.1:6379
STORAGE_DIR=/srv/lifeline-data/storage
CORS_ORIGINS=https://admin.example.com
FIREBASE_SERVICE_ACCOUNT=/srv/lifeline/firebase-service-account.json
ADMIN_EMAIL=you@example.com
ADMIN_PASSWORD=<strong password; change it after first login>
BACKUP_AGE_RECIPIENT=age1...
BACKUP_REMOTE=b2:lifeline-backups
```

`APP_DEBUG` must be `false`: when it is `true` the API returns OTP codes in responses.

## 4. Run it with systemd

`/etc/systemd/system/lifeline-api.service`:

```ini
[Unit]
Description=Lifeline API
After=network.target postgresql.service redis-server.service

[Service]
User=lifeline
WorkingDirectory=/srv/lifeline/lifeline-api
ExecStart=/usr/bin/node dist/main.js
Restart=always
Environment=NODE_ENV=production
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/srv/lifeline-data /srv/lifeline/lifeline-api/backups

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now lifeline-api
curl http://127.0.0.1:8000/api/v1/health
```

## 5. nginx + HTTPS

`/etc/nginx/sites-available/lifeline-api`:

```nginx
server {
    server_name api.example.com;
    client_max_body_size 6m;            # uploads are capped at 5 MB

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # WebSockets (Socket.IO)
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 120s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/lifeline-api /etc/nginx/sites-enabled/
sudo apt install -y certbot python3-certbot-nginx && sudo certbot --nginx -d api.example.com
sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw enable
```

The admin console is a static build (`admin-lifeline`, `npm run build` with
`VITE_API_URL=https://api.example.com/api/v1`); serve its `dist/` from another
nginx server block. Build the mobile app with
`EXPO_PUBLIC_API_URL=https://api.example.com/api/v1`.

## 6. Push notifications

In the Firebase console: Project settings → Service accounts → Generate new
private key. Copy the JSON to the path in `FIREBASE_SERVICE_ACCOUNT`
(`chmod 600`, owned by `lifeline`) and restart. The log shows `FCM push enabled`.

## 7. Encrypted off-site backups

Medical records must survive losing the VPS. `scripts/backup.sh` dumps the
database and the files folder, encrypts them with [age](https://age-encryption.org)
and uploads them with rclone.

1. **On your own computer** (not the VPS): `age-keygen -o lifeline-backup.key`.
   Keep this file safe (password manager plus an offline copy). The printed
   `age1...` public key goes into `BACKUP_AGE_RECIPIENT`. The VPS only ever
   has the public key, so it can't read old backups even if it's broken into.
2. `sudo -iu lifeline rclone config` to add the remote, e.g. Backblaze B2
   with a bucket-only key, and set `BACKUP_REMOTE`.
3. Test it: `sudo -iu lifeline /srv/lifeline/lifeline-api/scripts/backup.sh`
4. Schedule it: `sudo -iu lifeline crontab -e`
   ```
   30 2 * * * /srv/lifeline/lifeline-api/scripts/backup.sh >> /srv/lifeline/backup.log 2>&1
   ```
   Turn on versioning or object lock on the bucket so backups can't be deleted from the VPS.

### Restore (practise this)

```bash
age --decrypt --identity lifeline-backup.key lifeline-<stamp>.tar.age | tar -xf -
pg_restore --clean --if-exists --no-owner --dbname=postgresql://lifeline:...@127.0.0.1:5432/lifeline db.dump
tar -xf storage.tar -C /srv/lifeline-data/
```

## Updating

```bash
cd /srv/lifeline/lifeline-api && git pull
npm ci && npx prisma generate && npm run build
npx prisma migrate deploy
sudo systemctl restart lifeline-api
```
