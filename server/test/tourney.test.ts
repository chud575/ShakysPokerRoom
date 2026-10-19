import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup, connect, botAct, makeClub, clubChipsBalance, TestConn, type FakeClock } from './helpers.ts';
import { Room } from '../src/room.ts';
import { Store } from '../src/store.ts';
import { payoutAmounts, payoutPct, defaultLevels, type Tournament } from '../src/tournament.ts';
import { Stream } from '../../engine/src/rng.ts';

const lastErr = (c: TestConn) => c.errors.at(-1)?.message;
const names = (n: number) => Array.from({ length: n }, (_, i) => 'p' + String(i + 1).padStart(2, '0'));

/** every invariant we can state about a running tournament */
function tourneyChecks(room: Room, tt: Tournament) {
  if (tt.st.status !== 'running') return;
  const seatedAt = new Map<string, string>();
  let chips = 0;
  for (const t of tt.tables()) {
    const live = t.hand && t.hand.state.phase !== 'done' ? t.hand.state : null;
    for (const s of t.st.seats) if (s) {
      assert.ok(!seatedAt.has(s.userId), s.userId + ' seated twice');
      seatedAt.set(s.userId, t.id);
      const p = live?.players.find(x => x.id === s.userId);
      chips += p ? p.stack + p.total : s.stack;
    }
  }
  for (const e of tt.st.entries) {
    if (e.status === 'playing') assert.equal(seatedAt.get(e.userId), e.tableId, e.userId + ' is where the director thinks');
    else assert.ok(!seatedAt.has(e.userId), e.userId + ' busted but still seated');
  }
  const seatedEver = tt.st.entries.filter(e => e.status !== 'registered').length;
  assert.equal(chips, seatedEver * tt.cfg.startingStack, 'tournament chips conserved');
}

/** bots play every table they are at; they follow 'moved' messages to their new table */
function playTourney(room: Room, clock: FakeClock, conns: TestConn[], r: Stream, done: () => boolean, check: () => void, maxSteps = 400000) {
  for (const c of conns) c.onMessage = m => { if (m.t === 'moved') room.handle(c, { t: 'watch', tableId: m.tableId }); };
  let step = 0;
  const tts = [...room.tourneys.values()];
  for (; step < maxSteps && !done(); step++) {
    room.flush();
    // like the real client: follow your seat (the tournament view says where it is)
    for (const c of conns) for (const tt of tts) {
      const e = tt.entry(c.user!.id);
      if (e?.tableId && !c.watching.has(e.tableId) && room.tables.has(e.tableId)) room.handle(c, { t: 'watch', tableId: e.tableId });
    }
    let acted = false;
    for (const c of conns) {
      for (const v of c.views.values()) {
        const h = v.hand;
        if (h && !h.done && h.legal) { room.handle(c, { t: 'act', tableId: v.id, handId: h.id, action: botAct(v, h.legal, r) }); acted = true; break; }
      }
      if (acted) break;
    }
    if (step % 25 === 0) check();
    if (!acted) clock.advance(1000);
  }
  room.flush();
  return step;
}

function invariant(room: Room, store: Store, clubId: string) {
  const { outstanding, held } = clubChipsBalance(room, store, clubId);
  assert.equal(held, outstanding, 'club chips balance (pools included)');
}

test('payouts and the default structure', () => {
  for (const n of [2, 3, 5, 9, 15, 25, 40, 100, 500]) {
    const pct = payoutPct(n);
    assert.ok(Math.abs(pct.reduce((a, b) => a + b, 0) - 100) < 1e-9, 'sums to 100 for ' + n);
    assert.ok(pct.every((p, i) => i === 0 || p <= pct[i - 1]), 'descending for ' + n);
    assert.ok(pct.length <= n, 'never pays more places than entrants');
    const amt = payoutAmounts(n * 1001, pct);
    assert.equal(amt.reduce((a, b) => a + b, 0), n * 1001, 'whole pool paid for ' + n);
  }
  const L = defaultLevels(3000);
  assert.deepEqual(L[0], { sb: 15, bb: 30, ante: 0 });
  assert.ok(L.every((l, i) => i === 0 || l.bb > L[i - 1].bb));
  assert.ok(L[3].ante > 0);
});

test('sit-and-go: registers into the pool, starts when full, pays 65/35', () => {
  const { store, clock, room } = setup();
  const ps = names(6);
  const clubId = makeClub(store, ['owner', ...ps], 10_000);
  const owner = connect(room, 'owner');
  room.handle(owner, { t: 'createTourney', clubId, tourney: { kind: 'sng', name: 'Six-max SNG', games: [{ game: 'holdem', structure: 'NL' }], buyIn: 1000, startingStack: 1500, maxPlayers: 6, seatsPerTable: 6, levelMinutes: 0.25 } });
  const tt = [...room.tourneys.values()][0];
  const conns = ps.map(n => connect(room, n));
  for (const c of conns.slice(0, 5)) room.handle(c, { t: 'register', tourneyId: tt.id });
  assert.equal(tt.st.status, 'registering');
  assert.equal(tt.st.pool, 5000);
  assert.equal(store.balance(clubId, 'p01'), 9000);
  room.handle(conns[4], { t: 'unregister', tourneyId: tt.id });
  assert.equal(store.balance(clubId, 'p05'), 10_000, 'refunded');
  room.handle(conns[4], { t: 'register', tourneyId: tt.id });
  invariant(room, store, clubId);
  room.handle(conns[5], { t: 'register', tourneyId: tt.id });
  assert.equal(tt.st.status, 'running', 'starts when the sixth registers');
  assert.equal(tt.tables().length, 1);
  room.handle(conns[0], { t: 'unregister', tourneyId: tt.id });
  assert.equal(lastErr(conns[0]), 'the tournament has started');
  room.handle(conns[0], { t: 'leave', tableId: tt.tables()[0].id });
  assert.match(lastErr(conns[0])!, /cannot leave a tournament/);

  const steps = playTourney(room, clock, conns, new Stream('91'.repeat(32), 'sng'), () => tt.st.status === 'finished',
    () => { tourneyChecks(room, tt); invariant(room, store, clubId); });
  assert.equal(tt.st.status, 'finished', 'finished in ' + steps + ' steps');
  const byPlace = tt.st.entries.slice().sort((a, b) => a.place! - b.place!);
  assert.deepEqual(byPlace.map(e => e.place), [1, 2, 3, 4, 5, 6].slice(0, byPlace.length).map((p, i) => byPlace[i].place), 'every entry placed');
  assert.equal(byPlace[0].place, 1);
  assert.equal(tt.st.entries.reduce((a, e) => a + (e.prize ?? 0), 0), 6000, 'pool paid in full');
  assert.equal(byPlace[0].prize, 3900); assert.equal(byPlace[1].prize, 2100);
  assert.equal(tt.st.pool, 0);
  assert.equal(room.tables.size, 0, 'tables gone');
  invariant(room, store, clubId);
  const rep = store.report(clubId);
  assert.equal(rep.reduce((a, r) => a + r.played, 0), 0, 'zero-sum');
  const hh = store.history(store.handIds(tt.cfg.id + '-1')[0])!;
  assert.match(hh, new RegExp('Tournament #' + tt.cfg.number + ', 1000\\+0 Hold\'em No Limit - Level I '));
});

test('multi-table: draw, balancing, breaking to a final table, late registration, payouts', () => {
  const { store, clock, room } = setup();
  const ps = names(44);
  const clubId = makeClub(store, ['owner', ...ps], 5000);
  const owner = connect(room, 'owner');
  room.handle(owner, { t: 'createTourney', clubId, tourney: { kind: 'mtt', name: 'Sunday Mixed', games: [{ game: 'holdem', structure: 'FL' }, { game: 'stud8', structure: 'FL' }],
    handsPerGame: 4, buyIn: 500, startingStack: 2000, maxPlayers: 60, seatsPerTable: 8, levelMinutes: 0.5, lateRegLevels: 2 } });
  const tt = [...room.tourneys.values()][0];
  const conns = ps.map(n => connect(room, n));
  for (const c of conns.slice(0, 40)) room.handle(c, { t: 'register', tourneyId: tt.id });
  room.handle(conns[0], { t: 'startTourney', tourneyId: tt.id });
  assert.equal(lastErr(conns[0]), 'only the club owner or an admin can do that');
  room.handle(owner, { t: 'startTourney', tourneyId: tt.id });
  assert.equal(tt.tables().length, 5);
  assert.deepEqual(tt.tables().map(t => t.playersSeated()), [8, 8, 8, 8, 8]);

  let maxTables = 5, sawFinalTable = false, lateDone = false;
  const check = () => {
    tourneyChecks(room, tt); invariant(room, store, clubId);
    const counts = tt.tables().filter(t => !tt.st.breaking.includes(t.id)).map(t => t.playersSeated());
    if (counts.length > 1 && tt.tables().every(t => !t.busy())) assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, 'balanced when idle: ' + counts);
    maxTables = Math.max(maxTables, tt.tables().length);
    if (tt.st.status === 'running' && tt.tables().length === 1) sawFinalTable = true;
    // late registration during level 1-2
    if (!lateDone && tt.lateRegOpen() && tt.levelIndex() === 1) {
      for (const c of conns.slice(40)) room.handle(c, { t: 'register', tourneyId: tt.id });
      lateDone = true;
    }
  };
  playTourney(room, clock, conns, new Stream('92'.repeat(32), 'mtt'), () => tt.st.status === 'finished', check);
  assert.equal(tt.st.status, 'finished');
  assert.ok(lateDone, 'late registration happened');
  assert.equal(tt.st.entries.length, 44);
  room.handle(owner, { t: 'register', tourneyId: tt.id });
  assert.ok(sawFinalTable, 'reached a final table');
  const places = tt.st.entries.map(e => e.place!).sort((a, b) => a - b);
  assert.equal(places[0], 1);
  assert.ok(places.every(p => p >= 1 && p <= 44));
  const paid = tt.st.entries.filter(e => e.prize).length;
  assert.equal(tt.st.entries.reduce((a, e) => a + (e.prize ?? 0), 0), 44 * 500, 'pool paid in full');
  assert.ok(paid >= 9, 'paid ' + paid + ' places');
  invariant(room, store, clubId);
});

test('MTT: cancel before the start refunds everyone; scheduled start with too few players cancels', () => {
  const { store, clock, room } = setup();
  const clubId = makeClub(store, ['owner', 'a', 'b'], 1000);
  const [owner, a] = ['owner', 'a'].map(n => connect(room, n));
  room.handle(owner, { t: 'createTourney', clubId, tourney: { kind: 'mtt', games: [{ game: 'razz' }], buyIn: 300, startingStack: 1500, minPlayers: 3, startAt: new Date(clock.now() + 60_000).toISOString() } });
  const t1 = [...room.tourneys.values()][0];
  room.handle(a, { t: 'register', tourneyId: t1.id });
  room.handle(owner, { t: 'register', tourneyId: t1.id });
  assert.equal(store.balance(clubId, 'a'), 700);
  clock.advance(61_000); room.flush();
  assert.equal(t1.st.status, 'cancelled', 'only 2 of the 3 needed');
  assert.equal(store.balance(clubId, 'a'), 1000);
  assert.ok(!room.tourneys.has(t1.id));
  room.handle(owner, { t: 'createTourney', clubId, tourney: { kind: 'mtt', games: [{ game: 'holdem' }], buyIn: 300, startingStack: 1500 } });
  const t2 = [...room.tourneys.values()][0];
  room.handle(a, { t: 'register', tourneyId: t2.id });
  room.handle(owner, { t: 'cancelTourney', tourneyId: t2.id });
  assert.equal(store.balance(clubId, 'a'), 1000);
  invariant(room, store, clubId);
  room.handle(owner, { t: 'createTourney', clubId, tourney: { kind: 'sng', games: [{ game: 'stud', structure: 'NL' }], startingStack: 1500 } });
  assert.equal(lastErr(owner), '7 Card Stud cannot be played NL');
});

test('crash in the middle of a multi-table tournament: it picks up and finishes', () => {
  const db = join(mkdtempSync(join(tmpdir(), 'tourney-')), 'room.db');
  let { store, clock, room } = setup(db);
  const ps = names(20);
  const clubId = makeClub(store, ['owner', ...ps], 2000);
  const owner = connect(room, 'owner');
  room.handle(owner, { t: 'createTourney', clubId, tourney: { kind: 'mtt', name: 'Crashy', games: [{ game: 'omaha', structure: 'PL' }], buyIn: 200, startingStack: 1000, seatsPerTable: 6, levelMinutes: 0.4 } });
  const tid = [...room.tourneys.values()][0].id;
  let conns = ps.map(n => connect(room, n));
  for (const c of conns) room.handle(c, { t: 'register', tourneyId: tid });
  room.handle(owner, { t: 'startTourney', tourneyId: tid });
  const r = new Stream('93'.repeat(32), 'crash');
  let tt = room.tourneys.get(tid)!;
  playTourney(room, clock, conns, r, () => tt.playing().length <= 12 && tt.tables().some(t => t.busy()), () => tourneyChecks(room, tt));
  const before = { playing: tt.playing().length, tables: tt.st.tables.slice() };
  room.close();

  const store2 = new Store(db);
  const room2 = new Room(store2, clock);
  tt = room2.tourneys.get(tid)!;
  assert.ok(tt, 'tournament restored');
  assert.equal(tt.playing().length, before.playing);
  tourneyChecks(room2, tt);
  conns = ps.map(n => connect(room2, n));
  for (const c of conns) for (const t of tt.tables()) room2.handle(c, { t: 'watch', tableId: t.id });
  playTourney(room2, clock, conns, r, () => tt.st.status === 'finished', () => { tourneyChecks(room2, tt); invariant(room2, store2, clubId); });
  assert.equal(tt.st.status, 'finished');
  assert.equal(tt.st.entries.reduce((a, e) => a + (e.prize ?? 0), 0), 20 * 200);
  invariant(room2, store2, clubId);
  room2.close();
});
