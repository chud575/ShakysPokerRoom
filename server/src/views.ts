/* What one viewer is allowed to see.  This is the ONLY place hand state is
   turned into something sent to a client, so hole-card secrecy lives here:
   a card leaves the server only if the viewer owns it, it is face up (stud),
   or it was shown at showdown. */

import { cardStr } from '../../engine/src/cards.ts';
import { legalActions, type Legal } from '../../engine/src/engine.ts';
import { GAMES } from '../../engine/src/games.ts';
import { handHistory } from '../../engine/src/hh.ts';
import type { Table } from './table.ts';
import type { Tournament } from './tournament.ts';

export interface SeatView {
  seat: number;
  name: string;
  stack: number;
  sittingOut: boolean;
  connected: boolean;
  inHand: boolean;
  folded: boolean;
  allIn: boolean;
  bet: number;
  /** null = a face-down card the viewer may not see */
  cards: (string | null)[];
  up: boolean[];
  timeBank: number;
}

export interface TableView {
  id: string;
  clubId: string;
  name: string;
  game: { id: string; name: string; structure: string };
  next: { id: string; name: string; structure: string } | null;   // after this rotation block
  stakes: { smallBet: number; bigBet: number };
  buyIn: { min: number; max: number };
  actionSeconds: number;
  /** server clock when this view was made (for countdowns) */
  now: number;
  maxSeats: number;
  /** tournament tables: the tournament and its current level */
  tourney: null | { id: string; name: string; level: number; sb: number; bb: number; ante: number; nextAt: number | null; remaining: number };
  mySeat: number;                // 0 = watching
  button: number;
  seats: (SeatView | null)[];
  hand: null | {
    id: number;
    commitment: string;
    done: boolean;
    board: string[];
    pot: number;                 // in the middle (bets in front not included)
    toAct: number;               // seat number, 0 = nobody
    deadline: number;
    street: string;
    /** this viewer's PokerStars-format history of the hand so far */
    log: string[];
    /** only when it is the viewer's turn */
    legal: Legal | null;
    /** revealed when the hand is over */
    serverSeed: string | null;
  };
}

export function viewFor(t: Table, userId: string | null): TableView {
  const cfg = t.cfg, st = t.st;
  const cur = t.current();
  const g = GAMES[cur.game];
  const mySeat = userId ? t.seatOf(userId) : 0;
  const live = t.hand ?? t.last;
  const hs = live?.state ?? null;

  // the game the CURRENT/last hand is in (rotation may already point past it)
  const handGame = hs ? GAMES[hs.cfg.game] : g;
  const nextIdx = st.rotation % cfg.games.length;
  const shown = new Set<number>();
  if (hs) for (const e of hs.events) if (e.k === 'show') shown.add(e.p);
  const viewerIdx = hs && userId ? hs.players.findIndex(p => p.id === userId) : -1;

  const seats: (SeatView | null)[] = st.seats.map((s, i) => {
    if (!s) return null;
    const seatNo = i + 1;
    const pi = hs ? hs.players.findIndex(p => p.seat === seatNo && p.id === s.userId) : -1;
    const p = pi >= 0 ? hs!.players[pi] : null;
    const see = (j: number) => pi === viewerIdx || (p!.up[j] ?? false) || shown.has(pi);
    return {
      seat: seatNo, name: s.name,
      stack: p && hs!.phase !== 'done' ? p.stack : s.stack,
      sittingOut: s.sittingOut, connected: t.connected.has(s.userId),
      inHand: !!p, folded: p?.folded ?? false, allIn: p?.allIn ?? false,
      bet: p && hs!.phase !== 'done' ? p.bet : 0,
      cards: p ? p.cards.map((c, j) => (see(j) ? cardStr(c) : null)) : [],
      up: p ? p.up.slice() : [],
      timeBank: Math.round(s.timeBank),
    };
  });

  let hand: TableView['hand'] = null;
  if (live && hs) {
    const toAct = hs.phase === 'done' || hs.toAct < 0 ? 0 : hs.players[hs.toAct].seat;
    const L = hs.phase !== 'done' && viewerIdx >= 0 && hs.toAct === viewerIdx ? legalActions(hs) : null;
    const lastStreet = [...hs.events].reverse().find(e => e.k === 'street');
    hand = {
      id: live.id, commitment: live.commitment, done: hs.phase === 'done',
      board: hs.board.map(cardStr),                 // flop board, or stud's community card
      pot: hs.players.reduce((a, p) => a + p.total - (hs.phase === 'done' ? 0 : p.bet), 0),
      toAct, deadline: toAct ? live.deadline : 0,
      street: hs.phase === 'draw' ? 'draw' : lastStreet && lastStreet.k === 'street' ? lastStreet.street : '',
      log: handHistory(hs, viewerIdx).trimEnd().split('\n'),
      legal: L,
      serverSeed: hs.phase === 'done' ? live.serverSeed : null,
    };
  }

  const nextGame = cfg.games.length > 1 ? cfg.games[nextIdx] : null;
  return {
    id: cfg.id, clubId: cfg.clubId, name: cfg.name,
    game: { id: handGame.id, name: handGame.name, structure: hs ? hs.cfg.structure : cur.structure },
    next: nextGame ? { id: nextGame.game, name: GAMES[nextGame.game].name, structure: nextGame.structure } : null,
    stakes: { smallBet: cfg.stakes.smallBet, bigBet: cfg.stakes.bigBet },
    buyIn: { min: cfg.minBuyIn, max: cfg.maxBuyIn }, actionSeconds: cfg.actionSeconds, now: t.clockNow(),
    maxSeats: cfg.maxSeats, mySeat,
    tourney: (() => {
      const d = t.director as unknown as Tournament | null;
      if (!d || !t.isTourney) return null;
      const i = d.levelIndex(), L = d.cfg.levels[i];
      return { id: d.cfg.id, name: d.cfg.name, level: i + 1, sb: L.sb, bb: L.bb, ante: L.ante, nextAt: d.nextLevelAt(), remaining: d.playing().length };
    })(), button: handGame.family === 'stud' ? 0 : st.button,
    seats, hand,
  };
}

/** lobby line for a table */
export function summaryOf(t: Table) {
  const cur = t.current();
  return {
    id: t.cfg.id, clubId: t.cfg.clubId, name: t.cfg.name,
    game: t.cfg.games.length > 1 ? (t.cfg.mixedName ?? 'Mixed') : GAMES[cur.game].name,
    structure: t.cfg.games.length > 1 ? 'mixed' : cur.structure,
    stakes: `${t.cfg.stakes.smallBet}/${t.cfg.stakes.bigBet}`,
    seated: t.st.seats.filter(Boolean).length, maxSeats: t.cfg.maxSeats,
  };
}
