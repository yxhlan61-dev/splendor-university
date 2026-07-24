import assert from 'node:assert/strict';
import {
  buyCard,
  createGame,
  discardToken,
  drawOpportunity,
  getPaymentOptions,
  reserveMarketCard,
  resolveOpportunity,
  takeDifferent,
  takeSame,
  totalTokens,
} from '../src/game.js';
import { LEVEL2_TEMPLATES, MARKET_SIZE } from '../src/data.js';

function deterministicGame(playerCount = 2) {
  return createGame({ playerCount, firstPlayerIndex: 0, rng: () => 0.42 });
}

function findTemplate(game, templateId) {
  for (const key of ['level1', 'level2']) {
    const marketCard = game.market[key].find((card) => card.templateId === templateId);
    if (marketCard) return marketCard;
    const deckCard = game.decks[key].find((card) => card.templateId === templateId);
    if (deckCard) return deckCard;
  }
  throw new Error(`missing ${templateId}`);
}

function giveCard(player, attribute, count) {
  for (let i = 0; i < count; i += 1) {
    player.ownedCards.push({ instanceId: `owned_${attribute}_${i}_${Math.random()}`, attribute, happiness: 0 });
  }
}

function testInit() {
  const g2 = deterministicGame(2);
  assert.equal(g2.supply.a, 5);
  assert.equal(g2.supply.wild, 5);
  assert.equal(g2.decks.level1.length + g2.market.level1.length, 75);
  assert.equal(g2.decks.level2.length + g2.market.level2.length, 36);
  assert.equal(g2.market.level1.length, MARKET_SIZE);
  assert.equal(g2.market.level2.length, MARKET_SIZE);

  const g3 = deterministicGame(3);
  assert.equal(g3.supply.a, 6);
  const g4 = deterministicGame(4);
  assert.equal(g4.supply.a, 8);
}

function testTakeTokens() {
  const game = deterministicGame(2);
  takeDifferent(game, ['a', 'b', 'c']);
  assert.equal(game.players[0].tokens.a, 1);
  assert.equal(game.currentPlayerIndex, 1);
  assert.throws(() => takeDifferent(game, ['a', 'b']), /必须选择 3/);

  game.supply.d = 3;
  assert.throws(() => takeSame(game, 'd'), /少于 4/);
  game.supply.d = 4;
  takeSame(game, 'd');
  assert.equal(game.players[1].tokens.d, 2);
}

function testReserve() {
  const game = deterministicGame(2);
  const card = game.market.level1[0];
  const deckBefore = game.decks.level1.length;
  reserveMarketCard(game, 1, card.instanceId);
  assert.equal(game.players[0].reservedCards.length, 1);
  assert.equal(game.players[0].tokens.wild, 1);
  assert.equal(game.market.level1.length, MARKET_SIZE);
  assert.equal(game.decks.level1.length, deckBefore - 1);

  game.phase = 'player_action';
  game.currentPlayerIndex = 0;
  game.players[0].reservedCards.push({ instanceId: 'x' }, { instanceId: 'y' });
  assert.throws(() => reserveMarketCard(game, 1, game.market.level1[0].instanceId), /预留区已满/);
}

function testFixedPurchaseDiscount() {
  const game = deterministicGame(2);
  const player = game.players[0];
  giveCard(player, 'a', 2);
  player.tokens.a = 1;
  const card = { instanceId: 'manual', templateId: 'manual', name: '测试学习', level: 1, attribute: 'a', cost: { a: 3 }, happiness: 0 };
  game.market.level1[0] = card;
  buyCard(game, card.instanceId);
  assert.equal(player.tokens.a, 0);
  assert(player.ownedCards.some((c) => c.instanceId === 'manual'));
}

function testFlexibleCosts() {
  const game = deterministicGame(2);
  const player = game.players[0];
  const baoYan = LEVEL2_TEMPLATES.find((c) => c.id === 'L2_002');
  giveCard(player, 'a', 2);
  giveCard(player, 'b', 3);
  player.tokens.a = 4;
  player.tokens.b = 3;
  player.tokens.c = 3;
  player.tokens.wild = 0;
  let options = getPaymentOptions(player, baoYan);
  assert.equal(options.length, 1);
  assert.equal(options[0].required, 10);

  const dorm = LEVEL2_TEMPLATES.find((c) => c.id === 'L2_009');
  player.tokens = { a: 6, b: 3, c: 0, d: 0, e: 0, wild: 0 };
  giveCard(player, 'a', 2);
  options = getPaymentOptions(player, dorm);
  assert(options.some((o) => o.selectedType === 'a' && o.required === 4));
  assert(!options.some((o) => o.selectedType === 'b'));
}

function testOpportunity() {
  const game = deterministicGame(2);
  giveCard(game.players[0], 'a', 2);
  giveCard(game.players[1], 'a', 1);
  game.supply.a = 1;
  const result = resolveOpportunity(game, { name: '期末考试', attribute: 'a' });
  assert.equal(result.winnerIndex, 0);
  assert.equal(result.reward, 1);
  assert.equal(game.players[0].tokens.a, 1);

  game.players[1].ownedCards.push({ attribute: 'a' });
  const tie = resolveOpportunity(game, { name: '期末考试', attribute: 'a' });
  assert.equal(tie.winnerIndex, null);
}

function testDiscardAndEndgame() {
  const game = deterministicGame(2);
  game.players[0].tokens = { a: 10, b: 0, c: 0, d: 0, e: 0, wild: 0 };
  game.supply.b = 5;
  takeSame(game, 'b');
  assert.equal(game.phase, 'discard_tokens');
  discardToken(game, 'a');
  discardToken(game, 'a');
  assert.equal(game.phase, 'player_action');

  const end = deterministicGame(2);
  const player = end.players[0];
  player.tokens.e = 3;
  player.happiness = 14;
  const card = { instanceId: 'score', templateId: 'score', name: '单机游戏', level: 1, attribute: 'e', cost: { e: 3 }, happiness: 1 };
  end.market.level1[0] = card;
  buyCard(end, card.instanceId);
  if (end.phase === 'opportunity_choice') drawOpportunity(end);
  assert.equal(end.endgameTriggered, true);
  assert.equal(end.phase, 'player_action');
}

testInit();
testTakeTokens();
testReserve();
testFixedPurchaseDiscount();
testFlexibleCosts();
testOpportunity();
testDiscardAndEndgame();

console.log('All rule tests passed.');
