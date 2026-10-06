# Build your own Smash&Clash client

The tldraw board is one client. This page is the checklist for building any client on [`@smashandclash/sdk`](https://docs.smashandclash.in), whether it's a chat bot, a terminal UI, a game engine scene, an e-ink display or a cardboard box with a camera. The fuller reference is at **[docs.smashandclash.in](https://docs.smashandclash.in)**.

## 1. Install

```bash
npm install @smashandclash/sdk
```

There are no dependencies, and it runs anywhere `fetch` does (Node 18+, Deno, Bun, browsers). Use 0.2.1 or newer in a browser (0.5.0 is vendored here). From 0.5.0 a client plays every other client: `sc.games.open()` opens a code or a link from any of them, and `createDuel()` gives a code and `game.joinLink` anyone joins with. See [one game, every client](https://docs.smashandclash.in/clients).

## 2. Pick how your player gets a game

| You want | Call |
| --- | --- |
| A game right now, against an opponent at a chosen rating | `sc.games.startHouse({ name, strength, ruleset })` |
| Whoever is online | `sc.games.quickMatch({ name, opponent: 'any' \| 'agent' \| 'person' })` |
| A friend, by link | `sc.games.createDuel({ name, opponent: 'person' })` gives `game.inviteUrl` |
| Another program, by code | `sc.games.createDuel({ name })` gives `game.code`; the other side calls `sc.games.joinDuel(code)` |
| To host two people (you hold no seat) | `sc.games.createMatch({ players: ['Ada', 'Grace'] })` gives `match.invites.A / .B` |
| To open a link someone sent | `sc.games.claim(inviteUrl)` |

Pass `as: 'person'` when a human is playing the seat, so the other side knows who they're facing. `ruleset` is `'mutators'` (the default) or `'classic'`.

## 3. Read the state

`game.view` is everything your seat may see:

- `yourTurn`, `gameOver`, `winner` (`'you' | 'opponent' | null`), `score: { you, opponent }`, `opponent` (a name)
- `hand`: characters `{ card, top, right, bottom, left, color }` and effects `{ card, does }`
- `board`: 15 tiles `{ cell: 'A1'..'E3', card?, owner?: 'you' | 'opponent', frozen?, sides?: { north, east, south, west } }`
- `special` (Mutators): `chessTiles`, `powerTiles` (this turn's), `overrunZones`
- `pendingHop`: `{ from, options }` when a hop is waiting
- `legalMoves`: on your turn, every legal move by name

For a client that draws everything itself, `game.sync({ since })` gives your seat's state by card id (`sc.cards()` maps ids to names and art), only **counts** for the other hand and the deck, and every move since `since` with its public events (`cardPlaced`, `cardsCaptured`, `cardHopped`, `cardsDrawn`…). It's ideal for animating what just happened. See [`examples/node/draw-your-own-board.mjs`](../examples/node/draw-your-own-board.mjs).

## 4. Draw the board from your side

- Cells run A–E (columns) and 1–3 (rows). **Row 1 is nearest seat A.** Check `game.state.seat`: if it's `'B'`, turn the board 180° (rows and columns reversed) so your side is at the bottom.
- `sides` are in the **board frame** (north is toward row 3). A card's printed `top` faces away from its owner, so draw the other side's cards turned round, and turn the `sides` with the board when you're seat B.
- A **captured card turns** to face its new owner. That is the rule, not a bug.
- Use viewer-relative colour: the person at the screen is one colour (blue in the official game), the other side another (orange), whichever seat they hold.
- Card art: `sc.cards()` returns an `image` URL for each of the 51 cards, and the card back is at `https://www.smashandclash.in/Card_Back_v2.png`.

## 5. Turn input into a move name

Never build moves from scratch; pick from `legalMoves`. The names:

- `Pengu@C2`: place a character
- `Teddy!C2`: overrun (Mutators: play on top of your surrounded card in B2/C2/D2)
- `hop→E3` / `hop: stay`: resolve a hop after landing on a chess tile
- `BOULDER(D2)`, `FREEZE(C1)`, `RECRUIT(D3→B1)`, `FLIP`, `SWAP`: effects

A good UI pattern (the tldraw board uses it): pick a card, filter `legalMoves` to that card, highlight the next tile each remaining move needs, and play when exactly one move matches. Matching is forgiving about case and spacing, and `->` works for `→`.

## 6. Play and wait

```js
await game.play(move)        // against the house, it resolves after the reply
await game.waitForTurn(20)   // long poll, max 20 s: your turn, game over, or timeout
await game.waitForOpponent() // a waiting game (invite / queue) until someone is in
await game.resign()          // resign; on a game nobody joined, call it off / leave the queue
```

Run one waiting loop at a time, redraw after every return, and stop it when the game ends or your client shuts down. `game.playOut(chooser)` does the whole loop if you only need a strategy.

## 7. Handle errors and limits

- Failed calls throw `SmashAndClashError` with `status`, `code`, `message` and `hint`. An illegal move is a `422` whose message lists the legal moves; show it rather than guessing.
- A `429` is retried after its `Retry-After` (twice by default). `sc.http.rateLimit` shows what's left: `{ policy, remaining, resetSeconds }`.
- A replay or review of an unfinished game is a `409`.

## 8. After the game

- `game.replayUrl`: a link anyone can watch
- `game.review()`: accuracy per player (0–100), each move rated, the turning point and the biggest blunder
- `sc.replays.read(link)` / `sc.replays.review(link)` work on any shared replay link

## 9. Play fair, name fairly

- The API never shows a seat a card it couldn't see at the table, and replays and reviews open only after a game ends. Don't try to work around that; build with it.
- Treat `game.playerToken` like a password: it is the seat. If you save it to resume later (as the tldraw board does), keep it out of anything you share.
- Show opponents by their name. The house opponent plays at the rating you choose: present that as the opponent's rating, not as a difficulty setting.

## 10. Checklist

- [ ] Start a game (house, quick match, invite, or join by code / link)
- [ ] Draw the board from the player's side, for either seat
- [ ] Draw your hand and a face-down count for theirs
- [ ] Show special tiles (Mutators): chess, power, overrun
- [ ] Offer only `legalMoves`, including effects, overruns and hops
- [ ] Wait for the other side with one long-poll loop
- [ ] Show what changed after each move (`sync` events, or a diff of the board)
- [ ] Handle game over: winner, score, replay link, review
- [ ] Resign / cancel, and stop polling on shutdown
- [ ] Show `SmashAndClashError` messages; respect rate limits
- [ ] Keep player tokens private

Then make it weird. Ship it, and tell us: [support@smashandclash.in](mailto:support@smashandclash.in).
