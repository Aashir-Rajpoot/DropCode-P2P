'use strict';

/**
 * SignalingRoom — Durable Object
 * ---------------------------------------------------------------------------
 * Ported 1:1 from signaling-server/server.js (Node + `ws`). This single
 * Durable Object instance acts as the same kind of central coordinator the
 * old single Node process was: it holds every active room, relays
 * offer/answer/ICE between the two peers of a room, enforces one-receiver-
 * per-room, expires rooms on a TTL, and rate-limits join attempts per IP —
 * exactly like server.js did with its in-memory `rooms` / `ipAttempts` Maps.
 *
 * Every WebSocket connection (whether it ends up being a "sender" or a
 * "receiver") lands on this same Durable Object instance, so room state
 * never needs to be shared across processes — it's naturally coordinated
 * here, the same way it was naturally coordinated by living in one Node
 * process's memory.
 *
 * Differences from server.js, and why:
 *  - Uses the WebSocket Hibernation API (ctx.acceptWebSocket /
 *    webSocketMessage / webSocketClose) instead of `ws`'s event emitters,
 *    per the Workers runtime — this lets idle connections (e.g. a sender
 *    waiting for a receiver to scan/type a code) be evicted from memory
 *    without being disconnected, and is the current best practice for
 *    Durable Object WebSockets.
 *  - Room state and IP rate-limit state are persisted to Durable Object
 *    storage (ctx.storage) and rehydrated on wake, because in-memory class
 *    fields do not survive hibernation the way they survived living in a
 *    single long-running Node process.
 *  - Per-socket role/room association is kept as a WebSocket "attachment"
 *    (ws.serializeAttachment / ws.deserializeAttachment) rather than as a
 *    property set directly on the `ws` object, again because attachments
 *    are what survives hibernation.
 *  - Room TTL expiry uses a Durable Object Alarm instead of setTimeout,
 *    since setTimeout does not survive hibernation/eviction.
 *  - Client IP comes from the `CF-Connecting-IP` header (set by Cloudflare
 *    at the edge, not attacker-controlled) instead of `req.socket.remoteAddress`
 *    or a manually trusted X-Forwarded-For — there is no direct socket
 *    access in Workers, and CF-Connecting-IP is the correct/authoritative
 *    replacement here.
 *
 * Everything else — message types, payload shapes, statuses, TTL/rate-limit
 * defaults, and the file-metadata/relay validation rules — is unchanged.
 */

const CODE_LENGTH = 5;
const MAX_CODE = 10 ** CODE_LENGTH; // 100,000 possible codes
const MAX_PAYLOAD_BYTES = 32 * 1024; // signaling only — file bytes never hit this server
const MAX_FILE_SIZE_BYTES = Math.round(1.05 * 1024 * 1024 * 1024); // ~1 GB + slack

// CSPRNG-backed uniform random code in [0, MAX_CODE), via rejection sampling
// over crypto.getRandomValues (Web Crypto — available globally in Workers).
// This is the direct equivalent of Node's crypto.randomInt(0, MAX_CODE).
function secureCode() {
  const maxUint32 = 0x100000000;
  const limit = maxUint32 - (maxUint32 % MAX_CODE);
  const buf = new Uint32Array(1);
  let x;
  do {
    crypto.getRandomValues(buf);
    x = buf[0];
  } while (x >= limit);
  return (x % MAX_CODE).toString().padStart(CODE_LENGTH, '0');
}

function validFileMeta(meta) {
  return (
    meta && typeof meta === 'object' &&
    typeof meta.name === 'string' && meta.name.length > 0 && meta.name.length <= 500 &&
    typeof meta.size === 'number' && meta.size > 0 && meta.size <= MAX_FILE_SIZE_BYTES &&
    (meta.mime === undefined || (typeof meta.mime === 'string' && meta.mime.length <= 200))
  );
}

// Only these fields are ever relayed between peers for offer/answer/ICE —
// arbitrary client-supplied fields are dropped, and nothing is trusted as
// authoritative room state from the client.
function relayPayload(type, msg) {
  const payload = { type };
  if ((type === 'offer' || type === 'answer') && msg.sdp) payload.sdp = msg.sdp;
  if (type === 'ice-candidate' && msg.candidate) payload.candidate = msg.candidate;
  return payload;
}

export class SignalingRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;

    // code -> room record (rehydrated from storage on every wake)
    this.rooms = new Map();
    // ip -> { count, windowStart, lockedUntil } (rehydrated from storage)
    this.ipAttempts = new Map();

    this.ROOM_TTL_MS = (Number(env.ROOM_TTL_MINUTES) || 30) * 60 * 1000;
    this.MAX_JOIN_ATTEMPTS = Number(env.MAX_JOIN_ATTEMPTS) || 8;
    this.LOCKOUT_WINDOW_MS = (Number(env.LOCKOUT_WINDOW_MINUTES) || 5) * 60 * 1000;
    this.LOCKOUT_DURATION_MS = (Number(env.LOCKOUT_DURATION_MINUTES) || 10) * 60 * 1000;

    // Blocks incoming fetch()/webSocketMessage()/alarm() calls until state
    // is rehydrated from storage, so nothing runs against a half-loaded map.
    this.ctx.blockConcurrencyWhile(async () => {
      await this.hydrate();
    });
  }

  async hydrate() {
    const roomEntries = await this.ctx.storage.list({ prefix: 'room:' });
    for (const [key, value] of roomEntries) {
      this.rooms.set(key.slice('room:'.length), value);
    }
    const ipEntries = await this.ctx.storage.list({ prefix: 'ip:' });
    for (const [key, value] of ipEntries) {
      this.ipAttempts.set(key.slice('ip:'.length), value);
    }
  }

  // ---------------------------------------------------------------------
  // HTTP entrypoint for this Durable Object: either the internal /health
  // room-count check forwarded from the Worker, or a WebSocket upgrade.
  // ---------------------------------------------------------------------
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ activeRooms: this.rooms.size }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Hibernatable accept — the runtime may evict this DO from memory while
    // the socket sits idle (e.g. a sender waiting for a receiver) and wake
    // it again on the next message/close/alarm without dropping the socket.
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ ip, role: null, roomCode: null });

    return new Response(null, { status: 101, webSocket: client });
  }

  // ---------------------------------------------------------------------
  // Hibernation API callbacks
  // ---------------------------------------------------------------------
  async webSocketMessage(ws, message) {
    let raw;
    if (typeof message === 'string') {
      raw = message;
    } else {
      raw = new TextDecoder().decode(message);
    }

    if (raw.length > MAX_PAYLOAD_BYTES) {
      return this.safeSend(ws, { type: 'error', message: 'Message too large' });
    }

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return this.safeSend(ws, { type: 'error', message: 'Invalid message format' });
    }
    if (!msg || typeof msg.type !== 'string') {
      return this.safeSend(ws, { type: 'error', message: 'Invalid message' });
    }

    try {
      await this.handleMessage(ws, msg);
    } catch {
      this.safeSend(ws, { type: 'error', message: 'Server error handling message' });
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    await this.handleDisconnect(ws);
  }

  async webSocketError(ws, error) {
    await this.handleDisconnect(ws);
  }

  // Fires when a room's expiresAt has passed, and reschedules itself for
  // the next-soonest expiry. Equivalent to server.js's per-room setTimeout.
  async alarm() {
    const now = Date.now();
    for (const [code, room] of [...this.rooms.entries()]) {
      if (room.status === 'completed') continue;
      if (room.expiresAt <= now) {
        this.safeSend(this.getSocketFor(code, 'sender'), { type: 'expired' });
        this.safeSend(this.getSocketFor(code, 'receiver'), { type: 'expired' });
        await this.deleteRoom(code);
      }
    }
    await this.ensureAlarm();
  }

  // ---------------------------------------------------------------------
  // Message routing — same message types/shapes as server.js
  // ---------------------------------------------------------------------
  async handleMessage(ws, msg) {
    switch (msg.type) {
      case 'create-room': {
        if (!validFileMeta(msg.fileMeta)) {
          return this.safeSend(ws, { type: 'error', message: 'Invalid file metadata' });
        }

        const att = this.getAttachment(ws);
        if (att.roomCode) await this.deleteRoom(att.roomCode); // fresh transfer on the same socket

        const code = await this.generateUniqueCode();
        const now = Date.now();
        const room = {
          sessionId: crypto.randomUUID(),
          code,
          fileMeta: {
            name: msg.fileMeta.name,
            size: msg.fileMeta.size,
            mime: msg.fileMeta.mime || 'application/octet-stream',
          },
          status: 'waiting', // waiting -> claimed -> connected -> completed
          createdAt: now,
          expiresAt: now + this.ROOM_TTL_MS,
        };

        this.rooms.set(code, room);
        await this.ctx.storage.put(`room:${code}`, room);

        att.role = 'sender';
        att.roomCode = code;
        this.setAttachment(ws, att);

        this.safeSend(ws, { type: 'room-created', code, expiresAt: room.expiresAt });
        await this.ensureAlarm();
        break;
      }

      case 'join-room': {
        const att = this.getAttachment(ws);
        const ip = att.ip || 'unknown';

        if (await this.isLocked(ip)) {
          return this.safeSend(ws, { type: 'error', message: 'Too many attempts from this connection. Try again later.' });
        }

        const code = String(msg.code || '').trim();
        if (!/^\d{5}$/.test(code)) {
          await this.recordFailedAttempt(ip);
          return this.safeSend(ws, { type: 'error', message: 'Invalid code format' });
        }

        const room = this.rooms.get(code);
        if (!room || room.status !== 'waiting') {
          await this.recordFailedAttempt(ip);
          return this.safeSend(ws, { type: 'error', message: 'That code is invalid, expired, or already claimed.' });
        }
        await this.clearAttempts(ip);

        room.status = 'claimed'; // one receiver per transfer — further joins rejected above
        await this.ctx.storage.put(`room:${code}`, room);

        att.role = 'receiver';
        att.roomCode = code;
        this.setAttachment(ws, att);

        this.safeSend(ws, { type: 'room-joined', fileMeta: room.fileMeta, expiresAt: room.expiresAt });
        this.safeSend(this.getSocketFor(code, 'sender'), { type: 'receiver-joined' });
        break;
      }

      case 'offer':
      case 'answer':
      case 'ice-candidate': {
        const att = this.getAttachment(ws);
        const room = this.rooms.get(att.roomCode);
        if (!room || room.status === 'completed') return;
        if (att.role !== 'sender' && att.role !== 'receiver') return;

        const targetRole = att.role === 'sender' ? 'receiver' : 'sender';
        const target = this.getSocketFor(att.roomCode, targetRole);
        if (!target) return;
        this.safeSend(target, relayPayload(msg.type, msg));
        break;
      }

      case 'transfer-complete': {
        const att = this.getAttachment(ws);
        const room = this.rooms.get(att.roomCode);
        if (room) {
          room.status = 'completed';
          await this.deleteRoom(room.code); // no file data was ever here — just drop the room
        }
        break;
      }

      case 'cancel': {
        const att = this.getAttachment(ws);
        const room = this.rooms.get(att.roomCode);
        if (!room) return;
        const targetRole = att.role === 'sender' ? 'receiver' : 'sender';
        this.safeSend(this.getSocketFor(att.roomCode, targetRole), { type: 'cancelled' });
        await this.deleteRoom(room.code);
        break;
      }

      default:
        this.safeSend(ws, { type: 'error', message: 'Unknown message type' });
    }
  }

  async handleDisconnect(ws) {
    const att = this.getAttachment(ws);
    if (!att.roomCode) return;
    const room = this.rooms.get(att.roomCode);
    if (!room || room.status === 'completed') return;

    const targetRole = att.role === 'sender' ? 'receiver' : 'sender';
    this.safeSend(this.getSocketFor(att.roomCode, targetRole), {
      type: att.role === 'sender' ? 'sender-disconnected' : 'receiver-disconnected',
    });
    await this.deleteRoom(room.code);
  }

  // ---------------------------------------------------------------------
  // Room helpers
  // ---------------------------------------------------------------------
  async deleteRoom(code) {
    this.rooms.delete(code);
    await this.ctx.storage.delete(`room:${code}`);
  }

  async generateUniqueCode() {
    for (let i = 0; i < 25; i++) {
      const code = secureCode();
      if (!this.rooms.has(code)) return code;
    }
    throw new Error('Could not allocate a free code — try again');
  }

  // Reschedules the Durable Object Alarm to the next-soonest room
  // expiresAt, or clears it when no rooms remain. This is the hibernation-
  // safe replacement for server.js's per-room setTimeout.
  async ensureAlarm() {
    let minExpiry = null;
    for (const room of this.rooms.values()) {
      if (room.status === 'completed') continue;
      if (minExpiry === null || room.expiresAt < minExpiry) minExpiry = room.expiresAt;
    }
    const currentAlarm = await this.ctx.storage.getAlarm();
    if (minExpiry !== null) {
      if (currentAlarm === null || currentAlarm > minExpiry) {
        await this.ctx.storage.setAlarm(minExpiry);
      }
    } else if (currentAlarm !== null) {
      await this.ctx.storage.deleteAlarm();
    }
  }

  // ---------------------------------------------------------------------
  // Per-IP join-attempt rate limiting (mirrors server.js exactly)
  // ---------------------------------------------------------------------
  async isLocked(ip) {
    const rec = this.ipAttempts.get(ip);
    if (!rec) return false;
    const now = Date.now();
    if (rec.lockedUntil && now < rec.lockedUntil) return true;
    if (rec.lockedUntil && now >= rec.lockedUntil) {
      this.ipAttempts.delete(ip);
      await this.ctx.storage.delete(`ip:${ip}`);
    }
    return false;
  }

  async recordFailedAttempt(ip) {
    const now = Date.now();
    let rec = this.ipAttempts.get(ip);
    if (!rec || now - rec.windowStart > this.LOCKOUT_WINDOW_MS) {
      rec = { count: 0, windowStart: now, lockedUntil: 0 };
    }
    rec.count += 1;
    if (rec.count >= this.MAX_JOIN_ATTEMPTS) rec.lockedUntil = now + this.LOCKOUT_DURATION_MS;
    this.ipAttempts.set(ip, rec);
    await this.ctx.storage.put(`ip:${ip}`, rec);
  }

  async clearAttempts(ip) {
    this.ipAttempts.delete(ip);
    await this.ctx.storage.delete(`ip:${ip}`);
  }

  // ---------------------------------------------------------------------
  // Socket <-> role/room association (via WebSocket attachments, which
  // survive hibernation — a plain property on `ws` would not).
  // ---------------------------------------------------------------------
  getAttachment(ws) {
    try {
      return ws.deserializeAttachment() || {};
    } catch {
      return {};
    }
  }

  setAttachment(ws, att) {
    ws.serializeAttachment(att);
  }

  getSocketFor(code, role) {
    for (const sock of this.ctx.getWebSockets()) {
      const att = this.getAttachment(sock);
      if (att.roomCode === code && att.role === role) return sock;
    }
    return null;
  }

  safeSend(ws, obj) {
    if (ws && ws.readyState === 1 /* OPEN */) {
      try {
        ws.send(JSON.stringify(obj));
      } catch {
        /* socket died mid-send, ignore */
      }
    }
  }
}
