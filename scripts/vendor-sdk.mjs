// A tldraw board script can't install packages: it imports files that sit next to it. This copies
// the SDK's published browser build (node_modules/@smashandclash/sdk/dist/index.js) into each board
// script folder, as smashandclash-sdk.js. Run it after `npm install` or an SDK upgrade.
//
//   npm install && npm run vendor-sdk
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = join(root, 'node_modules', '@smashandclash', 'sdk', 'package.json'); // the package exports no ./package.json
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const dist = readFileSync(join(dirname(pkgPath), 'dist', 'index.js'), 'utf8');

const header = `// @smashandclash/sdk ${pkg.version}, the published npm build (https://www.npmjs.com/package/@smashandclash/sdk),
// bundled with this board so the game runs without a package install. Docs: https://docs.smashandclash.in
`;
for (const dir of ['board/script', 'examples/minimal-board/script']) {
  writeFileSync(join(root, dir, 'smashandclash-sdk.js'), header + dist);
  console.log(`wrote ${dir}/smashandclash-sdk.js (SDK ${pkg.version})`);
}
