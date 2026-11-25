import { router, usePathname, type Href } from 'expo-router';
import { Bell, CircleCheck, Clock, Info, TriangleAlert, X, type LucideIcon } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState, type ComponentRef } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { dismissNotification, getNotifications, markNotificationsSeen, type PanelNotice } from '@/api/events';
import { HeaderPopover } from '@/components/panel/HeaderPopover';
import { useLayoutWidth } from '@/theme/accessibility';
import { fonts, panel } from '@/theme/tokens';

const ICON: Record<PanelNotice['tone'], { icon: LucideIcon; fg: string; bg: string }> = {
  danger: { icon: TriangleAlert, fg: panel.danger, bg: panel.dangerSoft },
  warning: { icon: Clock, fg: panel.warning, bg: panel.warningSoft },
  info: { icon: Info, fg: panel.primary, bg: panel.primarySoft },
};
const REFRESH_MS = 60_000;

/** The header bell (17/10/2026): what needs this account's attention, from GET /notifications, newest first.
 *  The red counter shows what appeared since the bell was last opened, and goes out when it is opened
 *  (28/10/2026); an item disappears when its situation is solved, or when the person dismisses it (08/11/2026). */
export function NotificationBell({ onOpen }: { onOpen?: () => void }) {
  const [data, setData] = useState<{ items: PanelNotice[]; unseen: number } | null>(null);
  const [open, setOpen] = useState(false);
  const anchor = useRef<ComponentRef<typeof View>>(null);
  const pathname = usePathname();
  // Hung from the bell, the 380 px list ran past the LEFT edge of a phone (06/11/2026): the bell is near the
  // middle of the header there. Below 600 px it takes the screen's width instead, 12 px from each edge.
  const narrow = useLayoutWidth() < 600;
  // A short phone (568 px tall) had the end of the list and "Abrir a Visão geral" below the screen.
  const { height } = useWindowDimensions();
  const listMax = narrow ? Math.max(160, Math.min(420, height - 200)) : 420;

  const load = useCallback(() => { getNotifications().then(setData).catch(() => undefined); }, []);
  useEffect(() => { load(); }, [load, pathname]);           // every screen change…
  useEffect(() => {                                         // …and every minute while the panel is open
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);
  const close = useCallback(() => setOpen(false), []);

  const unseen = data?.unseen ?? 0;
  // Dismissed notices stay in the overview, not here (08/11/2026).
  const all = data?.items ?? [];
  const items = all.filter((n) => !n.dismissed);
  const hidden = all.length - items.length;
  function toggle() {
    if (!open) {
      onOpen?.();
      // Seen: the counter goes out now, and the list is read again after the server has the mark.
      setData((d) => (d ? { ...d, unseen: 0 } : d));
      markNotificationsSeen().then(load, load);
    }
    setOpen((o) => !o);
  }
  function go(href: string) {
    setOpen(false);
    router.navigate(href as Href);
  }
  /** "I already know" (08/11/2026): out of the bell at once; back only if something new happens behind it. */
  function dismiss(n: PanelNotice) {
    setData((d) => (d ? { ...d, items: d.items.map((x) => (x.key === n.key ? { ...x, dismissed: true } : x)) } : d));
    dismissNotification(n.key).then(load, load);
  }

  return (
    <View>
      <Pressable ref={anchor} accessibilityRole="button" accessibilityState={{ expanded: open }} aria-expanded={open}
                 accessibilityLabel={unseen ? `Notificações: ${unseen} ${unseen === 1 ? 'nova' : 'novas'}` : 'Notificações'}
                 onPress={toggle} style={styles.round}>
        <Bell size={18} color={panel.navText} strokeWidth={1.6} absoluteStrokeWidth />
        {unseen > 0 && (
          <View style={styles.badge}><Text style={styles.badgeText}>{unseen > 9 ? '9+' : unseen}</Text></View>
        )}
      </Pressable>
      <HeaderPopover open={open} onClose={close} anchor={anchor} width={narrow ? undefined : 380} style={styles.panel}
                     webStyle={[styles.panelWeb, narrow && styles.panelNarrow]}>
        {(room) => (
          <View accessibilityRole="menu" style={{ maxHeight: room }}>
            <View style={styles.head}>
              <Text style={styles.title}>Notificações</Text>
              {items.length > 0 && <Text style={styles.count}>{items.length} {items.length === 1 ? 'aviso' : 'avisos'}</Text>}
            </View>
            {items.length === 0 ? (
              <View style={styles.empty}>
                <CircleCheck size={22} color={panel.success} strokeWidth={1.6} absoluteStrokeWidth />
                <Text style={styles.emptyText}>Nada pendente por aqui.</Text>
              </View>
            ) : (
              // The head and the foot take about 100 px of the room left on the screen.
              <ScrollView style={{ maxHeight: Math.min(listMax, room - 100) }}>
                {items.map((n) => {
                  const t = ICON[n.tone];
                  return (
                    <View key={n.key} style={styles.item}>
                      <Pressable accessibilityRole="menuitem" onPress={() => go(n.href)}
                                 style={({ hovered }: any) => [styles.itemMain, hovered && { backgroundColor: panel.page }]}>
                        <View style={[styles.icon, { backgroundColor: t.bg }]}>
                          <t.icon size={15} color={t.fg} strokeWidth={1.8} absoluteStrokeWidth />
                        </View>
                        <View style={{ flex: 1, gap: 2 }}>
                          <Text style={styles.itemTitle}>{n.title}</Text>
                          <Text style={styles.itemText}>{n.description}</Text>
                        </View>
                      </Pressable>
                      <Pressable accessibilityRole="button" accessibilityLabel={`Dispensar o aviso: ${n.title}`} hitSlop={6}
                                 onPress={() => dismiss(n)}
                                 style={({ hovered }: any) => [styles.dismiss, hovered && { backgroundColor: panel.page }]}>
                        <X size={16} color={panel.muted} strokeWidth={1.8} absoluteStrokeWidth />
                      </Pressable>
                    </View>
                  );
                })}
              </ScrollView>
            )}
            {hidden > 0 && (
              <Text style={styles.hidden}>
                {hidden === 1 ? '1 aviso dispensado continua' : `${hidden} avisos dispensados continuam`} na Visão geral.
              </Text>
            )}
            <Pressable accessibilityRole="link" onPress={() => go('/painel')} style={styles.foot}>
              <Text style={styles.footLink}>Abrir a Visão geral</Text>
            </Pressable>
          </View>
        )}
      </HeaderPopover>
    </View>
  );
}

const styles = StyleSheet.create({
  round: { width: 38, height: 38, borderRadius: 999, backgroundColor: panel.page, alignItems: 'center', justifyContent: 'center' },
  badge: { position: 'absolute', top: -3, right: -4, minWidth: 18, height: 18, paddingHorizontal: 4, borderRadius: 999,
           backgroundColor: panel.notificationDot, borderWidth: 2, borderColor: panel.surface, alignItems: 'center', justifyContent: 'center' },
  badgeText: { fontFamily: fonts.bold, fontSize: 10, color: '#FFFFFF' },
  // The box's look; where it sits is decided by HeaderPopover (the app) or by panelWeb / panelNarrow (the site).
  panel: { backgroundColor: panel.surface, borderWidth: 1, borderColor: panel.border, borderRadius: panel.radius,
           boxShadow: '0px 12px 32px rgba(24, 55, 72, 0.16)', overflow: 'hidden' },
  panelWeb: { position: 'absolute', top: 50, right: -8, width: 380, maxWidth: '92vw' as unknown as number },
  panelNarrow: { position: 'fixed' as 'absolute', top: 64, left: 12, right: 12, width: 'auto', maxWidth: undefined, zIndex: 50 },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14,
          borderBottomWidth: 1, borderColor: panel.border },
  title: { fontFamily: fonts.bold, fontSize: 15, color: panel.text },
  count: { fontFamily: fonts.regular, fontSize: 12, color: panel.muted },
  item: { flexDirection: 'row', alignItems: 'flex-start', borderBottomWidth: 1, borderColor: panel.borderSoft },
  itemMain: { flex: 1, flexDirection: 'row', gap: 12, paddingLeft: 16, paddingRight: 4, paddingVertical: 12 },
  dismiss: { width: 32, height: 32, borderRadius: 999, alignItems: 'center', justifyContent: 'center', marginTop: 10, marginRight: 8 },
  hidden: { fontFamily: fonts.regular, fontSize: 12, color: panel.muted, textAlign: 'center', paddingHorizontal: 16, paddingTop: 10 },
  icon: { width: 30, height: 30, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  itemTitle: { fontFamily: fonts.bold, fontSize: 13, lineHeight: 18, color: panel.text },
  itemText: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 17, color: panel.muted },
  empty: { alignItems: 'center', gap: 8, paddingVertical: 28 },
  emptyText: { fontFamily: fonts.regular, fontSize: 13, color: panel.muted },
  foot: { paddingVertical: 12, alignItems: 'center' },
  footLink: { fontFamily: fonts.bold, fontSize: 13, color: panel.primary },
});
