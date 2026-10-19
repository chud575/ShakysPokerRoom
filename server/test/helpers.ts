/* Test kit: a fake clock, in-process connections, bots that play from the
   views the server sends (so they only ever know what a real client knows),
   and a hole-card leak check run on every view message. */

import { Room, type Conn } from '../src/room.ts';
import { Store } from '../src/store.ts';
import type { Clock, TableConfig } from '../src/table.ts';
import type { TableView } from '../src/views.ts';
import { Stream } from '../../engine/src/rng.ts';
import { cardStr, parseCard } from '../../engine/src/cards.ts';
import type { Legal } from '../../engine/src/engine.ts';

export class FakeClock implements Clock {
  t = Date.UTC(2026, 9, 19, 16);
  private timers: { at: number; f: () => void; id: number }[] = [];
  private nid = 0;
  now() { return this.t; }
  set(ms: number, f: () => void) { const id = ++this.nid; this.timers.push({ at: this.t + ms, f, id }); return id; }
  clear(h: unknown) { this.timers = this.timers.filter(x => x.id !== h); }
  /** run every timer due within `ms` (in time order) */
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const x = this.timers[0];
      if (!x || x.at > end) break;
      this.timers.shift();
      this.t = Math.max(this.t, x.at);
      x.f();
    }
    this.t = end;
  }
  pending() { return this.timers.length; }
}

export class TestConn implements Conn {
  user = null as Conn['user'];
  clientSeed = '';
  watching = new Set<string>();
  inbox: any[] = [];
  views = new Map<string, TableView>();
  errors: any[] = [];
  onMessage: ((m: any) => void) | null = null;
  send(msg: any) {
    const m = JSON.parse(JSON.stringify(msg));     // what would go over the wire
    this.inbox.push(m);
    if (m.t === 'table') this.views.set(m.view.id, m.view);
    if (m.t === 'error') this.errors.push(m);
    this.onMessage?.(m);
  }
}

export const BASE = { minBuyIn: 100, maxBuyIn: 5000, actionSeconds: 20, timeBankSeconds: 30, betweenHandsMs: 1000 };

export function setup(dbPath = ':memory:') {
  const store = new Store(dbPath);
  const clock = new FakeClock();
  const room = new Room(store, clock);
  return { store, clock, room };
}

export function connect(room: Room, token: string): TestConn {
  const c = new TestConn();
  room.connect(c);
  room.handle(c, { t: 'hello', token, clientSeed: 'seed-' + token });
  return c;
}

/** choose an action from what the view shows (own cards + legal) */
export function botAct(v: TableView, L: Legal, r: Stream) {
  if (L.draw) {
    const mine = v.seats[v.mySeat - 1]!.cards.filter((c): c is string => c != null);
    const k = r.int(mine.length + 1);
    const pool = mine.slice(), discard: number[] = [];
    for (let i = 0; i < k; i++) discard.push(parseCard(pool.splice(r.int(pool.length), 1)[0]));
    return { type: 'draw', discard };
  }
  if (L.bringIn != null) return r.int(4) === 0 && L.raise ? { type: 'raise', amount: L.raise.min } : { type: 'bringin' };
  const roll = r.int(100);
  const size = (x: { min: number; max: number; only?: number[] }) =>
    x.only ? x.only[r.int(x.only.length)] : r.int(3) === 0 ? x.max : x.min + r.int(x.max - x.min + 1);
  if (roll < 12 && L.call) return { type: 'fold' };
  if (roll < 70) return L.call ? { type: 'call' } : { type: 'check' };
  if (L.bet) return { type: 'bet', amount: size(L.bet) };
  if (L.raise) return { type: 'raise', amount: size(L.raise) };
  return L.call ? { type: 'call' } : { type: 'check' };
}

/** Hole-card secrecy: compare a view against the server's real hand. */
export function leaks(room: Room, viewerId: string | null, v: TableView): string[] {
  const t = room.tables.get(v.id)!;
  const live = t.hand ?? t.last;
  if (!live || !v.hand || live.id !== v.hand.id) return [];
  const hs = live.state;
  const shown = new Set<number>();
  for (const e of hs.events) if (e.k === 'show') shown.add(e.p);
  const out: string[] = [];
  v.seats.forEach(sv => {
    if (!sv) return;
    const pi = hs.players.findIndex(p => p.seat === sv.seat);
    if (pi < 0) { if (sv.cards.some(c => c)) out.push('cards for a seat not in the hand'); return; }
    const p = hs.players[pi];
    sv.cards.forEach((c, j) => {
      if (c == null) return;
      const allowed = p.id === viewerId || p.up[j] || shown.has(pi);
      if (!allowed) out.push(`${viewerId ?? 'watcher'} sees ${p.name}'s ${c}`);
      if (c !== cardStr(p.cards[j])) out.push('wrong card shown');
    });
  });
  // the log must not name unshown hidden cards of others either
  const secret = new Set<string>();
  hs.players.forEach((p, pi) => {
    if (p.id === viewerId || shown.has(pi)) return;
    p.cards.forEach((c, j) => { if (!p.up[j]) secret.add(cardStr(c)); });
    for (const e of hs.events) if (e.k === 'draw' && e.p === pi) for (const c of e.discard) secret.add(cardStr(c));
  });
  // a secret card may still appear legitimately if the viewer saw it elsewhere (own discards
  // reshuffled to another player); only flag cards the viewer never held or saw face up
  const vi = hs.players.findIndex(p => p.id === viewerId);
  const mineEver = new Set<string>();
  if (vi >= 0) for (const e of hs.events) {
    if (e.k === 'deal' && e.p === vi) e.cards.forEach(c => mineEver.add(cardStr(c)));
    if (e.k === 'draw' && e.p === vi) [...e.discard, ...e.drawn].forEach(c => mineEver.add(cardStr(c)));
  }
  // cards tabled at showdown are public (a reshuffled discard may be shown by its new owner)
  for (const e of hs.events) if (e.k === 'show') e.cards.forEach(c => mineEver.add(cardStr(c)));
  for (const line of v.hand.log) for (const m of line.matchAll(/\b([2-9TJQKA][cdhs])\b/g)) {
    if (secret.has(m[1]) && !mineEver.has(m[1]) && !hs.board.map(cardStr).includes(m[1])) {
      const upSomewhere = hs.players.some(p => p.cards.some((c, j) => p.up[j] && cardStr(c) === m[1]));
      if (!upSomewhere) out.push(`log shows hidden ${m[1]} to ${viewerId ?? 'watcher'}: ${line}`);
    }
  }
  return out;
}

export function table(id: string, games: TableConfig['games'], extra: Partial<TableConfig> = {}): TableConfig {
  return { id, name: id, maxSeats: 6, games, handsPerGame: 3, stakes: { smallBet: 20, bigBet: 40 }, ...BASE, ...extra };
}
