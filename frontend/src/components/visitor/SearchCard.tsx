import { ScanFace } from 'lucide-react-native';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { poppins, visitor } from '@/theme/tokens';

import { Note, ResponsibleUse, useJustified, vtext } from './ui';

type Props = {
  /** Shows the "Permissão para uso de imagem" if still needed, then opens the guided capture. */
  onStart: () => void;
  busy: boolean;
  style?: StyleProp<ViewStyle>;
};

/**
 * "Procure suas fotos" card of the event page.
 *
 * Adaptation: the design card says "Ao prosseguir, você aceita..." — a tacit acceptance,
 * forbidden (LGPD Art. 8 §1). Here "Buscar minhas fotos" first shows the
 * permission notice; only after "Estou ciente" does the camera open.
 *
 * The search is made ONLY with the camera, by the guided capture with liveness check.
 * The "Realizar upload" option is gone: a photo from the gallery could be anyone's photo.
 */
export function SearchCard({ onStart, busy, style, button = true }: Props & { button?: boolean }) {
  const justified = useJustified();
  return (
    <View style={[styles.card, style]}>
      <View>
        <Text style={vtext.h3}>Procure suas fotos</Text>
        <Text style={[vtext.h4, { marginTop: 2 }]}>Galeria privada</Text>
        <Text style={[vtext.small, justified]}>
          {button ? 'A galeria desse evento é privada e para você poder visualizar suas fotos você precisa realizar uma busca no campo abaixo.'
            : 'A galeria desse evento é privada e para você poder visualizar suas fotos você precisa realizar uma busca pelo botão “Buscar minhas fotos”.'}
        </Text>
      </View>
      <View style={{ gap: 4 }}>
        <View style={styles.row}>
          <ScanFace size={36} color={visitor.primary} strokeWidth={1.5} absoluteStrokeWidth />
          <Text style={vtext.h3}>Reconhecimento facial</Text>
        </View>
        <Note>
          Antes de abrir a câmera, você verá o aviso de permissão para uso de imagem. A busca usa uma captura rápida do seu
          rosto, seguindo os movimentos indicados na tela; nenhum vídeo é gravado e os quadros são apagados logo depois.
        </Note>
      </View>
      {/* On a phone the button is already at the top, by the event's name (06/11/2026: it showed twice). */}
      {button && (
      <Pressable accessibilityRole="button" accessibilityState={{ busy }} disabled={busy} onPress={onStart}
                 style={({ hovered }: any) => [styles.button, hovered && { opacity: 0.9 }]}>
        {busy ? <ActivityIndicator size="small" color="#FFFFFF" />
          : <ScanFace size={22} color="#FFFFFF" strokeWidth={1.8} absoluteStrokeWidth />}
        <Text style={styles.buttonText}>{busy ? 'Buscando suas fotos…' : 'Buscar minhas fotos'}</Text>
      </Pressable>)}
      {/* Only before a search: then this card goes away and the result brings its own copy (06/11/2026). */}
      <ResponsibleUse />
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: visitor.surface, borderRadius: 12, padding: 16, gap: 12, boxShadow: visitor.cardShadow, zIndex: 5 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  button: { height: 46, alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 18,
            borderRadius: 12, backgroundColor: visitor.action },
  buttonText: { fontFamily: poppins.semiBold, fontSize: 16, color: '#FFFFFF' },
});
