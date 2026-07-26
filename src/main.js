import {
  buyCard,
  canBuyCard,
  createGame,
  discardToken,
  getCurrentPlayer,
  getPaymentOptions,
  getPermanentCounts,
  reserveBlindCard,
  reserveMarketCard,
  takeDifferent,
  takeSame,
  totalTokens,
} from './game.js';
import { GAME_VERSION, MARKET_SIZE, RESERVE_LIMIT, TASK_INFO, TASK_TYPES, TOKEN_LIMIT, TOKEN_TYPES } from './data.js';

let game = null;
let selectedDifferent = new Set();
let lastError = '';
let opportunityAnimation = null;
let gameOverDismissed = false;
let rulesOpen = false;
let setupMode = 'menu';
let rooms = [];
let roomsLoading = false;
let online = loadOnlineSession();

const app = document.querySelector('#app');

function isOnline() {
  return Boolean(online?.room);
}

function onlineViewer() {
  return online?.room?.viewer || null;
}

function isOnlinePlayer() {
  return isOnline() && onlineViewer() && !onlineViewer().spectator && onlineViewer().playerIndex !== null;
}

function isOnlineActionTurn() {
  if (!isOnlinePlayer() || !game) return false;
  const viewer = onlineViewer();
  if (game.phase === 'player_action') return game.currentPlayerIndex === viewer.playerIndex;
  if (game.phase === 'discard_tokens') return game.pendingDiscardPlayerIndex === viewer.playerIndex;
  return false;
}

function save() {
  if (game && !isOnline()) localStorage.setItem('universitySplendorGame', JSON.stringify(game));
}

function load() {
  const raw = localStorage.getItem('universitySplendorGame');
  if (!raw) return null;
  try {
    const saved = JSON.parse(raw);
    return saved?.version === GAME_VERSION ? saved : null;
  } catch {
    return null;
  }
}

function loadOnlineSession() {
  const raw = localStorage.getItem('universitySplendorOnlineSession');
  if (!raw) return null;
  try {
    const saved = JSON.parse(raw);
    if (!saved?.roomId || !saved?.clientToken) return null;
    return { ...saved, room: null, connected: false, eventSource: null, lastFlashId: null };
  } catch {
    return null;
  }
}

function saveOnlineSession() {
  if (!online?.roomId || !online?.clientToken) return;
  localStorage.setItem('universitySplendorOnlineSession', JSON.stringify({ roomId: online.roomId, clientToken: online.clientToken }));
}

function clearOnlineSession() {
  online?.eventSource?.close?.();
  online = null;
  localStorage.removeItem('universitySplendorOnlineSession');
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败：${response.status}`);
  return data;
}

function applyOnlineRoom(room) {
  if (!online) return;
  online.room = room;
  online.connected = true;
  game = room.game || null;
  if (room.flash?.type === 'opportunity' && room.flash.id !== online.lastFlashId) {
    online.lastFlashId = room.flash.id;
    if (room.flash.card && room.flash.message) showOpportunityAnimation(room.flash.card, room.flash.message);
  }
}

async function refreshRooms() {
  roomsLoading = true;
  render();
  try {
    const data = await api('/api/rooms');
    rooms = data.rooms || [];
    lastError = '';
  } catch (error) {
    rooms = [];
    lastError = `${error.message || error}。如果是在本机开发预览，请用 npm run serve 或 node server.js 启动带房间 API 的服务器；线上部署页面请稍后刷新重试。`;
  } finally {
    roomsLoading = false;
    render();
  }
}

async function reconnectOnlineSession() {
  if (!online?.roomId || !online?.clientToken) return;
  try {
    const data = await api(`/api/rooms/${encodeURIComponent(online.roomId)}?clientToken=${encodeURIComponent(online.clientToken)}`);
    applyOnlineRoom(data.room);
    connectRoomEvents();
  } catch (error) {
    lastError = `无法恢复线上房间：${error.message || error}`;
    clearOnlineSession();
    game = null;
  }
  render();
}

function connectRoomEvents() {
  if (!online?.roomId || !online?.clientToken || online.eventSource) return;
  const source = new EventSource(`/api/rooms/${encodeURIComponent(online.roomId)}/events?clientToken=${encodeURIComponent(online.clientToken)}`);
  online.eventSource = source;
  source.onopen = () => {
    if (!online) return;
    online.connected = true;
    if (lastError === '线上连接已断开，浏览器正在尝试重连。') lastError = '';
  };
  source.addEventListener('room', (event) => {
    applyOnlineRoom(JSON.parse(event.data));
    selectedDifferent.clear();
    render();
  });
  source.onerror = () => {
    if (!online) return;
    online.connected = false;
    lastError = '线上连接已断开，浏览器正在尝试重连。';
    render();
  };
}

async function createOnlineRoom(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    lastError = '';
    const data = await api('/api/rooms', {
      method: 'POST',
      body: JSON.stringify({
        roomName: form.get('roomName'),
        playerName: form.get('playerName'),
        playerCount: Number(form.get('playerCount')),
        firstMode: form.get('firstMode'),
      }),
    });
    online = { roomId: data.room.id, clientToken: data.clientToken, room: data.room, connected: true, eventSource: null, lastFlashId: null };
    game = data.room.game || null;
    saveOnlineSession();
    connectRoomEvents();
  } catch (error) {
    lastError = error.message || String(error);
  }
  render();
}

async function joinOnlineRoom(roomId, playerName = '') {
  const name = playerName || prompt('请输入你的玩家名称：', '线上玩家');
  if (name === null) return;
  try {
    lastError = '';
    const data = await api(`/api/rooms/${encodeURIComponent(roomId)}/join`, {
      method: 'POST',
      body: JSON.stringify({ playerName: name }),
    });
    online = { roomId: data.room.id, clientToken: data.clientToken, room: data.room, connected: true, eventSource: null, lastFlashId: null };
    game = data.room.game || null;
    saveOnlineSession();
    connectRoomEvents();
  } catch (error) {
    lastError = error.message || String(error);
  }
  render();
}

async function startOnlineRoom() {
  try {
    lastError = '';
    const data = await api(`/api/rooms/${encodeURIComponent(online.roomId)}/start`, {
      method: 'POST',
      body: JSON.stringify({ clientToken: online.clientToken }),
    });
    applyOnlineRoom(data.room);
  } catch (error) {
    lastError = error.message || String(error);
  }
  render();
}

async function sendOnlineAction(type, payload = {}) {
  try {
    lastError = '';
    const data = await api(`/api/rooms/${encodeURIComponent(online.roomId)}/actions`, {
      method: 'POST',
      body: JSON.stringify({ clientToken: online.clientToken, type, payload }),
    });
    selectedDifferent.clear();
    applyOnlineRoom(data.room);
  } catch (error) {
    lastError = error.message || String(error);
  }
  render();
}

function leaveOnlineRoom() {
  if (!confirm('确定要退出当前线上房间吗？')) return;
  const roomId = online?.roomId;
  const clientToken = online?.clientToken;
  if (roomId && clientToken) {
    api(`/api/rooms/${encodeURIComponent(roomId)}/leave`, {
      method: 'POST',
      body: JSON.stringify({ clientToken }),
    }).catch(() => {});
  }
  clearOnlineSession();
  game = null;
  selectedDifferent.clear();
  setupMode = 'online';
  refreshRooms();
  render();
}

function runAction(fn, onlineAction) {
  if (isOnline()) {
    if (!onlineAction) {
      lastError = '该动作暂不支持线上模式。';
      render();
      return;
    }
    sendOnlineAction(onlineAction.type, onlineAction.payload);
    return;
  }
  try {
    lastError = '';
    fn();
    selectedDifferent.clear();
    save();
  } catch (error) {
    lastError = error.message || String(error);
  }
  render();
}

function startGame(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const playerCount = Number(form.get('playerCount'));
  const names = Array.from({ length: playerCount }, (_, i) => form.get(`p${i + 1}`)?.trim() || `玩家${i + 1}`);
  const firstMode = form.get('firstMode');
  const firstPlayerIndex = firstMode === 'random' ? Math.floor(Math.random() * playerCount) : Number(form.get('firstPlayerIndex'));
  game = createGame({ playerCount, playerNames: names, firstPlayerIndex });
  opportunityAnimation = null;
  gameOverDismissed = false;
  rulesOpen = false;
  selectedDifferent.clear();
  save();
  render();
}

function resetGame() {
  if (isOnline()) {
    leaveOnlineRoom();
    return;
  }
  if (!confirm('确定要重新开始并清除当前进度吗？')) return;
  game = null;
  opportunityAnimation = null;
  gameOverDismissed = false;
  rulesOpen = false;
  localStorage.removeItem('universitySplendorGame');
  selectedDifferent.clear();
  render();
}

function render() {
  if (isOnline() && !online.room) {
    renderSetup();
    return;
  }
  if (isOnline() && online.room.status === 'waiting') {
    game = null;
    renderOnlineRoom();
    return;
  }
  if (!game) {
    renderSetup();
    return;
  }
  const current = getCurrentPlayer(game);
  const viewer = onlineViewer();
  const modeText = isOnline()
    ? `线上房间 ${escapeHtml(online.room.name)}（${escapeHtml(online.room.id)}）${viewer?.spectator ? ' · 观战中' : ` · 你是 ${escapeHtml(viewer?.playerName || '')}`}`
    : `本地多人 ${GAME_VERSION}`;
  app.innerHTML = `
    ${renderRulesModal()}
    ${renderGameOver()}
    ${renderOpportunityAnimation()}
    <header class="hero">
      <div>
        <h1>璀璨宝石之大学模拟器</h1>
        <p>${modeText} · 每回合四选一 · 15 开心值触发终局</p>
      </div>
      <div class="header-actions">
        ${isOnline() ? `<button id="copyRoomBtn">复制房间号</button>` : ''}
        <button id="rulesBtn">规则介绍</button>
        ${isOnline() ? `<button class="danger" id="leaveOnlineBtn">退出房间</button>` : '<button id="saveBtn">保存进度</button><button class="danger" id="resetBtn">重新开始</button>'}
      </div>
    </header>

    ${renderOnlineNotice()}
    ${lastError ? `<div class="toast error">${escapeHtml(lastError)}</div>` : ''}

    <main class="dashboard">
      <section class="status-grid">
        <div class="panel current">
          <h2>当前回合</h2>
          <p class="big">${escapeHtml(current.name)}</p>
          <p>第 ${game.roundNumber} 轮 · ${game.endgameTriggered ? `终局：${game.endgameTriggeredBy}` : '未终局'}</p>
        </div>
        <div class="panel">
          <h2>公共供应</h2>
          <div class="tokens">${TOKEN_TYPES.map((t) => tokenBadge(t, game.supply[t], false)).join('')}</div>
        </div>
        <div class="panel">
          <h2>牌库</h2>
          <p>一级 ${game.decks.level1.length} 张 · 二级 ${game.decks.level2.length} 张 · 机遇池 ${game.decks.opportunity.length} 张（有放回）</p>
          <p>市场：每级最多 ${MARKET_SIZE} 张</p>
        </div>
      </section>

      ${renderMarket()}

      <section class="lower-grid">
        ${renderPlayers()}
        ${renderPhaseControls()}
        ${renderReserved()}
        ${renderLog()}
      </section>
    </main>
  `;
  bindEvents();
}

function renderSetup() {
  const saved = load();
  app.innerHTML = `
    ${renderRulesModal()}
    <div class="setup-top-actions">
      <button id="rulesBtn">规则介绍</button>
    </div>
    <main class="setup">
      <div class="setup-card setup-card-wide">
        <h1>璀璨宝石之大学模拟器</h1>
        <p>请选择游玩模式：本地多人轮流共用一台设备，或线上多人通过房间同步游玩。</p>
        <div class="mode-switch">
          <button class="${setupMode === 'local' || setupMode === 'menu' ? 'primary' : ''}" data-mode="local">本地多人轮流</button>
          <button class="${setupMode === 'online' ? 'primary' : ''}" data-mode="online">线上多人房间</button>
        </div>
        ${setupMode === 'online' ? renderOnlineLobby() : renderLocalSetup(saved)}
      </div>
    </main>
  `;
  bindSetupEvents(saved);
}

function renderLocalSetup(saved) {
  return `
    <section class="mode-panel">
      <h2>本地多人轮流游玩</h2>
      <p class="muted">所有玩家共用当前浏览器，按回合轮流操作；可保存到浏览器本地存储。</p>
      ${saved ? '<button id="continueBtn" class="primary wide">继续上次本地进度</button>' : ''}
      <form id="setupForm">
        <label>玩家人数
          <select name="playerCount" id="playerCount">
            <option value="2">2 人</option>
            <option value="3">3 人</option>
            <option value="4">4 人</option>
          </select>
        </label>
        <div id="nameFields"></div>
        <label>先手规则
          <select name="firstMode" id="firstMode">
            <option value="manual">手动指定</option>
            <option value="random">随机</option>
          </select>
        </label>
        <label id="firstPlayerWrap">先手玩家
          <select name="firstPlayerIndex" id="firstPlayerIndex"></select>
        </label>
        <button class="primary wide" type="submit">开始本地新游戏</button>
      </form>
    </section>
  `;
}

function renderOnlineLobby() {
  return `
    <section class="mode-panel online-lobby">
      <h2>线上多人游玩</h2>
      <p class="muted">当前网页会连接线上房间服务。创建房间后，把本页面地址或房间号发给朋友；朋友选择「线上多人房间」即可看到并加入。只有本地开发预览时才需要 <code>npm run serve</code> 或 <code>node server.js</code>。</p>
      <div class="online-grid">
        <form id="createRoomForm" class="sub-card">
          <h3>创建房间</h3>
          <label>房间名称 <input name="roomName" maxlength="24" value="我的房间" /></label>
          <label>你的名称 <input name="playerName" maxlength="18" value="玩家1" /></label>
          <label>房间人数
            <select name="playerCount">
              <option value="2">2 人</option>
              <option value="3">3 人</option>
              <option value="4">4 人</option>
            </select>
          </label>
          <label>先手规则
            <select name="firstMode">
              <option value="host">房主先手</option>
              <option value="random">随机先手</option>
            </select>
          </label>
          <button class="primary wide" type="submit">创建线上房间</button>
        </form>
        <div class="sub-card">
          <div class="room-list-title">
            <h3>已有房间</h3>
            <button id="refreshRoomsBtn" type="button">${roomsLoading ? '刷新中...' : '刷新'}</button>
          </div>
          <div class="rooms">
            ${rooms.length ? rooms.map(renderRoomListItem).join('') : `<p class="muted">暂无房间。点击刷新，或自己创建一个房间。</p>`}
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderRoomListItem(room) {
  const statusText = { waiting: '等待中', playing: '游戏中', game_over: '已结束' }[room.status] || room.status;
  const canJoin = room.status === 'waiting' && room.occupied < room.playerCount;
  const canWatch = room.status !== 'waiting';
  const buttonText = canJoin ? '进入房间' : (room.status === 'waiting' ? '房间已满' : '观战');
  const buttonAttrs = canJoin || canWatch ? `data-join-room="${escapeHtml(room.id)}"` : 'disabled';
  const hint = canJoin
    ? '可加入空位'
    : (room.status === 'waiting' ? '座位已满；如果是别人退出后的旧房间，请点刷新，服务器会自动释放离线空位。' : '游戏已开始，只能观战。');
  return `
    <article class="room-item">
      <div>
        <strong>${escapeHtml(room.name)}</strong>
        <p>${escapeHtml(room.id)} &middot; ${statusText} &middot; ${room.occupied}/${room.playerCount} 人</p>
        <p class="muted">${room.seats.map((seat) => seat.occupied ? escapeHtml(seat.name) : `空位${seat.index + 1}`).join('、')}</p>
        <p class="muted room-hint">${escapeHtml(hint)}</p>
      </div>
      <button ${buttonAttrs}>${buttonText}</button>
    </article>
  `;
}

function bindSetupEvents(saved) {
  bindRulesEvents();
  document.querySelectorAll('[data-mode]').forEach((btn) => btn.addEventListener('click', () => {
    setupMode = btn.dataset.mode;
    if (setupMode === 'online') refreshRooms();
    else render();
  }));
  document.querySelector('#createRoomForm')?.addEventListener('submit', createOnlineRoom);
  document.querySelector('#refreshRoomsBtn')?.addEventListener('click', refreshRooms);
  document.querySelectorAll('[data-join-room]').forEach((btn) => btn.addEventListener('click', () => joinOnlineRoom(btn.dataset.joinRoom)));

  const playerCount = document.querySelector('#playerCount');
  const firstMode = document.querySelector('#firstMode');
  if (playerCount && firstMode) {
    const updateFields = () => {
      const count = Number(playerCount.value);
      document.querySelector('#nameFields').innerHTML = Array.from({ length: count }, (_, i) => `
        <label>玩家 ${i + 1} 名称 <input name="p${i + 1}" value="玩家${i + 1}" /></label>
      `).join('');
      document.querySelector('#firstPlayerIndex').innerHTML = Array.from({ length: count }, (_, i) => `<option value="${i}">玩家${i + 1}</option>`).join('');
    };
    const updateFirst = () => {
      document.querySelector('#firstPlayerWrap').style.display = firstMode.value === 'random' ? 'none' : 'grid';
    };
    playerCount.addEventListener('change', updateFields);
    firstMode.addEventListener('change', updateFirst);
    document.querySelector('#setupForm')?.addEventListener('submit', startGame);
    document.querySelector('#continueBtn')?.addEventListener('click', () => {
      game = saved;
      opportunityAnimation = null;
      gameOverDismissed = false;
      render();
    });
    updateFields();
    updateFirst();
  }
}

function renderOnlineRoom() {
  const room = online.room;
  const viewer = onlineViewer();
  const canStart = viewer?.isHost && room.seats.every((seat) => seat.occupied);
  app.innerHTML = `
    ${renderRulesModal()}
    <header class="hero">
      <div>
        <h1>${escapeHtml(room.name)}</h1>
        <p>线上房间 ${escapeHtml(room.id)} · 等待玩家加入 · ${room.seats.filter((s) => s.occupied).length}/${room.playerCount} 人</p>
      </div>
      <div class="header-actions">
        <button id="copyRoomBtn">复制房间号</button>
        <button id="rulesBtn">规则介绍</button>
        <button class="danger" id="leaveOnlineBtn">退出房间</button>
      </div>
    </header>
    ${lastError ? `<div class="toast error">${escapeHtml(lastError)}</div>` : ''}
    <main class="setup">
      <div class="setup-card setup-card-wide">
        <h2>房间等待区</h2>
        <p class="muted">把当前页面地址或房间号 ${escapeHtml(room.id)} 发给其他玩家。所有座位坐满后，房主可以开始游戏。</p>
        <div class="seat-grid">
          ${room.seats.map((seat) => `
            <article class="seat-card ${seat.occupied ? 'occupied' : ''}">
              <h3>座位 ${seat.index + 1}${seat.isHost ? ' · 房主' : ''}</h3>
              <p>${seat.occupied ? escapeHtml(seat.name) : '等待加入'}</p>
              <small>${seat.connected ? '在线' : seat.occupied ? '暂离' : '空位'}</small>
            </article>
          `).join('')}
        </div>
        <button id="startOnlineBtn" class="primary wide" ${canStart ? '' : 'disabled'}>${viewer?.isHost ? '开始线上游戏' : '等待房主开始'}</button>
      </div>
    </main>
  `;
  bindEvents();
}

function renderOnlineNotice() {
  if (!isOnline()) return '';
  const viewer = onlineViewer();
  const turn = isOnlineActionTurn();
  const text = viewer?.spectator
    ? '你正在观战，不能执行游戏动作。'
    : turn ? '轮到你操作。' : '请等待其他玩家操作。';
  return `<div class="online-notice ${turn ? 'your-turn' : ''}">${escapeHtml(text)} ${online.connected ? '已连接' : '连接中断，自动重连中'}。</div>`;
}

function showOpportunityAnimation(card, message) {
  const id = Date.now();
  opportunityAnimation = {
    id,
    name: card.name,
    attribute: card.attribute,
    message: message.replace(/^机遇「[^」]+」：/, '').replace(/。$/, ''),
  };
  window.setTimeout(() => {
    if (opportunityAnimation?.id === id) {
      opportunityAnimation = null;
      render();
    }
  }, 2800);
}

function renderOpportunityAnimation() {
  if (!opportunityAnimation) return '';
  const attr = opportunityAnimation.attribute;
  const attrName = TASK_INFO[attr]?.name || '无属性';
  return `
    <div class="opportunity-overlay" aria-live="polite">
      <article class="opportunity-card attr-${attr || 'none'}">
        <p class="opportunity-kicker">机遇卡</p>
        <h2>${escapeHtml(opportunityAnimation.name)}</h2>
        <p class="opportunity-attr">${attributeBadge(attr, attrName)}</p>
        <p class="opportunity-message">${escapeHtml(opportunityAnimation.message)}</p>
      </article>
    </div>
  `;
}

function renderPlayers() {
  const viewer = onlineViewer();
  return `<section class="players">${game.players.map((player, index) => {
    const permanent = getPermanentCounts(player);
    const badges = `${index === game.currentPlayerIndex ? '<span>当前</span>' : ''}${viewer?.playerIndex === index ? '<span>你</span>' : ''}`;
    return `
      <article class="panel player ${index === game.currentPlayerIndex ? 'active' : ''} ${viewer?.playerIndex === index ? 'me' : ''}">
        <h2>${escapeHtml(player.name)} ${badges}</h2>
        <p class="score">开心值 ${player.happiness}</p>
        <p>资源 ${totalTokens(player.tokens)}/${TOKEN_LIMIT}</p>
        <div class="tokens small">${TOKEN_TYPES.map((t) => tokenBadge(t, player.tokens[t], true)).join('')}</div>
        <p>永久属性</p>
        <div class="tokens small">${TASK_TYPES.map((t) => tokenBadge(t, permanent[t], true)).join('')}</div>
        <p>已赢取 ${player.ownedCards.length} 张 · 预留 ${player.reservedCards.length}/${RESERVE_LIMIT} 张 · 已行动 ${player.turnsTaken} 次</p>
      </article>
    `;
  }).join('')}</section>`;
}

function renderPhaseControls() {
  if (game.phase === 'game_over') return '';
  const canInteract = !isOnline() || isOnlineActionTurn();
  if (isOnline() && !canInteract) {
    const current = game.phase === 'discard_tokens' ? game.players[game.pendingDiscardPlayerIndex] : getCurrentPlayer(game);
    return `
      <section class="panel action-panel">
        <h2>等待操作</h2>
        <p>当前阶段：${phaseText(game.phase)}。</p>
        <p>请等待 ${escapeHtml(current.name)} 完成操作。</p>
      </section>
    `;
  }
  if (game.phase === 'discard_tokens') {
    const player = game.players[game.pendingDiscardPlayerIndex];
    return `
      <section class="panel action-panel highlight">
        <h2>强制弃还资源</h2>
        <p>${escapeHtml(player.name)} 当前资源 ${totalTokens(player.tokens)}/${TOKEN_LIMIT}，请弃还到 ${TOKEN_LIMIT} 张。</p>
        <div class="button-row">${TOKEN_TYPES.map((type) => `<button ${player.tokens[type] <= 0 || !canInteract ? 'disabled' : ''} data-discard="${type}">弃还${TASK_INFO[type].name}</button>`).join('')}</div>
      </section>
    `;
  }
  const currentPlayer = getCurrentPlayer(game);
  const reserveFull = currentPlayer.reservedCards.length >= RESERVE_LIMIT;
  const hasLevel1Reservable = game.decks.level1.some((card) => card.attribute);
  const hasLevel2Reservable = game.decks.level2.some((card) => card.attribute);
  return `
    <section class="panel action-panel">
      <h2>主动作</h2>
      <div class="action-block">
        <h3>拿 3 不同</h3>
        <div class="button-row">${TASK_TYPES.map((type) => `<button class="select-token ${selectedDifferent.has(type) ? 'selected' : ''}" ${game.supply[type] <= 0 || !canInteract ? 'disabled' : ''} data-toggle-different="${type}">${TASK_INFO[type].name}</button>`).join('')}</div>
        <button class="primary" ${!canInteract ? 'disabled' : ''} data-action="takeDifferent">拿所选</button>
      </div>
      <div class="action-block">
        <h3>拿 2 相同</h3>
        <div class="button-row">${TASK_TYPES.map((type) => `<button ${game.supply[type] < 4 || !canInteract ? 'disabled' : ''} data-take-same="${type}">2${TASK_INFO[type].name}</button>`).join('')}</div>
      </div>
      <div class="action-block">
        <h3>盲预留</h3>
        <button ${reserveFull || !hasLevel1Reservable || !canInteract ? 'disabled' : ''} data-blind-reserve="1">盲预留一级牌</button>
        <button ${reserveFull || !hasLevel2Reservable || !canInteract ? 'disabled' : ''} data-blind-reserve="2">盲预留二级牌</button>
      </div>
    </section>
  `;
}


function renderMarket() {
  return `
    <section class="market">
      ${renderMarketLevel(2, '复杂事件（二级）')}
      ${renderMarketLevel(1, '简单事件（一级）')}
    </section>
  `;
}

function renderMarketLevel(level, title) {
  const key = level === 1 ? 'level1' : 'level2';
  return `
    <div class="panel">
      <h2>${title}</h2>
      <div class="cards">${game.market[key].map((card) => renderCard(card, { source: 'market', level })).join('')}</div>
    </div>
  `;
}

function renderReserved() {
  const player = getCurrentPlayer(game);
  return `
    <section class="panel">
      <h2>${escapeHtml(player.name)} 的预留卡</h2>
      <div class="cards reserved-cards">${player.reservedCards.length ? player.reservedCards.map((card) => renderCard(card, { source: 'reserved' })).join('') : '<p class="muted">暂无预留卡</p>'}</div>
    </section>
  `;
}

function renderCard(card, { source, level } = {}) {
  const player = game ? getCurrentPlayer(game) : null;
  const canInteract = !isOnline() || isOnlineActionTurn();
  const affordable = player && game.phase === 'player_action' && canBuyCard(player, card);
  const purchasable = affordable && canInteract;
  const options = player ? getPaymentOptions(player, card) : [];
  const attr = card.attribute ? TASK_INFO[card.attribute].name : '无属性';
  const attrKey = card.attribute || 'none';
  const reservable = Boolean(card.attribute);
  const reserveDisabled = game.phase !== 'player_action' || getCurrentPlayer(game).reservedCards.length >= RESERVE_LIMIT || !reservable || !canInteract;
  return `
    <article class="card level-${card.level} attr-${attrKey} ${affordable ? 'can-buy' : ''}">
      <div class="card-top">
        <strong>${escapeHtml(card.name)}</strong>
        <span>+${card.happiness || 0}</span>
      </div>
      <p>等级 ${card.level} · 属性：${attributeBadge(card.attribute, attr)}</p>
      <p class="cost-line">成本：${renderCostBadges(card)}</p>
      <p class="muted">${affordable ? options[0]?.label || '可赢取' : '当前不可赢取'}</p>
      <div class="card-actions">
        <button ${!purchasable ? 'disabled' : ''} data-buy="${card.instanceId}">赢取</button>
        ${source === 'market' ? `<button ${reserveDisabled ? 'disabled' : ''} title="${reservable ? '预留该发展卡' : '无属性发展卡不能预留'}" data-reserve="${card.instanceId}" data-level="${level}">${reservable ? '预留' : '不可预留'}</button>` : ''}
      </div>
    </article>
  `;
}
function attributeBadge(type, label) {
  const key = type || 'none';
  return `<span class="cost-badge attr-chip cost-${key}">${escapeHtml(label)}</span>`;
}

function renderCostBadges(card) {
  if (card.flexCost?.type === 'abc-total') {
    return `<span class="cost-badges"><span class="cost-badge cost-a">学习</span><span class="cost-badge cost-b">科研</span><span class="cost-badge cost-c">学工</span><span class="cost-note">合计 ${card.flexCost.amount}</span></span>`;
  }
  if (card.flexCost?.type === 'same-kind') {
    return `<span class="cost-badges"><span class="cost-badge cost-any">任意同种</span><span class="cost-note">合计 ${card.flexCost.amount}</span></span>`;
  }
  const badges = TASK_TYPES
    .filter((type) => card.cost?.[type])
    .map((type) => `<span class="cost-badge cost-${type}">${TASK_INFO[type].name}<b>${card.cost[type]}</b></span>`);
  return badges.length ? `<span class="cost-badges">${badges.join('')}</span>` : '<span class="cost-badges"><span class="cost-badge cost-none">无</span></span>';
}

function renderLog() {
  return `
    <section class="panel log-panel">
      <h2>日志</h2>
      <ol>${game.log.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ol>
    </section>
  `;
}


function renderRulesModal() {
  if (!rulesOpen) return '';
  return `
    <div class="rules-overlay" id="rulesOverlay" role="dialog" aria-modal="true" aria-labelledby="rulesTitle">
      <article class="rules-modal">
        <button class="rules-close" id="rulesCloseBtn" aria-label="\u5173\u95ed\u89c4\u5219\u4ecb\u7ecd">\u00d7</button>
        <header class="rules-modal-header">
          <p class="rules-kicker">\u65b0\u624b\u5feb\u901f\u4e0a\u624b</p>
          <h2 id="rulesTitle">\u89c4\u5219\u4ecb\u7ecd</h2>
          <p>\u8fd9\u662f\u4e00\u6b3e\u4ee5\u300a\u7480\u74a8\u5b9d\u77f3\u300b\u4e3a\u6838\u5fc3\u7684\u5927\u5b66\u4e3b\u9898\u5361\u724c\u6e38\u620f\uff1a\u6536\u96c6\u4efb\u52a1\u5361\uff0c\u8d62\u53d6\u53d1\u5c55\u5361\uff0c\u7d2f\u79ef\u5f00\u5fc3\u503c\u3002</p>
        </header>
        <div class="rules-content">
          <section>
            <h3>1. \u6e38\u620f\u76ee\u6807</h3>
            <p>\u73a9\u5bb6\u8f6e\u6d41\u884c\u52a8\uff0c\u901a\u8fc7\u8d62\u53d6\u53d1\u5c55\u5361\u83b7\u5f97\u5f00\u5fc3\u503c\u3002\u4efb\u4e00\u73a9\u5bb6\u8fbe\u5230 <strong>15 \u5f00\u5fc3\u503c</strong> \u540e\u89e6\u53d1\u7ec8\u5c40\uff0c\u8865\u9f50\u5230\u6bcf\u4f4d\u73a9\u5bb6\u884c\u52a8\u6b21\u6570\u76f8\u540c\u540e\u7ed3\u7b97\u3002</p>
          </section>
          <section>
            <h3>2. \u8d44\u6e90\u4e0e\u5c5e\u6027</h3>
            <p>\u4efb\u52a1\u5361\u6709 5 \u79cd\uff1a\u5b66\u4e60 a\u3001\u79d1\u7814 b\u3001\u5b66\u5de5 c\u3001\u793e\u4ea4 d\u3001\u5a31\u4e50 e\u3002\u4e07\u80fd\u5361\u53ef\u4ee5\u4ee3\u66ff\u4efb\u610f\u4e00\u79cd\u4efb\u52a1\u5361\u652f\u4ed8\u6210\u672c\u3002</p>
            <div class="rules-token-row">${TASK_TYPES.map((type) => tokenBadge(type, TASK_INFO[type].name, true)).join('')}${tokenBadge('wild', TASK_INFO.wild.name, true)}</div>
          </section>
          <section>
            <h3>3. \u6bcf\u56de\u5408\u53ea\u80fd\u505a 1 \u4e2a\u4e3b\u52a8\u4f5c</h3>
            <ul>
              <li><strong>\u62ff 3 \u4e0d\u540c</strong>\uff1a\u4ece\u4f9b\u5e94\u4e2d\u62ff 3 \u79cd\u4e0d\u540c\u666e\u901a\u4efb\u52a1\u5361\u3002</li>
              <li><strong>\u62ff 2 \u76f8\u540c</strong>\uff1a\u67d0\u79cd\u666e\u901a\u4efb\u52a1\u5361\u4f9b\u5e94\u81f3\u5c11 4 \u5f20\u65f6\uff0c\u53ef\u62ff\u8be5\u79cd 2 \u5f20\u3002</li>
              <li><strong>\u9884\u7559\u53d1\u5c55\u5361</strong>\uff1a\u53ef\u9884\u7559\u4e00\u5f20\u6709\u5c5e\u6027\u53d1\u5c55\u5361\u6216\u76f2\u9884\u7559\u724c\u5e93\u4e2d\u7684\u6709\u5c5e\u6027\u5361\uff0c\u6700\u591a 3 \u5f20\uff1b\u82e5\u4e07\u80fd\u5361\u6709\u4f9b\u5e94\uff0c\u9884\u7559\u65f6\u83b7\u5f97 1 \u5f20\u4e07\u80fd\u5361\u3002</li>
              <li><strong>\u8d62\u53d6\u53d1\u5c55\u5361</strong>\uff1a\u652f\u4ed8\u6210\u672c\uff0c\u8d62\u53d6\u5e02\u573a\u6216\u81ea\u5df1\u9884\u7559\u533a\u7684 1 \u5f20\u53d1\u5c55\u5361\u3002</li>
            </ul>
          </section>
          <section>
            <h3>4. \u53d1\u5c55\u5361\u548c\u6298\u6263</h3>
            <p>\u53d1\u5c55\u5361\u662f\u4e3b\u8981\u7684\u5f97\u5206\u548c\u6298\u6263\u6765\u6e90\uff0c\u724c\u9762\u4e0a\u4f1a\u663e\u793a\u300c\u5c5e\u6027\u300d\u3001\u300c\u6210\u672c\u300d\u548c\u300c\u5f00\u5fc3\u503c\u300d\u3002</p>
            <ul>
              <li><strong>\u6210\u672c</strong>\uff1a\u8868\u793a\u8d62\u53d6\u8fd9\u5f20\u5361\u9700\u8981\u652f\u4ed8\u7684\u4efb\u52a1\u5361\u6570\u91cf\u3002\u4f8b\u5982\u6210\u672c\u5199\u7740\u300c\u5b66\u4e60 2\u3001\u793e\u4ea4 1\u300d\uff0c\u5c31\u9700\u8981\u4ea4\u56de 2 \u5f20\u5b66\u4e60\u548c 1 \u5f20\u793e\u4ea4\u4efb\u52a1\u5361\u3002</li>
              <li><strong>\u5f00\u5fc3\u503c</strong>\uff1a\u5361\u724c\u53f3\u4e0a\u89d2\u7684\u6570\u5b57\u662f\u8fd9\u5f20\u5361\u63d0\u4f9b\u7684\u5f00\u5fc3\u503c\u3002\u8d62\u53d6\u540e\u7acb\u5373\u52a0\u5230\u73a9\u5bb6\u603b\u5f00\u5fc3\u503c\uff0c\u7528\u4e8e\u89e6\u53d1 15 \u5f00\u5fc3\u503c\u7ec8\u5c40\u548c\u6700\u7ec8\u80dc\u8d1f\u7ed3\u7b97\u3002\u6ca1\u6709\u6570\u5b57\u6216\u4e3a 0 \u5219\u4e0d\u52a0\u5206\u3002</li>
              <li><strong>\u6298\u6263</strong>\uff1a\u6709\u5c5e\u6027\u53d1\u5c55\u5361\u8d62\u53d6\u540e\u4f1a\u6210\u4e3a\u6c38\u4e45\u5c5e\u6027\uff0c\u4eca\u540e\u652f\u4ed8\u5bf9\u5e94\u5c5e\u6027\u6210\u672c\u65f6\uff0c\u6bcf\u5f20\u53ef\u62b5\u6263 1 \u70b9\u3002\u4e07\u80fd\u5361\u53ef\u5728\u6298\u6263\u540e\u8865\u8db3\u4efb\u610f\u4e00\u79cd\u4e0d\u591f\u7684\u6210\u672c\u3002</li>
              <li><strong>\u65e0\u5c5e\u6027\u5361</strong>\uff1a\u53ef\u4ee5\u8d62\u53d6\u5e76\u83b7\u5f97\u724c\u9762\u5f00\u5fc3\u503c\uff0c\u4f46\u4e0d\u63d0\u4f9b\u6c38\u4e45\u5c5e\u6027\uff0c\u4e5f\u4e0d\u80fd\u9884\u7559\u3002</li>
            </ul>
          </section>
          <section>
            <h3>5. \u7279\u6b8a\u6210\u672c</h3>
            <ul>
              <li><strong>\u4fdd\u7814\u4e0a\u5cb8</strong>\uff1a\u5b66\u4e60/\u79d1\u7814/\u5b66\u5de5\u5408\u8ba1 15\uff0c\u4eab\u53d7 a/b/c \u6c38\u4e45\u5c5e\u6027\u603b\u6298\u6263\u3002</li>
              <li><strong>\u5bbf\u820d\u9886\u8896</strong>\uff1a\u9009\u62e9\u4efb\u610f\u4e00\u79cd\u666e\u901a\u4efb\u52a1\u5361\u5408\u8ba1 8\uff0c\u4eab\u53d7\u6240\u9009\u5c5e\u6027\u6298\u6263\uff0c\u53ef\u7528\u4e07\u80fd\u5361\u8865\u8db3\u3002</li>
              <li><strong>\u4e30\u5bcc\u751f\u6d3b</strong>\uff1a\u6309\u56fa\u5b9a\u6210\u672c\u652f\u4ed8\uff1a\u5b66\u4e60 3\u3001\u79d1\u7814 3\u3001\u5b66\u5de5 3\u3001\u793e\u4ea4 3\u3001\u5a31\u4e50 3\u3002</li>
            </ul>
          </section>
          <section>
            <h3>6. \u673a\u9047\u5361\uff08\u5f3a\u5236\u6267\u884c\uff09</h3>
            <p>\u6bcf\u6b21\u8d62\u53d6\u5f00\u5fc3\u503c\u5927\u4e8e 0 \u7684\u53d1\u5c55\u5361\u540e\uff0c\u7a0b\u5e8f\u4f1a\u5f3a\u5236\u6267\u884c 1 \u5f20\u673a\u9047\u5361\u3002\u673a\u9047\u5361\u4ece\u5b8c\u6574 5 \u5f20\u5361\u6c60\u4e2d\u6709\u653e\u56de\u968f\u673a\u62bd\u53d6\uff0c\u5176\u4e2d\u300c\u4f18\u5e72\u7b54\u8fa9\u300d\u6709 2 \u5f20\u3002</p>
            <p>\u7ed3\u7b97\u65f6\u6bd4\u8f83\u673a\u9047\u5361\u5bf9\u5e94\u5c5e\u6027\u7684\u6c38\u4e45\u6570\u91cf\uff1a\u82e5\u6709\u552f\u4e00\u6700\u591a\u8005\uff0c\u8be5\u73a9\u5bb6\u83b7\u5f97\u6700\u591a 2 \u5f20\u5bf9\u5e94\u4efb\u52a1\u5361\uff1b\u82e5\u5e76\u5217\u6700\u591a\uff0c\u5219\u65e0\u4eba\u83b7\u5f97\u5956\u52b1\u3002</p>
          </section>
          <section>
            <h3>7. \u8d44\u6e90\u4e0a\u9650\u4e0e\u80dc\u8d1f</h3>
            <p>\u4efb\u610f\u73a9\u5bb6\u5728\u56de\u5408\u7ed3\u7b97\u4e2d\u8d44\u6e90\u8d85\u8fc7 10 \u5f20\u65f6\uff0c\u5fc5\u987b\u5f03\u8fd8\u5230 10 \u5f20\u624d\u80fd\u7ee7\u7eed\u3002\u7ec8\u5c40\u65f6\u5f00\u5fc3\u503c\u6700\u9ad8\u8005\u83b7\u80dc\uff1b\u82e5\u5e76\u5217\uff0c\u5df2\u8d62\u53d6\u53d1\u5c55\u5361\u66f4\u5c11\u8005\u80dc\u3002</p>
          </section>
        </div>
      </article>
    </div>
  `;
}

function renderGameOver() {
  if (!game || game.phase !== 'game_over' || gameOverDismissed) return '';
  const ranking = [...game.players].sort((a, b) => b.happiness - a.happiness || a.ownedCards.length - b.ownedCards.length);
  const winnerNames = game.winners.map((p) => escapeHtml(p.name)).join('、');
  return `
    <div class="game-over-overlay" role="dialog" aria-modal="true" aria-labelledby="gameOverTitle">
      <article class="game-over-card">
        <p class="game-over-kicker">终局结算</p>
        <h2 id="gameOverTitle">游戏结束</h2>
        <p class="game-over-winner">胜者：<strong>${winnerNames}</strong></p>
        <ol class="game-over-ranking">
          ${ranking.map((p, index) => `
            <li class="${game.winners.some((winner) => winner.id === p.id) ? 'winner' : ''}">
              <span class="rank-medal">${index + 1}</span>
              <span class="rank-name">${escapeHtml(p.name)}</span>
              <span class="rank-score">${p.happiness} 开心值</span>
              <span class="rank-cards">${p.ownedCards.length} 张发展卡</span>
            </li>
          `).join('')}
        </ol>
        <div class="game-over-actions">
          <button class="primary" id="gameOverResetBtn">重新开始</button>
          <button id="gameOverCloseBtn">查看棋盘</button>
        </div>
      </article>
    </div>
  `;
}

function bindRulesEvents() {
  document.querySelector('#rulesBtn')?.addEventListener('click', () => {
    rulesOpen = true;
    render();
  });
  document.querySelector('#rulesCloseBtn')?.addEventListener('click', () => {
    rulesOpen = false;
    render();
  });
  document.querySelector('#rulesOverlay')?.addEventListener('click', (event) => {
    if (event.target.id === 'rulesOverlay') {
      rulesOpen = false;
      render();
    }
  });
}

function bindEvents() {
  bindRulesEvents();
  document.querySelector('#saveBtn')?.addEventListener('click', () => {
    save();
    lastError = '已保存到浏览器本地存储。';
    render();
  });
  document.querySelector('#resetBtn')?.addEventListener('click', resetGame);
  document.querySelector('#leaveOnlineBtn')?.addEventListener('click', leaveOnlineRoom);
  document.querySelector('#startOnlineBtn')?.addEventListener('click', startOnlineRoom);
  document.querySelector('#copyRoomBtn')?.addEventListener('click', async () => {
    const text = `${location.origin}${location.pathname} 房间号：${online?.room?.id || online?.roomId || ''}`;
    await navigator.clipboard?.writeText(text).catch(() => {});
    lastError = '已复制房间信息。';
    render();
  });
  document.querySelector('#gameOverResetBtn')?.addEventListener('click', resetGame);
  document.querySelector('#gameOverCloseBtn')?.addEventListener('click', () => {
    gameOverDismissed = true;
    render();
  });
  document.querySelectorAll('[data-toggle-different]').forEach((btn) => btn.addEventListener('click', () => {
    const type = btn.dataset.toggleDifferent;
    if (selectedDifferent.has(type)) selectedDifferent.delete(type);
    else selectedDifferent.add(type);
    render();
  }));
  document.querySelector('[data-action="takeDifferent"]')?.addEventListener('click', () => runAction(
    () => takeDifferent(game, [...selectedDifferent]),
    { type: 'takeDifferent', payload: { types: [...selectedDifferent] } },
  ));
  document.querySelectorAll('[data-take-same]').forEach((btn) => btn.addEventListener('click', () => runAction(
    () => takeSame(game, btn.dataset.takeSame),
    { type: 'takeSame', payload: { tokenType: btn.dataset.takeSame } },
  )));
  document.querySelectorAll('[data-reserve]').forEach((btn) => btn.addEventListener('click', () => runAction(
    () => reserveMarketCard(game, Number(btn.dataset.level), btn.dataset.reserve),
    { type: 'reserveMarket', payload: { level: Number(btn.dataset.level), instanceId: btn.dataset.reserve } },
  )));
  document.querySelectorAll('[data-blind-reserve]').forEach((btn) => btn.addEventListener('click', () => runAction(
    () => reserveBlindCard(game, Number(btn.dataset.blindReserve)),
    { type: 'reserveBlind', payload: { level: Number(btn.dataset.blindReserve) } },
  )));
  document.querySelectorAll('[data-buy]').forEach((btn) => btn.addEventListener('click', () => runAction(
    () => {
      const purchase = buyCard(game, btn.dataset.buy, 0);
      const draw = purchase?.opportunity;
      const message = draw?.result?.message || '';
      if (draw?.card && message) showOpportunityAnimation(draw.card, message);
    },
    { type: 'buyCard', payload: { instanceId: btn.dataset.buy, optionIndex: 0 } },
  )));
  document.querySelectorAll('[data-discard]').forEach((btn) => btn.addEventListener('click', () => runAction(
    () => discardToken(game, btn.dataset.discard),
    { type: 'discardToken', payload: { tokenType: btn.dataset.discard } },
  )));
}


function tokenBadge(type, count, small) {
  return `<span class="token ${small ? 'small' : ''}" style="--token-color:${TASK_INFO[type].color}" title="${TASK_INFO[type].name}">${TASK_INFO[type].short}<b>${count || 0}</b></span>`;
}

function phaseText(phase) {
  return {
    player_action: '主动作',
    opportunity_choice: '机遇选择',
    discard_tokens: '弃还资源',
    game_over: '游戏结束',
  }[phase] || phase;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}

if (online?.roomId) reconnectOnlineSession();
else render();
