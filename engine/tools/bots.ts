/* Random-but-legal bots for fuzzing.  They pick only from legalActions(),
   with sizes spread across the whole legal range so min-raises, pot-sized
   bets, all-ins and short all-ins all get exercised. */

import type { Action, HandState, Legal } from '../src/engine.ts';
import type { Stream } from '../src/rng.ts';

export function botAction(s: HandState, L: Legal, r: Stream): Action {
  if (L.draw) {
    const cards = s.players[L.player].cards;
    const k = r.int(cards.length + 1);
    const pool = cards.slice();
    const discard = [];
    for (let i = 0; i < k; i++) discard.push(pool.splice(r.int(pool.length), 1)[0]);
    return { type: 'draw', discard };
  }
  if (L.bringIn != null) return L.raise && r.int(4) === 0 ? { type: 'raise', amount: L.raise.min } : { type: 'bringin' };

  const roll = r.int(100);
  const sized = (x: { min: number; max: number; only?: number[] }) => {
    if (x.only) return x.only[r.int(x.only.length)];
    const pick = r.int(4);
    if (pick === 0 || x.max === x.min) return x.min;
    if (pick === 1) return x.max;
    return x.min + r.int(x.max - x.min + 1);
  };
  if (roll < 12 && L.fold && L.call) return { type: 'fold' };
  if (roll < 70) return L.call ? { type: 'call' } : { type: 'check' };
  if (L.bet) return { type: 'bet', amount: sized(L.bet) };
  if (L.raise) return { type: 'raise', amount: sized(L.raise) };
  return L.call ? { type: 'call' } : { type: 'check' };
}
