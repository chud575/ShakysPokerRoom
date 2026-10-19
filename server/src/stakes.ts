/* One set of table stakes, expressed as the limit small bet / big bet, turned
   into the posts and bet sizes of whichever game is being dealt — so a mixed
   table (HORSE, 8-Game, dealer's choice) keeps one stake level across games. */

import type { GameDef, Structure } from '../../engine/src/games.ts';
import type { Stakes } from '../../engine/src/engine.ts';

export interface TableStakes {
  smallBet: number;          // limit small bet; also the big blind
  bigBet: number;            // limit big bet
  smallBlind?: number;       // default: half the small bet
  bigBlind?: number;         // default: the small bet
  ante?: number;             // stud ante, default a fifth of the small bet
  bringIn?: number;          // stud bring-in, default a quarter of the small bet
  flopAnte?: number;         // optional ante in flop/draw games
}

export function stakesFor(g: GameDef, _structure: Structure, t: TableStakes): Stakes {
  if (g.family === 'stud') {
    return {
      ante: t.ante ?? Math.max(1, Math.round(t.smallBet / 5)),
      bringIn: t.bringIn ?? Math.max(1, Math.round(t.smallBet / 4)),
      smallBet: t.smallBet, bigBet: t.bigBet, smallBlind: 0, bigBlind: 0,
    };
  }
  return {
    ante: t.flopAnte ?? 0,
    smallBlind: t.smallBlind ?? Math.floor(t.smallBet / 2),
    bigBlind: t.bigBlind ?? t.smallBet,
    bringIn: 0, smallBet: t.smallBet, bigBet: t.bigBet,
  };
}
