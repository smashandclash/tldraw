// Watch a public game live, as a spectator (the public board only, never a hand).
//
//   node examples/node/watch-live.mjs [gameId]
import { SmashAndClash } from '@smashandclash/sdk';

const sc = new SmashAndClash();

let id = process.argv[2];
if (!id) {
  const live = await sc.games.live();
  if (!live.length) {
    console.log('Nobody is playing a public game right now. Recently finished:');
    for (const g of await sc.games.live({ status: 'finished', limit: 5 })) console.log(`  ${g.id}  ${g.players.A} vs ${g.players.B}  ${g.score.A}-${g.score.B}`);
    process.exit(0);
  }
  for (const g of live) console.log(`  ${g.id}  ${g.players.A} vs ${g.players.B}  move ${g.moveCount}  ${g.score.A}-${g.score.B}`);
  id = live[0].id;
}

console.log(`\nWatching ${id}...`);
for await (const s of sc.games.spectate(id, { timeoutMs: 10 * 60_000 })) {
  console.log(`move ${String(s.moveCount).padStart(2)}  ${(s.lastMove ?? '-').padEnd(20)} ${s.players.A} ${s.score.A} - ${s.score.B} ${s.players.B}`);
}
console.log('Game over.');
