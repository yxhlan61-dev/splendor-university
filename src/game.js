import {
  GAME_VERSION,
  LEVEL1_TEMPLATES,
  LEVEL2_TEMPLATES,
  MARKET_SIZE,
  OPPORTUNITY_TEMPLATES,
  RESERVE_LIMIT,
  TASK_INFO,
  TASK_TYPES,
  TOKEN_LIMIT,
  TOKEN_SUPPLY_BY_PLAYERS,
  TOKEN_TYPES,
  WINNING_HAPPINESS,
} from './data.js';

export function emptyTokens(value = 0) {
  return { a: value, b: value, c: value, d: value, e: value, wild: value };
}

export function cloneTokens(tokens) {
  return { ...emptyTokens(), ...tokens };
}

export function totalTokens(tokens) {
  return TOKEN_TYPES.reduce((sum, type) => sum + (tokens[type] || 0), 0);
}

export function shuffle(array, rng = Math.random) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function createOpportunityDeck(cycle = 0) {
  const cards = [];
  for (const template of OPPORTUNITY_TEMPLATES) {
    const copies = template.copies ?? 1;
    for (let i = 1; i <= copies; i += 1) {
      cards.push({
        ...template,
        instanceId: `${template.id}_cycle${cycle}_${String(i).padStart(2, '0')}`,
        templateId: template.id,
      });
    }
  }
  return cards;
}

function opportunityPoolMatchesTemplates(pool = []) {
  const expected = OPPORTUNITY_TEMPLATES.flatMap((template) => Array(template.copies ?? 1).fill(template.id)).sort();
  const actual = pool.map((card) => card.templateId || card.id).sort();
  return actual.length === expected.length && actual.every((id, index) => id === expected[index]);
}

function getOpportunityPool(game) {
  if (!opportunityPoolMatchesTemplates(game.decks.opportunity)) {
    game.opportunityCycle = game.opportunityCycle || 0;
    game.decks.opportunity = createOpportunityDeck(game.opportunityCycle);
  }
  return game.decks.opportunity;
}

function canReserveCard(card) {
  return Boolean(card?.attribute);
}

export function expandTemplates(templates, defaultCopies = 1, prefix) {
  const cards = [];
  for (const template of templates) {
    const copies = template.copies ?? defaultCopies;
    for (let i = 1; i <= copies; i += 1) {
      cards.push({
        ...template,
        cost: cloneCost(template.cost),
        instanceId: `${template.id}_${String(i).padStart(2, '0')}`,
        templateId: template.id,
        deckPrefix: prefix,
      });
    }
  }
  return cards;
}

function cloneCost(cost = {}) {
  return TASK_TYPES.reduce((acc, type) => {
    if (cost[type]) acc[type] = cost[type];
    return acc;
  }, {});
}

export function createGame({ playerCount = 2, playerNames = [], firstPlayerIndex = 0, rng = Math.random } = {}) {
  if (![2, 3, 4].includes(playerCount)) throw new Error('玩家人数必须为 2-4 人');
  const decks = {
    level1: shuffle(expandTemplates(LEVEL1_TEMPLATES, 1, 'level1'), rng),
    level2: shuffle(expandTemplates(LEVEL2_TEMPLATES, 1, 'level2'), rng),
    opportunity: createOpportunityDeck(0),
  };
  const game = {
    version: GAME_VERSION,
    phase: 'player_action',
    players: Array.from({ length: playerCount }, (_, i) => ({
      id: `P${i + 1}`,
      name: playerNames[i] || `玩家${i + 1}`,
      tokens: emptyTokens(),
      reservedCards: [],
      ownedCards: [],
      happiness: 0,
      turnsTaken: 0,
      active: true,
    })),
    currentPlayerIndex: firstPlayerIndex,
    firstPlayerIndex,
    supply: cloneTokens(TOKEN_SUPPLY_BY_PLAYERS[playerCount]),
    market: { level1: [], level2: [] },
    decks,
    discard: { opportunity: [] },
    endgameTriggered: false,
    endgameTriggeredBy: null,
    roundNumber: 1,
    log: [],
    pendingOpportunity: null,
    pendingDiscardPlayerIndex: null,
    opportunityCycle: 0,
    winners: [],
  };
  refillMarket(game, 1);
  refillMarket(game, 2);
  log(game, `游戏开始：${playerCount} 人局，${game.players[firstPlayerIndex].name} 先手。`);
  return game;
}

export function refillMarket(game, level) {
  const key = levelKey(level);
  while (game.market[key].length < MARKET_SIZE && game.decks[key].length > 0) {
    game.market[key].push(game.decks[key].shift());
  }
}

function levelKey(level) {
  return Number(level) === 1 ? 'level1' : 'level2';
}

export function getCurrentPlayer(game) {
  return game.players[game.currentPlayerIndex];
}

export function isPlayerActive(player) {
  return player?.active !== false;
}

export function getActivePlayers(game) {
  return game.players.filter((player) => isPlayerActive(player));
}

export function activePlayerCount(game) {
  return getActivePlayers(game).length;
}

export function getNextActivePlayerIndex(game, fromIndex = game.currentPlayerIndex) {
  const total = game.players.length;
  for (let step = 1; step <= total; step += 1) {
    const index = (fromIndex + step) % total;
    if (isPlayerActive(game.players[index])) return index;
  }
  return -1;
}

export function advanceToNextActivePlayer(game, fromIndex = game.currentPlayerIndex) {
  const nextIndex = getNextActivePlayerIndex(game, fromIndex);
  if (nextIndex < 0) {
    game.phase = 'game_over';
    game.winners = determineWinners(game);
    return -1;
  }
  if (nextIndex <= fromIndex) game.roundNumber += 1;
  game.currentPlayerIndex = nextIndex;
  game.phase = 'player_action';
  return nextIndex;
}

export function markPlayerInactive(game, playerIndex) {
  const player = game.players[playerIndex];
  if (!player || player.active === false) return false;
  player.active = false;
  player.leftAt = Date.now();
  return true;
}

export function getPermanentCounts(player) {
  const counts = { a: 0, b: 0, c: 0, d: 0, e: 0 };
  for (const card of player.ownedCards) {
    if (card.attribute) counts[card.attribute] += 1;
  }
  return counts;
}

export function formatTokens(tokens, includeZero = false) {
  return TOKEN_TYPES
    .filter((type) => includeZero || (tokens[type] || 0) > 0)
    .map((type) => `${TASK_INFO[type].name}${tokens[type] || 0}`)
    .join(' / ') || '无';
}

export function formatCost(card) {
  if (card.flexCost?.type === 'abc-total') return `学习/科研/学工合计 ${card.flexCost.amount}（享折扣）`;
  if (card.flexCost?.type === 'same-kind') return `任意同种 ${card.flexCost.amount}（可万能补足，享所选属性折扣）`;
  return TASK_TYPES.filter((type) => card.cost?.[type]).map((type) => `${TASK_INFO[type].name}${card.cost[type]}`).join(' / ') || '无';
}

export function validateTakeDifferent(game, types) {
  assertActionPhase(game);
  const unique = [...new Set(types)];
  const availableCount = TASK_TYPES.filter((type) => game.supply[type] > 0).length;
  const required = Math.min(3, availableCount);
  if (unique.length !== types.length) throw new Error('必须选择不同种类任务卡');
  if (unique.some((type) => !TASK_TYPES.includes(type))) throw new Error('只能选择普通任务卡，不能选择万能卡');
  if (unique.length !== required) throw new Error(`当前必须选择 ${required} 种不同任务卡`);
  for (const type of unique) {
    if (game.supply[type] <= 0) throw new Error(`${TASK_INFO[type].name}供应不足`);
  }
}

export function takeDifferent(game, types) {
  validateTakeDifferent(game, types);
  const player = getCurrentPlayer(game);
  for (const type of types) {
    game.supply[type] -= 1;
    player.tokens[type] += 1;
  }
  log(game, `${player.name} 拿取不同任务卡：${types.map((t) => TASK_INFO[t].name).join('、')}。`);
  finishMainAction(game);
}

export function validateTakeSame(game, type) {
  assertActionPhase(game);
  if (!TASK_TYPES.includes(type)) throw new Error('只能选择普通任务卡，不能选择万能卡');
  if (game.supply[type] < 4) throw new Error(`${TASK_INFO[type].name}供应少于 4，不能拿 2 张相同任务卡`);
}

export function takeSame(game, type) {
  validateTakeSame(game, type);
  const player = getCurrentPlayer(game);
  game.supply[type] -= 2;
  player.tokens[type] += 2;
  log(game, `${player.name} 拿取 2 张${TASK_INFO[type].name}。`);
  finishMainAction(game);
}

export function reserveMarketCard(game, level, instanceId) {
  assertActionPhase(game);
  const player = getCurrentPlayer(game);
  if (player.reservedCards.length >= RESERVE_LIMIT) throw new Error('预留区已满，最多 3 张');
  const key = levelKey(level);
  const index = game.market[key].findIndex((card) => card.instanceId === instanceId);
  if (index < 0) throw new Error('目标卡不在市场中');
  const card = game.market[key][index];
  if (!canReserveCard(card)) throw new Error('无属性发展卡不能预留');
  game.market[key].splice(index, 1);
  player.reservedCards.push(card);
  if (game.supply.wild > 0) {
    game.supply.wild -= 1;
    player.tokens.wild += 1;
    log(game, `${player.name} 预留「${card.name}」并获得 1 张万能卡。`);
  } else {
    log(game, `${player.name} 预留「${card.name}」，万能卡供应为空。`);
  }
  refillMarket(game, level);
  finishMainAction(game);
}

export function reserveBlindCard(game, level) {
  assertActionPhase(game);
  const player = getCurrentPlayer(game);
  if (player.reservedCards.length >= RESERVE_LIMIT) throw new Error('预留区已满，最多 3 张');
  const key = levelKey(level);
  if (game.decks[key].length === 0) throw new Error('目标牌库已空');
  const index = game.decks[key].findIndex(canReserveCard);
  if (index < 0) throw new Error('目标牌库中没有可预留的发展卡');
  const [card] = game.decks[key].splice(index, 1);
  player.reservedCards.push(card);
  if (game.supply.wild > 0) {
    game.supply.wild -= 1;
    player.tokens.wild += 1;
    log(game, `${player.name} 盲预留 ${level} 级牌并获得 1 张万能卡。`);
  } else {
    log(game, `${player.name} 盲预留 ${level} 级牌，万能卡供应为空。`);
  }
  finishMainAction(game);
}

export function findCardLocation(game, instanceId) {
  for (const level of [1, 2]) {
    const key = levelKey(level);
    const marketIndex = game.market[key].findIndex((card) => card.instanceId === instanceId);
    if (marketIndex >= 0) return { zone: 'market', key, level, index: marketIndex, card: game.market[key][marketIndex] };
  }
  const player = getCurrentPlayer(game);
  const reserveIndex = player.reservedCards.findIndex((card) => card.instanceId === instanceId);
  if (reserveIndex >= 0) return { zone: 'reserved', index: reserveIndex, card: player.reservedCards[reserveIndex] };
  return null;
}

export function getPaymentOptions(player, card) {
  if (card.flexCost?.type === 'abc-total') return getAbcTotalOptions(player, card.flexCost.amount);
  if (card.flexCost?.type === 'same-kind') return getSameKindOptions(player, card.flexCost.amount);
  return getFixedPaymentOption(player, card.cost || {});
}

function getFixedPaymentOption(player, cost) {
  const permanent = getPermanentCounts(player);
  const remaining = {};
  let wildNeeded = 0;
  const pay = emptyTokens();
  for (const type of TASK_TYPES) {
    const need = Math.max(0, (cost[type] || 0) - permanent[type]);
    remaining[type] = need;
    const normalPay = Math.min(player.tokens[type] || 0, need);
    pay[type] = normalPay;
    wildNeeded += need - normalPay;
  }
  if ((player.tokens.wild || 0) < wildNeeded) return [];
  pay.wild = wildNeeded;
  return [{ kind: 'fixed', required: remaining, pay, wildNeeded, label: `自动支付：${formatTokens(pay)}` }];
}

function getAbcTotalOptions(player, amount) {
  const permanent = getPermanentCounts(player);
  const required = Math.max(0, amount - permanent.a - permanent.b - permanent.c);
  const availableNormal = (player.tokens.a || 0) + (player.tokens.b || 0) + (player.tokens.c || 0);
  const availableAll = availableNormal + (player.tokens.wild || 0);
  if (availableAll < required) return [];
  const pay = emptyTokens();
  let remain = required;
  const sorted = ['a', 'b', 'c'].sort((x, y) => (player.tokens[y] || 0) - (player.tokens[x] || 0));
  for (const type of sorted) {
    const use = Math.min(player.tokens[type] || 0, remain);
    pay[type] = use;
    remain -= use;
  }
  pay.wild = remain;
  return [{ kind: 'abc-total', required, pay, wildNeeded: pay.wild, label: `保研上岸支付：${formatTokens(pay)}` }];
}

function getSameKindOptions(player, amount) {
  const permanent = getPermanentCounts(player);
  const options = [];
  for (const type of TASK_TYPES) {
    const required = Math.max(0, amount - permanent[type]);
    const normal = Math.min(player.tokens[type] || 0, required);
    const wildNeeded = required - normal;
    if ((player.tokens.wild || 0) >= wildNeeded) {
      const pay = emptyTokens();
      pay[type] = normal;
      pay.wild = wildNeeded;
      options.push({
        kind: 'same-kind',
        selectedType: type,
        required,
        pay,
        wildNeeded,
        label: `选择${TASK_INFO[type].name}：${formatTokens(pay)}`,
      });
    }
  }
  return options.sort((a, b) => a.wildNeeded - b.wildNeeded || TASK_TYPES.indexOf(a.selectedType) - TASK_TYPES.indexOf(b.selectedType));
}

export function canBuyCard(player, card) {
  return getPaymentOptions(player, card).length > 0;
}

export function buyCard(game, instanceId, optionIndex = 0, rng = Math.random) {
  assertActionPhase(game);
  const player = getCurrentPlayer(game);
  const location = findCardLocation(game, instanceId);
  if (!location) throw new Error('\u76ee\u6807\u5361\u4e0d\u5728\u5e02\u573a\u6216\u5f53\u524d\u73a9\u5bb6\u9884\u7559\u533a\u4e2d')
  const options = getPaymentOptions(player, location.card);
  if (options.length === 0) throw new Error('\u8d44\u6e90\u4e0d\u8db3\uff0c\u65e0\u6cd5\u8d62\u53d6\u8be5\u53d1\u5c55\u5361')
  const option = options[optionIndex] || options[0];
  for (const type of TOKEN_TYPES) {
    const count = option.pay[type] || 0;
    if (count > 0) {
      player.tokens[type] -= count;
      game.supply[type] += count;
    }
  }
  let card;
  if (location.zone === 'market') {
    [card] = game.market[location.key].splice(location.index, 1);
    refillMarket(game, location.level);
  } else {
    [card] = player.reservedCards.splice(location.index, 1);
  }
  player.ownedCards.push(card);
  player.happiness += card.happiness || 0;
  log(game, `${player.name} \u8d62\u53d6\u300c${card.name}\u300d\uff0c\u652f\u4ed8 ${formatTokens(option.pay)}\uff0c\u83b7\u5f97 ${card.happiness || 0} \u5f00\u5fc3\u503c\u3002`);

  const opportunity = (card.happiness || 0) > 0 ? executeForcedOpportunity(game, rng) : null;
  finishMainAction(game);
  return { card, opportunity };
}

function drawAndResolveOpportunity(game, rng = Math.random) {
  const pool = getOpportunityPool(game);
  if (pool.length === 0) return null;
  const card = pool[Math.floor(rng() * pool.length)];
  const result = resolveOpportunity(game, card);
  log(game, `${result.message}\uff08\u5f3a\u5236\u6267\u884c\uff0c\u6709\u653e\u56de\u62bd\u53d6\uff09`);
  return { card, result };
}

function executeForcedOpportunity(game, rng = Math.random) {
  const draw = drawAndResolveOpportunity(game, rng);
  game.pendingOpportunity = null;
  return draw;
}

export function skipOpportunity() {
  throw new Error('\u673a\u9047\u5361\u4e3a\u5f3a\u5236\u6267\u884c\uff0c\u4e0d\u80fd\u8df3\u8fc7');
}

export function drawOpportunity(game, rng = Math.random) {
  if (game.phase !== 'opportunity_choice') throw new Error('\u5f53\u524d\u6ca1\u6709\u673a\u9047\u5361\u9009\u62e9');
  const draw = executeForcedOpportunity(game, rng);
  finishMainAction(game);
  return draw;
}

function resolvePovertyGrantOpportunity(game, card) {
  const scores = game.players.map((player) => (player.happiness || 0) + (player.ownedCards?.length || 0));
  const min = Math.min(...scores);
  const candidates = scores.map((score, index) => ({ score, index })).filter((item) => item.score === min);
  if (candidates.length !== 1) {
    return { winnerIndex: null, reward: 0, tokenType: 'wild', message: `机遇「${card.name}」：目前阶段得分+永久发展卡数量并列最少，无人获得奖励。` };
  }
  const winnerIndex = candidates[0].index;
  const winner = game.players[winnerIndex];
  const reward = Math.min(1, game.supply.wild || 0);
  if (reward <= 0) {
    return { winnerIndex, reward: 0, tokenType: 'wild', message: `机遇「${card.name}」：${winner.name} 目前阶段得分+永久发展卡数量唯一最少，但万能卡供应为 0，无奖励。` };
  }
  game.supply.wild -= reward;
  winner.tokens.wild += reward;
  return { winnerIndex, reward, tokenType: 'wild', message: `机遇「${card.name}」：${winner.name} 目前阶段得分+永久发展卡数量唯一最少，获得 ${reward} 张万能卡。` };
}

export function resolveOpportunity(game, card) {
  if (card.effect === 'poverty-grant') return resolvePovertyGrantOpportunity(game, card);
  const counts = game.players.map((player) => getPermanentCounts(player)[card.attribute] || 0);
  const max = Math.max(...counts);
  const leaders = counts.map((count, index) => ({ count, index })).filter((item) => item.count === max);
  const attrName = TASK_INFO[card.attribute].name;
  if (leaders.length !== 1) {
    return { winnerIndex: null, reward: 0, message: `\u673a\u9047\u300c${card.name}\u300d\uff1a${attrName}\u5c5e\u6027\u5e76\u5217\u6700\u591a\uff0c\u65e0\u4eba\u83b7\u5f97\u5956\u52b1\u3002` };
  }
  const winner = game.players[leaders[0].index];
  const reward = Math.min(2, game.supply[card.attribute]);
  if (reward <= 0) {
    return { winnerIndex: leaders[0].index, reward: 0, message: `\u673a\u9047\u300c${card.name}\u300d\uff1a${winner.name} ${attrName}\u6700\u591a\uff0c\u4f46\u4f9b\u5e94\u4e3a 0\uff0c\u65e0\u5956\u52b1\u3002` };
  }
  game.supply[card.attribute] -= reward;
  winner.tokens[card.attribute] += reward;
  return { winnerIndex: leaders[0].index, reward, message: `\u673a\u9047\u300c${card.name}\u300d\uff1a${winner.name} ${attrName}\u6700\u591a\uff0c\u83b7\u5f97 ${reward} \u5f20${attrName}\u4efb\u52a1\u5361\u3002` };
}

function findOverLimitPlayerIndex(game) {
  if (totalTokens(getCurrentPlayer(game).tokens) > TOKEN_LIMIT) return game.currentPlayerIndex;
  return game.players.findIndex((player) => totalTokens(player.tokens) > TOKEN_LIMIT);
}

function enterDiscardPhaseIfNeeded(game) {
  const index = findOverLimitPlayerIndex(game);
  if (index < 0) return false;
  const player = game.players[index];
  game.phase = 'discard_tokens';
  game.pendingDiscardPlayerIndex = index;
  log(game, `${player.name} \u8d44\u6e90\u8d85\u8fc7 ${TOKEN_LIMIT}\uff0c\u5fc5\u987b\u5f03\u8fd8\u3002`);
  return true;
}

function finishMainAction(game) {
  if (enterDiscardPhaseIfNeeded(game)) return;
  completeTurn(game);
}

export function discardToken(game, type) {
  if (game.phase !== 'discard_tokens') throw new Error('\u5f53\u524d\u4e0d\u5728\u5f03\u8fd8\u8d44\u6e90\u9636\u6bb5');
  const player = game.players[game.pendingDiscardPlayerIndex];
  if (!TOKEN_TYPES.includes(type)) throw new Error('\u672a\u77e5\u8d44\u6e90\u7c7b\u578b');
  if ((player.tokens[type] || 0) <= 0) throw new Error(`\u6ca1\u6709${TASK_INFO[type].name}\u53ef\u5f03\u8fd8`);
  player.tokens[type] -= 1;
  game.supply[type] += 1;
  log(game, `${player.name} 弃还 1 张${TASK_INFO[type].name}。`);
  if (totalTokens(player.tokens) <= TOKEN_LIMIT) {
    game.pendingDiscardPlayerIndex = null;
    if (enterDiscardPhaseIfNeeded(game)) return;
    completeTurn(game);
  }
}

function completeTurn(game) {
  const player = getCurrentPlayer(game);
  if (player?.active !== false) {
    if (!game.endgameTriggered && player.happiness >= WINNING_HAPPINESS) {
      game.endgameTriggered = true;
      game.endgameTriggeredBy = player.id;
      log(game, `${player.name} ?? ${player.happiness} ?????????`);
    }
    player.turnsTaken += 1;
  }
  if (game.endgameTriggered && allTurnsEqual(game)) {
    game.phase = 'game_over';
    game.winners = determineWinners(game);
    log(game, `????????${game.winners.map((p) => p.name).join('?')}?`);
    return;
  }
  const nextIndex = getNextActivePlayerIndex(game, game.currentPlayerIndex);
  if (nextIndex < 0) {
    game.phase = 'game_over';
    game.winners = determineWinners(game);
    return;
  }
  if (nextIndex <= game.currentPlayerIndex) game.roundNumber += 1;
  game.currentPlayerIndex = nextIndex;
  game.phase = 'player_action';
}

function allTurnsEqual(game) {
  const activeTurns = getActivePlayers(game).map((player) => player.turnsTaken);
  return activeTurns.length > 0 && activeTurns.every((turn) => turn === activeTurns[0]);
}

export function determineWinners(game) {
  const players = getActivePlayers(game).length ? getActivePlayers(game) : game.players;
  const sorted = [...players].sort((p1, p2) => {
    if (p2.happiness !== p1.happiness) return p2.happiness - p1.happiness;
    return p1.ownedCards.length - p2.ownedCards.length;
  });
  const best = sorted[0];
  return sorted.filter((player) => player.happiness === best.happiness && player.ownedCards.length === best.ownedCards.length);
}

function assertActionPhase(game) {
  if (game.phase !== 'player_action') throw new Error('当前不能执行主动作');
}

export function log(game, message) {
  game.log.unshift(message);
  game.log = game.log.slice(0, 80);
}

export function serializeGame(game) {
  return JSON.stringify(game);
}

export function deserializeGame(json) {
  return JSON.parse(json);
}



