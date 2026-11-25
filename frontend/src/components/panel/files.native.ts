import { CryptoDigestAlgorithm, digest } from 'expo-crypto';
import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, Paths, UploadType } from 'expo-file-system';
import { Alert } from 'react-native';

import { appHeaders } from '@/api/client';

/**
 * Files chosen to send, in the app (06/11/2026): a File of expo-file-system, read from the phone's disk. The same
 * functions as files.ts, so the upload checks are the same as the site's. The types say "File" (the browser's) for
 * the shared code; here the object is expo's File, which has the same name, size, type, slice and arrayBuffer.
 */
type PhoneFile = File & { modificationTime?: number | null };

/**
 * A file chosen in the gallery, the camera or Files: the phone's file, with the name the person knows (the gallery
 * gives the file a random name in the app's cache; the real one is needed to show it and to tell RAW formats apart).
 */
export type Picked = { name: string; size: number; type: string; uri: string; lastModified: number; file: PhoneFile };

export function pickedFile(uri: string, name: string | null | undefined, type: string | null | undefined, size?: number | null): globalThis.File {
  const file = new File(uri) as PhoneFile;
  const picked: Picked = { name: name || file.name, size: size ?? file.size ?? 0, type: type || file.type || '', uri,
                           lastModified: file.modificationTime ?? Date.now(), file };
  return picked as unknown as globalThis.File;
}

/** Files chosen in the phone's Files: read where they are, with the right to read given by the picker (no copy in the
 *  app), and with their real names (needed to show them and to tell RAW formats apart). */
export async function pickFromFiles(mimeTypes: string[]): Promise<globalThis.File[]> {
  const r = await DocumentPicker.getDocumentAsync({ multiple: true, type: mimeTypes, copyToCacheDirectory: false });
  if (r.canceled) return [];
  return r.assets.map((a) => pickedFile(a.uri, a.name, a.mimeType, a.size));
}

const phone = (file: unknown): PhoneFile => (file as Picked).file ?? (file as PhoneFile);

export const fileStamp = (file: globalThis.File) => (file as unknown as Picked).lastModified ?? phone(file).modificationTime ?? 0;

export async function headBytes(file: globalThis.File, count: number): Promise<Uint8Array> {
  const handle = phone(file).open();
  // SDK 58: readBytes became asynchronous; the handle is closed only after the bytes arrive ("file handle is closed").
  try { return await handle.readBytes(Math.min(count, phone(file).size ?? count)); } finally { handle.close(); }
}

export const previewOf = (file: globalThis.File) => phone(file).uri;

/**
 * The camera preview cut out of a RAW (08/11/2026: the app showed only the "RAW" mark, the site the photo).
 * The site shows those bytes straight from memory (a blob: address); the app has no such address, so the preview is
 * written to a file of its own in the app's cache and shown from there. It is a picture of the people in the photo:
 * deleted when the row leaves the list or the screen closes (releasePreview), and whatever is left (the app was
 * closed in the middle) is deleted the next time the app starts (clearPickedCopies).
 */
const PREVIEW_FOLDER = 'raw-previews';

export function previewFromBytes(bytes: Uint8Array): string | null {
  try {
    const dir = new Directory(Paths.cache, PREVIEW_FOLDER);
    if (!dir.exists) dir.create({ intermediates: true });
    const file = new File(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 10)}.jpg`);
    file.writeSync(bytes);
    return file.uri;
  } catch {
    return null;   // the list keeps the "RAW" mark
  }
}

/** Deletes a preview made by previewFromBytes. The other addresses are the person's own files: never touched. */
export function releasePreview(url: string) {
  if (!url.startsWith(new Directory(Paths.cache, PREVIEW_FOLDER).uri)) return;
  try { new File(url).delete(); } catch { /* already gone */ }
}

export async function sha256Hex(file: globalThis.File): Promise<string> {
  const sum = await digest(CryptoDigestAlgorithm.SHA256, new Uint8Array(await phone(file).arrayBuffer()));
  return Array.from(new Uint8Array(sum)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export type SendResult = { status: number; body: string };

/** Sends the file from the phone's disk, with the session headers and the progress (expo-file-system's upload). */
export async function sendFile(url: string, file: globalThis.File, headers: Record<string, string>, onProgress: (percent: number) => void,
                               signal?: AbortSignal): Promise<SendResult> {
  try {
    const task = phone(file).createUploadTask(url, {
      uploadType: UploadType.MULTIPART, fieldName: 'file', mimeType: phone(file).type || undefined,
      headers: { ...appHeaders(), ...headers }, signal,
      // On the iPhone (08/11/2026) the counts arrive as BigInt, and mixing BigInt with a number in arithmetic throws
      // "Cannot convert BigInt to number" (the author's upload of photos and videos). Number() accepts both.
      onProgress: ({ bytesSent, totalBytes }: { bytesSent: number | bigint; totalBytes: number | bigint }) => {
        const sent = Number(bytesSent), total = Number(totalBytes);
        if (total > 0) onProgress(Math.min(100, Math.round((100 * sent) / total)));
      },
    } as Parameters<PhoneFile['createUploadTask']>[1]);
    const r = await task.uploadAsync();
    // Sent: the app's copy (the gallery and Files copy what they give into the app's cache) is deleted at once.
    if (r?.status === 201) discardCopy(file);
    return { status: r?.status ?? 0, body: r?.body ?? '' };
  } catch (e) {
    return { status: e instanceof Error && e.name === 'AbortError' ? -1 : 0, body: '' };
  }
}

/** The copies the gallery, the camera and Files leave in the app's cache. Photos and videos of an event are not kept on
 *  the phone after they are sent (deleted one by one above) nor across runs of the app (all deleted when it starts). */
const PICKER_FOLDERS = ['ImagePicker', 'DocumentPicker', 'Camera', PREVIEW_FOLDER];

function discardCopy(file: globalThis.File) {
  const f = phone(file);
  if (!f.uri.startsWith(Paths.cache.uri)) return;   // a file of the person's own storage is never touched
  try { f.delete(); } catch { /* already gone */ }
}

export function clearPickedCopies(): void {
  for (const name of PICKER_FOLDERS) {
    try { const dir = new Directory(Paths.cache, name); if (dir.exists) dir.delete(); } catch { /* nothing there */ }
  }
}

/** One photo chosen by the person (a profile photo), from the phone's gallery (only the chosen photo is shared). */
export async function pickPhoto(_accept?: string): Promise<globalThis.File | null> {
  const ImagePicker = await import('expo-image-picker');
  const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1, exif: false, allowsMultipleSelection: false });
  if (r.canceled || !r.assets[0]) return null;
  const a = r.assets[0];
  return pickedFile(a.uri, a.fileName, a.mimeType, a.fileSize);
}

/** One JPEG image (the event cover). */
export type PickedImage = { name: string; size: number; uri: string; type: string; file?: globalThis.File };

/** Where the image comes from. The cover opened only the Files app; on a phone the photos live in the gallery
 *  (08/11/2026). Closing the question chooses nothing. */
function askSource(title: string): Promise<'gallery' | 'files' | null> {
  return new Promise((resolve) => {
    Alert.alert(title, 'De onde vem a imagem?', [
      { text: 'Galeria', onPress: () => resolve('gallery') },
      { text: 'Arquivos', onPress: () => resolve('files') },
      { text: 'Cancelar', style: 'cancel', onPress: () => resolve(null) },
    ], { cancelable: true, onDismiss: () => resolve(null) });
  });
}

/**
 * A JPEG chosen in the gallery or in Files. The server takes only JPEG covers (checked by the bytes). The gallery of an
 * iPhone keeps photos as HEIC: "Compatible" asks the phone for a JPEG copy, and a quality just under 1 makes the
 * picker write a JPEG instead of passing the original through. A PNG (a screenshot) stays PNG: the caller says so.
 */
export async function pickJpeg(title: string): Promise<PickedImage | null> {
  const source = await askSource(title);
  if (source === 'gallery') {
    const ImagePicker = await import('expo-image-picker');
    const r = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'], quality: 0.95, exif: false, allowsEditing: false, allowsMultipleSelection: false,
      preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
    });
    if (r.canceled || !r.assets[0]) return null;
    const a = r.assets[0];
    const type = a.mimeType || 'image/jpeg';
    // The gallery may keep the original name (IMG_0001.HEIC) for what is now a JPEG copy.
    const name = type === 'image/jpeg' ? (a.fileName || 'capa').replace(/\.[^.]+$/, '') + '.jpg' : a.fileName || 'imagem';
    return { name, size: a.fileSize ?? new File(a.uri).size ?? 0, uri: a.uri, type };
  }
  if (source === 'files') {
    const r = await DocumentPicker.getDocumentAsync({ type: 'image/jpeg', copyToCacheDirectory: false });
    if (r.canceled || !r.assets?.[0]) return null;
    const a = r.assets[0];
    return { name: a.name, size: a.size ?? 0, uri: a.uri, type: a.mimeType || 'image/jpeg' };
  }
  return null;
}

/** The gallery's copy of a chosen image, deleted when the form no longer needs it (a file of the person's own storage,
 *  chosen in Files, is never touched). */
export function discardPicked(uri: string): void {
  if (!uri.startsWith(Paths.cache.uri)) return;
  try { new File(uri).delete(); } catch { /* already gone */ }
}

