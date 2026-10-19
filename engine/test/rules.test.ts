/* Scripted rules scenarios — the things chip conservation alone cannot catch:
   who acts, minimum/maximum amounts, reopening, bring-ins, pots, odd chips. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCards, type Card } from '../src/cards.ts';
import {
  startHand, legalActions, applyAction, checkInvariants,
  type Action, type HandConfig, type HandState, type Stakes,
} from '../src/engine.ts';
import type { GameId, Structure } from '../src/games.ts';
import { handHistory } from '../src/hh.ts';
import { Stream, shuffle, handSeed, commitment, newServerSeed } from '../src/rng.ts';

const NLS: Stakes = { ante: 0, smallBlind: 10, bigBlind: 20, bringIn: 0, smallBet: 0, bigBet: 0 };
const FLS: Stakes = { ante: 0, smallBlind: 10, bigBlind: 20, bringIn: 0, smallBet: 20, bigBet: 40 };
const STUD: Stakes = { ante: 2, smallBlind: 0, bigBlind: 0, bringIn: 5, smallBet: 20, bigBet: 40 };

function mk(game: GameId, structure: Structure, stacks: number[], o: Partial<HandConfig> & { deck?: string } = {}): HandState {
  const cfg: HandConfig = {
    handId: '1', game, structure,
    stakes: o.stakes ?? (game.match(/stud|razz/) ? STUD : structure === 'FL' ? FLS : NLS),
    seats: stacks.map((stack, i) => ({ seat: i + 1, id: 'p' + i, name: 'P' + (i + 1), stack })),
    button: o.button ?? 1, seed: '11'.repeat(32), table: 'T', maxSeats: 9,
    startedAt: '2026-10-19T16:00:00Z', capBets: o.capBets, uncappedHeadsUp: o.uncappedHeadsUp,
    testDeck: o.deck ? parseCards(o.deck) : undefined,
  };
  return startHand(cfg);
}
function act(s: HandState, ...as: Action[]): HandState {
  for (const a of as) { s = applyAction(s, a); assert.deepEqual(checkInvariants(s), []); }
  return s;
}
const who = (s: HandState) => s.players[s.toAct]?.name;
const F: Action = { type: 'fold' }, C: Action = { type: 'call' }, K: Action = { type: 'check' };
const R = (amount: number): Action => ({ type: 'raise', amount });
const B = (amount: number): Action => ({ type: 'bet', amount });

/* ---------- blinds, position, min raise ------------------------------------ */

test('3-handed: SB/BB left of button, button acts first preflop', () => {
  const s = mk('holdem', 'NL', [1000, 1000, 1000]);
  assert.equal(s.players[1].bet, 10); assert.equal(s.players[2].bet, 20);
  assert.equal(who(s), 'P1');
  const L = legalActions(s)!;
  assert.equal(L.call, 20); assert.deepEqual(L.raise, { min: 40, max: 1000 });
});

test('heads-up: button posts the small blind, acts first preflop and last after', () => {
  let s = mk('holdem', 'NL', [1000, 1000], { button: 2 });
  assert.equal(s.players[1].bet, 10, 'button = small blind');
  assert.equal(who(s), 'P2');
  s = act(s, C, K);
  assert.equal(who(s), 'P1', 'big blind acts first on the flop');
});

test('big blind gets the option; NL min raise follows the last full raise', () => {
  let s = mk('holdem', 'NL', [1000, 1000, 1000]);
  s = act(s, C, C);
  assert.equal(who(s), 'P3'); assert.equal(legalActions(s)!.check, true);
  s = act(s, R(60));                           // raise of 40
  assert.equal(legalActions(s)!.raise!.min, 100);
  s = act(s, R(200));                          // raise of 140
  assert.equal(legalActions(s)!.raise!.min, 340);
});

test('NL short all-in does not reopen; short all-ins that add up to a full raise do', () => {
  // P1 btn, P2 sb, P3 bb, P4 utg.  Flop: P2 bets 100, P3 all-in 150 (short), P4 calls.
  let s = mk('holdem', 'NL', [1000, 1000, 170, 1000]);
  s = act(s, C, C, C, K);                      // limped to the flop (everyone in for 20)
  assert.equal(who(s), 'P2');
  s = act(s, B(100));
  s = act(s, { type: 'raise', amount: 150 }); // P3 all-in for 150 total
  assert.equal(s.players[2].allIn, true);
  s = act(s, C, C);                            // P4 and P1 call 150
  assert.equal(who(s), 'P2');
  const L = legalActions(s)!;
  assert.equal(L.call, 50); assert.equal(L.raise, null, 'short all-in must not reopen for P2');

  // cumulative: 100 bet, short all-in to 150, another all-in to 210 => 110 more than P2 faced: reopens
  let t = mk('holdem', 'NL', [1000, 1000, 170, 230]);
  t = act(t, C, C, C, K);
  t = act(t, B(100), R(150), R(210), C);
  assert.equal(who(t), 'P2');
  assert.ok(legalActions(t)!.raise, 'short raises adding to a full raise reopen the betting');
});

test('short big blind: the amount to call is still the full big blind', () => {
  const s = mk('holdem', 'NL', [1000, 1000, 5]);
  assert.equal(s.players[2].bet, 5); assert.equal(s.players[2].allIn, true);
  assert.equal(legalActions(s)!.call, 20);
});

test('pot limit: 3.5 big blinds preflop, pot-sized raise after a bet', () => {
  let s = mk('omaha', 'PL', [5000, 5000, 5000]);
  assert.deepEqual(legalActions(s)!.raise, { min: 40, max: 70 });
  s = act(s, C, C, K);                         // pot 60
  assert.deepEqual(legalActions(s)!.bet, { min: 20, max: 60 });
  s = act(s, B(60));
  assert.deepEqual(legalActions(s)!.raise, { min: 120, max: 240 }, 'call 60 -> pot 180, raise 180 => to 240');
});

/* ---------- fixed limit ---------------------------------------------------- */

test('fixed limit: big blind is the first bet; cap at 4; uncapped heads-up option', () => {
  let s = mk('holdem', 'FL', [1000, 1000, 1000]);
  assert.deepEqual(legalActions(s)!.raise, { min: 40, max: 40 });
  s = act(s, R(40), R(60), R(80));             // 2, 3, 4 bets
  assert.equal(s.events.at(-1)!.k, 'capped');
  assert.equal(legalActions(s)!.raise, null);
  s = act(s, C, C);
  assert.equal(s.board.length, 3);
  assert.deepEqual(legalActions(s)!.bet, { min: 20, max: 20 });
  s = act(s, K, K, K);
  assert.deepEqual(legalActions(s)!.bet, { min: 40, max: 40 }, 'turn = big bet');

  let h = mk('holdem', 'FL', [1000, 1000], { uncappedHeadsUp: true, button: 2 });
  h = act(h, R(40), R(60), R(80));
  assert.ok(legalActions(h)!.raise, 'heads-up: no cap');
});

test('fixed limit short all-ins: under half a bet does not reopen, half or more counts as a raise', () => {
  // button P1, sb P2, bb P3 (20), utg P4 all-in for 25 (under half a bet more)
  let s = mk('holdem', 'FL', [1000, 1000, 1000, 25]);
  s = act(s, R(25));
  assert.equal(s.betCount, 1, 'not a raise');
  assert.deepEqual(legalActions(s)!.raise, { min: 40, max: 40 }, 'next full raise is to 40, not 45');
  s = act(s, C, C);                            // P1, P2 call 25
  assert.equal(who(s), 'P3');
  assert.equal(legalActions(s)!.call, 5);
  assert.ok(legalActions(s)!.raise, 'big blind has not acted yet, may raise');
  s = act(s, C);
  assert.equal(s.board.length, 3);

  // all-in for 30 (half a bet more) counts as a raise to 40
  let t = mk('holdem', 'FL', [1000, 1000, 1000, 30]);
  t = act(t, R(30));
  assert.equal(t.betCount, 2);
  assert.deepEqual(legalActions(t)!.raise, { min: 60, max: 60 });
});

test('stud: an all-in for less than the completion does not complete', () => {
  // P3 brings in (2c); P1 all-in for 12 total (stack 14 - ante 2)
  const deck = '3h 4h 8c   5d 6d Ah   7s 9s 2c';
  let s = mk('stud', 'FL', [14, 500, 500], { deck });
  s = act(s, { type: 'bringin' });
  assert.equal(who(s), 'P1');
  s = act(s, R(12));
  assert.equal(s.betCount, 0);
  assert.deepEqual(legalActions(s)!.raise, { min: 20, max: 20 }, 'P2 may complete to 20');
});

/* ---------- uncalled bet, side pots, odd chips ----------------------------- */

test('uncalled bet is returned and logged', () => {
  let s = mk('holdem', 'NL', [1000, 1000, 1000]);
  s = act(s, R(300), F, F);
  const e = s.events.find(x => x.k === 'uncalled');
  assert.deepEqual(e, { k: 'uncalled', p: 0, amount: 280 });
  assert.deepEqual(s.result!.net, [30, -10, -20]);
});

test('side pots: each pot goes to the best hand eligible for it', () => {
  // button P1.  Deal order: P2, P3, P4, P1 (two cards each), then the board.
  // P2: AA (all-in 100)   P3: KK (all-in 300)   P4: QQ (deep)   P1: 72o (deep)
  const deck = 'Ac Ad  Kc Kd  Qc Qd  7h 2s  3s 8d 9h 4c Jh';
  let s = mk('holdem', 'NL', [2000, 100, 300, 2000], { deck });
  // preflop: P4 (utg) raises to 300, P1 calls, P2 all-in 100, P3 all-in 300; then checked down
  s = act(s, R(300), C, C, C);
  while (s.phase !== 'done') s = act(s, K);
  const pots = s.result!.pots;
  assert.deepEqual(pots.map(p => p.amount), [400, 600]);
  assert.deepEqual(s.result!.net, [-300, 300, 300, -300]);
  const hh = handHistory(s, 'all');
  assert.match(hh, /Main pot 400\. Side pot 600\./);
  assert.match(hh, /P2 collected 400 from main pot/);
  assert.match(hh, /P3 collected 600 from side pot/);
});

test('split pot: odd chip goes to the high half; tied winners by position', () => {
  // Omaha Hi/Lo, 3 players, button P1.  Board 2c 3d 4h Kc Kd.
  // P2: A5xx -> wheel low + straight... keep it simple: P2 wins the low alone,
  // P3 and P1 tie the high with identical KQ-holdings (quads? no: trips K).
  const deck = 'Ah 5s 9c 9d   Qh Jh Ts 9s   Qs Js Th 9h   2c 3d 4h Kc Kd';
  let s = mk('omaha8', 'PL', [1001, 1001, 1001], { deck, stakes: { ...NLS, smallBlind: 10, bigBlind: 21 } });
  // pot: everyone calls 21 preflop -> 63, check down
  s = act(s, C, C, K);
  while (s.phase !== 'done') s = act(s, K);
  // P2: A,5 + 2,3,4 = 5-high low; high: A5 + 234 = straight (wheel) beats trips? P2 high: wheel straight.
  // P3/P1 high: QJ + KK x = trip kings... the wheel wins high too -> P2 scoops
  assert.deepEqual(s.result!.net, [-21, 42, -21]);
});

test('split pot odd chip: 63 chips, low takes 31, high 32; tied highs split by position', () => {
  // Board: As Ks 2d 3c 9h.  P2 (sb): 4h 5h ... gives the nut low 5-4-3-2-A and a wheel straight.
  // Make high a tie between P3 and P1: both hold Ad Kd / Ac Kc equivalent: two pair AK.
  const deck = '8h 7h Qd Jc   Ad Kd 6s 6h   Ac Kc 6c 6d   As Ks 2d 3c 9h';
  let s = mk('omaha8', 'PL', [1001, 1001, 1001], { deck, stakes: { ...NLS, smallBlind: 10, bigBlind: 21 } });
  s = act(s, C, C, K);
  while (s.phase !== 'done') s = act(s, K);
  // P2: 8 7 + A 2 3 = 8-7-3-2-A low (only low).  High: P3 and P1 both AK two pair -> tie.
  // pot 63: low 31 to P2, high 32 split 16/16
  const col = s.events.filter(e => e.k === 'collect') as { p: number; amount: number; half: string }[];
  const lo = col.filter(c => c.half === 'lo'), hi = col.filter(c => c.half === 'hi');
  assert.deepEqual(lo.map(c => [c.p, c.amount]), [[1, 31]]);
  assert.deepEqual(hi.map(c => c.amount).sort(), [16, 16]);
});

test('odd chip in a tied pot goes to the first winner left of the button', () => {
  // Hold'em, 3 players, chop between P3 and P1; pot 63 (blinds 10/21 + call).
  const deck = '2c 3c   Ah Kh   As Ks   Qd Jd Td 4s 5s';
  let s = mk('holdem', 'NL', [1000, 1000, 1000], { deck, stakes: { ...NLS, smallBlind: 10, bigBlind: 21 } });
  s = act(s, C, C, K);
  while (s.phase !== 'done') s = act(s, K);
  // board Q J T 4 5: AK makes the broadway straight for both P3 and P1
  const col = s.events.filter(e => e.k === 'collect') as { p: number; amount: number }[];
  // order left of button (P1 btn): P2, P3, P1 -> P3 gets the odd chip
  assert.deepEqual(col.map(c => [c.p, c.amount]), [[2, 32], [0, 31]]);
});

/* ---------- stud ---------------------------------------------------------- */

test('stud: lowest door card brings in, clubs lowest; bring-in may complete', () => {
  // seats 1..3 get 3 cards each in order: [down down UP]
  const deck = 'Ah Ad 2d   Kh Kd 2c   Qh Qd 9s';
  let s = mk('stud', 'FL', [500, 500, 500], { deck });
  assert.equal(who(s), 'P2', '2c brings in over 2d');
  const L = legalActions(s)!;
  assert.equal(L.bringIn, 5); assert.equal(L.fold, false);
  assert.deepEqual(L.raise, { min: 20, max: 20 }, 'or complete');
  s = act(s, { type: 'bringin' });
  assert.equal(who(s), 'P3');
  assert.deepEqual(legalActions(s)!.raise, { min: 20, max: 20 }, 'completion');
  s = act(s, R(20));
  assert.match(handHistory(s, 'all'), /P3: raises 15 to 20/);
});

test('razz: highest door card brings in (ace low), spades highest', () => {
  const deck = 'Ah 2d Kc   3h 4d Ks   5h 6d 7s';
  const s = mk('razz', 'FL', [500, 500, 500], { deck });
  assert.equal(who(s), 'P2', 'Ks brings in over Kc');
});

test('stud: a paired board acts before a higher unpaired board; open pair allows the big bet', () => {
  // 3rd: P1 up 8c, P2 up Ah, P3 up 2c (brings in).  4th: P1 8d (pair of 8s showing), P2 Kh.
  const deck = '3h 4h 8c   5d 6d Ah   7s 9s 2c   8d Kh Tc';
  let s = mk('stud', 'FL', [500, 500, 500], { deck });
  s = act(s, { type: 'bringin' }, C, C);
  assert.equal(s.round, 1);
  assert.equal(who(s), 'P1', 'open eights act before A-K');
  assert.deepEqual(legalActions(s)!.bet, { min: 20, max: 40, only: [20, 40] });
  s = act(s, B(40));
  assert.deepEqual(legalActions(s)!.raise, { min: 80, max: 80 }, 'after a big bet, raises are big');
});

test('stud 8: no open-pair big bet', () => {
  const deck = '3h 4h 8c   5d 6d Ah   7s 9s 2c   8d Kh Tc';
  let s = mk('stud8', 'FL', [500, 500, 500], { deck });
  s = act(s, { type: 'bringin' }, C, C);
  assert.deepEqual(legalActions(s)!.bet, { min: 20, max: 20 });
});

test('stud: eight players to 7th street share a community card', () => {
  let s = mk('stud', 'FL', [500, 500, 500, 500, 500, 500, 500, 500]);
  s = act(s, { type: 'bringin' });
  while (s.phase !== 'done') { const L = legalActions(s)!; s = act(s, L.call ? C : K); }
  assert.equal(s.board.length, 1, 'one community card');
  assert.ok(s.events.some(e => e.k === 'community'));
  assert.ok(s.players.every(p => p.cards.length === 6));
});

/* ---------- draw games ----------------------------------------------------- */

test('triple draw: all-in players still draw; discards are reshuffled when the stub runs out', () => {
  let s = mk('td27', 'FL', [1000, 1000, 1000, 1000, 1000, 15]);
  let reshuffled = false, sawAllInDraw = false;
  while (s.phase !== 'done') {
    const L = legalActions(s)!;
    if (L.draw) {
      if (s.players[L.player].allIn) sawAllInDraw = true;
      s = act(s, { type: 'draw', discard: s.players[L.player].cards.slice() });   // draw five every time
    } else s = act(s, L.call ? C : K);
    if (s.events.some(e => e.k === 'reshuffle')) reshuffled = true;
  }
  assert.ok(sawAllInDraw, 'the all-in player drew');
  assert.ok(reshuffled, '6 players drawing 5 x3 must reshuffle');
  assert.equal(s.events.filter(e => e.k === 'street' && /^draw/.test(e.street)).length, 3);
});

test('2-7 single draw no limit: one draw, then betting, then showdown', () => {
  let s = mk('sd27', 'NL', [1000, 1000]);
  s = act(s, C, K);
  assert.equal(s.phase, 'draw');
  s = act(s, { type: 'draw', discard: [] }, { type: 'draw', discard: [] });
  assert.equal(s.phase, 'bet');
  s = act(s, K, K);
  assert.equal(s.phase, 'done'); assert.equal(s.result!.showdown, true);
});

test('2-7: A-2-3-4-5 beats a pair at showdown', () => {
  // heads-up, button P2 (sb).  Deal order: P1 first (left of button), then P2.
  const deck = 'Ah 2c 3d 4s 5h   2h 2d 7c 5c 3h';
  let s = mk('td27', 'FL', [1000, 1000], { deck, button: 2 });
  s = act(s, C, K);
  for (let r = 0; r < 3; r++) s = act(s, { type: 'draw', discard: [] }, { type: 'draw', discard: [] }, K, K);
  assert.equal(s.phase, 'done');
  assert.ok(s.result!.net[0] > 0, 'ace-high no pair wins in 2-7');
});

/* ---------- determinism & fairness ----------------------------------------- */

test('same seed + same actions = same hand; commit-reveal derivation', () => {
  const server = newServerSeed();
  assert.equal(commitment(server).length, 64);
  const seed = handSeed(server, 'h1', ['alice', 'bob']);
  assert.notEqual(seed, handSeed(server, 'h1', ['alice', 'bob2']), 'a client seed changes the deck');
  const run = () => {
    const cfg: HandConfig = { handId: 'h1', game: 'holdem', structure: 'NL', stakes: NLS, button: 1, seed, table: 'T', maxSeats: 6, startedAt: '2026-10-19T16:00:00Z',
      seats: [{ seat: 1, id: 'a', name: 'A', stack: 500 }, { seat: 2, id: 'b', name: 'B', stack: 500 }] };
    let s = startHand(cfg);
    while (s.phase !== 'done') { const L = legalActions(s)!; s = applyAction(s, L.call ? C : K); }
    return handHistory(s, 'all');
  };
  assert.equal(run(), run());
});

test('shuffle is uniform: each card lands in each position about equally often', () => {
  const N = 52 * 400, counts = Array.from({ length: 52 }, () => new Array(52).fill(0));
  const st = new Stream('22'.repeat(32), 'uniform');
  for (let t = 0; t < N; t++) {
    const d = shuffle(Array.from({ length: 52 }, (_, i) => i), st);
    for (let pos = 0; pos < 52; pos++) counts[d[pos]][pos]++;
  }
  // chi-square over all 2704 cells, expected 400 each; df = 2601 (mean df, sd ~72)
  let chi = 0;
  for (const row of counts) for (const c of row) chi += (c - 400) ** 2 / 400;
  assert.ok(chi < 2601 + 5 * 72 && chi > 2601 - 5 * 72, 'chi-square ' + chi.toFixed(0));
});
