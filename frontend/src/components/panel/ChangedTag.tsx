import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { formatDateTime } from '@/api/images';
import { fonts, panel } from '@/theme/tokens';

function ago(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return 'hoje';
  if (days === 1) return 'ontem';
  if (days < 30) return `há ${days} dias`;
  const months = Math.floor(days / 30);
  return months < 12 ? `há ${months} ${months === 1 ? 'mês' : 'meses'}` : `há ${Math.floor(months / 12)} ${months < 24 ? 'ano' : 'anos'}`;
}

/**
 * "alterado" next to a piece of data that was corrected after the registration (24/10/2026). Hovering it (or
 * tapping, on a phone) shows when: "Alterado em 24/10/2026 às 15:30 (há 3 dias)".
 */
export function ChangedTag({ at }: { at?: string | null }) {
  const [open, setOpen] = useState(false);
  if (!at) return null;
  const when = `Alterado em ${formatDateTime(at)} (${ago(at)})`;
  return (
    <View style={{ zIndex: open ? 20 : 1 }}>
      <Pressable accessibilityRole="text" accessibilityLabel={when} onHoverIn={() => setOpen(true)} onHoverOut={() => setOpen(false)}
                 onPress={() => setOpen((o) => !o)} style={styles.tag}>
        <Text style={styles.tagText}>alterado</Text>
      </Pressable>
      {open && <View style={styles.tip} pointerEvents="none"><Text style={styles.tipText}>{when}</Text></View>}
    </View>
  );
}

const styles = StyleSheet.create({
  tag: { paddingHorizontal: 7, paddingVertical: 1, borderRadius: 999, backgroundColor: panel.warningSoft },
  tagText: { fontFamily: fonts.semiBold, fontSize: 11, color: panel.warning },
  tip: { position: 'absolute', top: 22, left: 0, backgroundColor: panel.text, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6,
         width: 260 },
  tipText: { fontFamily: fonts.regular, fontSize: 12, color: '#FFFFFF' },
});
