import { useCallback, useEffect, useRef } from 'react';

type Props = { src: string; poster?: string; label: string; seek?: { at: number; n: number }; fill?: boolean };

/** The browser's own player. It asks the API for parts of the file as the person watches, never the whole file.
 *  `seek` jumps to a moment (a face of "Pessoas neste vídeo"); `n` makes a second click on the same face jump again. */
export function VideoPlayer({ src, poster, label, seek }: Props) {
  const element = useRef<HTMLVideoElement | null>(null);
  const attach = useCallback((node: HTMLVideoElement | null) => { element.current = node; }, []);
  useEffect(() => {
    const video = element.current;
    if (!video || !seek) return;
    video.currentTime = Math.max(0, seek.at - 0.5);
    void video.play().catch(() => undefined);
  }, [seek]);
  return (
    <video ref={attach} src={src} poster={poster} controls preload="metadata" aria-label={label}
           style={{ width: '100%', maxHeight: '60vh', borderRadius: 10, backgroundColor: '#000000', display: 'block' }} />
  );
}
