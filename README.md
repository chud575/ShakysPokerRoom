# Shaky Bets Poker Room

A play-chip online poker room for home games, built to replace PokerStars Home Games and GG clubs.

| Folder | What | Status |
|---|---|---|
| `engine/` | Rules engine: 13 games, FL/PL/NL, side pots, provably-fair shuffle, PokerStars hand histories | Phase 1: done (36 tests + 4M-hand fuzz with Replayer round trip) |
| `server/` | Table server: seating, hand loop, event-log persistence and crash recovery, WebSocket protocol | Phase 2: done (9 integration tests, load-tested to 500 players) |
| `client/` | Web client: clubs, table in the Replayer's style, action controls, draw picker, fairness check, hand-history download, club admin (members, chips, ledger, settle-up report) | Phases 3–4 |

## Try it locally

```bash
cd server && npm install && DB=dev.db npm start -- --dev
```

Open http://localhost:8790 and sign in with `alice` (the dev users are alice…frank, and each token is the user's name). Alice owns the dev club, "Shaky Bets Home Game"; everyone in it starts with 100,000 chips. To get opponents, run this in a second terminal:

```bash
cd server && node tools/devbots.ts nlh-1 bob,carol,dave
```

The dev tables are `nlh-1`, `plo-1`, `horse-1` and `eight-1`.

## Clubs and chips

Chips belong to a club. The owner and admins **issue** chips to a member when that member pays them, and **redeem** chips when they pay the member out. Money settles outside the room. Members buy in at the club's tables from their club balance. Every movement is a row in the club ledger, and one invariant holds at all times (the tests check it after every action):

    chips issued − chips redeemed = member balances + chips on the club's tables

The **Settle up** tab shows each member's issued, redeemed, won/lost and balance for any date range, with a CSV download.

## Next

- ~~Phase 4: clubs and the club chip ledger~~ (done)
- Phase 5: tournaments
- Phase 6: hosting (Postgres, ShakyBets sign-in, a new droplet)
