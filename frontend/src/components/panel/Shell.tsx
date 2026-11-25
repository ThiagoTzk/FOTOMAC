import { router, usePathname, type Href } from 'expo-router';
import {
  CalendarDays, ChevronDown, CircleUserRound, Globe, IdCard, Info, LayoutDashboard, LifeBuoy, LogOut, Menu, ScanFace, ScrollText, Tags, Users, X, type LucideIcon,
} from 'lucide-react-native';
import { useCallback, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/auth/AuthContext';
import { AccountAvatar } from '@/components/AccountAvatar';
import { ContractClock } from '@/components/panel/ContractClock';
import { Brand } from '@/components/panel/Brand';
import { HeaderPopover } from '@/components/panel/HeaderPopover';
import { NotificationBell } from '@/components/panel/NotificationBell';
import { AccessibilityButton } from '@/components/panel/AccessibilityMenu';
import { ScrollLock } from '@/components/panel/scrollLock';
import { ThemeToggle } from '@/components/panel/ThemeToggle';
import { useHideVideoCorner, useVideoQueue } from '@/components/panel/videoQueue';
import { CONTENT_ID, SkipLink } from '@/components/SkipLink';
import { fonts, panel } from '@/theme/tokens';
import { useLayoutWidth } from '@/theme/accessibility';

type NavEntry = { href: Href; label: string; icon: LucideIcon; match: string };

const NAV: NavEntry[] = [
  { href: '/painel', label: 'Visão geral', icon: LayoutDashboard, match: '/painel' },
  { href: '/eventos', label: 'Eventos', icon: CalendarDays, match: '/eventos' },
];

/** Figma (photographer menu): the consultation of institutional people — never for the hired
 *  photographer's temporary account. The API refuses it too. */
const INSTITUTIONAL_NAV: NavEntry = { href: '/pessoas-institucionais', label: 'Pessoas institucionais', icon: IdCard, match: '/pessoas-institucionais' };

/** RF027 (11/11/2026): the whole team keeps the themes (administrator, photographers, marketing), never the hired
 *  photographer's temporary account. Each theme is changed only by its author or the administrator (API). */
const THEMES_NAV: NavEntry = { href: '/temas', label: 'Temas', icon: Tags, match: '/temas' };

/** Administrator-only items (the Figma has no admin screens; same layout as the rest).
 *  Hiding them is only for the interface: the API refuses non-admins. */
const ADMIN_NAV: NavEntry[] = [
  { href: '/contas', label: 'Contas', icon: Users, match: '/contas' },
  THEMES_NAV,
  { href: '/reconhecimento', label: 'Reconhecimento facial', icon: ScanFace, match: '/reconhecimento' },
  // RF024 and RNF14 (11/11/2026): operations, atypical use of the public search and the compliance export.
  { href: '/registros', label: 'Registros', icon: ScrollText, match: '/registros' },
];

/** Every profile (28/10/2026): the team writes to the administration; the administration reads and answers. */
const SUPPORT_NAV: NavEntry = { href: '/suporte', label: 'Suporte', icon: LifeBuoy, match: '/suporte' };

const AREA: Record<string, string> = {
  admin: 'ÁREA DO ADMINISTRADOR', photographer: 'ÁREA DO FOTÓGRAFO', marketing: 'ÁREA DA EQUIPE DE MARKETING',
  contractor: 'ÁREA DO FOTÓGRAFO CONTRATADO',
};

/** Below this width the sidebar becomes a drawer (phones and tablets too). */
const WIDE = 1024;

export { initials } from '@/components/AccountAvatar';

function NavItem({ href, label, icon: Icon, active, onPress }: { href: Href; label: string; icon: LucideIcon; active: boolean; onPress?: () => void }) {
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityState={{ selected: active }} aria-current={active ? 'page' : undefined}
      onPress={() => { onPress?.(); router.navigate(href); }}
      style={({ hovered }: any) => [styles.navItem, active ? styles.navActive : hovered && { backgroundColor: panel.page }]}>
      <Icon size={18} color={active ? '#FFFFFF' : panel.navText} strokeWidth={1.6} absoluteStrokeWidth />
      <Text style={[styles.navLabel, active && styles.navLabelActive]}>{label}</Text>
    </Pressable>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { account, logout } = useAuth();
  const items = account?.role === 'admin' ? [...NAV, INSTITUTIONAL_NAV, ...ADMIN_NAV, SUPPORT_NAV]
    : account?.role === 'contractor' ? [...NAV, SUPPORT_NAV] : [...NAV, INSTITUTIONAL_NAV, THEMES_NAV, SUPPORT_NAV];
  return (
    <View style={styles.sidebar}>
      <View style={{ gap: 30 }}>
        <Brand />
        <View style={{ gap: 8 }} role="navigation" accessibilityLabel="Menu principal">
          {items.map((n) => (
            <NavItem key={n.label} {...n} active={pathname.startsWith(n.match)} onPress={onNavigate} />
          ))}
        </View>
      </View>
      <View style={{ gap: 8 }}>
        <View style={styles.divider} />
        {/* Back to the public site still logged in: its header shows the name and "Área da equipe". */}
        <NavItem href="/" label="Ver o site" icon={Globe} active={false} onPress={onNavigate} />
        {/* Credits of the project inside the panel (asked after the final banca, 17/11/2026); the site has /creditos. */}
        <NavItem href="/sobre" label="Sobre" icon={Info} active={pathname === '/sobre'} onPress={onNavigate} />
        <NavItem href="/perfil" label="Meu perfil" icon={CircleUserRound} active={pathname === '/perfil'} onPress={onNavigate} />
        <Pressable accessibilityRole="button" onPress={logout}
                   style={({ hovered }: any) => [styles.navItem, hovered && { backgroundColor: panel.page }]}>
          <LogOut size={18} color={panel.navText} strokeWidth={1.6} absoluteStrokeWidth />
          <Text style={styles.navLabel}>Sair</Text>
        </Pressable>
      </View>
    </View>
  );
}

function Header({ onMenu }: { onMenu?: () => void }) {
  const { account, logout } = useAuth();
  // Narrow screens (onMenu present): only the initials, so the header never overflows.
  const compact = !!onMenu;
  const [menu, setMenu] = useState(false);
  const avatar = useRef<ComponentRef<typeof View>>(null);
  const closeMenu = useCallback(() => setMenu(false), []);

  if (!account) return null;
  const role = account.role_label;
  return (
    <View style={[styles.header, compact && { paddingHorizontal: 16 }]} role="banner">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        {onMenu && (
          <Pressable accessibilityRole="button" accessibilityLabel="Abrir menu" onPress={onMenu} style={styles.round}>
            <Menu size={18} color={panel.navText} strokeWidth={1.6} absoluteStrokeWidth />
          </Pressable>
        )}
        {!compact && <Text style={styles.context}>{AREA[account.role]}</Text>}
      </View>
      <View style={styles.account}>
        {!compact && <ContractClock />}
        <AccessibilityButton />
        <ThemeToggle />
        <NotificationBell onOpen={() => setMenu(false)} />
        <Pressable ref={avatar} accessibilityRole="button" accessibilityLabel="Menu da conta" accessibilityState={{ expanded: menu }} aria-expanded={menu}
                   onPress={() => setMenu((m) => !m)} style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
          {/* The initials, or the photo the person chose to send in "Meu perfil" (optional, 28/10/2026). */}
          <AccountAvatar account={account} style={styles.avatar} textStyle={styles.avatarText} />
          {!compact && (
            <>
              <View style={{ gap: 2 }}>
                <Text style={styles.name} numberOfLines={1}>{account.full_name.split(' ').slice(0, 2).join(' ')}</Text>
                <Text style={styles.role}>{role}</Text>
              </View>
              <ChevronDown size={14} color={panel.muted} strokeWidth={1.6} absoluteStrokeWidth />
            </>
          )}
        </Pressable>
        {/* Closes with a touch outside, like the bell (08/11/2026). */}
        <HeaderPopover open={menu} onClose={closeMenu} anchor={avatar} width={200} style={styles.menu} webStyle={styles.menuWeb}>
          {() => (
            <View accessibilityRole="menu">
              <Pressable accessibilityRole="menuitem" style={styles.menuItem}
                         onPress={() => { setMenu(false); router.navigate('/perfil'); }}>
                <Text style={styles.menuText}>Meu perfil</Text>
              </Pressable>
              <Pressable accessibilityRole="menuitem" style={styles.menuItem}
                         onPress={() => { setMenu(false); router.navigate('/'); }}>
                <Text style={styles.menuText}>Ver o site</Text>
              </Pressable>
              <Pressable accessibilityRole="menuitem" style={styles.menuItem} onPress={() => { setMenu(false); logout(); }}>
                <Text style={styles.menuText}>Sair</Text>
              </Pressable>
            </View>
          )}
        </HeaderPopover>
      </View>
    </View>
  );
}

/** Sidebar + header + scrollable content, as in every "Área autenticada" frame. */
export function Shell({ children }: { children: ReactNode }) {
  const width = useLayoutWidth();
  const [drawer, setDrawer] = useState(false);
  const wide = width >= WIDE;
  // The count of videos sits over the bottom-right corner: room at the end so the last button is never under it.
  const queue = useVideoQueue();
  const videos = queue.items.length > 0;
  useHideVideoCorner(!wide && drawer);
  const [locked, setLocked] = useState(false);   // a finger on a map being edited: the page holds still (scrollLock.ts)
  return (
    <View style={styles.root}>
      <SkipLink />
      {wide && <Sidebar />}
      <View style={{ flex: 1 }}>
        <Header onMenu={wide ? undefined : () => setDrawer(true)} />
        {!wide && <ContractClock strip />}
        <ScrollLock.Provider value={setLocked}>
        <ScrollView style={{ flex: 1 }} scrollEnabled={!locked} contentContainerStyle={[styles.content, !wide && { padding: 16 }, videos && { paddingBottom: Math.max(200, queue.cornerHeight + 40) }]}>
          <View role="main" id={CONTENT_ID} style={{ gap: 24 }}>{children}</View>
        </ScrollView>
        </ScrollLock.Provider>
      </View>
      {!wide && drawer && (
        // A layer over the page, like the other windows: a screen reader stays in the menu while it is open.
        <View style={styles.overlay} role="dialog" aria-modal aria-label="Menu">
          <View style={{ height: '100%' }}>
            <Sidebar onNavigate={() => setDrawer(false)} />
            <Pressable accessibilityRole="button" accessibilityLabel="Fechar menu" onPress={() => setDrawer(false)}
                       style={[styles.round, { position: 'absolute', top: 20, right: -48 }]}>
              <X size={18} color={panel.navText} strokeWidth={1.6} absoluteStrokeWidth />
            </Pressable>
          </View>
          <Pressable style={{ flex: 1 }} accessibilityLabel="Fechar menu" onPress={() => setDrawer(false)} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, flexDirection: 'row', backgroundColor: panel.page },
  sidebar: { width: 240, height: '100%', backgroundColor: panel.surface, paddingTop: 26, paddingBottom: 24, paddingHorizontal: 20,
             justifyContent: 'space-between', borderRightWidth: 1, borderColor: panel.border },
  navItem: { height: 44, borderRadius: 10, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 12 },
  navActive: { backgroundColor: panel.action },
  navLabel: { fontFamily: fonts.medium, fontSize: 14, color: panel.navText },
  navLabelActive: { fontFamily: fonts.bold, color: '#FFFFFF' },
  divider: { height: 1, backgroundColor: panel.navDivider },
  header: { height: 72, backgroundColor: panel.surface, borderBottomWidth: 1, borderColor: panel.border, paddingHorizontal: 32,
            flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', zIndex: 10 },
  context: { fontFamily: fonts.regular, fontSize: 12, color: panel.muted },
  account: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  round: { width: 38, height: 38, borderRadius: 999, backgroundColor: panel.page, alignItems: 'center', justifyContent: 'center' },
  avatar: { width: 38, height: 38, borderRadius: 999, backgroundColor: panel.primarySoft, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontFamily: fonts.bold, fontSize: 14, color: panel.primaryText },
  name: { fontFamily: fonts.bold, fontSize: 14, color: panel.text, maxWidth: 160 },
  role: { fontFamily: fonts.regular, fontSize: 12, color: panel.muted },
  menu: { backgroundColor: panel.surface, borderWidth: 1, borderColor: panel.border,
          borderRadius: panel.radius, boxShadow: '0px 8px 24px rgba(24, 55, 72, 0.12)', paddingVertical: 6 },
  menuWeb: { position: 'absolute', top: 50, right: 0, minWidth: 180 },
  menuItem: { paddingHorizontal: 14, paddingVertical: 10 },
  menuText: { fontFamily: fonts.regular, fontSize: 14, color: panel.text },
  content: { padding: 32, gap: 24 },
  overlay: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, flexDirection: 'row', backgroundColor: 'rgba(7, 45, 68, 0.35)', zIndex: 100 },
});
