/* The 13 games of the first release.  Everything game-specific the engine
   needs is data here; the betting/dealing machinery is shared. */

export type Family = 'flop' | 'stud' | 'draw';
export type Structure = 'FL' | 'PL' | 'NL';
/** how a hand is scored at showdown */
export type Rule =
  | 'high'          // hold'em, stud
  | 'omaha-high'    // exactly 2 hole + 3 board
  | 'omaha-hilo8'   // omaha, split with 8-or-better low
  | 'stud-hilo8'    // stud, split with 8-or-better low
  | 'razz'          // A-5 low, best 5 of 7
  | 'low27'         // 2-7 lowball, 5 cards
  | 'lowA5'         // A-5 lowball, 5 cards
  | 'badugi';

export interface GameDef {
  id: GameId;
  name: string;
  family: Family;
  rule: Rule;
  /** hole cards dealt (flop/draw); stud is always 7 over five streets */
  holeCards: number;
  /** draw rounds (draw family) */
  draws: number;
  structures: Structure[];
  defaultStructure: Structure;
  maxSeats: number;
  /** stud hi only: open pair on 4th street allows the big bet */
  openPairDouble: boolean;
  /** PokerStars game name, without the betting structure */
  psName: string;
}

export type GameId =
  | 'holdem' | 'omaha' | 'omaha8' | 'bigo' | 'plo5' | 'plo6'
  | 'stud' | 'stud8' | 'razz'
  | 'td27' | 'sd27' | 'a5td' | 'badugi';

const G = (d: GameDef): GameDef => d;

export const GAMES: Record<GameId, GameDef> = {
  holdem: G({ id: 'holdem', name: "Hold'em",          family: 'flop', rule: 'high',        holeCards: 2, draws: 0, structures: ['NL', 'FL', 'PL'], defaultStructure: 'NL', maxSeats: 10, openPairDouble: false, psName: "Hold'em" }),
  omaha:  G({ id: 'omaha',  name: 'Omaha',            family: 'flop', rule: 'omaha-high',  holeCards: 4, draws: 0, structures: ['PL', 'NL', 'FL'], defaultStructure: 'PL', maxSeats: 10, openPairDouble: false, psName: 'Omaha' }),
  omaha8: G({ id: 'omaha8', name: 'Omaha Hi/Lo',      family: 'flop', rule: 'omaha-hilo8', holeCards: 4, draws: 0, structures: ['FL', 'PL', 'NL'], defaultStructure: 'FL', maxSeats: 10, openPairDouble: false, psName: 'Omaha Hi/Lo' }),
  bigo:   G({ id: 'bigo',   name: 'Big O',            family: 'flop', rule: 'omaha-hilo8', holeCards: 5, draws: 0, structures: ['PL', 'FL', 'NL'], defaultStructure: 'PL', maxSeats: 9,  openPairDouble: false, psName: '5 Card Omaha Hi/Lo' }),
  plo5:   G({ id: 'plo5',   name: '5 Card PLO',       family: 'flop', rule: 'omaha-high',  holeCards: 5, draws: 0, structures: ['PL', 'NL', 'FL'], defaultStructure: 'PL', maxSeats: 9,  openPairDouble: false, psName: '5 Card Omaha' }),
  plo6:   G({ id: 'plo6',   name: '6 Card PLO',       family: 'flop', rule: 'omaha-high',  holeCards: 6, draws: 0, structures: ['PL', 'NL', 'FL'], defaultStructure: 'PL', maxSeats: 7,  openPairDouble: false, psName: '6 Card Omaha' }),
  stud:   G({ id: 'stud',   name: '7 Card Stud',      family: 'stud', rule: 'high',        holeCards: 7, draws: 0, structures: ['FL'],             defaultStructure: 'FL', maxSeats: 8,  openPairDouble: true,  psName: '7 Card Stud' }),
  stud8:  G({ id: 'stud8',  name: 'Stud Hi/Lo',       family: 'stud', rule: 'stud-hilo8',  holeCards: 7, draws: 0, structures: ['FL'],             defaultStructure: 'FL', maxSeats: 8,  openPairDouble: false, psName: '7 Card Stud Hi/Lo' }),
  razz:   G({ id: 'razz',   name: 'Razz',             family: 'stud', rule: 'razz',        holeCards: 7, draws: 0, structures: ['FL'],             defaultStructure: 'FL', maxSeats: 8,  openPairDouble: false, psName: 'Razz' }),
  td27:   G({ id: 'td27',   name: '2-7 Triple Draw',  family: 'draw', rule: 'low27',       holeCards: 5, draws: 3, structures: ['FL', 'PL', 'NL'], defaultStructure: 'FL', maxSeats: 6,  openPairDouble: false, psName: 'Triple Draw 2-7 Lowball' }),
  sd27:   G({ id: 'sd27',   name: '2-7 Single Draw',  family: 'draw', rule: 'low27',       holeCards: 5, draws: 1, structures: ['NL', 'PL', 'FL'], defaultStructure: 'NL', maxSeats: 6,  openPairDouble: false, psName: 'Single Draw 2-7 Lowball' }),
  a5td:   G({ id: 'a5td',   name: 'A-5 Triple Draw',  family: 'draw', rule: 'lowA5',       holeCards: 5, draws: 3, structures: ['FL', 'PL', 'NL'], defaultStructure: 'FL', maxSeats: 6,  openPairDouble: false, psName: 'Triple Draw A-5 Lowball' }),
  badugi: G({ id: 'badugi', name: 'Badugi',           family: 'draw', rule: 'badugi',      holeCards: 4, draws: 3, structures: ['FL', 'PL', 'NL'], defaultStructure: 'FL', maxSeats: 6,  openPairDouble: false, psName: 'Badugi' }),
};

export const GAME_IDS = Object.keys(GAMES) as GameId[];

/** number of betting rounds in a hand */
export function bettingRounds(g: GameDef): number {
  return g.family === 'flop' ? 4 : g.family === 'stud' ? 5 : 1 + g.draws;
}

/** fixed limit: does betting round `r` (0-based) use the big bet? */
export function usesBigBet(g: GameDef, r: number): boolean {
  if (g.family === 'flop') return r >= 2;              // turn, river
  if (g.family === 'stud') return r >= 2;              // 5th street on
  return g.draws === 1 ? r >= 1 : r >= 2;              // after the 2nd draw (triple), after the draw (single)
}

export const structureName = (s: Structure): string =>
  s === 'NL' ? 'No Limit' : s === 'PL' ? 'Pot Limit' : 'Limit';
