'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const WebSocket = require('ws');

// Render sets PORT. Locally (e.g. Termux on a hotspot) we default to 8787,
// which is the port the game page expects for Hotspot / Wi-Fi mode.
const PORT = Number(process.env.PORT || 8787);
const MAX_PLAYERS = 8;
const MSG_PER_SEC = 60;
const rooms = new Map();
const peers = new Map();

/* ---------- static page (cached, gzip, ETag) ---------- */
const PAGE_FILE = path.join(__dirname, 'index.html');
let page = null;

function getPage() {
  const st = fs.statSync(PAGE_FILE);
  if (!page || page.mtime !== st.mtimeMs) {
    const raw = fs.readFileSync(PAGE_FILE);
    page = {
      mtime: st.mtimeMs,
      raw,
      gz: zlib.gzipSync(raw, {level: 9}),
      etag: 'W/"' + raw.length + '-' + Math.floor(st.mtimeMs) + '"'
    };
  }
  return page;
}

const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin'
};

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    res.writeHead(400, SEC_HEADERS);
    return res.end('Bad request');
  }

  if (pathname === '/health') {
    res.writeHead(200, {...SEC_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
    return res.end(JSON.stringify({ok: true, rooms: rooms.size}));
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, {...SEC_HEADERS, Allow: 'GET, HEAD'});
    return res.end('Method not allowed');
  }

  if (pathname !== '/' && pathname !== '/index.html') {
    res.writeHead(404, SEC_HEADERS);
    return res.end('Not found');
  }

  let p;
  try {
    p = getPage();
  } catch {
    res.writeHead(500, SEC_HEADERS);
    return res.end('index.html could not be loaded');
  }

  const headers = {
    ...SEC_HEADERS,
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache',
    ETag: p.etag,
    Vary: 'Accept-Encoding'
  };

  if (req.headers['if-none-match'] === p.etag) {
    res.writeHead(304, headers);
    return res.end();
  }

  const gzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  if (gzip) headers['Content-Encoding'] = 'gzip';
  const body = gzip ? p.gz : p.raw;
  headers['Content-Length'] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
});

/* ---------- rooms ---------- */
function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function snapshot(room) {
  return [...room.values()].map(p => ({
    peer: p.id,
    presence: p.presence || {name: p.name, s: {}}
  }));
}

function broadcastPeers(room) {
  const peersList = snapshot(room);
  for (const p of room.values()) {
    send(p.ws, {type: 'peers', peers: peersList});
  }
}

// Take a peer out of its room. The connection itself stays registered in
// `peers` unless `dropConnection` is true (socket closed).
function leaveRoom(ws, dropConnection) {
  const p = peers.get(ws);
  if (!p) return;
  if (dropConnection) peers.delete(ws);

  if (p.room) {
    const room = rooms.get(p.room);
    p.room = null;
    if (room) {
      room.delete(p.id);
      if (room.size) broadcastPeers(room);
      else rooms.delete(room.code);
    }
  }
}

const wss = new WebSocket.Server({server, maxPayload: 256 * 1024});

wss.on('connection', ws => {
  const p = {
    id: crypto.randomBytes(8).toString('hex'),
    ws,
    room: null,
    name: 'Player',
    presence: null,
    winStart: Date.now(),
    winCount: 0
  };

  peers.set(ws, p);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  send(ws, {type: 'welcome', peer: p.id});

  ws.on('message', raw => {
    // basic flood protection
    const now = Date.now();
    if (now - p.winStart > 1000) {
      p.winStart = now;
      p.winCount = 0;
    }
    if (++p.winCount > MSG_PER_SEC) return;

    let m;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return send(ws, {type: 'error', message: 'Invalid message format.'});
    }

    if (!m || typeof m !== 'object' || Array.isArray(m)) {
      return send(ws, {type: 'error', message: 'Invalid message format.'});
    }

    if (m.type === 'join') {
      const code = String(m.room || '')
        .toUpperCase()
        .replace(/[^A-Z0-9_-]/g, '')
        .slice(0, 32);

      if (!code) {
        return send(ws, {type: 'error', code: 'nocode', message: 'Room code is required.'});
      }

      // intent: 'create' = must be a new room, 'join' = must already exist,
      // anything else (older clients) = join if it exists, otherwise create.
      const intent = m.intent === 'create' || m.intent === 'join' ? m.intent : null;

      if (p.room) leaveRoom(ws, false);

      let room = rooms.get(code);
      if (!room) {
        if (intent === 'join') {
          return send(ws, {type: 'error', code: 'missing', message: 'Room not found. Check the code with the host.'});
        }
        room = new Map();
        room.code = code;
        rooms.set(code, room);
      } else if (intent === 'create') {
        return send(ws, {type: 'error', code: 'exists', message: 'That room code is already in use.'});
      }

      if (room.size >= MAX_PLAYERS) {
        return send(ws, {type: 'error', code: 'full', message: 'Room is full (maximum 8 players).'});
      }

      p.room = code;
      p.name = String(m.name || 'Player').replace(/[<>]/g, '').slice(0, 24) || 'Player';
      p.presence = {name: p.name, s: {}};
      room.set(p.id, p);
      broadcastPeers(room);
      return;
    }

    if (!p.room) {
      return send(ws, {type: 'error', message: 'Join a room first.'});
    }

    const room = rooms.get(p.room);
    if (!room) return;

    if (m.type === 'presence') {
      const pr = (m.presence && typeof m.presence === 'object' && !Array.isArray(m.presence))
        ? m.presence
        : {s: {}};
      p.presence = {...pr, name: p.name};
      broadcastPeers(room);
      return;
    }

    if (m.type === 'event') {
      const eventName = String(m.name || '').slice(0, 40);
      if (!eventName) return;

      for (const other of room.values()) {
        send(other.ws, {
          type: 'event',
          peer: p.id,
          name: eventName,
          data: m.data
        });
      }
    }
  });

  ws.on('close', () => leaveRoom(ws, true));
  ws.on('error', () => leaveRoom(ws, true));
});

// Heartbeat: keeps idle sockets alive through proxies and drops dead ones.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      leaveRoom(ws, true);
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 25000);
wss.on('close', () => clearInterval(heartbeat));

process.on('uncaughtException', err => console.error('uncaught:', err));

function shutdown() {
  clearInterval(heartbeat);
  for (const ws of wss.clients) {
    try { ws.close(1001, 'Server restarting'); } catch {}
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Digital Swami website running on port ${PORT}`);
});
