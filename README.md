# Shaky Bets Poker Room

A play-chip online poker room for home games, built to replace PokerStars Home Games and GG clubs.

| Folder | What | Status |
|---|---|---|
| `engine/` | Rules engine: 13 games, FL/PL/NL, side pots, provably-fair shuffle, PokerStars hand histories | Phase 1: done (36 tests + 4M-hand fuzz with Replayer round trip) |
| `server/` | Table server: seating, hand loop, event-log persistence and crash recovery, WebSocket protocol | Phase 2: done (9 integration tests, load-tested to 500 players) |
| `client/` | Web client: lobby, table in the Replayer's style, action controls, draw picker, fairness check, hand-history download | Phase 3: first version |

## Try it locally

```bash
cd server && npm install && DB=dev.db npm start -- --dev
```

Open http://localhost:8790 and sign in with `alice` (the dev users are alice…frank, and each token is the user's name). To get opponents, run this in a second terminal:

```bash
cd server && node tools/devbots.ts nlh-1 bob,carol,dave
```

The dev tables are `nlh-1`, `plo-1`, `horse-1` and `eight-1`.

## Next

- Phase 4: clubs and the club chip ledger
- Phase 5: tournaments
- Phase 6: hosting (Postgres, ShakyBets sign-in, a new droplet)
