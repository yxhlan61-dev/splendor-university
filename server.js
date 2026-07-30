import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  advanceToNextActivePlayer,
  activePlayerCount,
  buyCard,
  createGame,
  discardToken,
  reserveBlindCard,
  markPlayerInactive,
  reserveMarketCard,
  takeDifferent,
  takeSame,
} from './src/game.js';
import { AI_LEVELS, hydrateAIPlayers, runAIActions } from './src/ai.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5500);
const rooms = new Map();
const subscribers = new Map();
const aiTimers = new Map();
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


function normalizeAILevel(level) {
  return AI_LEVELS[level] ? level : 'haiku';
}

function makeAIClientId(index) {
  return `AI${index + 1}`;
}

function isAIClientId(clientId = '') {
  return String(clientId).startsWith('AI');
}

function isAISeat(seat) {
  return Boolean(seat?.aiLevel || isAIClientId(seat?.clientId));
}

function aiDisplayName(level) {
  return AI_LEVELS[normalizeAILevel(level)].name;
}

function runRoomAI(room, { maxActions = 20 } = {}) {
  if (!room?.game || room.status !== 'playing') return [];
  const flashes = [];
  const results = runAIActions(room.game, {
    maxActions,
    onAction: ({ result }) => {
      if (result?.opportunity?.card) {
        flashes.push({
          id: randomId('F'),
          type: 'opportunity',
          card: result.opportunity.card,
          message: result.opportunity.result?.message || '',
          createdAt: new Date().toISOString(),
        });
      }
    },
  });
  if (flashes.length) room.flash = flashes[flashes.length - 1];
  if (room.game.phase === 'game_over') room.status = 'game_over';
  return results;
}

function isRoomAITurn(room) {
  const game = room?.game;
  if (!game || room.status !== 'playing' || game.phase === 'game_over') return false;
  const index = game.phase === 'discard_tokens' ? game.pendingDiscardPlayerIndex : game.currentPlayerIndex;
  return Number.isInteger(index) && game.players?.[index]?.active !== false && game.players?.[index]?.isAI;
}

function scheduleRoomAI(room, delay = 5000) {
  if (!room?.id || !isRoomAITurn(room) || aiTimers.has(room.id)) return;
  const timer = setTimeout(() => {
    aiTimers.delete(room.id);
    const liveRoom = rooms.get(room.id);
    if (!liveRoom || !isRoomAITurn(liveRoom)) return;
    runRoomAI(liveRoom, { maxActions: 1 });
    if (liveRoom.game?.phase === 'game_over') liveRoom.status = 'game_over';
    touch(liveRoom);
    broadcast(liveRoom);
    if (liveRoom.status === 'playing' && isRoomAITurn(liveRoom)) scheduleRoomAI(liveRoom, 5000);
  }, delay);
  aiTimers.set(room.id, timer);
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
    seats: room.seats.map((seat) => {
      const client = seat.clientId ? room.clients.get(seat.clientId) : null;
      return {
        index: seat.index,
        name: seat.name,
        occupied: Boolean(seat.clientId),
        aiLevel: seat.aiLevel || null,
        isAI: isAISeat(seat),
        connected: isAISeat(seat) ? true : Boolean(client?.connected),
        ready: Boolean(isAISeat(seat) || client?.ready || seat.clientId === room.hostClientId),
        active: room.game?.players?.[seat.index]?.active !== false,
        isHost: seat.clientId === room.hostClientId,
      };
    }),
    viewer: me ? {
      clientId: me.clientId,
      playerIndex: me.playerIndex,
      playerName: me.playerName,
      spectator: me.spectator,
      ready: Boolean(me.ready || me.clientId === room.hostClientId),
      isHost: me.clientId === room.hostClientId,
    } : null,
    game: room.game,
    chat: room.chat || [],
    notices: room.notices || [],
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
      aiLevel: seat.aiLevel || null,
      isAI: isAISeat(seat),
      connected: isAISeat(seat) ? true : Boolean(seat.clientId && room.clients.get(seat.clientId)?.connected),
    })),
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
  };
}

function touch(room) {
  room.updatedAt = new Date().toISOString();
}

function addNotice(room, type, message) {
  room.notices = room.notices || [];
  room.notices.unshift({ id: randomId('N'), type, message, createdAt: new Date().toISOString() });
  room.notices = room.notices.slice(0, 20);
}

function addChatMessage(room, client, message) {
  const text = String(message || '').trim().slice(0, 300);
  if (!text) throw new Error('\u804a\u5929\u5185\u5bb9\u4e0d\u80fd\u4e3a\u7a7a');
  room.chat = room.chat || [];
  room.chat.push({
    id: randomId('M'),
    sender: client?.playerName || '\u73a9\u5bb6',
    playerIndex: client?.playerIndex ?? null,
    message: text,
    createdAt: new Date().toISOString(),
  });
  room.chat = room.chat.slice(-80);
}

function readyState(room) {
  const occupied = room.seats.filter((seat) => seat.clientId);
  const missing = room.seats.filter((seat) => !seat.clientId);
  const unready = occupied.filter((seat) => !isAISeat(seat) && seat.clientId !== room.hostClientId && !room.clients.get(seat.clientId)?.ready);
  return { occupied, missing, unready, canStart: room.status === 'waiting' && missing.length === 0 && unready.length === 0 };
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
  const broken = (value) => {
    const text = String(value || '').trim();
    return text.length >= 2 && /^\?+$/.test(text);
  };
  return broken(room.name) && room.seats.some((seat) => seat.clientId && broken(seat.name));
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
  if (client?.isAI) return false;
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
  const seen = [...room.clients.values()].filter((client) => !client.isAI).map((client) => Number(client.lastSeen || 0));
  return seen.length ? Math.max(...seen) : 0;
}

function hasConnectedSeat(room) {
  return room.seats.some((seat) => {
    if (!seat.clientId) return false;
    const client = room.clients.get(seat.clientId);
    const player = room.game?.players?.[seat.index];
    return Boolean(client && !client.isAI && client.connected && client.left !== true && player?.active !== false);
  });
}

function isAbandoned(room, now) {
  return !hasConnectedSeat(room) && now - latestClientLastSeen(room) > ABANDONED_ROOM_TTL_MS;
}

function canReplaceSeat(room, seat, now) {
  if (isAISeat(seat)) return false;
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
    if (!seat.clientId || isAISeat(seat)) continue;
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
    const nextHostSeat = room.seats.find((seat) => seat.clientId && !room.clients.get(seat.clientId)?.isAI);
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
      (room.status === 'closed' && now - Date.parse(room.updatedAt) > 60 * 1000) ||
      (room.status === 'game_over' && now - Date.parse(room.updatedAt) > GAME_OVER_TTL_MS) ||
      (room.status !== 'waiting' && isAbandoned(room, now))
    ) {
      deleteRoom(id);
      continue;
    }
    if (room.status === 'waiting' && room.seats.some((seat) => seat.clientId) && cleanupWaitingRoom(room, now)) {
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
    aiLevel: null,
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
      ready: true,
      connected: false,
      lastSeen: Date.now(),
    }]]),
    game: null,
    chat: [],
    notices: [],
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
    if (room.status === 'waiting') {
      existing.playerName = name || existing.playerName;
      const seat = existing.playerIndex !== null ? room.seats[existing.playerIndex] : null;
      if (seat?.clientId === requestedToken) seat.name = existing.playerName;
    }
    existing.lastSeen = Date.now();
    if (existing.clientId === room.hostClientId) existing.ready = true;
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
    client = { clientId, playerIndex: emptySeat.index, playerName: name, spectator: false, ready: false, connected: false, lastSeen: Date.now() };
  } else if (room.status === 'waiting') {
    throw new Error('\u623f\u95f4\u5df2\u6ee1\uff0c\u8bf7\u5237\u65b0\u623f\u95f4\u5217\u8868\u6216\u7b49\u5f85\u7a7a\u4f4d\u91ca\u653e');
  } else {
    throw new Error('\u6e38\u620f\u5df2\u5f00\u59cb\uff0c\u65e0\u6cd5\u52a0\u5165\u623f\u95f4');
  }
  room.clients.set(clientId, client);
  touch(room);
  broadcast(room);
  return { clientToken: clientId, room };
}

function closeRoomForTooFewPlayers(room) {
  const message = '\u623f\u95f4\u5185\u53ea\u5269 1 \u540d\u73a9\u5bb6\uff0c\u591a\u4eba\u6e38\u620f\u5df2\u81ea\u52a8\u7ed3\u675f\uff0c\u6240\u6709\u73a9\u5bb6\u5c06\u9000\u51fa\u623f\u95f4\u3002';
  room.status = 'closed';
  room.game = null;
  addNotice(room, 'room_closed', message);
  room.flash = { id: randomId('F'), type: 'room_closed', message, createdAt: new Date().toISOString() };
  touch(room);
}

function handlePlayerLeftDuringGame(room, client, reason = 'leave') {
  if (!room.game || client.playerIndex === null || client.spectator) return;
  const player = room.game.players?.[client.playerIndex];
  const playerName = player?.name || client.playerName || `\u73a9\u5bb6${client.playerIndex + 1}`;
  const changed = markPlayerInactive(room.game, client.playerIndex);
  client.connected = false;
  client.left = true;
  client.lastSeen = Date.now();
  const seat = room.seats[client.playerIndex];
  if (seat) seat.left = true;
  if (changed) {
    const message = `${playerName} \u5df2\u9000\u51fa\u623f\u95f4\uff0c\u7cfb\u7edf\u5c06\u81ea\u52a8\u8df3\u8fc7\u8be5\u73a9\u5bb6\u7684\u56de\u5408\u3002`;
    addNotice(room, 'player_left', message);
    room.flash = { id: randomId('F'), type: 'player_left', playerIndex: client.playerIndex, message, createdAt: new Date().toISOString() };
    room.game.log?.unshift?.(message);
    if (room.game.log) room.game.log = room.game.log.slice(0, 80);
  }
  if (activePlayerCount(room.game) <= 1) {
    closeRoomForTooFewPlayers(room);
    return;
  }
  if (room.game.phase === 'discard_tokens' && room.game.pendingDiscardPlayerIndex === client.playerIndex) {
    room.game.pendingDiscardPlayerIndex = null;
    room.game.phase = 'player_action';
  }
  if (room.game.currentPlayerIndex === client.playerIndex || room.game.players?.[room.game.currentPlayerIndex]?.active === false) {
    advanceToNextActivePlayer(room.game, client.playerIndex);
  }
  scheduleRoomAI(room);
  if (room.game.phase === 'game_over') room.status = 'game_over';
}

function leaveRoom(room, clientToken) {
  const client = room.clients.get(clientToken);
  if (!client) return;
  if (room.status === 'waiting' && client.playerIndex !== null) {
    const seat = room.seats[client.playerIndex];
    if (seat?.clientId === clientToken) {
      seat.clientId = null;
      seat.aiLevel = null;
      seat.name = `等待玩家${seat.index + 1}`;
    }
    room.clients.delete(clientToken);
    if (clientToken === room.hostClientId) {
      const nextHostSeat = room.seats.find((seat) => seat.clientId && !room.clients.get(seat.clientId)?.isAI);
      room.hostClientId = nextHostSeat?.clientId || null;
      if (room.hostClientId && room.clients.get(room.hostClientId)) room.clients.get(room.hostClientId).ready = true;
    }
  } else if (client.spectator) {
    room.clients.delete(clientToken);
  } else if (room.status === 'playing') {
    handlePlayerLeftDuringGame(room, client, 'leave');
  } else {
    client.connected = false;
    client.lastSeen = Date.now();
  }
  markAllStaleConnections(room);
  touch(room);
  if ((!room.hostClientId && room.status === 'waiting') || (room.status !== 'waiting' && room.status !== 'closed' && !hasConnectedSeat(room))) {
    deleteRoom(room.id);
    return;
  }
  broadcast(room);
}

function setReady(room, clientToken, ready) {
  const client = ensureClient(room, clientToken);
  if (room.status !== 'waiting') throw new Error('只有等待中的房间可以准备');
  if (client.spectator || client.playerIndex === null) throw new Error('观战者不能准备');
  if (client.clientId === room.hostClientId) client.ready = true;
  else client.ready = Boolean(ready);
  touch(room);
  broadcast(room);
}


function addAIPlayer(room, hostToken, playerIndex, aiLevel) {
  const host = ensureClient(room, hostToken);
  if (host.clientId !== room.hostClientId) throw new Error('\u53ea\u6709\u623f\u4e3b\u53ef\u4ee5\u52a0\u5165\u7535\u8111\u73a9\u5bb6');
  if (room.status !== 'waiting') throw new Error('\u53ea\u6709\u7b49\u5f85\u754c\u9762\u53ef\u4ee5\u52a0\u5165\u7535\u8111\u73a9\u5bb6');
  const index = Number(playerIndex);
  const seat = room.seats[index];
  if (!seat) throw new Error('座位不存在');
  if (index === 0 || seat.clientId === room.hostClientId) throw new Error('\u623f\u4e3b\u5ea7\u4f4d\u4e0d\u80fd\u52a0\u5165\u7535\u8111');
  if (seat.clientId) throw new Error('该座位已经有玩家');
  const level = normalizeAILevel(aiLevel);
  const clientId = makeAIClientId(index);
  seat.clientId = clientId;
  seat.aiLevel = level;
  seat.name = aiDisplayName(level);
  room.clients.set(clientId, {
    clientId,
    playerIndex: index,
    playerName: seat.name,
    spectator: false,
    ready: true,
    connected: true,
    lastSeen: Date.now(),
    isAI: true,
    aiLevel: level,
  });
  addNotice(room, 'ai_added', `${seat.name} 已加入座位 ${index + 1}。`);
  touch(room);
  broadcast(room);
}

function kickPlayer(room, hostToken, playerIndex) {
  const host = ensureClient(room, hostToken);
  if (host.clientId !== room.hostClientId) throw new Error('只有房主可以踢出玩家');
  if (room.status !== 'waiting') throw new Error('只有等待界面可以踢出玩家');
  const index = Number(playerIndex);
  const seat = room.seats[index];
  if (!seat?.clientId) throw new Error('该座位没有玩家');
  if (seat.clientId === room.hostClientId) throw new Error('房主不能踢出自己');
  const kickedName = seat.name;
  room.clients.delete(seat.clientId);
  seat.clientId = null;
  seat.aiLevel = null;
  seat.name = `等待玩家${seat.index + 1}`;
  addNotice(room, 'player_kicked', `${kickedName} 已被房主移出房间。`);
  touch(room);
  broadcast(room);
}

function sendChat(room, clientToken, message) {
  const client = ensureClient(room, clientToken);
  if (room.status === 'closed') throw new Error('房间已经结束');
  addChatMessage(room, client, message);
  touch(room);
  broadcast(room);
}

function startRoom(room, clientToken) {
  const client = ensureClient(room, clientToken);
  if (client.clientId !== room.hostClientId) throw new Error('只有房主可以开始游戏');
  if (room.status === 'playing' && room.game) return;
  if (room.status !== 'waiting') throw new Error('房间已经结束');
  const { missing, unready } = readyState(room);
  if (missing.length) throw new Error('\u8bf7\u7b49\u5f85\u6240\u6709\u5ea7\u4f4d\u5750\u6ee1\u540e\u518d\u5f00\u59cb\uff0c\u623f\u4e3b\u4e5f\u53ef\u4ee5\u5728\u7a7a\u5ea7\u4f4d\u52a0\u5165\u7535\u8111\u73a9\u5bb6');
  if (unready.length) throw new Error('\u9664\u623f\u4e3b\u548c \u7535\u8111\u5916\u7684\u6240\u6709\u73a9\u5bb6\u90fd\u51c6\u5907\u540e\u624d\u80fd\u5f00\u59cb');
  const firstPlayerIndex = room.firstMode === 'random' ? Math.floor(Math.random() * room.playerCount) : 0;
  room.game = hydrateAIPlayers(createGame({
    playerCount: room.playerCount,
    playerNames: room.seats.map((seat) => seat.name),
    firstPlayerIndex,
  }), room.seats.filter(isAISeat).map((seat) => ({ index: seat.index, aiLevel: seat.aiLevel })));
  room.status = 'playing';
  room.flash = null;
  addNotice(room, 'game_started', '游戏已开始，祝大家玩得开心。');
  scheduleRoomAI(room);
  touch(room);
  broadcast(room);
}

function assertPlayerTurn(room, client) {
  if (!room.game || room.status !== 'playing') throw new Error('房间尚未开始游戏');
  if (client.isAI) throw new Error('\u7535\u8111\u73a9\u5bb6\u4f1a\u81ea\u52a8\u884c\u52a8');
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
  scheduleRoomAI(room);
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
          if (c) {
            if (room.status === 'playing' && !c.spectator) handlePlayerLeftDuringGame(room, c, 'disconnect');
            else c.connected = false;
          }
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
      if (req.method === 'POST' && parts[3] === 'ready') {
        const body = await readBody(req);
        setReady(room, body.clientToken, body.ready);
        json(res, 200, { room: publicRoom(room, body.clientToken) });
        return true;
      }

      if (req.method === 'POST' && parts[3] === 'ai') {
        const body = await readBody(req);
        addAIPlayer(room, body.clientToken, body.playerIndex, body.aiLevel || body.level);
        json(res, 200, { room: publicRoom(room, body.clientToken) });
        return true;
      }
      if (req.method === 'POST' && parts[3] === 'kick') {
        const body = await readBody(req);
        kickPlayer(room, body.clientToken, body.playerIndex);
        json(res, 200, { room: publicRoom(room, body.clientToken) });
        return true;
      }
      if (req.method === 'POST' && parts[3] === 'chat') {
        const body = await readBody(req);
        sendChat(room, body.clientToken, body.message);
        json(res, 200, { room: publicRoom(room, body.clientToken) });
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
