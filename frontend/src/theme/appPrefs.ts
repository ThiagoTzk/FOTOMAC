/** The site keeps its screen preferences in localStorage (theme/mode.ts, theme/accessibility.ts): nothing here. */
export function readPref(_key: string): string | null {
  return null;
}

export function writePref(_key: string, _value: string): void {}
