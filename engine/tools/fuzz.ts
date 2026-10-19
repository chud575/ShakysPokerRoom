/* Fuzzer: random tables, random stacks (lots of short ones, to force all-ins
   and side pots), random-but-legal bots, every game and structure.  After
   every action the engine invariants are checked; illegal actions must be
   rejected.  Optional --hh round-trips every hand history through the
   Replayer's parser + engine.

   node tools/fuzz.ts [hands=20000] [--hh] [--game=id] [--seed=hex] */

import { startHand, legalActions, applyActionMut, checkInvariants, type HandConfig, type HandState, type Stakes } from '../src/engine.ts';
import { GAMES, GAME_IDS, type GameId, type Structure } from '../src/games.ts';
import { Stream } from '../src/rng.ts';
import { botAction } from './bots.ts';
import { createHash } from 'node:crypto';
import { handHistory } from '../src/hh.ts';
import { cardStr } from '../src/cards.ts';
import { loadReplayer, type ReplayerApi } from './replayer.ts';

const PARSED_KEY: Record<GameId, string> = {
  holdem: 'holdem', omaha: 'omaha', omaha8: 'omaha8', bigo: 'o58', plo5: 'o5', plo6: 'o6',
  stud: 'stud', stud8: 'stud8', razz: 'razz', td27: 'td27', sd27: 'sd27', a5td: 'a5td', badugi: 'badugi',
};

export const checked = { histories: 0, showdowns: 0 };
/** Round-trip one finished hand through the Replayer.  Returns problems found. */
export function roundTrip(s: HandState, R: ReplayerApi, viewer: number | 'all'): string[] {
  const errs: string[] = [];
  const text = handHistory(s, viewer);
  const hands = R.parse(text);
  if (hands.length !== 1) return ['parsed ' + hands.length + ' hands'];
  const h = hands[0];
  if (h.game.key !== PARSED_KEY[s.cfg.game]) errs.push('game parsed as ' + h.game.key);
  R.build(h);
  checked.histories++;
  for (const w of h.warnings) errs.push('replayer: ' + w);
  s.players.forEach((p, i) => {
    const got = h.result[p.name];
    if (got !== s.result!.net[i]) errs.push(p.name + ' net ' + s.result!.net[i] + ' but replayer says ' + got);
  });
  // independent showdown check: single-pot showdowns, winners per the Replayer's evaluators
  if (viewer === 'all' && s.result!.showdown && s.result!.pots.length === 1) {
    const g = s.cfg.game;
    const live = s.players.map((p, i) => i).filter(i => !s.players[i].folded);
    const comm = s.board.length && GAMES[g].family === 'stud' ? s.board : [];
    const hands2 = live.map(i => s.players[i].cards.concat(comm));
    {
      const out = new Array(live.length).fill(0);
      const ids = (cs: number[]) => cs.map(c => R.cid(cardStr(c)));
      R.sharesInto(PARSED_KEY[g], hands2.map(ids), GAMES[g].family === 'flop' ? ids(s.board) : [], out);
      const pot = s.result!.pots[0].amount;
      checked.showdowns++;
      live.forEach((pi, k) => {
        const mine = s.result!.net[pi] + s.players[pi].total;
        const theirs = pot * out[k];
        // integer chips vs exact fractions: at most one odd chip per half
        const halves = GAMES[g].rule === 'omaha-hilo8' || GAMES[g].rule === 'stud-hilo8' ? 2 : 1;
        if (Math.abs(mine - theirs) >= halves + 0.001) errs.push(s.players[pi].name + ' won ' + mine + ', replayer equity code pays ' + theirs.toFixed(1));
      });
    }
  }
  if (errs.length) errs.push('\n' + text);
  return errs;
}

export function randomConfig(r: Stream, i: number, game?: GameId): HandConfig {
  const id = game ?? GAME_IDS[r.int(GAME_IDS.length)];
  const g = GAMES[id];
  const structure: Structure = g.structures[r.int(g.structures.length)];
  const nSeats = 2 + r.int(g.maxSeats - 1);
  const maxSeats = Math.max(nSeats, [2, 6, 8, 9, 10].find(x => x >= nSeats && x >= g.maxSeats - 2) ?? g.maxSeats);
  const seatNos = Array.from({ length: maxSeats }, (_, k) => k + 1);
  for (let k = seatNos.length - 1; k > 0; k--) { const j = r.int(k + 1); [seatNos[k], seatNos[j]] = [seatNos[j], seatNos[k]]; }
  const big = 20;
  const stakes: Stakes = g.family === 'stud'
    ? { ante: r.int(3) === 0 ? 0 : 2 + r.int(3), smallBlind: 0, bigBlind: 0, bringIn: 5, smallBet: 20, bigBet: 40 }
    : structure === 'FL'
      ? { ante: r.int(5) === 0 ? 2 : 0, smallBlind: 10, bigBlind: 20, bringIn: 0, smallBet: 20, bigBet: 40 }
      : { ante: r.int(5) === 0 ? 3 : 0, smallBlind: 10, bigBlind: big, bringIn: 0, smallBet: 0, bigBet: 0 };
  const seats = seatNos.slice(0, nSeats).map((seat, k) => {
    const kind = r.int(10);
    const stack = kind < 3 ? 1 + r.int(60) : kind < 6 ? 20 + r.int(400) : 200 + r.int(4000);
    return { seat, id: 'u' + k, name: 'Player' + (k + 1), stack };
  });
  return {
    handId: String(1000000 + i), game: id, structure, stakes, seats,
    button: 1 + r.int(maxSeats),
    seed: createHash('sha256').update('fuzz' + i + r.int(1e9)).digest('hex'),
    capBets: 4, uncappedHeadsUp: r.int(4) === 0,
    table: 'Fuzz ' + (i % 7), maxSeats, startedAt: new Date(Date.UTC(2026, 9, 19, 12, 0, i % 60)).toISOString(),
    mixed: r.int(4) === 0 ? ['HORSE', '8-Game', 'Mixed'][r.int(3)] : undefined,
    tournament: r.int(2) === 0 ? { id: String(900000 + (i % 50)), buyIn: '100+10', level: 1 + r.int(30) } : undefined,
  };
}

export function playHand(cfg: HandConfig, r: Stream, onError: (m: string) => void): HandState {
  const s = startHand(cfg);
  let guard = 0;
  for (;;) {
    const errs = checkInvariants(s);
    if (errs.length) { onError(errs.join('; ')); return s; }
    const L = legalActions(s);
    if (!L) break;
    if (++guard > 500) { onError('hand did not terminate'); return s; }
    // illegal probes must throw and leave the state untouched
    if (r.int(8) === 0) {
      const before = JSON.stringify(s);
      const probes = [
        { type: 'check' as const }, { type: 'call' as const }, { type: 'bet' as const, amount: 1 },
        { type: 'raise' as const, amount: 10 ** 9 }, { type: 'draw' as const, discard: [99] }, { type: 'bringin' as const },
      ];
      const pr = probes[r.int(probes.length)];
      let threw = false;
      try { applyActionMut(s, pr); } catch { threw = true; }
      if (!threw) continue;            // the probe happened to be legal: it was played
      if (JSON.stringify(s) !== before) { onError('rejected action mutated state: ' + JSON.stringify(pr)); return s; }
    }
    applyActionMut(s, botAction(s, L, r));
  }
  const errs = checkInvariants(s);
  if (errs.length) onError(errs.join('; '));
  if (!s.result) onError('no result');
  return s;
}

if (import.meta.filename === process.argv[1]) {
  const args = process.argv.slice(2);
  const hands = +(args.find(a => /^\d+$/.test(a)) ?? 20000);
  const game = args.find(a => a.startsWith('--game='))?.slice(7) as GameId | undefined;
  const seed = args.find(a => a.startsWith('--seed='))?.slice(7) ?? 'ab'.repeat(32);
  const R = args.includes('--hh') ? loadReplayer() : null;
  console.log('seed ' + seed);
  const r = new Stream(seed, 'fuzz');
  const stats: Record<string, { hands: number; showdowns: number; sidepots: number; errors: number }> = {};
  let errors = 0;
  const t0 = Date.now();
  for (let i = 0; i < hands; i++) {
    const cfg = randomConfig(r, i, game);
    const key = cfg.game + '/' + cfg.structure;
    const st = stats[key] ??= { hands: 0, showdowns: 0, sidepots: 0, errors: 0 };
    st.hands++;
    let s: HandState | null = null;
    try {
      s = playHand(cfg, r, m => { st.errors++; if (errors++ < 400) console.log('ERROR', key, cfg.handId, m); });
    } catch (e) {
      st.errors++; if (errors++ < 10) console.log('THROW', key, cfg.handId, (e as Error).stack);
    }
    if (R && s?.result) {
      const views: (number | 'all')[] = ['all', r.int(s.players.length)];
      for (const v of views) {
        const errs = roundTrip(s, R, v);
        if (errs.length) { st.errors++; if (errors++ < 5) console.log('HH', key, cfg.handId, 'viewer', v, errs.join('\n')); }
      }
    }
    if (s?.result?.showdown) st.showdowns++;
    if (s?.result && s.result.pots.length > 1) st.sidepots++;
  }
  console.table(stats);
  console.log(hands + ' hands, ' + errors + ' errors, ' + ((Date.now() - t0) / 1000).toFixed(1) + 's' +
    (R ? ` — ${checked.histories} histories replayed, ${checked.showdowns} showdowns re-scored by the Replayer` : ''));
  process.exit(errors ? 1 : 0);
}
