/* WebSocket transport for the Room: JSON messages on /ws, a small payload
   limit, and ping/pong so dead connections drop (and the player shows as
   disconnected) instead of lingering. */

import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Room, Conn } from './room.ts';

export interface Listening { http: Server; wss: WebSocketServer; port: number; close(): Promise<void> }

const CLIENT = join(import.meta.dirname, '../../client');
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

export function listen(room: Room, port: number, host = '127.0.0.1', clientDir = CLIENT): Promise<Listening> {
  const http = createServer(async (req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    if (url === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }
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
  const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 16 * 1024 });
  const alive = new WeakMap<WebSocket, boolean>();

  wss.on('connection', ws => {
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));
    const conn: Conn = {
      user: null, clientSeed: '', watching: new Set(),
      send: msg => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); },
    };
    room.connect(conn);
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
