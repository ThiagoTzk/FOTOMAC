/** The site applies the accessibility choices with CSS (theme/accessibility.ts): nothing to do when it starts. */
export type SavedA11y = { text: number; bold: boolean; contrast: boolean; spacing: boolean; underline: boolean };
export const APP_A11Y: SavedA11y | null = null;
export const A11Y_KEY = 'fotomac-a11y';
