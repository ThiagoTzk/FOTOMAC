import { StyleSheet } from 'react-native';

import { HEAVIER } from './a11yData';
import { readPref } from './appPrefs';

export type SavedA11y = { text: number; bold: boolean; contrast: boolean; spacing: boolean; underline: boolean };
const STEPS = [1, 1.25, 1.5, 1.75, 2];
export const A11Y_KEY = 'fotomac-a11y';

function saved(): SavedA11y {
  try {
    const raw = JSON.parse(readPref(A11Y_KEY) ?? '{}') as Partial<SavedA11y>;
    return { text: STEPS.includes(Number(raw.text)) ? Number(raw.text) : 1, bold: raw.bold === true, contrast: raw.contrast === true,
             spacing: raw.spacing === true, underline: raw.underline === true };
  } catch {
    return { text: 1, bold: false, contrast: false, spacing: false, underline: false };
  }
}

/** The accessibility choices of this phone, read once when the app starts (changing one restarts the app). */
export const APP_A11Y: SavedA11y = saved();

type TextStyle = { fontSize?: unknown; lineHeight?: unknown; fontFamily?: unknown; letterSpacing?: unknown; textDecorationLine?: unknown;
                   height?: unknown; minHeight?: unknown; width?: unknown };

/**
 * The app (06/11/2026): the site applies the choices with CSS; the app has no CSS, so they are applied to every style
 * as it is made (StyleSheet.create), before any screen is drawn: larger text and its line height, the heavier font
 * file, the WCAG 1.4.12 spacing, and underlined links (the styles named "link"). This module is the first one the app
 * loads (index.js). The phone's own text size and bold settings still apply on top, as in any app.
 */
function adapt(name: string, style: TextStyle): TextStyle {
  const a = APP_A11Y;
  const out = { ...style };
  if (typeof out.fontSize === 'number') {
    const size = out.fontSize * a.text;
    out.fontSize = size;
    if (typeof out.lineHeight === 'number') out.lineHeight = out.lineHeight * a.text;
    if (a.spacing) {
      out.lineHeight = Math.max(typeof out.lineHeight === 'number' ? out.lineHeight : 0, size * 1.5);
      out.letterSpacing = size * 0.12;
    }
  }
  // A control drawn for normal text (a field, a button, a chip: a fixed height and no fixed width) grows with the
  // text instead of cutting it (06/11/2026: "Buscar evento" was cut at 125%). Round icons keep their size.
  if (a.text !== 1 && typeof out.height === 'number' && out.height >= 28 && out.height <= 64 && out.width === undefined) {
    out.minHeight = Math.round(out.height * a.text);
    delete out.height;
  }
  if (a.bold && typeof out.fontFamily === 'string' && HEAVIER[out.fontFamily]) out.fontFamily = HEAVIER[out.fontFamily];
  // 09/11/2026 (no link was underlined in the app): the site underlines every text inside a link; here only the
  // styles named "...link..." are, so every text that works as a link has "Link" in its style's name (seeAllLink,
  // backLink, crumbLink, footLink...). A new text link must follow that, or it is never underlined in the app.
  if (a.underline && /link/i.test(name)) out.textDecorationLine = 'underline';
  return out;
}

const changed = APP_A11Y.text !== 1 || APP_A11Y.bold || APP_A11Y.spacing || APP_A11Y.underline;
if (changed) {
  const create = StyleSheet.create;
  // Typed read-only since React Native 0.88, but a plain property of a plain object (only absoluteFill is frozen).
  (StyleSheet as { create: unknown }).create = ((styles: Record<string, TextStyle>) => {
    const out: Record<string, TextStyle> = {};
    for (const [name, style] of Object.entries(styles)) out[name] = style && typeof style === 'object' ? adapt(name, style) : style;
    return create(out as never);
  }) as typeof StyleSheet.create;
}
