/* One table: seats, the button, the game rotation and the hand loop.

   Ordering guarantee — an action is (1) validated against a copy of the hand,
   (2) written to the event log, (3) committed in memory, (4) broadcast.  So
   the log never holds an illegal action, and nothing a player was shown is
   missing from the log.  After a crash, `Table.restore` replays the log. */

import { startHand, legalActions, applyActionMut, type Action, type HandConfig, type HandState } from '../../engine/src/engine.ts';
import { GAMES, type GameId, type Structure } from '../../engine/src/games.ts';
import { handHistory } from '../../engine/src/hh.ts';
import { newServerSeed, commitment, handSeed } from '../../engine/src/rng.ts';
import { stakesFor, type TableStakes } from './stakes.ts';
import type { Store, User } from './store.ts';

export interface TableConfig {
  id: string;
  /** the club whose chips are played here; only its members may sit */
  clubId: string;
  name: string;
  maxSeats: number;
  /** one entry = a fixed game; several = a rotation (HORSE, 8-Game…) */
  games: { game: GameId; structure: Structure }[];
  handsPerGame: number;
  mixedName?: string;
  stakes: TableStakes;
  minBuyIn: number;
  maxBuyIn: number;
  actionSeconds: number;
  timeBankSeconds: number;
  betweenHandsMs: number;
  capBets?: number;
  uncappedHeadsUp?: boolean;
}

export interface SeatState {
  userId: string;
  name: string;
  stack: number;               // chips behind, between hands
  sittingOut: boolean;
  leaving: boolean;            // cash out when the current hand ends
  timeBank: number;            // seconds left
  clientSeed: string;
}

export interface TableState {
  seats: (SeatState | null)[]; // index = seat number - 1
  button: number;              // seat number, 0 = not yet placed
  handsPlayed: number;
  rotation: number;            // index into config.games
  handsThisGame: number;
  /** an admin closed the table: no new hands; everyone is cashed out */
  closing?: boolean;
}

export interface LiveHand {
  id: number;
  state: HandState;
  serverSeed: string;
  commitment: string;
  clientSeeds: string[];
  seq: number;                 // actions logged so far
  deadline: number;            // ms epoch for the player to act, 0 = none
  turnStarted: number;
}

export interface Clock {
  now(): number;
  set(ms: number, f: () => void): unknown;
  clear(h: unknown): void;
}
export const realClock: Clock = {
  now: () => Date.now(),
  set: (ms, f) => setTimeout(f, ms),
  clear: h => clearTimeout(h as NodeJS.Timeout),
};

export interface HandEndInfo { handId: number; serverSeed: string; commitment: string; clientSeeds: string[]; net: Record<string, number> }

export interface TableEvents {
  changed(t: Table): void;
  handEnded(t: Table, info: HandEndInfo): void;
}

export class TableError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

export function validateConfig(c: TableConfig): void {
  if (!c.games.length) throw new Error('no games');
  for (const { game, structure } of c.games) {
    const g = GAMES[game];
    if (!g) throw new Error('unknown game ' + game);
    if (!g.structures.includes(structure)) throw new Error(g.name + ' cannot be played ' + structure);
    if (c.maxSeats > g.maxSeats) throw new Error(g.name + ' seats at most ' + g.maxSeats);
    const st = stakesFor(g, structure, c.stakes);
    if (g.family === 'stud' && !(st.bringIn > 0 && st.bringIn < st.smallBet)) throw new Error('stud bring-in must be below the small bet');
  }
  if (c.maxSeats < 2) throw new Error('need at least two seats');
  if (!(c.minBuyIn > 0 && c.maxBuyIn >= c.minBuyIn)) throw new Error('bad buy-in range');
  if (!(c.handsPerGame >= 1)) throw new Error('handsPerGame must be at least 1');
}

export class Table {
  cfg: TableConfig;
  st: TableState;
  hand: LiveHand | null = null;
  /** the hand that just finished, kept on show until the next one starts */
  last: LiveHand | null = null;
  connected = new Set<string>();
  private store: Store;
  private clock: Clock;
  private ev: TableEvents;
  private turnTimer: unknown = null;
  private startTimer: unknown = null;

  constructor(cfg: TableConfig, store: Store, ev: TableEvents, clock: Clock = realClock, state?: TableState) {
    validateConfig(cfg);
    this.cfg = cfg; this.store = store; this.ev = ev; this.clock = clock;
    this.st = state ?? { seats: new Array(cfg.maxSeats).fill(null), button: 0, handsPlayed: 0, rotation: 0, handsThisGame: 0 };
    if (!state) store.saveTable(cfg.id, cfg.clubId, cfg, this.st);
  }

  /** Rebuild a table (and any hand in progress) from the store. */
  static restore(store: Store, row: { config: TableConfig; state: TableState }, ev: TableEvents, clock: Clock = realClock): Table {
    const t = new Table(row.config, store, ev, clock, row.state);
    const open = store.openHand(row.config.id);
    if (open) {
      const state = startHand(open.config);
      for (const a of open.actions) applyActionMut(state, a);
      t.hand = { id: open.id, state, serverSeed: open.serverSeed, commitment: open.commitment, clientSeeds: open.clientSeeds, seq: open.actions.length, deadline: 0, turnStarted: 0 };
      t.afterChange();
    } else t.scheduleStart(0);
    return t;
  }

  get id(): string { return this.cfg.id; }
  clockNow(): number { return this.clock.now(); }
  current() { return this.cfg.games[this.st.rotation % this.cfg.games.length]; }
  seatOf(userId: string): number {
    return this.st.seats.findIndex(s => s?.userId === userId) + 1;      // 0 = not seated
  }
  /** engine player index of a user in the current hand, -1 if not dealt in */
  handIndex(userId: string): number {
    return this.hand ? this.hand.state.players.findIndex(p => p.id === userId) : -1;
  }
  /** dealt into the hand in progress (folded or not): their seat's chips are
      only settled when that hand ends, so they cannot be cashed out before */
  private inCurrentHand(userId: string): boolean {
    return this.handIndex(userId) >= 0 && this.hand!.state.phase !== 'done';
  }
  private inLiveHand(userId: string): boolean {
    const i = this.handIndex(userId);
    return i >= 0 && this.hand!.state.phase !== 'done' && !this.hand!.state.players[i].folded;
  }
  private save(): void { this.store.saveTableState(this.id, this.st); }

  /* ---------------- seating ---------------- */

  sit(user: User, seat: number, buyIn: number, clientSeed = ''): void {
    if (this.st.closing) throw new TableError('closed', 'this table is closing');
    if (!(seat >= 1 && seat <= this.cfg.maxSeats)) throw new TableError('seat', 'no such seat');
    if (this.st.seats[seat - 1]) throw new TableError('seat', 'seat taken');
    if (this.seatOf(user.id)) throw new TableError('seat', 'already seated here');
    if (!Number.isInteger(buyIn) || buyIn < this.cfg.minBuyIn || buyIn > this.cfg.maxBuyIn)
      throw new TableError('buyin', `buy in for ${this.cfg.minBuyIn} to ${this.cfg.maxBuyIn}`);
    this.store.tx(() => {
      this.store.adjust(this.cfg.clubId, user.id, -buyIn, 'buyin', { tableId: this.id });
      this.st.seats[seat - 1] = { userId: user.id, name: user.name, stack: buyIn, sittingOut: false, leaving: false, timeBank: this.cfg.timeBankSeconds, clientSeed: clientSeed.slice(0, 128) };
      this.save();
    });
    this.ev.changed(this);
    this.scheduleStart(0);
  }

  /** top up between hands (or while not in the hand), up to the max buy-in */
  addChips(userId: string, amount: number): void {
    const seat = this.seatOf(userId);
    if (!seat) throw new TableError('seat', 'not seated');
    if (this.handIndex(userId) >= 0 && this.hand!.state.phase !== 'done') throw new TableError('busy', 'wait for the hand to finish');
    const s = this.st.seats[seat - 1]!;
    if (!Number.isInteger(amount) || amount <= 0 || s.stack + amount > this.cfg.maxBuyIn) throw new TableError('buyin', 'at most ' + (this.cfg.maxBuyIn - s.stack));
    this.store.tx(() => { this.store.adjust(this.cfg.clubId, userId, -amount, 'rebuy', { tableId: this.id }); s.stack += amount; this.save(); });
    this.ev.changed(this);
    this.scheduleStart(0);
  }

  leave(userId: string): void {
    const seat = this.seatOf(userId);
    if (!seat) return;
    const s = this.st.seats[seat - 1]!;
    if (this.inCurrentHand(userId)) {
      s.leaving = true; s.sittingOut = true; this.save();
      const i = this.handIndex(userId);
      if (this.inLiveHand(userId) && this.hand!.state.toAct === i) this.autoAct(true);
      else this.ev.changed(this);
      return;
    }
    this.cashOut(seat);
    this.ev.changed(this);
  }

  private cashOut(seat: number): void {
    const s = this.st.seats[seat - 1]!;
    this.store.tx(() => {
      if (s.stack > 0) this.store.adjust(this.cfg.clubId, s.userId, s.stack, 'cashout', { tableId: this.id, handId: this.last?.id });
      this.st.seats[seat - 1] = null;
      this.save();
    });
  }

  setSittingOut(userId: string, on: boolean): void {
    const seat = this.seatOf(userId);
    if (!seat) throw new TableError('seat', 'not seated');
    this.st.seats[seat - 1]!.sittingOut = on;
    this.save();
    this.ev.changed(this);
    if (!on) this.scheduleStart(0);
  }

  setClientSeed(userId: string, seed: string): void {
    const seat = this.seatOf(userId);
    if (seat) { this.st.seats[seat - 1]!.clientSeed = String(seed).slice(0, 128); this.save(); }
  }

  setConnected(userId: string, on: boolean): void {
    if (on) this.connected.add(userId); else this.connected.delete(userId);
    if (this.seatOf(userId)) this.ev.changed(this);
  }

  /* ---------------- the hand loop ---------------- */

  private scheduleStart(ms: number): void {
    if (this.hand || this.startTimer) return;
    this.startTimer = this.clock.set(ms, () => { this.startTimer = null; this.maybeStart(); });
  }

  private eligible(): number[] {
    const out: number[] = [];
    this.st.seats.forEach((s, i) => { if (s && s.stack > 0 && !s.sittingOut && !s.leaving) out.push(i + 1); });
    return out;
  }

  maybeStart(): void {
    if (this.hand || this.st.closing) return;
    const seats = this.eligible();
    if (seats.length < 2) return;
    const { game, structure } = this.current();
    const g = GAMES[game];

    // move the button to the next seat dealt in (stud has no button; it stays put)
    if (g.family !== 'stud' || !this.st.button) {
      const from = this.st.button;
      this.st.button = seats.find(x => x > from) ?? seats[0];
    }

    const id = this.store.nextHandId();
    const serverSeed = newServerSeed();
    const clientSeeds = seats.map(x => this.st.seats[x - 1]!.clientSeed);
    const config: HandConfig = {
      handId: String(id), game, structure,
      stakes: stakesFor(g, structure, this.cfg.stakes),
      seats: seats.map(x => { const s = this.st.seats[x - 1]!; return { seat: x, id: s.userId, name: s.name, stack: s.stack }; }),
      button: this.st.button,
      seed: handSeed(serverSeed, String(id), clientSeeds),
      capBets: this.cfg.capBets, uncappedHeadsUp: this.cfg.uncappedHeadsUp,
      table: this.cfg.name, maxSeats: this.cfg.maxSeats,
      startedAt: new Date(this.clock.now()).toISOString(),
      mixed: this.cfg.games.length > 1 ? (this.cfg.mixedName ?? 'Mixed') : undefined,
    };
    const state = startHand(config);
    this.st.handsPlayed++;
    if (++this.st.handsThisGame >= this.cfg.handsPerGame) { this.st.handsThisGame = 0; this.st.rotation = (this.st.rotation + 1) % this.cfg.games.length; }
    const c = commitment(serverSeed);
    this.store.tx(() => { this.store.startHand(id, this.id, config, serverSeed, c, clientSeeds); this.save(); });
    this.hand = { id, state, serverSeed, commitment: c, clientSeeds, seq: 0, deadline: 0, turnStarted: 0 };
    this.last = null;
    this.afterChange();
  }

  /** a player acts.  Throws TableError if it is not theirs to make or illegal. */
  act(userId: string, handId: number, action: Action): void {
    const h = this.hand;
    if (!h || h.id !== handId || h.state.phase === 'done') throw new TableError('stale', 'no such hand in progress');
    const i = this.handIndex(userId);
    if (i < 0 || h.state.toAct !== i) throw new TableError('turn', 'not your turn');
    this.commit(action, true);
  }

  private commit(action: Action, voluntary: boolean): void {
    const h = this.hand!;
    const i = h.state.toAct;
    const next = structuredClone(h.state);
    try { applyActionMut(next, action); }                  // (1) validate
    catch (e) { throw new TableError('illegal', (e as Error).message); }
    this.store.appendAction(h.id, h.seq, action);           // (2) log
    h.seq++;
    h.state = next;                                         // (3) commit
    // time bank: whatever went past the normal action time comes off the bank
    const seat = this.seatOf(next.players[i].id);
    if (seat && voluntary && h.turnStarted) {
      const over = (this.clock.now() - h.turnStarted) / 1000 - this.cfg.actionSeconds;
      if (over > 0) { const s = this.st.seats[seat - 1]!; s.timeBank = Math.max(0, s.timeBank - over); }
    }
    this.afterChange();                                     // (4) broadcast
  }

  private afterChange(): void {
    const h = this.hand!;
    if (this.turnTimer) { this.clock.clear(this.turnTimer); this.turnTimer = null; }
    if (h.state.phase === 'done') { this.endHand(); return; }
    // a player who already left is folded / stood pat for at once
    const p = h.state.players[h.state.toAct];
    const seat = this.st.seats[p.seat - 1];
    if (!seat || seat.leaving) { this.autoAct(false); return; }
    const bank = seat.timeBank;
    h.turnStarted = this.clock.now();
    h.deadline = h.turnStarted + (this.cfg.actionSeconds + bank) * 1000;
    const hid = h.id, who = h.state.toAct, seq = h.seq;
    this.turnTimer = this.clock.set(h.deadline - h.turnStarted, () => {
      this.turnTimer = null;
      const cur = this.hand;
      if (cur && cur.id === hid && cur.seq === seq && cur.state.toAct === who) this.autoAct(true);
    });
    this.ev.changed(this);
  }

  /** time ran out (or the player left): check if free, stand pat, post the
      bring-in — otherwise fold.  A timed-out player is sat out. */
  private autoAct(timedOut: boolean): void {
    const h = this.hand!;
    const L = legalActions(h.state)!;
    const p = h.state.players[L.player];
    const seat = this.st.seats[p.seat - 1];
    if (timedOut && seat) { seat.sittingOut = true; seat.timeBank = 0; }
    const a: Action = L.draw ? { type: 'draw', discard: [] }
      : L.bringIn != null ? { type: 'bringin' }
      : L.check ? { type: 'check' } : { type: 'fold' };
    this.commit(a, false);
  }

  private endHand(): void {
    const h = this.hand!;
    const s = h.state;
    const net: Record<string, number> = {};
    this.store.tx(() => {
      this.store.finishHand(h.id, s.result!, handHistory(s, 'all'));
      s.players.forEach((p, i) => {
        net[p.id] = s.result!.net[i];
        const seat = this.st.seats[p.seat - 1];
        if (seat && seat.userId === p.id) seat.stack = p.stack;
      });
      this.st.seats.forEach((seat, i) => {
        if (!seat) return;
        if (seat.leaving || this.st.closing) this.cashOut(i + 1);
        else if (seat.stack === 0) seat.sittingOut = true;              // busted: rebuy to play on
      });
      this.save();
    });
    this.hand = null;
    this.last = h;
    this.ev.handEnded(this, { handId: h.id, serverSeed: h.serverSeed, commitment: h.commitment, clientSeeds: h.clientSeeds, net });
    this.ev.changed(this);
    this.scheduleStart(this.cfg.betweenHandsMs);
  }

  /** Admin closes the table: no new hands, everyone not in a hand is cashed
      out now and the rest when the hand ends.  Returns true once empty. */
  shutDown(): boolean {
    this.st.closing = true;
    this.st.seats.forEach((s, i) => { if (s && !this.inCurrentHand(s.userId)) this.cashOut(i + 1); });
    this.save();
    this.ev.changed(this);
    return this.isEmpty();
  }
  isEmpty(): boolean { return this.st.seats.every(s => !s); }

  /** stop timers (shutdown / tests) */
  close(): void {
    if (this.turnTimer) this.clock.clear(this.turnTimer);
    if (this.startTimer) this.clock.clear(this.startTimer);
    this.turnTimer = this.startTimer = null;
  }
}
