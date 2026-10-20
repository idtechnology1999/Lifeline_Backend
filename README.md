# Lifeline API

Backend for the Lifeline mobile app (`../Lifeline`) and admin console
(`../admin-lifeline`): NestJS + TypeScript, PostgreSQL with PostGIS, Redis,
Socket.IO and Firebase Cloud Messaging. Uploaded files stay on the server's
private disk, and the database keeps only their metadata.

- Endpoints: [docs/API.md](docs/API.md)
- Production on a VPS, plus encrypted backups: [docs/DEPLOY.md](docs/DEPLOY.md)

## Run locally (Windows dev machine)

You need PostgreSQL 17 with PostGIS, Redis and Node 24.

```bash
cp .env.example .env          # set DATABASE_URL, APP_KEY, ADMIN_PASSWORD, APP_DEBUG=true
npm install                   # also generates the Prisma client
npx prisma migrate dev        # creates the tables (PostGIS included)
npm run db:seed               # settings, admin, demo accounts and sample activity
npm run start:dev             # http://0.0.0.0:8000/api/v1
```

Demo logins (OTP shown in the app while `APP_DEBUG=true`): `08030000001`
patient, `…02` ambulance, `…03` pharmacy, `…04` rider. The admin is
`ADMIN_EMAIL` / `ADMIN_PASSWORD`.

## Tests

```bash
npm run test:e2e
```

Runs the whole API against a separate `lifeline_test` database (created and
migrated automatically; it is emptied before every test, and the run refuses
any database whose name doesn't end in `_test`) and Redis database 1.

## Layout

| Folder | What's there |
|---|---|
| `prisma/` | Schema, migrations (with the PostGIS trigger that keeps `providers.location` in sync), seed |
| `src/auth` | Phone OTP, admin password login, revocable bearer tokens, role guards |
| `src/emergency` | Ambulance requests: negotiation, assignment, trips (sorted by PostGIS distance) |
| `src/orders` | Public catalog, patient orders, pharmacy orders, rider deliveries |
| `src/providers` | Provider registration, documents, GPS location, products, earnings/withdrawals |
| `src/requester` | Patient wallet, subscription, contacts, addresses |
| `src/admin` | Admin console endpoints |
| `src/payments` | Payments (demo mode: card/transfer succeed instantly), wallet ledger, commission |
| `src/notifications` | Inbox + Socket.IO + FCM push |
| `src/realtime` | Socket.IO gateway (Redis adapter) and live trip/order/location broadcasts |
| `src/files` | Private file storage with signed, expiring links |
