import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import { appHeaders } from '@/api/client';

/**
 * Downloads a file in the app (06/11/2026): to a folder of the app's own cache, then the phone's "Salvar/Compartilhar"
 * opens and the person chooses where it goes (the gallery, Files). The app keeps no copy: the folder is emptied when
 * the visit ends and every time the app starts (LGPD Art. 6, III and Art. 15: nothing kept beyond its purpose).
 */
const folder = () => new Directory(Paths.cache, 'fotomac-downloads');

export async function saveFile(url: string, title: string): Promise<void> {
  const dir = folder();
  if (!dir.exists) dir.create({ intermediates: true });
  // The signed address is tied to this visit (or login) on the server: the session goes along, as in any request.
  const file = await File.downloadFileAsync(url, dir, { headers: appHeaders(), idempotent: true });
  if (!(await Sharing.isAvailableAsync())) throw new Error('Este celular não permite salvar o arquivo pelo app.');
  await Sharing.shareAsync(file.uri, { mimeType: file.type || undefined, dialogTitle: title });
}

export function clearSavedFiles(): void {
  try { const dir = folder(); if (dir.exists) dir.delete(); } catch { /* nothing to clear */ }
}
