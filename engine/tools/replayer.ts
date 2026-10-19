/* Loads the PokerStars Replayer's parser + engine (+ equity) into Node so
   hand histories written here can be checked by the Replayer's own,
   independently written pot accounting. */

import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { join } from 'node:path';

export const REPLAYER_JS = join(import.meta.dirname, '../../../PokerStars Replayer/js');

export interface ReplayerApi {
  parse(text: string): any[];
  build(h: any): any[];
  sharesInto(key: string, hands: number[][], board: number[], out: number[]): boolean;
  cid(code: string): number;
}

export function loadReplayer(): ReplayerApi {
  const win: any = {};
  const ctx = { window: win, console, setTimeout, Math, Date, JSON };
  for (const f of ['parser.js', 'engine.js', 'equity.js'])
    runInNewContext(readFileSync(join(REPLAYER_JS, f), 'utf8'), ctx, { filename: f });
  return {
    parse: (t: string) => win.PSParser.parseFile(t, 'roundtrip'),
    build: (h: any) => win.PSEngine.build(h),
    sharesInto: (k, h, b, o) => win.PSEquity.sharesInto(k, h, b, o),
    cid: (c: string) => win.PSEquity.cid(c),
  };
}
