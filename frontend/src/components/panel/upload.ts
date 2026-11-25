/**
 * Upload queue of the "Enviar imagens" screen.
 * One HTTP request per file: a failure affects only that file, which can be re-sent alone,
 * and an interrupted batch resumes without re-sending what is already done.
 */
import { API_URL, accountHeaders, api, followSession } from '@/api/client';
import type { UploadRules } from '@/api/images';
import { holdSession } from '@/auth/idle';

import { fileStamp, headBytes, previewFromBytes, previewOf, releasePreview, sendFile, sha256Hex } from './files';

export const MAX_FILES_PER_BATCH = 500;  // files per sending operation
const PARALLEL = 3;

/** Duplicates and invalid files are never sent, so they do not take a place among the 500 of a batch. */
export const takesPlace = (e: Entry) => e.status !== 'duplicate' && e.status !== 'invalid';

export type EntryStatus = 'checking' | 'valid' | 'invalid' | 'duplicate' | 'waiting' | 'sending' | 'done' | 'failed';

/** jpeg/png/webp: the browser draws a preview; heic and raw usually not (the server makes the JPEG copy). */
export type Kind = 'jpeg' | 'png' | 'webp' | 'heic' | 'raw';

export type Entry = {
  key: string;
  file: File;
  previewUrl: string;
  kind?: Kind;
  /** A RAW whose camera preview (the JPEG inside it) could be extracted: it gets a real thumbnail. */
  embeddedPreview?: boolean;
  status: EntryStatus;
  progress: number;
  message?: string;
  sha256?: string;
};

/** The cause in plain Portuguese. */
const REASONS: Record<string, string> = {
  format: 'Formato não permitido: envie fotografias em JPEG, PNG, HEIC ou WebP.',
  too_large: 'O arquivo ultrapassa o limite de 25 MB por imagem.',
  raw_too_large: 'O arquivo RAW ultrapassa o limite definido pela administração.',
  raw_disabled: 'Este evento não aceita arquivos RAW. Envie a fotografia exportada em JPEG, ou peça a quem gerencia o evento para ligar "Aceitar arquivos RAW".',
  format_unavailable: 'Este formato ainda não pode ser recebido. Envie a fotografia em JPEG.',
  corrupted: 'O arquivo está corrompido e não pôde ser lido.',
  event_limit: 'O evento atingiu o limite de 1.000 mídias.',
  duplicate: 'Esta imagem já está no acervo do evento e não será enviada novamente.',
  network: 'Falha de transmissão. Verifique a conexão e tente novamente.',
};

const HEIF_BRANDS = ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx'];
const TIFF_STARTS = ['II*\0', 'MM\0*', 'IIRO', 'IIRS', 'IIU\0'];

/** By the binary signature, not the extension — the same rules as the server, which checks again
 *  (backend/app/images/formats.py). The name only separates the RAW formats that share
 *  the TIFF signature (DNG, NEF...). */
async function detect(file: File, rawExtensions: string[]): Promise<Kind | null> {
  const b = await headBytes(file, 64);
  const text = (from: number, to: number) => String.fromCharCode(...b.slice(from, to));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (text(0, 8) === '\x89PNG\r\n\x1a\n') return 'png';
  if (text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP') return 'webp';
  if (text(4, 8) === 'ftyp') {
    const major = text(8, 12);
    if (major === 'crx ') return 'raw';
    const compatible = Array.from({ length: 12 }, (_, i) => text(16 + 4 * i, 20 + 4 * i));
    if (HEIF_BRANDS.includes(major) || (['mif1', 'msf1'].includes(major) && compatible.some((c) => HEIF_BRANDS.includes(c)))) return 'heic';
  }
  if (text(0, 16) === 'FUJIFILMCCD-RAW ') return 'raw';
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (TIFF_STARTS.includes(text(0, 4)) && rawExtensions.includes(ext)) return 'raw';
  return null;
}

/** The browser can draw these; HEIC (and a RAW without a camera preview) get a placeholder in the list. */
export const previewable = (kind?: Kind) => kind === 'jpeg' || kind === 'png' || kind === 'webp';

/** "JPEG", "PNG", "HEIC", "WebP", "RAW (NEF)"... shown beside the size of each file. */
export function kindLabel(entry: Entry): string {
  const ext = entry.file.name.split('.').pop()?.toUpperCase() ?? '';
  if (!entry.kind) return ext ? `${ext} (não aceito)` : 'formato não aceito';
  return entry.kind === 'raw' ? `RAW (${ext})` : { jpeg: 'JPEG', png: 'PNG', webp: 'WebP', heic: 'HEIC' }[entry.kind];
}

const PREVIEW_SCAN_BYTES = 48 * 1024 * 1024;   // camera previews sit well inside the first megabytes

/** End of the JPEG that starts at `start` (just after its FF D9), or -1. The segments are walked by
 *  their lengths: the preview usually carries a smaller thumbnail INSIDE its EXIF block, and stopping at
 *  the first FF D9 found would cut the preview at the end of that inner thumbnail. */
function jpegEnd(b: Uint8Array, start: number): number {
  let i = start + 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return -1;
    const m = b[i + 1];
    if (m === 0xff) { i += 1; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    if (m === 0xd9) return i + 2;
    const length = (b[i + 2] << 8) | b[i + 3];
    i += 2 + length;
    if (m !== 0xda) continue;
    // Entropy-coded data after SOS: FF 00 and FF D0-D7 belong to it; FF D9 ends the image; any other
    // marker (a progressive JPEG has several scans) goes back to walking segments.
    while (i + 1 < b.length) {
      if (b[i] === 0xff && b[i + 1] !== 0x00 && !(b[i + 1] >= 0xd0 && b[i + 1] <= 0xd7) && b[i + 1] !== 0xff) break;
      i += 1;
    }
  }
  return -1;
}

/** The largest JPEG inside a camera RAW file — the preview the camera itself shows. Read in the
 *  browser only, nothing is sent; null when there is none (the list keeps the "RAW" placeholder). */
async function rawPreview(file: File): Promise<string | null> {
  const b = await headBytes(file, PREVIEW_SCAN_BYTES);
  let best: [number, number] | null = null;
  for (let i = 0; i + 3 < b.length; i++) {
    if (b[i] !== 0xff || b[i + 1] !== 0xd8 || b[i + 2] !== 0xff) continue;
    const end = jpegEnd(b, i);
    if (end > 0 && end - i > 4096 && (!best || end - i > best[1] - best[0])) best = [i, end];
  }
  return best ? previewFromBytes(b.slice(best[0], best[1])) : null;
}

export function newEntries(files: File[]): Entry[] {
  return files.map((file) => ({
    key: `${file.name}-${file.size}-${fileStamp(file)}-${Math.random().toString(36).slice(2, 8)}`,
    file, previewUrl: previewOf(file), status: 'checking', progress: 0,
  }));
}

/** Checks format, size and duplicates (in the event and inside the selection) before sending.
 *  listed: the checksums already in the list (files added before), so a copy among them is a duplicate too. */
export async function validate(eventId: string, entries: Entry[], rules: UploadRules, listed: string[] = []): Promise<Entry[]> {
  const checked: Entry[] = [];
  for (const e of entries) {
    const kind = await detect(e.file, rules.raw_extensions);
    if (!kind) checked.push({ ...e, status: 'invalid', message: REASONS.format });
    else if (kind === 'raw' && !rules.raw_enabled) checked.push({ ...e, kind, status: 'invalid', message: REASONS.raw_disabled });
    else if (kind === 'raw' && e.file.size > (rules.max_raw_bytes ?? 0)) {
      checked.push({ ...e, kind, status: 'invalid',
                     message: `O arquivo RAW ultrapassa o limite de ${Math.round((rules.max_raw_bytes ?? 0) / 1024 ** 2)} MB.` });
    } else if (kind !== 'raw' && e.file.size > rules.max_photo_bytes) checked.push({ ...e, kind, status: 'invalid', message: REASONS.too_large });
    else checked.push({ ...e, kind, sha256: await sha256Hex(e.file), status: 'valid' });
  }
  // RAW files get the camera preview as their thumbnail (the browser cannot draw the RAW itself).
  for (const [n, e] of checked.entries()) {
    if (e.kind !== 'raw') continue;
    const url = await rawPreview(e.file).catch(() => null);
    if (url) { releasePreview(e.previewUrl); checked[n] = { ...e, previewUrl: url, embeddedPreview: true }; }
  }
  const sums = checked.filter((e) => e.sha256).map((e) => e.sha256!);
  const { existing } = sums.length
    ? await api<{ existing: string[] }>(`/events/${eventId}/images/check`, { body: { checksums: sums } })
    : { existing: [] as string[] };
  const seen = new Set<string>(listed);
  return checked.map((e) => {
    if (!e.sha256) return e;
    if (existing.includes(e.sha256) || seen.has(e.sha256)) return { ...e, status: 'duplicate', message: REASONS.duplicate };
    seen.add(e.sha256);
    return e;
  });
}

/** One file, with its progress (the browser's XMLHttpRequest, or the phone's upload in the app: files.ts). */
async function send(eventId: string, file: File, onProgress: (p: number) => void): Promise<{ ok: boolean; message?: string }> {
  const r = await sendFile(`${API_URL}/api/v1/events/${eventId}/images`, file, accountHeaders(), onProgress);
  if (r.status === 201) return { ok: true };
  // The server answers {reason} for a refused file, or a plain message (e.g. an internal error): show what it said.
  // "Falha de transmissão" only when nothing came back at all.
  let message = REASONS.network;
  try {
    const detail = JSON.parse(r.body).detail;
    if (r.status === 409 && detail?.reason === 'account_changed') followSession();
    message = typeof detail === 'string' ? detail : REASONS[detail?.reason] ?? detail?.message ?? message;
  } catch { /* keep generic */ }
  return { ok: false, message };
}

/** Sends the given entries, a few at a time; one failure never stops the others. */
export async function runQueue(eventId: string, keys: string[], update: (key: string, patch: Partial<Entry>) => void,
                               getFile: (key: string) => File | undefined, isCancelled: () => boolean): Promise<void> {
  const queue = [...keys];
  // A big upload takes a while and nobody needs to touch the mouse meanwhile: it counts as use (25/10/2026).
  const release = holdSession();
  async function lane() {
    while (queue.length && !isCancelled()) {
      const key = queue.shift()!;
      const file = getFile(key);
      if (!file) continue;
      update(key, { status: 'sending', progress: 0 });
      const r = await send(eventId, file, (p) => update(key, { progress: p }));
      update(key, r.ok ? { status: 'done', progress: 100 } : { status: 'failed', message: r.message });
    }
  }
  try { await Promise.all(Array.from({ length: PARALLEL }, lane)); } finally { release(); }
}
