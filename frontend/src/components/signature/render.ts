import { SIGNATURE_FONTS, type SignatureFont } from './fonts';

export const CANVAS_WIDTH = 600;
export const CANVAS_HEIGHT = 200;

/**
 * Writes a typed name (or initials) in a handwriting font on a transparent canvas and returns it as a PNG
 * data URL — the same kind of image as a drawn signature, so whoever receives it treats both alike.
 * The font size shrinks until the text fits the box.
 */
export async function renderTypedSignature(text: string, family: SignatureFont, ink = '#14232F'): Promise<string | null> {
  const clean = text.trim();
  if (!clean || typeof document === 'undefined') return null;
  const scale = SIGNATURE_FONTS.find((f) => f.family === family)?.size ?? 1;
  let size = Math.round(96 * scale);
  // The font must be really loaded before drawing, or the canvas silently falls back to a system font.
  await document.fonts.load(`${size}px "${family}"`);
  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_WIDTH;
  canvas.height = CANVAS_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  for (; size > 18; size -= 4) {
    ctx.font = `${size}px "${family}"`;
    if (ctx.measureText(clean).width <= CANVAS_WIDTH - 48) break;
  }
  ctx.fillStyle = ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(clean, CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2 + size * 0.08);
  return canvas.toDataURL('image/png');
}

const CONNECTORS = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'di', 'du', 'del']);

/** "Maria Clara Souza Lima" → "MCSL": the starting point of a rubrica (the person can change it). */
export function initialsOf(name: string): string {
  return name.trim().split(/\s+/).filter((w) => w && !CONNECTORS.has(w.toLowerCase()))
    .map((w) => w[0].toUpperCase()).join('').slice(0, 6);
}
