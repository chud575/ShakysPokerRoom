/* Over real WebSockets: two players sit, play hands, one drops mid-hand and
   reconnects, and the hand carries on from the server's view of it. */

import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { Store } from '../src/store.ts';
import { Room } from '../src/room.ts';
import { listen } from '../src/server.ts';
import { table } from './helpers.ts';

class Client {
  ws: WebSocket;
  msgs: any[] = [];
  view: any = null;
  private waiters: { pred: (m: any) => boolean; res: (m: any) => void }[] = [];
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', d => {
      const m = JSON.parse(String(d));
      this.msgs.push(m);
      if (m.t === 'table') this.view = m.view;
      this.waiters = this.waiters.filter(w => (w.pred(m) ? (w.res(m), false) : true));
    });
  }
  open() { return new Promise<void>(r => this.ws.once('open', () => r())); }
  send(m: unknown) { this.ws.send(JSON.stringify(m)); }
  next(pred: (m: any) => boolean, ms = 5000) {
    return new Promise<any>((res, rej) => {
      const timer = setTimeout(() => rej(new Error('timed out waiting')), ms);
      this.waiters.push({ pred, res: m => { clearTimeout(timer); res(m); } });
    });
  }
  close() { return new Promise<void>(r => { this.ws.once('close', () => r()); this.ws.close(); }); }
}

test('websocket: play, drop mid-hand, reconnect, finish', async () => {
  const store = new Store(':memory:');
  store.createUser('alice', 'alice', 'tok-a', 10_000);
  store.createUser('bob', 'bob', 'tok-b', 10_000);
  const room = new Room(store);
  room.createTable(table('t', [{ game: 'holdem', structure: 'NL' }], { betweenHandsMs: 30, actionSeconds: 5 }));
  const srv = await listen(room, 0);
  const url = `ws://127.0.0.1:${srv.port}/ws`;

  const a = new Client(url), b = new Client(url);
  await Promise.all([a.open(), b.open()]);
  a.send({ t: 'hello', token: 'tok-a', ref: 1 });
  b.send({ t: 'hello', token: 'tok-b', ref: 1 });
  await Promise.all([a.next(m => m.t === 'welcome'), b.next(m => m.t === 'welcome')]);
  a.send({ t: 'lobby', ref: 2 });
  const lobby = await a.next(m => m.t === 'lobby');
  assert.equal(lobby.tables[0].id, 't');

  a.send({ t: 'sit', tableId: 't', seat: 1, buyIn: 1000 });
  b.send({ t: 'sit', tableId: 't', seat: 2, buyIn: 1000 });

  // both play check/call until 3 hands are done
  const autoplay = (c: Client) => {
    const f = (d: WebSocket.RawData) => {
      const m = JSON.parse(String(d));
      const h = m.t === 'table' ? m.view.hand : null;
      if (h && h.legal && !h.done) c.send({ t: 'act', tableId: 't', handId: h.id, action: h.legal.call ? { type: 'call' } : { type: 'check' } });
    };
    c.ws.on('message', f);
    return () => c.ws.off('message', f);
  };
  const stopA = autoplay(a); autoplay(b);
  await a.next(m => m.t === 'handEnd' && m.handId === 3, 8000);
  stopA();

  // hand 4: wait until it is alice's turn, then drop her
  const turn = await a.next(m => m.t === 'table' && m.view.hand?.id >= 4 && m.view.hand.legal);
  const handId = turn.view.hand.id;
  await a.close();
  const seen = await b.next(m => m.t === 'table' && m.view.seats[0] && m.view.seats[0].connected === false);
  assert.equal(seen.view.seats[0].name, 'alice');

  // reconnect: the server still has her turn waiting
  const a2 = new Client(url);
  await a2.open();
  a2.send({ t: 'hello', token: 'tok-a' });
  await a2.next(m => m.t === 'welcome');
  a2.send({ t: 'watch', tableId: 't' });
  const back = await a2.next(m => m.t === 'table');
  assert.equal(back.view.hand.id, handId);
  assert.ok(back.view.hand.legal, 'still her turn after reconnecting');
  assert.ok(back.view.seats[0].cards.every((c: string | null) => c), 'her own cards are back');
  assert.ok(back.view.seats[1].cards.every((c: string | null) => c === null), "bob's cards stay hidden");
  autoplay(a2);
  a2.send({ t: 'act', tableId: 't', handId, action: back.view.hand.legal.call ? { type: 'call' } : { type: 'check' } });
  const end = await a2.next(m => m.t === 'handEnd' && m.handId === handId, 8000);
  assert.match(end.serverSeed, /^[0-9a-f]{64}$/);

  // money adds up: balances + stacks = what was granted
  const t = room.tables.get('t')!;
  await new Promise(r => setTimeout(r, 50));
  const stacks = t.hand ? t.hand.state.players.reduce((s, p) => s + p.stack + p.total, 0) : t.st.seats.reduce((s, x) => s + (x?.stack ?? 0), 0);
  assert.equal(store.user('alice')!.balance + store.user('bob')!.balance + stacks, 20_000);

  room.close();
  await Promise.all([a2.close(), b.close()]);
  await srv.close();
});
