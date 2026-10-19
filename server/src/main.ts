/* Start the room.
     DB=room.db PORT=8790 node src/main.ts [--dev]
   Production settings come from the environment (deploy/poker-room.env.example):
     ROOM_HANDOFF_SECRET, ROOM_LOGIN_URL, ROOM_ORIGINS, ROOM_SECURE_COOKIE.
   --dev seeds a club ("Shaky Bets Home Game", owner alice) with members
   bob…frank, 100k chips each, and four tables.  Tokens = user names. */

import { Store } from './store.ts';
import { Room } from './room.ts';
import { listen } from './server.ts';
import { authFromEnv } from './auth.ts';
import type { TableConfig } from './table.ts';

const dev = process.argv.includes('--dev');
const auth = authFromEnv(process.env, dev);
if (!dev) {
  const missing = [!auth.secret || auth.secret.length < 32 ? 'ROOM_HANDOFF_SECRET (32+ chars)' : '', !auth.origins.length ? 'ROOM_ORIGINS' : ''].filter(Boolean);
  if (missing.length) { console.error('not starting: set ' + missing.join(' and ') + ' (or run with --dev)'); process.exit(1); }
}
if (dev) auth.secureCookie = false;
const store = new Store(process.env.DB ?? 'room.db');

const base = { minBuyIn: 400, maxBuyIn: 4000, actionSeconds: 30, timeBankSeconds: 60, betweenHandsMs: 3000 };
export function devTables(clubId: string): TableConfig[] {
  return [
    { id: 'nlh-1', clubId, name: 'Hold\'em 6-max', maxSeats: 6, games: [{ game: 'holdem', structure: 'NL' }], handsPerGame: 1, stakes: { smallBet: 20, bigBet: 40 }, ...base },
    { id: 'plo-1', clubId, name: 'PLO', maxSeats: 6, games: [{ game: 'omaha', structure: 'PL' }], handsPerGame: 1, stakes: { smallBet: 20, bigBet: 40 }, ...base },
    { id: 'horse-1', clubId, name: 'HORSE', maxSeats: 8, mixedName: 'HORSE', handsPerGame: 8, stakes: { smallBet: 20, bigBet: 40 }, ...base,
      games: [{ game: 'holdem', structure: 'FL' }, { game: 'omaha8', structure: 'FL' }, { game: 'razz', structure: 'FL' }, { game: 'stud', structure: 'FL' }, { game: 'stud8', structure: 'FL' }] },
    { id: 'eight-1', clubId, name: '8-Game', maxSeats: 6, mixedName: '8-Game', handsPerGame: 6, stakes: { smallBet: 20, bigBet: 40 }, ...base,
      games: [{ game: 'td27', structure: 'FL' }, { game: 'holdem', structure: 'FL' }, { game: 'omaha8', structure: 'FL' }, { game: 'razz', structure: 'FL' },
        { game: 'stud', structure: 'FL' }, { game: 'stud8', structure: 'FL' }, { game: 'holdem', structure: 'NL' }, { game: 'omaha', structure: 'PL' }] },
  ];
}

let devClub: string | null = null;
if (dev) {
  const names = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank'];
  for (const n of names) if (!store.userByToken(n)) store.createUser(n, n, n);
  devClub = store.clubsOf('alice').find(c => c.role === 'owner')?.id ?? null;
  if (!devClub) {
    const club = store.createClub('alice', 'Shaky Bets Home Game');
    devClub = club.id;
    for (const n of names) {
      if (n !== 'alice') { store.requestJoin(club.id, n); store.setMember(club.id, n, { status: 'active' }); }
      store.adjust(club.id, n, 100_000, 'issue', { actorId: 'alice', note: 'dev seed' });
    }
  }
}
const room = new Room(store);
if (devClub) for (const cfg of devTables(devClub)) if (!room.tables.has(cfg.id) && !store.tableClub(cfg.id)) room.createTable(cfg);

const srv = await listen(room, Number(process.env.PORT ?? 8790), process.env.HOST ?? '127.0.0.1', undefined, auth);
console.log(`poker room on ws://127.0.0.1:${srv.port}/ws  (${room.tables.size} tables)` + (devClub ? `  dev club invite code ${store.club(devClub)!.inviteCode}` : ''));

const stop = async () => { room.close(); await srv.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
