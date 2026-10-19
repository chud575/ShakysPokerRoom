# Poker Room — table server (Phase 2)

The table server runs the rules engine (`../engine`) at live tables and handles seating, the button, game rotation, the action clock, persistence, crash recovery and a JSON WebSocket protocol.

```
npm install
npm test                         # 9 integration tests (in-process + real WebSockets)
DB=room.db PORT=8790 npm start -- --dev    # seeds 4 tables + users alice…frank (token = name)
node --disable-warning=ExperimentalWarning tools/load.ts 102 60   # load test
```

## Pieces

| File | What it does |
|---|---|
| `src/table.ts` | One table: seats, buy-ins and rebuys, sit out, leave, button, game rotation, hand loop, action clock and time bank, auto-act on timeout, restoring a table after a crash |
| `src/views.ts` | Builds what each viewer may see. This is the only place hand state becomes client data, so hole-card secrecy lives here |
| `src/room.ts` | All tables, who watches what, and the message protocol (listed at the top of the file) |
| `src/server.ts` | WebSocket transport on `/ws`, 16 KB message limit, ping/pong, `/health` |
| `src/store.ts` | SQLite event log: hands, actions, tables, users, play-chip ledger |
| `src/stakes.ts` | One stake level (small bet / big bet) turned into the posts and bet sizes for any game, so mixed tables keep one level |

## Guarantees

- **Write before broadcast.** An action is first checked against a copy of the hand, then written to the log, then committed in memory, and only then broadcast. The log never holds an illegal action, and nothing a player was shown is missing from it.
- **Crash recovery.** On start, every table is reloaded. An unfinished hand is rebuilt by replaying its config and actions through the engine, and the result is byte-identical (tested).
- **Atomic hand ends.** The result, the history, the new stacks and any cash-outs are written in one transaction.
- **Provably fair.** Each hand publishes `SHA-256(serverSeed)` before any action. Players' client seeds feed the deck. The server seed is revealed when the hand ends. `{t:'history'}` returns the player's own PokerStars-format history together with the proof.
- **Hole-card secrecy.** Every view sent in the tests (6 players plus an observer, all 13 games) is checked against the real hand. Mutating the masking code makes the test fail.

## Tested

- **Every game:** bots play 60+ hands per game from only what they're sent. Chips are conserved across balances, stacks and pots, and there are no leaks.
- **Table behaviour:**
  - Mixed rotation, with `HORSE (Razz Limit)` headers.
  - Timeouts: the time bank is used first, then the player auto-checks or folds and is sat out.
  - Illegal and out-of-turn actions are refused with no state change.
  - Leaving mid-hand folds you, then cashes you out when the hand ends.
  - Buy-in limits.
- **Crash recovery:** the server is killed mid-hand and restarted from the database, the hand finishes, and every chip is accounted for.
- **Real WebSockets:** a player disconnects mid-hand, reconnects and gets their turn and cards back.
- **Load** (M-series Mac, server and all bot clients in one process; bots act every 50–300 ms, far faster than people):

| Players | Tables | Hands/min | Actions/s | p99 latency | CPU | RSS |
|---|---|---|---|---|---|---|
| 102 | 17 | 178 | 90 | 1.4 ms | 5% of one core | 206 MB |
| 504 | 84 | 891 | 439 | 4.7 ms | 29% of one core | 306 MB |

## Not yet

- **Blind rules for new players.** Missed and dead blinds, and "wait for the big blind". Right now a new player is dealt in on the next hand.
- **Postgres adapter.** Needed for the hosted room. The schema in `store.ts` is plain SQL.
- **Real sign-in.** The ShakyBets accounts service is planned. Today, dev tokens come from the users table.
- **Rate limiting and chat.**
- **Clubs and the club chip ledger** (Phase 4), **tournaments** (Phase 5), and **the web client** (Phase 3).
