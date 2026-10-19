import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, connect, botAct, table, makeClub, clubChipsBalance, type TestConn, type FakeClock } from './helpers.ts';
import type { Room } from '../src/room.ts';
import type { Store } from '../src/store.ts';
import { Stream } from '../../engine/src/rng.ts';

const last = (c: TestConn, t: string) => [...c.inbox].reverse().find(m => m.t === t);
const lastErr = (c: TestConn) => c.errors.at(-1)?.message;

function playUntil(room: Room, clock: FakeClock, conns: TestConn[], r: Stream, done: () => boolean, check?: () => void) {
  for (let step = 0; step < 100000 && !done(); step++) {
    room.flush();
    let acted = false;
    for (const c of conns) {
      for (const v of c.views.values()) {
        const h = v.hand;
        if (h && !h.done && h.legal) { room.handle(c, { t: 'act', tableId: v.id, handId: h.id, action: botAct(v, h.legal, r) }); acted = true; break; }
      }
      if (acted) break;
    }
    check?.();
    if (!acted) {
      // busted players rebuy (if their club balance allows) and sit back in
      for (const c of conns) for (const t of room.tables.values()) {
        const seat = t.seatOf(c.user!.id), s = seat ? t.st.seats[seat - 1] : null;
        if (s && s.stack === 0 && !t.hand) { room.handle(c, { t: 'addChips', tableId: t.id, amount: 300 }); room.handle(c, { t: 'sitOut', tableId: t.id, on: false }); }
      }
      clock.advance(1000);
    }
  }
  room.flush();
}

function invariant(room: Room, store: Store, clubId: string) {
  const { outstanding, held } = clubChipsBalance(room, store, clubId);
  assert.equal(held, outstanding, 'club chips: issued - redeemed must equal balances + chips on tables');
}

test('joining a club: invite code, pending until approved, then the tables open up', () => {
  const { store, room } = setup();
  for (const n of ['alice', 'bob']) store.createUser(n, n, n);
  const alice = connect(room, 'alice'), bob = connect(room, 'bob');
  room.handle(alice, { t: 'createClub', name: 'Thursday Game' });
  const page = last(alice, 'club');
  assert.equal(page.me.role, 'owner');
  assert.match(page.club.inviteCode, /^[A-Z2-9]{8}$/);
  const clubId = page.club.id;
  room.handle(alice, { t: 'createTable', clubId, table: { games: [{ game: 'holdem', structure: 'NL' }], smallBet: 20 } });
  const tableId = [...room.tables.keys()][0];

  room.handle(bob, { t: 'joinClub', code: 'NOPE1234' });
  assert.equal(lastErr(bob), 'no club has that invite code');
  room.handle(bob, { t: 'joinClub', code: page.club.inviteCode.toLowerCase() });
  assert.equal(last(bob, 'clubs').clubs[0].status, 'pending');
  assert.equal(last(alice, 'clubChanged').clubId, clubId, 'admins are told about the request');

  room.handle(bob, { t: 'lobby', clubId });
  assert.equal(lastErr(bob), 'your request to join is waiting for approval');
  room.handle(bob, { t: 'watch', tableId });
  assert.equal(lastErr(bob), 'your request to join is waiting for approval');

  room.handle(bob, { t: 'member', clubId, userId: 'bob', status: 'active' });
  assert.match(lastErr(bob)!, /waiting for approval/, 'cannot approve yourself');
  room.handle(alice, { t: 'member', clubId, userId: 'bob', status: 'active' });
  room.handle(bob, { t: 'lobby', clubId });
  assert.equal(last(bob, 'lobby').tables.length, 1);
  room.handle(bob, { t: 'club', clubId });
  assert.equal(last(bob, 'club').members, undefined, 'members list is for admins');
  assert.equal(last(bob, 'club').club.inviteCode, undefined, 'invite code is for admins');
});

test('roles: only admins move chips; only the owner makes admins; nobody touches the owner', () => {
  const { store, room } = setup();
  const clubId = makeClub(store, ['alice', 'bob', 'carol'], 0);
  const [alice, bob, carol] = ['alice', 'bob', 'carol'].map(n => connect(room, n));
  room.handle(bob, { t: 'chips', clubId, userId: 'bob', amount: 1000 });
  assert.equal(lastErr(bob), 'only the club owner or an admin can do that');
  room.handle(alice, { t: 'member', clubId, userId: 'carol', role: 'admin' });
  room.handle(carol, { t: 'chips', clubId, userId: 'bob', amount: 1000, note: 'paid $10 cash' });
  assert.equal(store.balance(clubId, 'bob'), 1000);
  assert.deepEqual(last(bob, 'balance'), { t: 'balance', clubId, balance: 1000 }, 'bob sees it at once');
  room.handle(carol, { t: 'member', clubId, userId: 'bob', role: 'admin' });
  assert.equal(lastErr(carol), 'only the owner can make admins');
  room.handle(carol, { t: 'member', clubId, userId: 'alice', status: 'removed' });
  assert.equal(lastErr(carol), "the owner's membership can't be changed");
  room.handle(carol, { t: 'chips', clubId, userId: 'bob', amount: -1500 });
  assert.equal(lastErr(carol), 'bob only has 1000 chips off the tables');
  room.handle(carol, { t: 'chips', clubId, userId: 'bob', amount: -400, note: 'paid out $4' });
  assert.equal(store.balance(clubId, 'bob'), 600);
  const rows = store.ledger(clubId);
  assert.deepEqual(rows.map(r => [r.kind, r.delta, r.actorId, r.note]), [['redeem', -400, 'carol', 'paid out $4'], ['issue', 1000, 'carol', 'paid $10 cash']]);
  room.handle(bob, { t: 'ledger', clubId, userId: 'carol' });
  assert.ok(last(bob, 'ledger').rows.every((r: any) => r.userId === 'bob'), 'members only see their own rows');
});

test('clubs are walled off: their tables, hands and chips', () => {
  const { store, clock, room } = setup();
  const a = makeClub(store, ['alice', 'bob'], 5000, 'A');
  room.createTable(table('ta', [{ game: 'holdem', structure: 'NL' }]));
  const b = makeClub(store, ['carol', 'dave'], 5000, 'B');
  room.createTable(table('tb', [{ game: 'holdem', structure: 'NL' }]));
  const [alice, bob, carol] = ['alice', 'bob', 'carol'].map(n => connect(room, n));
  room.handle(alice, { t: 'watch', tableId: 'tb' });
  assert.equal(lastErr(alice), 'not a member of this club');
  room.handle(alice, { t: 'sit', tableId: 'tb', seat: 1, buyIn: 500 });
  assert.equal(lastErr(alice), 'not a member of this club');
  room.handle(alice, { t: 'chips', clubId: b, userId: 'alice', amount: 100 });
  assert.equal(lastErr(alice), 'not a member of this club');
  // a hand at club A cannot be read by club B
  room.handle(alice, { t: 'sit', tableId: 'ta', seat: 1, buyIn: 500 });
  room.handle(bob, { t: 'sit', tableId: 'ta', seat: 2, buyIn: 500 });
  playUntil(room, clock, [alice, bob], new Stream('81'.repeat(32), 'iso'), () => room.tables.get('ta')!.st.handsPlayed >= 2 && !room.tables.get('ta')!.hand);
  const hid = store.handIds('ta')[0];
  room.handle(carol, { t: 'history', handId: hid });
  assert.equal(lastErr(carol), 'not your hand');
  assert.equal(store.balance(b, 'carol'), 5000);
  invariant(room, store, a); invariant(room, store, b);
});

test('the ledger always balances: play, issue, redeem, rebuys, removal mid-hand, closing a table', () => {
  const { store, clock, room } = setup();
  const names = ['alice', 'bob', 'carol', 'dave', 'erin'];
  const clubId = makeClub(store, names, 3000);
  room.createTable(table('t1', [{ game: 'holdem', structure: 'NL' }], { minBuyIn: 100, maxBuyIn: 2000 }));
  room.createTable(table('t2', [{ game: 'razz', structure: 'FL' }, { game: 'td27', structure: 'FL' }], { minBuyIn: 100, maxBuyIn: 2000 }));
  const conns = names.map(n => connect(room, n));
  const [alice] = conns;
  conns.forEach((c, i) => room.handle(c, { t: 'sit', tableId: i < 3 ? 't1' : 't2', seat: 1 + (i % 3), buyIn: 800 }));
  room.handle(alice, { t: 'sit', tableId: 't2', seat: 3, buyIn: 900 });      // alice plays both tables
  const r = new Stream('82'.repeat(32), 'ledger');
  let checks = 0;
  const check = () => { invariant(room, store, clubId); checks++; };
  const t1 = room.tables.get('t1')!, t2 = room.tables.get('t2')!;

  playUntil(room, clock, conns, r, () => t1.st.handsPlayed >= 15, check);
  room.handle(alice, { t: 'chips', clubId, userId: 'erin', amount: 2500 });              // erin buys more chips
  room.handle(alice, { t: 'chips', clubId, userId: 'bob', amount: -store.balance(clubId, 'bob') }); // bob cashes out what is off-table
  check();
  // remove dave mid-hand: he leaves t2 (cashed out when the hand ends)
  playUntil(room, clock, conns, r, () => !!t2.hand && t2.handIndex('dave') >= 0, check);
  room.handle(alice, { t: 'member', clubId, userId: 'dave', status: 'removed' });
  assert.equal(t2.st.seats[t2.seatOf('dave') - 1]?.leaving ?? true, true);
  playUntil(room, clock, conns, r, () => t2.seatOf('dave') === 0, check);
  room.handle(conns[3], { t: 'sit', tableId: 't1', seat: 4, buyIn: 100 });
  assert.equal(lastErr(conns[3]), 'not a member of this club');
  room.handle(alice, { t: 'chips', clubId, userId: 'dave', amount: -store.balance(clubId, 'dave') });   // pay dave out
  assert.equal(store.balance(clubId, 'dave'), 0);
  check();
  // close t1 mid-hand
  playUntil(room, clock, conns, r, () => !!t1.hand && t1.hand.seq > 1, check);
  assert.ok(t1.hand && t1.hand.seq > 1, 'a hand is in progress at t1');
  room.handle(alice, { t: 'closeTable', tableId: 't1' });
  assert.ok(room.tables.has('t1'), 'stays until the hand in progress ends');
  playUntil(room, clock, conns, r, () => !room.tables.has('t1'), check);
  assert.ok(!room.tables.has('t1'), 'closed table is gone once empty');
  room.handle(alice, { t: 'lobby', clubId });
  assert.deepEqual(last(alice, 'lobby').tables.map((x: any) => x.id), ['t2']);
  playUntil(room, clock, conns, r, () => t2.st.handsPlayed >= 30, check);
  // everybody leaves: the report is zero-sum and squares with the balances
  for (const c of conns) room.handle(c, { t: 'leave', tableId: 't2' });
  playUntil(room, clock, conns, r, () => t2.isEmpty(), check);
  room.handle(alice, { t: 'report', clubId });
  const rep = last(alice, 'report');
  assert.equal(rep.rows.reduce((a: number, x: any) => a + x.played, 0), 0, 'what members won equals what others lost');
  for (const x of rep.rows) assert.equal(x.balance, x.issued - x.redeemed + x.played, x.name + ': balance = issued - redeemed + played');
  assert.equal(rep.outstanding, store.sumBalances(clubId));
  assert.ok(checks > 500, 'invariant checked ' + checks + ' times');
});

test('regression: folding then leaving mid-hand does not refund chips you already put in', () => {
  const { store, clock, room } = setup();
  const clubId = makeClub(store, ['alice', 'bob', 'carol'], 5000);
  room.createTable(table('t', [{ game: 'holdem', structure: 'NL' }]));
  const conns = ['alice', 'bob', 'carol'].map(n => connect(room, n));
  conns.forEach((c, i) => room.handle(c, { t: 'sit', tableId: 't', seat: i + 1, buyIn: 1000 }));
  clock.advance(0); room.flush();
  const t = room.tables.get('t')!;
  // whoever acts first raises, the next folds … make a small blind fold after posting, then leave
  const sbIdx = t.hand!.state.players.length === 2 ? t.hand!.state.btn : (t.hand!.state.btn + 1) % 3;
  const sb = t.hand!.state.players[sbIdx];
  const conn = (id: string) => conns[['alice', 'bob', 'carol'].indexOf(id)];
  let guard = 0;
  while (t.hand && t.hand.state.players[t.hand.state.toAct].id !== sb.id && guard++ < 10) {
    const p = t.hand.state.players[t.hand.state.toAct];
    room.handle(conn(p.id), { t: 'act', tableId: 't', handId: t.hand.id, action: { type: 'call' } });
  }
  room.handle(conn(sb.id), { t: 'act', tableId: 't', handId: t.hand!.id, action: { type: 'fold' } });
  assert.ok(t.hand && t.hand.state.phase !== 'done', 'hand still running');
  room.handle(conn(sb.id), { t: 'leave', tableId: 't' });
  invariant(room, store, clubId);
  playUntil(room, clock, conns, new Stream('83'.repeat(32), 'fold-leave'), () => t.seatOf(sb.id) === 0, () => invariant(room, store, clubId));
  assert.equal(store.balance(clubId, sb.id), 5000 - 10, 'lost exactly the small blind');
});

test('admins open tables with validation; members cannot', () => {
  const { store, room } = setup();
  const clubId = makeClub(store, ['alice', 'bob'], 0);
  const [alice, bob] = ['alice', 'bob'].map(n => connect(room, n));
  room.handle(bob, { t: 'createTable', clubId, table: { games: [{ game: 'holdem' }], smallBet: 20 } });
  assert.equal(lastErr(bob), 'only the club owner or an admin can do that');
  room.handle(alice, { t: 'createTable', clubId, table: { games: [{ game: 'chess' }], smallBet: 20 } });
  assert.equal(lastErr(alice), 'unknown game chess');
  room.handle(alice, { t: 'createTable', clubId, table: { games: [{ game: 'stud', structure: 'NL' }], smallBet: 20 } });
  assert.equal(lastErr(alice), '7 Card Stud cannot be played NL');
  room.handle(alice, { t: 'createTable', clubId, table: { name: 'Mixed Draw', games: [{ game: 'td27' }, { game: 'badugi' }, { game: 'a5td' }], smallBet: 40, maxSeats: 9 } });
  const t = [...room.tables.values()].find(x => x.cfg.name === 'Mixed Draw')!;
  assert.equal(t.cfg.maxSeats, 6, 'capped at what every game in the mix seats');
  assert.equal(t.cfg.clubId, clubId);
  assert.deepEqual([t.cfg.minBuyIn, t.cfg.maxBuyIn, t.cfg.handsPerGame], [800, 4000, 6]);
});
