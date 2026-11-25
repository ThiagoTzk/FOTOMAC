import { Clock } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { api } from '@/api/client';
import { useAuth, type Account } from '@/auth/AuthContext';
import { IDLE_LOGOUT_FLAG, lastUseAt, markUse, setAsking, syncFromServer } from '@/auth/idle';
import { startPresence } from '@/auth/presence';
import { fonts, panel } from '@/theme/tokens';

const WARN_SECONDS = 60;   // "Você ainda está aí?" this long before the end
const TICK_MS = 1000;      // the countdown goes down one second at a time

/**
 * Ends the session after a period without use (25/10/2026), for every profile — the administrator too.
 * Not with "Manter conectado" (the person's own computer). One minute before the end it asks "Você ainda
 * está aí?" and the card STAYS until "Continuar conectado" or the end (28/10/2026): moving the mouse does not
 * answer it. Use in another tab keeps the session (the card closes there too). The server enforces the same
 * limit by itself: closing this warning does not keep an abandoned session alive.
 */
export function IdleGuard() {
  const { account, logout } = useAuth();
  const idle = account?.idle_minutes ?? null;
  const [left, setLeft] = useState<number | null>(null);   // seconds, while the warning is shown

  useEffect(() => {
    if (!idle) return;
    const web = Platform.OS === 'web';
    const use = () => markUse();
    // In the app (06/11/2026) every touch on the screen counts as use: the root layout calls markUse() (no mouse there).
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'focus'] as const;
    if (web) {
      events.forEach((e) => window.addEventListener(e, use, { passive: true, capture: true }));
      window.addEventListener('scroll', use, { passive: true, capture: true });
    }
    markUse(true);
    const stopPresence = web ? startPresence() : () => undefined;   // closing the browser ends the session too
    let checking = false;
    const close = () => { setAsking(false); setLeft(null); };
    const tick = async () => {
      // lastUseAt() only moves while the card is open if "Continuar conectado" was clicked (here or in another tab).
      const remaining = Math.ceil((idle * 60_000 - (Date.now() - lastUseAt())) / 1000);
      if (remaining > WARN_SECONDS) { close(); return; }
      if (remaining > 0) { setAsking(true); setLeft(remaining); return; }
      if (checking) return;
      // Time is up here — the server decides (another window may have been in use).
      checking = true;
      try {
        const me = await api<Account>('/auth/me', { asIs: true });
        if (me.idle_left_seconds && me.idle_left_seconds > 3) { syncFromServer(me.idle_left_seconds, idle); close(); }
        else throw new Error('idle');
      } catch {
        try { sessionStorage.setItem(IDLE_LOGOUT_FLAG, String(idle)); } catch { /* the login just won't explain */ }
        close();
        void logout();   // the other tabs are told too
      } finally { checking = false; }
    };
    const timer = setInterval(tick, TICK_MS);
    return () => {
      clearInterval(timer);
      stopPresence();
      setAsking(false);
      if (web) {
        events.forEach((e) => window.removeEventListener(e, use, { capture: true }));
        window.removeEventListener('scroll', use, { capture: true });
      }
    };
  }, [idle, logout]);

  if (left === null || !account) return null;
  const mmss = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  return (
    <Modal visible transparent animationType="fade">
      <View style={styles.overlay}>
        <View style={styles.card} role="alertdialog" aria-label="Você ainda está aí?">
          <View style={styles.icon}><Clock size={24} color={panel.primary} strokeWidth={1.8} absoluteStrokeWidth /></View>
          <Text style={styles.title}>Você ainda está aí?</Text>
          <Text style={styles.text}>
            Por segurança, a conta é desconectada depois de {idle} minutos sem uso. Faltam <Text style={styles.strong}>{mmss}</Text>.
          </Text>
          <View style={styles.actions}>
            <Pressable accessibilityRole="button" onPress={() => { setAsking(false); setLeft(null); void logout(); }} style={[styles.button, styles.secondary]}>
              <Text style={[styles.buttonText, { color: panel.text }]}>Sair agora</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => { setAsking(false); markUse(true); setLeft(null); }} style={styles.button}>
              <Text style={styles.buttonText}>Continuar conectado</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(7, 45, 68, 0.45)', alignItems: 'center', justifyContent: 'center', padding: 16 },
  card: { width: '100%', maxWidth: 420, backgroundColor: panel.surface, borderRadius: 14, padding: 24, gap: 14 },
  icon: { width: 46, height: 46, borderRadius: 23, backgroundColor: panel.primarySoft, alignItems: 'center', justifyContent: 'center' },
  title: { fontFamily: fonts.semiBold, fontSize: 19, color: panel.text },
  text: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 21, color: panel.muted },
  strong: { fontFamily: fonts.bold, color: panel.text },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, flexWrap: 'wrap' },
  button: { height: 42, paddingHorizontal: 16, borderRadius: 10, backgroundColor: panel.action, alignItems: 'center', justifyContent: 'center' },
  secondary: { backgroundColor: panel.surface, borderWidth: 1, borderColor: panel.border },
  buttonText: { fontFamily: fonts.semiBold, fontSize: 14, color: '#FFFFFF' },
});
