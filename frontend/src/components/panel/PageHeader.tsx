import { router, type Href } from 'expo-router';
import { ArrowLeft } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { usePhone } from '@/theme/accessibility';
import { fonts, panel } from '@/theme/tokens';
import { confirmAsync } from '@/ui/confirm';

type Crumb = { label: string; href?: Href };

/**
 * "Título da página": breadcrumb, title (+ status), subtitle and actions on the right.
 *
 * Every page deeper than the first level gets a "Voltar" button before the breadcrumb. It goes
 * UP one level — to the nearest crumb with a link (Imagem → Imagens → Evento → Eventos) — not
 * back in the browser history, which could be anywhere (deep pages had no
 * easy way back).
 */
export function PageHeader({ crumbs, title, badge, subtitle, actions, leading, confirmLeave }: {
  crumbs?: Crumb[]; title: string; badge?: ReactNode; subtitle?: string; actions?: ReactNode;
  /** Before the title, e.g. the photo of the account being shown. */
  leading?: ReactNode;
  /** Asked before leaving by the header (e.g. photos still being sent would stop). */
  confirmLeave?: string;
}) {
  const parent = crumbs?.slice(0, -1).reverse().find((c) => c.href);
  const phone = usePhone();
  // On a phone the whole path took 2 or 3 lines: "Voltar" already says where it goes, so only the current page.
  const shown = phone && crumbs ? crumbs.slice(-1) : crumbs;
  const go = async (href: Href) => {
    // The browser's own confirm window, or the phone's alert in the app (ui/confirm).
    if (confirmLeave && !(await confirmAsync(confirmLeave, 'Sair'))) return;
    router.navigate(href);
  };
  return (
    <View style={{ gap: 10 }}>
      {crumbs && (
        <View style={styles.crumbs} role="navigation" accessibilityLabel="Caminho">
          {parent && (
            <Pressable accessibilityRole="link" accessibilityLabel={`Voltar para ${parent.label}`}
                       onPress={() => go(parent.href!)}
                       style={({ hovered }: any) => [styles.back, hovered && { backgroundColor: panel.primarySoft }]}>
              <ArrowLeft size={18} color={panel.primary} strokeWidth={2} absoluteStrokeWidth />
              <Text style={styles.backLink}>Voltar</Text>
            </Pressable>
          )}
          {shown!.map((c, i) => (
            <View key={c.label} style={{ flexDirection: 'row' }}>
              {i > 0 && <Text style={styles.crumbText}> / </Text>}
              {c.href ? (
                <Pressable accessibilityRole="link" onPress={() => go(c.href!)}>
                  <Text style={styles.crumbLink}>{c.label}</Text>
                </Pressable>
              ) : (
                <Text style={styles.crumbText}>{c.label}</Text>
              )}
            </View>
          ))}
        </View>
      )}
      <View style={styles.row}>
        {leading}
        <View style={{ flex: 1, minWidth: phone ? 0 : 240, gap: 6 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <Text style={[styles.title, phone && { fontSize: 24 }]} accessibilityRole="header">{title}</Text>
            {badge}
          </View>
          {!!subtitle && <Text style={styles.subtitle}>{subtitle}</Text>}
        </View>
        {/* maxWidth: without it the buttons ran past the screen instead of going to the next line. On a phone they
            always take the line below the title: beside it, "Baixar acervo" covered the word "Imagens" (06/11/2026). */}
        {actions && <View style={[{ flexDirection: 'row', gap: 10, flexWrap: 'wrap', flexShrink: 1, maxWidth: '100%' }, phone && { width: '100%' }]}>{actions}</View>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  crumbs: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
  back: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 34, paddingHorizontal: 12, marginRight: 14,
          borderRadius: 8, borderWidth: 1, borderColor: panel.primary },
  backLink: { fontFamily: fonts.semiBold, fontSize: 14, color: panel.primary },
  crumbLink: { fontFamily: fonts.semiBold, fontSize: 14, color: panel.primary },
  // The separator and the current page are not links: the same look, never underlined in the app.
  crumbText: { fontFamily: fonts.semiBold, fontSize: 14, color: panel.primary },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' },
  title: { fontFamily: fonts.regular, fontSize: 28, color: panel.text },
  subtitle: { fontFamily: fonts.regular, fontSize: 16, lineHeight: 23, color: panel.muted },
});
