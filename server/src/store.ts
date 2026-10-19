/* Persistence.  Every hand is an event log: the hand's config (which carries
   the hand seed) plus its actions in order, written BEFORE anything is
   broadcast.  Replaying the log through the engine rebuilds the hand exactly,
   which is how the server recovers from a crash mid-hand.

   Chips live in clubs: a member's balance is per club, and every movement
   (issue, redeem, buy-in, rebuy, cash-out) is a ledger row.

   SQLite (node:sqlite, synchronous) for development and tests.  The schema is
   plain SQL so a Postgres adapter can implement the same interface for the
   hosted room. */

import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import type { Action, HandConfig, HandResult } from '../../engine/src/engine.ts';

export interface User { id: string; name: string }
export type Role = 'owner' | 'admin' | 'member';
export type MemberStatus = 'pending' | 'active' | 'removed';
export interface Club { id: string; name: string; ownerId: string; inviteCode: string; createdAt: string }
export interface Member { clubId: string; userId: string; name: string; role: Role; status: MemberStatus; balance: number; joinedAt: string }
export interface LedgerRow {
  id: number; clubId: string; userId: string; name: string; delta: number; kind: LedgerKind;
  actorId: string | null; note: string | null; tableId: string | null; handId: number | null; at: string;
}
/** issue/redeem = an admin moving chips in or out of the club (settled off-platform);
    buyin/rebuy/cashout = chips moving between a member and a cash table;
    tbuyin/trefund/tprize = tournament entry, refund (unregister/cancel), prize */
export type LedgerKind = 'issue' | 'redeem' | 'buyin' | 'rebuy' | 'cashout' | 'tbuyin' | 'trefund' | 'tprize';
const ZERO = (): Record<LedgerKind, number> => ({ issue: 0, redeem: 0, buyin: 0, rebuy: 0, cashout: 0, tbuyin: 0, trefund: 0, tprize: 0 });

export interface ReportRow {
  userId: string; name: string; role: Role; status: MemberStatus;
  issued: number; redeemed: number; buyins: number; cashouts: number;
  /** cashouts - buyins over the period: what the member won or lost at the tables */
  played: number;
  balance: number;
}

export interface StoredHand {
  id: number;
  tableId: string;
  config: HandConfig;
  serverSeed: string;
  commitment: string;
  clientSeeds: string[];
  actions: Action[];
  done: boolean;
}

const SCHEMA = `
create table if not exists users (
  id text primary key, name text not null unique, token text unique, created_at text not null
);
create table if not exists clubs (
  id text primary key, name text not null, owner_id text not null, invite_code text not null unique, created_at text not null
);
create table if not exists members (
  club_id text not null, user_id text not null, role text not null, status text not null,
  balance integer not null default 0, joined_at text not null,
  primary key (club_id, user_id)
);
create table if not exists ledger (
  id integer primary key autoincrement, club_id text not null, user_id text not null, delta integer not null,
  kind text not null, actor_id text, note text, table_id text, hand_id integer, at text not null
);
create index if not exists ledger_club on ledger(club_id, at);
create table if not exists tables (
  id text primary key, club_id text not null, config text not null, state text not null, closed integer not null default 0
);
create table if not exists hands (
  id integer primary key autoincrement, table_id text not null, config text not null,
  server_seed text not null, commitment text not null, client_seeds text not null,
  started_at text not null, ended_at text, result text, history text
);
create table if not exists actions (
  hand_id integer not null, seq integer not null, action text not null, at text not null,
  primary key (hand_id, seq)
);
create index if not exists hands_table on hands(table_id, id);
create table if not exists tournaments (
  id text primary key, club_id text not null, config text not null, state text not null,
  status text not null, created_at text not null
);
create index if not exists tournaments_club on tournaments(club_id, created_at);
create table if not exists sessions (
  token_hash text primary key, user_id text not null, created_at text not null, expires_at integer not null
);
create table if not exists handoffs (
  nonce text primary key, at integer not null
);
`;
const VERSION = 2;

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';        // no 0/O/1/I
function code(n: number): string {
  const b = randomBytes(n);
  return [...b].map(x => CODE_CHARS[x % CODE_CHARS.length]).join('');
}
const now = () => new Date().toISOString();

export class Store {
  db: DatabaseSync;

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec('pragma journal_mode = wal; pragma synchronous = full; pragma foreign_keys = on;');
    const v = Number((this.db.prepare('pragma user_version').get() as any).user_version);
    const fresh = !(this.db.prepare("select name from sqlite_master where type = 'table' and name = 'users'").get());
    if (!fresh && v < VERSION) throw new Error('database is from an older version of the room (before clubs) — move it aside and start fresh');
    this.db.exec(SCHEMA);
    this.db.exec('pragma user_version = ' + VERSION);
  }

  /** run `f` atomically; nests (savepoints), so callers can compose */
  private depth = 0;
  tx<T>(f: () => T): T {
    const sp = 'sp' + this.depth++;
    this.db.exec('savepoint ' + sp);
    try { const r = f(); this.db.exec('release ' + sp); return r; }
    catch (e) { this.db.exec('rollback to ' + sp); this.db.exec('release ' + sp); throw e; }
    finally { this.depth--; }
  }

  /* ---- users ---- */

  createUser(id: string, name: string, token: string): User {
    this.db.prepare('insert into users (id, name, token, created_at) values (?, ?, ?, ?)').run(id, name, token, now());
    return { id, name };
  }
  user(id: string): User | null {
    const r = this.db.prepare('select id, name from users where id = ?').get(id) as any;
    return r ? { id: r.id, name: r.name } : null;
  }
  userByToken(token: string): User | null {
    const r = this.db.prepare('select id, name from users where token = ?').get(token) as any;
    return r ? { id: r.id, name: r.name } : null;
  }

  /** a ShakyBets account arriving through a sign-in pass: create or rename */
  upsertUser(id: string, name: string): User {
    const cur = this.user(id);
    let want = name.slice(0, 24) || id;
    // names are unique in the room; a clash (another account took it) gets a suffix
    for (let k = 2; this.db.prepare('select 1 from users where name = ? and id <> ?').get(want, id); k++) want = name.slice(0, 20) + '-' + k;
    if (!cur) this.db.prepare('insert into users (id, name, token, created_at) values (?, ?, null, ?)').run(id, want, now());
    else if (cur.name !== want) this.db.prepare('update users set name = ? where id = ?').run(want, id);
    return { id, name: want };
  }
  /** a pass may be used once; false if this nonce was seen before */
  useNonce(nonce: string, atSec: number): boolean {
    this.db.prepare('delete from handoffs where at < ?').run(atSec - 3600);
    try { this.db.prepare('insert into handoffs (nonce, at) values (?, ?)').run(nonce, atSec); return true; }
    catch { return false; }
  }
  createSession(tokenHash: string, userId: string, expiresAtSec: number): void {
    this.db.prepare('insert into sessions (token_hash, user_id, created_at, expires_at) values (?, ?, ?, ?)').run(tokenHash, userId, now(), expiresAtSec);
  }
  sessionUser(tokenHash: string, nowSec: number): User | null {
    const r = this.db.prepare('select u.id, u.name from sessions s join users u on u.id = s.user_id where s.token_hash = ? and s.expires_at > ?').get(tokenHash, nowSec) as any;
    return r ? { id: r.id, name: r.name } : null;
  }
  endSession(tokenHash: string): void { this.db.prepare('delete from sessions where token_hash = ?').run(tokenHash); }

  /* ---- clubs & members ---- */

  createClub(ownerId: string, name: string): Club {
    const id = 'c' + code(10).toLowerCase();
    let invite = code(8);
    while (this.clubByCode(invite)) invite = code(8);
    this.tx(() => {
      this.db.prepare('insert into clubs (id, name, owner_id, invite_code, created_at) values (?, ?, ?, ?, ?)').run(id, name, ownerId, invite, now());
      this.db.prepare("insert into members (club_id, user_id, role, status, balance, joined_at) values (?, ?, 'owner', 'active', 0, ?)").run(id, ownerId, now());
    });
    return this.club(id)!;
  }
  private clubRow(r: any): Club { return { id: r.id, name: r.name, ownerId: r.owner_id, inviteCode: r.invite_code, createdAt: r.created_at }; }
  club(id: string): Club | null {
    const r = this.db.prepare('select * from clubs where id = ?').get(id) as any;
    return r ? this.clubRow(r) : null;
  }
  clubByCode(invite: string): Club | null {
    const r = this.db.prepare('select * from clubs where invite_code = ?').get(invite.toUpperCase().trim()) as any;
    return r ? this.clubRow(r) : null;
  }
  newInviteCode(clubId: string): string {
    let invite = code(8);
    while (this.clubByCode(invite)) invite = code(8);
    this.db.prepare('update clubs set invite_code = ? where id = ?').run(invite, clubId);
    return invite;
  }
  private memberRow(r: any): Member {
    return { clubId: r.club_id, userId: r.user_id, name: r.name, role: r.role, status: r.status, balance: Number(r.balance), joinedAt: r.joined_at };
  }
  member(clubId: string, userId: string): Member | null {
    const r = this.db.prepare('select m.*, u.name from members m join users u on u.id = m.user_id where club_id = ? and user_id = ?').get(clubId, userId) as any;
    return r ? this.memberRow(r) : null;
  }
  members(clubId: string): Member[] {
    return (this.db.prepare("select m.*, u.name from members m join users u on u.id = m.user_id where club_id = ? order by case m.status when 'pending' then 0 when 'active' then 1 else 2 end, u.name").all(clubId) as any[])
      .map(r => this.memberRow(r));
  }
  /** clubs a user belongs to (any status), with their club role and balance */
  clubsOf(userId: string): (Club & { role: Role; status: MemberStatus; balance: number })[] {
    return (this.db.prepare('select c.*, m.role, m.status, m.balance from members m join clubs c on c.id = m.club_id where m.user_id = ? order by c.name').all(userId) as any[])
      .map(r => ({ ...this.clubRow(r), role: r.role, status: r.status, balance: Number(r.balance) }));
  }
  /** ask to join; an owner/admin approves.  Re-asking after removal asks again. */
  requestJoin(clubId: string, userId: string): Member {
    const m = this.member(clubId, userId);
    if (m && m.status !== 'removed') return m;
    if (m) this.db.prepare("update members set status = 'pending', role = 'member' where club_id = ? and user_id = ?").run(clubId, userId);
    else this.db.prepare("insert into members (club_id, user_id, role, status, balance, joined_at) values (?, ?, 'member', 'pending', 0, ?)").run(clubId, userId, now());
    return this.member(clubId, userId)!;
  }
  setMember(clubId: string, userId: string, change: { role?: Role; status?: MemberStatus }): Member {
    if (change.role) this.db.prepare('update members set role = ? where club_id = ? and user_id = ?').run(change.role, clubId, userId);
    if (change.status) this.db.prepare('update members set status = ? where club_id = ? and user_id = ?').run(change.status, clubId, userId);
    return this.member(clubId, userId)!;
  }

  /* ---- the club chip ledger ---- */

  /** Move club chips for a member.  Every movement is one ledger row; a
      balance can never go negative. */
  adjust(clubId: string, userId: string, delta: number, kind: LedgerKind,
         opts: { actorId?: string; note?: string; tableId?: string; handId?: number } = {}): number {
    if (!Number.isInteger(delta) || delta === 0) throw new Error('bad amount');
    return this.tx(() => {
      const m = this.member(clubId, userId);
      if (!m) throw new Error('not a member of this club');
      if (m.balance + delta < 0) throw new Error('insufficient balance');
      this.db.prepare('update members set balance = balance + ? where club_id = ? and user_id = ?').run(delta, clubId, userId);
      this.db.prepare('insert into ledger (club_id, user_id, delta, kind, actor_id, note, table_id, hand_id, at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(clubId, userId, delta, kind, opts.actorId ?? null, opts.note ?? null, opts.tableId ?? null, opts.handId ?? null, now());
      return m.balance + delta;
    });
  }
  balance(clubId: string, userId: string): number { return this.member(clubId, userId)?.balance ?? 0; }

  ledger(clubId: string, q: { userId?: string; from?: string; to?: string; limit?: number } = {}): LedgerRow[] {
    const where = ['l.club_id = ?'], args: any[] = [clubId];
    if (q.userId) { where.push('l.user_id = ?'); args.push(q.userId); }
    if (q.from) { where.push('l.at >= ?'); args.push(q.from); }
    if (q.to) { where.push('l.at < ?'); args.push(q.to); }
    args.push(Math.min(q.limit ?? 500, 5000));
    return (this.db.prepare(`select l.*, u.name from ledger l join users u on u.id = l.user_id where ${where.join(' and ')} order by l.id desc limit ?`).all(...args) as any[])
      .map(r => ({ id: Number(r.id), clubId: r.club_id, userId: r.user_id, name: r.name, delta: Number(r.delta), kind: r.kind, actorId: r.actor_id, note: r.note, tableId: r.table_id, handId: r.hand_id == null ? null : Number(r.hand_id), at: r.at }));
  }

  /** per-member totals over [from, to) — what the club owner settles from */
  report(clubId: string, from?: string, to?: string): ReportRow[] {
    const sums = new Map<string, Record<LedgerKind, number>>();
    const rows = this.db.prepare(`select user_id, kind, sum(delta) s from ledger where club_id = ? and at >= ? and at < ? group by user_id, kind`)
      .all(clubId, from ?? '', to ?? '9999') as any[];
    for (const r of rows) {
      const k = sums.get(r.user_id) ?? ZERO();
      k[r.kind as LedgerKind] = Number(r.s);
      sums.set(r.user_id, k);
    }
    return this.members(clubId).map(m => {
      const k = sums.get(m.userId) ?? ZERO();
      // cash games and tournaments together; a refund cancels its tournament buy-in
      const buyins = -(k.buyin + k.rebuy + k.tbuyin + k.trefund), cashouts = k.cashout + k.tprize;
      return { userId: m.userId, name: m.name, role: m.role, status: m.status, issued: k.issue, redeemed: -k.redeem, buyins, cashouts, played: cashouts - buyins, balance: m.balance };
    });
  }

  /** chips the club has put into play: issued minus redeemed (all time) */
  outstanding(clubId: string): number {
    const r = this.db.prepare("select coalesce(sum(delta), 0) s from ledger where club_id = ? and kind in ('issue', 'redeem')").get(clubId) as any;
    return Number(r.s);
  }
  sumBalances(clubId: string): number {
    const r = this.db.prepare('select coalesce(sum(balance), 0) s from members where club_id = ?').get(clubId) as any;
    return Number(r.s);
  }

  /* ---- tournaments ---- */

  saveTourney(id: string, clubId: string, config: unknown, state: { status: string }): void {
    this.db.prepare(`insert into tournaments (id, club_id, config, state, status, created_at) values (?, ?, ?, ?, ?, ?)
      on conflict(id) do update set state = excluded.state, status = excluded.status`)
      .run(id, clubId, JSON.stringify(config), JSON.stringify(state), state.status, now());
  }
  /** tournaments still registering or running (finished ones stay for the record) */
  liveTourneys(): { config: any; state: any }[] {
    return (this.db.prepare("select config, state from tournaments where status in ('registering', 'running') order by created_at").all() as any[])
      .map(r => ({ config: JSON.parse(r.config), state: JSON.parse(r.state) }));
  }
  tourney(id: string): { config: any; state: any } | null {
    const r = this.db.prepare('select config, state from tournaments where id = ?').get(id) as any;
    return r ? { config: JSON.parse(r.config), state: JSON.parse(r.state) } : null;
  }
  recentTourneys(clubId: string, limit = 20): { config: any; state: any }[] {
    return (this.db.prepare("select config, state from tournaments where club_id = ? and status in ('finished', 'cancelled') order by created_at desc limit ?").all(clubId, limit) as any[])
      .map(r => ({ config: JSON.parse(r.config), state: JSON.parse(r.state) }));
  }

  /* ---- tables ---- */

  saveTable(id: string, clubId: string, config: unknown, state: unknown): void {
    this.db.prepare('insert into tables (id, club_id, config, state) values (?, ?, ?, ?) on conflict(id) do update set config = excluded.config, state = excluded.state')
      .run(id, clubId, JSON.stringify(config), JSON.stringify(state));
  }
  saveTableState(id: string, state: unknown): void {
    this.db.prepare('update tables set state = ? where id = ?').run(JSON.stringify(state), id);
  }
  tableClub(id: string): string | null {
    const r = this.db.prepare('select club_id from tables where id = ?').get(id) as any;
    return r?.club_id ?? null;
  }
  closeTable(id: string): void {
    this.db.prepare('update tables set closed = 1 where id = ?').run(id);
  }
  /** open tables (closed ones stay in the database for their hand histories) */
  tables(): { id: string; config: any; state: any }[] {
    return (this.db.prepare('select id, config, state from tables where closed = 0 order by id').all() as any[])
      .map(r => ({ id: r.id, config: JSON.parse(r.config), state: JSON.parse(r.state) }));
  }

  /* ---- hands (the event log) ---- */

  /** allocate the next hand id (the config's handId is this number) */
  nextHandId(): number {
    const r = this.db.prepare("select coalesce(max(id), 0) + 1 n from hands").get() as any;
    return Number(r.n);
  }
  startHand(id: number, tableId: string, config: HandConfig, serverSeed: string, commitment: string, clientSeeds: string[]): void {
    this.db.prepare('insert into hands (id, table_id, config, server_seed, commitment, client_seeds, started_at) values (?, ?, ?, ?, ?, ?, ?)')
      .run(id, tableId, JSON.stringify(config), serverSeed, commitment, JSON.stringify(clientSeeds), new Date().toISOString());
  }
  appendAction(handId: number, seq: number, action: Action): void {
    this.db.prepare('insert into actions (hand_id, seq, action, at) values (?, ?, ?, ?)')
      .run(handId, seq, JSON.stringify(action), new Date().toISOString());
  }
  finishHand(handId: number, result: HandResult, history: string): void {
    this.db.prepare('update hands set ended_at = ?, result = ?, history = ? where id = ?')
      .run(new Date().toISOString(), JSON.stringify(result), history, handId);
  }
  hand(id: number): StoredHand | null {
    const r = this.db.prepare('select * from hands where id = ?').get(id) as any;
    if (!r) return null;
    const actions = (this.db.prepare('select action from actions where hand_id = ? order by seq').all(id) as any[])
      .map(a => JSON.parse(a.action));
    return {
      id: Number(r.id), tableId: r.table_id, config: JSON.parse(r.config), serverSeed: r.server_seed,
      commitment: r.commitment, clientSeeds: JSON.parse(r.client_seeds), actions, done: r.ended_at != null,
    };
  }
  /** the unfinished hand at a table, if the server stopped mid-hand */
  openHand(tableId: string): StoredHand | null {
    const r = this.db.prepare('select id from hands where table_id = ? and ended_at is null order by id desc limit 1').get(tableId) as any;
    return r ? this.hand(Number(r.id)) : null;
  }
  history(handId: number): string | null {
    const r = this.db.prepare('select history from hands where id = ?').get(handId) as any;
    return r?.history ?? null;
  }
  handIds(tableId: string): number[] {
    return (this.db.prepare('select id from hands where table_id = ? order by id').all(tableId) as any[]).map(r => Number(r.id));
  }
}
