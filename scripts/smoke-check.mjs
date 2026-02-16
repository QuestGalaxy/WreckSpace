import { readFileSync, existsSync } from 'node:fs';

function fail(msg) {
  console.error(`[smoke] ${msg}`);
  process.exit(1);
}

if (!existsSync('dist/index.html')) fail('dist/index.html missing; run build first.');
const html = readFileSync('dist/index.html', 'utf8');
if (!html.includes('game-canvas')) fail('game canvas hook not found in dist/index.html.');
if (!html.includes('assets/index-')) fail('built JS asset reference missing in dist/index.html.');

console.log('[smoke] dist artifact checks passed.');
