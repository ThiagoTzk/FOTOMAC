import type { LucideIcon } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { Modal as RNModal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { usePhone } from '@/theme/accessibility';

import { fonts, panel } from '@/theme/tokens';
import { SafeWindow } from '@/ui/SafeWindow';

type Props = {
  visible: boolean;
  onClose: () => void;
  icon: LucideIcon;
  tone?: 'primary' | 'danger';
  title: string;
  width?: number;
  children: ReactNode;
};

/** "Modal de publicação" / "Modal de exclusão": dark overlay + white card, read from the .fig. */
export function Modal({ visible, onClose, icon: Icon, tone = 'primary', title, width = 520, children }: Props) {
  const bg = tone === 'danger' ? panel.dangerSoft : panel.primarySoft;
  const fg = tone === 'danger' ? panel.danger : panel.primary;
  // On a phone the icon and the title share one line and the margins are smaller: the content gets the room.
  const phone = usePhone();
  return (
    <RNModal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <SafeWindow style={styles.dim}>
      <Pressable style={[styles.overlay, phone && { padding: 10 }]} onPress={onClose} accessibilityLabel="Fechar">
        <Pressable style={[styles.card, { maxWidth: width }, phone && { padding: 18, maxHeight: '96%' }]} onPress={() => undefined}
                   accessibilityRole="none" aria-modal role="dialog" aria-label={title}>
          <ScrollView contentContainerStyle={{ gap: phone ? 14 : 20 }}>
            <View style={phone ? { flexDirection: 'row', alignItems: 'center', gap: 12 } : { gap: 20 }}>
              <View style={[styles.icon, { backgroundColor: bg }, phone && { width: 36, height: 36 }]}>
                <Icon size={phone ? 18 : 23} color={fg} strokeWidth={1.6} absoluteStrokeWidth />
              </View>
              <Text style={[styles.title, phone && { fontSize: 19, flex: 1 }]}>{title}</Text>
            </View>
            {children}
          </ScrollView>
        </Pressable>
      </Pressable>
      </SafeWindow>
    </RNModal>
  );
}

const styles = StyleSheet.create({
  dim: { backgroundColor: 'rgba(9, 38, 56, 0.60)' },
  overlay: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16 },
  card: { width: '100%', maxHeight: '90%', backgroundColor: panel.surface, borderRadius: panel.cardRadius, padding: 28,
          boxShadow: '0px 18px 48px rgba(0, 27, 43, 0.18)' },
  icon: { width: 48, height: 48, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  title: { fontFamily: fonts.regular, fontSize: 24, color: panel.text },
});
