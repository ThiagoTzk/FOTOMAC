import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useMemo } from 'react';
import { StyleSheet } from 'react-native';

import { appHeaders } from '@/api/client';

type Props = { src: string; poster?: string; label: string; seek?: { at: number; n: number }; fill?: boolean };

/**
 * The phone's own player (06/11/2026, the app), the same role as the browser's in VideoPlayer.web.tsx: it asks the API
 * for parts of the file as the person watches, with the session in the headers; nothing is kept on the phone
 * (no cache). `seek` jumps to a moment; `fill` takes the whole space it is given (the visitor's full-screen viewer).
 */
export function VideoPlayer({ src, label, seek, fill }: Props) {
  // The source is made once per video: a new object at every redraw made expo-video replace the player while the
  // screen still showed the old one, and the app stopped answering (06/11/2026).
  const source = useMemo(() => ({ uri: src, headers: appHeaders(), useCaching: false }), [src]);
  const player = useVideoPlayer(source, (p) => { p.loop = false; });
  useEffect(() => {
    if (!seek) return;
    // expo-video moves the playback by setting this property of its player object (its documented way).
    // eslint-disable-next-line react-hooks/immutability
    player.currentTime = Math.max(0, seek.at - 0.5);
    player.play();
  }, [seek, player]);
  return (
    <VideoView player={player} nativeControls contentFit="contain" accessibilityLabel={label} allowsPictureInPicture={false}
               style={fill ? StyleSheet.absoluteFill : styles.box} />
  );
}

const styles = StyleSheet.create({
  box: { width: '100%', aspectRatio: 16 / 9, borderRadius: 10, backgroundColor: '#000000', overflow: 'hidden' },
});
