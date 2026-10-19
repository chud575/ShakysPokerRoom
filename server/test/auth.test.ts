/* ShakyBets sign-in: the pass, the session cookie, and the WebSocket gate. */

import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { Store } from '../src/store.ts';
import { Room } from '../src/room.ts';
import { listen } from '../src/server.ts';
import { makePass, readPass, type AuthConfig } from '../src/auth.ts';

const SECRET = 'x'.repeat(64);
const nowSec = () => Math.floor(Date.now() / 1000);

test('passes: signature, expiry, tampering', () => {
  const p = { u: 7, n: 'shaky', e: nowSec() + 60, r: 'n1' };
  assert.deepEqual(readPass(SECRET, makePass(SECRET, p), nowSec()), p);
  assert.throws(() => readPass(SECRET, makePass('y'.repeat(64), p), nowSec()), /bad pass/, 'wrong secret');
  assert.throws(() => readPass(SECRET, makePass(SECRET, { ...p, e: nowSec() - 1 }), nowSec()), /expired/);
  assert.throws(() => readPass(SECRET, makePass(SECRET, { ...p, e: nowSec() + 3600 }), nowSec()), /bad pass/, 'too long-lived');
  const [body, sig] = makePass(SECRET, p).split('.');
  const forged = Buffer.from(JSON.stringify({ ...p, u: 1 })).toString('base64url');
  assert.throws(() => readPass(SECRET, forged + '.' + sig, nowSec()), /bad pass/, 'changed user id');
  assert.throws(() => readPass('short', body + '.' + sig, nowSec()), /not configured/);
});

test('handoff sets a session; the socket signs in by cookie; replays, other sites and dev tokens are refused', async () => {
  const store = new Store(':memory:');
  store.createUser('alice', 'alice', 'alice');
  const room = new Room(store);
  const auth: AuthConfig = { secret: SECRET, loginUrl: 'https://example.test/room', devTokens: false, origins: ['http://room.test'], secureCookie: true };
  const srv = await listen(room, 0, '127.0.0.1', undefined, auth);
  const base = `http://127.0.0.1:${srv.port}`;
  try {
    const pass = makePass(SECRET, { u: 42, n: 'shaky', e: nowSec() + 60, r: 'once' });
    const r1 = await fetch(base + '/auth/handoff?t=' + pass, { redirect: 'manual' });
    assert.equal(r1.status, 302);
    const cookie = r1.headers.get('set-cookie')!;
    assert.match(cookie, /^pr_session=[\w-]{20,}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/);
    const r2 = await fetch(base + '/auth/handoff?t=' + pass, { redirect: 'manual' });
    assert.equal(r2.status, 403, 'a pass works once');
    assert.match(await r2.text(), /already used/);
    assert.equal(store.user('sb42')!.name, 'shaky');

    const sock = (origin: string, c: string) => new Promise<string[]>(res => {
      const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { headers: { origin, cookie: c } });
      const got: string[] = [];
      ws.on('message', d => {
        const m = JSON.parse(String(d));
        got.push(m.t === 'welcome' ? 'welcome:' + m.user.id : m.t === 'error' ? 'error:' + m.message : m.t);
        if (m.t === 'hi' && !c) ws.send(JSON.stringify({ t: 'hello', token: 'alice' }));
      });
      let done = false;
      ws.on('error', () => {});
      ws.on('unexpected-response', (_q, r) => { got.push('refused:' + r.statusCode); done = true; res(got); });
      setTimeout(() => { if (!done) { ws.close(); res(got); } }, 300);
    });
    const session = cookie.split(';')[0];
    assert.deepEqual(await sock('http://room.test', session), ['hi', 'welcome:sb42']);
    assert.deepEqual(await sock('http://room.test', ''), ['hi', 'error:please sign in'], 'dev tokens are off');
    assert.deepEqual(await sock('https://evil.test', session), ['refused:401'], 'other sites cannot open a socket');
    assert.deepEqual(await sock('http://room.test', 'pr_session=forged'), ['hi'], 'unknown session: not signed in');

    const out = await fetch(base + '/auth/logout', { headers: { cookie: session }, redirect: 'manual' });
    assert.equal(out.status, 302);
    assert.deepEqual(await sock('http://room.test', session), ['hi'], 'signed out');
  } finally {
    room.close();
    await srv.close();
  }
});
