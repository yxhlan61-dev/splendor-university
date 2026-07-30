import {
  buyCard,
  canBuyCard,
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
import { RESERVE_LIMIT, TASK_TYPES, TOKEN_LIMIT, TOKEN_TYPES } from './data.js';

export const AI_LEVELS = {
  haiku: {
    id: 'haiku',
    name: 'haiku',
    label: '初级 AI · haiku',
    description: '场上有什么拿什么，不会预留，不会观察对手。',
  },
  sonnet: {
    id: 'sonnet',
    name: 'sonnet',
    label: '中级 AI · sonnet',
    description: '会预留关键牌，但不观察对手。',
  },
  opus: {
    id: 'opus',
    name: 'opus',
    label: '高级 AI · opus',
    description: '会预留，也会观察对手，但仍偏局部最优。',
  },
  fable: {
    id: 'fable',
    name: 'fable',
    label: '顶级 AI · fable',
    description: '解锁完整策略；当前使用训练型价值函数风格的搜索策略。',
  },
};

export const AI_LEVEL_ORDER = ['haiku', 'sonnet', 'opus', 'fable'];

export function normalizeAILevel(level) {
  return AI_LEVELS[level] ? level : 'haiku';
}

export function makeAIPlayerName(level) {
  return AI_LEVELS[normalizeAILevel(level)].name;
}

export function isAIPlayer(player) {
  return Boolean(player?.isAI || player?.aiLevel);
}

export function decorateAIPlayer(player, level) {
  const aiLevel = normalizeAILevel(level);
  player.isAI = true;
  player.aiLevel = aiLevel;
  player.name = makeAIPlayerName(aiLevel);
  return player;
}

export function hydrateAIPlayers(game, aiSeats = []) {
  if (!game) return game;
  for (const seat of aiSeats || []) {
    const index = Number(seat?.index);
    if (!Number.isInteger(index) || !game.players[index]) continue;
    decorateAIPlayer(game.players[index], seat.aiLevel || seat.level);
  }
  return game;
}

function levelKey(level) {
  return Number(level) === 1 ? 'level1' : 'level2';
}

function allVisibleCards(game) {
  return [
    ...game.market.level2.map((card) => ({ card, source: 'market', level: 2 })),
    ...game.market.level1.map((card) => ({ card, source: 'market', level: 1 })),
  ];
}

function ownReservedCards(player) {
  return (player.reservedCards || []).map((card) => ({ card, source: 'reserved', level: card.level || 1 }));
}

function actionPriority(type) {
  return {
    buyCard: 0,
    reserveMarket: 1,
    reserveBlind: 2,
    takeSame: 3,
    takeDifferent: 4,
    discardToken: 5,
  }[type] ?? 99;
}

function cloneGame(game) {
  return JSON.parse(JSON.stringify(game));
}

function safeApply(game, action) {
  try {
    switch (action.type) {
      case 'buyCard':
        return buyCard(game, action.payload.instanceId, action.payload.optionIndex || 0, () => 0.42);
      case 'reserveMarket':
        reserveMarketCard(game, action.payload.level, action.payload.instanceId);
        return null;
      case 'reserveBlind':
        reserveBlindCard(game, action.payload.level);
        return null;
      case 'takeSame':
        takeSame(game, action.payload.tokenType);
        return null;
      case 'takeDifferent':
        takeDifferent(game, action.payload.types || []);
        return null;
      case 'discardToken':
        discardToken(game, action.payload.tokenType);
        return null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function costTotal(card) {
  if (card.flexCost?.amount) return card.flexCost.amount;
  return TASK_TYPES.reduce((sum, type) => sum + (card.cost?.[type] || 0), 0);
}


function tokenLoad(player) {
  return totalTokens(player.tokens || {});
}

function tokenPressure(player) {
  // Starts nudging decisions at 8 task cards, and becomes strong at/above the 10-card limit.
  return Math.max(0, tokenLoad(player) - (TOKEN_LIMIT - 3));
}

function isNearTokenLimit(player) {
  return tokenLoad(player) >= TOKEN_LIMIT - 1;
}

function reserveSlotsUsed(player) {
  return player.reservedCards?.length || 0;
}

function reserveCapacityPressure(player) {
  const used = reserveSlotsUsed(player);
  if (used <= 0) return 0;
  return used * used * 18 + (used >= RESERVE_LIMIT - 1 ? 38 : 0);
}

function projectedTokenLoad(game, player, action) {
  const current = tokenLoad(player);
  if (action.type === 'takeSame') return current + 2;
  if (action.type === 'takeDifferent') return current + (action.tokenTypes?.length || action.payload?.types?.length || 0);
  if ((action.type === 'reserveMarket' || action.type === 'reserveBlind') && game.supply.wild > 0) return current + 1;
  if (action.type === 'buyCard') return Math.max(0, current - costTotal(action.card));
  return current;
}

function tokenOverflowPenalty(game, player, action, multiplier = 55) {
  return Math.max(0, projectedTokenLoad(game, player, action) - TOKEN_LIMIT) * multiplier;
}

function missingCost(player, card) {
  const permanent = getPermanentCounts(player);
  if (card.flexCost?.type === 'abc-total') {
    const discount = permanent.a + permanent.b + permanent.c;
    const needed = Math.max(0, card.flexCost.amount - discount);
    const held = (player.tokens.a || 0) + (player.tokens.b || 0) + (player.tokens.c || 0) + (player.tokens.wild || 0);
    return Math.max(0, needed - held);
  }
  if (card.flexCost?.type === 'same-kind') {
    let best = Infinity;
    for (const type of TASK_TYPES) {
      const needed = Math.max(0, card.flexCost.amount - (permanent[type] || 0));
      const held = (player.tokens[type] || 0) + (player.tokens.wild || 0);
      best = Math.min(best, Math.max(0, needed - held));
    }
    return Number.isFinite(best) ? best : 0;
  }
  let missing = 0;
  for (const type of TASK_TYPES) {
    const needed = Math.max(0, (card.cost?.[type] || 0) - (permanent[type] || 0));
    missing += Math.max(0, needed - (player.tokens[type] || 0));
  }
  return Math.max(0, missing - (player.tokens.wild || 0));
}

function cardValue(player, card, level = card.level || 1, profile = 'balanced') {
  const permanent = getPermanentCounts(player);
  const attrNeed = card.attribute ? Math.max(0, 3 - (permanent[card.attribute] || 0)) : 0;
  const points = (card.happiness || 0) * (profile === 'fable' ? 15 : 11);
  const discount = card.attribute ? 5 + attrNeed * 1.4 : 0;
  const cheap = Math.max(0, 8 - costTotal(card)) * (level === 1 ? 0.8 : 0.35);
  const distance = missingCost(player, card);
  const near = Math.max(0, 7 - distance) * (profile === 'fable' ? 1.7 : 1.1);
  const levelBias = level === 2 ? (profile === 'haiku' ? 0 : 2.2) : 1.2;
  return points + discount + cheap + near + levelBias - distance * 1.8;
}

function desiredTokenWeights(game, player, profile = 'balanced') {
  const weights = Object.fromEntries(TASK_TYPES.map((type) => [type, 1]));
  const candidates = [...allVisibleCards(game), ...ownReservedCards(player)];
  const sorted = candidates
    .map((item) => ({ ...item, distance: missingCost(player, item.card), value: cardValue(player, item.card, item.level, profile) }))
    .sort((a, b) => b.value - a.value)
    .slice(0, profile === 'haiku' ? 2 : 5);

  for (const { card, distance, value } of sorted) {
    const multiplier = Math.max(0.5, value / 10) * (distance <= 3 ? 1.7 : 1);
    if (card.flexCost?.type === 'abc-total') {
      for (const type of ['a', 'b', 'c']) weights[type] += multiplier;
    } else if (card.flexCost?.type === 'same-kind') {
      const bestType = TASK_TYPES
        .map((type) => ({ type, need: Math.max(0, card.flexCost.amount - (getPermanentCounts(player)[type] || 0) - (player.tokens[type] || 0)) }))
        .sort((x, y) => x.need - y.need)[0]?.type;
      if (bestType) weights[bestType] += multiplier * 1.5;
    } else {
      for (const type of TASK_TYPES) {
        const need = Math.max(0, (card.cost?.[type] || 0) - (getPermanentCounts(player)[type] || 0) - (player.tokens[type] || 0));
        if (need > 0) weights[type] += need * multiplier;
      }
    }
  }
  for (const type of TASK_TYPES) weights[type] += Math.max(0, 2 - (player.tokens[type] || 0)) * 0.25;
  return weights;
}

function opponentThreat(game, currentIndex, card) {
  let threat = 0;
  for (let i = 0; i < game.players.length; i += 1) {
    if (i === currentIndex) continue;
    const opponent = game.players[i];
    if (!opponent || opponent.active === false) continue;
    const distance = missingCost(opponent, card);
    const value = (card.happiness || 0) * 8 + (card.attribute ? 3 : 0);
    if (canBuyCard(opponent, card)) threat += value + 8;
    else if (distance <= 2) threat += Math.max(0, value - distance * 3);
  }
  return threat;
}

function enumerateBuyActions(game, player, includeReserved = true) {
  return [...allVisibleCards(game), ...(includeReserved ? ownReservedCards(player) : [])]
    .filter(({ card }) => canBuyCard(player, card))
    .map(({ card, source, level }) => ({
      type: 'buyCard',
      payload: { instanceId: card.instanceId, optionIndex: 0 },
      card,
      source,
      level,
    }));
}

function enumerateReserveActions(game, player, includeBlind = true) {
  if ((player.reservedCards?.length || 0) >= RESERVE_LIMIT) return [];
  const actions = allVisibleCards(game)
    .filter(({ card }) => card.attribute)
    .map(({ card, level }) => ({ type: 'reserveMarket', payload: { level, instanceId: card.instanceId }, card, level }));
  if (includeBlind) {
    for (const level of [2, 1]) {
      if (game.decks[levelKey(level)]?.some((card) => card.attribute)) actions.push({ type: 'reserveBlind', payload: { level }, level });
    }
  }
  return actions;
}

function enumerateTokenActions(game, player, profile = 'balanced') {
  const weights = desiredTokenWeights(game, player, profile);
  const same = TASK_TYPES
    .filter((type) => game.supply[type] >= 4)
    .map((type) => ({ type: 'takeSame', payload: { tokenType: type }, tokenTypes: [type, type], tokenScore: weights[type] * 2 - Math.max(0, (player.tokens[type] || 0) - 2) * 0.4 }));
  const available = TASK_TYPES.filter((type) => game.supply[type] > 0);
  const required = Math.min(3, available.length);
  const different = combinations(available, required)
    .map((types) => ({ type: 'takeDifferent', payload: { types }, tokenTypes: types, tokenScore: types.reduce((sum, type) => sum + weights[type], 0) }));
  return [...same, ...different].sort((a, b) => (b.tokenScore || 0) - (a.tokenScore || 0));
}

function combinations(items, size, start = 0, prefix = []) {
  if (prefix.length === size) return [prefix];
  const result = [];
  for (let i = start; i < items.length; i += 1) {
    result.push(...combinations(items, size, i + 1, [...prefix, items[i]]));
  }
  return result;
}

function enumerateDiscardActions(game, player) {
  const weights = desiredTokenWeights(game, player, 'discard');
  return TOKEN_TYPES
    .filter((type) => (player.tokens[type] || 0) > 0)
    .map((type) => ({
      type: 'discardToken',
      payload: { tokenType: type },
      tokenScore: type === 'wild' ? 999 : weights[type],
    }))
    .sort((a, b) => a.tokenScore - b.tokenScore);
}

function evaluateGameForPlayer(game, playerIndex, profile = 'balanced') {
  const player = game.players[playerIndex];
  if (!player) return -Infinity;
  const permanent = getPermanentCounts(player);
  let score = (player.happiness || 0) * 100 + (player.ownedCards?.length || 0) * 2 - totalTokens(player.tokens) * 0.1;
  for (const type of TASK_TYPES) score += (permanent[type] || 0) * 12 + (player.tokens[type] || 0) * 1.7;
  score += (player.tokens.wild || 0) * 3.2;
  for (const card of player.reservedCards || []) score += cardValue(player, card, card.level, profile) * 0.45;
  const affordable = enumerateBuyActions(game, player, true);
  score += affordable.reduce((sum, action) => sum + cardValue(player, action.card, action.level, profile) * 0.25, 0);

  if (profile === 'fable') {
    for (let i = 0; i < game.players.length; i += 1) {
      if (i === playerIndex || game.players[i]?.active === false) continue;
      score -= (game.players[i].happiness || 0) * 28;
      score -= enumerateBuyActions(game, game.players[i], true).reduce((sum, action) => sum + (action.card.happiness || 0) * 6, 0);
    }
  }
  return score;
}

function scoreAction(game, playerIndex, action, level) {
  const player = game.players[playerIndex];
  const profile = level;
  if (action.type === 'discardToken') return -(action.tokenScore || 0);
  const load = tokenLoad(player);
  const pressure = tokenPressure(player);
  const nearLimit = isNearTokenLimit(player);
  const reservedCount = reserveSlotsUsed(player);
  const reservePenalty = reserveCapacityPressure(player);
  let score = 0;
  if (action.type === 'buyCard') {
    score += 1000 + cardValue(player, action.card, action.level, profile) * 12;
    score += (action.card.happiness || 0) * (level === 'fable' ? 70 : 45);
    score += pressure * 125 + Math.max(0, load - TOKEN_LIMIT + 1) * 140;
    score += Math.min(TOKEN_LIMIT, costTotal(action.card)) * (pressure > 0 ? 14 : 3);
    if (action.source === 'reserved') score += 8 + reservedCount * 12;
  } else if (action.type === 'reserveMarket') {
    const distance = missingCost(player, action.card);
    score += 18 + cardValue(player, action.card, action.level, profile) * 2.4;
    score += Math.max(0, 2 - distance) * 16;
    if (level === 'opus' || level === 'fable') score += opponentThreat(game, playerIndex, action.card) * (level === 'fable' ? 0.45 : 0.28);
    if (game.supply.wild > 0) score += pressure > 0 ? (nearLimit ? -4 : -18) : 5;
    if (nearLimit) {
      // When the hand is about to hit the 10-card cap, visible reserves are preferred over taking more cards.
      score += 55 + pressure * 32 + Math.max(0, 6 - distance) * 9;
      score -= tokenOverflowPenalty(game, player, action, 20);
    }
    score -= reservePenalty;
    if (distance > 5) score -= (distance - 5) * 16;
  } else if (action.type === 'reserveBlind') {
    score += action.level === 2 ? 6 : 2;
    if (game.supply.wild > 0) score += pressure > 0 ? -24 : 3;
    score -= reservePenalty + 28;
  } else if (action.type === 'takeSame' || action.type === 'takeDifferent') {
    score += action.tokenScore || 0;
    score -= pressure * (nearLimit ? 34 : action.type === 'takeDifferent' ? 18 : 12);
    score -= tokenOverflowPenalty(game, player, action, 75);
  }

  if ((action.type === 'reserveMarket' || action.type === 'reserveBlind') && reservedCount >= RESERVE_LIMIT - 1) score -= 80;

  if (level === 'fable') {
    const sim = cloneGame(game);
    safeApply(sim, action);
    score += evaluateGameForPlayer(sim, playerIndex, 'fable') * 0.18;
  }
  return score;
}

function chooseHaiku(game, player) {
  const buys = enumerateBuyActions(game, player, false);
  if (buys.length) return buys.sort((a, b) => allVisibleCards(game).findIndex((x) => x.card.instanceId === a.card.instanceId) - allVisibleCards(game).findIndex((x) => x.card.instanceId === b.card.instanceId))[0];
  const available = TASK_TYPES.filter((type) => game.supply[type] > 0);
  const required = Math.min(3, available.length);
  if (required > 0) return { type: 'takeDifferent', payload: { types: available.slice(0, required) } };
  const same = TASK_TYPES.find((type) => game.supply[type] >= 4);
  if (same) return { type: 'takeSame', payload: { tokenType: same } };
  return null;
}

function chooseStrategic(game, playerIndex, level) {
  const player = game.players[playerIndex];
  let actions = [];
  const buys = enumerateBuyActions(game, player, true);
  if (buys.length) actions.push(...buys);

  const pressure = tokenPressure(player);
  const reservedCount = reserveSlotsUsed(player);
  const nearLimit = isNearTokenLimit(player);
  const reserveActions = enumerateReserveActions(game, player, level !== 'sonnet');
  const visibleReserveActions = reserveActions.filter((action) => action.type === 'reserveMarket');
  const shouldConsiderReserve = pressure <= 1 && reservedCount === 0;
  if (shouldConsiderReserve) {
    if (level === 'sonnet') {
      const goodReserve = visibleReserveActions.filter((action) => missingCost(player, action.card) <= 4 && cardValue(player, action.card, action.level, level) >= 18);
      if (!buys.length && goodReserve.length) actions.push(...goodReserve);
    } else if (level === 'opus') {
      const goodReserve = visibleReserveActions.filter((action) => missingCost(player, action.card) <= 5 || opponentThreat(game, playerIndex, action.card) >= 18);
      if (!buys.length || game.supply.wild > 0) actions.push(...goodReserve);
    } else if (level === 'fable') {
      const goodReserve = visibleReserveActions.filter((action) => missingCost(player, action.card) <= 5 || opponentThreat(game, playerIndex, action.card) >= 22);
      actions.push(...goodReserve);
      if (!buys.length && reservedCount === 0 && pressure === 0 && game.supply.wild > 0) {
        actions.push(...reserveActions.filter((action) => action.type === 'reserveBlind' && action.level === 2));
      }
    }
  }

  if (nearLimit && !buys.length && reservedCount < RESERVE_LIMIT) {
    const pressureReserve = visibleReserveActions.filter((action) => {
      const distance = missingCost(player, action.card);
      const value = cardValue(player, action.card, action.level, level);
      const threat = level === 'opus' || level === 'fable' ? opponentThreat(game, playerIndex, action.card) : 0;
      return distance <= 6 || value >= 12 || threat >= 12;
    });
    actions.push(...(pressureReserve.length ? pressureReserve : visibleReserveActions));
  }

  const tokenActions = enumerateTokenActions(game, player, level);
  if (pressure >= 2 && buys.length) {
    actions = buys;
  } else {
    actions.push(...tokenActions);
  }
  actions = actions.filter(Boolean);
  if (!actions.length) return null;
  return actions
    .map((action) => ({ action, score: scoreAction(game, playerIndex, action, level) }))
    .sort((a, b) => b.score - a.score || actionPriority(a.action.type) - actionPriority(b.action.type))[0].action;
}

export function chooseAIAction(game, playerIndex = game.currentPlayerIndex) {
  if (!game || game.phase === 'game_over') return null;
  const player = game.players[playerIndex];
  if (!isAIPlayer(player) || player.active === false) return null;
  const level = normalizeAILevel(player.aiLevel);

  if (game.phase === 'discard_tokens') {
    if (game.pendingDiscardPlayerIndex !== playerIndex) return null;
    return enumerateDiscardActions(game, player)[0] || null;
  }
  if (game.phase !== 'player_action' || game.currentPlayerIndex !== playerIndex) return null;

  if (level === 'haiku') return chooseHaiku(game, player);
  return chooseStrategic(game, playerIndex, level);
}

export function applyAIAction(game, action) {
  if (!action) return null;
  return safeApply(game, action);
}

export function runNextAIAction(game) {
  const playerIndex = game?.phase === 'discard_tokens' ? game.pendingDiscardPlayerIndex : game?.currentPlayerIndex;
  if (!Number.isInteger(playerIndex)) return null;
  const action = chooseAIAction(game, playerIndex);
  if (!action) return null;
  const result = applyAIAction(game, action);
  return { action, result, playerIndex };
}

export function runAIActions(game, { maxActions = 60, onAction = null } = {}) {
  const results = [];
  for (let step = 0; step < maxActions; step += 1) {
    const item = runNextAIAction(game);
    if (!item) break;
    results.push(item);
    onAction?.(item);
    if (game.phase === 'game_over') break;
  }
  return results;
}
