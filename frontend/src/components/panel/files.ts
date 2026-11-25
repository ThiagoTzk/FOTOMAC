/**
 * Files chosen to send (photos, videos, a cover, a profile photo), the site's way: the browser's File. The app's
 * version (files.native.ts, 06/11/2026) gives the same functions for a file of the phone, so the checks of the upload
 * (format by signature, size, duplicates) are the same in both.
 */
export const fileStamp = (file: File) => file.lastModified;

/** The first bytes, to know the format by its signature (not by the name). */
export async function headBytes(file: File, count: number): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(0, count).arrayBuffer());
}

/** An address to show the file on the screen while it is in the list. */
export const previewOf = (file: File) => URL.createObjectURL(file);
export const releasePreview = (url: string) => { if (url.startsWith('blob:')) URL.revokeObjectURL(url); };

/** An address for bytes cut out of a file (the camera preview inside a RAW), or null where it cannot be made. */
export const previewFromBytes = (bytes: Uint8Array): string | null =>
  URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/jpeg' }));

export async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export type SendResult = { status: number; body: string };

/** Sends one file as a form field, reporting the progress (XMLHttpRequest: fetch does not report it). status 0: no
 *  answer (the connection failed); -1: stopped by the signal. */
export function sendFile(url: string, file: File, headers: Record<string, string>, onProgress: (percent: number) => void,
                         signal?: AbortSignal): Promise<SendResult> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.withCredentials = true;   // the HttpOnly session cookie
    Object.entries(headers).forEach(([k, v]) => xhr.setRequestHeader(k, v));
    xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) onProgress(Math.round((100 * ev.loaded) / ev.total)); };
    xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText });
    xhr.onerror = () => resolve({ status: 0, body: '' });
    xhr.onabort = () => resolve({ status: -1, body: '' });
    signal?.addEventListener('abort', () => xhr.abort());
    const form = new FormData();
    form.append('file', file, file.name);
    xhr.send(form);
  });
}

/** The app deletes the copies the phone's pickers leave in its cache (files.native.ts); the browser keeps none. */
export function clearPickedCopies(): void {}

/** A file chosen by the phone's pickers: only the app makes these (files.native.ts). */
export function pickedFile(_uri: string, _name: string | null | undefined, _type: string | null | undefined, _size?: number | null): File {
  throw new Error('Arquivos do celular só existem no app.');
}

/** The phone's Files picker: only the app has it (files.native.ts). */
export async function pickFromFiles(_mimeTypes: string[]): Promise<File[]> {
  return [];
}

/** One photo chosen by the person (a profile photo): the browser's file chooser. The app opens the gallery. */
export function pickPhoto(accept = 'image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif'): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

/** One JPEG image (the event cover). In the app the person chooses Galeria or Arquivos (files.native.ts). */
export type PickedImage = { name: string; size: number; uri: string; type: string; file?: File };

/** The browser: its own file chooser, which already offers every source of the computer or phone. */
export async function pickJpeg(_title: string): Promise<PickedImage | null> {
  const DocumentPicker = await import('expo-document-picker');
  const r = await DocumentPicker.getDocumentAsync({ type: 'image/jpeg', copyToCacheDirectory: false });
  if (r.canceled || !r.assets?.[0]) return null;
  const a = r.assets[0];
  return { name: a.name, size: a.size ?? 0, uri: a.uri, type: a.mimeType || 'image/jpeg', file: (a as { file?: File }).file };
}

/** The app deletes the copy the gallery left in its cache (files.native.ts); the browser has none. */
export function discardPicked(_uri: string): void {}
