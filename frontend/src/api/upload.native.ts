import { File } from 'expo-file-system';

/** A file to send: a Blob in the browser, a file of the phone ({ uri }) in the app. */
export type Upload = Blob | { uri: string; type?: string };

/**
 * Puts a file in a form, in the app (06/11/2026). The app's fetch (Expo's) sends a file of the phone only as a File of
 * expo-file-system, read from the disk while it is sent: never the old { uri, name, type } object of React Native.
 */
export function appendFile(form: FormData, field: string, file: Upload, name: string) {
  form.append(field, ('uri' in file ? new File(file.uri) : file) as Blob, name);
}
