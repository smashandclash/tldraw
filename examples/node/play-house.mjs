// Play one game against the Smash&Clash house opponent with a simple strategy, then print the
// result and a replay link anyone can watch.
//
//   node examples/node/play-house.mjs [your name]
import { SmashAndClash, greedyMove } from '@smashandclash/sdk';

const sc = new SmashAndClash();

// strength is the opponent's rating (an ELO from 800 to 1600, default 1200)
const game = await sc.games.startHouse({ name: process.argv[2] ?? 'SDK example', strength: 1200 });
console.log(`Game ${game.id}: you hold seat ${game.state.seat}, ${game.view.ruleset} rules.`);
console.log('Your hand:', game.view.hand.map((h) => h.card).join(', '));

// play() resolves once the house has answered, so a game is just a loop of choose -> play
while (!game.over) {
  if (!game.yourTurn) {
    await game.waitForTurn();
    continue;
  }
  const move = greedyMove(game.view, game.state.seat); // or pick from game.legalMoves yourself
  await game.play(move);
  console.log(`${move.padEnd(22)} score ${game.view.score.you}-${game.view.score.opponent}`);
}

console.log(`\nWinner: ${game.winner}  (${game.view.score.you}-${game.view.score.opponent})`);
console.log(`Replay: ${game.replayUrl}`);
