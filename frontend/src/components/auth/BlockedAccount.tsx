import { router } from 'expo-router';
import { Ban, Clock, LogOut, PauseCircle } from 'lucide-react-native';
import { useEffect } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { formatDateTime } from '@/api/images';
import { useAuth, type Account } from '@/auth/AuthContext';
import { AccountAvatar } from '@/components/AccountAvatar';
import { Brand } from '@/components/panel/Brand';
import { AccessibilityButton } from '@/components/panel/AccessibilityMenu';
import { ThemeToggle } from '@/components/panel/ThemeToggle';
import { Card, Notice } from '@/components/panel/ui';
import { MySupport } from '@/components/support/MySupport';
import { fonts, panel } from '@/theme/tokens';

const CHECK_MS = 30000;   // reactivated meanwhile? the full panel opens by itself

const TEXT: Record<Exclude<Account['status'], 'active'>, { icon: typeof Ban; title: string; body: string; since: string; subject: string }> = {
  suspended: {
    icon: Ban, title: 'Esta conta está suspensa',
    body: 'A administração suspendeu o seu acesso ao FOTOMAC. Enquanto isso, você vê só esta página. Para entender o motivo ou pedir a reativação, escreva para a administração abaixo.',
    since: 'Suspensa em', subject: 'Pedido de reativação da conta',
  },
  inactive: {
    icon: PauseCircle, title: 'Esta conta está desativada',
    body: 'A administração desativou o seu acesso ao FOTOMAC. Enquanto isso, você vê só esta página. Para voltar a usar o sistema, escreva para a administração abaixo.',
    since: 'Desativada em', subject: 'Pedido de reativação da conta',
  },
  expired: {
    icon: Clock, title: 'O prazo da sua conta temporária terminou',
    body: 'O período contratado acabou e o acesso aos eventos foi encerrado. As fotos que você enviou continuam no acervo, com o seu crédito. Para uma nova cobertura ou mais prazo, escreva para a administração abaixo.',
    since: 'Expirou em', subject: 'Pedido de renovação do acesso',
  },
};

function Data({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ gap: 2, minWidth: 180, flexGrow: 1, flexBasis: 180 }}>
      <Text style={styles.label}>{label}</Text>
      <Text selectable={false} style={styles.value}>{value}</Text>
    </View>
  );
}

/**
 * What a suspended, deactivated or expired account sees after typing the RIGHT password (31/10/2026, user test:
 * before, only the generic error, and nowhere to go). Its situation, its own data and the Support page to ask to
 * come back — nothing else of the panel; the server refuses every other route to this session anyway.
 */
export function BlockedAccount({ account }: { account: Account }) {
  const { logout, refresh } = useAuth();
  const text = TEXT[account.status as Exclude<Account['status'], 'active'>];
  const Icon = text.icon;

  useEffect(() => {
    const id = setInterval(() => { refresh(); }, CHECK_MS);
    return () => clearInterval(id);
  }, [refresh]);

  return (
    <View style={{ flex: 1, backgroundColor: panel.page }}>
      {/* iPhone: "Sair" moves left out of the corner that takes no touch (SafeWindow.tsx). */}
      <View style={styles.top}>
        <Pressable accessibilityRole="link" accessibilityLabel="FOTOMAC, início" onPress={() => router.navigate('/')}>
          <Brand />
        </Pressable>
        <View style={styles.topRight}>
          <AccessibilityButton />
          <ThemeToggle />
          <Pressable accessibilityRole="button" onPress={logout}
                     style={({ hovered }: any) => [styles.exit, hovered && { borderColor: panel.primary }]}>
            <LogOut size={16} color={panel.navText} strokeWidth={1.8} absoluteStrokeWidth />
            <Text style={styles.exitText}>Sair</Text>
          </Pressable>
        </View>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.column}>
          <Notice tone="warning" icon={Icon} title={text.title} description={text.body} />
          <Card padding={24} style={{ gap: 18 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
              <AccountAvatar account={account} style={styles.avatar} textStyle={styles.avatarText} />
              <View style={{ gap: 2, flex: 1 }}>
                <Text style={styles.name}>{account.full_name}</Text>
                <Text style={styles.label}>{account.role_label} · conta {account.status_label.toLowerCase()}</Text>
              </View>
            </View>
            <View style={styles.data}>
              <Data label="E-mail" value={account.email} />
              <Data label={text.since} value={account.blocked?.since ? formatDateTime(account.blocked.since) : 'Não registrado'} />
              <Data label="Último acesso ao sistema" value={account.blocked?.last_login_at ? formatDateTime(account.blocked.last_login_at) : 'Não registrado'} />
            </View>
          </Card>
          <MySupport initialKind="access" initialSubject={text.subject} formTitle="Falar com a administração" />
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  top: { height: 72, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 24,
         backgroundColor: panel.surface, borderBottomWidth: 1, borderColor: panel.border },
  topRight: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  exit: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 38, paddingHorizontal: 14, borderRadius: 999,
          borderWidth: 1, borderColor: panel.border, backgroundColor: panel.page },
  exitText: { fontFamily: fonts.semiBold, fontSize: 14, color: panel.navText },
  content: { padding: 24, alignItems: 'center' },
  column: { width: '100%', maxWidth: 860, gap: 18 },
  avatar: { width: 56, height: 56, borderRadius: 999, backgroundColor: panel.primarySoft, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontFamily: fonts.bold, fontSize: 20, color: panel.primaryText },
  name: { fontFamily: fonts.bold, fontSize: 18, color: panel.text },
  label: { fontFamily: fonts.regular, fontSize: 13, color: panel.muted },
  value: { fontFamily: fonts.semiBold, fontSize: 15, color: panel.text },
  data: { flexDirection: 'row', flexWrap: 'wrap', gap: 18 },
});
