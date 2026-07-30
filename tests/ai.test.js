import assert from 'node:assert/strict';
import { createGame, totalTokens } from '../src/game.js';
import { TOKEN_LIMIT } from '../src/data.js';
import { applyAIAction, chooseAIAction, hydrateAIPlayers, runAIActions } from '../src/ai.js';

function deterministicGame(playerCount = 2) {
  return createGame({ playerCount, firstPlayerIndex: 0, rng: () => 0.42 });
}

function testHydrateAIPlayers() {
  const game = deterministicGame(3);
  hydrateAIPlayers(game, [{ index: 1, aiLevel: 'sonnet' }, { index: 2, aiLevel: 'opus' }]);
  assert.equal(game.players[0].isAI, undefined);
  assert.equal(game.players[1].isAI, true);
  assert.equal(game.players[1].aiLevel, 'sonnet');
  assert.equal(game.players[1].name, 'sonnet');
  assert.equal(game.players[2].isAI, true);
  assert.equal(game.players[2].aiLevel, 'opus');
  assert.equal(game.players[2].name, 'opus');
}

function testRunAIActionsAdvancesTurn() {
  const game = deterministicGame(2);
  hydrateAIPlayers(game, [{ index: 0, aiLevel: 'haiku' }]);
  const before = game.currentPlayerIndex;
  const results = runAIActions(game, { maxActions: 1 });
  assert.equal(results.length, 1);
  assert.equal(results[0].playerIndex, before);
  assert.equal(game.currentPlayerIndex, 1);
}

function testHaikuNeverReserves() {
  const game = deterministicGame(2);
  hydrateAIPlayers(game, [{ index: 0, aiLevel: 'haiku' }]);
  const action = chooseAIAction(game, 0);
  assert.notEqual(action?.type, 'reserveMarket');
  assert.notEqual(action?.type, 'reserveBlind');
}


function testStrategicAIPrefersTokensOverOpeningReserve() {
  for (const level of ['sonnet', 'opus', 'fable']) {
    const game = deterministicGame(2);
    hydrateAIPlayers(game, [{ index: 0, aiLevel: level }]);
    const action = chooseAIAction(game, 0);
    assert.notEqual(action?.type, 'reserveMarket', `${level} should not reserve a visible card as its opening move`);
    assert.notEqual(action?.type, 'reserveBlind', `${level} should not blind-reserve as its opening move`);
  }
}

function testStrategicAIBuysWhenNearTokenLimit() {
  for (const level of ['sonnet', 'opus', 'fable']) {
    const game = deterministicGame(2);
    hydrateAIPlayers(game, [{ index: 0, aiLevel: level }]);
    const card = {
      id: 'TEST_BUY',
      templateId: 'TEST_BUY',
      instanceId: `TEST_BUY_${level}`,
      name: 'Test affordable card',
      level: 1,
      attribute: 'a',
      cost: { a: 1, b: 1, c: 1 },
      happiness: 0,
    };
    game.market.level1 = [card];
    game.market.level2 = [];
    game.decks.level1 = [];
    game.decks.level2 = [];
    game.players[0].tokens = { a: 1, b: 1, c: 1, d: 3, e: 3, wild: 0 };

    const action = chooseAIAction(game, 0);
    assert.equal(action?.type, 'buyCard', `${level} should buy an affordable card when near the 10-token limit`);
    assert.equal(action?.payload.instanceId, card.instanceId);
  }
}

function testStrategicAIPrereservesVisibleCardInsteadOfTakingMoreNearTokenLimit() {
  for (const level of ['sonnet', 'opus', 'fable']) {
    const game = deterministicGame(2);
    hydrateAIPlayers(game, [{ index: 0, aiLevel: level }]);
    const card = {
      id: 'TEST_RESERVE',
      templateId: 'TEST_RESERVE',
      instanceId: `TEST_RESERVE_${level}`,
      name: 'Test reserve card',
      level: 1,
      attribute: 'a',
      cost: { a: 4, b: 4, c: 4, d: 4, e: 4 },
      happiness: 3,
    };
    game.market.level1 = [card];
    game.market.level2 = [];
    game.decks.level1 = [];
    game.decks.level2 = [];
    game.players[0].tokens = { a: 2, b: 2, c: 2, d: 2, e: 1, wild: 0 };

    const action = chooseAIAction(game, 0);
    assert.equal(action?.type, 'reserveMarket', `${level} should reserve/preorder a visible card instead of taking more tokens near the 10-token limit`);
    assert.equal(action?.payload.instanceId, card.instanceId);
  }
}



function testOpusAndFableTakeImmediateWinningLevelTwoCard() {
  for (const level of ['opus', 'fable']) {
    const game = deterministicGame(2);
    hydrateAIPlayers(game, [{ index: 0, aiLevel: level }]);
    game.players[0].happiness = 10;
    game.players[0].tokens = { a: 7, b: 0, c: 0, d: 0, e: 0, wild: 0 };
    const winningCard = {
      instanceId: `WIN_L2_${level}`,
      templateId: `WIN_L2_${level}`,
      name: 'Winning level two card',
      level: 2,
      attribute: 'a',
      cost: { a: 7 },
      happiness: 5,
    };
    const smallCard = {
      instanceId: `SMALL_L1_${level}`,
      templateId: `SMALL_L1_${level}`,
      name: 'Small level one card',
      level: 1,
      attribute: 'e',
      cost: { e: 3 },
      happiness: 1,
    };
    game.market.level1 = [smallCard];
    game.market.level2 = [winningCard];
    game.decks.level1 = [];
    game.decks.level2 = [];

    const action = chooseAIAction(game, 0);
    assert.equal(action?.type, 'buyCard', `${level} should take the level-2 lethal card immediately`);
    assert.equal(action?.payload.instanceId, winningCard.instanceId);
  }
}

function testOpusAndFableCollectFastestTokensForLevelTwoLethal() {
  for (const level of ['opus', 'fable']) {
    const game = deterministicGame(2);
    hydrateAIPlayers(game, [{ index: 0, aiLevel: level }]);
    game.players[0].happiness = 10;
    game.players[0].tokens = { a: 4, b: 0, c: 0, d: 0, e: 0, wild: 0 };
    game.supply = { a: 5, b: 5, c: 5, d: 5, e: 5, wild: 5 };
    const winningCard = {
      instanceId: `NEAR_WIN_L2_${level}`,
      templateId: `NEAR_WIN_L2_${level}`,
      name: 'Near winning level two card',
      level: 2,
      attribute: 'a',
      cost: { a: 7 },
      happiness: 5,
    };
    game.market.level1 = [];
    game.market.level2 = [winningCard];
    game.decks.level1 = [];
    game.decks.level2 = [];

    const action = chooseAIAction(game, 0);
    assert.equal(action?.type, 'takeSame', `${level} should collect the fastest tokens for next-turn level-2 lethal instead of reserving`);
    assert.equal(action?.payload.tokenType, 'a');
  }
}

function testOpusAndFableReserveDistantLevelTwoLethalPlan() {
  for (const level of ['opus', 'fable']) {
    const game = deterministicGame(2);
    hydrateAIPlayers(game, [{ index: 0, aiLevel: level }]);
    game.players[0].happiness = 10;
    game.players[0].tokens = { a: 1, b: 0, c: 0, d: 0, e: 0, wild: 0 };
    game.supply = { a: 5, b: 5, c: 5, d: 5, e: 5, wild: 5 };
    const winningCard = {
      instanceId: `DISTANT_WIN_L2_${level}`,
      templateId: `DISTANT_WIN_L2_${level}`,
      name: 'Distant winning level two card',
      level: 2,
      attribute: 'a',
      cost: { a: 7 },
      happiness: 5,
    };
    game.market.level1 = [];
    game.market.level2 = [winningCard];
    game.decks.level1 = [];
    game.decks.level2 = [];

    const action = chooseAIAction(game, 0);
    assert.equal(action?.type, 'reserveMarket', `${level} should reserve a distant lethal level-2 route before it disappears`);
    assert.equal(action?.payload.instanceId, winningCard.instanceId);
  }
}

function testAIApplyBuyUsesProvidedRandomForOpportunityDraw() {
  const first = deterministicGame(2);
  const firstCard = {
    instanceId: 'AI_SCORE_FIRST',
    templateId: 'AI_SCORE_FIRST',
    name: 'AI score first',
    level: 1,
    attribute: 'e',
    cost: { e: 3 },
    happiness: 1,
  };
  first.market.level1[0] = firstCard;
  first.players[0].tokens.e = 3;
  const firstResult = applyAIAction(first, { type: 'buyCard', payload: { instanceId: firstCard.instanceId, optionIndex: 0 }, card: firstCard, source: 'market', level: 1 }, () => 0);
  assert.equal(firstResult.opportunity.card.templateId, 'O_001');

  const last = deterministicGame(2);
  const lastCard = { ...firstCard, instanceId: 'AI_SCORE_LAST', templateId: 'AI_SCORE_LAST' };
  last.market.level1[0] = lastCard;
  last.players[0].tokens.e = 3;
  const lastResult = applyAIAction(last, { type: 'buyCard', payload: { instanceId: lastCard.instanceId, optionIndex: 0 }, card: lastCard, source: 'market', level: 1 }, () => 0.99);
  assert.equal(lastResult.opportunity.card.templateId, 'O_005');
}

function testAIDiscardReturnsToLimit() {
  const game = deterministicGame(2);
  hydrateAIPlayers(game, [{ index: 0, aiLevel: 'fable' }]);
  game.players[0].tokens = { a: 7, b: 2, c: 1, d: 1, e: 0, wild: 0 };
  game.phase = 'discard_tokens';
  game.pendingDiscardPlayerIndex = 0;
  const results = runAIActions(game, { maxActions: 5 });
  assert(results.length >= 1);
  assert.equal(totalTokens(game.players[0].tokens), TOKEN_LIMIT);
  assert.equal(game.phase, 'player_action');
}

testHydrateAIPlayers();
testRunAIActionsAdvancesTurn();
testHaikuNeverReserves();
testStrategicAIPrefersTokensOverOpeningReserve();
testStrategicAIBuysWhenNearTokenLimit();
testStrategicAIPrereservesVisibleCardInsteadOfTakingMoreNearTokenLimit();
testOpusAndFableTakeImmediateWinningLevelTwoCard();
testOpusAndFableCollectFastestTokensForLevelTwoLethal();
testOpusAndFableReserveDistantLevelTwoLethalPlan();
testAIApplyBuyUsesProvidedRandomForOpportunityDraw();
testAIDiscardReturnsToLimit();

console.log('All AI tests passed.');
