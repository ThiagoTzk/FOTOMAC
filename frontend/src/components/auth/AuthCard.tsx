import { router, type Href } from 'expo-router';
import { ArrowLeft } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Icon } from '@/components/icons/Icon';
import { Brand } from '@/components/panel/Brand';
import { colors, fonts, radius, shadow } from '@/theme/tokens';

type Props = {
  title: string;
  subtitle: string;
  children?: ReactNode;
  /** Shows the green check circle of the success screens. */
  success?: boolean;
  /** The first-access card is 520 px wide in Figma; the others 480 px. */
  width?: number;
  /** Arrow in the page's top-left corner, where people look for "back" (24/10/2026). */
  back?: { href: Href; label: string };
};

/** "Card de autenticação": the frame shared by the 9 authentication screens. */
export function AuthCard({ title, subtitle, children, success = false, width = 480, back }: Props) {
  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.center}>
      {back && (
        <Pressable accessibilityRole="link" accessibilityLabel={back.label} onPress={() => router.replace(back.href)}
                   {...({ title: back.label } as object)}
                   style={({ hovered }: any) => [styles.back, hovered && { backgroundColor: colors.primarySoft }]}>
          <ArrowLeft size={22} color={colors.primary} strokeWidth={2} absoluteStrokeWidth />
        </Pressable>
      )}
      <View style={[styles.card, { maxWidth: width }]} role="main">
        {/* The camera symbol + wordmark, the same mark as the public site and the panel. */}
        <View style={styles.brand}>
          <Brand large />
          <Text style={styles.brandInstitution}>Centro Universitário CESMAC</Text>
        </View>
        {success && (
          <View style={styles.check}>
            <Icon name="check" size={25} />
          </View>
        )}
        <View style={styles.header}>
          <Text style={styles.title} accessibilityRole="header">{title}</Text>
          <Text style={styles.subtitle}>{subtitle}</Text>
        </View>
        {children}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  // Vertically centred like the Figma frames, but scrollable on short or narrow screens
  // — 16 px side margin so the card never touches the edges on a phone.
  center: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: 16 },
  card: {
    width: '100%',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: 40,
    gap: 24,
    alignItems: 'center',
    ...shadow.card,
  },
  back: { position: 'absolute', top: 20, left: 20, width: 44, height: 44, borderRadius: 22, alignItems: 'center',
          justifyContent: 'center', zIndex: 2 },
  brand: { alignItems: 'center', gap: 6 },
  brandInstitution: { fontFamily: fonts.bold, fontSize: 9, color: colors.textMuted, textTransform: 'uppercase' },
  check: {
    width: 56,
    height: 56,
    borderRadius: radius.pill,
    backgroundColor: colors.successSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  header: { gap: 10, width: '100%' },
  title: { fontFamily: fonts.regular, fontSize: 28, color: colors.text, textAlign: 'center' },
  subtitle: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 21, color: colors.textMuted, textAlign: 'center' },
});
