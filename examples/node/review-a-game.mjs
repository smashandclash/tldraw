// Read a finished game back: its replay (every move and the score after it) and its Game Review
// (each move rated, accuracy per player, the turning point and the biggest blunder).
// Takes a game id or any shared replay link (https://www.smashandclash.in/replay#z=...).
//
//   node examples/node/review-a-game.mjs <gameId | replay link>
import { SmashAndClash } from '@smashandclash/sdk';

const sc = new SmashAndClash();
const arg = process.argv[2];
if (!arg) {
  console.log('Usage: node examples/node/review-a-game.mjs <gameId | replay link>');
  process.exit(1);
}
const isLink = arg.startsWith('http');
const replay = isLink ? await sc.replays.read(arg) : await sc.games.replay(arg);
const review = isLink ? await sc.replays.review(arg) : await sc.games.review(arg);

console.log(`${replay.players.A} (A) vs ${replay.players.B} (B), ${replay.ruleset}: winner ${replay.winner}, ${replay.score.A}-${replay.score.B}`);
console.log(`Accuracy: A ${Math.round(review.accuracy.A)}%, B ${Math.round(review.accuracy.B)}%\n`);
for (const m of review.moves) {
  const mark = m.n === review.turningPoint ? '  <- turning point' : m.n === review.biggestBlunder ? '  <- biggest blunder' : '';
  console.log(`${String(m.n).padStart(2)}. ${m.seat}  ${m.name.padEnd(20)} ${review.classes[m.class] ?? m.class}${mark}`);
}
