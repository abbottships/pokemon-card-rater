// Download a handful of card scans from the Pokémon TCG API's image CDN into
// tests/fixtures/cards. They're for local testing only (gitignored).
// Add your own photos or scans to the same folder too: any .png/.jpg/.webp is picked up.
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = new URL('../tests/fixtures/cards/', import.meta.url).pathname;

// set id / card number on images.pokemontcg.io. A mix of eras, borders and holo styles.
const CARDS = [
  ['base1', '58', 'pikachu-base'],
  ['base1', '4', 'charizard-base-holo'],
  ['sv3pt5', '25', 'pikachu-151'],
  ['swsh12pt5', '160', 'pikachu-crown-zenith'],
  ['sm115', '1', 'shining-legends-energy'],
];

mkdirSync(OUT, { recursive: true });
for (const [set, num, name] of CARDS) {
  const path = join(OUT, `${name}.png`);
  if (existsSync(path)) { console.log(`have ${name}`); continue; }
  const url = `https://images.pokemontcg.io/${set}/${num}_hires.png`;
  const res = await fetch(url);
  if (!res.ok) { console.warn(`skip ${name}: ${res.status} ${url}`); continue; }
  writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  console.log(`got ${name}`);
}
