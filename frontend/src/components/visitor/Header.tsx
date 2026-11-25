import { router } from 'expo-router';
import { ArrowLeft, Settings2 } from 'lucide-react-native';
import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/auth/AuthContext';
import { Brand } from '@/components/panel/Brand';
import { AccessibilityButton } from '@/components/panel/AccessibilityMenu';
import { ThemeToggle } from '@/components/panel/ThemeToggle';
import { useHideVideoCorner } from '@/components/panel/videoQueue';
import { poppins, visitor } from '@/theme/tokens';

import { Backdrop, Column } from './ui';

const MENU = [
  { label: 'Início', href: '/' },
  { label: 'Eventos', href: '/explorar' },
  { label: 'Como funciona', href: '/como-funciona' },
  { label: 'Política de Privacidade', href: '/privacidade' },
  { label: 'Créditos', href: '/creditos' },
] as const;

type Props = { back?: boolean | string; children?: ReactNode };

/**
 * White top card of every visitor screen ("Rectangle 3" with shadow 0 4 12 2 / 8%): the brand,
 * the settings icon and, below them, the screen's own header content.
 *
 * The settings icon opens the menu with the Privacy Policy — reachable from ANY screen
 * — the removal channel open to anyone and the staff login.
 */
export function VisitorHeader({ back, children }: Props) {
  const [open, setOpen] = useState(false);
  useHideVideoCorner(open);
  const { account, logout } = useAuth();
  return (
    <View style={styles.card}>
      <Column style={{ gap: 20, paddingTop: 24, paddingBottom: 20 }}>
        <View style={[styles.top, { zIndex: 30 }]}>
          <Pressable accessibilityRole="link" accessibilityLabel="FOTOMAC, início" onPress={() => router.navigate('/')}>
            <Brand small />
          </Pressable>
          {/* iPhone: the menu (the way to "Acesso da equipe") moves left out of the corner that takes no touch
              (SafeWindow.tsx), 08/11/2026. */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <AccessibilityButton />
            <ThemeToggle />
            <View>
              {open && <Backdrop onPress={() => setOpen(false)} />}
              <Pressable accessibilityRole="button" accessibilityLabel="Menu" accessibilityState={{ expanded: open }} aria-expanded={open}
                         onPress={() => setOpen((o) => !o)} hitSlop={6}>
                <Settings2 size={28} color={visitor.heading} strokeWidth={1.6} absoluteStrokeWidth />
              </Pressable>
              {open && (
                <View style={styles.menu} accessibilityRole="menu">
                  {/* A staff member logged in on this phone: who it is and the way back to their area. */}
                  {account && (
                    <View style={styles.who}>
                      <Text style={styles.whoName} numberOfLines={1}>{account.full_name}</Text>
                      <Text style={styles.whoRole}>{account.role_label}</Text>
                    </View>
                  )}
                  {[...MENU, account ? { label: 'Área da equipe', href: '/painel' } : { label: 'Acesso da equipe', href: '/login' }].map((m) => (
                    <Pressable key={m.href} accessibilityRole="menuitem"
                               onPress={() => { setOpen(false); router.push(m.href as never); }}
                               style={({ hovered }: any) => [styles.item, hovered && { backgroundColor: visitor.page }]}>
                      <Text style={styles.itemText}>{m.label}</Text>
                    </Pressable>
                  ))}
                  {account && (
                    <Pressable accessibilityRole="menuitem" onPress={() => { setOpen(false); logout(); }}
                               style={({ hovered }: any) => [styles.item, hovered && { backgroundColor: visitor.page }]}>
                      <Text style={styles.itemText}>Sair</Text>
                    </Pressable>
                  )}
                </View>
              )}
            </View>
          </View>
        </View>
        {back && (
          <Pressable accessibilityRole="link" style={styles.back}
                     // Really goes back (removes this screen) — "navigate" would stack the previous
                     // page on top and keep this one alive underneath. Opened by a direct link:
                     // there is nothing behind it, so it is replaced by the given page (or home).
                     onPress={() => (router.canGoBack() ? router.back() : router.replace((typeof back === 'string' ? back : '/') as never))}>
            <ArrowLeft size={24} color={visitor.primary} strokeWidth={1.8} absoluteStrokeWidth />
            <Text style={styles.backLink}>Voltar</Text>
          </Pressable>
        )}
        {children}
      </Column>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: visitor.surface, boxShadow: visitor.headerShadow, zIndex: 10 },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  menu: { position: 'absolute', right: 0, top: 38, width: 250, backgroundColor: visitor.surface, borderRadius: 12,
          padding: 8, boxShadow: visitor.menuShadow },
  item: { paddingVertical: 10, paddingHorizontal: 10, borderRadius: 8 },
  itemText: { fontFamily: poppins.medium, fontSize: 13, color: visitor.text },
  who: { paddingVertical: 8, paddingHorizontal: 10, borderBottomWidth: 1, borderBottomColor: visitor.page, marginBottom: 4 },
  whoName: { fontFamily: poppins.semiBold, fontSize: 13, color: visitor.heading },
  whoRole: { fontFamily: poppins.regular, fontSize: 12, color: visitor.muted },
  back: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start' },
  backLink: { fontFamily: poppins.medium, fontSize: 16, color: visitor.primary },
});
