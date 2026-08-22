'use strict';

/**
 * DropCode signaling server — Cloudflare Workers entrypoint
 * ---------------------------------------------------------------------------
 * Ported from signaling-server/server.js. Stateless concerns (CORS/origin
 * checks, /ice-servers, WebSocket upgrade routing) live here in the Worker.
 * All shared room/session state lives in the SignalingRoom Durable Object
 * (see ./room.js), since that's the piece that multiple WebSocket
 * connections need to coordinate through.
 */

import { SignalingRoom } from './room.js';

function parseAllowedOrigins(env) {
  return (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Mirrors server.js's originAllowed(): with no ALLOWED_ORIGINS configured,
// any origin is allowed (fine for a public signaling relay carrying no
// sensitive data beyond ephemeral offer/answer/ICE payloads).
function originAllowed(request, env) {
  const allowed = parseAllowedOrigins(env);
  if (allowed.length === 0) return true;
  const origin = request.headers.get('Origin');
  return !!origin && allowed.includes(origin);
}

// Mirrors server.js's corsOriginFor(): '*' when no allowlist is configured,
// the exact matching origin when one is, or '' (no ACAO header at all) when
// the requesting origin isn't on the list.
function corsOriginFor(request, env) {
  const allowed = parseAllowedOrigins(env);
  if (allowed.length === 0) return '*';
  const origin = request.headers.get('Origin');
  return origin && allowed.includes(origin) ? origin : '';
}

// Cloudflare Realtime TURN: mints a fresh, short-lived credential per request
// via Cloudflare's documented REST mechanism (CF_TURN_KEY_ID / CF_TURN_API_TOKEN,
// set with `wrangler secret put`). This is the primary/preferred TURN path —
// no long-lived credential is ever generated or handed to the browser; every
// call to GET /ice-servers gets its own TTL-bounded credential.
// Docs: https://developers.cloudflare.com/realtime/turn/generate-credentials/
const TURN_CREDENTIAL_TTL_SECONDS = 3600; // 1 hour — comfortably covers a single transfer

async function cloudflareRealtimeTurnServers(env) {
  const keyId = env.CF_TURN_KEY_ID;
  const apiToken = env.CF_TURN_API_TOKEN;
  if (!keyId || !apiToken) return null; // not configured — caller falls back

  try {
    const resp = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: TURN_CREDENTIAL_TTL_SECONDS }),
      }
    );
    if (!resp.ok) return null; // bad/expired key, rate limited, etc. — degrade to STUN-only
    const data = await resp.json();
    return Array.isArray(data.iceServers) ? data.iceServers : null;
  } catch {
    // Network error reaching Cloudflare's API — degrade to STUN-only rather
    // than failing the whole /ice-servers response.
    return null;
  }
}

// Fallback path for a self-hosted/third-party TURN server (coturn, Twilio,
// Metered, Xirsys, ...) for anyone not using Cloudflare Realtime TURN. Only
// used if CF_TURN_KEY_ID/CF_TURN_API_TOKEN aren't set. Static, so — unlike
// the Cloudflare Realtime path above — these ARE long-lived credentials;
// that's an inherent limitation of most third-party TURN providers' REST
// APIs, not something this Worker can fix. Prefer Cloudflare Realtime TURN.
function staticTurnServersConfig(env) {
  const urls = (env.TURN_URLS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const username = env.TURN_USERNAME || '';
  const credential = env.TURN_CREDENTIAL || '';
  if (urls.length > 0 && username && credential) {
    return [{ urls, username, credential }];
  }
  return [];
}

async function turnServersConfig(env) {
  const cfServers = await cloudflareRealtimeTurnServers(env);
  if (cfServers) return cfServers;
  return staticTurnServersConfig(env);
}

function getRoomStub(env) {
  // Single coordinator instance — every WebSocket connection (and the
  // /health room-count check) is routed to the same Durable Object, the
  // same way server.js held all room state in one Node process's memory.
  // The literal name is versioned so a future breaking storage-format
  // change could migrate to a new instance by bumping this string.
  const id = env.ROOMS.idFromName('global-v1');
  return env.ROOMS.get(id);
}

function handleOptions(request, env) {
  const origin = corsOriginFor(request, env);
  const headers = {
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  return new Response(null, { status: 204, headers });
}

async function handleHealth(request, env) {
  try {
    const stub = getRoomStub(env);
    const doResp = await stub.fetch('https://internal/health');
    const data = await doResp.json();
    return new Response(JSON.stringify({ ok: true, activeRooms: data.activeRooms }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  } catch {
    // Matches server.js's shape even in the unlikely event the DO call fails.
    return new Response(JSON.stringify({ ok: true, activeRooms: 0 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}

async function handleIceServers(request, env) {
  const origin = corsOriginFor(request, env);
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  const turnServers = await turnServersConfig(env);
  return new Response(JSON.stringify({ turnServers }), {
    status: 200,
    headers,
  });
}

async function handleWebSocketUpgrade(request, env) {
  if (request.headers.get('Upgrade') !== 'websocket') {
    return new Response('Expected WebSocket upgrade', { status: 426 });
  }
  if (!originAllowed(request, env)) {
    return new Response('Origin not allowed', { status: 403 });
  }
  // CF-Connecting-IP is set by Cloudflare at the edge and forwarded
  // automatically inside this request — the Durable Object reads it
  // directly, replacing server.js's ipOf()/TRUST_PROXY logic (there is no
  // req.socket.remoteAddress in Workers, and CF-Connecting-IP can't be
  // spoofed by the client the way a client-supplied header could be).
  const stub = getRoomStub(env);
  return stub.fetch(request);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return handleOptions(request, env);
    }
    if (url.pathname === '/health' && request.method === 'GET') {
      return handleHealth(request, env);
    }
    if (url.pathname === '/ice-servers' && request.method === 'GET') {
      return handleIceServers(request, env);
    }
    if (request.headers.get('Upgrade') === 'websocket') {
      return handleWebSocketUpgrade(request, env);
    }

    return new Response('Not found', { status: 404 });
  },
};

export { SignalingRoom };
