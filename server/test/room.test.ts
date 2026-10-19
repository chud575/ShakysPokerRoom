import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup, connect, botAct, leaks, table, makeClub, clubChipsBalance, TestConn, type FakeClock } from './helpers.ts';
import { Room } from '../src/room.ts';
import { Store } from '../src/store.ts';
import { Stream, handSeed, commitment } from '../../engine/src/rng.ts';
import { GAME_IDS, GAMES } from '../../engine/src/games.ts';

const NAMES = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank'];
const GRANT = 100_000;

let CLUB = '';
function users(store: Store, n = 6) {
  CLUB = makeClub(store, NAMES.slice(0, n), GRANT);
}

/** total chips anywhere in the club: balances + stacks at tables (+ chips in a live hand) */
function chipsEverywhere(room: Room, store: Store, n: number): number {
  const { outstanding, held } = clubChipsBalance(room, store, CLUB);
  assert.equal(outstanding, n * GRANT, 'issued chips');
  return held;
}

/** play until `hands` hands have finished at `tableId` (bots act from their views) */
function play(room: Room, clock: FakeClock, conns: TestConn[], r: Stream, until: () => boolean, maxSteps = 200000) {
  for (let step = 0; step < maxSteps && !until(); step++) {
    room.flush();
    let acted = false;
    for (const c of conns) {
      for (const v of c.views.values()) {
        const h = v.hand;
        if (h && !h.done && h.legal) {
          room.handle(c, { t: 'act', tableId: v.id, handId: h.id, action: botAct(v, h.legal, r) });
          acted = true; break;
        }
      }
      if (acted) break;
    }
    if (!acted) {
      // busted bots rebuy so the game keeps going
      for (const c of conns) for (const t of room.tables.values()) {
        const seat = t.seatOf(c.user!.id), s = seat ? t.st.seats[seat - 1] : null;
        if (s && s.stack === 0 && !t.hand) {
          room.handle(c, { t: 'addChips', tableId: t.id, amount: 1000 });
          room.handle(c, { t: 'sitOut', tableId: t.id, on: false });
        }
      }
      clock.advance(1000);
    }
  }
  room.flush();
}

function watchForLeaks(room: Room, conns: TestConn[], problems: string[]) {
  for (const c of conns) c.onMessage = m => { if (m.t === 'table') problems.push(...leaks(room, c.user?.id ?? null, m.view)); };
}

test('every game: bots play from their views; chips conserved; no hole-card leaks', () => {
  for (const game of GAME_IDS) {
    const g = GAMES[game];
    const { store, clock, room } = setup();
    users(store);
    const seats = Math.min(6, g.maxSeats);
    room.createTable(table('t', [{ game, structure: g.defaultStructure }], { maxSeats: seats }));
    const conns = NAMES.slice(0, seats).map(u => connect(room, u));
    store.createUser('rail', 'rail', 'rail'); store.requestJoin(CLUB, 'rail'); store.setMember(CLUB, 'rail', { status: 'active' });
    const watcher = connect(room, 'rail'); room.handle(watcher, { t: 'watch', tableId: 't' });
    const problems: string[] = [];
    watchForLeaks(room, [...conns, watcher], problems);
    conns.forEach((c, i) => room.handle(c, { t: 'sit', tableId: 't', seat: i + 1, buyIn: 300 + 400 * i }));
    const r = new Stream('33'.repeat(32), game);
    const t = room.tables.get('t')!;
    play(room, clock, conns, r, () => t.st.handsPlayed >= 60 && !t.hand);
    assert.deepEqual(problems.slice(0, 3), [], game + ' leaks');
    assert.ok(t.st.handsPlayed >= 60, game + ' played ' + t.st.handsPlayed);
    assert.equal(chipsEverywhere(room, store, seats), seats * GRANT, game + ' chips');
    for (const c of conns) assert.deepEqual(c.errors.filter(e => e.code !== 'turn'), [], game + ' errors');
    room.close();
  }
});

test('mixed table rotates games and labels the history', () => {
  const { store, clock, room } = setup();
  users(store);
  room.createTable(table('horse', [{ game: 'holdem', structure: 'FL' }, { game: 'razz', structure: 'FL' }, { game: 'stud8', structure: 'FL' }], { handsPerGame: 2, mixedName: 'HORSE' }));
  const conns = NAMES.slice(0, 4).map(u => connect(room, u));
  conns.forEach((c, i) => room.handle(c, { t: 'sit', tableId: 'horse', seat: i + 1, buyIn: 2000 }));
  const t = room.tables.get('horse')!;
  play(room, clock, conns, new Stream('44'.repeat(32), 'mix'), () => t.st.handsPlayed >= 6 && !t.hand);
  const games = store.handIds('horse').slice(0, 6).map(id => store.hand(id)!.config.game);
  assert.deepEqual(games, ['holdem', 'holdem', 'razz', 'razz', 'stud8', 'stud8']);
  assert.match(store.history(store.handIds('horse')[2])!, /HORSE \(Razz Limit\)/);
});

test('timeout: auto check/fold, then sat out; time bank is spent first', () => {
  const { store, clock, room } = setup();
  users(store, 3);
  room.createTable(table('t', [{ game: 'holdem', structure: 'NL' }]));
  const conns = NAMES.slice(0, 3).map(u => connect(room, u));
  conns.forEach((c, i) => room.handle(c, { t: 'sit', tableId: 't', seat: i + 1, buyIn: 1000 }));
  clock.advance(0);
  const t = room.tables.get('t')!;
  const h = t.hand!;
  const who = h.state.players[h.state.toAct];
  clock.advance(20_000 + 29_000);                 // action time + most of the bank: still waiting
  assert.equal(t.hand?.id, h.id); assert.equal(t.hand!.state.players[t.hand!.state.toAct].id, who.id);
  clock.advance(2_000);
  const seat = t.st.seats[who.seat - 1]!;
  assert.equal(seat.sittingOut, true);
  assert.equal(seat.timeBank, 0);
  const ev = store.hand(h.id)!.actions[0];
  assert.deepEqual(ev, { type: 'fold' });          // facing the big blind: fold
});

test('illegal and out-of-turn actions are refused and change nothing', () => {
  const { store, clock, room } = setup();
  users(store, 2);
  room.createTable(table('t', [{ game: 'holdem', structure: 'NL' }]));
  const [a, b] = ['alice', 'bob'].map(u => connect(room, u));
  room.handle(a, { t: 'sit', tableId: 't', seat: 1, buyIn: 1000 });
  room.handle(b, { t: 'sit', tableId: 't', seat: 2, buyIn: 1000 });
  clock.advance(0);
  const t = room.tables.get('t')!;
  const h = t.hand!;
  const mover = h.state.players[h.state.toAct].id === 'alice' ? a : b;
  const other = mover === a ? b : a;
  const before = JSON.stringify(t.hand!.state);
  room.handle(other, { t: 'act', tableId: 't', handId: h.id, action: { type: 'call' }, ref: 1 });
  room.handle(mover, { t: 'act', tableId: 't', handId: h.id, action: { type: 'raise', amount: 5 }, ref: 2 });
  room.handle(mover, { t: 'act', tableId: 't', handId: h.id + 1, action: { type: 'call' }, ref: 3 });
  room.handle(mover, { t: 'bogus', ref: 4 });
  assert.deepEqual(other.errors.map(e => [e.code, e.ref]), [['turn', 1]]);
  assert.deepEqual(mover.errors.map(e => [e.code, e.ref]), [['illegal', 2], ['stale', 3], ['proto', 4]]);
  assert.equal(JSON.stringify(t.hand!.state), before);
  assert.equal(store.hand(h.id)!.actions.length, 0);
});

test('leaving mid-hand folds you and cashes out when the hand ends', () => {
  const { store, clock, room } = setup();
  users(store, 3);
  room.createTable(table('t', [{ game: 'holdem', structure: 'NL' }]));
  const conns = NAMES.slice(0, 3).map(u => connect(room, u));
  conns.forEach((c, i) => room.handle(c, { t: 'sit', tableId: 't', seat: i + 1, buyIn: 1000 }));
  clock.advance(0);
  const t = room.tables.get('t')!;
  const h = t.hand!;
  const leaver = h.state.players.find((p, i) => i !== h.state.toAct)!;      // not the one to act
  room.handle(conns[NAMES.indexOf(leaver.id)], { t: 'leave', tableId: 't' });
  assert.equal(t.st.seats[leaver.seat - 1]!.leaving, true);
  play(room, clock, conns, new Stream('55'.repeat(32), 'leave'), () => t.st.handsPlayed >= 2);
  assert.equal(t.seatOf(leaver.id), 0, 'seat freed');
  const after = store.hand(h.id)!;
  assert.ok(after.done);
  assert.equal(store.balance(CLUB, leaver.id), store.ledger(CLUB, { userId: leaver.id }).reduce((a, r) => a + r.delta, 0), 'ledger matches balance');
  assert.equal(chipsEverywhere(room, store, 3), 3 * GRANT);
});

test('crash mid-hand: a new server replays the event log and the hand carries on', () => {
  const dir = mkdtempSync(join(tmpdir(), 'room-'));
  const db = join(dir, 'room.db');
  let { store, clock, room } = setup(db);
  users(store, 4);
  room.createTable(table('t', [{ game: 'td27', structure: 'FL' }], { maxSeats: 4 }));
  let conns = NAMES.slice(0, 4).map(u => connect(room, u));
  conns.forEach((c, i) => room.handle(c, { t: 'sit', tableId: 't', seat: i + 1, buyIn: 1000 }));
  const r = new Stream('66'.repeat(32), 'crash');
  const t1 = room.tables.get('t')!;
  play(room, clock, conns, r, () => t1.st.handsPlayed >= 3 && !!t1.hand && t1.hand.seq >= 5);
  const midId = t1.hand!.id, midSeq = t1.hand!.seq, midState = JSON.stringify(t1.hand!.state);
  room.close();                                    // "crash": drop everything in memory

  const store2 = new Store(db);
  const clock2 = clock;
  const room2 = new Room(store2, clock2);
  const t2 = room2.tables.get('t')!;
  assert.equal(t2.hand!.id, midId);
  assert.equal(t2.hand!.seq, midSeq);
  assert.equal(JSON.stringify(t2.hand!.state), midState, 'replayed state is identical');
  conns = NAMES.slice(0, 4).map(u => connect(room2, u));
  for (const c of conns) room2.handle(c, { t: 'watch', tableId: 't' });
  play(room2, clock2, conns, r, () => t2.st.handsPlayed >= 8 && !t2.hand);
  assert.ok(store2.hand(midId)!.done);
  assert.equal(chipsEverywhere(room2, store2, 4), 4 * GRANT);
  room2.close();
});

test('history: your own view only, plus a fairness proof that checks out', () => {
  const { store, clock, room } = setup();
  users(store, 3);
  room.createTable(table('t', [{ game: 'holdem', structure: 'NL' }]));
  const conns = NAMES.slice(0, 3).map(u => connect(room, u));
  conns.forEach((c, i) => room.handle(c, { t: 'sit', tableId: 't', seat: i + 1, buyIn: 1000 }));
  const t = room.tables.get('t')!;
  play(room, clock, conns, new Stream('77'.repeat(32), 'hist'), () => t.st.handsPlayed >= 2 && !t.hand);
  const id = store.handIds('t')[0];
  room.handle(conns[0], { t: 'history', handId: id, ref: 'h' });
  const msg = conns[0].inbox.find(m => m.t === 'history' && m.ref === 'h');
  assert.ok(msg, 'history reply');
  const dealt = (msg.text as string).split('\n').filter(l => l.startsWith('Dealt to'));
  assert.deepEqual(dealt.map(l => l.split(' ')[2]), ['alice'], 'only your own hole cards');
  const p = msg.proof;
  assert.equal(createHash('sha256').update(Buffer.from(p.serverSeed, 'hex')).digest('hex'), p.commitment);
  assert.equal(commitment(p.serverSeed), p.commitment);
  assert.equal(handSeed(p.serverSeed, p.handId, p.clientSeeds), store.hand(id)!.config.seed, 'deck seed derives from the revealed seeds');
  // the commitment was published before the first action
  const firstView = conns[0].inbox.find(m => m.t === 'table' && m.view.hand?.id === id);
  assert.equal(firstView.view.hand.commitment, p.commitment);
  assert.equal(firstView.view.hand.serverSeed, null);
});

test('buy-ins come from the balance; cannot buy in for more than you have', () => {
  const { store, room } = setup();
  const club = makeClub(store, ['poor'], 150);
  room.createTable(table('t', [{ game: 'holdem', structure: 'NL' }]));
  const c = connect(room, 'poor');
  room.handle(c, { t: 'sit', tableId: 't', seat: 1, buyIn: 200, ref: 1 });
  assert.equal(c.errors[0]?.message, 'not enough chips in your club balance');
  assert.equal(room.tables.get('t')!.seatOf('poor'), 0);
  room.handle(c, { t: 'sit', tableId: 't', seat: 1, buyIn: 150 });
  assert.equal(store.balance(club, 'poor'), 0);
  room.handle(c, { t: 'leave', tableId: 't' });
  assert.equal(store.balance(club, 'poor'), 150);
});

