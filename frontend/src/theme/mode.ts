/**
 * Light or dark mode (28/10/2026), chosen with the sun/moon button beside the bell. Saved in this browser (in the app,
 * in the phone, 06/11/2026)
 * (localStorage: a preference of the screen, not personal data) and applied to the whole site — panel and public
 * pages — by one attribute on <html>; the colours themselves are the CSS variables of theme/tokens.ts.
 */
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';

import { readPref, writePref } from '@/theme/appPrefs';
import { restartApp } from '@/theme/restartApp';
import { themeStylesheet } from '@/theme/tokens';

export type Mode = 'light' | 'dark';
const KEY = 'fotomac-theme';
const listeners = new Set<(m: Mode) => void>();

function saved(): Mode {
  try { return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light'; } catch { return 'light'; }
}

function apply(mode: Mode): void {
  document.documentElement.setAttribute('data-theme', mode);
  listeners.forEach((l) => l(mode));
}

/** Runs once, before the first screen is drawn: the palettes, and the mode saved in this browser (no flash). */
export function installTheme(): void {
  if (Platform.OS !== 'web' || document.getElementById('fotomac-theme')) return;
  const style = document.createElement('style');
  style.id = 'fotomac-theme';
  style.textContent = themeStylesheet();
  document.head.appendChild(style);
  apply(saved());
  // Another tab changed the mode: this one follows.
  window.addEventListener('storage', (e) => { if (e.key === KEY) apply(saved()); });
}

export function setMode(mode: Mode): void {
  if (Platform.OS !== 'web') {
    // The app: the colours are fixed when the styles are made, so the app restarts in the new mode (a blink).
    writePref(KEY, mode);
    restartApp('Modo claro/escuro');
    return;
  }
  try { localStorage.setItem(KEY, mode); } catch { /* private window: this page only */ }
  apply(mode);
}

export function useMode(): Mode {
  const [mode, setState] = useState<Mode>(() => (Platform.OS === 'web' ? saved() : readPref(KEY) === 'dark' ? 'dark' : 'light'));
  useEffect(() => {
    listeners.add(setState);
    return () => { listeners.delete(setState); };
  }, []);
  return mode;
}
