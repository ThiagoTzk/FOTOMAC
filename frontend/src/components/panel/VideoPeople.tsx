import { Image } from '@/ui/Image';
import { Users } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { formatDuration, videoPeople, type VideoItem } from '@/api/videos';
import { fonts, panel } from '@/theme/tokens';
import { useTapWord } from '@/theme/accessibility';

/**
 * "Pessoas neste vídeo" (05/11/2026): below the player of the panel, one face per person the recognition found,
 * each with the moment it was seen; a click takes the video there. Only for whoever manages the video. The faces are
 * cut from the video by the server when this opens and live only in this screen: nothing is stored or cached.
 */
export function VideoPeople({ video, onSeek }: { video: VideoItem; onSeek: (second: number) => void }) {
  const tap = useTapWord();
  const [people, setPeople] = useState<{ second: number; image: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    videoPeople(video.id).then((r) => alive && setPeople(r.people)).catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, [video.id]);

  return (
    <View style={styles.box} role="region" aria-label="Pessoas neste vídeo">
      <View style={styles.head}>
        <Users size={16} color={panel.primary} strokeWidth={1.8} absoluteStrokeWidth />
        <Text style={styles.title}>Pessoas neste vídeo</Text>
        {people && <Text style={styles.count}>{people.length === 1 ? '1 pessoa' : `${people.length} pessoas`}</Text>}
      </View>
      {error ? <Text style={styles.help}>{error}</Text>
        : !people ? <ActivityIndicator color={panel.primary} style={{ alignSelf: 'flex-start' }} />
          : people.length === 0 ? <Text style={styles.help}>Nenhuma pessoa encontrada pelo reconhecimento facial neste vídeo.</Text>
            : (
              <View style={styles.row}>
                {people.map((p, i) => (
                  <Pressable key={i} accessibilityRole="button" accessibilityLabel={`Pessoa ${i + 1}: ir para ${formatDuration(p.second)} do vídeo`}
                             onPress={() => onSeek(p.second)} style={({ hovered }: any) => [styles.face, hovered && { borderColor: panel.primary }]}>
                    <Image source={p.image} style={styles.picture} contentFit="cover" accessibilityLabel="" />
                    <Text style={styles.when}>{formatDuration(p.second)}</Text>
                  </Pressable>
                ))}
              </View>
            )}
      <Text style={styles.help}>
        Uma foto de cada pessoa encontrada pelo reconhecimento facial, com o momento em que aparece; {tap} para ir até ele.
        As fotos são recortadas do vídeo agora e não ficam guardadas.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: 8 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontFamily: fonts.bold, fontSize: 14, color: panel.text },
  count: { fontFamily: fonts.regular, fontSize: 13, color: panel.muted },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  face: { width: 84, gap: 4, padding: 4, borderRadius: 10, borderWidth: 1, borderColor: panel.border, alignItems: 'center' },
  picture: { width: 74, height: 74, borderRadius: 8, backgroundColor: panel.page },
  when: { fontFamily: fonts.medium, fontSize: 12, color: panel.muted },
  help: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 17, color: panel.muted },
});
