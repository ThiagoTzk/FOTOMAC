import { Camera, CircleCheck, KeyRound, Trash2, TriangleAlert } from 'lucide-react-native';
import { useState } from 'react';
import { StyleSheet, Text, View, type TextStyle } from 'react-native';

import { api, ApiError, appendFile, type Upload } from '@/api/client';
import { useAuth, type Account } from '@/auth/AuthContext';
import { failedRules, type PasswordRuleKey } from '@/auth/password-rules';
import { AccountAvatar } from '@/components/AccountAvatar';
import { PasswordRequirements } from '@/components/auth/PasswordRequirements';
import { PageHeader } from '@/components/panel/PageHeader';
import { Button, Card, Field, Input, Notice, Pill, SectionTitle } from '@/components/panel/ui';
import { fonts, panel } from '@/theme/tokens';
import { pickPhoto } from '@/components/panel/files';
import { usePhone } from '@/theme/accessibility';

function ChangePassword({ onDone }: { onDone: () => void }) {
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [failed, setFailed] = useState<PasswordRuleKey[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit() {
    const rules = failedRules(password);
    setFailed(rules);
    setError(null);
    if (!current) return setError('Informe sua senha atual.');
    if (rules.length) return setError('A nova senha ainda não atende aos requisitos.');
    if (password !== confirmation) return setError('As senhas não coincidem.');
    setSaving(true);
    try {
      await api('/auth/password/change', { body: { current_password: current, password, password_confirmation: confirmation } });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível alterar a senha.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <View style={{ gap: 14 }}>
      {error && <Notice tone="danger" icon={TriangleAlert} title={error} />}
      <Field label="Senha atual"><Input secureTextEntry value={current} onChangeText={setCurrent} autoComplete="current-password" accessibilityLabel="Senha atual" /></Field>
      <Field label="Nova senha"><Input secureTextEntry value={password} onChangeText={setPassword} autoComplete="new-password" accessibilityLabel="Nova senha" /></Field>
      <Field label="Confirmar nova senha"><Input secureTextEntry value={confirmation} onChangeText={setConfirmation} autoComplete="new-password" accessibilityLabel="Confirmar nova senha" /></Field>
      <PasswordRequirements failed={failed} />
      <Text style={styles.help}>Ao alterar a senha, as sessões abertas em outros dispositivos são encerradas.</Text>
      <View style={styles.actions}><Button label="Salvar nova senha" onPress={submit} loading={saving} /></View>
    </View>
  );
}

/** Optional profile photo (28/10/2026): instead of the initials, only if the person wants one. */
function ProfilePhoto({ account, onChange }: { account: Account; onChange: (a: Account) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The browser's file chooser, or the phone's gallery in the app (components/panel/files).
  async function choose() {
    const file = await pickPhoto();
    if (!file) return;
    const form = new FormData();
    appendFile(form, 'file', file as unknown as Upload, file.name);
    setBusy(true); setError(null);
    try { onChange(await api<Account>('/auth/me/photo', { method: 'PUT', body: form })); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'Não foi possível enviar a foto.'); }
    finally { setBusy(false); }
  }

  async function remove() {
    setBusy(true); setError(null);
    try { onChange(await api<Account>('/auth/me/photo', { method: 'DELETE' })); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'Não foi possível remover a foto.'); }
    finally { setBusy(false); }
  }

  return (
    <View style={{ alignItems: 'center', gap: 10, width: '100%' }}>
      <AccountAvatar account={account} style={styles.avatar} textStyle={styles.avatarText} />
      {error && <Notice tone="danger" icon={TriangleAlert} title={error} />}
      <View style={styles.photoActions}>
        <Button variant="secondary" icon={Camera} label={account.photo_version ? 'Trocar foto' : 'Enviar foto'} onPress={choose} loading={busy} />
        {account.photo_version && <Button variant="secondary" icon={Trash2} label="Remover" onPress={remove} disabled={busy} />}
      </View>
      <Text style={[styles.help, { textAlign: 'center' }]}>
        Opcional. Aparece para você, no topo do painel e do site, e para a administração, na lista de contas. A foto é recortada em quadrado e salva sem os dados
        do arquivo (local, câmera).
      </Text>
    </View>
  );
}

/**
 * "Meu perfil": optional profile photo, name/e-mail/role are
 * read-only (set by the administrator), and the signature keeps only the professional name —
 * the institution is added automatically to the credit.
 */
export default function ProfileScreen() {
  const phone = usePhone();
  const { account, setAccount } = useAuth();
  const [signature, setSignature] = useState(account?.photographer_signature ?? '');
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [changing, setChanging] = useState(false);

  if (!account) return null;
  // Every profile that sends photos signs them (credit): photographer, marketing, hired photographer.
  const photographer = account.role !== 'admin';
  const role = account.role_label;

  async function save() {
    setError(null); setSaved(null); setSaving(true);
    try {
      setAccount(await api<Account>('/auth/me', { method: 'PATCH', body: { photographer_signature: signature } }));
      setSaved('Assinatura atualizada.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível salvar.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeader crumbs={[{ label: 'Visão geral', href: '/painel' }, { label: 'Meu perfil' }]} title="Meu perfil" subtitle="Gerencie seus dados de conta e sua assinatura fotográfica." />
      <View style={styles.layout}>
        {/* On a phone the card takes the whole width, like the cards below it (06/11/2026). */}
        <Card padding={24} style={[styles.side, phone && { width: '100%' }]}>
          <ProfilePhoto account={account} onChange={setAccount} />
          <View style={{ alignItems: 'center', gap: 8 }}>
            <Text style={styles.name}>{account.full_name}</Text>
            <Pill label={role} />
          </View>
        </Card>
        <View style={{ flex: 1, minWidth: 300, gap: 18 }}>
          <Card padding={24} style={{ gap: 18 }}>
            <SectionTitle title="Informações pessoais" />
            {saved && <Notice tone="success" icon={CircleCheck} title={saved} />}
            {error && <Notice tone="danger" icon={TriangleAlert} title={error} />}
            {/* Plain text, not fields: none of the three can be changed here, so none may look like it waits for typing
                (30-31/10/2026: no box, no text cursor, no reaction to a click). */}
            <Field label="Nome"><Text selectable={false} style={styles.fixed}>{account.full_name}</Text></Field>
            <Field label="E-mail"><Text selectable={false} style={styles.fixed}>{account.email}</Text></Field>
            <Field label="Perfil" help="Nome, e-mail e perfil são definidos pela instituição e não podem ser editados.">
              <Text selectable={false} style={styles.fixed}>{role}</Text>
            </Field>
            {photographer && (
              <>
                <Field label="Assinatura / crédito fotográfico"
                       help={`Como aparecerá nas fotos e nos metadados: “Fotografia por: ${signature.trim() || '…'} · Centro Universitário CESMAC”.`}>
                  <Input value={signature} onChangeText={setSignature} maxLength={80} accessibilityLabel="Assinatura" />
                </Field>
                <View style={styles.actions}>
                  <Button variant="secondary" label="Cancelar" onPress={() => setSignature(account.photographer_signature ?? '')} />
                  <Button label="Salvar alterações" onPress={save} loading={saving}
                          disabled={signature.trim() === (account.photographer_signature ?? '')} />
                </View>
              </>
            )}
          </Card>
          <Card padding={24}>
            <SectionTitle title="Senha e segurança" />
            {changing ? (
              <ChangePassword onDone={() => { setChanging(false); setSaved('Senha alterada. Outros dispositivos foram desconectados.'); }} />
            ) : (
              <>
                <Text style={styles.help}>Atualize sua senha do FOTOMAC periodicamente para manter sua conta segura.</Text>
                <View style={{ alignSelf: 'flex-start' }}>
                  <Button variant="secondary" icon={KeyRound} label="Alterar senha" onPress={() => setChanging(true)} />
                </View>
              </>
            )}
          </Card>
        </View>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  layout: { flexDirection: 'row', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' },
  side: { width: 330, maxWidth: '100%', alignItems: 'center', gap: 16 },
  photoActions: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', justifyContent: 'center' },
  avatar: { width: 96, height: 96, borderRadius: 999, backgroundColor: panel.primarySoft, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontFamily: fonts.bold, fontSize: 32, color: panel.primaryText },
  name: { fontFamily: fonts.bold, fontSize: 18, color: panel.text, textAlign: 'center' },
  help: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: panel.muted },
  fixed: { fontFamily: fonts.semiBold, fontSize: 15, color: panel.text, cursor: 'default', userSelect: 'none' } as TextStyle,
  actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 12 },
});
