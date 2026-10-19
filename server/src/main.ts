/* Start the room.
     DB=room.db PORT=8790 node src/main.ts [--dev]
   --dev seeds a few tables and test users (tokens = their names, 100k play chips). */

import { Store } from './store.ts';
import { Room } from './room.ts';
import { listen } from './server.ts';
import type { TableConfig } from './table.ts';

const dev = process.argv.includes('--dev');
const store = new Store(process.env.DB ?? 'room.db');

const base = { minBuyIn: 400, maxBuyIn: 4000, actionSeconds: 30, timeBankSeconds: 60, betweenHandsMs: 3000 };
export const DEV_TABLES: TableConfig[] = [
  { id: 'nlh-1', name: 'Hold\'em 6-max', maxSeats: 6, games: [{ game: 'holdem', structure: 'NL' }], handsPerGame: 1, stakes: { smallBet: 20, bigBet: 40 }, ...base },
  { id: 'plo-1', name: 'PLO', maxSeats: 6, games: [{ game: 'omaha', structure: 'PL' }], handsPerGame: 1, stakes: { smallBet: 20, bigBet: 40 }, ...base },
  { id: 'horse-1', name: 'HORSE', maxSeats: 8, mixedName: 'HORSE', handsPerGame: 8, stakes: { smallBet: 20, bigBet: 40 }, ...base,
    games: [{ game: 'holdem', structure: 'FL' }, { game: 'omaha8', structure: 'FL' }, { game: 'razz', structure: 'FL' }, { game: 'stud', structure: 'FL' }, { game: 'stud8', structure: 'FL' }] },
  { id: 'eight-1', name: '8-Game', maxSeats: 6, mixedName: '8-Game', handsPerGame: 6, stakes: { smallBet: 20, bigBet: 40 }, ...base,
    games: [{ game: 'td27', structure: 'FL' }, { game: 'holdem', structure: 'FL' }, { game: 'omaha8', structure: 'FL' }, { game: 'razz', structure: 'FL' },
      { game: 'stud', structure: 'FL' }, { game: 'stud8', structure: 'FL' }, { game: 'holdem', structure: 'NL' }, { game: 'omaha', structure: 'PL' }] },
];

if (dev) {
  for (const n of ['alice', 'bob', 'carol', 'dave', 'erin', 'frank']) if (!store.userByToken(n)) store.createUser(n, n, n, 100_000);
}
const room = new Room(store);
if (dev) for (const cfg of DEV_TABLES) if (!room.tables.has(cfg.id)) room.createTable(cfg);

const srv = await listen(room, Number(process.env.PORT ?? 8790), process.env.HOST ?? '127.0.0.1');
console.log(`poker room on ws://127.0.0.1:${srv.port}/ws  (${room.tables.size} tables)`);

const stop = async () => { room.close(); await srv.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
