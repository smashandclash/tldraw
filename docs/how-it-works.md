# How the tldraw client works

A walk through [`board/script/main.js`](../board/script/main.js), in the order the code runs. Everything here is plain JavaScript on two public APIs: the tldraw editor and [`@smashandclash/sdk`](https://docs.smashandclash.in).

## 1. A board script

tldraw Desktop runs `script/main.js` when the board opens and again whenever the file changes. Its default export receives:

- `editor`: the live tldraw `Editor`
- `helpers`: editor-bound conveniences; the one this client depends on is `helpers.renderEphemeral(fn)`
- `signal`: an `AbortSignal`, aborted before a rerun and when the board closes
- `app`: `app.board.isHost`, false in an editor that joined someone else's shared board

A script can import `tldraw` (and `react`) from the app itself, and files that sit next to it. It can't install packages, which is why the SDK's browser build is vendored as `smashandclash-sdk.js` (`npm run vendor-sdk` refreshes it).

## 2. The SDK client

```js
const sc = new SmashAndClash({ fetch: fetchWithoutSdkHeader })
```

All game state lives on smashandclash.in; the board holds a `Game` object from the SDK and a player token. The custom `fetch` keeps the script working with SDK 0.2.0 too; from 0.2.1 the SDK needs nothing extra in a browser (see the note in the README).

## 3. State

Two kinds of state, kept in plain variables inside the default export, never in shapes:

- **Game state** is the SDK's `game.state` / `game.view`: whose turn it is, your hand, the board (each tile's card, owner, frozen flag and board-frame `sides`), the special tiles, `pendingHop`, the score and, on your turn, `legalMoves`.
- **UI state** is the selected hand card, the tiles clicked so far for a multi-tile effect, an optimistic `pending` card while a move is in flight, the tiles that changed with the last move (outlined in violet), notices, and the "click again to confirm" arm.

Keeping UI state per editor matters on a shared board: one person's selection should never be broadcast to everyone.

## 4. Drawing: `scene()` and `render()`

`scene()` is a pure function of state. It returns a list of `[shapePartial, layer, onClick?]`:

- the header (logo image, title),
- the opponent's name, rating and face-down hand (the real card back),
- 15 tile shapes (labels for chess, power and overrun tiles when empty), each card as a coloured frame plus an `image` shape with the card's art from `sc.cards()`,
- your hand, the side panel (status, details, an action button, scores, six buttons, your record),
- highlights: green outlines for legal targets, a violet dashed outline for what just changed.

Opponent cards are drawn **turned round** (`rotation: Math.PI`), because a card's printed values read from its owner's side. If you hold seat B, the whole board is turned so your side is at the bottom.

`render()` diffs that list against the last frame (by shape id and JSON), then creates, updates and deletes shapes inside:

```js
helpers.renderEphemeral(() =>
  editor.run(() => { /* createShapes / updateShapes / deleteShapes */ }, { history: 'ignore', ignoreShapeLock: true })
)
```

`renderEphemeral` writes render immediately but never dirty the document, land in a save, sync to other participants or enter undo. After creating shapes it brings each layer to the front in order, so a highlight is always above a card.

**Gotcha:** ephemeral shapes outlive a script rerun. The script deletes every `shape:sc-*` shape on start and on abort, or a rerun would leave the last run's cards on the board.

## 5. Input

Game shapes are created `isLocked: true`, so a click doesn't select them. The script listens to the editor's events and hit-tests its own clickable shapes:

```js
editor.on('event', (info) => {
  if (info.type !== 'pointer' || info.name !== 'pointer_down') return
  const point = editor.screenToPage(info.point)
  const hit = clickables.find(({ id }) => editor.isPointInShape(id, point, { hitInside: true }))
  if (hit) setTimeout(hit.onClick, 0) // out of the editor's dispatch: renderEphemeral can't run inside editor.run
})
```

**Gotcha:** keep controls in fixed places. An early version grew the panel when a notice appeared, which pushed every button down, and the click that confirms "Resign" landed on a different button.

## 6. Turning clicks into moves

Every move is a string from `game.view.legalMoves`. The client parses each one into a key and the tiles it needs:

| Move | Key | Tiles |
| --- | --- | --- |
| `Pengu@C2` (place) / `Teddy!C2` (overrun) | `Pengu` / `Teddy` | `C2` |
| `BOULDER(D2)`, `FREEZE(C1)` | `BOULDER`, `FREEZE` | `D2` / `C1` |
| `RECRUIT(D3→B1)` | `RECRUIT` | `D3`, then `B1` |
| `FLIP`, `SWAP` | `FLIP`, `SWAP` | none |
| `hop→E3` / `hop: stay` | `hop` | `E3` / none |

A hand card's key is its name, or for an effect its keyword (`Boulder!` → `BOULDER`). Selecting a card filters `legalMoves` to its key; the next tile each remaining move needs is lit green; clicking tiles walks the path until exactly one move matches, and that move is played. A move with no tiles plays on a second click. A pending hop restricts everything to `hop` moves. The client never invents a move, so it can't send an illegal one.

## 7. The game loop

```js
async function pump() {            // one at a time (a generation counter cancels stale pumps)
  while (game && !game.over && !game.yourTurn) {
    await game.waitForTurn(20)     // long poll: returns when it's your turn, the game ends, or 20 s pass
    render()
  }
}
```

After every state change, `afterChange()` works out which tiles changed (for the outline), finishes the game if it's over (`game.review()` for accuracy, rating update, replay link) or starts the pump. Against the house, `game.play()` resolves after the reply, so the pump returns at once.

## 8. Game modes

- **New game**: `startHouse({ strength })`. The board keeps a local rating (starting at 1200, updated by ELO after each game) and passes it as `strength`, so the opponent tracks your level. The house opponent appears under a player handle chosen from the game id (the same name shapes as the online lobby), with its rating.
- **Quick match**: `quickMatch({ opponent: 'any' })`. While `game.waiting`, the pump's long polls hold your place in the queue; **Cancel** resigns, which leaves it.
- **Invite a friend**: `createDuel({ opponent: 'person' })`. The invite link is copied to the clipboard and shown in the panel. No `opponentName` is passed, so your friend's own name appears once they open the link.

## 9. Persistence

The document keeps one record in `document.meta.smashandclash`: `{ rating, played, won, ruleset, active }`, where `active` holds the game in progress (`id`, `playerToken`, mode). On open, the script calls `sc.games.resume(id, token)` and carries on. That write is the only persisted one, done with `history: 'ignore'`, and only by the board's host. `active` goes back to `null` when a game ends or is called off.

**Keep in mind:** while a game is in progress the record holds that game's player token, which is that seat. Don't share a board file mid-game.

## 10. Shared boards

When a board is shared, every participant's editor runs the same script. Because drawing and UI state are per editor, each person simply plays their own game. Only the host (`app.board.isHost`) writes the record, so guests never fight over the document.

## 11. The things that bit us

- `renderEphemeral` can't be called inside `editor.run`. Nest it the other way round, and leave event handlers with `setTimeout` first.
- A locked shape ignores `editor.updateShapes` unless you pass `ignoreShapeLock: true`.
- A geo label needs room (a one-line `m` label needs about 70 px of height). Too little and tldraw grows the shape, which overlaps its neighbours.
- tldraw shape ids are bound to a type for the editor's life: never reuse an id for a different shape type.
- A captured card turns to face its new owner. That isn't a rendering bug; it's the rule ("a card belongs to the player it faces").
