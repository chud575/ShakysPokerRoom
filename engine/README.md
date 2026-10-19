# Poker Room — rules engine (Phase 1)

A deterministic rules engine for the poker room. It runs every game in the first release, in fixed limit, pot limit and no limit, and writes PokerStars-format hand histories that the PokerStars Replayer reads unchanged.

There are no runtime dependencies. Node 24 runs the TypeScript directly, and `typescript` is used only for type checking.

```
npm install          # typescript + @types/node (type checking only)
npm run typecheck
npm test             # evaluator + rules tests
npm run fuzz -- 200000 --hh     # random hands, invariants + Replayer round trip
```

## Games

| id | Game | Structures (default first) | Max seats |
|---|---|---|---|
| holdem | Hold'em | NL, FL, PL | 10 |
| omaha | Omaha (PLO) | PL, NL, FL | 10 |
| omaha8 | Omaha Hi/Lo | FL, PL, NL | 10 |
| bigo | Big O (5-card Omaha Hi/Lo) | PL, FL, NL | 9 |
| plo5 | 5 Card PLO | PL, NL, FL | 9 |
| plo6 | 6 Card PLO | PL, NL, FL | 7 |
| stud | 7 Card Stud | FL | 8 |
| stud8 | Stud Hi/Lo | FL | 8 |
| razz | Razz | FL | 8 |
| td27 | 2-7 Triple Draw | FL, PL, NL | 6 |
| sd27 | 2-7 Single Draw | NL, PL, FL | 6 |
| a5td | A-5 Triple Draw | FL, PL, NL | 6 |
| badugi | Badugi | FL, PL, NL | 6 |

## API

```ts
import { startHand, legalActions, applyAction } from './src/engine.ts';
import { handHistory } from './src/hh.ts';

let s = startHand(config);            // posts antes/blinds, deals, sets who acts
const L = legalActions(s);            // { player, fold, check, call, bet, raise, bringIn, draw }
s = applyAction(s, { type: 'raise', amount: 60 });   // amount = raise TO; throws if illegal
handHistory(s, 'all');                // archive copy, every card shown
handHistory(s, 2);                    // what player index 2 is allowed to see
```

A hand is fully determined by its config (which includes the hand seed) plus its list of actions. That makes replay, crash recovery and audits a simple fold over the action list. `applyAction` is pure; `applyActionMut` mutates in place and is what the fuzzer uses.

## Shuffling (provably fair)

`src/rng.ts` works per hand like this:

1. The server picks a secret `serverSeed` from the OS CSPRNG.
2. It publishes `SHA-256(serverSeed)` before dealing.
3. Each player supplies a client seed.
4. `handSeed = HMAC-SHA256(serverSeed, handId | clientSeeds…)`.
5. The server reveals `serverSeed` after the hand.

Every random draw comes from labelled HMAC streams keyed by `handSeed`. That covers the deal and any reshuffle of draw-game discards. The shuffle is Fisher-Yates with rejection sampling, so there is no modulo bias. A chi-square test checks its uniformity.

## Rules implemented

- **Blinds and position.**
  - Small and big blind sit left of the button.
  - Heads-up, the button posts the small blind. It acts first before the flop or draw, and last after.
  - A short big blind still sets the full big blind as the amount to call.
- **Fixed limit.**
  - The big blind counts as the first bet. On 3rd street in stud, the completion counts as the first bet.
  - The cap is 4 bets (`capBets`). Uncapped heads-up is optional (`uncappedHeadsUp`).
  - An all-in for at least half a bet more counts as a raise. Raises are measured from the last full bet, so with a 20 big blind and a short all-in to 25, the next raise goes to 40.
- **No limit and pot limit.**
  - The minimum raise is the size of the last full raise.
  - A short all-in does not reopen the betting for players who have already acted, unless several short all-ins add up to a full raise (TDA).
  - Pot limit allows 3.5 big blinds preflop and a pot-sized raise after calling.
- **Stud.**
  - Antes, then the bring-in:
    - Stud and Stud 8: lowest door card brings in, suits ranked c < d < h < s.
    - Razz: highest door card brings in (ace low), with spades highest.
  - The bring-in player may complete instead.
  - From 4th street, the best exposed hand acts first: pairs count, straights and flushes don't. In razz, the lowest hand acts first. Equal boards are broken by the suit of the top card.
  - Stud Hi has the open-pair big-bet option on 4th street.
  - If the deck can't give every remaining player a 7th card, one community card is dealt face up.
- **Draw games.**
  - All-in players still draw.
  - When the stub runs short, the earlier discards are reshuffled into it. The discards of the player being served are never included.
- **Pots.**
  - Uncalled bets are returned at the end of each round.
  - Main and side pots are built from each player's total contribution.
  - Split pots give the odd chip to the high half.
  - Tied winners get odd chips in seat order starting left of the button. In stud, the winner holding the highest card by suit gets it first.

## How it's verified

- **Evaluators** (`test/evaluate.test.ts`): high, 2-7, A-5, razz, 8-or-better, badugi, and Omaha with 4, 5 and 6 hole cards. Each is checked against naive brute-force scorers written separately in the test, 6,000 random comparisons apiece.
- **Rules** (`test/rules.test.ts`): stacked-deck scenarios for every rule listed above. Mutating the engine (for example, flipping the bring-in suit order or dropping the NL reopen rule) makes these tests fail.
- **Fuzzer** (`tools/fuzz.ts`): random tables with many short stacks, plus random-but-legal bots that use the whole bet-size range.
  - Invariants are checked after every action: chips conserved, every card exactly once, nets sum to zero.
  - Illegal actions are sent as probes. They must throw and leave the state untouched.
  - With `--hh`, every hand history (the archive copy plus one player's view) is parsed by the Replayer's own parser and replayed by its own engine. Its per-player result must match ours exactly.
  - Single-pot showdowns are re-scored with the Replayer's equity code.

## Notes

- The 2-7 evaluator here treats A-2-3-4-5 as ace high, not a straight. The Replayer's `evalHigh` counts it as a wheel straight in 2-7 too, which is wrong. The fuzzer skips those showdowns when it cross-checks.
- `testDeck` in the config stacks the deck. It's for tests only, and the server must never set it.
