/* Showdown: hand strength per game rule, side-pot construction and pot
   awarding with integer chips and a positional odd-chip rule. */

import { type Card, rankOf, suitOf } from './cards.ts';
import type { GameDef } from './games.ts';
import {
  evalHigh, eval27, lowA5_5, lowA5Best, low8Best, badugiEval, omahaHi, omahaLo8,
  describeHigh, describeLowA5, describe27, describeBadugi,
} from './evaluate.ts';

/** hi: bigger is better.  lo: smaller is better (null = no qualifying low). */
export interface Strength { hi: number | null; lo: number | null }

/** `cards` = the player's own cards; `board` = community cards (flop games,
    or the stud community card when the deck ran short). */
export function strength(g: GameDef, cards: readonly Card[], board: readonly Card[]): Strength {
  switch (g.rule) {
    case 'high':        return { hi: evalHigh(cards.concat(board)), lo: null };
    case 'omaha-high':  return { hi: omahaHi(cards, board), lo: null };
    case 'omaha-hilo8': return { hi: omahaHi(cards, board), lo: omahaLo8(cards, board) };
    case 'stud-hilo8': { const all = cards.concat(board); return { hi: evalHigh(all), lo: low8Best(all) }; }
    case 'razz':        return { hi: null, lo: lowA5Best(cards.concat(board)) };
    case 'low27':       return { hi: null, lo: eval27(cards) };
    case 'lowA5':       return { hi: null, lo: lowA5_5(cards) };
    case 'badugi':      return { hi: null, lo: badugiEval(cards) };
  }
}

/** split game: half the pot to the best high, half to the best qualifying low */
export const isSplit = (g: GameDef): boolean => g.rule === 'omaha-hilo8' || g.rule === 'stud-hilo8';

export function describe(g: GameDef, s: Strength): string {
  switch (g.rule) {
    case 'high': case 'omaha-high': return describeHigh(s.hi!);
    case 'omaha-hilo8': case 'stud-hilo8':
      return 'HI: ' + describeHigh(s.hi!) + (s.lo != null ? '; LO: ' + describeLowA5(s.lo) : '');
    case 'razz': case 'lowA5': return describeLowA5(s.lo!);
    case 'low27': return describe27(s.lo!);
    case 'badugi': return describeBadugi(s.lo!);
  }
}

export interface Pot { amount: number; eligible: number[] }

/** Main pot + side pots from each player's total contribution.  Folded
    players' chips are dead money in every pot their contribution reaches. */
export function buildPots(total: readonly number[], folded: readonly boolean[]): Pot[] {
  const levels = [...new Set(total.filter((t, i) => !folded[i] && t > 0))].sort((a, b) => a - b);
  const pots: Pot[] = [];
  let prev = 0;
  for (const L of levels) {
    let amount = 0;
    for (const t of total) amount += Math.min(t, L) - Math.min(t, prev);
    const eligible: number[] = [];
    total.forEach((t, i) => { if (!folded[i] && t >= L) eligible.push(i); });
    if (amount > 0) pots.push({ amount, eligible });
    prev = L;
  }
  // dead money above the highest live contribution (cannot normally happen
  // once uncalled bets are returned) goes to the last pot
  let dead = 0;
  for (const t of total) dead += Math.max(0, t - prev);
  if (dead && pots.length) pots[pots.length - 1].amount += dead;
  return pots;
}

export interface Award { player: number; amount: number; pot: number; half: 'all' | 'hi' | 'lo' }

/** Split `amount` among `winners` (already in odd-chip priority order). */
function split(amount: number, winners: number[], pot: number, half: Award['half'], out: Award[]): void {
  const base = Math.floor(amount / winners.length);
  let rem = amount - base * winners.length;
  for (const w of winners) {
    const a = base + (rem > 0 ? 1 : 0);
    if (rem > 0) rem--;
    if (a > 0) out.push({ player: w, amount: a, pot, half });
  }
}

/**
 * Award every pot.  `priority` orders players for odd chips (earlier = gets
 * the chip first).  Split games give the odd chip of a pot to the high half.
 */
export function awardPots(
  g: GameDef, pots: Pot[], strengths: readonly (Strength | null)[], priority: readonly number[],
): Award[] {
  const out: Award[] = [];
  const rank = new Map<number, number>();
  priority.forEach((p, i) => rank.set(p, i));
  const byPriority = (a: number, b: number) => (rank.get(a) ?? 99) - (rank.get(b) ?? 99);

  pots.forEach((pot, pi) => {
    const el = pot.eligible.filter(i => strengths[i]);
    const bestHi = (): number[] => {
      let b = -Infinity; for (const i of el) b = Math.max(b, strengths[i]!.hi!);
      return el.filter(i => strengths[i]!.hi === b).sort(byPriority);
    };
    const bestLo = (): number[] => {
      let b = Infinity; for (const i of el) { const l = strengths[i]!.lo; if (l != null && l < b) b = l; }
      return b === Infinity ? [] : el.filter(i => strengths[i]!.lo === b).sort(byPriority);
    };
    if (isSplit(g)) {
      const lo = bestLo();
      if (!lo.length) { split(pot.amount, bestHi(), pi, 'all', out); return; }
      const loAmt = Math.floor(pot.amount / 2), hiAmt = pot.amount - loAmt;   // odd chip to the high
      split(hiAmt, bestHi(), pi, 'hi', out);
      split(loAmt, lo, pi, 'lo', out);
    } else if (g.rule === 'high' || g.rule === 'omaha-high') {
      split(pot.amount, bestHi(), pi, 'all', out);
    } else {
      split(pot.amount, bestLo(), pi, 'all', out);
    }
  });
  return out;
}

/** stud odd-chip order: the player holding the highest card by suit first */
export function studPriority(players: readonly { cards: readonly Card[] }[], live: readonly number[]): number[] {
  const top = (cs: readonly Card[]) => cs.reduce((m, c) => Math.max(m, rankOf(c) * 4 + suitOf(c)), -1);
  return live.slice().sort((a, b) => top(players[b].cards) - top(players[a].cards));
}

export function potName(i: number, count: number): string {
  if (count === 1) return 'pot';
  if (i === 0) return 'main pot';
  return count === 2 ? 'side pot' : 'side pot-' + i;
}
