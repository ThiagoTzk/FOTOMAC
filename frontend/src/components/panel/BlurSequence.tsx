import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { ImageItem } from '@/api/images';
import { BlurEditor } from '@/components/panel/BlurEditor';
import { ProgressBar } from '@/components/panel/Progress';
import { Button } from '@/components/panel/ui';
import { fonts, panel } from '@/theme/tokens';

type Props = { images: ImageItem[]; onFinished: (blurred: number, skipped: number) => void };

/**
 * "Borrar rostos nas selecionadas" (05/11/2026): the selected photos one after the other, quickly. Photo 1:
 * blur; photo 2: blur; photo 3: nothing to hide, skip. Each blur replaces that file at once, as in the photo's own
 * screen; closing in the middle keeps what was already blurred.
 */
export function BlurSequence({ images, onFinished }: Props) {
  const [at, setAt] = useState(0);
  const [blurred, setBlurred] = useState(0);
  const current = images[at];
  const last = at === images.length - 1;

  function next(didBlur: boolean) {
    const done = blurred + (didBlur ? 1 : 0);
    if (last) { onFinished(done, images.length - done); return; }
    setBlurred(done);
    setAt(at + 1);
  }

  if (!current) return null;
  return (
    <View style={{ gap: 12 }}>
      <View style={styles.head}>
        <Text style={styles.count} accessibilityLiveRegion="polite" aria-live="polite">Foto {at + 1} de {images.length}</Text>
        <Text style={styles.done}>{blurred} {blurred === 1 ? 'borrada' : 'borradas'} até agora</Text>
      </View>
      <ProgressBar percent={(100 * at) / images.length} height={5} />
      {/* key: a new photo starts the editor over (its faces, its picks). */}
      <BlurEditor key={current.id} image={current} height={480} onDone={() => next(true)}
                  applyLabel={last ? 'Borrar e concluir' : 'Borrar e ir para a próxima'}
                  secondary={<Button variant="secondary" label={last ? 'Nada a borrar: concluir' : 'Nada a borrar: próxima foto'} onPress={() => next(false)} />} />
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  count: { fontFamily: fonts.bold, fontSize: 16, color: panel.text },
  done: { fontFamily: fonts.regular, fontSize: 13, color: panel.muted },
});
