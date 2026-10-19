/* Hand evaluators, ported from the Replayer's equity.js (validated there
   against every showdown in the user's PokerStars history).  One change:
   evalHigh takes a `wheel` flag — in 2-7 lowball A-2-3-4-5 is NOT a straight
   (aces are high), so 2-7 scores with wheel = false.

   Conventions:  high values — bigger is better.
                 low values  — smaller is better.  null = no qualifying low. */

import { type Card, rankOf as rk, suitOf as st, lowRank as lowv } from './cards.ts';

export function pack(cat: number, a: number, b?: number, c?: number, d?: number, e?: number): number {
  return ((((cat * 16 + (a + 1)) * 16 + (b == null ? 0 : b + 1)) * 16 +
    (c == null ? 0 : c + 1)) * 16 + (d == null ? 0 : d + 1)) * 16 + (e == null ? 0 : e + 1);
}
export const categoryOf = (v: number): number => Math.floor(v / 1048576);

function straightFrom(mask: number, wheel: boolean): number {
  for (let hi = 12; hi >= 4; hi--) {
    const need = 0x1F << (hi - 4);
    if ((mask & need) === need) return hi;
  }
  if (wheel && (mask & 0x100F) === 0x100F) return 3;   // A-2-3-4-5, five high
  return -1;
}

/* ---------- best high hand from 5, 6 or 7 cards ------------------------ */
const _cnt = new Int8Array(13), _sc = new Int8Array(4), _sm = new Int32Array(4);
export function evalHigh(cards: readonly Card[], wheel = true): number {
  _cnt.fill(0); _sc.fill(0); _sm.fill(0);
  let mask = 0;
  for (let i = 0; i < cards.length; i++) {
    const id = cards[i], r = rk(id), s = st(id);
    _cnt[r]++; _sc[s]++; _sm[s] |= 1 << r; mask |= 1 << r;
  }
  let best = 0;
  for (let s = 0; s < 4; s++) {
    if (_sc[s] < 5) continue;
    const sh = straightFrom(_sm[s], wheel);
    if (sh >= 0) { const v = pack(8, sh); if (v > best) best = v; }
    else {
      const rs: number[] = [];
      for (let r = 12; r >= 0 && rs.length < 5; r--) if (_sm[s] & (1 << r)) rs.push(r);
      const v = pack(5, rs[0], rs[1], rs[2], rs[3], rs[4]); if (v > best) best = v;
    }
  }
  const sh = straightFrom(mask, wheel);
  if (sh >= 0) { const v = pack(4, sh); if (v > best) best = v; }

  let q = -1, t1 = -1, t2 = -1, p1 = -1, p2 = -1;
  for (let r = 12; r >= 0; r--) {
    const n = _cnt[r];
    if (n === 4) { if (q < 0) q = r; }
    else if (n === 3) { if (t1 < 0) t1 = r; else if (t2 < 0) t2 = r; }
    else if (n === 2) { if (p1 < 0) p1 = r; else if (p2 < 0) p2 = r; }
  }
  const kick = (skipA: number, skipB: number, n: number): number[] => {
    const out: number[] = [];
    for (let r = 12; r >= 0 && out.length < n; r--)
      if (_cnt[r] && r !== skipA && r !== skipB) out.push(r);
    return out;
  };
  let v: number;
  if (q >= 0) { const k = kick(q, -1, 1); v = pack(7, q, k[0]); if (v > best) best = v; }
  if (t1 >= 0 && (p1 >= 0 || t2 >= 0)) {
    const pr = (t2 > p1) ? t2 : p1;
    v = pack(6, t1, pr); if (v > best) best = v;
  }
  if (t1 >= 0) { const k = kick(t1, -1, 2); v = pack(3, t1, k[0], k[1]); if (v > best) best = v; }
  if (p1 >= 0 && p2 >= 0) { const k = kick(p1, p2, 1); v = pack(2, p1, p2, k[0]); if (v > best) best = v; }
  if (p1 >= 0) { const k = kick(p1, -1, 3); v = pack(1, p1, k[0], k[1], k[2]); if (v > best) best = v; }
  { const k = kick(-1, -1, 5); v = pack(0, k[0], k[1], k[2], k[3], k[4]); if (v > best) best = v; }
  return best;
}

/** 2-7 lowball: the worst high hand wins; aces high, no wheel.  Smaller = better. */
export const eval27 = (cards: readonly Card[]): number => evalHigh(cards, false);

/* ---------- ace-to-five lowball (pairs count, straights/flushes don't) --- */
export function lowA5_5(cards: readonly Card[]): number {
  const c = new Int8Array(13);
  for (let i = 0; i < 5; i++) c[lowv(cards[i])]++;
  let q = -1, t = -1, p1 = -1, p2 = -1;
  for (let r = 12; r >= 0; r--) {
    if (c[r] === 4) q = r; else if (c[r] === 3) t = r;
    else if (c[r] === 2) { if (p1 < 0) p1 = r; else p2 = r; }
  }
  const kick = (a: number, b: number, n: number): number[] => {
    const o: number[] = [];
    for (let r = 12; r >= 0 && o.length < n; r--) if (c[r] && r !== a && r !== b) o.push(r);
    return o;
  };
  if (q >= 0) { const k = kick(q, -1, 1); return pack(5, q, k[0]); }
  if (t >= 0 && p1 >= 0) return pack(4, t, p1);
  if (t >= 0) { const k = kick(t, -1, 2); return pack(3, t, k[0], k[1]); }
  if (p1 >= 0 && p2 >= 0) { const k = kick(p1, p2, 1); return pack(2, p1, p2, k[0]); }
  if (p1 >= 0) { const k = kick(p1, -1, 3); return pack(1, p1, k[0], k[1], k[2]); }
  const k = kick(-1, -1, 5);
  return pack(0, k[0], k[1], k[2], k[3], k[4]);
}

/** best A-5 low from 5..7 cards (razz) */
export function lowA5Best(cards: readonly Card[]): number {
  const seen = new Int8Array(13); let distinct = 0;
  for (let i = 0; i < cards.length; i++) { const v = lowv(cards[i]); if (!seen[v]) { seen[v] = 1; distinct++; } }
  if (distinct >= 5) {
    const r: number[] = [];
    for (let v = 0; v < 13 && r.length < 5; v++) if (seen[v]) r.push(v);
    return pack(0, r[4], r[3], r[2], r[1], r[0]);
  }
  let best = Infinity;
  const n = cards.length, five: Card[] = new Array(5);
  for (let a = 0; a < n - 4; a++) for (let b = a + 1; b < n - 3; b++)
    for (let c = b + 1; c < n - 2; c++) for (let d = c + 1; d < n - 1; d++)
      for (let e = d + 1; e < n; e++) {
        five[0] = cards[a]; five[1] = cards[b]; five[2] = cards[c]; five[3] = cards[d]; five[4] = cards[e];
        const v = lowA5_5(five); if (v < best) best = v;
      }
  return best;
}

/** 8-or-better low from 5..7 cards (stud 8), null if none */
export function low8Best(cards: readonly Card[]): number | null {
  const seen = new Int8Array(8);
  for (let i = 0; i < cards.length; i++) { const v = lowv(cards[i]); if (v <= 7) seen[v] = 1; }
  const r: number[] = [];
  for (let v = 0; v < 8 && r.length < 5; v++) if (seen[v]) r.push(v);
  if (r.length < 5) return null;
  return pack(0, r[4], r[3], r[2], r[1], r[0]);
}

/* ---------- badugi: more cards beats fewer, then lowest ranks (aces low) -- */
export function badugiEval(cards: readonly Card[]): number {
  let best = Infinity;
  const n = cards.length;
  for (let m = 1; m < (1 << n); m++) {
    let rmask = 0, smask = 0, ok = true, size = 0;
    const rs: number[] = [];
    for (let i = 0; i < n; i++) {
      if (!(m & (1 << i))) continue;
      const id = cards[i], v = lowv(id), s = st(id);
      if ((rmask & (1 << v)) || (smask & (1 << s))) { ok = false; break; }
      rmask |= 1 << v; smask |= 1 << s; rs.push(v); size++;
    }
    if (!ok) continue;
    rs.sort((x, y) => y - x);
    const v = ((4 - size) * 1048576) + pack(0, rs[0], rs[1], rs[2], rs[3]);
    if (v < best) best = v;
  }
  return best;
}

/* ---------- omaha: exactly two hole + three board (any hole count) ------- */
const B3 = [[0, 1, 2], [0, 1, 3], [0, 1, 4], [0, 2, 3], [0, 2, 4], [0, 3, 4], [1, 2, 3], [1, 2, 4], [1, 3, 4], [2, 3, 4]];
const pairCache = new Map<number, number[][]>();
function allPairs(n: number): number[][] {
  let p = pairCache.get(n);
  if (!p) { p = []; for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) p.push([i, j]); pairCache.set(n, p); }
  return p;
}
const _five: Card[] = new Array(5);
export function omahaHi(hole: readonly Card[], board: readonly Card[]): number {
  let best = 0;
  const hp = allPairs(hole.length);
  for (const [a, b] of hp) for (const [x, y, z] of B3) {
    _five[0] = hole[a]; _five[1] = hole[b]; _five[2] = board[x]; _five[3] = board[y]; _five[4] = board[z];
    const v = evalHigh(_five); if (v > best) best = v;
  }
  return best;
}
function low8Exact5(c: readonly Card[]): number | null {
  const seen = new Int8Array(8);
  for (let i = 0; i < 5; i++) { const v = lowv(c[i]); if (v > 7 || seen[v]) return null; seen[v] = 1; }
  const r: number[] = []; for (let v = 0; v < 8; v++) if (seen[v]) r.push(v);
  return pack(0, r[4], r[3], r[2], r[1], r[0]);
}
export function omahaLo8(hole: readonly Card[], board: readonly Card[]): number | null {
  let best: number | null = null;
  const hp = allPairs(hole.length);
  for (const [a, b] of hp) for (const [x, y, z] of B3) {
    _five[0] = hole[a]; _five[1] = hole[b]; _five[2] = board[x]; _five[3] = board[y]; _five[4] = board[z];
    const v = low8Exact5(_five); if (v != null && (best == null || v < best)) best = v;
  }
  return best;
}

/* ---------- partial boards (stud first-to-act) --------------------------
   Exposed cards only.  Straights and flushes never count on a partial board;
   pairs, two pair, trips and quads do.                                      */

/** high showing hand, bigger = better */
export function showingHigh(up: readonly Card[]): number {
  const c = new Int8Array(13);
  for (const id of up) c[rk(id)]++;
  let q = -1, t = -1, p1 = -1, p2 = -1;
  for (let r = 12; r >= 0; r--) {
    if (c[r] === 4) q = r; else if (c[r] === 3) t = r;
    else if (c[r] === 2) { if (p1 < 0) p1 = r; else p2 = r; }
  }
  const kick = (a: number, b: number): number[] => {
    const o: number[] = [];
    for (let r = 12; r >= 0; r--) if (c[r] && r !== a && r !== b) o.push(r);
    return o;
  };
  if (q >= 0) return pack(7, q);
  if (t >= 0) { const k = kick(t, -1); return pack(3, t, k[0]); }
  if (p1 >= 0 && p2 >= 0) return pack(2, p1, p2);
  if (p1 >= 0) { const k = kick(p1, -1); return pack(1, p1, k[0], k[1]); }
  const k = kick(-1, -1);
  return pack(0, k[0], k[1], k[2], k[3]);
}

/** A-5 low showing hand (razz), smaller = better; paired boards are worse */
export function showingLowA5(up: readonly Card[]): number {
  const c = new Int8Array(13);
  for (const id of up) c[lowv(id)]++;
  let q = -1, t = -1, p1 = -1, p2 = -1;
  for (let r = 12; r >= 0; r--) {
    if (c[r] === 4) q = r; else if (c[r] === 3) t = r;
    else if (c[r] === 2) { if (p1 < 0) p1 = r; else p2 = r; }
  }
  const kick = (a: number, b: number): number[] => {
    const o: number[] = [];
    for (let r = 12; r >= 0; r--) if (c[r] && r !== a && r !== b) o.push(r);
    return o;
  };
  if (q >= 0) return pack(5, q);
  if (t >= 0) { const k = kick(t, -1); return pack(3, t, k[0]); }
  if (p1 >= 0 && p2 >= 0) return pack(2, p1, p2);
  if (p1 >= 0) { const k = kick(p1, -1); return pack(1, p1, k[0], k[1]); }
  const k = kick(-1, -1);
  return pack(0, k[0], k[1], k[2], k[3]);
}

/* ---------- hand descriptions for hand histories ------------------------ */
const NAMES = ['Deuces', 'Threes', 'Fours', 'Fives', 'Sixes', 'Sevens', 'Eights', 'Nines', 'Tens', 'Jacks', 'Queens', 'Kings', 'Aces'];
const ONE = ['Deuce', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Jack', 'Queen', 'King', 'Ace'];
const digits = (v: number): number[] => {
  const o: number[] = [];
  for (let i = 4; i >= 0; i--) o.push(((v >> (4 * i)) & 15) - 1);
  return o;                                   // up to five ranks, -1 = unused
};

/** PokerStars-style description of a high value from evalHigh */
export function describeHigh(v: number): string {
  const cat = categoryOf(v), r = digits(v);
  switch (cat) {
    case 8: return r[0] === 12 ? 'a Royal Flush' : 'a straight flush, ' + ONE[r[0] - 4 < 0 ? 12 : r[0] - 4] + ' to ' + ONE[r[0]];
    case 7: return 'four of a kind, ' + NAMES[r[0]];
    case 6: return 'a full house, ' + NAMES[r[0]] + ' full of ' + NAMES[r[1]];
    case 5: return 'a flush, ' + ONE[r[0]] + ' high';
    case 4: return 'a straight, ' + (r[0] === 3 ? 'Ace' : ONE[r[0] - 4]) + ' to ' + ONE[r[0]];
    case 3: return 'three of a kind, ' + NAMES[r[0]];
    case 2: return 'two pair, ' + NAMES[r[0]] + ' and ' + NAMES[r[1]];
    case 1: return 'a pair of ' + NAMES[r[0]];
    default: return 'high card ' + ONE[r[0]];
  }
}

const LOWCH = 'A23456789TJQK';
/** "8,6,4,3,A" — for no-pair lows (A-5 encoding) */
export function describeLowA5(v: number): string {
  const r = digits(v);
  if (categoryOf(v) !== 0) return describeHighLike(v);
  return r.filter(x => x >= 0).map(x => LOWCH[x]).join(',');
}
function describeHighLike(v: number): string {
  // paired A-5 lows: describe the pairing in plain words
  const cat = categoryOf(v), r = digits(v);
  const nm = (x: number) => ['Aces', 'Deuces', 'Threes', 'Fours', 'Fives', 'Sixes', 'Sevens', 'Eights', 'Nines', 'Tens', 'Jacks', 'Queens', 'Kings'][x];
  if (cat === 1) return 'a pair of ' + nm(r[0]);
  if (cat === 2) return 'two pair, ' + nm(r[0]) + ' and ' + nm(r[1]);
  if (cat === 3) return 'three of a kind, ' + nm(r[0]);
  if (cat === 4) return 'a full house, ' + nm(r[0]) + ' full of ' + nm(r[1]);
  return 'four of a kind, ' + nm(r[0]);
}
/** 2-7: no-pair hands read "7,5,4,3,2" (ace high) */
export function describe27(v: number): string {
  if (categoryOf(v) !== 0) return describeHigh(v);
  return digits(v).filter(x => x >= 0).map(x => RANKS27[x]).join(',');
}
const RANKS27 = '23456789TJQKA';
export function describeBadugi(v: number): string {
  const size = 4 - Math.floor(v / 1048576);
  const r = digits(v % 1048576).filter(x => x >= 0).map(x => LOWCH[x]);
  return (size === 4 ? 'Badugi' : size + '-card') + ' ' + r.join(',');
}
