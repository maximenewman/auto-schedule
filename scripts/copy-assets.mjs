import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const here = resolve(process.cwd());
const pairs = [
  ['src/state/migrations', 'dist/state/migrations'],
  ['src/server/public', 'dist/server/public'],
];

for (const [from, to] of pairs) {
  const src = resolve(here, from);
  if (!existsSync(src)) continue;
  mkdirSync(resolve(here, to), { recursive: true });
  cpSync(src, resolve(here, to), { recursive: true });
  console.log(`copied ${from} -> ${to}`);
}
