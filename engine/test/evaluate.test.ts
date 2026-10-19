/* Evaluators vs naive brute-force scorers written independently here.
   We only compare ORDER (which of two hands wins, or a tie) — encodings differ. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCards, rankOf, suitOf, lowRank, type Card } from '../src/cards.ts';
import { evalHigh, eval27, lowA5_5, lowA5Best, low8Best, badugiEval, omahaHi, omahaLo8, describeHigh } from '../src/evaluate.ts';
import { Stream, shuffle } from '../src/rng.ts';

type Tup = number[];
const cmp = (a: Tup, b: Tup): number => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] ?? -1) - (b[i] ?? -1); if (d) return Math.sign(d); } return 0; };
function combos<T>(xs: readonly T[], k: number): T[][] {
  const out: T[][] = [];
  const rec = (s: number, cur: T[]) => { if (cur.length === k) { out.push(cur.slice()); return; } for (let i = s; i < xs.length; i++) { cur.push(xs[i]); rec(i + 1, cur); cur.pop(); } };
  rec(0, []); return out;
}
/** grouped ranks: sort by (count desc, rank desc) */
function groups(ranks: number[]): { counts: number[]; order: number[] } {
  const m = new Map<number, number>();
  for (const r of ranks) m.set(r, (m.get(r) ?? 0) + 1);
  const g = [...m.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  return { counts: g.map(x => x[1]), order: g.map(x => x[0]) };
}
/** naive 5-card high: bigger tuple = better */
function naiveHigh5(cs: Card[], wheel: boolean): Tup {
  const rs = cs.map(rankOf);
  const flush = new Set(cs.map(suitOf)).size === 1;
  const u = [...new Set(rs)].sort((a, b) => b - a);
  let straight = -1;
  if (u.length === 5 && u[0] - u[4] === 4) straight = u[0];
  if (wheel && u.join() === '12,3,2,1,0') straight = 3;
  const { counts, order } = groups(rs);
  if (straight >= 0 && flush) return [8, straight];
  if (counts[0] === 4) return [7, ...order];
  if (counts[0] === 3 && counts[1] === 2) return [6, ...order];
  if (flush) return [5, ...u];
  if (straight >= 0) return [4, straight];
  if (counts[0] === 3) return [3, ...order];
  if (counts[0] === 2 && counts[1] === 2) return [2, ...order];
  if (counts[0] === 2) return [1, ...order];
  return [0, ...order];
}
const bestOf = (cs: Card[], k: number, f: (x: Card[]) => Tup, better: number): Tup =>
  combos(cs, k).map(f).reduce((a, b) => (cmp(b, a) === better ? b : a));
/** naive A-5 low 5 cards: SMALLER tuple = better */
function naiveA5(cs: Card[]): Tup {
  const { counts, order } = groups(cs.map(lowRank));
  const cat = counts[0] === 4 ? 5 : counts[0] === 3 && counts[1] === 2 ? 4 : counts[0] === 3 ? 3 : counts[0] === 2 && counts[1] === 2 ? 2 : counts[0] === 2 ? 1 : 0;
  return [cat, ...order];
}
function naiveLow8(cs: Card[]): Tup | null {
  let best: Tup | null = null;
  for (const c of combos(cs, 5)) {
    const r = c.map(lowRank);
    if (new Set(r).size !== 5 || r.some(x => x > 7)) continue;
    const t = r.sort((a, b) => b - a);
    if (!best || cmp(t, best) < 0) best = t;
  }
  return best;
}
function naiveBadugi(cs: Card[]): Tup {
  let best: Tup | null = null;
  for (let k = 4; k >= 1 && !best; k--) for (const c of combos(cs, k)) {
    if (new Set(c.map(lowRank)).size !== k || new Set(c.map(suitOf)).size !== k) continue;
    const t = [4 - k, ...c.map(lowRank).sort((a, b) => b - a)];
    if (!best || cmp(t, best) < 0) best = t;
  }
  return best!;
}

const st = new Stream('00'.repeat(32), 'eval-test');
const deal = (k: number): Card[] => shuffle(Array.from({ length: 52 }, (_, i) => i), st).slice(0, k);
const N = 6000;

function agree(label: string, k: number, fast: (c: Card[]) => number | null, naive: (c: Card[]) => Tup | null, biggerBetter: boolean) {
  test(label, () => {
    for (let t = 0; t < N; t++) {
      const both = deal(2 * k), a = both.slice(0, k), b = both.slice(k);
      const fa = fast(a), fb = fast(b), na = naive(a), nb = naive(b);
      assert.equal(fa == null, na == null, 'qualifier mismatch ' + a);
      if (fa == null || fb == null || na == null || nb == null) continue;
      const f = Math.sign(fa - fb) * (biggerBetter ? 1 : -1);
      const nv = cmp(na, nb) * (biggerBetter ? 1 : -1);
      assert.equal(f, nv, label + ': ' + a + ' vs ' + b);
    }
  });
}

agree('high 5 cards', 5, c => evalHigh(c), c => naiveHigh5(c, true), true);
agree('high 7 cards', 7, c => evalHigh(c), c => bestOf(c, 5, x => naiveHigh5(x, true), 1), true);
agree('2-7 lowball', 5, eval27, c => naiveHigh5(c, false), false);
agree('A-5 lowball 5 cards', 5, lowA5_5, naiveA5, false);
agree('razz best of 7', 7, lowA5Best, c => bestOf(c, 5, naiveA5, -1), false);
agree('8-or-better from 7', 7, low8Best, naiveLow8, false);
agree('badugi', 4, badugiEval, naiveBadugi, false);

for (const holes of [4, 5, 6]) {
  test('omaha hi/lo, ' + holes + ' hole cards', () => {
    for (let t = 0; t < 1500; t++) {
      const d = deal(5 + 2 * holes);
      const board = d.slice(0, 5), a = d.slice(5, 5 + holes), b = d.slice(5 + holes);
      const naiveHi = (h: Card[]) => { let best: Tup = [-1]; for (const two of combos(h, 2)) for (const three of combos(board, 3)) { const v = naiveHigh5([...two, ...three], true); if (cmp(v, best) > 0) best = v; } return best; };
      const naiveLo = (h: Card[]) => { let best: Tup | null = null; for (const two of combos(h, 2)) for (const three of combos(board, 3)) { const v = naiveLow8([...two, ...three]); if (v && (!best || cmp(v, best) < 0)) best = v; } return best; };
      assert.equal(Math.sign(omahaHi(a, board) - omahaHi(b, board)), cmp(naiveHi(a), naiveHi(b)));
      const la = omahaLo8(a, board), lb = omahaLo8(b, board), na = naiveLo(a), nb = naiveLo(b);
      assert.equal(la == null, na == null); assert.equal(lb == null, nb == null);
      if (la != null && lb != null) assert.equal(Math.sign(lb - la), cmp(nb!, na!));
    }
  });
}

test('2-7: A-2-3-4-5 is ace high, not a straight', () => {
  const wheel = eval27(parseCards('Ah 2c 3d 4s 5h'));
  const pair = eval27(parseCards('2h 2c 7d 5s 3h'));
  const ace = eval27(parseCards('Ah Kc 3d 4s 5h'));
  assert.ok(wheel < pair, 'ace-high no-pair beats a pair in 2-7');
  assert.ok(wheel < ace, 'A5432 beats AK543');
  assert.ok(eval27(parseCards('7h 5c 4d 3s 2h')) < eval27(parseCards('7h 6c 4d 3s 2h')), '75432 is the nuts');
  assert.ok(eval27(parseCards('6h 5c 4d 3s 2h')) > pair, '65432 is a straight');
});

test('descriptions', () => {
  assert.equal(describeHigh(evalHigh(parseCards('Ah Ad Kc 7s 2d'))), 'a pair of Aces');
  assert.equal(describeHigh(evalHigh(parseCards('Ah 2d 3c 4s 5d'))), 'a straight, Ace to Five');
  assert.equal(describeHigh(evalHigh(parseCards('2h 2d 2c 3s 3d'))), 'a full house, Deuces full of Threes');
});
