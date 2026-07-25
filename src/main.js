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
  opportunityAnimation = null;
  gameOverDismissed = false;
  rulesOpen = false;
  selectedDifferent.clear();
  save();
  render();
}

function resetGame() {
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
  if (!game) {
    renderSetup();
    return;
  }
  const current = getCurrentPlayer(game);
  app.innerHTML = `
    ${renderRulesModal()}
    ${renderGameOver()}
    ${renderOpportunityAnimation()}
    <header class="hero">
      <div>
        <h1>璀璨宝石之大学模拟器</h1>
        <p>本地多人 ${GAME_VERSION} · 每回合四选一 · 15 开心值触发终局</p>
      </div>
      <div class="header-actions">
        <button id="rulesBtn">\u89c4\u5219\u4ecb\u7ecd</button>
        <button id="saveBtn">保存进度</button>
        <button class="danger" id="resetBtn">重新开始</button>
      </div>
    </header>

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
      <button id="rulesBtn">\u89c4\u5219\u4ecb\u7ecd</button>
    </div>
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
  bindRulesEvents();
  document.querySelector('#continueBtn')?.addEventListener('click', () => {
    game = saved;
    opportunityAnimation = null;
    gameOverDismissed = false;
    render();
  });
  updateFields();
  updateFirst();
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
  const currentPlayer = getCurrentPlayer(game);
  const reserveFull = currentPlayer.reservedCards.length >= RESERVE_LIMIT;
  const hasLevel1Reservable = game.decks.level1.some((card) => card.attribute);
  const hasLevel2Reservable = game.decks.level2.some((card) => card.attribute);
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
        <button ${reserveFull || !hasLevel1Reservable ? 'disabled' : ''} data-blind-reserve="1">盲预留一级牌</button>
        <button ${reserveFull || !hasLevel2Reservable ? 'disabled' : ''} data-blind-reserve="2">盲预留二级牌</button>
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
  const attrKey = card.attribute || 'none';
  const reservable = Boolean(card.attribute);
  const reserveDisabled = game.phase !== 'player_action' || getCurrentPlayer(game).reservedCards.length >= RESERVE_LIMIT || !reservable;
  return `
    <article class="card level-${card.level} attr-${attrKey} ${purchasable ? 'can-buy' : ''}">
      <div class="card-top">
        <strong>${escapeHtml(card.name)}</strong>
        <span>+${card.happiness || 0}</span>
      </div>
      <p>等级 ${card.level} · 属性：${attributeBadge(card.attribute, attr)}</p>
      <p class="cost-line">成本：${renderCostBadges(card)}</p>
      <p class="muted">${purchasable ? options[0]?.label || '可赢取' : '当前不可赢取'}</p>
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
            <p>\u6709\u5c5e\u6027\u53d1\u5c55\u5361\u8d62\u53d6\u540e\u4f1a\u6210\u4e3a\u6c38\u4e45\u5c5e\u6027\uff0c\u4eca\u540e\u652f\u4ed8\u5bf9\u5e94\u5c5e\u6027\u6210\u672c\u65f6\uff0c\u6bcf\u5f20\u53ef\u62b5\u6263 1 \u70b9\u3002\u65e0\u5c5e\u6027\u53d1\u5c55\u5361\u53ef\u8d62\u53d6\uff0c\u4f46\u4e0d\u63d0\u4f9b\u6c38\u4e45\u5c5e\u6027\uff0c\u4e5f\u4e0d\u80fd\u9884\u7559\u3002</p>
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
  document.querySelector('[data-action="takeDifferent"]')?.addEventListener('click', () => runAction(() => takeDifferent(game, [...selectedDifferent])));
  document.querySelectorAll('[data-take-same]').forEach((btn) => btn.addEventListener('click', () => runAction(() => takeSame(game, btn.dataset.takeSame))));
  document.querySelectorAll('[data-reserve]').forEach((btn) => btn.addEventListener('click', () => runAction(() => reserveMarketCard(game, Number(btn.dataset.level), btn.dataset.reserve))));
  document.querySelectorAll('[data-blind-reserve]').forEach((btn) => btn.addEventListener('click', () => runAction(() => reserveBlindCard(game, Number(btn.dataset.blindReserve)))));
  document.querySelectorAll('[data-buy]').forEach((btn) => btn.addEventListener('click', () => runAction(() => {
    const purchase = buyCard(game, btn.dataset.buy, 0);
    const draw = purchase?.opportunity;
    const message = draw?.result?.message || '';
    if (draw?.card && message) showOpportunityAnimation(draw.card, message);
  })));
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
