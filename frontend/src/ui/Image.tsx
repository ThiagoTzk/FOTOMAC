import { Image as ExpoImage, type ImageProps } from 'expo-image';

import { API_URL, appHeaders, IS_APP } from '@/api/client';

type Source = ImageProps['source'];

/** In the app, an image of our API carries the session headers, like any other request (the site sends cookies). */
function withSession(src: Source): { source: Source; session: boolean } {
  if (!IS_APP || !src) return { source: src, session: false };
  const uri = typeof src === 'string' ? src : !Array.isArray(src) && typeof src === 'object' && 'uri' in src ? src.uri : undefined;
  if (typeof uri !== 'string' || !uri.startsWith(API_URL)) return { source: src, session: false };
  const base = typeof src === 'string' ? { uri: src } : (src as object);
  return { source: { ...base, headers: { ...appHeaders(), ...((src as { headers?: Record<string, string> }).headers ?? {}) } }, session: true };
}

/**
 * The project's image (06/11/2026): expo-image, plus the session in the app. Photos of our server (the visitor's
 * result, the panel's collection) are kept only in memory in the app, never in the phone's disk cache: nothing of
 * them is left on the phone after the person leaves (LGPD Art. 6, III: only what is needed). The site is unchanged.
 */
export function Image(props: ImageProps) {
  const main = withSession(props.source);
  const placeholder = withSession(props.placeholder);
  const keep = main.session && !/\/public\/events\/[^/]+\/cover/.test(String((main.source as { uri?: string })?.uri ?? ''));
  return <ExpoImage {...props} source={main.source} placeholder={placeholder.source}
                    cachePolicy={props.cachePolicy ?? (keep ? 'memory' : undefined)} />;
}
