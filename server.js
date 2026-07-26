import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buyCard,
  createGame,
  discardToken,
  reserveBlindCard,
  reserveMarketCard,
  takeDifferent,
  takeSame,
} from './src/game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5500);
const rooms = new Map();
const subscribers = new Map();
const ROOM_TTL_MS = 12 * 60 * 60 * 1000;
const WAITING_DISCONNECTED_TTL_MS = 10 * 60 * 1000;
const ABANDONED_ROOM_TTL_MS = 5 * 60 * 1000;
const GAME_OVER_TTL_MS = 30 * 60 * 1000;

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function randomId(prefix = '') {
  return `${prefix}${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`.toUpperCase();
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error('JSON 格式错误')); }
    });
    req.on('error', reject);
  });
}

function normalizeClientToken(value) {
  const token = String(value || '').trim().toUpperCase();
  return /^C[A-Z0-9]{8,48}$/.test(token) ? token : '';
}

function sanitizeName(value, fallback, max = 18) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  return (text || fallback).slice(0, max);
}

function publicRoom(room, clientToken = '') {
  const me = room.clients.get(clientToken);
  return {
    id: room.id,
    name: room.name,
    status: room.status,
    playerCount: room.playerCount,
    hostClientId: room.hostClientId,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    firstMode: room.firstMode,
    seats: room.seats.map((seat) => ({
      index: seat.index,
      name: seat.name,
      occupied: Boolean(seat.clientId),
      connected: Boolean(seat.clientId && room.clients.get(seat.clientId)?.connected),
      isHost: seat.clientId === room.hostClientId,
    })),
    viewer: me ? {
      clientId: me.clientId,
      playerIndex: me.playerIndex,
      playerName: me.playerName,
      spectator: me.spectator,
      isHost: me.clientId === room.hostClientId,
    } : null,
    game: room.game,
    flash: room.flash || null,
  };
}

function roomListItem(room) {
  const occupied = room.seats.filter((seat) => seat.clientId).length;
  return {
    id: room.id,
    name: room.name,
    status: room.status,
    playerCount: room.playerCount,
    occupied,
    seats: room.seats.map((seat) => ({
      index: seat.index,
      name: seat.name,
      occupied: Boolean(seat.clientId),
      connected: Boolean(seat.clientId && room.clients.get(seat.clientId)?.connected),
    })),
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
  };
}

function touch(room) {
  room.updatedAt = new Date().toISOString();
}

function markClientSeen(room, clientToken) {
  const client = room.clients.get(clientToken);
  if (!client) return false;
  client.lastSeen = Date.now();
  return true;
}

function broadcast(room) {
  const list = subscribers.get(room.id);
  if (!list?.size) return;
  for (const sub of [...list]) {
    if (sub.closed || sub.res.destroyed || sub.res.writableEnded) {
      list.delete(sub);
      continue;
    }
    try {
      sub.res.write(`event: room\ndata: ${JSON.stringify(publicRoom(room, sub.clientToken))}\n\n`);
    } catch {
      sub.closed = true;
      list.delete(sub);
    }
  }
  if (list.size === 0) subscribers.delete(room.id);
}

function isBrokenRoom(room) {
  const broken = (value) => /^\?+$/.test(String(value || '').trim());
  return broken(room.name) || room.seats.some((seat) => broken(seat.name));
}

function closeSubscribers(roomId) {
  const list = subscribers.get(roomId);
  if (list) {
    for (const sub of list) sub.res.end();
    subscribers.delete(roomId);
  }
}

function hasLiveSubscriber(roomId, clientToken) {
  return [...(subscribers.get(roomId) || [])].some((sub) => sub.clientToken === clientToken);
}

function markStaleConnection(room, client) {
  if (client?.connected && !hasLiveSubscriber(room.id, client.clientId)) {
    client.connected = false;
    return true;
  }
  return false;
}

function markAllStaleConnections(room) {
  let changed = false;
  for (const client of room.clients.values()) {
    changed = markStaleConnection(room, client) || changed;
  }
  return changed;
}

function latestClientLastSeen(room) {
  const seen = [...room.clients.values()].map((client) => Number(client.lastSeen || 0));
  return seen.length ? Math.max(...seen) : 0;
}

function hasConnectedSeat(room) {
  return room.seats.some((seat) => seat.clientId && room.clients.get(seat.clientId)?.connected);
}

function isAbandoned(room, now) {
  return !hasConnectedSeat(room) && now - latestClientLastSeen(room) > ABANDONED_ROOM_TTL_MS;
}

function canReplaceSeat(room, seat, now) {
  const client = seat.clientId ? room.clients.get(seat.clientId) : null;
  return !client || (!client.connected && now - (client.lastSeen || 0) > WAITING_DISCONNECTED_TTL_MS);
}

function deleteRoom(roomId) {
  rooms.delete(roomId);
  closeSubscribers(roomId);
}

function cleanupWaitingRoom(room, now) {
  let changed = false;
  for (const seat of room.seats) {
    if (!seat.clientId) continue;
    const client = room.clients.get(seat.clientId);
    const inactive = !client || (!client.connected && now - (client.lastSeen || 0) > WAITING_DISCONNECTED_TTL_MS);
    if (inactive) {
      if (client) room.clients.delete(seat.clientId);
      seat.clientId = null;
      seat.name = `\u7b49\u5f85\u73a9\u5bb6${seat.index + 1}`;
      changed = true;
    }
  }
  for (const [clientId, client] of room.clients) {
    if (client.spectator && !client.connected && now - (client.lastSeen || 0) > WAITING_DISCONNECTED_TTL_MS) {
      room.clients.delete(clientId);
      changed = true;
    }
  }
  if (!room.hostClientId || !room.clients.get(room.hostClientId)) {
    const nextHostSeat = room.seats.find((seat) => seat.clientId);
    room.hostClientId = nextHostSeat?.clientId || null;
    changed = true;
  }
  return changed;
}

function cleanupRooms() {
  const now = Date.now();
  for (const [id, room] of [...rooms]) {
    const staleChanged = markAllStaleConnections(room);
    if (
      isBrokenRoom(room) ||
      now - Date.parse(room.updatedAt) > ROOM_TTL_MS ||
      (room.status === 'game_over' && now - Date.parse(room.updatedAt) > GAME_OVER_TTL_MS) ||
      (room.status !== 'waiting' && isAbandoned(room, now))
    ) {
      deleteRoom(id);
      continue;
    }
    if (room.status === 'waiting' && cleanupWaitingRoom(room, now)) {
      if (!room.hostClientId) {
        deleteRoom(id);
      } else {
        touch(room);
      }
    } else if (staleChanged) {
      touch(room);
    }
  }
}

function ensureRoom(id) {
  const room = rooms.get(id);
  if (!room) throw new Error('房间不存在或已过期');
  return room;
}

function ensureClient(room, token) {
  const client = room.clients.get(token);
  if (!client) throw new Error('你还没有进入该房间');
  client.lastSeen = Date.now();
  return client;
}

function createRoom(body) {
  const playerCount = Number(body.playerCount || 2);
  if (![2, 3, 4].includes(playerCount)) throw new Error('线上房间人数必须为 2-4 人');
  const id = randomId('R').slice(0, 8);
  const hostClientId = randomId('C');
  const hostName = sanitizeName(body.playerName, '房主');
  const now = new Date().toISOString();
  const seats = Array.from({ length: playerCount }, (_, index) => ({
    index,
    name: index === 0 ? hostName : `等待玩家${index + 1}`,
    clientId: index === 0 ? hostClientId : null,
  }));
  const room = {
    id,
    name: sanitizeName(body.roomName, `${hostName}的房间`, 24),
    status: 'waiting',
    playerCount,
    firstMode: body.firstMode === 'random' ? 'random' : 'host',
    createdAt: now,
    updatedAt: now,
    hostClientId,
    seats,
    clients: new Map([[hostClientId, {
      clientId: hostClientId,
      playerIndex: 0,
      playerName: hostName,
      spectator: false,
      connected: false,
      lastSeen: Date.now(),
    }]]),
    game: null,
    flash: null,
  };
  rooms.set(id, room);
  return { room, clientToken: hostClientId };
}

function joinRoom(room, body) {
  const name = sanitizeName(body.playerName, '\u73a9\u5bb6');
  const requestedToken = normalizeClientToken(body.clientToken);
  if (requestedToken && room.clients.get(requestedToken)) {
    const existing = room.clients.get(requestedToken);
    existing.playerName = name || existing.playerName;
    existing.lastSeen = Date.now();
    touch(room);
    return { clientToken: requestedToken, room };
  }
  markAllStaleConnections(room);
  const now = Date.now();
  const reusableSeat = room.status === 'waiting' ? room.seats.find((seat) => seat.clientId && canReplaceSeat(room, seat, now)) : null;
  if (reusableSeat?.clientId) room.clients.delete(reusableSeat.clientId);
  const emptySeat = room.status === 'waiting' ? (reusableSeat || room.seats.find((seat) => !seat.clientId)) : null;
  const clientId = requestedToken || randomId('C');
  let client;
  if (emptySeat) {
    emptySeat.clientId = clientId;
    emptySeat.name = name;
    client = { clientId, playerIndex: emptySeat.index, playerName: name, spectator: false, connected: false, lastSeen: Date.now() };
  } else if (room.status === 'waiting') {
    throw new Error('\u623f\u95f4\u5df2\u6ee1\uff0c\u8bf7\u5237\u65b0\u623f\u95f4\u5217\u8868\u6216\u7b49\u5f85\u7a7a\u4f4d\u91ca\u653e');
  } else {
    client = { clientId, playerIndex: null, playerName: name, spectator: true, connected: false, lastSeen: Date.now() };
  }
  room.clients.set(clientId, client);
  touch(room);
  broadcast(room);
  return { clientToken: clientId, room };
}

function leaveRoom(room, clientToken) {
  const client = room.clients.get(clientToken);
  if (!client) return;
  if (room.status === 'waiting' && client.playerIndex !== null) {
    const seat = room.seats[client.playerIndex];
    if (seat?.clientId === clientToken) {
      seat.clientId = null;
      seat.name = `等待玩家${seat.index + 1}`;
    }
    room.clients.delete(clientToken);
    if (clientToken === room.hostClientId) {
      const nextHostSeat = room.seats.find((seat) => seat.clientId);
      room.hostClientId = nextHostSeat?.clientId || null;
    }
  } else if (client.spectator) {
    room.clients.delete(clientToken);
  } else {
    client.connected = false;
    client.lastSeen = Date.now();
  }
  markAllStaleConnections(room);
  touch(room);
  if ((!room.hostClientId && room.status === 'waiting') || (room.status !== 'waiting' && !hasConnectedSeat(room))) {
    deleteRoom(room.id);
    return;
  }
  broadcast(room);
}

function startRoom(room, clientToken) {
  const client = ensureClient(room, clientToken);
  if (client.clientId !== room.hostClientId) throw new Error('只有房主可以开始游戏');
  if (room.status === 'playing' && room.game) return;
  if (room.status !== 'waiting') throw new Error('房间已经结束');
  const missing = room.seats.filter((seat) => !seat.clientId);
  if (missing.length) throw new Error('请等待所有座位坐满后再开始');
  const firstPlayerIndex = room.firstMode === 'random' ? Math.floor(Math.random() * room.playerCount) : 0;
  room.game = createGame({
    playerCount: room.playerCount,
    playerNames: room.seats.map((seat) => seat.name),
    firstPlayerIndex,
  });
  room.status = 'playing';
  room.flash = null;
  touch(room);
  broadcast(room);
}

function assertPlayerTurn(room, client) {
  if (!room.game || room.status !== 'playing') throw new Error('房间尚未开始游戏');
  if (client.spectator || client.playerIndex === null) throw new Error('观战者不能执行游戏动作');
  const game = room.game;
  if (game.phase === 'player_action' && game.currentPlayerIndex !== client.playerIndex) throw new Error('还没有轮到你行动');
  if (game.phase === 'discard_tokens' && game.pendingDiscardPlayerIndex !== client.playerIndex) throw new Error('当前需要其他玩家弃还资源');
}

function handleAction(room, clientToken, body) {
  const client = ensureClient(room, clientToken);
  assertPlayerTurn(room, client);
  const { type, payload = {} } = body;
  let result = null;
  switch (type) {
    case 'takeDifferent':
      takeDifferent(room.game, payload.types || []);
      break;
    case 'takeSame':
      takeSame(room.game, payload.tokenType);
      break;
    case 'reserveMarket':
      reserveMarketCard(room.game, Number(payload.level), payload.instanceId);
      break;
    case 'reserveBlind':
      reserveBlindCard(room.game, Number(payload.level));
      break;
    case 'buyCard':
      result = buyCard(room.game, payload.instanceId, Number(payload.optionIndex || 0));
      if (result?.opportunity?.card) {
        room.flash = {
          id: randomId('F'),
          type: 'opportunity',
          card: result.opportunity.card,
          message: result.opportunity.result?.message || '',
          createdAt: new Date().toISOString(),
        };
      }
      break;
    case 'discardToken':
      discardToken(room.game, payload.tokenType);
      break;
    default:
      throw new Error('未知线上动作');
  }
  if (room.game.phase === 'game_over') room.status = 'game_over';
  touch(room);
  broadcast(room);
  return result;
}

async function handleApi(req, res, url) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
    return true;
  }
  try {
    cleanupRooms();
    const parts = url.pathname.split('/').filter(Boolean);
    if (req.method === 'GET' && url.pathname === '/api/rooms') {
      json(res, 200, { rooms: [...rooms.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).map(roomListItem) });
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/rooms') {
      const created = createRoom(await readBody(req));
      json(res, 200, { clientToken: created.clientToken, room: publicRoom(created.room, created.clientToken) });
      return true;
    }
    if (parts[0] === 'api' && parts[1] === 'rooms' && parts[2]) {
      const room = ensureRoom(parts[2].toUpperCase());
      if (req.method === 'GET' && parts.length === 3) {
        const clientToken = url.searchParams.get('clientToken') || '';
        markClientSeen(room, clientToken);
        json(res, 200, { room: publicRoom(room, clientToken) });
        return true;
      }
      if (req.method === 'GET' && parts[3] === 'events') {
        const clientToken = url.searchParams.get('clientToken') || '';
        const client = ensureClient(room, clientToken);
        client.connected = true;
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });
        res.write(`event: room\ndata: ${JSON.stringify(publicRoom(room, clientToken))}\n\n`);
        const sub = { res, clientToken };
        if (!subscribers.has(room.id)) subscribers.set(room.id, new Set());
        subscribers.get(room.id).add(sub);
        req.on('close', () => {
          sub.closed = true;
          subscribers.get(room.id)?.delete(sub);
          const c = room.clients.get(clientToken);
          if (c) c.connected = false;
          touch(room);
          broadcast(room);
        });
        return true;
      }
      if (req.method === 'POST' && parts[3] === 'join') {
        const joined = joinRoom(room, await readBody(req));
        json(res, 200, { clientToken: joined.clientToken, room: publicRoom(room, joined.clientToken) });
        return true;
      }
      if (req.method === 'POST' && parts[3] === 'leave') {
        const body = await readBody(req);
        leaveRoom(room, body.clientToken);
        json(res, 200, { ok: true });
        return true;
      }
      if (req.method === 'POST' && parts[3] === 'start') {
        const body = await readBody(req);
        startRoom(room, body.clientToken);
        json(res, 200, { room: publicRoom(room, body.clientToken) });
        return true;
      }
      if (req.method === 'POST' && parts[3] === 'actions') {
        const body = await readBody(req);
        const result = handleAction(room, body.clientToken, body);
        json(res, 200, { room: publicRoom(room, body.clientToken), result });
        return true;
      }
    }
    json(res, 404, { error: 'API 不存在' });
    return true;
  } catch (error) {
    json(res, 400, { error: error.message || String(error) });
    return true;
  }
}

function serveStatic(req, res, url) {
  const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const safePath = path.normalize(pathname).replace(/^([.][.][\\/])+/, '');
  const filePath = path.join(__dirname, safePath);
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(__dirname, 'index.html'), (indexErr, indexData) => {
        if (indexErr) {
          res.writeHead(404);
          res.end('Not found');
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(indexData);
        }
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': mimeTypes[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    await handleApi(req, res, url);
    return;
  }
  serveStatic(req, res, url);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`璀璨宝石之大学模拟器已启动： http://127.0.0.1:${PORT}/`);
  console.log('同一局域网玩家可访问本机 IP 加端口加入线上房间。');
});
