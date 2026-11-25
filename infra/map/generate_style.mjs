// Writes frontend/public/map/style.json, the drawing rules of the map. Run from a folder with @protomaps/basemaps 5.7.2
// installed: node generate_style.mjs <path of style.json>. Sources and paths are filled in by EventMap.web.tsx.
import { layers, namedFlavor } from '@protomaps/basemaps';
import { writeFileSync } from 'fs';

// The default style names universities but not "college", which is how OpenStreetMap marks the CESMAC campuses, nor the
// places that usually hold an event.
const VENUES = ['college', 'hospital', 'clinic', 'sports_centre', 'events_venue', 'conference_centre', 'community_centre',
                'arts_centre', 'place_of_worship', 'parking'];

const all = layers('protomaps', namedFlavor('light'), { lang: 'pt' });
const pois = all.find((l) => l.id === 'pois');
pois.filter[1][2][1].push(...VENUES);
pois.layout['icon-image'] = ['match', ['get', 'kind'], 'station', 'train_station', 'college', 'university', ['get', 'kind']];
const textColor = pois.paint['text-color'];
const institutions = textColor.findIndex((v) => Array.isArray(v) && JSON.stringify(v).includes('"university"'));
textColor[institutions][2][1].push(...VENUES);

const style = {
  version: 8, sprite: '', glyphs: '',
  sources: { protomaps: { type: 'vector', url: '', attribution: '<a href="https://protomaps.com">Protomaps</a> © <a href="https://openstreetmap.org">OpenStreetMap</a>' } },
  layers: all,
};
writeFileSync(process.argv[2], JSON.stringify(style));
