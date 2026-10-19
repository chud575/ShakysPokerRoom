/* Provably-fair shuffling.

   Per hand the server:
     1. picks a secret serverSeed (32 random bytes from the OS CSPRNG) and
        publishes commitment = SHA-256(serverSeed) before any card is dealt;
     2. collects a clientSeed from every player dealt in;
     3. derives handSeed = HMAC-SHA256(serverSeed, handId | clientSeeds…);
     4. reveals serverSeed after the hand, so anyone can recompute the deck.

   The engine only ever sees handSeed.  Every random draw in a hand (the
   initial shuffle, any reshuffle of draw-game discards) comes from a
   labelled HMAC stream keyed by it, so a hand is fully reproducible from
   (handSeed, actions) — the basis for replay, crash recovery and audits. */

import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { Card } from './cards.ts';

export const newServerSeed = (): string => randomBytes(32).toString('hex');
export const commitment = (serverSeed: string): string =>
  createHash('sha256').update(Buffer.from(serverSeed, 'hex')).digest('hex');

export function handSeed(serverSeed: string, handId: string, clientSeeds: readonly string[]): string {
  const h = createHmac('sha256', Buffer.from(serverSeed, 'hex'));
  h.update(handId);
  for (const c of clientSeeds) { h.update('|'); h.update(c); }
  return h.digest('hex');
}

/** Deterministic byte stream: HMAC(seed, label | counter) blocks. */
export class Stream {
  private key: Buffer;
  private label: string;
  private counter = 0;
  private buf: Buffer = Buffer.alloc(0);
  private pos = 0;

  constructor(seedHex: string, label: string) {
    this.key = Buffer.from(seedHex, 'hex');
    this.label = label;
  }

  private u32(): number {
    if (this.pos + 4 > this.buf.length) {
      this.buf = createHmac('sha256', this.key).update(this.label + '|' + this.counter++).digest();
      this.pos = 0;
    }
    const v = this.buf.readUInt32BE(this.pos);
    this.pos += 4;
    return v;
  }

  /** uniform integer in [0, n) — rejection sampling, no modulo bias */
  int(n: number): number {
    if (n <= 0 || n > 0x100000000) throw new Error('bad range');
    const limit = 0x100000000 - (0x100000000 % n);
    for (;;) {
      const v = this.u32();
      if (v < limit) return v % n;
    }
  }
}

/** Fisher-Yates, in place. */
export function shuffle(cards: Card[], s: Stream): Card[] {
  for (let i = cards.length - 1; i > 0; i--) {
    const j = s.int(i + 1);
    const t = cards[i]; cards[i] = cards[j]; cards[j] = t;
  }
  return cards;
}
