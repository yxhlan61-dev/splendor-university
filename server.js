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
    seats: room.seats.map((seat) => ({ index: seat.index, name: seat.name, occupied: Boolean(seat.clientId) })),
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
  };
}

function touch(room) {
  room.updatedAt = new Date().toISOString();
}

function broadcast(room) {
  const list = subscribers.get(room.id);
  if (!list) return;
  for (const sub of [...list]) {
    sub.res.write(`event: room\ndata: ${JSON.stringify(publicRoom(room, sub.clientToken))}\n\n`);
  }
}

function cleanupRooms() {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (now - Date.parse(room.updatedAt) > ROOM_TTL_MS) {
      rooms.delete(id);
      const list = subscribers.get(id);
      if (list) {
        for (const sub of list) sub.res.end();
        subscribers.delete(id);
      }
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
      connected: true,
      lastSeen: Date.now(),
    }]]),
    game: null,
    flash: null,
  };
  rooms.set(id, room);
  return { room, clientToken: hostClientId };
}

function joinRoom(room, body) {
  const name = sanitizeName(body.playerName, '线上玩家');
  const clientId = randomId('C');
  const emptySeat = room.status === 'waiting' ? room.seats.find((seat) => !seat.clientId) : null;
  let client;
  if (emptySeat) {
    emptySeat.clientId = clientId;
    emptySeat.name = name;
    client = { clientId, playerIndex: emptySeat.index, playerName: name, spectator: false, connected: true, lastSeen: Date.now() };
  } else {
    client = { clientId, playerIndex: null, playerName: name, spectator: true, connected: true, lastSeen: Date.now() };
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
  touch(room);
  if (!room.hostClientId && room.status === 'waiting') {
    rooms.delete(room.id);
    subscribers.get(room.id)?.forEach((sub) => sub.res.end());
    subscribers.delete(room.id);
    return;
  }
  broadcast(room);
}

function startRoom(room, clientToken) {
  const client = ensureClient(room, clientToken);
  if (client.clientId !== room.hostClientId) throw new Error('只有房主可以开始游戏');
  if (room.status !== 'waiting') throw new Error('房间已经开始或结束');
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
