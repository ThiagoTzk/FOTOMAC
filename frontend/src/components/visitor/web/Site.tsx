import { router, usePathname, type Href } from 'expo-router';
import { ArrowLeft, ChevronDown, ChevronRight, LayoutDashboard, LogIn } from 'lucide-react-native';
import { useState, type ReactNode, type Ref, type ComponentRef } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { useAuth } from '@/auth/AuthContext';
import { Brand } from '@/components/panel/Brand';
import { CONTENT_ID, SkipLink } from '@/components/SkipLink';
import { AccountAvatar } from '@/components/AccountAvatar';
import { AccessibilityButton } from '@/components/panel/AccessibilityMenu';
import { ThemeToggle } from '@/components/panel/ThemeToggle';
import { Backdrop } from '@/components/visitor/ui';
import { poppins, themed, visitor } from '@/theme/tokens';
import { useLayoutWidth } from '@/theme/accessibility';

/**
 * The visitor area on a COMPUTER is a web site, not a stretched phone screen. Bands run edge to edge; only their content is limited to a 1200 px column
 * ("Wrap"). Layout studied in docs/design/simulado-home (approved 15/10/2026), CITEC tokens.
 */
export const web = {
  navy: '#072D44',
  navy2: '#0B3B5A',
  yellow: '#FFC506',
  ...themed('w', { line: '#E5E7EB', soft: '#646B78', softBlue: '#E8F5FC' },
               { line: '#2B3A46', soft: '#A3AEBB', softBlue: '#12324A' }),
  cardShadow: '0px 1px 3px rgba(0,0,0,.08), 0px 8px 24px rgba(5,27,59,.06)',
  cardShadowHover: '0px 2px 6px rgba(0,0,0,.08), 0px 16px 32px rgba(5,27,59,.12)',
};

export function Wrap({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.wrap, style]}>{children}</View>;
}

/** The site's menu, one real page per item, like any known site (24/10/2026). */
export const SITE_NAV: { label: string; href: Href; match: (p: string) => boolean }[] = [
  { label: 'Início', href: '/', match: (p) => p === '/' },
  { label: 'Eventos', href: '/explorar', match: (p) => p.startsWith('/explorar') || p.startsWith('/evento') },
  { label: 'Como funciona', href: '/como-funciona', match: (p) => p.startsWith('/como-funciona') },
  { label: 'Privacidade', href: '/privacidade', match: (p) => p.startsWith('/privacidade') },
];

/**
 * Right side of the top bar. Nobody logged in: "Acesso da equipe". A staff member already logged in in
 * this browser: their name and role and a button straight to their area — they go back and forth between
 * the public site and the panel without logging in again (e.g. to see a photo they just published).
 */
function StaffAccess() {
  const { account, logout } = useAuth();
  const [menu, setMenu] = useState(false);
  // Narrower windows: only the initials in the bar (the name and role move to the top of the menu).
  const compact = useLayoutWidth() < 1200;
  if (!account) {
    return (
      <Pressable accessibilityRole="link" onPress={() => router.push('/login')}
                 style={({ hovered }: any) => [styles.staff, hovered && { backgroundColor: web.softBlue }]}>
        <LogIn size={18} color={visitor.primary} strokeWidth={1.8} absoluteStrokeWidth />
        <Text style={styles.staffText}>Acesso da equipe</Text>
      </Pressable>
    );
  }
  return (
    <View style={styles.staffRow}>
      <View>
        {menu && <Backdrop onPress={() => setMenu(false)} />}
        <Pressable accessibilityRole="button" accessibilityLabel={`Conta de ${account.full_name}`} accessibilityState={{ expanded: menu }} aria-expanded={menu}
                   onPress={() => setMenu((m) => !m)} style={styles.who}>
          <AccountAvatar account={account} style={styles.avatar} textStyle={styles.avatarText} />
          {!compact && (
            <View style={{ maxWidth: 170 }}>
              <Text style={styles.whoName} numberOfLines={1}>{account.full_name.split(' ').slice(0, 2).join(' ')}</Text>
              <Text style={styles.whoRole} numberOfLines={1}>{account.role_label}</Text>
            </View>
          )}
          <ChevronDown size={14} color={visitor.muted} strokeWidth={1.8} absoluteStrokeWidth />
        </Pressable>
        {menu && (
          <View style={styles.menu} accessibilityRole="menu">
            {compact && (
              <View style={styles.menuWho}>
                <Text style={styles.whoName} numberOfLines={1}>{account.full_name}</Text>
                <Text style={styles.whoRole}>{account.role_label}</Text>
              </View>
            )}
            {/* "Área da equipe" is the blue button beside it — not repeated here (28/10/2026). */}
            {([['Meu perfil', () => router.push('/perfil')], ['Sair', () => logout()]] as const).map(([label, go]) => (
              <Pressable key={label} accessibilityRole="menuitem" onPress={() => { setMenu(false); go(); }}
                         style={({ hovered }: any) => [styles.menuItem, hovered && { backgroundColor: visitor.page }]}>
                <Text style={styles.menuText}>{label}</Text>
              </Pressable>
            ))}
          </View>
        )}
      </View>
      <Pressable accessibilityRole="link" onPress={() => router.push('/painel')}
                 style={({ hovered }: any) => [styles.panelButton, hovered && { opacity: 0.9 }]}>
        <LayoutDashboard size={18} color="#FFFFFF" strokeWidth={1.8} absoluteStrokeWidth />
        <Text style={styles.panelButtonText}>Área da equipe</Text>
      </Pressable>
    </View>
  );
}

/** Full-width top bar: the FOTOMAC mark (camera symbol + wordmark), the menu and staff access. */
export function SiteHeader() {
  const path = usePathname();
  return (
    <View style={styles.top} role="banner">
      <SkipLink />
      <Wrap style={styles.topRow}>
        <Pressable accessibilityRole="link" accessibilityLabel="FOTOMAC, início" onPress={() => router.navigate('/')}>
          <Brand large />
        </Pressable>
        <View style={styles.nav} role="navigation" accessibilityLabel="Menu principal">
          {SITE_NAV.map((n) => {
            const on = n.match(path);
            return (
              <Pressable key={n.label} accessibilityRole="link" onPress={() => router.navigate(n.href)}
                         style={({ hovered }: any) => [styles.navItem, (on || hovered) && styles.navItemOn]}>
                {({ hovered }: any) => <Text style={[styles.navText, (on || hovered) && { color: visitor.primary }]}>{n.label}</Text>}
              </Pressable>
            );
          })}
        </View>
        {/* Light/dark mode here too (30/10/2026), for whoever visits; the choice is the same as in the panel. */}
        <View style={styles.topRight}>
          <AccessibilityButton />
          <ThemeToggle />
          <StaffAccess />
        </View>
      </Wrap>
    </View>
  );
}

/** Footer in columns (the privacy policy and the removal channel on every page). */
export function SiteFooter() {
  const { account } = useAuth();
  const link = (label: string, href: Href) => (
    <Pressable accessibilityRole="link" onPress={() => router.navigate(href)}>
      {({ hovered }: any) => <Text style={[styles.footLink, hovered && { color: visitor.primary }]}>{label}</Text>}
    </Pressable>
  );
  return (
    <View style={styles.footer} role="contentinfo">
      <Wrap style={styles.footCols}>
        <View style={{ flex: 1.6, gap: 14 }}>
          <Brand />
          <Text style={styles.about}>
            Acervo fotográfico dos eventos do Centro Universitário CESMAC. As fotos destinam-se exclusivamente às pessoas
            nelas retratadas.
          </Text>
        </View>
        <View style={styles.footCol}><Text style={styles.footTitle}>FOTOMAC</Text>{link('Início', '/')}{link('Eventos', '/explorar')}{link('Como funciona', '/como-funciona')}{link('Créditos', '/creditos')}</View>
        <View style={styles.footCol}><Text style={styles.footTitle}>Privacidade</Text>{link('Política de Privacidade', '/privacidade')}</View>
        <View style={styles.footCol}><Text style={styles.footTitle}>Equipe</Text>{link(account ? 'Área da equipe' : 'Acesso da equipe', account ? '/painel' : '/login')}</View>
      </Wrap>
      <Wrap><View style={styles.legal}><Text style={styles.legalText}>© {new Date().getFullYear()} Centro Universitário CESMAC</Text><Text style={styles.legalText}>Maceió/AL</Text></View></Wrap>
    </View>
  );
}

export type Crumb = { label: string; href?: Href };

/**
 * Title band of an inner page, in the colours of the home's hero: a back arrow, the breadcrumb ("Início ›
 * Eventos › …" — every level is a link, so going back is always one click) and the title.
 */
export function PageBand({ crumbs, title, sub, children }: { crumbs: Crumb[]; title?: string; sub?: string; children?: ReactNode }) {
  return (
    <View style={styles.band}>
      <Wrap style={{ paddingTop: 28, paddingBottom: 40 }}>
        <View style={styles.crumbs} role="navigation" accessibilityLabel="Você está em">
          {/* Back where the person came from in the site; opened from a link (nothing behind it in this
              tab, e.g. "Ver no site" in the panel): the home page. */}
          <Pressable accessibilityRole="link" accessibilityLabel="Voltar" {...({ title: 'Voltar' } as object)}
                     onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
                     style={({ hovered }: any) => [styles.bandBack, hovered && { backgroundColor: 'rgba(255,255,255,0.18)' }]}>
            <ArrowLeft size={18} color="#FFFFFF" strokeWidth={2} absoluteStrokeWidth />
          </Pressable>
          {[{ label: 'Início', href: '/' as Href }, ...crumbs].map((c, i, all) => (
            <View key={c.label} style={styles.crumb}>
              {i > 0 && <ChevronRight size={14} color="rgba(255,255,255,0.6)" strokeWidth={1.8} absoluteStrokeWidth />}
              {c.href && i < all.length - 1 ? (
                <Pressable accessibilityRole="link" onPress={() => router.navigate(c.href!)}>
                  {({ hovered }: any) => <Text style={[styles.crumbText, hovered && { color: '#FFFFFF', textDecorationLine: 'underline' }]}>{c.label}</Text>}
                </Pressable>
              ) : <Text style={[styles.crumbText, { color: '#FFFFFF' }]} numberOfLines={1}>{c.label}</Text>}
            </View>
          ))}
        </View>
        {!!title && <Text style={styles.bandTitle} accessibilityRole="header">{title}</Text>}
        {!!sub && <Text style={styles.bandSub}>{sub}</Text>}
        {children}
      </Wrap>
    </View>
  );
}

/** A whole web page: top bar, the page's bands and the footer, in one scroll. */
export function WebPage({ children, scrollRef }: { children: ReactNode; scrollRef?: Ref<ComponentRef<typeof ScrollView>> }) {
  return (
    <ScrollView ref={scrollRef} style={{ flex: 1, backgroundColor: visitor.page }} contentContainerStyle={{ minHeight: '100%' }}>
      <SiteHeader />
      {/* Above the footer: a menu that opens near the end of the content (e.g. "Buscar minhas fotos")
          spills over it and must stay clickable. */}
      <View style={{ flexGrow: 1, zIndex: 1 }} role="main" id={CONTENT_ID}>{children}</View>
      <SiteFooter />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  topRight: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  wrap: { width: '100%', maxWidth: visitor.columnWide, alignSelf: 'center', paddingHorizontal: 32 },
  top: { backgroundColor: visitor.surface, boxShadow: visitor.headerShadow, zIndex: 50 },
  topRow: { height: 76, flexDirection: 'row', alignItems: 'center', gap: 32 },
  nav: { flex: 1, flexDirection: 'row', gap: 26, paddingLeft: 8 },
  navItem: { paddingVertical: 6, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  navItemOn: { borderBottomColor: visitor.primary },
  navText: { fontFamily: poppins.medium, fontSize: 15, color: visitor.heading },
  staff: { height: 44, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 18, borderRadius: 12, borderWidth: 1.5,
           borderColor: visitor.primary },
  staffText: { fontFamily: poppins.semiBold, fontSize: 15, color: visitor.primary },
  staffRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  who: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 },
  avatar: { width: 38, height: 38, borderRadius: 999, backgroundColor: web.softBlue, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontFamily: poppins.semiBold, fontSize: 14, color: visitor.primary },
  whoName: { fontFamily: poppins.semiBold, fontSize: 14, color: visitor.heading },
  whoRole: { fontFamily: poppins.regular, fontSize: 12, color: visitor.muted },
  menu: { position: 'absolute', top: 50, right: 0, minWidth: 190, backgroundColor: visitor.surface, borderRadius: 12, padding: 6,
          boxShadow: visitor.menuShadow, zIndex: 60 },
  menuItem: { paddingVertical: 10, paddingHorizontal: 12, borderRadius: 8 },
  menuWho: { paddingVertical: 8, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: web.line, marginBottom: 4 },
  menuText: { fontFamily: poppins.medium, fontSize: 14, color: visitor.text },
  panelButton: { height: 44, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 18, borderRadius: 12,
                 backgroundColor: visitor.action },
  panelButtonText: { fontFamily: poppins.semiBold, fontSize: 15, color: '#FFFFFF' },
  bandBack: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', marginRight: 4,
              backgroundColor: 'rgba(255,255,255,0.1)' },
  band: { zIndex: 20, backgroundImage: `radial-gradient(900px 360px at 90% -20%, rgba(68,200,245,.30), transparent 60%), linear-gradient(120deg, ${web.navy} 0%, ${web.navy2} 50%, ${visitor.primary} 100%)` } as object,
  crumbs: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  crumb: { flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: 560 },
  crumbText: { fontFamily: poppins.medium, fontSize: 14, color: 'rgba(255,255,255,0.75)' },
  bandTitle: { fontFamily: poppins.bold, fontSize: 38, lineHeight: 46, color: '#FFFFFF', marginTop: 18, maxWidth: 900 },
  bandSub: { fontFamily: poppins.regular, fontSize: 17, lineHeight: 27, color: 'rgba(255,255,255,0.85)', marginTop: 8, maxWidth: 760 },
  footer: { backgroundColor: visitor.surface, borderTopWidth: 1, borderTopColor: web.line },
  footCols: { flexDirection: 'row', gap: 32, paddingTop: 48, paddingBottom: 36 },
  footCol: { flex: 1, gap: 10 },
  footTitle: { fontFamily: poppins.semiBold, fontSize: 14, color: visitor.heading, marginBottom: 2 },
  footLink: { fontFamily: poppins.regular, fontSize: 14, color: visitor.muted },
  about: { fontFamily: poppins.regular, fontSize: 13, lineHeight: 22, color: web.soft, maxWidth: 340 },
  legal: { borderTopWidth: 1, borderTopColor: web.line, flexDirection: 'row', justifyContent: 'space-between', paddingTop: 18,
           paddingBottom: 22 },
  legalText: { fontFamily: poppins.regular, fontSize: 13, color: web.soft },
});
