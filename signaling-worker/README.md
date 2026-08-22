# DropCode Signaling — Cloudflare Workers + Durable Objects

Port of `signaling-server/server.js` (Node + `ws`) to Cloudflare Workers. Same
message protocol, same room/status model, same TTL and rate-limiting
behavior — the frontend (`frontend/app.js`) does not need to change, only
`frontend/config.js`'s `window.DROPCODE_WS_URL`.

## Files

```
signaling-worker/
  src/
    index.js     Worker entrypoint: /health, /ice-servers, WS upgrade routing, CORS/origin checks
    room.js       SignalingRoom Durable Object: rooms, relay, TTL, rate limiting
  wrangler.toml   Worker + Durable Object config, plain env vars
  package.json
  README.md
```

## What changed vs. the Node server, and why

| Node (`ws`) | Worker | Why |
|---|---|---|
| Single in-memory `rooms` Map in one process | `SignalingRoom` Durable Object, one instance (`env.ROOMS.idFromName('global-v1')`) coordinating all rooms | DOs give you a single-threaded, strongly-consistent place for the state multiple WebSockets share — the direct equivalent of "one Node process's memory" |
| `ws` event listeners (`connection`, `message`, `close`) | Hibernation API: `ctx.acceptWebSocket()`, `webSocketMessage()`, `webSocketClose()` | Current Cloudflare best practice; lets idle connections (e.g. a sender waiting for a receiver) be evicted from memory without disconnecting them |
| `setTimeout` per room for TTL | Durable Object Alarm (`ctx.storage.setAlarm`) | `setTimeout` doesn't survive hibernation/eviction; alarms do |
| Property set directly on `ws` (`ws.role`, `ws.roomCode`) | WebSocket attachment (`ws.serializeAttachment()` / `deserializeAttachment()`) | Plain JS properties don't survive hibernation; attachments do |
| `req.socket.remoteAddress` / `X-Forwarded-For` + `TRUST_PROXY` | `request.headers.get('CF-Connecting-IP')` | Workers have no raw socket; `CF-Connecting-IP` is set by Cloudflare at the edge and isn't attacker-controlled, so `TRUST_PROXY` isn't needed/used |
| Everything in-memory only | Room records + IP rate-limit records persisted to `ctx.storage`, rehydrated on wake | In-memory Maps don't survive hibernation the way they survived a long-running Node process |

Message types, payload shapes (`create-room`, `join-room`, `offer`, `answer`,
`ice-candidate`, `transfer-complete`, `cancel`, and the server's
`room-created`, `room-joined`, `receiver-joined`, `expired`, `cancelled`,
`sender-disconnected`, `receiver-disconnected`, `error` replies), the 5-digit
code format, one-receiver-per-room enforcement, room TTL, join rate
limiting, and `GET /health` / `GET /ice-servers` are all unchanged.

No file bytes ever pass through the Worker or the Durable Object — same as
before, this is signaling only (offer/answer/ICE).

---

## 1. Exact files to create/change

**Create** (new Cloudflare Workers project, e.g. as a sibling of your existing repo root):
- `signaling-worker/src/index.js`
- `signaling-worker/src/room.js`
- `signaling-worker/wrangler.toml`
- `signaling-worker/package.json`
- `signaling-worker/README.md`

**Change** (existing repo):
- `frontend/config.js` — set `window.DROPCODE_WS_URL` to your deployed Worker URL (see §7).

**Leave alone:**
- `frontend/app.js`, `frontend/index.html`, `frontend/styles.css` — untouched.
- `signaling-server/` (the old Node server) — you can keep it around or delete it once the Worker is verified; nothing here depends on it anymore.

Copy the two `signaling-worker/src/*.js` files, `wrangler.toml`, and
`package.json` exactly as given below into a new `signaling-worker/`
directory at your repo root (or wherever you keep it — it doesn't need to
live inside `DropCode-P2P` at all, since it's now a fully separate
deployable unit).

---

## 2. Complete contents of every changed file

All four Worker files (`src/index.js`, `src/room.js`, `wrangler.toml`,
`package.json`) and the `frontend/config.js` change are provided in full in
this response — copy them verbatim. Nothing is partial or a diff/snippet.

---

## 3. Exact CMD/PowerShell commands to install dependencies

From inside `signaling-worker/`:

```powershell
cd signaling-worker
npm install
```

This installs Wrangler (the Cloudflare CLI) as a local dev dependency —
nothing else. There is no runtime `dependencies` entry, because the Worker
uses only Web-standard APIs (`WebSocketPair`, `crypto.getRandomValues`,
`crypto.randomUUID`) plus the Durable Object API — no `ws`, no npm package
at runtime at all.

---

## 4. Exact Wrangler commands to login/deploy

```powershell
cd signaling-worker

# One-time: authenticate Wrangler with your Cloudflare account
npx wrangler login

# Deploy
npx wrangler deploy
```

`wrangler deploy` will print your Worker's URL, e.g.:

```
https://dropcode-signaling.<your-subdomain>.workers.dev
```

To run it locally first (optional but recommended before your first real deploy):

```powershell
npx wrangler dev
```

This starts a local server (default `http://localhost:8787`) that emulates
Workers + Durable Objects, including WebSockets and hibernation.

---

## 5. Exact Cloudflare dashboard settings

You don't need to click through the dashboard to deploy — `wrangler deploy`
does everything (creates the Worker, provisions the Durable Object
namespace/migration, sets plain vars from `wrangler.toml`). Dashboard steps
you *do* still want:

1. **Workers & Pages → dropcode-signaling → Settings → Domains & Routes**
   Confirm the `workers.dev` subdomain is enabled (it is by default the
   first time you deploy any Worker on your account) if you want the
   `*.workers.dev` URL. If you'd rather use your own domain
   (e.g. `signal.yourdomain.com`), add a custom domain here instead — you'll
   then use `wss://signal.yourdomain.com` as `DROPCODE_WS_URL` in step 7.

2. **Workers & Pages → dropcode-signaling → Settings → Variables and Secrets**
   You'll see `ALLOWED_ORIGINS`, `ROOM_TTL_MINUTES`, `MAX_JOIN_ATTEMPTS`,
   `LOCKOUT_WINDOW_MINUTES`, `LOCKOUT_DURATION_MINUTES` already populated
   from `wrangler.toml` (they redeploy from the file each time — edit
   `wrangler.toml`, not the dashboard, if you want the change to persist
   across deploys). `CF_TURN_KEY_ID` / `CF_TURN_API_TOKEN` (or the static
   `TURN_URLS` / `TURN_USERNAME` / `TURN_CREDENTIAL` fallback) will appear
   here as **Secrets** once you set them via CLI (step 6) — you can verify
   they exist here, but you cannot read their values back.

3. **Workers & Pages → dropcode-signaling → Durable Objects**
   Confirm the `ROOMS` binding → `SignalingRoom` class is listed, with SQLite
   storage. This is created automatically by the `[[migrations]]` block in
   `wrangler.toml` on first deploy.

4. **Your GitHub Pages frontend**
   This project's frontend is hosted on **GitHub Pages** (see the root
   `README.md`, Part 4), not Cloudflare Pages. Whatever your actual GitHub
   Pages origin is (`https://YOUR-USERNAME.github.io` — no path, even for a
   project site), it must match `ALLOWED_ORIGINS` in `wrangler.toml` exactly
   (scheme + host, no path, no trailing slash), or the Worker rejects the
   WebSocket upgrade with HTTP 403.

---

## 6. Exact environment/secrets commands

Plain vars (`ALLOWED_ORIGINS`, `ROOM_TTL_MINUTES`, etc.) live in
`wrangler.toml`'s `[vars]` block — edit the file directly, then
`npx wrangler deploy` to apply.

TURN credentials are **secrets** (not committed to the repo, not put in
`wrangler.toml`). Preferred: Cloudflare Realtime TURN, which the Worker
uses to mint a fresh, short-lived credential on every `/ice-servers`
request (see root `README.md` Part 2 for creating the TURN key itself):

```powershell
cd signaling-worker

npx wrangler secret put CF_TURN_KEY_ID
# paste your TURN key's uid when prompted

npx wrangler secret put CF_TURN_API_TOKEN
# paste your Cloudflare API token (Calls Write permission) or TURN key
# bearer token when prompted
```

I have not invented or filled in any values — you provide the real ones
from your own Cloudflare account. If you skip this step, `/ice-servers`
returns `{"turnServers":[]}` and the app runs STUN-only.

Only if you're deliberately using a non-Cloudflare TURN provider instead
(static/long-lived credentials, used only as a fallback when the two
secrets above are unset):

```powershell
npx wrangler secret put TURN_URLS
# e.g.: turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp,turns:turn.example.com:5349?transport=tcp
npx wrangler secret put TURN_USERNAME
npx wrangler secret put TURN_CREDENTIAL
```

To list which secrets are set (values are never shown):

```powershell
npx wrangler secret list
```

To remove one:

```powershell
npx wrangler secret delete CF_TURN_KEY_ID
```

Each `secret put`/`delete` triggers a redeploy of the current code with the
updated secret.

---

## 7. Exact frontend/config.js change

Replace this line in `frontend/config.js`:

```js
window.DROPCODE_WS_URL = window.DROPCODE_WS_URL || undefined;
```

with your deployed Worker URL:

```js
window.DROPCODE_WS_URL = window.DROPCODE_WS_URL || 'wss://dropcode-signaling.<your-subdomain>.workers.dev';
```

(This has already been applied for you in `frontend/config.js` in this
response — replace `<your-subdomain>` with the actual subdomain
`wrangler deploy` printed, or your custom domain if you set one up in §5.)

Nothing else in `frontend/config.js`, `app.js`, `index.html`, or
`styles.css` needs to change — `app.js` already derives the `/ice-servers`
HTTP(S) URL from `DROPCODE_WS_URL` by swapping `ws`→`http`, so it will
correctly call `https://dropcode-signaling.<your-subdomain>.workers.dev/ice-servers`.

---

## 8. Exact Git commands to push the changes

From your repo root (adjust paths if `signaling-worker/` lives outside the
main repo):

```powershell
git add signaling-worker/ frontend/config.js
git commit -m "Migrate signaling server to Cloudflare Workers + Durable Objects"
git push origin main
```

If `signaling-worker/` is its own separate repo instead:

```powershell
cd signaling-worker
git init
git add .
git commit -m "Initial commit: DropCode signaling on Cloudflare Workers"
git branch -M main
git remote add origin <your-new-repo-url>
git push -u origin main
```

Either way, deployment itself happens via `wrangler deploy` (§4), not via
git push — Wrangler doesn't require a git-integrated deploy pipeline unless
you separately set one up (Workers Builds CI, which isn't required here).

---

## 9. Exact test procedure using two browsers

1. Deploy the Worker (§4) and update+deploy the frontend with the new
   `DROPCODE_WS_URL` (§7).
2. **Browser A** (e.g. Chrome): open your deployed GitHub Pages URL, e.g. `https://YOUR-USERNAME.github.io/dropcode/`
   (or wherever your Pages frontend is), choose a file to send. Confirm you
   get a 5-digit room code on screen.
3. **Browser B** (e.g. Firefox, or Chrome Incognito to get a separate
   WebSocket/PeerConnection identity): open the same URL, enter the code
   from step 2, and join.
4. Confirm in Browser A that it shows "receiver joined" (or equivalent UI
   state) and the WebRTC connection proceeds to offer/answer/ICE exchange
   automatically.
5. Confirm the file transfer completes and the received file in Browser B
   matches the original (checksum or just open/compare it).
6. **Negative tests:**
   - Try joining with a code that doesn't exist → should get an error, not
     a crash.
   - Try joining the same code twice from a third browser/tab after Browser
     B already claimed it → should be rejected ("already claimed").
   - Close Browser B mid-transfer → Browser A should see a
     disconnect/cancelled state, not hang indefinitely.
   - Wait past `ROOM_TTL_MINUTES` (or temporarily set it to `1` in
     `wrangler.toml` and redeploy for a faster test) without joining →
     Browser A should receive `expired`.

## 10. Verifying the WebSocket connection and /health endpoint

**`/health`:**

```powershell
curl.exe https://dropcode-signaling.<your-subdomain>.workers.dev/health
```

Expected: `{"ok":true,"activeRooms":0}` (or a nonzero count if rooms are
currently active). A `200` with this JSON shape confirms the Worker is
deployed and the Durable Object is reachable and responding.

**`/ice-servers`:**

```powershell
curl.exe https://dropcode-signaling.<your-subdomain>.workers.dev/ice-servers
```

Expected: `{"turnServers":[]}` until you've set the three `TURN_*` secrets
(§6), after which it returns your configured TURN entry.

**WebSocket connection**, from the browser console on your deployed
frontend page (or any page, since this test doesn't depend on `app.js`):

```js
const ws = new WebSocket('wss://dropcode-signaling.<your-subdomain>.workers.dev');
ws.onopen = () => console.log('connected');
ws.onmessage = (e) => console.log('message', e.data);
ws.onerror = (e) => console.error('error', e);
ws.onclose = (e) => console.log('closed', e.code, e.reason);
```

You should see `connected` logged. Then:

```js
ws.send(JSON.stringify({ type: 'create-room', fileMeta: { name: 'test.txt', size: 123, mime: 'text/plain' } }));
```

You should see a `message` log with a `room-created` payload containing a
5-digit `code` and an `expiresAt` timestamp — confirming the Durable Object
is correctly creating and persisting room state end-to-end.

You can also watch live logs while testing:

```powershell
npx wrangler tail
```

This streams `console.log`/errors and request/WebSocket events from the
live Worker as they happen, useful for confirming origin-check rejections,
rate-limit lockouts, etc. during the two-browser test in §9.
