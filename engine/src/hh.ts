/* PokerStars-format hand history from a finished (or running) hand.

   viewer = a player index  -> that player's history: their own hole cards,
                               everyone else's exposed cards only (what
                               PokerStars gives a player)
   viewer = 'all'           -> the archive copy: every card dealt is shown

   The output parses in the Replayer unchanged, so every hand dealt in the
   room can be replayed, analysed and fed to its stats/luck screens. */

import { type Card, cardsStr } from './cards.ts';
import { GAMES, structureName } from './games.ts';
import type { HandState, StreetName } from './engine.ts';

const MARK: Record<StreetName, string> = {
  preflop: '*** HOLE CARDS ***', flop: '*** FLOP ***', turn: '*** TURN ***', river: '*** RIVER ***',
  '3rd': '*** 3rd STREET ***', '4th': '*** 4th STREET ***', '5th': '*** 5th STREET ***', '6th': '*** 6th STREET ***', '7th': '*** RIVER ***',
  predraw: '*** DEALING HANDS ***', draw1: '*** FIRST DRAW ***', draw2: '*** SECOND DRAW ***', draw3: '*** THIRD DRAW ***',
};
const FOLD_WHERE: Record<StreetName, string> = {
  preflop: 'before Flop', flop: 'on the Flop', turn: 'on the Turn', river: 'on the River',
  '3rd': 'on the 3rd Street', '4th': 'on the 4th Street', '5th': 'on the 5th Street', '6th': 'on the 6th Street', '7th': 'on the River',
  predraw: 'before the Draw', draw1: 'after the 1st Draw', draw2: 'after the 2nd Draw', draw3: 'after the 3rd Draw',
};

function roman(n: number): string {
  const T: [number, string][] = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let s = '';
  for (const [v, r] of T) while (n >= v) { s += r; n -= v; }
  return s;
}

/** "2026/10/19 8:05:09 ET" */
function etStamp(iso: string): string {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: 'numeric', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(d);
  const v = (t: string) => parts.find(p => p.type === t)!.value;
  return `${v('year')}/${v('month')}/${v('day')} ${+v('hour')}:${v('minute')}:${v('second')} ET`;
}

export function handHistory(s: HandState, viewer: number | 'all'): string {
  const cfg = s.cfg, g = GAMES[cfg.game], st = cfg.stakes;
  const P = s.players;
  const see = (i: number) => viewer === 'all' || viewer === i;
  const L: string[] = [];
  const allin = (b: boolean) => (b ? ' and is all-in' : '');

  /* ---- header ---- */
  let desc = g.psName + ' ' + structureName(cfg.structure);
  if (cfg.mixed) desc = cfg.mixed + ' (' + desc + ')';
  const stakes = cfg.structure === 'FL' ? st.smallBet + '/' + st.bigBet : st.smallBlind + '/' + st.bigBlind;
  const when = etStamp(cfg.startedAt);
  if (cfg.tournament) {
    const t = cfg.tournament;
    L.push(`PokerStars Hand #${cfg.handId}: Tournament #${t.id}, ${t.buyIn} ${desc} - Level ${roman(t.level)} (${stakes}) - ${when}`);
  } else {
    L.push(`PokerStars Hand #${cfg.handId}:  ${desc} (${stakes}) - ${when}`);
  }
  L.push(`Table '${cfg.table}' ${cfg.maxSeats}-max` + (g.family === 'stud' ? '' : ` Seat #${P[s.btn].seat} is the button`));
  for (const p of P) L.push(`Seat ${p.seat}: ${p.name} (${p.start} in chips) `);

  /* ---- body ---- */
  const dealt: Card[][] = P.map(() => []);      // cards so far, per player
  const upSoFar: Card[][] = P.map(() => []);
  const foldedOn: (StreetName | null)[] = P.map(() => null);
  const sbIdx = P.length === 2 ? s.btn : (s.btn + 1) % P.length;
  const bbIdx = (sbIdx + 1) % P.length;
  let street: StreetName = g.family === 'stud' ? '3rd' : g.family === 'flop' ? 'preflop' : 'predraw';
  const board: Card[] = [];
  let community: Card | null = null;
  const shown = new Map<number, { cards: Card[]; desc: string }>();
  const won = new Map<number, number>();

  for (const e of s.events) {
    switch (e.k) {
      case 'ante': L.push(`${P[e.p].name}: posts the ante ${e.amount}${allin(e.allIn)}`); break;
      case 'sb': L.push(`${P[e.p].name}: posts small blind ${e.amount}${allin(e.allIn)}`); break;
      case 'bb': L.push(`${P[e.p].name}: posts big blind ${e.amount}${allin(e.allIn)}`); break;
      case 'street': {
        street = e.street;
        if (e.newBoard) {
          const before = board.slice();
          board.push(...e.newBoard);
          L.push(MARK[e.street] + (before.length ? ` [${cardsStr(before)}] [${cardsStr(e.newBoard)}]` : ` [${cardsStr(e.newBoard)}]`));
        } else L.push(MARK[e.street]);
        break;
      }
      case 'deal': {
        const p = P[e.p];
        const prev = dealt[e.p].slice(), prevUp = upSoFar[e.p].slice();
        dealt[e.p].push(...e.cards);
        e.cards.forEach((c, j) => { if (e.up[j]) upSoFar[e.p].push(c); });
        if (g.family !== 'stud') { if (see(e.p)) L.push(`Dealt to ${p.name} [${cardsStr(e.cards)}]`); break; }
        if (see(e.p)) {
          L.push(prev.length ? `Dealt to ${p.name} [${cardsStr(prev)}] [${cardsStr(e.cards)}]` : `Dealt to ${p.name} [${cardsStr(e.cards)}]`);
        } else {
          const ups = e.cards.filter((_, j) => e.up[j]);
          if (ups.length) L.push(prevUp.length ? `Dealt to ${p.name} [${cardsStr(prevUp)}] [${cardsStr(ups)}]` : `Dealt to ${p.name} [${cardsStr(ups)}]`);
        }
        break;
      }
      case 'community': {
        // one face-up card shared by everyone still in; written as each
        // player's 7th card so a stud parser sees seven cards apiece
        community = e.card;
        P.forEach((p, i) => {
          if (foldedOn[i]) return;
          const prev = see(i) ? dealt[i] : upSoFar[i];
          L.push(`Dealt to ${p.name} [${cardsStr(prev)}] [${cardsStr([e.card])}]`);
        });
        break;
      }
      case 'bringin': L.push(`${P[e.p].name}: brings in for ${e.amount}${allin(e.allIn)}`); break;
      case 'fold': foldedOn[e.p] = street; L.push(`${P[e.p].name}: folds `); break;
      case 'check': L.push(`${P[e.p].name}: checks `); break;
      case 'call': L.push(`${P[e.p].name}: calls ${e.amount}${allin(e.allIn)}`); break;
      case 'bet': L.push(`${P[e.p].name}: bets ${e.amount}${allin(e.allIn)}`); break;
      case 'raise': L.push(`${P[e.p].name}: raises ${e.by} to ${e.to}${allin(e.allIn)}`); break;
      case 'capped': L.push('Betting is capped'); break;
      case 'draw': {
        const p = P[e.p], k = e.discard.length;
        if (!k) { L.push(`${p.name}: stands pat`); break; }
        const word = k + ' card' + (k > 1 ? 's' : '');
        if (see(e.p)) {
          L.push(`${p.name}: discards ${word} [${cardsStr(e.discard)}]`);
          L.push(`Dealt to ${p.name} [${cardsStr(e.kept)}] [${cardsStr(e.drawn)}]`);
        } else L.push(`${p.name}: discards ${word}`);
        break;
      }
      case 'reshuffle': break;
      case 'uncalled': L.push(`Uncalled bet (${e.amount}) returned to ${P[e.p].name}`); break;
      case 'showdown': L.push('*** SHOW DOWN ***'); break;
      case 'show': {
        const cards = community != null ? e.cards.concat([community]) : e.cards;
        shown.set(e.p, { cards, desc: e.desc });
        L.push(`${P[e.p].name}: shows [${cardsStr(cards)}] (${e.desc})`);
        break;
      }
      case 'nolow': L.push('No low hand qualified'); break;
      case 'collect':
        won.set(e.p, (won.get(e.p) ?? 0) + e.amount);
        L.push(`${P[e.p].name} collected ${e.amount} from ${e.pot}`);
        break;
    }
  }

  /* ---- summary ---- */
  if (s.phase !== 'done') return L.join('\n') + '\n';
  L.push('*** SUMMARY ***');
  const total = P.reduce((t, p) => t + p.total, 0);
  const pots = s.result!.pots;
  let breakdown = '';
  if (pots.length > 1) {
    breakdown = ` Main pot ${pots[0].amount}.`;
    for (let i = 1; i < pots.length; i++) breakdown += ` ${pots.length === 2 ? 'Side pot' : 'Side pot-' + i} ${pots[i].amount}.`;
  }
  L.push(`Total pot ${total}${breakdown} | Rake 0 `);
  if (board.length) L.push(`Board [${cardsStr(board)}]`);
  P.forEach((p, i) => {
    const pos = g.family === 'stud' ? ''
      : i === s.btn ? ' (button)' : i === sbIdx && st.smallBlind > 0 ? ' (small blind)' : i === bbIdx ? ' (big blind)' : '';
    let tail: string;
    const sh = shown.get(i), w = won.get(i);
    if (sh) tail = `showed [${cardsStr(sh.cards)}] and ` + (w ? `won (${w})` : 'lost') + ` with ${sh.desc}`;
    else if (w) tail = `collected (${w})`;
    else if (foldedOn[i]) tail = 'folded ' + FOLD_WHERE[foldedOn[i]!];
    else tail = 'mucked';
    L.push(`Seat ${p.seat}: ${p.name}${pos} ${tail}`);
  });
  return L.join('\n') + '\n';
}
