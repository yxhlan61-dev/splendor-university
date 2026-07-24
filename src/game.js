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
    opportunity: shuffle(OPPORTUNITY_TEMPLATES.map((card, i) => ({ ...card, instanceId: `${card.id}_${i + 1}` })), rng),
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
  const [card] = game.market[key].splice(index, 1);
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
  const card = game.decks[key].shift();
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

export function buyCard(game, instanceId, optionIndex = 0) {
  assertActionPhase(game);
  const player = getCurrentPlayer(game);
  const location = findCardLocation(game, instanceId);
  if (!location) throw new Error('目标卡不在市场或当前玩家预留区中');
  const options = getPaymentOptions(player, location.card);
  if (options.length === 0) throw new Error('资源不足，无法赢取该发展卡');
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
  log(game, `${player.name} 赢取「${card.name}」，支付 ${formatTokens(option.pay)}，获得 ${card.happiness || 0} 开心值。`);

  if ((card.happiness || 0) > 0) {
    prepareOpportunity(game, card);
  } else {
    finishMainAction(game);
  }
}

function prepareOpportunity(game, card) {
  if (game.decks.opportunity.length === 0 && game.discard.opportunity.length > 0) {
    game.decks.opportunity = shuffle(game.discard.opportunity);
    game.discard.opportunity = [];
    log(game, '机遇牌库为空，已将弃牌区洗混形成新牌库。');
  }
  if (game.decks.opportunity.length === 0) {
    finishMainAction(game);
    return;
  }
  game.phase = 'opportunity_choice';
  game.pendingOpportunity = { playerIndex: game.currentPlayerIndex, sourceCard: card };
}

export function skipOpportunity(game) {
  if (game.phase !== 'opportunity_choice') throw new Error('当前没有机遇卡选择');
  const player = getCurrentPlayer(game);
  log(game, `${player.name} 选择不翻开机遇卡。`);
  game.pendingOpportunity = null;
  finishMainAction(game);
}

export function drawOpportunity(game) {
  if (game.phase !== 'opportunity_choice') throw new Error('当前没有机遇卡选择');
  if (game.decks.opportunity.length === 0 && game.discard.opportunity.length > 0) {
    game.decks.opportunity = shuffle(game.discard.opportunity);
    game.discard.opportunity = [];
  }
  if (game.decks.opportunity.length === 0) {
    game.pendingOpportunity = null;
    finishMainAction(game);
    return;
  }
  const card = game.decks.opportunity.shift();
  const result = resolveOpportunity(game, card);
  game.discard.opportunity.push(card);
  log(game, result.message);
  game.pendingOpportunity = null;
  finishMainAction(game);
}

export function resolveOpportunity(game, card) {
  const counts = game.players.map((player) => getPermanentCounts(player)[card.attribute] || 0);
  const max = Math.max(...counts);
  const leaders = counts.map((count, index) => ({ count, index })).filter((item) => item.count === max);
  const attrName = TASK_INFO[card.attribute].name;
  if (leaders.length !== 1) {
    return { winnerIndex: null, reward: 0, message: `机遇「${card.name}」：${attrName}属性并列最多，无人获得奖励。` };
  }
  const winner = game.players[leaders[0].index];
  const reward = Math.min(2, game.supply[card.attribute]);
  if (reward <= 0) {
    return { winnerIndex: leaders[0].index, reward: 0, message: `机遇「${card.name}」：${winner.name} ${attrName}最多，但供应为 0，无奖励。` };
  }
  game.supply[card.attribute] -= reward;
  winner.tokens[card.attribute] += reward;
  return { winnerIndex: leaders[0].index, reward, message: `机遇「${card.name}」：${winner.name} ${attrName}最多，获得 ${reward} 张${attrName}任务卡。` };
}

function finishMainAction(game) {
  const player = getCurrentPlayer(game);
  if (totalTokens(player.tokens) > TOKEN_LIMIT) {
    game.phase = 'discard_tokens';
    game.pendingDiscardPlayerIndex = game.currentPlayerIndex;
    log(game, `${player.name} 资源超过 ${TOKEN_LIMIT}，必须弃还。`);
    return;
  }
  completeTurn(game);
}

export function discardToken(game, type) {
  if (game.phase !== 'discard_tokens') throw new Error('当前不在弃还资源阶段');
  const player = game.players[game.pendingDiscardPlayerIndex];
  if (!TOKEN_TYPES.includes(type)) throw new Error('未知资源类型');
  if ((player.tokens[type] || 0) <= 0) throw new Error(`没有${TASK_INFO[type].name}可弃还`);
  player.tokens[type] -= 1;
  game.supply[type] += 1;
  log(game, `${player.name} 弃还 1 张${TASK_INFO[type].name}。`);
  if (totalTokens(player.tokens) <= TOKEN_LIMIT) {
    game.pendingDiscardPlayerIndex = null;
    completeTurn(game);
  }
}

function completeTurn(game) {
  const player = getCurrentPlayer(game);
  if (!game.endgameTriggered && player.happiness >= WINNING_HAPPINESS) {
    game.endgameTriggered = true;
    game.endgameTriggeredBy = player.id;
    log(game, `${player.name} 达到 ${player.happiness} 开心值，触发终局！`);
  }
  player.turnsTaken += 1;
  if (game.endgameTriggered && allTurnsEqual(game)) {
    game.phase = 'game_over';
    game.winners = determineWinners(game);
    log(game, `游戏结束！胜者：${game.winners.map((p) => p.name).join('、')}。`);
    return;
  }
  game.currentPlayerIndex = (game.currentPlayerIndex + 1) % game.players.length;
  if (game.currentPlayerIndex === game.firstPlayerIndex) game.roundNumber += 1;
  game.phase = 'player_action';
}

function allTurnsEqual(game) {
  const turns = game.players.map((player) => player.turnsTaken);
  return turns.every((turn) => turn === turns[0]);
}

export function determineWinners(game) {
  const sorted = [...game.players].sort((p1, p2) => {
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



