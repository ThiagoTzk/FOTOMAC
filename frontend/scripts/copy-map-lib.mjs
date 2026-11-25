// Copies the map library to public/map/lib, served by our own server to the app's map page (public/map/app.html).
// Runs after every "npm install", so the copy always matches the installed version; the copy is not in git.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public/map/lib');
mkdirSync(out, { recursive: true });
for (const [from, to] of [['maplibre-gl/dist/maplibre-gl.js', 'maplibre-gl.js'], ['maplibre-gl/dist/maplibre-gl.css', 'maplibre-gl.css'],
  ['pmtiles/dist/pmtiles.js', 'pmtiles.js']]) {
  copyFileSync(join(root, 'node_modules', from), join(out, to));
}
console.log('map library copied to public/map/lib');
