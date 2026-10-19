/* The room: all tables, who is watching which, and the message protocol.
   Transport-agnostic — a Conn is anything that can `send` a JSON message, so
   tests drive the room directly and server.ts plugs WebSockets in.

   Client -> server
     { t:'hello', token, clientSeed? }            authenticate (first message)
     { t:'lobby' }                                list tables
     { t:'watch', tableId } / { t:'unwatch', tableId }
     { t:'sit', tableId, seat, buyIn }
     { t:'addChips', tableId, amount }
     { t:'leave', tableId }
     { t:'sitOut', tableId, on }
     { t:'act', tableId, handId, action }         engine Action
     { t:'seed', clientSeed }                     your entropy for future hands
     { t:'history', handId }                      your history of a finished hand + fairness proof
   Server -> client
     { t:'welcome', user }    { t:'lobby', tables }    { t:'table', view }
     { t:'handEnd', tableId, handId, serverSeed, commitment, clientSeeds, net }
     { t:'history', handId, text, proof }        { t:'error', code, message, ref? }
     { t:'balance', balance }                    after buy-ins, rebuys and cash-outs
   Every request may carry `ref`; replies and errors echo it.               */

import { startHand, applyActionMut } from '../../engine/src/engine.ts';
import { handHistory } from '../../engine/src/hh.ts';
import { Table, TableError, realClock, type Clock, type TableConfig, type HandEndInfo } from './table.ts';
import { viewFor, summaryOf } from './views.ts';
import type { Store, User } from './store.ts';

export interface Conn {
  send(msg: unknown): void;
  user: User | null;
  clientSeed: string;
  watching: Set<string>;
}

export class Room {
  store: Store;
  clock: Clock;
  tables = new Map<string, Table>();
  private conns = new Set<Conn>();
  private dirty = new Set<string>();
  private flushQueued = false;

  constructor(store: Store, clock: Clock = realClock) {
    this.store = store; this.clock = clock;
    for (const row of store.tables()) {
      const t = Table.restore(store, row, this.events(), clock);
      this.tables.set(t.id, t);
    }
  }

  private events() {
    return {
      changed: (t: Table) => this.markDirty(t.id),
      handEnded: (t: Table, info: HandEndInfo) => {
        this.flush();                               // final state before the reveal
        for (const c of this.conns) if (c.watching.has(t.id))
          c.send({ t: 'handEnd', tableId: t.id, ...info, net: c.user && info.net[c.user.id] != null ? { [c.user.id]: info.net[c.user.id] } : {} });
        // a player who left mid-hand is cashed out now — tell them wherever they are
        for (const id of Object.keys(info.net)) this.balance(id);
      },
    };
  }

  createTable(cfg: TableConfig): Table {
    if (this.tables.has(cfg.id)) throw new Error('table exists: ' + cfg.id);
    const t = new Table(cfg, this.store, this.events(), this.clock);
    this.tables.set(t.id, t);
    return t;
  }

  /* ---- broadcasting: coalesce every change in one tick into one view ---- */
  private markDirty(id: string): void {
    this.dirty.add(id);
    if (!this.flushQueued) { this.flushQueued = true; queueMicrotask(() => this.flush()); }
  }
  flush(): void {
    this.flushQueued = false;
    const ids = [...this.dirty]; this.dirty.clear();
    for (const id of ids) {
      const t = this.tables.get(id);
      if (!t) continue;
      for (const c of this.conns) if (c.watching.has(id)) c.send({ t: 'table', view: viewFor(t, c.user?.id ?? null) });
    }
  }

  /* ---- connections ---- */
  connect(c: Conn): void { this.conns.add(c); }
  disconnect(c: Conn): void {
    this.conns.delete(c);
    if (c.user) for (const id of c.watching) this.presence(id, c.user.id);
  }
  private presence(tableId: string, userId: string): void {
    const on = [...this.conns].some(x => x.user?.id === userId && x.watching.has(tableId));
    this.tables.get(tableId)?.setConnected(userId, on);
  }

  handle(c: Conn, msg: any): void {
    const ref = msg?.ref;
    try {
      this.dispatch(c, msg);
    } catch (e) {
      const code = e instanceof TableError ? e.code : 'error';
      c.send({ t: 'error', code, message: (e as Error).message, ref });
    }
  }

  private balance(userId: string): void {
    const b = this.store.user(userId)?.balance ?? 0;
    for (const c of this.conns) if (c.user?.id === userId) c.send({ t: 'balance', balance: b });
  }

  private table(id: unknown): Table {
    const t = this.tables.get(String(id));
    if (!t) throw new TableError('table', 'no such table');
    return t;
  }
  private me(c: Conn): User {
    if (!c.user) throw new TableError('auth', 'say hello first');
    return c.user;
  }

  private dispatch(c: Conn, m: any): void {
    if (!m || typeof m.t !== 'string') throw new TableError('proto', 'bad message');
    const ref = m.ref;
    switch (m.t) {
      case 'hello': {
        const u = this.store.userByToken(String(m.token ?? ''));
        if (!u) throw new TableError('auth', 'unknown token');
        c.user = u;
        if (m.clientSeed) c.clientSeed = String(m.clientSeed).slice(0, 128);
        c.send({ t: 'welcome', user: u, ref });
        return;
      }
      case 'lobby':
        c.send({ t: 'lobby', tables: [...this.tables.values()].map(summaryOf), ref });
        return;
      case 'watch': {
        const t = this.table(m.tableId);
        c.watching.add(t.id);
        if (c.user) this.presence(t.id, c.user.id);
        c.send({ t: 'table', view: viewFor(t, c.user?.id ?? null), ref });
        return;
      }
      case 'unwatch': {
        c.watching.delete(String(m.tableId));
        if (c.user) this.presence(String(m.tableId), c.user.id);
        return;
      }
      case 'seed': {
        const u = this.me(c);
        c.clientSeed = String(m.clientSeed ?? '').slice(0, 128);
        for (const t of this.tables.values()) t.setClientSeed(u.id, c.clientSeed);
        return;
      }
      case 'sit': {
        const u = this.me(c), t = this.table(m.tableId);
        t.sit(this.store.user(u.id)!, Number(m.seat), Number(m.buyIn), c.clientSeed);
        c.watching.add(t.id);
        this.presence(t.id, u.id);
        this.balance(u.id);
        return;
      }
      case 'addChips': { const u = this.me(c); this.table(m.tableId).addChips(u.id, Number(m.amount)); this.balance(u.id); return; }
      case 'leave': { const u = this.me(c); this.table(m.tableId).leave(u.id); this.balance(u.id); return; }
      case 'sitOut': this.table(m.tableId).setSittingOut(this.me(c).id, !!m.on); return;
      case 'act': {
        const a = m.action;
        if (!a || typeof a.type !== 'string') throw new TableError('proto', 'bad action');
        const action = a.type === 'draw'
          ? { type: 'draw' as const, discard: Array.isArray(a.discard) ? a.discard.map(Number) : [] }
          : a.amount != null ? { type: a.type, amount: Number(a.amount) } : { type: a.type };
        this.table(m.tableId).act(this.me(c).id, Number(m.handId), action);
        return;
      }
      case 'history': {
        const u = this.me(c);
        const h = this.store.hand(Number(m.handId));
        if (!h || !h.done) throw new TableError('history', 'no finished hand ' + m.handId);
        const state = startHand(h.config);
        for (const a of h.actions) applyActionMut(state, a);
        const idx = state.players.findIndex(p => p.id === u.id);
        c.send({
          t: 'history', handId: h.id, text: handHistory(state, idx), ref,
          proof: { serverSeed: h.serverSeed, commitment: h.commitment, clientSeeds: h.clientSeeds, handId: String(h.id) },
        });
        return;
      }
      default:
        throw new TableError('proto', 'unknown message ' + m.t);
    }
  }

  close(): void { for (const t of this.tables.values()) t.close(); }
}
