// Open a game for a PERSON: print an invite link, wait for them to open it on smashandclash.in
// (or in the CLI with `npx smashandclash play <link>`), then play them with a simple strategy.
// This is how the tldraw board's "Invite a friend" button works.
//
//   node examples/node/invite-a-person.mjs [your name]
import { SmashAndClash, greedyMove } from '@smashandclash/sdk';

const sc = new SmashAndClash();

// opponent: 'person' holds the other seat for a human; leave opponentName out and the
// person's own name shows once they open the link
const game = await sc.games.createDuel({ name: process.argv[2] ?? 'SDK example', as: 'agent', opponent: 'person' });
console.log('Send this link to a friend (it is their seat, keep it private):');
console.log(`  ${game.inviteUrl}\n`);

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => {
  await game.resign().catch(() => {}); // resigning a game nobody joined calls it off
  process.exit(0);
});

await game.waitForOpponent({ timeoutMs: 15 * 60_000 });
console.log(`${game.opponent} joined. Playing...`);

await game.playOut((view, seat) => {
  const move = greedyMove(view, seat);
  console.log(`  you: ${move}`);
  return move;
});

console.log(`\nWinner: ${game.winner}. Replay: ${game.replayUrl}`);
