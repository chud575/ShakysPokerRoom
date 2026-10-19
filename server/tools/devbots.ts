/* Seat some bots at a table on a running dev server so you can play against them.
     node tools/devbots.ts <tableId> [bob,carol,dave] [port=8790]
   They act after a short pause: mostly check/call, sometimes bet/raise/fold;
   in draw games they throw their highest cards. */

import WebSocket from 'ws';

const [tableId = 'nlh-1', names = 'bob,carol,dave', port = '8790'] = process.argv.slice(2);
const RANK = '23456789TJQKA';

names.split(',').forEach((name, i) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  let busy = false;
  const send = (m: unknown) => ws.send(JSON.stringify(m));
  ws.on('open', () => { send({ t: 'hello', token: name, clientSeed: String(Math.random()) }); send({ t: 'watch', tableId }); });
  ws.on('message', d => {
    const m = JSON.parse(String(d));
    if (m.t === 'error' && m.code !== 'turn' && m.code !== 'stale') console.log(name, m.message);
    if (m.t !== 'table') return;
    const v = m.view;
    if (!v.mySeat) {
      // bot i takes seat i+2 (seat 1 is left for you), or the next free one after it
      const order = [...Array(v.maxSeats).keys()].map(k => ((i + 1 + k) % v.maxSeats)).filter(k => k > 0);
      const free = order.find(k => !v.seats[k]);
      if (free != null && !busy) { busy = true; send({ t: 'sit', tableId, seat: free + 1, buyIn: Math.min(v.buyIn.max, 2000) }); setTimeout(() => { busy = false; send({ t: 'watch', tableId }); }, 700 + i * 300); }
      return;
    }
    const me = v.seats[v.mySeat - 1];
    if (me.stack === 0 && (!v.hand || v.hand.done)) { send({ t: 'addChips', tableId, amount: 1000 }); send({ t: 'sitOut', tableId, on: false }); }
    const h = v.hand, L = h && !h.done ? h.legal : null;
    if (!L || busy) return;
    busy = true;
    setTimeout(() => {
      busy = false;
      let a: any;
      const r = Math.random();
      if (L.draw) {
        const cards: string[] = me.cards.filter(Boolean);
        const worst = cards.slice().sort((x, y) => RANK.indexOf(y[0]) - RANK.indexOf(x[0])).slice(0, Math.floor(Math.random() * 3));
        a = { type: 'draw', discard: worst.map(c => RANK.indexOf(c[0]) * 4 + 'cdhs'.indexOf(c[1])) };
      } else if (L.bringIn != null) a = { type: 'bringin' };
      else if (r < 0.12 && L.call) a = { type: 'fold' };
      else if (r < 0.8 || !(L.bet || L.raise)) a = L.call ? { type: 'call' } : { type: 'check' };
      else { const x = L.bet || L.raise; a = { type: L.bet ? 'bet' : 'raise', amount: x.only ? x.only[0] : x.min }; }
      send({ t: 'act', tableId, handId: h.id, action: a });
    }, 600 + i * 150 + Math.random() * 600);
  });
});
console.log('bots ' + names + ' -> ' + tableId);
