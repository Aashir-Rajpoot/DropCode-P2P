// Override this before app.js loads if the signaling server isn't on the
// same host, e.g.: <script>window.DROPCODE_WS_URL = 'wss://signal.example.com';</script>
// Left undefined, app.js derives ws(s)://<current-host>:4000 for local dev,
// or ws(s)://<current-host> when served from the same origin/port.
//
// ─────────────────────────────────────────────────────────────────────────
// REQUIRED: set this to YOUR OWN deployed Cloudflare Worker URL before
// deploying the frontend. After running `npx wrangler deploy` in
// signaling-worker/, Wrangler prints a URL like:
//     https://dropcode-signaling.<your-subdomain>.workers.dev
// Take that exact URL, change "https://" to "wss://", and put it below.
// This is NOT your frontend's GitHub Pages URL
// (e.g. NOT https://YOUR-USERNAME.github.io) — it must be the Worker URL.
//
// The placeholder below will NOT work as-is — it belongs to a different,
// unrelated Cloudflare account. Deploy your own Worker (see README.md) and
// replace this value, or the app will fail to connect for everyone.
// ─────────────────────────────────────────────────────────────────────────
window.DROPCODE_WS_URL = window.DROPCODE_WS_URL || 'wss://REPLACE-WITH-YOUR-WORKER-SUBDOMAIN.workers.dev';

// TURN servers for networks where direct STUN/P2P fails (symmetric NATs,
// CGNAT, some mobile/corporate networks) — this is what's missing when the
// browser reports "ICE failed, add a TURN server". By default app.js fetches
// these at runtime from the signaling server's GET /ice-servers, which
// reads TURN_URLS/TURN_USERNAME/TURN_CREDENTIAL from the Worker's
// environment (set via `wrangler secret put`, see signaling-worker/README.md)
// — so credentials live server-side, not in this static file. Leave
// undefined to use that. Only set this if you need to force a specific TURN
// config from the frontend instead, in which case it takes precedence:
// window.DROPCODE_TURN_SERVERS = [{ urls: 'turn:turn.example.com:3478', username: '...', credential: '...' }];
window.DROPCODE_TURN_SERVERS = window.DROPCODE_TURN_SERVERS || undefined;

// Set true to log ICE/connection/gathering/signaling state changes (and
// each ICE candidate) to the console — useful with chrome://webrtc-internals
// while diagnosing a failed connection. Off by default so production
// deployments don't spam the console.
window.DROPCODE_DEBUG_WEBRTC = window.DROPCODE_DEBUG_WEBRTC || false;
