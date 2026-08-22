# DropCode — Peer-to-Peer File Transfer

Send a file, get a 5-digit code, share it. The receiver enters the code and
the file streams **directly between the two browsers over WebRTC** — it
never touches any server, cloud storage, or database.

## How it works

```
Sender                          Signaling Worker                   Receiver
  |  create-room (fileMeta)  --------->  |
  |  <--------  room-created (code)      |
  |                                      |   <--------  join-room (code)
  |  <--------  receiver-joined          |
  |  offer  --------------------------->  |  --------->  offer
  |                                      |   <--------  answer
  |  <---------------------------------  |  answer
  |  <---- ICE candidates (both ways) ---|----> ICE candidates
  |                                      |
  |======= RTCDataChannel (direct P2P) =========|
  |  file chunks stream browser -> browser, server never sees them
```

The signaling Worker's only job is exchanging WebRTC handshake messages
(offer/answer/ICE), managing the 5-digit code → room mapping, and minting
short-lived TURN credentials, all via a Durable Object. Once the
`RTCDataChannel` opens, file bytes flow directly between browsers.
**No file data is ever sent to, or stored by, the Worker.**

## Project structure

```
DropCode-P2P/
├── .github/workflows/
│   └── deploy-pages.yml    # publishes frontend/ to GitHub Pages on push
├── frontend/
│   ├── index.html
│   ├── styles.css
│   ├── app.js               # WebSocket signaling client + WebRTC transfer logic
│   └── config.js            # signaling Worker URL / TURN override
├── signaling-worker/
│   ├── src/
│   │   ├── index.js         # Worker entrypoint: /health, /ice-servers, WS upgrade, CORS
│   │   └── room.js          # SignalingRoom Durable Object: rooms, relay, TTL, rate limiting
│   ├── package.json
│   ├── wrangler.toml
│   └── README.md            # full deploy/config/test reference for the Worker
├── .env.example
├── .gitignore
└── README.md                 # this file
```

## Authoritative architecture

- **Frontend:** static HTML/CSS/JS, hosted on **GitHub Pages** (this is the
  supported target — not Cloudflare Pages).
- **Signaling:** Cloudflare Worker, WebSocket upgrade routed to a Durable
  Object per the standard "one coordinator object" pattern.
- **NAT traversal:** Cloudflare's public STUN (`stun.cloudflare.com`) plus
  Google's public STUN, both free/unlimited.
- **Fallback relay:** Cloudflare Realtime TURN, short-lived credentials
  minted by the Worker per request — no long-lived secret ever reaches the
  browser.
- **File transfer:** WebRTC DataChannel, chunked, with `bufferedAmount`
  backpressure. The Worker/Durable Object never sees file bytes.
- No database, no Firebase, no R2/S3 — the Durable Object's own storage is
  the only state that exists, and it holds only room metadata (code,
  internal session id, file name/size/type, expiry) — never file contents.

---

## Deployment — step by step

### Part 1: the signaling Worker (Cloudflare)

**1.** Install Node.js if you don't have it (needed for `npm`/`npx`; the
Worker itself doesn't run Node at runtime).

**2.**
```bash
cd signaling-worker
npm install
npx wrangler login
npx wrangler deploy
```

**3.** Copy the `*.workers.dev` URL Wrangler prints, e.g.
`https://dropcode-signaling.<your-subdomain>.workers.dev`.

**4.** Put that URL into `frontend/config.js`, with `https://` changed to
`wss://`:
```js
window.DROPCODE_WS_URL = window.DROPCODE_WS_URL || 'wss://dropcode-signaling.<your-subdomain>.workers.dev';
```
The file ships with an obvious placeholder (`REPLACE-WITH-YOUR-WORKER-SUBDOMAIN`)
that will not work until you replace it with your own deployed Worker's URL.

### Part 2: TURN (Cloudflare Realtime — recommended)

TURN is not optional for a project meant to work across arbitrary countries
and networks — without it, users behind symmetric NAT or restrictive
firewalls simply can't connect.

**1.** In the Cloudflare dashboard: **Realtime → TURN → Create TURN key**
(or via API: `POST /accounts/{account_id}/calls/turn_keys`, "Calls Write"
permission). Note the returned **key uid** and the **bearer token/key
secret**.

Alternatively, using an API token instead of the raw key secret: create an
API token scoped to **Calls Write**, and use the TURN key's `uid` as
`CF_TURN_KEY_ID` alongside that token as `CF_TURN_API_TOKEN`.

**2.** From inside `signaling-worker/`:
```bash
npx wrangler secret put CF_TURN_KEY_ID
npx wrangler secret put CF_TURN_API_TOKEN
npx wrangler deploy
```

**3.** Verify:
```bash
curl https://dropcode-signaling.<your-subdomain>.workers.dev/ice-servers
```
You should see a `turnServers` array containing `turn.cloudflare.com`
entries with a fresh `username`/`credential` pair each time you call it —
that's the short-lived credential working. An empty array means
`CF_TURN_KEY_ID`/`CF_TURN_API_TOKEN` aren't set (or Cloudflare's API call
failed), and the app will run STUN-only.

Cloudflare Realtime TURN's free tier is 1,000 GB/month of relayed traffic —
more than enough for personal or small-scale use. See
[Cloudflare's TURN pricing](https://developers.cloudflare.com/realtime/sfu/pricing/)
if usage grows.

*(Using a non-Cloudflare TURN provider instead — coturn, Twilio, Metered,
Xirsys? Set `TURN_URLS` / `TURN_USERNAME` / `TURN_CREDENTIAL` via
`wrangler secret put` instead. These are static/long-lived, since most
third-party TURN REST APIs don't offer short-lived minting — the Worker
only falls back to this path if `CF_TURN_KEY_ID`/`CF_TURN_API_TOKEN` are
unset.)*

### Part 3: allow your GitHub Pages origin

`signaling-worker/wrangler.toml` → `[vars]` → `ALLOWED_ORIGINS` is the
allowlist of browser origins the Worker will accept a WebSocket upgrade
from. **This was the main reason previous deployments didn't work**: it
defaulted to a Cloudflare Pages domain, and a GitHub Pages origin was never
on the list, so the Worker returned HTTP 403 on every upgrade attempt from
the real deployed site — which browsers surface as a generic "can't
connect," not a CORS error.

Figure out your actual GitHub Pages URL first (see Part 4), then:
```
ALLOWED_ORIGINS = "https://YOUR-USERNAME.github.io,http://localhost:3000,http://127.0.0.1:3000"
```
Edit `wrangler.toml`, replace `YOUR-USERNAME`, and redeploy:
```bash
npx wrangler deploy
```

### Part 4: the frontend (GitHub Pages)

**This project's `index.html` lives in `frontend/`, not at the repo root.**
GitHub Pages' default "deploy from a branch" mode only serves the repo root
(or `/docs`), so using that mode as-is would 404 on every page. This repo
includes `.github/workflows/deploy-pages.yml`, which publishes the
`frontend/` folder itself as the site, using GitHub's official Pages
Actions — no need to move files or maintain a `gh-pages` branch by hand.

**1.** Push this repo to GitHub (with the `.github/workflows/` folder
included).

**2.** Repo → **Settings → Pages → Build and deployment → Source**: select
**"GitHub Actions"** (not "Deploy from a branch" — that's what causes the
404).

**3.** Push to `main` (or run the workflow manually from the Actions tab).
The Actions tab will show the deploy running, then finishing with your live
URL, in one of these two shapes depending on your repo name:
- User/org site (`your-username.github.io` repo): `https://your-username.github.io/`
- Project site (any other repo name): `https://your-username.github.io/your-repo-name/`

**4.** That exact URL (scheme + host, **no trailing slash**, and no path
for a project site — origins don't include paths) is what goes into
`ALLOWED_ORIGINS` in Part 3. Example: for
`https://your-username.github.io/dropcode/`, the origin is
`https://your-username.github.io` (yes, without `/dropcode` — CORS/WebSocket
origin checks are scheme+host+port only, the path is irrelevant to them).

### Part 5: local testing before deploying anywhere

```bash
cd frontend
npx serve -l 3000
# or: python3 -m http.server 3000
```
Open `http://localhost:3000` — already in the default `ALLOWED_ORIGINS`, so
the WebSocket should connect immediately. Open the same URL in a second
browser/private window to test sender + receiver locally first.

### Part 6: real cross-network test

Open your deployed GitHub Pages URL from two different devices on two
different networks (ideally two different countries, matching this
project's stated use case). **Send File** on one, **Receive File** with the
code on the other, confirm the file arrives intact — then repeat with one
device on a network likely to block direct P2P (e.g. a mobile hotspot or a
locked-down office network) to confirm the TURN fallback actually kicks in.

---

### Testing `/health` and `/ice-servers`

```bash
curl https://dropcode-signaling.<your-subdomain>.workers.dev/health
# {"ok":true,"activeRooms":0}

curl https://dropcode-signaling.<your-subdomain>.workers.dev/ice-servers
# {"turnServers":[]}   -- until CF_TURN_KEY_ID/CF_TURN_API_TOKEN (or the static
#                          TURN_* fallback) are set, then TURN entries appear
```

### Worldwide connectivity: STUN vs. TURN

STUN alone lets most home/office routers establish a **direct**
peer-to-peer connection, but does **not** guarantee connectivity everywhere:
symmetric NATs, some CGNAT/mobile carrier networks, and locked-down
corporate firewalls can block direct P2P outright. In that case
`RTCPeerConnection` reports `connectionState: "failed"` and the app shows
*"Couldn't establish a direct connection. This network may require a TURN
relay."* TURN (Part 2 above) is the fix, and given this project's stated
cross-country use case, it should be configured before relying on this
for real transfers, not treated as optional.

### Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Frontend loads but every page is 404 on GitHub Pages | Pages source is set to "Deploy from a branch" instead of "GitHub Actions", or `index.html`'s location doesn't match the Pages source | Settings → Pages → Source → "GitHub Actions" (see Part 4) |
| "Can't establish a connection to `wss://...`" in the browser console | Your GitHub Pages origin isn't in `ALLOWED_ORIGINS` — the Worker returns HTTP 403 on the upgrade, which browsers surface as a generic connection failure, not a 403 | Add the exact origin (scheme + host, no path, no trailing slash) to `ALLOWED_ORIGINS` in `wrangler.toml` and `npx wrangler deploy` again (see Part 3) |
| CORS error on `/health` or `/ice-servers` only (WebSocket itself is fine) | Same `ALLOWED_ORIGINS` allowlist also governs the `Access-Control-Allow-Origin` header on those two GET endpoints | Same fix as above |
| ICE connection state goes to `failed` | No direct P2P path between the two networks and TURN isn't configured (or Cloudflare Realtime TURN credential generation failed) | Complete Part 2; check `curl .../ice-servers` returns a non-empty `turnServers` array |
| "That code is invalid, expired, or already claimed" | Code typo, code already used by a receiver, or the 30-minute TTL expired | Generate a new code (create a new send) |
| File transfer stuck partway through | One peer's tab was closed/backgrounded (mobile browsers throttle backgrounded tabs) or the DataChannel hit `bufferedAmount` backpressure and never drained | Keep both tabs foregrounded during the transfer; retry |
| Frontend loads (HTML/CSS visible) but nothing works | `app.js` or `config.js` failed to load/parse, or `window.DROPCODE_WS_URL` still has the placeholder value | Check the browser console for a script error; confirm `config.js` was actually edited with your real Worker URL |
| `npx wrangler deploy` fails | Not logged in, or `wrangler.toml`/`package.json` syntax error | `npx wrangler login`; run `node --check` on the source files and validate `wrangler.toml` |
| Health check works but WebSocket doesn't | `/health` is a plain GET — it never exercises the `Upgrade: websocket` code path or the origin check, so it proves the Worker is deployed but nothing about the socket | Test the WebSocket directly (see `signaling-worker/README.md`'s test procedure), not just `/health` |

## Known limitations

- No resume-after-full-disconnect — a dropped connection mid-transfer means
  starting over.
- Files well above a few hundred MB are not guaranteed to complete
  reliably on lower-memory mobile browsers; the receiver currently holds
  received chunks in memory until the transfer completes, then assembles
  them into a single Blob for download. "Up to 1 GB" is realistic on
  typical desktop browsers with a stable connection — treat it as
  network/device-dependent, not a guarantee, and communicate that to users.
- A small fraction of very restrictive networks may still fail even with
  TURN configured, if those networks block TURN's ports outright.
- All active rooms currently coordinate through a single Durable Object
  instance (matching this project's original design) rather than one
  Durable Object per room. This is simple and correct, and Durable Objects
  comfortably handle far more room/session volume than a personal or
  small-scale deployment will produce — but it does mean every signaling
  message in the system passes through one object, and that object lives
  in whichever Cloudflare location first created it. For personal-scale
  use this is a non-issue; if this project ever needed to scale to heavy
  concurrent usage, sharding rooms across one Durable Object per code
  (via `env.ROOMS.idFromName(code)`) would be the next architectural step.

## Privacy

Files are transferred directly between connected browsers whenever
possible. The signaling server (Worker + Durable Object) coordinates
sessions — room code, expiry, and file name/size/type for display — but
never receives or stores file contents. When a direct peer-to-peer path
isn't available, WebRTC falls back to relaying encrypted traffic through
Cloudflare Realtime TURN; Cloudflare cannot decrypt this traffic (WebRTC's
DTLS encryption applies end-to-end between the two browsers), but it does
transit Cloudflare's infrastructure in that case. There is no database, no
Firebase, and no permanent file storage anywhere in this project.

Full Worker/Durable Object internals, environment variables, and a
two-browser test procedure including negative-path tests are in
[`signaling-worker/README.md`](./signaling-worker/README.md).
