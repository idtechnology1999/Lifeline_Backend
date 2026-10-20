# Lifeline API v1

Base URL: `http://<host>:8000/api/v1`. All bodies are JSON with camelCase keys.
Send `Authorization: Bearer <token>` on everything except the auth endpoints.
Lists are paginated: `{ data: [...], links, meta }` (`?page=`, `?per_page=`).
Errors: `422 { message, errors: { field: [..] } }`, `403`/`404`/`409 { message }`.

## Auth

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/auth/otp/send` | `phone, purpose: login\|signup` | `debugCode` is returned while `APP_DEBUG=true` (no SMS gateway yet; the code is also printed in the server log) |
| POST | `/auth/otp/verify` | `phone, code, purpose`, signup: `name, email?, city?, role: requester\|provider` | Returns `{ token, user }`. `user.provider` tells a provider app which dashboard to open |
| POST | `/admin/auth/login` | `email, password` | Admin only. Returns `{ token, user }` |
| GET/PATCH | `/me` | `name, email, city` | |
| POST | `/auth/logout` | | Revokes the current token |
| GET | `/notifications` | | Latest 50 `{ id, type, title, body, data: { requestId?, orderId? }, read, createdAt }` + `unreadCount` |
| GET | `/notifications/unread-count` | | `{ unreadCount }` (cheap, for badges) |
| POST | `/notifications/{id}/read` · `/notifications/read-all` | | |

## Requester (role `requester`)

| Method | Path | Body |
|---|---|---|
| GET | `/pricing` | Base rates, delivery fee, plan prices (public, no token) |
| GET | `/products?search=&category=&supplierId=` | Public, no token |
| GET | `/products/{id}` | Public, no token |
| GET/POST | `/emergency-requests` | `severity, ambulanceType, symptoms[], notes?, pickup, pickupLat?, pickupLng?, destination` |
| GET | `/emergency-requests/{id}` | Includes open `offers[]` from ambulances. Poll this while negotiating |
| POST | `/emergency-requests/{id}/offers/{offerId}/counter` | `amount` |
| POST | `/emergency-requests/{id}/offers/{offerId}/accept` | Only when the offer's `lastBy` is `provider` |
| POST | `/emergency-requests/{id}/pay` | `method: card\|transfer\|wallet` |
| POST | `/emergency-requests/{id}/cancel` | |
| GET/POST | `/orders` | `items: [{productId, qty}], deliveryAddress, deliveryNote?, urgent?` (one pharmacy per order) |
| GET | `/orders/{id}` | |
| POST | `/orders/{id}/pay` | `method` |
| POST | `/orders/{id}/cancel` | Before pickup only |
| POST/DELETE | `/subscription` | `plan: basic\|family\|annual, method` |
| GET | `/wallet` | `{ balance, entries[] }` (last 50: fund / payment / refund) |
| POST | `/wallet/fund` | `amount (100–1,000,000), method: card\|transfer` (simulated, succeeds instantly) |
| GET/POST | `/me/contacts` | `name, relation, phone` (max 10) |
| DELETE | `/me/contacts/{id}` | |
| GET/POST | `/me/addresses` | `label?, address` (max 10) |
| DELETE | `/me/addresses/{id}` | |

Paying with `method: wallet` spends the wallet balance (422 if too low); refunds of wallet payments go back to the wallet.

Request status: `searching → negotiating → en_route → on_trip → completed` (or `cancelled`).
Order status: `pending → accepted → picked_up → delivered` (or `cancelled`).

## Provider (role `provider`)

Registration works before approval. Everything else needs `verification = approved`.

| Method | Path | Body |
|---|---|---|
| GET | `/provider` | `data: null` until registered |
| POST | `/provider` | `type: ambulance\|supplier\|dispatcher, businessName, contactName, phone?, email?, city?, address?, vehicle?: {kind, plate}, availability: 24/7\|scheduled, hours?: {start, end}, details?: {...}` |
| PATCH | `/provider` | Same fields minus `type`. Editing a rejected application resubmits it |
| POST | `/provider/documents` | multipart: `file` (jpg/png/webp/pdf ≤5MB), `name`, `kind: id\|license\|registration\|insurance\|photo\|other` |
| DELETE | `/provider/documents/{id}` | |
| PATCH | `/provider/status` | `online: bool` |
| GET | `/provider/earnings` | `totalEarnings, availableBalance, completedJobs, recent[]` |
| GET/POST | `/provider/withdrawals` | `amount (≥1000), bank, accountName, accountNumber (10 digits)` |

**Ambulance**

| Method | Path | Body |
|---|---|---|
| GET | `/provider/emergency-requests?scope=open\|mine` | |
| GET | `/provider/emergency-requests/{id}` | |
| POST | `/provider/emergency-requests/{id}/offer` | `amount, etaMinutes?` |
| POST | `/provider/emergency-requests/{id}/accept-counter` | |
| POST | `/provider/emergency-requests/{id}/decline` | |
| POST | `/provider/emergency-requests/{id}/start-trip` | Patient picked up |
| POST | `/provider/emergency-requests/{id}/complete` | Credits earnings minus commission |

**Pharmacy (supplier)**

| Method | Path | Body |
|---|---|---|
| GET/POST | `/provider/products` | `name, category, price, stock, description?, usageNotes?, expiresAt?, available?, requiresPrescription?, emoji?, imageUris?` |
| GET/PATCH/DELETE | `/provider/products/{id}` | |
| POST | `/provider/products/{id}/images` | multipart `image` (≤5MB, max 6 per product). Returns the product with the new URL in `imageUris` |
| GET | `/provider/orders?status=pending,accepted` | |
| POST | `/provider/orders/{id}/accept` | Reserves stock and releases the order to riders |
| POST | `/provider/orders/{id}/decline` | |

**Dispatcher (rider)**

| Method | Path | |
|---|---|---|
| GET | `/provider/deliveries/available` | Accepted orders with no rider yet |
| GET | `/provider/deliveries?status=` | My deliveries |
| POST | `/provider/deliveries/{id}/accept` | One active delivery at a time |
| POST | `/provider/deliveries/{id}/pickup` | "I've arrived at pickup" |
| POST | `/provider/deliveries/{id}/deliver` | Pays the pharmacy (minus commission) and the rider (delivery fee) |

## Admin (role `admin`)

| Method | Path | Body |
|---|---|---|
| GET | `/admin/dashboard` | Counts and revenue |
| GET | `/admin/providers?type=&verification=&search=` | |
| GET | `/admin/providers/{id}` | |
| POST | `/admin/providers/{id}/approve` | |
| POST | `/admin/providers/{id}/reject` | `reason` |
| PATCH | `/admin/providers/{id}/status` | `status: active\|suspended` (suspending signs them out) |
| GET | `/admin/requesters?search=&status=` | |
| PATCH | `/admin/requesters/{id}/status` | `status` |
| GET | `/admin/emergency-requests?status=a,b&severity=` | |
| POST | `/admin/emergency-requests/{id}/assign` | `providerId, etaMinutes?` |
| POST | `/admin/emergency-requests/{id}/cancel` | |
| GET | `/admin/orders?status=` | |
| POST | `/admin/orders/{id}/cancel` | |
| GET | `/admin/transactions?kind=&status=` | |
| POST | `/admin/transactions/{id}/refund` | |
| GET | `/admin/withdrawals?status=` | |
| PATCH | `/admin/withdrawals/{id}/status` | `status: paid\|declined` |
| GET/PUT | `/admin/settings` | Same shape as admin-lifeline's `PlatformSettings` |

## Devices & files

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/devices` | `token, platform: android\|ios\|web` | Registers an FCM token for push notifications |
| GET | `/files/{id}?expires=&sig=` | | Streams an uploaded file. Product photos are public; documents and other private files need the signed link the API returns (valid 1 hour) |
| GET | `/health` | | `{ status, database, redis }` for uptime checks |

Uploads (`/provider/documents` field `file`, `/provider/products/{id}/images` field `image`) are multipart. Files are kept on the server's private disk (`STORAGE_DIR`); PostgreSQL stores only their metadata (`stored_files`).

## Realtime (Socket.IO)

Connect to the API host (path `/socket.io`) with `auth: { token }`, the same bearer token. Bad tokens get `connect_error: Unauthenticated.`

Every client joins `user:<id>`; approved providers also join `providers:<type>`. To follow a trip or delivery, emit `subscribe` with `{ type: 'request' | 'order', id }` (ack `{ ok }`; only people involved may subscribe) and `unsubscribe` to stop.

| Event | Room | Payload |
|---|---|---|
| `notification` | `user:<id>` | Same shape as an item of `GET /notifications` |
| `request.updated` | `request:<id>` | The emergency request (with open offers) |
| `requests.changed` | `providers:ambulance` | `{ id, status }`: refresh the open-requests list |
| `order.updated` | `order:<id>` | The supply order |
| `deliveries.changed` | `providers:dispatcher` | `{ id }`: a new order is ready for pickup |
| `location` | `request:<id>` / `order:<id>` | `{ providerId, lat, lng, updatedAt }` while the vehicle is on that job |

Polling the REST endpoints keeps working; sockets just make updates instant.

## Not real yet

- **SMS**: OTPs are only logged (`src/auth/otp.service.ts`).
- **Payments**: `PaymentService.charge` (`src/payments/payment.service.ts`) and wallet top-ups mark payments successful immediately (demo mode). Wire Paystack in before taking money.
- **Push**: works once `FIREBASE_SERVICE_ACCOUNT` points at a Firebase service-account JSON and the apps register tokens with `POST /devices`.
