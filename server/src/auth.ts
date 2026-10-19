/* Signing in through the ShakyBets accounts service.

   The room runs on its own droplet, so it cannot read the main site's session
   cookie.  Instead the main site hands players over:

     1. A signed-in ShakyBets user who has the "Poker Room" tool opens
        https://shakybetspokertools.com/room.  The accounts service answers with
        a redirect to  <room>/auth/handoff?t=<pass>.
     2. The pass is  base64url(JSON {u: user id, n: username, e: expiry (unix s), r: nonce})
        "." base64url(HMAC-SHA256(shared secret, the first part)), good for 60 s
        and usable once.
     3. The room checks it, creates or refreshes the player ("sb<user id>"),
        and sets its own session cookie; the WebSocket signs in from that cookie.

   Access (who may play at all) stays in the accounts service's /admin: the
   pass is only ever issued to users granted the Poker Room tool. */

import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export interface AuthConfig {
  /** shared with the accounts service (ROOM_HANDOFF_SECRET there) */
  secret: string;
  /** where players sign in: the main site's /room */
  loginUrl: string;
  /** dev only: allow { t:'hello', token } logins */
  devTokens: boolean;
  /** WebSocket Origin must be one of these (empty = any; dev only) */
  origins: string[];
  /** Secure cookie (true behind https) */
  secureCookie: boolean;
}

export const COOKIE = 'pr_session';
export const SESSION_DAYS = 30;

const b64 = (b: Buffer) => b.toString('base64url');
export const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export interface Pass { u: number | string; n: string; e: number; r: string }

/** make a pass — the accounts service does this in Python; this one is for tests */
export function makePass(secret: string, p: Pass): string {
  const body = b64(Buffer.from(JSON.stringify(p)));
  return body + '.' + b64(createHmac('sha256', secret).update(body).digest());
}

/** check signature and expiry; returns the pass or throws */
export function readPass(secret: string, token: string, nowSec: number): Pass {
  if (!secret || secret.length < 32) throw new Error('sign-in is not configured');
  const [body, sig] = String(token).split('.');
  if (!body || !sig) throw new Error('bad pass');
  const want = createHmac('sha256', secret).update(body).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw new Error('bad pass');
  let p: Pass;
  try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { throw new Error('bad pass'); }
  if (!p || !p.u || typeof p.n !== 'string' || !p.r || typeof p.e !== 'number') throw new Error('bad pass');
  if (p.e < nowSec) throw new Error('this sign-in link has expired — open the Poker Room from the site again');
  if (p.e > nowSec + 300) throw new Error('bad pass');
  return p;
}

export const newSessionToken = () => b64(randomBytes(32));

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(token: string, secure: boolean, maxAgeSec = SESSION_DAYS * 86400): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}` + (secure ? '; Secure' : '');
}

/** configuration from the environment (see deploy/poker-room.env.example) */
export function authFromEnv(env: NodeJS.ProcessEnv, dev: boolean): AuthConfig {
  return {
    secret: env.ROOM_HANDOFF_SECRET ?? '',
    loginUrl: env.ROOM_LOGIN_URL ?? 'https://shakybetspokertools.com/room',
    devTokens: dev || env.ROOM_DEV_TOKENS === '1',
    origins: (env.ROOM_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean),
    secureCookie: env.ROOM_SECURE_COOKIE !== '0',
  };
}
