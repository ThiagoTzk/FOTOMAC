import { ChevronLeft, ChevronRight, Columns2, Info, X } from 'lucide-react-native';
import { useEffect, useState, type ReactNode } from 'react';
import { Modal as RNModal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ZoomImage } from '@/components/ui/ZoomImage';
import { fonts, panel } from '@/theme/tokens';
import { useLayoutWidth } from '@/theme/accessibility';
import { SafeWindow } from '@/ui/SafeWindow';

type Props = {
  visible: boolean;
  onClose: () => void;
  uri: string;
  /** Small copy shown while the large one loads. */
  placeholder?: string;
  alt: string;
  /** "Foto 3 de 40" and, under it, the event or the credit. */
  title: string;
  subtitle?: string;
  /** Absent = no photo on that side. The ← → keys are the parent's (it already listens on the page). */
  onPrev?: () => void;
  onNext?: () => void;
  /** Status pills, on the left of the bottom bar. */
  info?: ReactNode;
  /** The decisions (approve, reject, "não é esta pessoa", download…), on the right of the bottom bar:
   *  always on screen, never below the photo, where they went unnoticed. */
  children?: ReactNode;
  /** "Detalhes" of the file, in a side panel opened from the top bar (24/10/2026). */
  details?: ReactNode;
  /** Something to compare the photo with, on the LEFT of it (31/10/2026: the reference photos of the person's
   *  signed term, to confirm "é a pessoa?" looking at both). Open from the start; the top bar hides it. */
  compare?: { label: string; content: ReactNode };
};

/**
 * The panel's full-screen photo (24/10/2026): the photo takes the whole window, with zoom (wheel, double
 * click, pinch, drag, + − 0), previous/next, and the actions of the page in a bar that never leaves the
 * screen. Esc closes. Same look as the visitor's "Foto ampliada", in the panel's colours.
 */
export function FullscreenViewer({ visible, onClose, uri, placeholder, alt, title, subtitle, onPrev, onNext, info, children, details,
                                  compare }: Props) {
  const width = useLayoutWidth();
  const phone = width < 640;
  const [showDetails, setShowDetails] = useState(false);
  const [showCompare, setShowCompare] = useState(!phone);

  useEffect(() => {
    if (Platform.OS !== 'web' || !visible) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [visible, onClose]);

  return (
    <RNModal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <SafeWindow style={styles.screen}><View style={{ flex: 1 }} role="dialog" aria-modal aria-label={title}>
        <View style={styles.top}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.title}>{title}</Text>
            {!!subtitle && <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text>}
          </View>
          <Text style={styles.hint}>{phone ? '' : '← → trocam de foto · Esc fecha'}</Text>
          {compare && (
            <Pressable accessibilityRole="button" accessibilityLabel={compare.label} accessibilityState={{ expanded: showCompare }} aria-expanded={showCompare}
                       onPress={() => setShowCompare((v) => !v)}
                       style={({ hovered }: any) => [styles.detailsButton, (hovered || showCompare) && { backgroundColor: 'rgba(255,255,255,0.12)' }]}>
              <Columns2 size={18} color="#FFFFFF" strokeWidth={1.8} absoluteStrokeWidth />
              {!phone && <Text style={styles.detailsText}>{compare.label}</Text>}
            </Pressable>
          )}
          {details && (
            <Pressable accessibilityRole="button" accessibilityLabel="Detalhes da foto" accessibilityState={{ expanded: showDetails }} aria-expanded={showDetails}
                       onPress={() => setShowDetails((v) => !v)}
                       style={({ hovered }: any) => [styles.detailsButton, (hovered || showDetails) && { backgroundColor: 'rgba(255,255,255,0.12)' }]}>
              <Info size={18} color="#FFFFFF" strokeWidth={1.8} absoluteStrokeWidth />
              {!phone && <Text style={styles.detailsText}>Detalhes</Text>}
            </Pressable>
          )}
          <Pressable accessibilityRole="button" accessibilityLabel="Fechar a tela cheia" onPress={onClose} hitSlop={8}
                     style={({ hovered }: any) => [styles.close, hovered && { backgroundColor: 'rgba(255,255,255,0.12)' }]}>
            <X size={26} color="#FFFFFF" strokeWidth={1.8} absoluteStrokeWidth />
          </Pressable>
        </View>

        <View style={{ flex: 1, flexDirection: 'row' }}>
          {compare && showCompare && (
            <ScrollView style={[styles.compare, phone && styles.sidePhone]} contentContainerStyle={{ padding: 16, gap: 12 }}>
              <Text style={styles.title}>{compare.label}</Text>
              {compare.content}
            </ScrollView>
          )}
          <View style={styles.stage}>
            <ZoomImage uri={uri} placeholder={placeholder} alt={alt} style={StyleSheet.absoluteFill} theme="dark" keyboard
                       onSwipe={(d) => (d === 1 ? onNext : onPrev)?.()} />
            {!phone && onPrev && <Arrow side="left" onPress={onPrev} />}
            {!phone && onNext && <Arrow side="right" onPress={onNext} />}
          </View>
          {details && showDetails && (
            <ScrollView style={[styles.side, phone && styles.sidePhone]} contentContainerStyle={{ padding: 20, gap: 12 }}>
              <Text style={styles.title}>Detalhes</Text>
              {details}
            </ScrollView>
          )}
        </View>

        {(info || children) && (
          <View style={styles.bottom}>
            <View style={styles.info}>{info}</View>
            <View style={styles.actions}>{children}</View>
          </View>
        )}
      </View></SafeWindow>
    </RNModal>
  );
}

function Arrow({ side, onPress }: { side: 'left' | 'right'; onPress: () => void }) {
  const Icon = side === 'left' ? ChevronLeft : ChevronRight;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={side === 'left' ? 'Foto anterior' : 'Próxima foto'} onPress={onPress}
               style={({ hovered }: any) => [styles.arrow, side === 'left' ? { left: 20 } : { right: 20 },
                                              hovered && { backgroundColor: panel.primary }]}>
      <Icon size={30} color="#FFFFFF" strokeWidth={2} absoluteStrokeWidth />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0B0F14' }, // solid: the page behind must not show through
  top: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingHorizontal: 20, paddingVertical: 12 },
  title: { fontFamily: fonts.semiBold, fontSize: 16, color: '#FFFFFF' },
  subtitle: { fontFamily: fonts.regular, fontSize: 13, color: 'rgba(255, 255, 255, 0.7)' },
  hint: { fontFamily: fonts.regular, fontSize: 12, color: 'rgba(255, 255, 255, 0.55)' },
  detailsButton: { height: 40, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, borderRadius: 20 },
  detailsText: { fontFamily: fonts.medium, fontSize: 14, color: '#FFFFFF' },
  side: { width: 340, flexGrow: 0, borderLeftWidth: 1, borderLeftColor: 'rgba(255, 255, 255, 0.08)', backgroundColor: '#111821' },
  compare: { width: 360, flexGrow: 0, borderRightWidth: 1, borderRightColor: 'rgba(255, 255, 255, 0.08)', backgroundColor: '#111821' },
  sidePhone: { position: 'absolute', top: 0, bottom: 0, right: 0, left: 0, width: 'auto' as never, zIndex: 5 },
  close: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  stage: { flex: 1, marginHorizontal: 8 },
  arrow: { position: 'absolute', top: '50%', marginTop: -26, width: 52, height: 52, borderRadius: 26,
           backgroundColor: 'rgba(0, 112, 176, 0.62)', alignItems: 'center', justifyContent: 'center' },
  bottom: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 12, paddingHorizontal: 20, paddingVertical: 14,
            borderTopWidth: 1, borderTopColor: 'rgba(255, 255, 255, 0.08)' },
  info: { flex: 1, minWidth: 200, flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
});
