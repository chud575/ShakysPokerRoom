# Shaky Bets Poker Room

A play-chip online poker room for home games, built to replace PokerStars Home Games and GG clubs.

| Folder | What | Status |
|---|---|---|
| `engine/` | Rules engine: 13 games, FL/PL/NL, side pots, provably-fair shuffle, PokerStars hand histories | Phase 1: done (36 tests + 4M-hand fuzz with Replayer round trip) |
| `server/` | Table server: seating, hand loop, event-log persistence and crash recovery, WebSocket protocol, clubs and chip ledger, tournaments | Phases 2, 4, 5: done (20 integration tests, load-tested to 500 players) |
| `client/` | Web client: clubs, tables in the Replayer's style, action controls, draw picker, fairness check, hand-history download, club admin (members, chips, ledger, settle-up report), tournament lobby and registration | Phases 3–5 |

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

## Tournaments

- **Sit & Go.** Starts when full.
- **Scheduled multi-table tournaments.** Late registration, and admins can start or cancel.
- **Any game or mix.** Tournaments use the same 13 games and rotations as cash tables.
- **Structure.** A level clock. Blinds start near 1/100 of the stack and rise 25–33% a level, with antes from level 4.
- **Seating.** A random draw. Tables are kept within one player of each other, and tables break down to a final table. Players are only ever moved between their own hands.
- **Payouts.** By field size. Players who bust in the same hand with the same stack going in tie and split. Prizes are paid into club balances.
- **Money.** Entry fees sit in the prize pool, and the ledger invariant includes the pools.

Not yet: rebuys and add-ons, bounties, hand-for-hand on the bubble, scheduled breaks, a blind-structure editor, and moving players by blind position.

## Next

- ~~Phase 4: clubs and the club chip ledger~~ (done)
- ~~Phase 5: tournaments~~ (done: sit-and-gos and multi-table)
- Phase 6: hosting (Postgres, ShakyBets sign-in, a new droplet)
