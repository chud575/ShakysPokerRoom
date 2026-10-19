/* Persistence.  Every hand is an event log: the hand's config (which carries
   the hand seed) plus its actions in order, written BEFORE anything is
   broadcast.  Replaying the log through the engine rebuilds the hand exactly,
   which is how the server recovers from a crash mid-hand.

   SQLite (node:sqlite, synchronous) for development and tests.  The schema is
   plain SQL so a Postgres adapter can implement the same interface for the
   hosted room. */

import { DatabaseSync } from 'node:sqlite';
import type { Action, HandConfig, HandResult } from '../../engine/src/engine.ts';

export interface User { id: string; name: string; balance: number }

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
  id text primary key, name text not null unique, token text unique, balance integer not null default 0
);
create table if not exists ledger (
  id integer primary key autoincrement, user_id text not null, delta integer not null,
  reason text not null, table_id text, hand_id integer, at text not null
);
create table if not exists tables (
  id text primary key, config text not null, state text not null
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
`;

export class Store {
  db: DatabaseSync;

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec('pragma journal_mode = wal; pragma synchronous = full;');
    this.db.exec(SCHEMA);
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

  /* ---- users & play-chip ledger ---- */

  createUser(id: string, name: string, token: string, balance = 0): User {
    this.db.prepare('insert into users (id, name, token, balance) values (?, ?, ?, 0)').run(id, name, token);
    if (balance) this.adjust(id, balance, 'grant');
    return this.user(id)!;
  }
  user(id: string): User | null {
    const r = this.db.prepare('select id, name, balance from users where id = ?').get(id) as any;
    return r ? { id: r.id, name: r.name, balance: Number(r.balance) } : null;
  }
  userByToken(token: string): User | null {
    const r = this.db.prepare('select id, name, balance from users where token = ?').get(token) as any;
    return r ? { id: r.id, name: r.name, balance: Number(r.balance) } : null;
  }
  /** move play chips; refuses to go negative */
  adjust(userId: string, delta: number, reason: string, tableId?: string, handId?: number): number {
    return this.tx(() => {
      const u = this.user(userId);
      if (!u) throw new Error('no such user');
      if (u.balance + delta < 0) throw new Error('insufficient balance');
      this.db.prepare('update users set balance = balance + ? where id = ?').run(delta, userId);
      this.db.prepare('insert into ledger (user_id, delta, reason, table_id, hand_id, at) values (?, ?, ?, ?, ?, ?)')
        .run(userId, delta, reason, tableId ?? null, handId ?? null, new Date().toISOString());
      return u.balance + delta;
    });
  }
  ledgerSum(userId: string): number {
    const r = this.db.prepare('select coalesce(sum(delta), 0) s from ledger where user_id = ?').get(userId) as any;
    return Number(r.s);
  }

  /* ---- tables ---- */

  saveTable(id: string, config: unknown, state: unknown): void {
    this.db.prepare('insert into tables (id, config, state) values (?, ?, ?) on conflict(id) do update set config = excluded.config, state = excluded.state')
      .run(id, JSON.stringify(config), JSON.stringify(state));
  }
  saveTableState(id: string, state: unknown): void {
    this.db.prepare('update tables set state = ? where id = ?').run(JSON.stringify(state), id);
  }
  tables(): { id: string; config: any; state: any }[] {
    return (this.db.prepare('select id, config, state from tables order by id').all() as any[])
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
