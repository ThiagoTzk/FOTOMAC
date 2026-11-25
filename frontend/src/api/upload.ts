/** A file to send: a Blob in the browser, a file of the phone ({ uri }) in the app. */
export type Upload = Blob | { uri: string; type?: string };

/** Puts a file in a form (the browser: a Blob). The app's version is upload.native.ts. */
export function appendFile(form: FormData, field: string, file: Upload, name: string) {
  if ('uri' in file) throw new Error('A file of the phone is sent only by the app.');
  form.append(field, file, name);
}
