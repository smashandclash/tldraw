// "Draw your own board": play the house and render the table yourself from game.sync(), the
// per-seat state stream a custom client draws from (your hand and the board by card id, only
// COUNTS for the other hand and the deck, and every move's public events).
//
//   node examples/node/draw-your-own-board.mjs
import { SmashAndClash, firstLegalMove } from '@smashandclash/sdk';

const sc = new SmashAndClash();
const names = new Map((await sc.cards()).map((c) => [c.id, c.name])); // the deck: 46 characters + 5 effects
const game = await sc.games.startHouse({ name: 'Board drawer' });
const me = game.state.seat;

function draw(state) {
  // state.board[r][c]: r 0..2 is row 1..3, c 0..4 is column A..E. Draw row 3 at the top for seat A,
  // and turned round for seat B, so your side is always at the bottom.
  const rows = me === 'A' ? [2, 1, 0] : [0, 1, 2];
  const cols = me === 'A' ? [0, 1, 2, 3, 4] : [4, 3, 2, 1, 0];
  const cell = (p) => (p ? `${p.owner === me ? '+' : '-'}${names.get(p.cardId)}${p.frozen ? '*' : ''}` : '.').slice(0, 11).padEnd(12);
  console.log(`      ${cols.map((c) => 'ABCDE'[c].padEnd(12)).join('')}`);
  for (const r of rows) console.log(`  ${r + 1}   ${cols.map((c) => cell(state.board[r][c])).join('')}`);
  console.log(`  hand: ${state.hand.map((id) => names.get(id)).join(', ')} | their hand: ${state.opponentHand} cards | deck: ${state.deck}`);
  if (state.powerTiles?.length) console.log(`  power tiles: ${state.powerTiles.map((p) => `${'ABCDE'[p.cell.c]}${p.cell.r + 1} +${p.boost} ${p.color}`).join(', ')}`);
}

let since = 0;
while (true) {
  const s = await game.sync({ since });
  for (const m of s.moves) {
    const events = m.events.map((e) => e.type).join(', ');
    console.log(`\n#${m.index + 1} ${m.seat === me ? 'you' : 'them'}: ${m.name}   [${events}]`);
  }
  since = s.moveCount;
  draw(s.state);
  if (s.status === 'finished') break;
  await game.refresh();
  if (game.yourTurn) await game.play(firstLegalMove(game.view));
  else await game.waitForTurn();
}
console.log(`\nWinner: ${game.winner}. Replay: ${game.replayUrl}`);
