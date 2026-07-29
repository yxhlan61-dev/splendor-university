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
} from '../src/game.js';

const ROOM_TTL_MS = 12 * 60 * 60 * 1000;
const WAITING_DISCONNECTED_TTL_MS = 10 * 60 * 1000;
const ABANDONED_ROOM_TTL_MS = 5 * 60 * 1000;
const GAME_OVER_TTL_MS = 30 * 60 * 1000;
const encoder = new TextEncoder();

function randomId(prefix = '') {
  return `${prefix}${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`.toUpperCase();
}

function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

async function readBody(request) {
  if (!request.body) return {};
  const raw = await request.text();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('JSON 格式错误');
  }
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
  const me = room.clients?.[clientToken];
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
      const client = seat.clientId ? room.clients?.[seat.clientId] : null;
      return {
        index: seat.index,
        name: seat.name,
        occupied: Boolean(seat.clientId),
        connected: Boolean(client?.connected),
        ready: Boolean(client?.ready || seat.clientId === room.hostClientId),
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
      connected: Boolean(seat.clientId && room.clients?.[seat.clientId]?.connected),
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
  const unready = occupied.filter((seat) => seat.clientId !== room.hostClientId && !room.clients?.[seat.clientId]?.ready);
  return { occupied, missing, unready, canStart: room.status === 'waiting' && missing.length === 0 && unready.length === 0 };
}

export class GameLobby {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.rooms = new Map();
    this.subscribers = new Map();
    this.ready = this.load();
  }

  async load() {
    const stored = await this.state.storage.get('rooms');
    const rooms = stored && typeof stored === 'object' ? stored : {};
    this.rooms = new Map(Object.entries(rooms));
    await this.cleanupRooms();
  }

  async save() {
    await this.state.storage.put('rooms', Object.fromEntries(this.rooms));
  }

  isBrokenRoom(room) {
    const broken = (value) => {
      const text = String(value || '').trim();
      return text.length >= 2 && /^\?+$/.test(text);
    };
    return broken(room.name) && room.seats.some((seat) => seat.clientId && broken(seat.name));
  }

  hasLiveSubscriber(roomId, clientToken) {
    return [...(this.subscribers.get(roomId) || [])].some((sub) => sub.clientToken === clientToken);
  }

  markStaleConnection(room, client) {
    if (client?.connected && !this.hasLiveSubscriber(room.id, client.clientId)) {
      client.connected = false;
      return true;
    }
    return false;
  }

  markAllStaleConnections(room) {
    let changed = false;
    for (const client of Object.values(room.clients || {})) {
      changed = this.markStaleConnection(room, client) || changed;
    }
    return changed;
  }

  latestClientLastSeen(room) {
    const seen = Object.values(room.clients || {}).map((client) => Number(client.lastSeen || 0));
    return seen.length ? Math.max(...seen) : 0;
  }

  hasConnectedSeat(room) {
    return room.seats.some((seat) => {
      if (!seat.clientId) return false;
      const client = room.clients?.[seat.clientId];
      const player = room.game?.players?.[seat.index];
      return Boolean(client && client.left !== true && player?.active !== false);
    });
  }

  isAbandoned(room, now) {
    return !this.hasConnectedSeat(room) && now - this.latestClientLastSeen(room) > ABANDONED_ROOM_TTL_MS;
  }

  canReplaceSeat(room, seat, now) {
    const client = seat.clientId ? room.clients?.[seat.clientId] : null;
    return !client || (!client.connected && now - (client.lastSeen || 0) > WAITING_DISCONNECTED_TTL_MS);
  }

  deleteRoom(roomId) {
    this.rooms.delete(roomId);
    this.closeSubscribers(roomId);
  }

  cleanupWaitingRoom(room, now) {
    let changed = false;
    for (const seat of room.seats) {
      if (!seat.clientId) continue;
      const client = room.clients?.[seat.clientId];
      const inactive = !client || (!client.connected && now - (client.lastSeen || 0) > WAITING_DISCONNECTED_TTL_MS);
      if (inactive) {
        if (client) delete room.clients[seat.clientId];
        seat.clientId = null;
        seat.name = `\u7b49\u5f85\u73a9\u5bb6${seat.index + 1}`;
        changed = true;
      }
    }
    for (const [clientId, client] of Object.entries(room.clients || {})) {
      if (client.spectator && !client.connected && now - (client.lastSeen || 0) > WAITING_DISCONNECTED_TTL_MS) {
        delete room.clients[clientId];
        changed = true;
      }
    }
    if (!room.hostClientId || !room.clients?.[room.hostClientId]) {
      const nextHostSeat = room.seats.find((seat) => seat.clientId);
      room.hostClientId = nextHostSeat?.clientId || null;
      changed = true;
    }
    return changed;
  }

  async cleanupRooms() {
    const now = Date.now();
    let changed = false;
    for (const [id, room] of [...this.rooms]) {
      const staleChanged = this.markAllStaleConnections(room);
      if (
        this.isBrokenRoom(room) ||
        now - Date.parse(room.updatedAt) > ROOM_TTL_MS ||
        (room.status === 'closed' && now - Date.parse(room.updatedAt) > 60 * 1000) ||
        (room.status === 'game_over' && now - Date.parse(room.updatedAt) > GAME_OVER_TTL_MS) ||
        (room.status !== 'waiting' && this.isAbandoned(room, now))
      ) {
        this.deleteRoom(id);
        changed = true;
        continue;
      }
      if (room.status === 'waiting' && room.seats.some((seat) => seat.clientId) && this.cleanupWaitingRoom(room, now)) {
        if (!room.hostClientId) {
          this.deleteRoom(id);
        } else {
          touch(room);
        }
        changed = true;
      } else if (staleChanged) {
        touch(room);
        changed = true;
      }
    }
    if (changed) await this.save();
  }

  closeSubscribers(roomId) {
    const list = this.subscribers.get(roomId);
    if (!list) return;
    for (const sub of [...list]) this.dropSubscriber(roomId, sub);
    this.subscribers.delete(roomId);
  }

  dropSubscriber(roomId, sub) {
    sub.closed = true;
    const list = this.subscribers.get(roomId);
    list?.delete(sub);
    if (list?.size === 0) this.subscribers.delete(roomId);
    sub.writer.close().catch(() => {});
  }

  queueSubscriberWrite(room, sub) {
    const list = this.subscribers.get(room.id);
    if (!list?.has(sub) || sub.closed) return;
    sub.latestPayload = encoder.encode(`event: room\ndata: ${JSON.stringify(publicRoom(room, sub.clientToken))}\n\n`);
    if (sub.writing) return;

    const pump = () => {
      if (sub.closed || !list.has(sub)) return;
      const payload = sub.latestPayload;
      sub.latestPayload = null;
      if (!payload) {
        sub.writing = false;
        return;
      }
      sub.writing = true;
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) this.dropSubscriber(room.id, sub);
      }, 1500);
      sub.writer.write(payload)
        .then(() => {
          settled = true;
          clearTimeout(timer);
          pump();
        })
        .catch(() => {
          settled = true;
          clearTimeout(timer);
          this.dropSubscriber(room.id, sub);
        });
    };

    pump();
  }

  broadcast(room) {
    const list = this.subscribers.get(room.id);
    if (!list?.size) return;
    for (const sub of [...list]) this.queueSubscriberWrite(room, sub);
  }
  ensureRoom(id) {
    const room = this.rooms.get(String(id || '').toUpperCase());
    if (!room) throw new Error('房间不存在或已过期');
    return room;
  }

  ensureClient(room, token) {
    const client = room.clients?.[token];
    if (!client) throw new Error('你还没有进入该房间');
    client.lastSeen = Date.now();
    return client;
  }

  markClientSeen(room, clientToken) {
    const client = room.clients?.[clientToken];
    if (!client) return false;
    client.lastSeen = Date.now();
    return true;
  }

  createRoom(body) {
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
      clients: {
        [hostClientId]: {
          clientId: hostClientId,
          playerIndex: 0,
          playerName: hostName,
          spectator: false,
          ready: true,
          connected: false,
          lastSeen: Date.now(),
        },
      },
      game: null,
      chat: [],
      notices: [],
      flash: null,
    };
    this.rooms.set(id, room);
    return { room, clientToken: hostClientId };
  }

  joinRoom(room, body) {
    const name = sanitizeName(body.playerName, '\u73a9\u5bb6');
    const requestedToken = normalizeClientToken(body.clientToken);
    if (requestedToken && room.clients?.[requestedToken]) {
      const existing = room.clients[requestedToken];
      if (room.status === 'waiting') {
        existing.playerName = name || existing.playerName;
        const seat = existing.playerIndex !== null ? room.seats[existing.playerIndex] : null;
        if (seat?.clientId === requestedToken) seat.name = existing.playerName;
      }
      existing.lastSeen = Date.now();
      if (existing.clientId === room.hostClientId) existing.ready = true;
      touch(room);
      return { room, clientToken: requestedToken };
    }
    this.markAllStaleConnections(room);
    const now = Date.now();
    const reusableSeat = room.status === 'waiting' ? room.seats.find((seat) => seat.clientId && this.canReplaceSeat(room, seat, now)) : null;
    if (reusableSeat?.clientId) delete room.clients[reusableSeat.clientId];
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
    room.clients[clientId] = client;
    touch(room);
    return { room, clientToken: clientId };
  }

  closeRoomForTooFewPlayers(room) {
    const message = '房间内只剩 1 名玩家，多人游戏已自动结束，所有玩家将退出房间。';
    room.status = 'closed';
    room.game = null;
    addNotice(room, 'room_closed', message);
    room.flash = { id: randomId('F'), type: 'room_closed', message, createdAt: new Date().toISOString() };
    touch(room);
  }

  handlePlayerLeftDuringGame(room, client, reason = 'leave') {
    if (!room.game || client.playerIndex === null || client.spectator) return;
    const player = room.game.players?.[client.playerIndex];
    const playerName = player?.name || client.playerName || `玩家${client.playerIndex + 1}`;
    const changed = markPlayerInactive(room.game, client.playerIndex);
    client.connected = false;
    client.left = true;
    client.lastSeen = Date.now();
    const seat = room.seats[client.playerIndex];
    if (seat) seat.left = true;
    if (changed) {
      const message = `${playerName} 已退出房间，系统将自动跳过该玩家的回合。`;
      addNotice(room, 'player_left', message);
      room.flash = { id: randomId('F'), type: 'player_left', playerIndex: client.playerIndex, message, createdAt: new Date().toISOString() };
      room.game.log?.unshift?.(message);
      if (room.game.log) room.game.log = room.game.log.slice(0, 80);
    }
    if (activePlayerCount(room.game) <= 1) {
      this.closeRoomForTooFewPlayers(room);
      return;
    }
    if (room.game.phase === 'discard_tokens' && room.game.pendingDiscardPlayerIndex === client.playerIndex) {
      room.game.pendingDiscardPlayerIndex = null;
      room.game.phase = 'player_action';
    }
    if (room.game.currentPlayerIndex === client.playerIndex || room.game.players?.[room.game.currentPlayerIndex]?.active === false) {
      advanceToNextActivePlayer(room.game, client.playerIndex);
    }
    if (room.game.phase === 'game_over') room.status = 'game_over';
  }

  leaveRoom(room, clientToken) {
    const client = room.clients?.[clientToken];
    if (!client) return;
    if (room.status === 'waiting' && client.playerIndex !== null) {
      const seat = room.seats[client.playerIndex];
      if (seat?.clientId === clientToken) {
        seat.clientId = null;
      seat.name = `\u7b49\u5f85\u73a9\u5bb6${seat.index + 1}`;
      }
      delete room.clients[clientToken];
      if (clientToken === room.hostClientId) {
        const nextHostSeat = room.seats.find((seat) => seat.clientId);
        room.hostClientId = nextHostSeat?.clientId || null;
        if (room.hostClientId && room.clients?.[room.hostClientId]) room.clients[room.hostClientId].ready = true;
      }
    } else if (client.spectator) {
      delete room.clients[clientToken];
    } else if (room.status === 'playing') {
      this.handlePlayerLeftDuringGame(room, client, 'leave');
    } else {
      client.connected = false;
      client.lastSeen = Date.now();
    }
    this.markAllStaleConnections(room);
    touch(room);
    if ((!room.hostClientId && room.status === 'waiting') || (room.status !== 'waiting' && room.status !== 'closed' && !this.hasConnectedSeat(room))) {
      this.deleteRoom(room.id);
    }
  }

  setReady(room, clientToken, ready) {
    const client = this.ensureClient(room, clientToken);
    if (room.status !== 'waiting') throw new Error('只有等待中的房间可以准备');
    if (client.spectator || client.playerIndex === null) throw new Error('观战者不能准备');
    if (client.clientId === room.hostClientId) {
      client.ready = true;
    } else {
      client.ready = Boolean(ready);
    }
    touch(room);
  }

  kickPlayer(room, hostToken, playerIndex) {
    const host = this.ensureClient(room, hostToken);
    if (host.clientId !== room.hostClientId) throw new Error('只有房主可以踢出玩家');
    if (room.status !== 'waiting') throw new Error('只有等待界面可以踢出玩家');
    const index = Number(playerIndex);
    const seat = room.seats[index];
    if (!seat?.clientId) throw new Error('该座位没有玩家');
    if (seat.clientId === room.hostClientId) throw new Error('房主不能踢出自己');
    const kickedName = seat.name;
    delete room.clients[seat.clientId];
    seat.clientId = null;
    seat.name = `等待玩家${seat.index + 1}`;
    addNotice(room, 'player_kicked', `${kickedName} 已被房主移出房间。`);
    touch(room);
  }

  sendChat(room, clientToken, message) {
    const client = this.ensureClient(room, clientToken);
    if (room.status === 'closed') throw new Error('房间已经结束');
    addChatMessage(room, client, message);
    touch(room);
  }

  startRoom(room, clientToken) {
    const client = this.ensureClient(room, clientToken);
    if (client.clientId !== room.hostClientId) throw new Error('只有房主可以开始游戏');
    if (room.status === 'playing' && room.game) return;
    if (room.status !== 'waiting') throw new Error('房间已经结束');
    const { missing, unready } = readyState(room);
    if (missing.length) throw new Error('请等待所有座位坐满后再开始');
    if (unready.length) throw new Error('除房主外的所有玩家都准备后才能开始');
    const firstPlayerIndex = room.firstMode === 'random' ? Math.floor(Math.random() * room.playerCount) : 0;
    room.game = createGame({
      playerCount: room.playerCount,
      playerNames: room.seats.map((seat) => seat.name),
      firstPlayerIndex,
    });
    room.status = 'playing';
    room.flash = null;
    addNotice(room, 'game_started', '游戏已开始，祝大家玩得开心。');
    touch(room);
  }

  assertPlayerTurn(room, client) {
    if (!room.game || room.status !== 'playing') throw new Error('房间尚未开始游戏');
    if (client.spectator || client.playerIndex === null) throw new Error('观战者不能执行游戏动作');
    const game = room.game;
    if (game.phase === 'player_action' && game.currentPlayerIndex !== client.playerIndex) throw new Error('还没有轮到你行动');
    if (game.phase === 'discard_tokens' && game.pendingDiscardPlayerIndex !== client.playerIndex) throw new Error('当前需要其他玩家弃还资源');
  }

  handleAction(room, clientToken, body) {
    const client = this.ensureClient(room, clientToken);
    this.assertPlayerTurn(room, client);
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
    return result;
  }

  async handleEvents(request, room, clientToken) {
    const client = this.ensureClient(room, clientToken);
    client.connected = true;
    touch(room);
    await this.save();

    const stream = new TransformStream();
    const writer = stream.writable.getWriter();
    const sub = { writer, clientToken };
    if (!this.subscribers.has(room.id)) this.subscribers.set(room.id, new Set());
    this.subscribers.get(room.id).add(sub);

    this.broadcast(room);

    request.signal.addEventListener('abort', () => {
      this.dropSubscriber(room.id, sub);
      const c = room.clients?.[clientToken];
      if (c) {
        if (room.status === 'playing' && !c.spectator) this.handlePlayerLeftDuringGame(room, c, 'disconnect');
        else c.connected = false;
      }
      touch(room);
      this.save().catch(() => {});
      this.broadcast(room);
    });

    return new Response(stream.readable, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    try {
      await this.cleanupRooms();
      const parts = url.pathname.split('/').filter(Boolean);
      if (request.method === 'GET' && url.pathname === '/api/rooms') {
        return json(200, { rooms: [...this.rooms.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).map(roomListItem) });
      }
      if (request.method === 'POST' && url.pathname === '/api/rooms') {
        const created = this.createRoom(await readBody(request));
        await this.save();
        return json(200, { clientToken: created.clientToken, room: publicRoom(created.room, created.clientToken) });
      }
      if (parts[0] === 'api' && parts[1] === 'rooms' && parts[2]) {
        const room = this.ensureRoom(parts[2]);
        if (request.method === 'GET' && parts.length === 3) {
          const clientToken = url.searchParams.get('clientToken') || '';
          if (this.markClientSeen(room, clientToken)) await this.save();
          return json(200, { room: publicRoom(room, clientToken) });
        }
        if (request.method === 'GET' && parts[3] === 'events') {
          const clientToken = url.searchParams.get('clientToken') || '';
          return this.handleEvents(request, room, clientToken);
        }
        if (request.method === 'POST' && parts[3] === 'join') {
          const joined = this.joinRoom(room, await readBody(request));
          await this.save();
          this.broadcast(room);
          return json(200, { clientToken: joined.clientToken, room: publicRoom(room, joined.clientToken) });
        }
        if (request.method === 'POST' && parts[3] === 'leave') {
          const body = await readBody(request);
          this.leaveRoom(room, body.clientToken);
          await this.save();
          if (this.rooms.has(room.id)) this.broadcast(room);
          return json(200, { ok: true });
        }
        if (request.method === 'POST' && parts[3] === 'ready') {
          const body = await readBody(request);
          this.setReady(room, body.clientToken, body.ready);
          await this.save();
          this.broadcast(room);
          return json(200, { room: publicRoom(room, body.clientToken) });
        }
        if (request.method === 'POST' && parts[3] === 'kick') {
          const body = await readBody(request);
          this.kickPlayer(room, body.clientToken, body.playerIndex);
          await this.save();
          this.broadcast(room);
          return json(200, { room: publicRoom(room, body.clientToken) });
        }
        if (request.method === 'POST' && parts[3] === 'chat') {
          const body = await readBody(request);
          this.sendChat(room, body.clientToken, body.message);
          await this.save();
          this.broadcast(room);
          return json(200, { room: publicRoom(room, body.clientToken) });
        }
        if (request.method === 'POST' && parts[3] === 'start') {
          const body = await readBody(request);
          this.startRoom(room, body.clientToken);
          await this.save();
          this.broadcast(room);
          return json(200, { room: publicRoom(room, body.clientToken) });
        }
        if (request.method === 'POST' && parts[3] === 'actions') {
          const body = await readBody(request);
          const result = this.handleAction(room, body.clientToken, body);
          await this.save();
          this.broadcast(room);
          return json(200, { room: publicRoom(room, body.clientToken), result });
        }
      }
      return json(404, { error: 'API 不存在' });
    } catch (error) {
      return json(400, { error: error.message || String(error) });
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      const id = env.GAME_LOBBY.idFromName('global');
      return env.GAME_LOBBY.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
