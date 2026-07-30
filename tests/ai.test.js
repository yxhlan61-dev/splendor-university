import assert from 'node:assert/strict';
import { createGame, totalTokens } from '../src/game.js';
import { TOKEN_LIMIT } from '../src/data.js';
import { chooseAIAction, hydrateAIPlayers, runAIActions } from '../src/ai.js';

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
testAIDiscardReturnsToLimit();

console.log('All AI tests passed.');
