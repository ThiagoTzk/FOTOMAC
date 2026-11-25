/** Downloads a file the site's way: the browser follows the signed address and saves it. See saveFile.native.ts. */
export async function saveFile(url: string, _title: string): Promise<void> {
  window.location.assign(url);
}

export function clearSavedFiles(): void {}
