/* The hand state machine.

     startHand(config)          -> HandState
     legalActions(state)        -> what the player to act may do
     applyAction(state, action) -> new HandState   (pure; applyActionMut mutates)

   A hand is fully determined by its config (which includes the hand seed)
   and the list of actions, so replay / crash recovery is just a fold.

   Rules implemented
   - Fixed limit, pot limit and no limit for every game.
   - Flop/draw: button, small/big blind (heads-up: button posts the small
     blind, acts first before the flop/draw and last after).  A short big
     blind still sets the full big blind as the amount to call.
   - Stud: antes, bring-in (stud/stud8: lowest door card, suits c<d<h<s;
     razz: highest door card, ace low, highest suit brings it in), the
     bring-in may complete; first to act from 4th street is the best exposed
     hand (razz: the lowest), ties broken by the suit of the top card; stud
     hi open pair on 4th allows the big bet; if the deck cannot give every
     remaining player a 7th card, one community card is dealt face up.
   - Fixed limit cap (default 4 bets, the big blind / completion counting as
     the first); optional uncapped heads-up.
   - NL/PL minimum raise = the last full raise; an all-in short raise does
     not reopen the betting to players who already acted, unless short
     raises add up to a full one.  Fixed limit: an all-in raise of at least
     half a full raise counts as a raise.
   - Uncalled bets returned at the end of each round; main/side pots;
     split pots (odd chip to the high); positional odd chips.
   - Draw games: all-in players still draw; if the stub runs short the
     earlier discards are reshuffled into it (not the discards of the player
     being served).                                                           */

import { type Card, freshDeck, rankOf, suitOf, lowRank } from './cards.ts';
import { Stream, shuffle } from './rng.ts';
import { GAMES, type GameDef, type GameId, type Structure, bettingRounds, usesBigBet } from './games.ts';
import { showingHigh, showingLowA5 } from './evaluate.ts';
import { strength, describe, buildPots, awardPots, studPriority, potName, type Strength } from './showdown.ts';

export interface Stakes {
  ante: number;
  smallBlind: number;
  bigBlind: number;
  /** stud */
  bringIn: number;
  /** fixed limit bet sizes */
  smallBet: number;
  bigBet: number;
}

export interface SeatInput { seat: number; id: string; name: string; stack: number }

export interface HandConfig {
  handId: string;
  game: GameId;
  structure: Structure;
  stakes: Stakes;
  /** players dealt in, any order (sorted by seat internally) */
  seats: SeatInput[];
  /** button seat number (flop / draw games) */
  button: number;
  /** hex hand seed (see rng.ts) */
  seed: string;
  capBets?: number;
  uncappedHeadsUp?: boolean;
  table: string;
  maxSeats: number;
  startedAt: string;           // ISO timestamp
  mixed?: string;              // e.g. "HORSE" / "8-Game"
  tournament?: { id: string; buyIn: string; level: number };
  /** TESTS ONLY: stack the deck (these cards first, the rest in order).
      The server must never set this. */
  testDeck?: Card[];
}

export interface PlayerState {
  seat: number; id: string; name: string;
  start: number;               // stack at the start of the hand
  stack: number;
  cards: Card[];
  up: boolean[];               // stud: which cards are face up
  folded: boolean;
  allIn: boolean;
  bet: number;                 // in front, this round
  total: number;               // put in this hand (antes included)
  acted: boolean;              // acted voluntarily this round
  actedAt: number;             // the amount to call when they last acted
  actedFull: number;           // FL: the full-bet level when they last acted
}

export type StreetName =
  | 'preflop' | 'flop' | 'turn' | 'river'
  | '3rd' | '4th' | '5th' | '6th' | '7th'
  | 'predraw' | 'draw1' | 'draw2' | 'draw3';

export type Ev =
  | { k: 'ante' | 'sb' | 'bb'; p: number; amount: number; allIn: boolean }
  | { k: 'street'; street: StreetName; newBoard?: Card[] }
  | { k: 'deal'; p: number; cards: Card[]; up: boolean[] }
  | { k: 'community'; card: Card }
  | { k: 'bringin'; p: number; amount: number; allIn: boolean }
  | { k: 'fold'; p: number }
  | { k: 'check'; p: number }
  | { k: 'call'; p: number; amount: number; allIn: boolean }
  | { k: 'bet'; p: number; amount: number; allIn: boolean }
  | { k: 'raise'; p: number; by: number; to: number; allIn: boolean }
  | { k: 'capped' }
  | { k: 'draw'; p: number; discard: Card[]; kept: Card[]; drawn: Card[] }
  | { k: 'reshuffle'; cards: number }
  | { k: 'uncalled'; p: number; amount: number }
  | { k: 'showdown' }
  | { k: 'show'; p: number; cards: Card[]; desc: string }
  | { k: 'collect'; p: number; amount: number; pot: string; half: 'all' | 'hi' | 'lo' }
  | { k: 'nolow' };

export type Action =
  | { type: 'fold' }
  | { type: 'check' }
  | { type: 'call' }
  | { type: 'bet'; amount?: number }       // amount = total bet this round ("to")
  | { type: 'raise'; amount?: number }     // amount = raise TO
  | { type: 'bringin' }
  | { type: 'draw'; discard: Card[] };

export interface Legal {
  player: number;
  fold: boolean;
  check: boolean;
  /** chips needed to call (0 = nothing to call) */
  call: number;
  /** `only`: the amount must be one of these (stud open-pair small/big bet) */
  bet: { min: number; max: number; only?: number[] } | null;
  raise: { min: number; max: number } | null;
  bringIn: number | null;
  draw: { max: number } | null;
}

export interface HandResult {
  net: number[];               // per player index: stack - start
  pots: { amount: number; eligible: number[] }[];
  showdown: boolean;
}

export interface HandState {
  cfg: HandConfig;
  players: PlayerState[];
  stub: Card[];                // undealt cards, next card at index 0
  discards: Card[];            // draw-game muck available for a reshuffle
  reshuffles: number;
  board: Card[];
  btn: number;                 // index of the button (flop/draw)
  round: number;               // betting round, 0-based
  phase: 'bet' | 'draw' | 'done';
  toAct: number;               // player index, -1 when nobody
  currentBet: number;
  minRaise: number;            // NL/PL: size of the last full raise
  unit: number;                // FL: bet size this round
  betCount: number;            // FL: bets + full raises this round
  fullLevel: number;           // FL: bet level of the last full bet/raise
  doubleOK: boolean;           // stud open pair on 4th street
  bringInPending: boolean;
  drawOrder: number[];         // draw phase: players still to draw, in order
  events: Ev[];
  result: HandResult | null;
}

/* ===================================================================== */

const def = (s: HandState): GameDef => GAMES[s.cfg.game];
const n = (s: HandState) => s.players.length;
const live = (s: HandState) => s.players.filter(p => !p.folded);
const canAct = (p: PlayerState) => !p.folded && !p.allIn;

function streetName(g: GameDef, r: number): StreetName {
  if (g.family === 'flop') return (['preflop', 'flop', 'turn', 'river'] as const)[r];
  if (g.family === 'stud') return (['3rd', '4th', '5th', '6th', '7th'] as const)[r];
  return (['predraw', 'draw1', 'draw2', 'draw3'] as const)[r];
}

function take(s: HandState, k: number): Card[] {
  if (s.stub.length < k) throw new Error('deck exhausted');
  return s.stub.splice(0, k);
}

/** move chips from a player's stack into the pot; returns chips moved */
function put(p: PlayerState, amt: number, asBet: boolean): number {
  const d = Math.max(0, Math.min(amt, p.stack));
  p.stack -= d; p.total += d;
  if (asBet) p.bet += d;
  if (p.stack === 0) p.allIn = true;
  return d;
}

/* ---------------------------------------------------------------------- */

export function startHand(cfg: HandConfig): HandState {
  const g = GAMES[cfg.game];
  if (!g) throw new Error('unknown game ' + cfg.game);
  if (!g.structures.includes(cfg.structure)) throw new Error(g.name + ' cannot be played ' + cfg.structure);
  const seats = cfg.seats.slice().sort((a, b) => a.seat - b.seat);
  if (seats.length < 2) throw new Error('need at least two players');
  if (seats.length > g.maxSeats) throw new Error(g.name + ' seats at most ' + g.maxSeats);
  for (const x of seats) if (!(x.stack > 0) || !Number.isInteger(x.stack)) throw new Error('bad stack for ' + x.name);
  const st = cfg.stakes;
  for (const k of ['ante', 'smallBlind', 'bigBlind', 'bringIn', 'smallBet', 'bigBet'] as const)
    if (!Number.isInteger(st[k]) || st[k] < 0) throw new Error('bad stake ' + k);
  if (g.family === 'stud' && !(st.bringIn > 0 && st.bringIn < st.smallBet)) throw new Error('stud needs 0 < bring-in < small bet');
  if (g.family !== 'stud' && !(st.bigBlind > 0)) throw new Error('big blind required');
  if (cfg.structure === 'FL' && !(st.smallBet > 0 && st.bigBet >= st.smallBet)) throw new Error('limit needs small/big bet');

  const players: PlayerState[] = seats.map(x => ({
    seat: x.seat, id: x.id, name: x.name, start: x.stack, stack: x.stack,
    cards: [], up: [], folded: false, allIn: false, bet: 0, total: 0, acted: false, actedAt: 0, actedFull: 0,
  }));

  // button: the dealt-in seat at or before the button seat (dead-button safe)
  let btn = players.length - 1;
  for (let i = players.length - 1; i >= 0; i--) if (players[i].seat <= cfg.button) { btn = i; break; }

  const s: HandState = {
    cfg, players,
    stub: cfg.testDeck
      ? cfg.testDeck.concat(freshDeck().filter(c => !cfg.testDeck!.includes(c)))
      : shuffle(freshDeck(), new Stream(cfg.seed, 'deck')),
    discards: [], reshuffles: 0, board: [], btn,
    round: 0, phase: 'bet', toAct: -1, currentBet: 0, minRaise: 0, unit: 0, betCount: 0, fullLevel: 0,
    doubleOK: false, bringInPending: false, drawOrder: [], events: [], result: null,
  };

  // antes
  if (st.ante > 0) for (let i = 0; i < n(s); i++) {
    const p = players[i];
    const a = put(p, st.ante, false);
    s.events.push({ k: 'ante', p: i, amount: a, allIn: p.allIn });
  }

  if (g.family === 'stud') {
    s.events.push({ k: 'street', street: '3rd' });
    for (let i = 0; i < n(s); i++) {
      const p = players[i];
      p.cards = take(s, 3); p.up = [false, false, true];
      s.events.push({ k: 'deal', p: i, cards: p.cards.slice(), up: p.up.slice() });
    }
  } else {
    // blinds
    const sb = n(s) === 2 ? btn : (btn + 1) % n(s);
    const bb = (sb + 1) % n(s);
    const a = put(players[sb], st.smallBlind, true);
    if (st.smallBlind > 0) s.events.push({ k: 'sb', p: sb, amount: a, allIn: players[sb].allIn });
    const b = put(players[bb], st.bigBlind, true);
    s.events.push({ k: 'bb', p: bb, amount: b, allIn: players[bb].allIn });
    s.events.push({ k: 'street', street: g.family === 'flop' ? 'preflop' : 'predraw' });
    for (let k = 1; k <= n(s); k++) {
      const i = (btn + k) % n(s);
      players[i].cards = take(s, g.holeCards);
      players[i].up = players[i].cards.map(() => false);
      s.events.push({ k: 'deal', p: i, cards: players[i].cards.slice(), up: players[i].up.slice() });
    }
  }
  beginRound(s);
  return s;
}

/* ---------- betting rounds ----------------------------------------------- */

/** fixed limit: the next full bet/raise level.  Measured from the last FULL
    bet, so after a short all-in (BB 20, all-in 25) a raise goes to 40. */
function fullRaiseTo(s: HandState): number {
  return s.fullLevel + s.unit;
}

function beginRound(s: HandState): void {
  const g = def(s), st = s.cfg.stakes, fl = s.cfg.structure === 'FL';
  const preflop = s.round === 0 && g.family !== 'stud';
  for (const p of s.players) {
    if (!preflop) p.bet = 0;
    p.acted = false; p.actedAt = 0; p.actedFull = 0;
  }
  s.phase = 'bet';
  s.unit = fl ? (usesBigBet(g, s.round) ? st.bigBet : st.smallBet) : st.bigBlind;
  s.minRaise = fl ? s.unit : st.bigBlind;
  s.doubleOK = false;
  s.bringInPending = false;

  let first: number;
  if (preflop) {
    s.currentBet = st.bigBlind;
    s.betCount = 1;                                     // the big blind is the first bet
    s.fullLevel = st.bigBlind;
    const sb = n(s) === 2 ? s.btn : (s.btn + 1) % n(s);
    first = n(s) === 2 ? sb : (sb + 2) % n(s);
  } else {
    s.currentBet = 0;
    s.betCount = 0;
    s.fullLevel = 0;
    if (g.family === 'stud') {
      if (s.round === 0) {
        first = bringInPlayer(s);
        if (first >= 0) s.bringInPending = true;
      } else {
        first = bestShowing(s);
        if (g.openPairDouble && s.round === 1)
          s.doubleOK = live(s).some(p => rankOf(p.cards[2]) === rankOf(p.cards[3]));
      }
    } else {
      first = (s.btn + 1) % n(s);
    }
  }
  s.toAct = -1;
  if (first < 0) { endRound(s); return; }
  if (s.bringInPending) { s.toAct = first; return; }
  // the first player who can act, starting at `first`
  for (let k = 0; k < n(s); k++) {
    const i = (first + k) % n(s);
    if (canAct(s.players[i])) { s.toAct = i; break; }
  }
  if (s.toAct < 0 || roundClosed(s)) { s.toAct = -1; endRound(s); }
}

/** no further betting possible / needed this round */
function roundClosed(s: HandState): boolean {
  if (live(s).length < 2) return true;
  const able = s.players.filter(canAct);
  if (able.length === 0) return true;
  if (able.length === 1 && able[0].bet >= s.currentBet &&
      s.players.every(p => p.folded || p.allIn || p === able[0])) return true;
  return !able.some(p => !p.acted || p.bet < s.currentBet);
}

function bringInPlayer(s: HandState): number {
  const g = def(s);
  let best = -1, bestKey = 0;
  s.players.forEach((p, i) => {
    if (!canAct(p)) return;
    const door = p.cards[2];
    // stud/stud8: lowest card brings in (suits c<d<h<s, clubs lowest);
    // razz: highest card (ace low), spades highest
    const key = g.rule === 'razz'
      ? -(lowRank(door) * 4 + suitOf(door))
      : rankOf(door) * 4 + suitOf(door);
    if (best < 0 || key < bestKey) { best = i; bestKey = key; }
  });
  return best;
}

/** stud first to act from 4th street: best exposed hand among live players */
function bestShowing(s: HandState): number {
  const g = def(s);
  let best = -1, bestV = 0, bestTie = 0;
  s.players.forEach((p, i) => {
    if (p.folded) return;
    const up = p.cards.filter((_, j) => p.up[j]);
    // bigger = acts first
    const v = g.rule === 'razz' ? -showingLowA5(up) : showingHigh(up);
    const top = up.reduce((m, c) => Math.max(m, g.rule === 'razz' ? lowRank(c) * 4 + suitOf(c) : rankOf(c) * 4 + suitOf(c)), -1);
    // equal boards: the higher suit on the top card acts first
    const tie = top & 3;
    if (best < 0 || v > bestV || (v === bestV && tie > bestTie)) { best = i; bestV = v; bestTie = tie; }
  });
  return best;
}

function endRound(s: HandState): void {
  // uncalled bet
  let hi = -1;
  for (let i = 0; i < n(s); i++) if (hi < 0 || s.players[i].bet > s.players[hi].bet) hi = i;
  let second = 0;
  for (let i = 0; i < n(s); i++) if (i !== hi) second = Math.max(second, s.players[i].bet);
  const h = s.players[hi];
  if (h.bet > second) {
    const back = h.bet - second;
    h.bet -= back; h.total -= back; h.stack += back;
    if (h.stack > 0) h.allIn = false;
    s.events.push({ k: 'uncalled', p: hi, amount: back });
  }
  for (const p of s.players) p.bet = 0;
  s.toAct = -1;

  if (live(s).length === 1) { finishUncontested(s); return; }
  s.round++;
  const g = def(s);
  if (s.round >= bettingRounds(g)) { showdown(s); return; }
  nextStreet(s);
}

function nextStreet(s: HandState): void {
  const g = def(s);
  const name = streetName(g, s.round);
  if (g.family === 'flop') {
    const k = s.round === 1 ? 3 : 1;
    const fresh = take(s, k);
    s.board.push(...fresh);
    s.events.push({ k: 'street', street: name, newBoard: fresh });
    beginRound(s);
  } else if (g.family === 'stud') {
    s.events.push({ k: 'street', street: name });
    const lv = s.players.map((p, i) => i).filter(i => !s.players[i].folded);
    if (s.round === 4 && s.stub.length < lv.length) {
      const c = take(s, 1)[0];
      s.board.push(c);
      s.events.push({ k: 'community', card: c });
    } else {
      for (const i of lv) {
        const p = s.players[i];
        const c = take(s, 1);
        const up = s.round < 4;
        p.cards.push(c[0]); p.up.push(up);
        s.events.push({ k: 'deal', p: i, cards: c, up: [up] });
      }
    }
    beginRound(s);
  } else {
    s.events.push({ k: 'street', street: name });
    s.phase = 'draw';
    s.drawOrder = [];
    for (let k = 1; k <= n(s); k++) {
      const i = (s.btn + k) % n(s);
      if (!s.players[i].folded) s.drawOrder.push(i);
    }
    s.toAct = s.drawOrder[0];
  }
}

function finishUncontested(s: HandState): void {
  const w = s.players.findIndex(p => !p.folded);
  const pot = s.players.reduce((t, p) => t + p.total, 0);
  s.players[w].stack += pot;
  s.events.push({ k: 'collect', p: w, amount: pot, pot: 'pot', half: 'all' });
  finish(s, [{ amount: pot, eligible: [w] }], false);
}

function showdown(s: HandState): void {
  const g = def(s);
  s.events.push({ k: 'showdown' });
  const order: number[] = [];
  if (g.family === 'stud') {
    for (let i = 0; i < n(s); i++) if (!s.players[i].folded) order.push(i);
  } else {
    for (let k = 1; k <= n(s); k++) { const i = (s.btn + k) % n(s); if (!s.players[i].folded) order.push(i); }
  }
  const strengths: (Strength | null)[] = s.players.map(() => null);
  for (const i of order) {
    const p = s.players[i];
    strengths[i] = strength(g, p.cards, s.board);
    s.events.push({ k: 'show', p: i, cards: p.cards.slice(), desc: describe(g, strengths[i]!) });
  }
  const pots = buildPots(s.players.map(p => p.total), s.players.map(p => p.folded));
  const priority = g.family === 'stud' ? studPriority(s.players, order) : order;
  const awards = awardPots(g, pots, strengths, priority);
  if ((g.rule === 'omaha-hilo8' || g.rule === 'stud-hilo8') && !awards.some(a => a.half === 'lo'))
    s.events.push({ k: 'nolow' });
  for (const a of awards) {
    s.players[a.player].stack += a.amount;
    s.events.push({ k: 'collect', p: a.player, amount: a.amount, pot: potName(a.pot, pots.length), half: a.half });
  }
  finish(s, pots, true);
}

function finish(s: HandState, pots: { amount: number; eligible: number[] }[], showdown: boolean): void {
  s.phase = 'done';
  s.toAct = -1;
  s.result = { net: s.players.map(p => p.stack - p.start), pots, showdown };
}

/* ---------- legal actions ------------------------------------------------- */

function potTotal(s: HandState): number {
  return s.players.reduce((t, p) => t + p.total, 0);
}

export function legalActions(s: HandState): Legal | null {
  if (s.phase === 'done' || s.toAct < 0) return null;
  const p = s.players[s.toAct];
  const L: Legal = { player: s.toAct, fold: false, check: false, call: 0, bet: null, raise: null, bringIn: null, draw: null };
  if (s.phase === 'draw') {
    L.draw = { max: p.cards.length };
    return L;
  }
  const g = def(s), st = s.cfg.stakes, struct = s.cfg.structure;
  const allInTo = p.bet + p.stack;

  if (s.bringInPending) {
    L.bringIn = Math.min(st.bringIn, p.stack);
    if (allInTo > st.bringIn) L.raise = { min: Math.min(st.smallBet, allInTo), max: Math.min(st.smallBet, allInTo) };
    return L;
  }

  const toCall = Math.max(0, s.currentBet - p.bet);
  L.fold = true;
  if (toCall === 0) L.check = true; else L.call = Math.min(toCall, p.stack);
  if (allInTo <= s.currentBet) return L;                 // can only call (all-in) or fold

  // may this player raise?  Short all-ins do not reopen the betting:
  // NL/PL — unless they add up to a full raise since this player acted;
  // FL    — unless one counted as a raise (at least half a bet).
  if (p.acted && (struct === 'FL' ? s.fullLevel <= p.actedFull : s.currentBet - p.actedAt < s.minRaise)) return L;

  if (struct === 'FL') {
    const headsUp = live(s).length === 2 && s.cfg.uncappedHeadsUp;
    const cap = s.cfg.capBets ?? 4;
    if (s.betCount >= cap && !headsUp) return L;
    const amt = Math.min(fullRaiseTo(s), allInTo);
    const range = { min: amt, max: amt };
    // stud hi open pair on 4th: the opener may bet the small OR the big bet
    // (not anything between); a big bet makes every later raise a big bet
    if (s.doubleOK && s.currentBet === 0) {
      const lo = Math.min(st.smallBet, allInTo), hi = Math.min(st.bigBet, allInTo);
      L.bet = { min: lo, max: hi, only: lo === hi ? [lo] : [lo, hi] };
      return L;
    }
    if (s.currentBet === 0) L.bet = range; else L.raise = range;
    return L;
  }

  // NL / PL
  if (s.currentBet === 0) {
    const min = Math.min(st.bigBlind, allInTo);
    const max = struct === 'NL' ? allInTo : Math.min(allInTo, potTotal(s));
    L.bet = { min, max: Math.max(min, max) };
  } else {
    const min = Math.min(s.currentBet + s.minRaise, allInTo);
    const max = struct === 'NL' ? allInTo : Math.min(allInTo, s.currentBet + potTotal(s) + toCall);
    L.raise = { min, max: Math.max(min, max) };
  }
  return L;
}

/* ---------- applying actions ---------------------------------------------- */

export function applyAction(s: HandState, a: Action): HandState {
  const c = structuredClone(s);
  applyActionMut(c, a);
  return c;
}

export function applyActionMut(s: HandState, a: Action): void {
  const L = legalActions(s);
  if (!L) throw new Error('no action expected');
  const i = L.player, p = s.players[i];
  const st = s.cfg.stakes;

  if (s.phase === 'draw') {
    if (a.type !== 'draw') throw new Error('expected a draw');
    doDraw(s, i, a.discard);
    return;
  }

  switch (a.type) {
    case 'bringin': {
      if (L.bringIn == null) throw new Error('no bring-in now');
      put(p, st.bringIn, true);
      s.currentBet = st.bringIn;
      s.bringInPending = false;
      s.events.push({ k: 'bringin', p: i, amount: p.bet, allIn: p.allIn });
      break;
    }
    case 'fold': {
      if (!L.fold) throw new Error('cannot fold now');
      p.folded = true;
      s.events.push({ k: 'fold', p: i });
      break;
    }
    case 'check': {
      if (!L.check) throw new Error('cannot check');
      s.events.push({ k: 'check', p: i });
      break;
    }
    case 'call': {
      if (!L.call) throw new Error('nothing to call');
      const d = put(p, L.call, true);
      s.events.push({ k: 'call', p: i, amount: d, allIn: p.allIn });
      break;
    }
    case 'bet': case 'raise': {
      const r = a.type === 'bet' ? L.bet : L.raise;
      if (!r) throw new Error('cannot ' + a.type);
      const to = a.amount ?? r.min;
      if (!Number.isInteger(to) || to < r.min || to > r.max) throw new Error(a.type + ' must be ' + r.min + (r.max > r.min ? '..' + r.max : ''));
      const double = s.cfg.structure === 'FL' && s.doubleOK && s.currentBet === 0;
      if (double && to !== r.min && to !== r.max) throw new Error('bet the small or the big bet');
      const prev = s.currentBet;
      const fullTo = s.cfg.structure === 'FL' ? (double ? to : fullRaiseTo(s)) : prev + s.minRaise;
      put(p, to - p.bet, true);
      const inc = to - prev;
      const full = s.cfg.structure === 'FL' ? to - prev >= Math.ceil((fullTo - prev) / 2) : inc >= s.minRaise;
      if (s.cfg.structure !== 'FL' && full) s.minRaise = inc;
      if (full) s.betCount++;
      if (full && s.cfg.structure === 'FL') s.fullLevel = Math.max(to, fullTo);
      if (double) { if (to >= st.bigBet) s.unit = st.bigBet; s.doubleOK = false; }
      s.currentBet = to;
      if (s.bringInPending) s.bringInPending = false;           // bring-in player completed
      if (a.type === 'bet' || (prev === 0)) s.events.push({ k: 'bet', p: i, amount: to, allIn: p.allIn });
      else s.events.push({ k: 'raise', p: i, by: inc, to, allIn: p.allIn });
      if (s.cfg.structure === 'FL' && s.betCount >= (s.cfg.capBets ?? 4) && !(live(s).length === 2 && s.cfg.uncappedHeadsUp))
        s.events.push({ k: 'capped' });
      break;
    }
    default:
      throw new Error('unexpected ' + a.type);
  }
  p.acted = true;
  p.actedAt = s.currentBet;
  p.actedFull = s.fullLevel;
  advance(s, i);
}

function advance(s: HandState, from: number): void {
  if (live(s).length === 1) { endRound(s); return; }
  if (roundClosed(s)) { endRound(s); return; }
  for (let k = 1; k <= n(s); k++) {
    const j = (from + k) % n(s);
    const q = s.players[j];
    if (canAct(q) && (!q.acted || q.bet < s.currentBet)) { s.toAct = j; return; }
  }
  endRound(s);
}

function doDraw(s: HandState, i: number, discard: Card[]): void {
  const p = s.players[i];
  const set = new Set(discard);
  if (set.size !== discard.length) throw new Error('duplicate discard');
  for (const c of discard) if (!p.cards.includes(c)) throw new Error('discarding a card not in hand');
  const k = discard.length;
  if (s.stub.length < k) {
    // reshuffle the earlier discards (never this player's own, just thrown) into the stub
    const extra = shuffle(s.discards.slice(), new Stream(s.cfg.seed, 'reshuffle-' + s.reshuffles++));
    s.discards = [];
    s.stub.push(...extra);
    s.events.push({ k: 'reshuffle', cards: extra.length });
  }
  const kept = p.cards.filter(c => !set.has(c));
  const drawn = take(s, k);
  p.cards = kept.concat(drawn);
  p.up = p.cards.map(() => false);
  s.discards.push(...discard);
  s.events.push({ k: 'draw', p: i, discard: discard.slice(), kept: kept.slice(), drawn: drawn.slice() });
  s.drawOrder.shift();
  if (s.drawOrder.length) { s.toAct = s.drawOrder[0]; return; }
  beginRound(s);
}

/* ---------- invariants (used by tests and the fuzzer) --------------------- */

export function checkInvariants(s: HandState): string[] {
  const errs: string[] = [];
  const start = s.players.reduce((t, p) => t + p.start, 0);
  const now = s.players.reduce((t, p) => t + p.stack + (s.phase === 'done' ? 0 : p.total), 0);
  if (start !== now) errs.push('chips not conserved: ' + start + ' vs ' + now);
  for (const p of s.players) {
    if (p.stack < 0 || !Number.isInteger(p.stack)) errs.push(p.name + ' stack ' + p.stack);
    if (s.phase !== 'done' && p.allIn && p.stack !== 0) errs.push(p.name + ' all-in with chips');
  }
  // every card exactly once across hands, board, stub, discards
  const seen = new Set<Card>();
  const add = (c: Card, where: string) => { if (seen.has(c)) errs.push('card ' + c + ' twice (' + where + ')'); seen.add(c); };
  for (const p of s.players) for (const c of p.cards) add(c, p.name);
  for (const c of s.board) add(c, 'board');
  for (const c of s.stub) add(c, 'stub');
  for (const c of s.discards) add(c, 'discards');
  if (seen.size !== 52) errs.push('deck has ' + seen.size + ' cards');
  if (s.result) {
    const sum = s.result.net.reduce((a, b) => a + b, 0);
    if (sum !== 0) errs.push('net does not sum to zero: ' + sum);
  }
  return errs;
}
