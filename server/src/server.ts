/* WebSocket transport for the Room: JSON messages on /ws, a small payload
   limit, and ping/pong so dead connections drop (and the player shows as
   disconnected) instead of lingering. */

import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Room, Conn } from './room.ts';
import { COOKIE, SESSION_DAYS, newSessionToken, parseCookies, readPass, sessionCookie, sha, type AuthConfig } from './auth.ts';

export interface Listening { http: Server; wss: WebSocketServer; port: number; close(): Promise<void> }

const CLIENT = join(import.meta.dirname, '../../client');
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const DEV_AUTH: AuthConfig = { secret: '', loginUrl: '', devTokens: true, origins: [], secureCookie: false };

export function listen(room: Room, port: number, host = '127.0.0.1', clientDir = CLIENT, auth: AuthConfig = DEV_AUTH): Promise<Listening> {
  room.devTokens = auth.devTokens;
  const nowSec = () => Math.floor(room.clock.now() / 1000);
  const userFromCookie = (cookie: string | undefined) => {
    const tok = parseCookies(cookie)[COOKIE];
    return tok ? room.store.sessionUser(sha(tok), nowSec()) : null;
  };
  const http = createServer(async (req, res) => {
    const full = new URL(req.url ?? '/', 'http://x');
    const url = full.pathname;
    if (url === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }
    // ShakyBets sign-in: the accounts service sends players here with a one-time pass
    if (url === '/auth/handoff' && req.method === 'GET') {
      try {
        const p = readPass(auth.secret, full.searchParams.get('t') ?? '', nowSec());
        if (!room.store.useNonce(p.r, nowSec())) throw new Error('this sign-in link was already used — open the Poker Room from the site again');
        const user = room.store.upsertUser('sb' + p.u, p.n);
        const tok = newSessionToken();
        room.store.createSession(sha(tok), user.id, nowSec() + SESSION_DAYS * 86400);
        res.writeHead(302, { location: '/', 'set-cookie': sessionCookie(tok, auth.secureCookie), 'cache-control': 'no-store' });
        res.end();
      } catch (e) {
        res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta name=viewport content="width=device-width"><body style="font:15px system-ui;background:#0e1116;color:#e7edf5;padding:40px">
          <h2>Can't sign you in</h2><p>${String((e as Error).message).replace(/[<&>]/g, '')}</p><p><a style="color:#5ea9ff" href="${auth.loginUrl}">Try again</a></p>`);
      }
      return;
    }
    if (url === '/auth/logout') {
      const tok = parseCookies(req.headers.cookie)[COOKIE];
      if (tok) room.store.endSession(sha(tok));
      res.writeHead(302, { location: '/', 'set-cookie': sessionCookie('', auth.secureCookie, 0) });
      res.end();
      return;
    }
    // the web client: static files, no directory escapes
    const rel = normalize(url === '/' ? '/index.html' : url).replace(/^(\.\.[/\\])+/, '');
    const type = TYPES[extname(rel)];
    if (req.method === 'GET' && type && !rel.includes('..')) {
      try {
        const body = await readFile(join(clientDir, rel));
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
        res.end(body);
        return;
      } catch { /* fall through */ }
    }
    res.writeHead(404); res.end();
  });
  const wss = new WebSocketServer({
    server: http, path: '/ws', maxPayload: 16 * 1024,
    // with cookie sign-in, only our own pages may open a socket (cross-site WebSocket hijacking)
    verifyClient: (info: { origin: string }) => !auth.origins.length || auth.origins.includes(info.origin),
  });
  const alive = new WeakMap<WebSocket, boolean>();

  wss.on('connection', (ws, req) => {
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));
    const conn: Conn = {
      user: null, clientSeed: '', watching: new Set(),
      send: msg => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); },
    };
    room.connect(conn);
    conn.send({ t: 'hi', devTokens: auth.devTokens, loginUrl: auth.loginUrl || null });
    const u = userFromCookie(req.headers.cookie);
    if (u) room.signIn(conn, u);
    ws.on('message', data => {
      let msg: unknown;
      try { msg = JSON.parse(String(data)); } catch { conn.send({ t: 'error', code: 'proto', message: 'not JSON' }); return; }
      room.handle(conn, msg);
    });
    ws.on('close', () => room.disconnect(conn));
    ws.on('error', () => ws.terminate());
  });

  const beat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) { ws.terminate(); continue; }
      alive.set(ws, false);
      ws.ping();
    }
  }, 30_000);

  return new Promise(resolve => {
    http.listen(port, host, () => {
      const addr = http.address();
      const p = typeof addr === 'object' && addr ? addr.port : port;
      resolve({
        http, wss, port: p,
        close: () => new Promise<void>(done => {
          clearInterval(beat);
          for (const ws of wss.clients) ws.terminate();
          wss.close(() => http.close(() => done()));
        }),
      });
    });
  });
}
