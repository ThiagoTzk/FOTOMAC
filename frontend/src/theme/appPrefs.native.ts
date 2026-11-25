import * as SecureStore from 'expo-secure-store';

/**
 * Preferences of the app's screen (06/11/2026): light or dark mode, and the accessibility choices. They are read
 * synchronously when the app starts, BEFORE the styles are made, because in the app the colours and the sizes are
 * fixed when each screen's styles are created. Changing one saves it and restarts the app (see mode.ts).
 * A preference of the screen, not personal data.
 */
export function readPref(key: string): string | null {
  try { return SecureStore.getItem(key); } catch { return null; }
}

export function writePref(key: string, value: string): void {
  try { SecureStore.setItem(key, value); } catch { /* not remembered, that is all */ }
}
