import { Redirect } from 'expo-router';
import { Square, SquareCheck } from 'lucide-react-native';
import { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/auth/AuthContext';
import { IDLE_LOGOUT_FLAG } from '@/auth/idle';
import { AuthCard } from '@/components/auth/AuthCard';
import { AuthLink } from '@/components/auth/AuthLink';
import { PrimaryButton } from '@/components/ui/Button';
import { Feedback } from '@/components/ui/Feedback';
import { TextField } from '@/components/ui/TextField';
import { colors, fonts } from '@/theme/tokens';

/** Figma: "Login padrão" + "Login — validação". */
export default function LoginScreen() {
  const { login, account } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // Unchecked by default: on a shared computer the session must end with the browser.
  const [remember, setRemember] = useState(false);
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Counted HERE, in the screen, for any e-mail typed: the warning below therefore says
  // nothing about whether an account exists, yet tells the real owner why
  // the correct password may stop working (lock after 5 failures).
  const [failures, setFailures] = useState(0);
  // Arrived here because the session ended for lack of use (IdleGuard): said once, then forgotten.
  const [idleNotice] = useState(() => {
    try {
      const minutes = sessionStorage.getItem(IDLE_LOGOUT_FLAG);
      sessionStorage.removeItem(IDLE_LOGOUT_FLAG);
      return minutes ? `Você foi desconectado depois de ${minutes} minutos sem uso, por segurança. Entre de novo.` : null;
    } catch { return null; }
  });

  // Already logged in: the staff login has nothing to do ("/" is the visitor home, not the panel).
  if (account) return <Redirect href="/painel" />;

  async function submit() {
    const missing = {
      email: email.trim() ? undefined : 'Informe seu e-mail.',
      password: password ? undefined : 'Informe sua senha.',
    };
    setErrors(missing);
    setServerError(null);
    if (missing.email || missing.password) return;

    setLoading(true);
    try {
      await login(email.trim(), password, remember);
      // The session now exists: the check below moves to the panel.
    } catch (err) {
      // The server answers with one generic message for every failure.
      setServerError(err instanceof Error ? err.message : 'Não foi possível entrar.');
      setFailures((n) => n + 1);
      setPassword('');
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthCard
      back={{ href: '/', label: 'Voltar ao site' }}
      title="Acesse sua conta"
      subtitle="Esta área é destinada à equipe FOTOMAC. Use o e-mail cadastrado na sua conta para continuar.">
      <View style={styles.form}>
        {idleNotice && !serverError && <Feedback tone="info" message={idleNotice} />}
        {serverError && <Feedback tone="error" message={serverError} />}
        {failures >= 3 && (
          <Feedback
            tone="info"
            message="Por segurança, após 5 tentativas sem sucesso o acesso é bloqueado por 15 minutos. Se esqueceu a senha, use “Esqueci minha senha”, que também desbloqueia a conta."
          />
        )}
        <TextField
          label="E-mail"
          value={email}
          onChangeText={setEmail}
          placeholder="nome@cesmac.edu.br"
          keyboardType="email-address"
          autoComplete="email"
          textContentType="username"
          autoFocus
          error={errors.email}
        />
        <TextField
          label="Senha"
          value={password}
          onChangeText={setPassword}
          placeholder="Digite sua senha"
          secure
          autoComplete="current-password"
          textContentType="password"
          onSubmitEditing={submit}
          error={errors.password}
        />
        <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: remember }} aria-checked={remember}
                   onPress={() => setRemember((v) => !v)} style={styles.remember}>
          {remember ? <SquareCheck size={20} color={colors.primary} strokeWidth={1.8} absoluteStrokeWidth />
            : <Square size={20} color={colors.textMuted} strokeWidth={1.8} absoluteStrokeWidth />}
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={styles.rememberLabel}>Manter conectado</Text>
            {/* The app keeps the session in the phone's safe; without it, closing the app logs out (06/11/2026). */}
            <Text style={styles.rememberHelp}>
              {Platform.OS === 'web' ? 'Por 30 dias, neste navegador. Use só no seu computador.' : 'Por 30 dias, neste celular. Use só no seu celular.'}
            </Text>
          </View>
        </Pressable>
        <PrimaryButton label="Entrar" onPress={submit} loading={loading} />
      </View>
      <AuthLink href="/recuperar-senha" label="Esqueci minha senha" />
    </AuthCard>
  );
}

const styles = StyleSheet.create({
  form: { gap: 16, width: '100%' },
  remember: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  rememberLabel: { fontFamily: fonts.semiBold, fontSize: 14, color: colors.text },
  rememberHelp: { fontFamily: fonts.regular, fontSize: 12, color: colors.textMuted },
});
