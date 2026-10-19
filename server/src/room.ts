/* The room: clubs, their tables, who is watching which, and the message
   protocol.  Transport-agnostic — a Conn is anything that can `send` a JSON
   message, so tests drive the room directly and server.ts plugs WebSockets in.

   Chips belong to a club.  Owners and admins issue chips to members (and
   redeem them) — that is the club's off-platform settlement, recorded in its
   ledger.  Members play their club balance at the club's tables.

   Client -> server
     { t:'hello', token, clientSeed? }            authenticate (first message)
     { t:'clubs' }                                my clubs (with role, status, balance)
     { t:'createClub', name }                     you become its owner
     { t:'joinClub', code }                       ask to join with an invite code
     { t:'club', clubId }                         club page: tables (+ members, invite code for admins)
     { t:'member', clubId, userId, role?, status? }      admin: approve / remove / promote
     { t:'chips', clubId, userId, amount, note? }        admin: issue (+) or redeem (-) chips
     { t:'newCode', clubId }                      admin: replace the invite code
     { t:'createTable', clubId, table }           admin: open a table (see tableFromRequest)
     { t:'closeTable', tableId }                  admin: close it (players cashed out)
     { t:'ledger', clubId, userId?, from?, to? }  admins: anyone's rows; members: their own
     { t:'report', clubId, from?, to? }           admin: per-member totals for settling up
     { t:'lobby', clubId }                        tables of a club
     { t:'watch', tableId } / { t:'unwatch', tableId }
     { t:'sit', tableId, seat, buyIn }   { t:'addChips', tableId, amount }   { t:'leave', tableId }
     { t:'sitOut', tableId, on }   { t:'act', tableId, handId, action }
     { t:'seed', clientSeed }                     your entropy for future hands
     { t:'history', handId }                      your history of a finished hand + fairness proof
     { t:'tourneys', clubId }                     a club's tournaments (live + recent)
     { t:'createTourney', clubId, tourney }       admin (see tourneyFromRequest)
     { t:'tourney', tourneyId }                   tournament lobby (and follow its updates)
     { t:'unwatchTourney', tourneyId }
     { t:'register', tourneyId } / { t:'unregister', tourneyId }
     { t:'startTourney', tourneyId } / { t:'cancelTourney', tourneyId }   admin
   Server -> client
     { t:'welcome', user }   { t:'clubs', clubs }   { t:'club', club, me, tables, members?, outstanding? }
     { t:'lobby', clubId, tables }   { t:'table', view }   { t:'ledger', clubId, rows }   { t:'report', clubId, rows }
     { t:'handEnd', tableId, handId, serverSeed, commitment, clientSeeds, net }
     { t:'history', handId, text, proof }   { t:'balance', clubId, balance }   { t:'clubChanged', clubId }
     { t:'tourneys', clubId, live, recent }   { t:'tourney', view }   { t:'moved', tourneyId, tableId }
     { t:'tableGone', tableId, tourneyId }       the table you were watching closed
     { t:'error', code, message, ref? }
   Every request may carry `ref`; replies and errors echo it.               */

import { randomBytes } from 'node:crypto';
import { startHand, applyActionMut } from '../../engine/src/engine.ts';
import { handHistory } from '../../engine/src/hh.ts';
import { GAMES, type GameId, type Structure } from '../../engine/src/games.ts';
import { Table, TableError, realClock, validateConfig, type Clock, type TableConfig, type HandEndInfo, type TableDirector } from './table.ts';
import { Tournament, defaultLevels, validateTourney, type TourneyConfig, type TourneyHost } from './tournament.ts';
import { viewFor, summaryOf } from './views.ts';
import type { Store, User, Member, Role } from './store.ts';

export interface Conn {
  send(msg: unknown): void;
  user: User | null;
  clientSeed: string;
  watching: Set<string>;
  /** tournament lobbies this connection follows */
  watchingT?: Set<string>;
}

const isAdmin = (m: Member | null) => !!m && m.status === 'active' && (m.role === 'owner' || m.role === 'admin');

/** Build a table config from an admin's request, with sensible defaults. */
export function tableFromRequest(clubId: string, r: any): TableConfig {
  const games: { game: GameId; structure: Structure }[] = (Array.isArray(r?.games) ? r.games : []).slice(0, 12).map((x: any) => {
    const g = GAMES[x?.game as GameId];
    if (!g) throw new TableError('table', 'unknown game ' + x?.game);
    return { game: g.id, structure: (x.structure ?? g.defaultStructure) as Structure };
  });
  if (!games.length) throw new TableError('table', 'pick at least one game');
  const smallBet = Math.round(Number(r.smallBet)), bigBet = Math.round(Number(r.bigBet ?? 2 * smallBet));
  const seatsCap = Math.min(...games.map(x => GAMES[x.game].maxSeats));
  const cfg: TableConfig = {
    id: 't' + randomBytes(5).toString('hex'), clubId,
    name: String(r.name ?? '').trim().slice(0, 40) || (games.length > 1 ? 'Mixed' : GAMES[games[0].game].name),
    maxSeats: Math.min(seatsCap, Math.max(2, Math.round(Number(r.maxSeats ?? seatsCap)))),
    games, handsPerGame: Math.max(1, Math.round(Number(r.handsPerGame ?? (games.length > 1 ? 6 : 1)))),
    mixedName: games.length > 1 ? String(r.mixedName ?? r.name ?? 'Mixed').slice(0, 20) : undefined,
    stakes: { smallBet, bigBet },
    minBuyIn: Math.round(Number(r.minBuyIn ?? 20 * smallBet)), maxBuyIn: Math.round(Number(r.maxBuyIn ?? 100 * smallBet)),
    actionSeconds: Math.min(120, Math.max(5, Math.round(Number(r.actionSeconds ?? 30)))),
    timeBankSeconds: Math.min(600, Math.max(0, Math.round(Number(r.timeBankSeconds ?? 60)))),
    betweenHandsMs: 3000,
  };
  if (!(smallBet >= 2 && bigBet >= smallBet)) throw new TableError('table', 'stakes: small bet at least 2, big bet at least the small bet');
  try { validateConfig(cfg); } catch (e) { throw new TableError('table', (e as Error).message); }
  return cfg;
}

/** Build a tournament config from an admin's request, with sensible defaults. */
export function tourneyFromRequest(clubId: string, r: any): TourneyConfig {
  const games: { game: GameId; structure: Structure }[] = (Array.isArray(r?.games) ? r.games : []).slice(0, 12).map((x: any) => {
    const g = GAMES[x?.game as GameId];
    if (!g) throw new TableError('tourney', 'unknown game ' + x?.game);
    return { game: g.id, structure: (x.structure ?? g.defaultStructure) as Structure };
  });
  if (!games.length) throw new TableError('tourney', 'pick at least one game');
  const kind = r.kind === 'mtt' ? 'mtt' : 'sng';
  const seatsCap = Math.min(...games.map(x => GAMES[x.game].maxSeats));
  const seatsPerTable = Math.min(seatsCap, Math.max(2, Math.round(Number(r.seatsPerTable ?? Math.min(seatsCap, 9)))));
  const startingStack = Math.round(Number(r.startingStack ?? 3000));
  const num = (v: unknown, d: number) => (v == null || v === '' ? d : Number(v));
  const cfg: TourneyConfig = {
    id: 'T' + randomBytes(5).toString('hex'),
    number: String(1_000_000_000 + Number('0x' + randomBytes(4).toString('hex')) % 8_999_999_999),
    clubId, kind,
    name: String(r.name ?? '').trim().slice(0, 40) || (kind === 'sng' ? 'Sit & Go' : 'Tournament'),
    games, handsPerGame: Math.max(1, Math.round(num(r.handsPerGame, games.length > 1 ? 6 : 1))),
    mixedName: games.length > 1 ? String(r.mixedName ?? r.name ?? 'Mixed').slice(0, 20) : undefined,
    buyIn: Math.round(num(r.buyIn, 0)), startingStack,
    levels: Array.isArray(r.levels) && r.levels.length ? r.levels.map((l: any) => ({ sb: Math.round(+l.sb), bb: Math.round(+l.bb), ante: Math.round(+l.ante || 0) })) : defaultLevels(startingStack),
    levelMinutes: Math.max(0.05, Math.min(120, num(r.levelMinutes, kind === 'sng' ? 6 : 12))),
    seatsPerTable,
    maxPlayers: Math.round(num(r.maxPlayers, kind === 'sng' ? seatsPerTable : 200)),
    minPlayers: Math.round(num(r.minPlayers, kind === 'sng' ? num(r.maxPlayers, seatsPerTable) : 2)),
    startAt: kind === 'mtt' && r.startAt ? new Date(r.startAt).toISOString() : undefined,
    lateRegLevels: kind === 'mtt' ? Math.max(0, Math.round(num(r.lateRegLevels, 4))) : 0,
    payoutPct: Array.isArray(r.payoutPct) && r.payoutPct.length ? r.payoutPct.map(Number) : undefined,
    actionSeconds: Math.min(120, Math.max(5, Math.round(num(r.actionSeconds, 30)))),
    timeBankSeconds: Math.min(600, Math.max(0, Math.round(num(r.timeBankSeconds, 60)))),
  };
  if (cfg.kind === 'sng') cfg.minPlayers = cfg.maxPlayers;
  validateTourney(cfg);
  return cfg;
}

export class Room {
  store: Store;
  clock: Clock;
  tables = new Map<string, Table>();
  tourneys = new Map<string, Tournament>();
  private conns = new Set<Conn>();
  private dirty = new Set<string>();
  private dirtyT = new Set<string>();
  private flushQueued = false;

  constructor(store: Store, clock: Clock = realClock) {
    this.store = store; this.clock = clock;
    // tournaments first, so their tables come back with their director
    for (const row of store.liveTourneys()) {
      const tt = new Tournament(this.host(), row.config, row.state);
      this.tourneys.set(tt.id, tt);
    }
    for (const row of store.tables()) {
      const tid = row.config.tourneyId;
      const dir = tid ? this.tourneys.get(tid) ?? null : null;
      if (tid && !dir) { store.closeTable(row.id); continue; }       // a finished tournament's leftover
      const t = Table.restore(store, row, this.events(), clock, dir);
      this.tables.set(t.id, t);
    }
    for (const tt of this.tourneys.values()) tt.reconcile();
  }

  /** what tournaments use to run their tables */
  private host(): TourneyHost {
    return {
      store: this.store, clock: this.clock,
      openTable: (cfg: TableConfig, director: TableDirector) => {
        const t = new Table(cfg, this.store, this.events(), this.clock, undefined, director);
        this.tables.set(t.id, t);
        return t;
      },
      table: (id: string) => this.tables.get(id),
      dropTable: (t: Table) => this.removeTable(t),
      changed: (tt: Tournament) => this.markDirtyT(tt.id),
      moved: (userId: string, tt: Tournament, tableId: string) => {
        for (const c of this.conns) if (c.user?.id === userId) c.send({ t: 'moved', tourneyId: tt.id, tableId });
      },
      balance: (clubId: string, userId: string) => this.balance(clubId, userId),
    };
  }

  private events() {
    return {
      changed: (t: Table) => this.markDirty(t.id),
      handEnded: (t: Table, info: HandEndInfo) => {
        this.flush();                               // final state before the reveal
        for (const c of this.conns) if (c.watching.has(t.id))
          c.send({ t: 'handEnd', tableId: t.id, ...info, net: c.user && info.net[c.user.id] != null ? { [c.user.id]: info.net[c.user.id] } : {} });
        // a player who left mid-hand is cashed out now — tell them wherever they are
        if (!t.isTourney) for (const id of Object.keys(info.net)) this.balance(t.cfg.clubId, id);
        if (t.isTourney) this.markDirtyT(t.cfg.tourneyId!);              // chip counts moved
        this.reap(t);
      },
    };
  }

  createTable(cfg: TableConfig): Table {
    if (this.tables.has(cfg.id)) throw new Error('table exists: ' + cfg.id);
    if (!this.store.club(cfg.clubId)) throw new Error('no such club ' + cfg.clubId);
    const t = new Table(cfg, this.store, this.events(), this.clock);
    this.tables.set(t.id, t);
    return t;
  }

  /** a closing table that has emptied is gone (its hands stay in the store) */
  private reap(t: Table): void {
    if (!t.st.closing || !t.isEmpty() || t.hand) return;
    this.removeTable(t);
    this.clubChanged(t.cfg.clubId);
  }
  /** take a table out of play and tell whoever was watching it */
  private removeTable(t: Table): void {
    t.close();
    this.store.closeTable(t.id);
    this.tables.delete(t.id);
    this.dirty.delete(t.id);
    for (const c of this.conns) if (c.watching.delete(t.id)) c.send({ t: 'tableGone', tableId: t.id, tourneyId: t.cfg.tourneyId ?? null });
  }

  /* ---- broadcasting: coalesce every change in one tick into one view ---- */
  private markDirty(id: string): void {
    this.dirty.add(id);
    if (!this.flushQueued) { this.flushQueued = true; queueMicrotask(() => this.flush()); }
  }
  private markDirtyT(id: string): void {
    this.dirtyT.add(id);
    if (!this.flushQueued) { this.flushQueued = true; queueMicrotask(() => this.flush()); }
  }
  flush(): void {
    this.flushQueued = false;
    const tids = [...this.dirtyT]; this.dirtyT.clear();
    for (const id of tids) {
      const tt = this.tourneys.get(id);
      if (!tt) continue;
      for (const c of this.conns) if (c.watchingT?.has(id)) c.send({ t: 'tourney', view: tt.view(c.user?.id ?? null) });
      if (tt.st.status === 'finished' || tt.st.status === 'cancelled') { tt.close(); this.tourneys.delete(id); this.clubChanged(tt.cfg.clubId); }
    }
    const ids = [...this.dirty]; this.dirty.clear();
    for (const id of ids) {
      const t = this.tables.get(id);
      if (!t) continue;
      for (const c of this.conns) if (c.watching.has(id)) c.send({ t: 'table', view: viewFor(t, c.user?.id ?? null) });
    }
  }
  private balance(clubId: string, userId: string): void {
    const b = this.store.balance(clubId, userId);
    for (const c of this.conns) if (c.user?.id === userId) c.send({ t: 'balance', clubId, balance: b });
  }
  /** nudge everyone in a club to refresh (membership, tables, invite code) */
  private clubChanged(clubId: string): void {
    for (const c of this.conns) if (c.user && this.store.member(clubId, c.user.id)) c.send({ t: 'clubChanged', clubId });
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

  /* ---- permission helpers ---- */
  private me(c: Conn): User {
    if (!c.user) throw new TableError('auth', 'say hello first');
    return c.user;
  }
  private tourney(id: unknown): Tournament {
    const tt = this.tourneys.get(String(id));
    if (!tt) throw new TableError('tourney', 'no such tournament (or it has finished)');
    return tt;
  }
  /** a host for reading finished tournaments: does nothing */
  private frozenHost(): TourneyHost {
    const noop = () => {};
    return { store: { saveTourney: noop } as unknown as Store, clock: { now: () => this.clock.now(), set: () => 0, clear: noop },
      openTable: () => { throw new Error('frozen'); }, table: () => undefined, dropTable: noop, changed: noop, moved: noop, balance: noop };
  }

  private table(id: unknown): Table {
    const t = this.tables.get(String(id));
    if (!t) throw new TableError('table', 'no such table');
    return t;
  }
  /** an active member of the club (or throws) */
  private memberOf(c: Conn, clubId: unknown): Member {
    const m = this.store.member(String(clubId), this.me(c).id);
    if (!m || m.status !== 'active') throw new TableError('club', m?.status === 'pending' ? 'your request to join is waiting for approval' : 'not a member of this club');
    return m;
  }
  private adminOf(c: Conn, clubId: unknown): Member {
    const m = this.memberOf(c, clubId);
    if (!isAdmin(m)) throw new TableError('club', 'only the club owner or an admin can do that');
    return m;
  }
  private clubPage(c: Conn, clubId: string, ref?: unknown): void {
    const m = this.memberOf(c, clubId);
    const club = this.store.club(clubId)!;
    const admin = isAdmin(m);
    c.send({
      t: 'club', ref,
      club: { id: club.id, name: club.name, ownerId: club.ownerId, inviteCode: admin ? club.inviteCode : undefined },
      me: { role: m.role, balance: m.balance },
      tables: [...this.tables.values()].filter(t => t.cfg.clubId === clubId && !t.st.closing && !t.isTourney).map(summaryOf),
      tourneys: [...this.tourneys.values()].filter(x => x.cfg.clubId === clubId).map(x => x.summary()),
      recentTourneys: this.store.recentTourneys(clubId, 10).map(r => new Tournament(this.frozenHost(), r.config, r.state).summary()),
      members: admin ? this.store.members(clubId) : undefined,
      outstanding: admin ? this.store.outstanding(clubId) : undefined,
    });
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

      /* ---------- clubs ---------- */
      case 'clubs':
        c.send({ t: 'clubs', ref, clubs: this.store.clubsOf(this.me(c).id).filter(x => x.status !== 'removed')
          .map(x => ({ id: x.id, name: x.name, role: x.role, status: x.status, balance: x.balance })) });
        return;
      case 'createClub': {
        const name = String(m.name ?? '').trim().slice(0, 40);
        if (name.length < 2) throw new TableError('club', 'give the club a name');
        const club = this.store.createClub(this.me(c).id, name);
        this.clubPage(c, club.id, ref);
        return;
      }
      case 'joinClub': {
        const club = this.store.clubByCode(String(m.code ?? ''));
        if (!club) throw new TableError('club', 'no club has that invite code');
        const mem = this.store.requestJoin(club.id, this.me(c).id);
        c.send({ t: 'clubs', ref, clubs: this.store.clubsOf(this.me(c).id).filter(x => x.status !== 'removed')
          .map(x => ({ id: x.id, name: x.name, role: x.role, status: x.status, balance: x.balance })) });
        if (mem.status === 'pending') this.clubChanged(club.id);           // admins see the request
        return;
      }
      case 'club': this.clubPage(c, String(m.clubId), ref); return;
      case 'member': {
        const clubId = String(m.clubId);
        const me = this.adminOf(c, clubId);
        const target = this.store.member(clubId, String(m.userId));
        if (!target) throw new TableError('club', 'no such member');
        if (target.role === 'owner') throw new TableError('club', "the owner's membership can't be changed");
        const role = m.role as Role | undefined, status = m.status as Member['status'] | undefined;
        if (role && !['admin', 'member'].includes(role)) throw new TableError('club', 'role must be admin or member');
        if (role === 'admin' && me.role !== 'owner') throw new TableError('club', 'only the owner can make admins');
        if (target.role === 'admin' && me.role !== 'owner') throw new TableError('club', 'only the owner can change an admin');
        if (status && !['active', 'removed'].includes(status)) throw new TableError('club', 'status must be active or removed');
        this.store.setMember(clubId, target.userId, { role, status });
        if (status === 'removed') {
          // a removed member leaves every club table (cashed out, now or when their hand ends)
          for (const t of this.tables.values()) if (t.cfg.clubId === clubId) t.leave(target.userId);
        }
        this.clubChanged(clubId);
        this.clubPage(c, clubId, ref);
        return;
      }
      case 'chips': {
        const clubId = String(m.clubId);
        const me = this.adminOf(c, clubId);
        const target = this.store.member(clubId, String(m.userId));
        if (!target || target.status === 'pending') throw new TableError('club', 'no such member');
        const amount = Math.round(Number(m.amount));
        if (!amount) throw new TableError('chips', 'enter an amount');
        if (amount > 0 && target.status !== 'active') throw new TableError('chips', 'chips can only be issued to active members');
        try {
          this.store.adjust(clubId, target.userId, amount, amount > 0 ? 'issue' : 'redeem', { actorId: me.userId, note: String(m.note ?? '').slice(0, 120) || undefined });
        } catch (e) { throw new TableError('chips', (e as Error).message === 'insufficient balance' ? `${target.name} only has ${target.balance} chips off the tables` : (e as Error).message); }
        this.balance(clubId, target.userId);
        this.clubPage(c, clubId, ref);
        return;
      }
      case 'newCode': { this.adminOf(c, m.clubId); this.store.newInviteCode(String(m.clubId)); this.clubPage(c, String(m.clubId), ref); return; }
      case 'createTable': {
        const clubId = String(m.clubId);
        this.adminOf(c, clubId);
        this.createTable(tableFromRequest(clubId, m.table));
        this.clubChanged(clubId);
        return;
      }
      case 'closeTable': {
        const t = this.table(m.tableId);
        this.adminOf(c, t.cfg.clubId);
        if (t.isTourney) throw new TableError('table', 'tournament tables close by themselves');
        t.shutDown();
        for (const s of t.st.seats) if (s) this.balance(t.cfg.clubId, s.userId);
        this.reap(t);
        this.clubChanged(t.cfg.clubId);
        return;
      }
      case 'ledger': {
        const clubId = String(m.clubId);
        const me = this.memberOf(c, clubId);
        const userId = isAdmin(me) ? (m.userId ? String(m.userId) : undefined) : me.userId;
        c.send({ t: 'ledger', ref, clubId, rows: this.store.ledger(clubId, { userId, from: m.from, to: m.to, limit: m.limit }) });
        return;
      }
      case 'report': {
        const clubId = String(m.clubId);
        this.adminOf(c, clubId);
        c.send({ t: 'report', ref, clubId, from: m.from ?? null, to: m.to ?? null, rows: this.store.report(clubId, m.from, m.to), outstanding: this.store.outstanding(clubId) });
        return;
      }

      /* ---------- tables ---------- */
      case 'lobby': {
        const clubId = String(m.clubId);
        this.memberOf(c, clubId);
        c.send({ t: 'lobby', ref, clubId, tables: [...this.tables.values()].filter(t => t.cfg.clubId === clubId && !t.st.closing && !t.isTourney).map(summaryOf) });
        return;
      }
      case 'watch': {
        const t = this.table(m.tableId);
        this.memberOf(c, t.cfg.clubId);
        c.watching.add(t.id);
        this.presence(t.id, c.user!.id);
        c.send({ t: 'table', view: viewFor(t, c.user!.id), ref });
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
        const t = this.table(m.tableId);
        const mem = this.memberOf(c, t.cfg.clubId);
        try { t.sit(this.store.user(mem.userId)!, Number(m.seat), Number(m.buyIn), c.clientSeed); }
        catch (e) { if ((e as Error).message === 'insufficient balance') throw new TableError('buyin', 'not enough chips in your club balance'); throw e; }
        c.watching.add(t.id);
        this.presence(t.id, mem.userId);
        this.balance(t.cfg.clubId, mem.userId);
        return;
      }
      case 'addChips': {
        const t = this.table(m.tableId);
        const mem = this.memberOf(c, t.cfg.clubId);
        try { t.addChips(mem.userId, Number(m.amount)); }
        catch (e) { if ((e as Error).message === 'insufficient balance') throw new TableError('buyin', 'not enough chips in your club balance'); throw e; }
        this.balance(t.cfg.clubId, mem.userId);
        return;
      }
      case 'leave': {
        // leaving is always allowed, even for someone just removed from the club
        const t = this.table(m.tableId), u = this.me(c);
        t.leave(u.id);
        this.balance(t.cfg.clubId, u.id);
        this.reap(t);
        return;
      }
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
        const clubId = this.store.tableClub(h.tableId);
        const state = startHand(h.config);
        const idx = state.players.findIndex(p => p.id === u.id);
        // your own hands always; otherwise only as an active member of the table's club
        if (idx < 0 && !(clubId && this.store.member(clubId, u.id)?.status === 'active')) throw new TableError('history', 'not your hand');
        for (const a of h.actions) applyActionMut(state, a);
        c.send({
          t: 'history', handId: h.id, text: handHistory(state, idx), ref,
          proof: { serverSeed: h.serverSeed, commitment: h.commitment, clientSeeds: h.clientSeeds, handId: String(h.id) },
        });
        return;
      }
      /* ---------- tournaments ---------- */
      case 'tourneys': {
        const clubId = String(m.clubId);
        this.memberOf(c, clubId);
        c.send({ t: 'tourneys', ref, clubId,
          live: [...this.tourneys.values()].filter(x => x.cfg.clubId === clubId).map(x => x.summary()),
          recent: this.store.recentTourneys(clubId).map(r => new Tournament(this.frozenHost(), r.config, r.state).summary()) });
        return;
      }
      case 'createTourney': {
        const clubId = String(m.clubId);
        this.adminOf(c, clubId);
        const tt = new Tournament(this.host(), tourneyFromRequest(clubId, m.tourney ?? {}));
        this.tourneys.set(tt.id, tt);
        this.clubChanged(clubId);
        c.send({ t: 'tourney', ref, view: tt.view(c.user!.id) });
        (c.watchingT ??= new Set()).add(tt.id);
        return;
      }
      case 'tourney': {
        const live = this.tourneys.get(String(m.tourneyId));
        if (!live) {
          // finished or cancelled: show the results from the record
          const row = this.store.tourney(String(m.tourneyId));
          if (!row) throw new TableError('tourney', 'no such tournament');
          this.memberOf(c, row.config.clubId);
          c.send({ t: 'tourney', ref, view: new Tournament(this.frozenHost(), row.config, row.state).view(c.user!.id) });
          return;
        }
        const tt = live;
        this.memberOf(c, tt.cfg.clubId);
        (c.watchingT ??= new Set()).add(tt.id);
        c.send({ t: 'tourney', ref, view: tt.view(c.user!.id) });
        return;
      }
      case 'unwatchTourney': c.watchingT?.delete(String(m.tourneyId)); return;
      case 'register': {
        const tt = this.tourney(m.tourneyId);
        const mem = this.memberOf(c, tt.cfg.clubId);
        tt.register(this.store.user(mem.userId)!, c.clientSeed);
        (c.watchingT ??= new Set()).add(tt.id);
        return;
      }
      case 'unregister': { const tt = this.tourney(m.tourneyId); tt.unregister(this.me(c).id); return; }
      case 'startTourney': { const tt = this.tourney(m.tourneyId); this.adminOf(c, tt.cfg.clubId); tt.start(); return; }
      case 'cancelTourney': { const tt = this.tourney(m.tourneyId); this.adminOf(c, tt.cfg.clubId); tt.cancel('cancelled by the club'); return; }
      default:
        throw new TableError('proto', 'unknown message ' + m.t);
    }
  }

  close(): void {
    for (const t of this.tables.values()) t.close();
    for (const tt of this.tourneys.values()) tt.close();
  }
}
