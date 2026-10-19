/* Cards are integers 0..51: id = rank * 4 + suit.
   rank 0 = '2' … 12 = 'A';  suit 0..3 = c d h s.
   Same encoding as the Replayer's equity.js, so evaluators port verbatim. */

export type Card = number;

export const RANKS = '23456789TJQKA';
export const SUITS = 'cdhs';

export const rankOf = (c: Card): number => c >> 2;
export const suitOf = (c: Card): number => c & 3;
/** ace-low rank value: A = 0, 2 = 1 … K = 12 */
export const lowRank = (c: Card): number => { const r = c >> 2; return r === 12 ? 0 : r + 1; };

export function cardStr(c: Card): string {
  return RANKS[c >> 2] + SUITS[c & 3];
}

export function parseCard(s: string): Card {
  const r = RANKS.indexOf(s[0]), u = SUITS.indexOf(s[1]);
  if (s.length !== 2 || r < 0 || u < 0) throw new Error('bad card: ' + s);
  return r * 4 + u;
}

export const parseCards = (s: string): Card[] => s.trim().split(/\s+/).filter(Boolean).map(parseCard);
export const cardsStr = (cs: readonly Card[]): string => cs.map(cardStr).join(' ');

export function freshDeck(): Card[] {
  const d: Card[] = [];
  for (let i = 0; i < 52; i++) d.push(i);
  return d;
}
