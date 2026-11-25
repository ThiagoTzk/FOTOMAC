const EXTENSIONS = ['mp4', 'm4v', 'mov', '3gp', 'mkv', 'webm', 'avi', 'wmv', 'mts', 'm2ts', 'mpg', 'mpeg', 'mxf'];
export const VIDEO_ACCEPT = `video/*,${EXTENSIONS.map((e) => `.${e}`).join(',')}`;

/** Only chooses the way a file goes: the server decides by its signature. The name is needed because some
 *  browsers give camera files (.mts) no video type. */
export const isVideoFile = (file: File) => file.type.startsWith('video/') || EXTENSIONS.includes(file.name.split('.').pop()?.toLowerCase() ?? '');

export function sizeLabel(bytes: number) {
  const mb = Math.round(bytes / (1024 * 1024));
  return mb >= 1024 ? `${(mb / 1024).toLocaleString('pt-BR')} GB` : `${mb} MB`;
}
