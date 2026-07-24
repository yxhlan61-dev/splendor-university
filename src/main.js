import {
  buyCard,
  canBuyCard,
  createGame,
  discardToken,
  drawOpportunity,
  findCardLocation,
  formatCost,
  formatTokens,
  getCurrentPlayer,
  getPaymentOptions,
  getPermanentCounts,
  reserveBlindCard,
  reserveMarketCard,
  skipOpportunity,
  takeDifferent,
  takeSame,
  totalTokens,
} from './game.js';
import { GAME_VERSION, MARKET_SIZE, RESERVE_LIMIT, TASK_INFO, TASK_TYPES, TOKEN_LIMIT, TOKEN_TYPES } from './data.js';

let game = null;
let selectedDifferent = new Set();
let lastError = '';

const app = document.querySelector('#app');

function save() {
  if (game) localStorage.setItem('universitySplendorGame', JSON.stringify(game));
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

function runAction(fn) {
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
  selectedDifferent.clear();
  save();
  render();
}

function resetGame() {
  if (!confirm('确定要重新开始并清除当前进度吗？')) return;
  game = null;
  localStorage.removeItem('universitySplendorGame');
  selectedDifferent.clear();
  render();
}

function render() {
  if (!game) {
    renderSetup();
    return;
  }
  const current = getCurrentPlayer(game);
  app.innerHTML = `
    <header class="hero">
      <div>
        <h1>璀璨宝石之大学模拟器</h1>
        <p>本地多人 ${GAME_VERSION} · 每回合四选一 · 15 开心值触发终局</p>
      </div>
      <div class="header-actions">
        <button id="saveBtn">保存进度</button>
        <button class="danger" id="resetBtn">重新开始</button>
      </div>
    </header>

    ${lastError ? `<div class="toast error">${escapeHtml(lastError)}</div>` : ''}
    ${game.phase === 'game_over' ? renderGameOver() : ''}

    <main class="dashboard">
      <section class="status-grid">
        <div class="panel current">
          <h2>当前回合</h2>
          <p class="big">${escapeHtml(current.name)}</p>
          <p>阶段：${phaseText(game.phase)} · 第 ${game.roundNumber} 轮 · ${game.endgameTriggered ? `终局：${game.endgameTriggeredBy}` : '未终局'}</p>
        </div>
        <div class="panel">
          <h2>公共供应</h2>
          <div class="tokens">${TOKEN_TYPES.map((t) => tokenBadge(t, game.supply[t], false)).join('')}</div>
        </div>
        <div class="panel">
          <h2>牌库</h2>
          <p>一级 ${game.decks.level1.length} · 二级 ${game.decks.level2.length} · 机遇 ${game.decks.opportunity.length} · 弃牌 ${game.discard.opportunity.length}</p>
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
    <main class="setup">
      <div class="setup-card">
        <h1>璀璨宝石之大学模拟器</h1>
        <p>第一版程序：本地 2-4 人轮流游玩。</p>
        ${saved ? '<button id="continueBtn" class="primary wide">继续上次进度</button>' : ''}
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
          <button class="primary wide" type="submit">开始新游戏</button>
        </form>
      </div>
    </main>
  `;
  const playerCount = document.querySelector('#playerCount');
  const firstMode = document.querySelector('#firstMode');
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
  document.querySelector('#setupForm').addEventListener('submit', startGame);
  document.querySelector('#continueBtn')?.addEventListener('click', () => {
    game = saved;
    render();
  });
  updateFields();
  updateFirst();
}

function renderPlayers() {
  return `<section class="players">${game.players.map((player, index) => {
    const permanent = getPermanentCounts(player);
    return `
      <article class="panel player ${index === game.currentPlayerIndex ? 'active' : ''}">
        <h2>${escapeHtml(player.name)} ${index === game.currentPlayerIndex ? '<span>当前</span>' : ''}</h2>
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
  if (game.phase === 'opportunity_choice') {
    return `
      <section class="panel action-panel highlight">
        <h2>机遇卡选择</h2>
        <p>${escapeHtml(getCurrentPlayer(game).name)} 刚获得开心值，可以选择是否翻开 1 张机遇卡。</p>
        <button class="primary" data-action="drawOpportunity">翻开机遇卡</button>
        <button data-action="skipOpportunity">不翻开</button>
      </section>
    `;
  }
  if (game.phase === 'discard_tokens') {
    const player = game.players[game.pendingDiscardPlayerIndex];
    return `
      <section class="panel action-panel highlight">
        <h2>强制弃还资源</h2>
        <p>${escapeHtml(player.name)} 当前资源 ${totalTokens(player.tokens)}/${TOKEN_LIMIT}，请弃还到 ${TOKEN_LIMIT} 张。</p>
        <div class="button-row">${TOKEN_TYPES.map((type) => `<button ${player.tokens[type] <= 0 ? 'disabled' : ''} data-discard="${type}">弃还${TASK_INFO[type].name}</button>`).join('')}</div>
      </section>
    `;
  }
  return `
    <section class="panel action-panel">
      <h2>主动作</h2>
      <div class="action-block">
        <h3>拿 3 不同</h3>
        <div class="button-row">${TASK_TYPES.map((type) => `<button class="select-token ${selectedDifferent.has(type) ? 'selected' : ''}" ${game.supply[type] <= 0 ? 'disabled' : ''} data-toggle-different="${type}">${TASK_INFO[type].name}</button>`).join('')}</div>
        <button class="primary" data-action="takeDifferent">拿所选</button>
      </div>
      <div class="action-block">
        <h3>拿 2 相同</h3>
        <div class="button-row">${TASK_TYPES.map((type) => `<button ${game.supply[type] < 4 ? 'disabled' : ''} data-take-same="${type}">2${TASK_INFO[type].name}</button>`).join('')}</div>
      </div>
      <div class="action-block">
        <h3>盲预留</h3>
        <button ${getCurrentPlayer(game).reservedCards.length >= RESERVE_LIMIT || game.decks.level1.length === 0 ? 'disabled' : ''} data-blind-reserve="1">盲预留一级牌</button>
        <button ${getCurrentPlayer(game).reservedCards.length >= RESERVE_LIMIT || game.decks.level2.length === 0 ? 'disabled' : ''} data-blind-reserve="2">盲预留二级牌</button>
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
  const purchasable = player && game.phase === 'player_action' && canBuyCard(player, card);
  const options = player ? getPaymentOptions(player, card) : [];
  const attr = card.attribute ? TASK_INFO[card.attribute].name : '无属性';
  return `
    <article class="card level-${card.level} ${purchasable ? 'can-buy' : ''}">
      <div class="card-top">
        <strong>${escapeHtml(card.name)}</strong>
        <span>+${card.happiness || 0}</span>
      </div>
      <p>等级 ${card.level} · 属性：${attr}</p>
      <p>成本：${formatCost(card)}</p>
      <p class="muted">${purchasable ? options[0]?.label || '可赢取' : '当前不可赢取'}</p>
      <div class="card-actions">
        <button ${!purchasable ? 'disabled' : ''} data-buy="${card.instanceId}">赢取</button>
        ${source === 'market' ? `<button ${game.phase !== 'player_action' || getCurrentPlayer(game).reservedCards.length >= RESERVE_LIMIT ? 'disabled' : ''} data-reserve="${card.instanceId}" data-level="${level}">预留</button>` : ''}
      </div>
    </article>
  `;
}

function renderLog() {
  return `
    <section class="panel log-panel">
      <h2>日志</h2>
      <ol>${game.log.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ol>
    </section>
  `;
}

function renderGameOver() {
  return `
    <section class="panel game-over">
      <h2>游戏结束</h2>
      <p>胜者：${game.winners.map((p) => escapeHtml(p.name)).join('、')}</p>
      <ol>${[...game.players].sort((a, b) => b.happiness - a.happiness || a.ownedCards.length - b.ownedCards.length).map((p) => `<li>${escapeHtml(p.name)}：${p.happiness} 开心值，已赢取 ${p.ownedCards.length} 张</li>`).join('')}</ol>
    </section>
  `;
}

function bindEvents() {
  document.querySelector('#saveBtn')?.addEventListener('click', () => {
    save();
    lastError = '已保存到浏览器本地存储。';
    render();
  });
  document.querySelector('#resetBtn')?.addEventListener('click', resetGame);
  document.querySelectorAll('[data-toggle-different]').forEach((btn) => btn.addEventListener('click', () => {
    const type = btn.dataset.toggleDifferent;
    if (selectedDifferent.has(type)) selectedDifferent.delete(type);
    else selectedDifferent.add(type);
    render();
  }));
  document.querySelector('[data-action="takeDifferent"]')?.addEventListener('click', () => runAction(() => takeDifferent(game, [...selectedDifferent])));
  document.querySelectorAll('[data-take-same]').forEach((btn) => btn.addEventListener('click', () => runAction(() => takeSame(game, btn.dataset.takeSame))));
  document.querySelectorAll('[data-reserve]').forEach((btn) => btn.addEventListener('click', () => runAction(() => reserveMarketCard(game, Number(btn.dataset.level), btn.dataset.reserve))));
  document.querySelectorAll('[data-blind-reserve]').forEach((btn) => btn.addEventListener('click', () => runAction(() => reserveBlindCard(game, Number(btn.dataset.blindReserve)))));
  document.querySelectorAll('[data-buy]').forEach((btn) => btn.addEventListener('click', () => runAction(() => buyCard(game, btn.dataset.buy, 0))));
  document.querySelector('[data-action="drawOpportunity"]')?.addEventListener('click', () => runAction(() => drawOpportunity(game)));
  document.querySelector('[data-action="skipOpportunity"]')?.addEventListener('click', () => runAction(() => skipOpportunity(game)));
  document.querySelectorAll('[data-discard]').forEach((btn) => btn.addEventListener('click', () => runAction(() => discardToken(game, btn.dataset.discard))));
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

render();
