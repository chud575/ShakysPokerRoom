/* Load test: N bot players over real WebSockets, 6 per table, a mix of games.
   Bots act 50-300 ms after their turn comes up (people take seconds), so this
   is far busier than 100 humans.  Reports hands/min, action latency, CPU, RSS.
     node --disable-warning=ExperimentalWarning tools/load.ts [players=102] [seconds=60] */

import WebSocket from 'ws';
import { Store } from '../src/store.ts';
import { Room } from '../src/room.ts';
import { listen } from '../src/server.ts';
import type { GameId, Structure } from '../../engine/src/games.ts';

const players = +(process.argv[2] ?? 102), seconds = +(process.argv[3] ?? 60);
const MIX: [GameId, Structure][] = [['holdem', 'NL'], ['omaha', 'PL'], ['omaha8', 'FL'], ['bigo', 'PL'], ['plo5', 'PL'], ['plo6', 'PL'],
  ['stud', 'FL'], ['stud8', 'FL'], ['razz', 'FL'], ['td27', 'FL'], ['sd27', 'NL'], ['a5td', 'FL'], ['badugi', 'FL']];

const store = new Store(':memory:');
const room = new Room(store);
const nTables = Math.ceil(players / 6);
for (let i = 0; i < players; i++) store.createUser('u' + i, 'Bot' + i, 'tok' + i);
const club = store.createClub('u0', 'Load');
for (let i = 0; i < players; i++) {
  if (i) { store.requestJoin(club.id, 'u' + i); store.setMember(club.id, 'u' + i, { status: 'active' }); }
  store.adjust(club.id, 'u' + i, 10_000_000, 'issue');
}
for (let i = 0; i < nTables; i++) {
  const [game, structure] = MIX[i % MIX.length];
  room.createTable({ id: 't' + i, clubId: club.id, name: 'T' + i, maxSeats: 6, games: [{ game, structure }], handsPerGame: 1, stakes: { smallBet: 20, bigBet: 40 },
    minBuyIn: 100, maxBuyIn: 100000, actionSeconds: 30, timeBankSeconds: 30, betweenHandsMs: 500 });
}
const srv = await listen(room, 0);
const url = `ws://127.0.0.1:${srv.port}/ws`;

const lat: number[] = [];
let actions = 0, errors = 0;
const socks: WebSocket[] = [];
const rnd = (n: number) => Math.floor(Math.random() * n);

for (let i = 0; i < players; i++) {
  const ws = new WebSocket(url);
  socks.push(ws);
  const tableId = 't' + Math.floor(i / 6), seat = (i % 6) + 1;
  let sentAt = 0, pendingHand = -1, pendingLog = -1, scheduled = false;
  ws.on('open', () => {
    ws.send(JSON.stringify({ t: 'hello', token: 'tok' + i, clientSeed: String(Math.random()) }));
    ws.send(JSON.stringify({ t: 'sit', tableId, seat, buyIn: 50_000 }));
  });
  ws.on('message', d => {
    const m = JSON.parse(String(d));
    if (m.t === 'error' && m.code !== 'turn' && m.code !== 'stale') { if (errors++ < 5) console.log('ERR', tableId, seat, m.code, m.message); return; }
    if (m.t !== 'table') return;
    const h = m.view.hand;
    // our action has landed once the hand's log grows (or the hand moved on)
    if (sentAt && (!h || h.id !== pendingHand || h.log.length !== pendingLog)) { lat.push(performance.now() - sentAt); sentAt = 0; }
    if (!h || h.done || !h.legal || sentAt || scheduled) return;
    scheduled = true;
    const L = h.legal;
    setTimeout(() => {
      let a: any;
      if (L.draw) a = { type: 'draw', discard: [] };
      else if (L.bringIn != null) a = { type: 'bringin' };
      else { const r = rnd(10); a = r < 1 && L.call ? { type: 'fold' } : r < 8 ? (L.call ? { type: 'call' } : { type: 'check' }) : L.bet ? { type: 'bet', amount: L.bet.min } : L.raise ? { type: 'raise', amount: L.raise.min } : { type: 'check' }; if (a.type === 'check' && L.call) a = { type: 'call' }; }
      scheduled = false;
      sentAt = performance.now(); pendingHand = h.id; pendingLog = h.log.length; actions++;
      ws.send(JSON.stringify({ t: 'act', tableId, handId: h.id, action: a }));
    }, 50 + rnd(250));
  });
}

const cpu0 = process.cpuUsage(), t0 = performance.now();
let peakRss = 0;
const mem = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 500);
await new Promise(r => setTimeout(r, seconds * 1000));
clearInterval(mem);
const wall = (performance.now() - t0) / 1000, cpu = process.cpuUsage(cpu0);
const hands = [...room.tables.values()].reduce((s, t) => s + t.st.handsPlayed, 0);
const satOut = [...room.tables.values()].reduce((s, t) => s + t.st.seats.filter(x => x?.sittingOut).length, 0);
console.log('players sat out (timed out): ' + satOut);
lat.sort((a, b) => a - b);
const q = (p: number) => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))]?.toFixed(1);
console.log(`${players} players, ${nTables} tables, ${wall.toFixed(0)}s`);
console.log(`hands: ${hands} (${(hands / wall * 60).toFixed(0)}/min), actions: ${actions} (${(actions / wall).toFixed(0)}/s), errors: ${errors}`);
console.log(`action -> update latency ms: p50 ${q(0.5)}  p99 ${q(0.99)}  max ${q(1)}`);
console.log(`CPU: ${(((cpu.user + cpu.system) / 1e6) / wall * 100).toFixed(1)}% of one core (server AND all ${players} bot clients in this process)`);
console.log(`peak RSS: ${(peakRss / 1048576).toFixed(0)} MB (same process)`);
for (const s of socks) s.terminate();
room.close(); await srv.close();
process.exit(0);
