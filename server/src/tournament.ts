/* Tournaments: sit-and-gos and multi-table.

   A Tournament is the director of its tables (TableDirector).  It takes
   entries (club chips into the prize pool), draws seats, runs the level
   clock, records busts, keeps the tables balanced, breaks tables as the field
   shrinks down to a final table, and pays the prizes into club balances.

   Moves only ever touch a player who is not in a hand: a player is moved
   from their table between hands (the table asks `beforeHand`, or an idle
   table is handled at once), into an empty seat anywhere — they are dealt in
   from that table's next hand.  Each move is one transaction across both
   tables, so a crash cannot lose or duplicate a player.

   Money: entry fees go into `pool`; the club ledger invariant becomes
     issued - redeemed = balances + cash-table chips + pools of unfinished tournaments. */

import { randomInt } from 'node:crypto';
import { GAMES, type GameId, type Structure } from '../../engine/src/games.ts';
import { Table, TableError, validateConfig, type Clock, type SeatState, type TableConfig, type TableDirector } from './table.ts';
import type { TableStakes } from './stakes.ts';
import type { Store, User } from './store.ts';

export interface Level { sb: number; bb: number; ante: number }

export interface TourneyConfig {
  id: string;
  /** numeric id for hand-history headers ("Tournament #…") */
  number: string;
  clubId: string;
  name: string;
  kind: 'sng' | 'mtt';
  games: { game: GameId; structure: Structure }[];
  handsPerGame: number;
  mixedName?: string;
  buyIn: number;                 // club chips; 0 = freeroll
  startingStack: number;
  levels: Level[];
  levelMinutes: number;
  seatsPerTable: number;
  maxPlayers: number;
  minPlayers: number;
  startAt?: string;              // MTT: scheduled start (ISO); SNG starts when full
  lateRegLevels: number;         // MTT: registration stays open through this many levels
  payoutPct?: number[];          // override: percentages by place
  actionSeconds: number;
  timeBankSeconds: number;
}

export interface Entry {
  userId: string;
  name: string;
  status: 'registered' | 'playing' | 'busted';
  tableId: string | null;
  clientSeed: string;
  bust?: { round: number; startStack: number; at: number };
  place?: number;
  prize?: number;
}

export interface TourneyState {
  status: 'registering' | 'running' | 'finished' | 'cancelled';
  entries: Entry[];
  startedAt: number | null;
  finishedAt: number | null;
  tables: string[];
  tableNo: number;
  pool: number;
  /** increments once per hand that busted someone (same-hand busts share it) */
  bustRound: number;
  breaking: string[];
}

/** what a tournament needs from the room */
export interface TourneyHost {
  store: Store;
  clock: Clock;
  openTable(cfg: TableConfig, director: TableDirector): Table;
  table(id: string): Table | undefined;
  dropTable(t: Table): void;
  changed(t: Tournament): void;
  moved(userId: string, t: Tournament, tableId: string): void;
  balance(clubId: string, userId: string): void;
}

/* ---------------- defaults ---------------- */

const NICE = [2, 4, 6, 8, 10, 15, 20, 25, 30, 40, 50, 60, 80, 100, 120, 150, 200, 250, 300, 400, 500, 600, 800, 1000, 1200, 1500,
  2000, 2500, 3000, 4000, 5000, 6000, 8000, 10000, 12000, 15000, 20000, 25000, 30000, 40000, 50000, 60000, 80000, 100000,
  120000, 150000, 200000, 250000, 300000, 400000, 500000, 600000, 800000, 1000000];

/** a standard structure: big blind starting near 1/100 of the stack, ~25-33% a level, antes from level 4 */
export function defaultLevels(startingStack: number, count = 30): Level[] {
  let i = NICE.findIndex(x => x >= startingStack / 100);
  if (i < 0) i = NICE.length - 1;
  const out: Level[] = [];
  for (let k = 0; k < count && i + k < NICE.length; k++) {
    const bb = NICE[i + k];
    out.push({ sb: Math.max(1, Math.floor(bb / 2)), bb, ante: k >= 3 ? Math.max(1, Math.round(bb / 10)) : 0 });
  }
  return out;
}

/** percentage of the pool by finishing place */
export function payoutPct(entrants: number): number[] {
  if (entrants <= 3) return [100];
  if (entrants <= 6) return [65, 35];
  if (entrants <= 10) return [50, 30, 20];
  if (entrants <= 18) return [40, 25, 17, 11, 7];
  if (entrants <= 27) return [33, 21, 15, 11, 8, 6, 6];
  if (entrants <= 45) return [30, 19, 14, 10, 8, 6, 5, 4, 4];
  const k = Math.round(entrants * 0.15);
  const w = Array.from({ length: k }, (_, i) => 1 / Math.pow(i + 1, 1.05));
  const sum = w.reduce((a, b) => a + b, 0);
  return w.map(x => (100 * x) / sum);
}

/** chip amounts by place: floor each share, the remainder to first place */
export function payoutAmounts(pool: number, pct: number[]): number[] {
  const amt = pct.map(p => Math.floor((pool * p) / 100));
  amt[0] += pool - amt.reduce((a, b) => a + b, 0);
  return amt;
}

export function validateTourney(c: TourneyConfig): void {
  if (!c.games.length) throw new TableError('tourney', 'pick at least one game');
  for (const { game, structure } of c.games) {
    const g = GAMES[game];
    if (!g) throw new TableError('tourney', 'unknown game ' + game);
    if (!g.structures.includes(structure)) throw new TableError('tourney', g.name + ' cannot be played ' + structure);
    if (c.seatsPerTable > g.maxSeats) throw new TableError('tourney', g.name + ' seats at most ' + g.maxSeats);
  }
  if (!(c.seatsPerTable >= 2)) throw new TableError('tourney', 'at least 2 seats per table');
  if (!(c.maxPlayers >= 2 && c.maxPlayers <= 1000)) throw new TableError('tourney', 'between 2 and 1000 players');
  if (c.kind === 'sng' && c.maxPlayers > c.seatsPerTable * 10) throw new TableError('tourney', 'a sit-and-go is at most 10 tables');
  if (!(c.minPlayers >= 2 && c.minPlayers <= c.maxPlayers)) throw new TableError('tourney', 'minimum players must be 2 to the maximum');
  if (!Number.isInteger(c.buyIn) || c.buyIn < 0) throw new TableError('tourney', 'bad buy-in');
  if (!c.levels.length) throw new TableError('tourney', 'no levels');
  for (const l of c.levels) if (!(l.bb >= 2 && l.sb >= 1 && l.sb <= l.bb && l.ante >= 0)) throw new TableError('tourney', 'bad level ' + JSON.stringify(l));
  if (!(c.startingStack >= 10 * c.levels[0].bb)) throw new TableError('tourney', 'starting stack should be at least 10 big blinds');
  if (!(c.levelMinutes > 0)) throw new TableError('tourney', 'bad level length');
  if (c.payoutPct) {
    const s = c.payoutPct.reduce((a, b) => a + b, 0);
    if (Math.abs(s - 100) > 0.01 || c.payoutPct.some(p => !(p > 0))) throw new TableError('tourney', 'payout percentages must be positive and add up to 100');
  }
}

/* ---------------- the director ---------------- */

export class Tournament implements TableDirector {
  cfg: TourneyConfig;
  st: TourneyState;
  private host: TourneyHost;
  private startTimer: unknown = null;

  constructor(host: TourneyHost, cfg: TourneyConfig, st?: TourneyState) {
    this.host = host; this.cfg = cfg;
    this.st = st ?? { status: 'registering', entries: [], startedAt: null, finishedAt: null, tables: [], tableNo: 0, pool: 0, bustRound: 0, breaking: [] };
    if (!st) this.save();
    this.armStart();
  }
  get id(): string { return this.cfg.id; }
  private get store(): Store { return this.host.store; }
  private now(): number { return this.host.clock.now(); }
  private save(): void { this.store.saveTourney(this.cfg.id, this.cfg.clubId, this.cfg, this.st); }
  private changed(): void { this.host.changed(this); }
  entry(userId: string): Entry | undefined { return this.st.entries.find(e => e.userId === userId); }
  playing(): Entry[] { return this.st.entries.filter(e => e.status === 'playing'); }
  /** live tables of this tournament */
  tables(): Table[] { return this.st.tables.map(id => this.host.table(id)).filter((t): t is Table => !!t); }

  /** MTT scheduled start */
  private armStart(): void {
    if (this.cfg.kind !== 'mtt' || !this.cfg.startAt || this.st.status !== 'registering') return;
    const ms = Math.max(0, Date.parse(this.cfg.startAt) - this.now());
    this.startTimer = this.host.clock.set(ms, () => {
      this.startTimer = null;
      if (this.st.status !== 'registering') return;
      if (this.st.entries.length >= this.cfg.minPlayers) this.start();
      else this.cancel('not enough players');
    });
  }
  close(): void { if (this.startTimer) { this.host.clock.clear(this.startTimer); this.startTimer = null; } }

  /* ---- levels ---- */

  levelIndex(): number {
    if (this.st.startedAt == null) return 0;
    const i = Math.floor((this.now() - this.st.startedAt) / (this.cfg.levelMinutes * 60_000));
    return Math.min(this.cfg.levels.length - 1, Math.max(0, i));
  }
  nextLevelAt(): number | null {
    if (this.st.startedAt == null || this.levelIndex() >= this.cfg.levels.length - 1) return null;
    return this.st.startedAt + (this.levelIndex() + 1) * this.cfg.levelMinutes * 60_000;
  }
  lateRegOpen(): boolean {
    return this.cfg.kind === 'mtt' && this.st.status === 'running' && this.levelIndex() < this.cfg.lateRegLevels;
  }
  stakesNow(): { stakes: TableStakes; level: number } {
    const L = this.cfg.levels[this.levelIndex()];
    return { stakes: { smallBet: L.bb, bigBet: 2 * L.bb, smallBlind: L.sb, bigBlind: L.bb, flopAnte: L.ante }, level: this.levelIndex() + 1 };
  }
  info() { return { id: this.cfg.number, buyIn: this.cfg.buyIn + '+0' }; }

  /* ---- entries ---- */

  register(user: User, clientSeed = ''): void {
    if (this.entry(user.id)) throw new TableError('tourney', 'already registered');
    const late = this.lateRegOpen();
    if (this.st.status !== 'registering' && !late) throw new TableError('tourney', 'registration is closed');
    if (this.st.entries.length >= this.cfg.maxPlayers) throw new TableError('tourney', 'the tournament is full');
    this.store.tx(() => {
      if (this.cfg.buyIn > 0) {
        try { this.store.adjust(this.cfg.clubId, user.id, -this.cfg.buyIn, 'tbuyin', { tableId: this.cfg.id, note: this.cfg.name }); }
        catch (e) { throw new TableError('tourney', (e as Error).message === 'insufficient balance' ? 'not enough chips in your club balance' : (e as Error).message); }
      }
      this.st.pool += this.cfg.buyIn;
      const e: Entry = { userId: user.id, name: user.name, status: 'registered', tableId: null, clientSeed: clientSeed.slice(0, 128) };
      this.st.entries.push(e);
      if (late) this.seatLate(e);
      this.save();
    });
    this.host.balance(this.cfg.clubId, user.id);
    this.changed();
    if (this.cfg.kind === 'sng' && this.st.status === 'registering' && this.st.entries.length >= this.cfg.maxPlayers) this.start();
  }

  unregister(userId: string): void {
    const e = this.entry(userId);
    if (!e) throw new TableError('tourney', 'not registered');
    if (this.st.status !== 'registering') throw new TableError('tourney', 'the tournament has started');
    this.store.tx(() => {
      if (this.cfg.buyIn > 0) this.store.adjust(this.cfg.clubId, userId, this.cfg.buyIn, 'trefund', { tableId: this.cfg.id, note: this.cfg.name });
      this.st.pool -= this.cfg.buyIn;
      this.st.entries = this.st.entries.filter(x => x !== e);
      this.save();
    });
    this.host.balance(this.cfg.clubId, userId);
    this.changed();
  }

  cancel(why = 'cancelled'): void {
    if (this.st.status !== 'registering') throw new TableError('tourney', 'only a tournament that has not started can be cancelled');
    this.close();
    this.store.tx(() => {
      for (const e of this.st.entries) if (this.cfg.buyIn > 0) this.store.adjust(this.cfg.clubId, e.userId, this.cfg.buyIn, 'trefund', { tableId: this.cfg.id, note: this.cfg.name + ' — ' + why });
      this.st.pool = 0;
      this.st.status = 'cancelled';
      this.st.finishedAt = this.now();
      this.save();
    });
    for (const e of this.st.entries) this.host.balance(this.cfg.clubId, e.userId);
    this.changed();
  }

  /* ---- starting: the draw ---- */

  start(): void {
    if (this.st.status !== 'registering') throw new TableError('tourney', 'already started');
    const n = this.st.entries.length;
    if (n < Math.max(2, this.cfg.minPlayers)) throw new TableError('tourney', `needs at least ${Math.max(2, this.cfg.minPlayers)} players`);
    this.close();
    const order = this.st.entries.slice();
    for (let i = order.length - 1; i > 0; i--) { const j = randomInt(i + 1); [order[i], order[j]] = [order[j], order[i]]; }
    const count = Math.ceil(n / this.cfg.seatsPerTable);
    this.store.tx(() => {
      this.st.status = 'running';
      this.st.startedAt = this.now();
      const tables = Array.from({ length: count }, () => this.newTable());
      order.forEach((e, k) => this.seat(e, tables[k % count]));
      this.save();
    });
    for (const e of this.st.entries) this.host.moved(e.userId, this, e.tableId!);
    this.changed();
  }

  private newTable(): Table {
    const no = ++this.st.tableNo;
    const lv = this.stakesNow();
    const cfg: TableConfig = {
      id: this.cfg.id + '-' + no, clubId: this.cfg.clubId, tourneyId: this.cfg.id,
      name: this.cfg.name + ' · table ' + no,
      maxSeats: this.cfg.seatsPerTable, games: this.cfg.games, handsPerGame: this.cfg.handsPerGame, mixedName: this.cfg.mixedName,
      stakes: lv.stakes, minBuyIn: 1, maxBuyIn: 1e12,
      actionSeconds: this.cfg.actionSeconds, timeBankSeconds: this.cfg.timeBankSeconds, betweenHandsMs: 2000,
    };
    validateConfig(cfg);
    const t = this.host.openTable(cfg, this);
    this.st.tables.push(t.id);
    return t;
  }

  private seat(e: Entry, t: Table): void {
    const seat = t.randomEmptySeat(randomInt);
    t.place(seat, { userId: e.userId, name: e.name, stack: this.cfg.startingStack, sittingOut: false, leaving: false, timeBank: this.cfg.timeBankSeconds, clientSeed: e.clientSeed });
    e.status = 'playing';
    e.tableId = t.id;
  }

  /** late registration: the emptiest table with room, or a new table */
  private seatLate(e: Entry): void {
    const open = this.tables().filter(t => !this.st.breaking.includes(t.id) && t.playersSeated() < t.cfg.maxSeats)
      .sort((a, b) => a.playersSeated() - b.playersSeated());
    this.seat(e, open[0] ?? this.newTable());
    this.host.moved(e.userId, this, e.tableId!);
    this.rebalance();
  }

  /* ---- the table hooks ---- */

  beforeHand(t: Table): boolean {
    if (this.st.status !== 'running') return false;
    this.rebalance();
    return this.st.tables.includes(t.id) && !this.st.breaking.includes(t.id);
  }

  afterHand(t: Table): void {
    if (this.st.status !== 'running') return;
    const last = t.last?.state;
    const busted = t.st.seats.filter((s): s is SeatState => !!s && s.stack === 0);
    if (busted.length) {
      const round = ++this.st.bustRound;
      this.store.tx(() => {
        for (const s of busted) {
          const e = this.entry(s.userId);
          t.unplace(s.userId);
          if (!e) continue;
          const startStack = last?.players.find(p => p.id === s.userId)?.start ?? 0;
          e.status = 'busted'; e.tableId = null;
          e.bust = { round, startStack, at: this.now() };
          e.place = this.playing().length + 1;          // provisional; final places are set at the end
        }
        this.save();
      });
    }
    if (this.playing().length <= 1) { this.finish(); return; }
    this.rebalance();
    this.changed();
  }

  /* ---- balancing and breaking ---- */

  rebalance(): void {
    if (this.st.status !== 'running') return;
    const seats = this.cfg.seatsPerTable;
    let moved = false;
    for (let guard = 0; guard < 1000; guard++) {
      const live = this.tables();
      const active = live.filter(t => !this.st.breaking.includes(t.id));
      const n = live.reduce((a, t) => a + t.playersSeated(), 0);
      const need = Math.max(1, Math.ceil(n / seats));

      // 1. too many tables: break the smallest (players move as its hand finishes)
      if (active.length > need) {
        const victim = active.slice().sort((a, b) => a.playersSeated() - b.playersSeated() || b.id.localeCompare(a.id))[0];
        this.st.breaking.push(victim.id);
        moved = true;
        continue;
      }
      // 2. empty out breaking tables that are between hands
      const breaking = live.filter(t => this.st.breaking.includes(t.id));
      let did = false;
      for (const b of breaking) {
        if (b.busy()) continue;
        const who = b.st.seats.find(Boolean);
        if (!who) { this.dropTable(b); did = true; break; }
        const dst = active.filter(t => t.playersSeated() < t.cfg.maxSeats).sort((x, y) => x.playersSeated() - y.playersSeated())[0];
        if (!dst) break;
        this.move(b, dst, who.userId); did = true; break;
      }
      if (did) { moved = true; continue; }
      // 3. balance: no table more than one player shorter than another
      if (active.length > 1) {
        const by = active.slice().sort((a, b) => a.playersSeated() - b.playersSeated());
        const small = by[0], bigs = by.filter(t => t.playersSeated() - small.playersSeated() >= 2);
        const src = bigs.reverse().find(t => !t.busy());
        if (src) {
          const who = src.st.seats.filter(Boolean)[randomInt(src.playersSeated())]!;
          this.move(src, small, who.userId);
          moved = true;
          continue;
        }
      }
      break;
    }
    if (moved) { this.save(); this.changed(); }
  }

  private move(src: Table, dst: Table, userId: string): void {
    this.store.tx(() => {
      const s = src.unplace(userId);
      dst.place(dst.randomEmptySeat(randomInt), s);
      const e = this.entry(userId);
      if (e) e.tableId = dst.id;
      this.save();
    });
    this.host.moved(userId, this, dst.id);
  }

  private dropTable(t: Table): void {
    this.st.tables = this.st.tables.filter(id => id !== t.id);
    this.st.breaking = this.st.breaking.filter(id => id !== t.id);
    this.save();
    this.host.dropTable(t);
  }

  /* ---- the end ---- */

  private finish(): void {
    const winner = this.playing()[0];
    const n = this.st.entries.length;
    const pct = this.cfg.payoutPct ?? payoutPct(n);
    const amounts = payoutAmounts(this.st.pool, pct);
    // order: winner, then busts latest first; same hand — the bigger stack going in finishes higher
    const busted = this.st.entries.filter(e => e.status === 'busted')
      .sort((a, b) => b.bust!.round - a.bust!.round || b.bust!.startStack - a.bust!.startStack);
    const ranked: Entry[][] = winner ? [[winner]] : [];
    for (const e of busted) {
      const g = ranked[ranked.length - 1];
      const prev = g?.[0];
      if (prev && prev !== winner && prev.bust && prev.bust.round === e.bust!.round && prev.bust.startStack === e.bust!.startStack) g.push(e);
      else ranked.push([e]);
    }
    this.store.tx(() => {
      let place = 1;
      for (const g of ranked) {
        const share = amounts.slice(place - 1, place - 1 + g.length).reduce((a, b) => a + b, 0);
        const each = Math.floor(share / g.length);
        let rem = share - each * g.length;
        for (const e of g) {
          e.place = place;
          e.prize = each + (rem > 0 ? 1 : 0); if (rem > 0) rem--;
          if (e.prize > 0) this.store.adjust(this.cfg.clubId, e.userId, e.prize, 'tprize', { tableId: this.cfg.id, note: `${this.cfg.name} — place ${place}` });
        }
        place += g.length;
      }
      this.st.pool = 0;
      this.st.status = 'finished';
      this.st.finishedAt = this.now();
      if (winner) {
        const t = winner.tableId ? this.host.table(winner.tableId) : undefined;
        if (t && !t.busy() && t.seatOf(winner.userId)) t.unplace(winner.userId);
        winner.tableId = null;
      }
      this.save();
    });
    for (const id of this.st.tables.slice()) { const t = this.host.table(id); if (t) this.dropTable(t); }
    for (const e of this.st.entries) if (e.prize) this.host.balance(this.cfg.clubId, e.userId);
    this.changed();
  }

  /** after a restart: settle busts that were not recorded, drop missing tables, wake idle tables */
  reconcile(): void {
    this.st.tables = this.st.tables.filter(id => this.host.table(id));
    if (this.st.status !== 'running') return;
    for (const t of this.tables()) if (!t.busy() && t.st.seats.some(s => s && s.stack === 0)) this.afterHand(t);
    if (this.st.status === 'running') { this.rebalance(); for (const t of this.tables()) t.wake(); }
  }

  /* ---- what clients see ---- */

  view(userId: string | null) {
    const chips = new Map<string, number>();
    for (const t of this.tables()) {
      const live = t.hand && t.hand.state.phase !== 'done' ? t.hand.state : null;
      for (const s of t.st.seats) if (s) {
        const p = live?.players.find(x => x.id === s.userId);
        chips.set(s.userId, p ? p.stack + p.total : s.stack);
      }
    }
    const L = this.cfg.levels[this.levelIndex()], next = this.cfg.levels[this.levelIndex() + 1];
    const n = this.st.entries.length;
    const pct = this.cfg.payoutPct ?? payoutPct(Math.max(n, 1));
    return {
      id: this.cfg.id, clubId: this.cfg.clubId, name: this.cfg.name, kind: this.cfg.kind, status: this.st.status,
      games: this.cfg.games.map(g => ({ id: g.game, name: GAMES[g.game].name, structure: g.structure })),
      mixedName: this.cfg.mixedName ?? null,
      buyIn: this.cfg.buyIn, startingStack: this.cfg.startingStack, maxPlayers: this.cfg.maxPlayers, minPlayers: this.cfg.minPlayers,
      seatsPerTable: this.cfg.seatsPerTable, startAt: this.cfg.startAt ?? null, levelMinutes: this.cfg.levelMinutes,
      entrants: n, remaining: this.st.status === 'running' ? this.playing().length : null, pool: this.st.pool + (this.st.status === 'finished' ? this.st.entries.reduce((a, e) => a + (e.prize ?? 0), 0) : 0),
      payouts: payoutAmounts(this.st.status === 'finished' ? this.st.entries.reduce((a, e) => a + (e.prize ?? 0), 0) : this.cfg.buyIn * n, pct),
      level: this.st.status === 'running' ? { n: this.levelIndex() + 1, ...L, next: next ?? null, nextAt: this.nextLevelAt() } : null,
      lateReg: this.lateRegOpen(),
      players: this.st.entries.map(e => ({ name: e.name, status: e.status, chips: chips.get(e.userId) ?? null, tableId: e.tableId, place: e.place ?? null, prize: e.prize ?? null }))
        .sort((a, b) => (b.chips ?? -1) - (a.chips ?? -1) || (a.place ?? 1e9) - (b.place ?? 1e9)),
      tables: this.tables().map(t => ({ id: t.id, name: t.cfg.name, players: t.playersSeated() })),
      me: userId ? (() => { const e = this.entry(userId); return e ? { status: e.status, tableId: e.tableId, place: e.place ?? null, prize: e.prize ?? null } : null; })() : null,
      now: this.now(),
    };
  }

  summary() {
    return { id: this.cfg.id, name: this.cfg.name, kind: this.cfg.kind, status: this.st.status, buyIn: this.cfg.buyIn,
      entrants: this.st.entries.length, maxPlayers: this.cfg.maxPlayers, startAt: this.cfg.startAt ?? null,
      game: this.cfg.games.length > 1 ? (this.cfg.mixedName ?? 'Mixed') : GAMES[this.cfg.games[0].game].name + ' ' + this.cfg.games[0].structure };
  }
}
