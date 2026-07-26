import {
  buyCard,
  createGame,
  discardToken,
  reserveBlindCard,
  reserveMarketCard,
  takeDifferent,
  takeSame,
} from '../src/game.js';

const ROOM_TTL_MS = 12 * 60 * 60 * 1000;
const WAITING_DISCONNECTED_TTL_MS = 5 * 60 * 1000;
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
    seats: room.seats.map((seat) => ({
      index: seat.index,
      name: seat.name,
      occupied: Boolean(seat.clientId),
      connected: Boolean(seat.clientId && room.clients?.[seat.clientId]?.connected),
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
    const broken = (value) => /^\?+$/.test(String(value || '').trim());
    return broken(room.name) || room.seats.some((seat) => broken(seat.name));
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

  cleanupWaitingRoom(room, now) {
    let changed = false;
    for (const seat of room.seats) {
      if (!seat.clientId) continue;
      const client = room.clients?.[seat.clientId];
      if (client) changed = this.markStaleConnection(room, client) || changed;
      const inactive = !client || (!client.connected && now - (client.lastSeen || 0) > WAITING_DISCONNECTED_TTL_MS);
      if (inactive) {
        if (client) delete room.clients[seat.clientId];
        seat.clientId = null;
        seat.name = `等待玩家${seat.index + 1}`;
        changed = true;
      }
    }
    for (const [clientId, client] of Object.entries(room.clients || {})) {
      changed = this.markStaleConnection(room, client) || changed;
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
      if (this.isBrokenRoom(room) || now - Date.parse(room.updatedAt) > ROOM_TTL_MS) {
        this.rooms.delete(id);
        this.closeSubscribers(id);
        changed = true;
        continue;
      }
      if (room.status === 'waiting' && this.cleanupWaitingRoom(room, now)) {
        if (!room.hostClientId) {
          this.rooms.delete(id);
          this.closeSubscribers(id);
        } else {
          touch(room);
        }
        changed = true;
      }
    }
    if (changed) await this.save();
  }

  closeSubscribers(roomId) {
    const list = this.subscribers.get(roomId);
    if (!list) return;
    for (const sub of list) {
      sub.writer.close().catch(() => {});
    }
    this.subscribers.delete(roomId);
  }

  async broadcast(room) {
    const list = this.subscribers.get(room.id);
    if (!list) return;
    for (const sub of [...list]) {
      try {
        await sub.writer.write(encoder.encode(`event: room\ndata: ${JSON.stringify(publicRoom(room, sub.clientToken))}\n\n`));
      } catch {
        list.delete(sub);
      }
    }
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
          connected: false,
          lastSeen: Date.now(),
        },
      },
      game: null,
      flash: null,
    };
    this.rooms.set(id, room);
    return { room, clientToken: hostClientId };
  }

  joinRoom(room, body) {
    const name = sanitizeName(body.playerName, '线上玩家');
    const clientId = randomId('C');
    const emptySeat = room.status === 'waiting' ? room.seats.find((seat) => !seat.clientId) : null;
    let client;
    if (emptySeat) {
      emptySeat.clientId = clientId;
      emptySeat.name = name;
      client = { clientId, playerIndex: emptySeat.index, playerName: name, spectator: false, connected: false, lastSeen: Date.now() };
    } else {
      client = { clientId, playerIndex: null, playerName: name, spectator: true, connected: false, lastSeen: Date.now() };
    }
    room.clients[clientId] = client;
    touch(room);
    return { room, clientToken: clientId };
  }

  leaveRoom(room, clientToken) {
    const client = room.clients?.[clientToken];
    if (!client) return;
    if (room.status === 'waiting' && client.playerIndex !== null) {
      const seat = room.seats[client.playerIndex];
      if (seat?.clientId === clientToken) {
        seat.clientId = null;
        seat.name = `等待玩家${seat.index + 1}`;
      }
      delete room.clients[clientToken];
      if (clientToken === room.hostClientId) {
        const nextHostSeat = room.seats.find((seat) => seat.clientId);
        room.hostClientId = nextHostSeat?.clientId || null;
      }
    } else if (client.spectator) {
      delete room.clients[clientToken];
    } else {
      client.connected = false;
      client.lastSeen = Date.now();
    }
    touch(room);
    if (!room.hostClientId && room.status === 'waiting') {
      this.rooms.delete(room.id);
      this.closeSubscribers(room.id);
    }
  }

  startRoom(room, clientToken) {
    const client = this.ensureClient(room, clientToken);
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

    await writer.write(encoder.encode(`event: room\ndata: ${JSON.stringify(publicRoom(room, clientToken))}\n\n`));
    await this.broadcast(room);

    request.signal.addEventListener('abort', async () => {
      this.subscribers.get(room.id)?.delete(sub);
      const c = room.clients?.[clientToken];
      if (c) c.connected = false;
      touch(room);
      await this.save();
      await this.broadcast(room);
      writer.close().catch(() => {});
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
          return json(200, { room: publicRoom(room, clientToken) });
        }
        if (request.method === 'GET' && parts[3] === 'events') {
          const clientToken = url.searchParams.get('clientToken') || '';
          return this.handleEvents(request, room, clientToken);
        }
        if (request.method === 'POST' && parts[3] === 'join') {
          const joined = this.joinRoom(room, await readBody(request));
          await this.save();
          await this.broadcast(room);
          return json(200, { clientToken: joined.clientToken, room: publicRoom(room, joined.clientToken) });
        }
        if (request.method === 'POST' && parts[3] === 'leave') {
          const body = await readBody(request);
          this.leaveRoom(room, body.clientToken);
          await this.save();
          if (this.rooms.has(room.id)) await this.broadcast(room);
          return json(200, { ok: true });
        }
        if (request.method === 'POST' && parts[3] === 'start') {
          const body = await readBody(request);
          this.startRoom(room, body.clientToken);
          await this.save();
          await this.broadcast(room);
          return json(200, { room: publicRoom(room, body.clientToken) });
        }
        if (request.method === 'POST' && parts[3] === 'actions') {
          const body = await readBody(request);
          const result = this.handleAction(room, body.clientToken, body);
          await this.save();
          await this.broadcast(room);
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
