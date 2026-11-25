/**
 * Accessibility menu (01/11/2026: "aumentar a letra, diminuir, letras em negrito e etc"). Each choice is an
 * attribute on <html> read by one stylesheet, the same idea as the light/dark mode (theme/mode.ts): no screen
 * re-renders and no screen needs to know about it.
 *
 * - Text size: the text of React Native for Web is a <div class="css-text-…"> with a font size in pixels. CSS
 *   `zoom` on those elements enlarges the text and its line height together, and the layout around makes room for it.
 *   Nested texts (`css-textHasAncestor-…`) are left alone: they already grow with their parent.
 * - Bold: the fonts are separate files per weight (Inter_400Regular, Inter_700Bold…), so the browser cannot simply
 *   "bolden" them. In bold mode each family name points to the file of a heavier weight.
 * - High contrast: darker greys and borders, overriding the colour variables of theme/tokens.ts (light and dark).
 * - Spacing: the WCAG 1.4.12 values (line height 1.5, letter spacing 0.12em, word spacing 0.16em).
 * - Underlined links.
 *
 * In the app (06/11/2026) the same choices are applied when the app starts (theme/appA11y.native.ts).
 *
 * Saved ONLY in this browser (localStorage; in the app, in the phone) and never sent to the server: a preference such as "larger text" may
 * hint at a health condition, which is sensitive data when tied to a person (LGPD Art. 5º, II). Kept on the device,
 * it is never tied to an account.
 */
import { useEffect, useState } from 'react';
import { Platform, useWindowDimensions } from 'react-native';

import { HEAVIER, HIGH_DARK, HIGH_LIGHT } from './a11yData';
import { A11Y_KEY, APP_A11Y } from './appA11y';
import { writePref } from './appPrefs';
import { restartApp } from './restartApp';

/** Spread on the bordered box around a text input: the focus ring is drawn on the box, not on the inset <input>. */
export const FIELD_BOX = { dataSet: { field: 'true' } } as object;

export type A11y = { text: number; bold: boolean; contrast: boolean; spacing: boolean; underline: boolean };
export const TEXT_STEPS = [1, 1.25, 1.5, 1.75, 2];   // up to 200%, the WCAG 1.4.4 reference
export const A11Y_DEFAULT: A11y = { text: 1, bold: false, contrast: false, spacing: false, underline: false };

// 02/11/2026: at 100% the site felt zoomed in. On a computer the frame shrinks more than the letters, the
// proportions of sites like YouTube (compact bars and buttons, text still easy to read). Phones keep their size.
const DESKTOP = '(min-width: 1024px)';
const FRAME_SCALE = 0.875;
const TEXT_SCALE = 0.93;

const KEY = 'fotomac-a11y';
const listeners = new Set<(a: A11y) => void>();
const TEXT = '[class*="css-text-"], [class*="css-textinput-"]';
const within = (attr: string, selector: string) => selector.split(', ').map((s) => `:root[${attr}] ${s}`).join(', ');

const vars = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${k}:${v}`).join(';');

const STYLESHEET = [
  // Always on, not a choice: where the keyboard is must be easy to see (WCAG 2.4.7). The blue ring has a gap in the
  // page colour, so it shows on white and on the dark blue bands; text fields too (React Native for Web hides theirs).
  `:focus-visible { outline: 3px solid var(--fm-p-primary, #0070B0) !important; outline-offset: 2px !important;
     box-shadow: 0 0 0 2px var(--fm-p-surface, #FFFFFF) !important; }`,
  // 06/11/2026: a text field is a rounded box with the real <input> inset in it, so the ring on the <input> was a
  // blue square inside the field. The ring goes to the box (FIELD_BOX), following its rounded corners.
  `[data-field] :is(input, textarea):focus-visible { outline: none !important; box-shadow: none !important; }`,
  `[data-field]:has(:is(input, textarea):focus-visible) { outline: 3px solid var(--fm-p-primary, #0070B0) !important;
     outline-offset: 2px !important; }`,
  // The main content gets the focus from "Pular para o conteúdo" by script: no ring around the whole page.
  `[role="main"]:focus { outline: none !important; box-shadow: none !important; }`,
  `@media ${DESKTOP} { :root { zoom: ${FRAME_SCALE}; } }`,
  `${TEXT} { zoom: var(--fm-text-scale, 1); }`,
  `${within('data-a11y-spacing', TEXT)}, ${within('data-a11y-spacing', '[class*="css-textHasAncestor-"]')}
     { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; }`,
  `${within('data-a11y-underline', '[role="link"], a, [role="link"] [class*="css-text"]')}
     { text-decoration-line: underline !important; }`,
  // The light values only outside the dark mode: otherwise they would cover the dark palette where HIGH_DARK is silent.
  `:root[data-a11y-contrast]:not([data-theme="dark"]) { ${vars(HIGH_LIGHT)} }`,
  `:root[data-a11y-contrast][data-theme="dark"] { ${vars(HIGH_DARK)} }`,
].join('\n');

function saved(): A11y {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<A11y>;
    const text = TEXT_STEPS.includes(Number(raw.text)) ? Number(raw.text) : 1;
    return { text, bold: raw.bold === true, contrast: raw.contrast === true, spacing: raw.spacing === true, underline: raw.underline === true };
  } catch {
    return A11Y_DEFAULT;
  }
}

/** The @font-face rules of bold mode: each family name with the file of a heavier weight. The files are the ones
 *  expo-font already declared (its <style id="expo-generated-fonts">), so nothing new is downloaded from outside. */
function boldFaces(): string | null {
  const sheet = (document.getElementById('expo-generated-fonts') as HTMLStyleElement | null)?.sheet;
  if (!sheet) return null;
  const src: Record<string, string> = {};
  for (const rule of Array.from(sheet.cssRules)) {
    if (rule instanceof CSSFontFaceRule) src[rule.style.getPropertyValue('font-family').replace(/["']/g, '')] = rule.style.getPropertyValue('src');
  }
  const faces = Object.entries(HEAVIER).filter(([, to]) => src[to]).map(([from, to]) => `@font-face{font-family:${from};src:${src[to]};}`);
  return faces.length ? faces.join('\n') : null;
}

let boldTimer: ReturnType<typeof setTimeout> | undefined;
function applyBold(on: boolean, tries = 0): void {
  clearTimeout(boldTimer);
  document.getElementById('fotomac-a11y-bold')?.remove();
  if (!on) return;
  const faces = boldFaces();
  if (!faces) {   // the fonts are still loading (the saved choice is applied at start-up): try again shortly
    if (tries < 60) boldTimer = setTimeout(() => applyBold(true, tries + 1), 250);
    return;
  }
  const style = document.createElement('style');
  style.id = 'fotomac-a11y-bold';
  style.textContent = faces;
  document.head.appendChild(style);   // after expo's: for the same family name, the last @font-face wins
}

function apply(a: A11y): void {
  const root = document.documentElement;
  const flag = (name: string, on: boolean) => (on ? root.setAttribute(name, '') : root.removeAttribute(name));
  flag('data-a11y-text', a.text !== 1);
  // The text sits inside the zoomed page: this zoom is relative to the frame.
  const desktop = window.matchMedia(DESKTOP).matches;
  root.style.setProperty('--fm-text-scale', String(desktop ? (a.text * TEXT_SCALE) / FRAME_SCALE : a.text));
  flag('data-a11y-contrast', a.contrast);
  flag('data-a11y-spacing', a.spacing);
  flag('data-a11y-underline', a.underline);
  applyBold(a.bold);
  listeners.forEach((l) => l(a));
}

/** Runs once, before the first screen is drawn (like installTheme): the stylesheet and the choices saved here. */
export function installAccessibility(): void {
  if (Platform.OS !== 'web' || document.getElementById('fotomac-a11y')) return;
  const style = document.createElement('style');
  style.id = 'fotomac-a11y';
  style.textContent = STYLESHEET;
  document.head.appendChild(style);
  apply(saved());
  window.addEventListener('storage', (e) => { if (e.key === KEY) apply(saved()); });   // another tab changed it
  window.matchMedia(DESKTOP).addEventListener('change', () => apply(saved()));
}

/** How many screen pixels a CSS pixel takes in this page: what turns a mouse position or an element's position
 *  on screen into a value for `style`. Measured, because browsers differ in how they report a zoomed page. */
export function siteScale(): number {
  if (Platform.OS !== 'web') return 1;
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;left:0;top:0;width:100px;height:0;visibility:hidden';
  document.body.appendChild(probe);
  const scale = probe.getBoundingClientRect().width / 100;
  probe.remove();
  return scale || 1;
}

export function setAccessibility(a: A11y): void {
  if (Platform.OS !== 'web') {
    // The app (06/11/2026): applied when the styles are made (appA11y.native.ts), so it restarts with the new choice.
    writePref(A11Y_KEY, JSON.stringify(a));
    restartApp('Acessibilidade');
    return;
  }
  try { localStorage.setItem(KEY, JSON.stringify(a)); } catch { /* private window: this page only */ }
  apply(a);
}

export function useAccessibility(): A11y {
  const [a, setA] = useState<A11y>(() => (Platform.OS === 'web' ? saved() : APP_A11Y ?? A11Y_DEFAULT));
  useEffect(() => {
    listeners.add(setA);
    return () => { listeners.delete(setA); };
  }, []);
  return a;
}

/**
 * The window width the layout plans for. With the text at 150% a 1440 px window holds what a 960 px one holds at
 * 100%, so the breakpoints (menu, columns, tables into cards) switch as they do with the browser's zoom; otherwise
 * the larger text would overlap the bars drawn for normal text.
 */
export function useLayoutWidth(): number {
  const { width } = useWindowDimensions();
  return width / useAccessibility().text;
}

/** "Toque" in the app and on a phone's screen, "clique" with a mouse (06/11/2026): the instructions say what the person
 *  does with the hand they use. Returns the word in lower case; capitalise at the start of a sentence. */
export function useTapWord(): 'toque' | 'clique' {
  const phone = useLayoutWidth() < PHONE_MAX;
  return Platform.OS !== 'web' || phone ? 'toque' : 'clique';
}

/** A phone (06/11/2026): one column, nothing laid side by side that does not fit in 390 px. */
export const PHONE_MAX = 640;
export function usePhone(): boolean {
  return useLayoutWidth() < PHONE_MAX;
}

/** For cards laid side by side (flexBasis in pixels): the larger the text, the wider each card, so they go to
 *  fewer columns instead of squeezing the larger words. */
export function useTextScale(): number {
  return useAccessibility().text;
}

export const isDefault = (a: A11y) => (Object.keys(A11Y_DEFAULT) as (keyof A11y)[]).every((k) => a[k] === A11Y_DEFAULT[k]);
