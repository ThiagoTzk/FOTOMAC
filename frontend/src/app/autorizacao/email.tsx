import { useLocalSearchParams } from 'expo-router';
import { CircleCheck, MailCheck, TriangleAlert } from 'lucide-react-native';
import { useEffect, useState, type ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { confirmEmailChange, getEmailChange } from '@/api/institutional';
import { VisitorHeader } from '@/components/visitor/Header';
import type { SignatureValue } from '@/components/signature/SignatureInput';
import { SignBox } from '@/components/visitor/SignBox';
import { Column, Note, useJustified, useWide, VButton, vtext } from '@/components/visitor/ui';
import { PageBand, WebPage, Wrap } from '@/components/visitor/web/Site';
import { visitor } from '@/theme/tokens';

type Info = Awaited<ReturnType<typeof getEmailChange>>;

/**
 * New e-mail of an institutional person (24/10/2026). The administrator asked for the change; it only happens
 * when the person signs here, at the link sent to the NEW address — the e-mail is where the revocation link and
 * every notice go. The authorization itself does not change.
 */
export default function EmailChangeScreen() {
  const justified = useJustified();
  const { token } = useLocalSearchParams<{ token?: string }>();
  const [info, setInfo] = useState<Info | null>(null);
  const [invalid, setInvalid] = useState(!token);
  const [done, setDone] = useState<string | null>(null);
  const [signature, setSignature] = useState<SignatureValue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) return;
    getEmailChange(token).then(setInfo).catch(() => setInvalid(true));
  }, [token]);

  async function confirm() {
    setBusy(true); setError(null);
    try { setDone((await confirmEmailChange(token!, signature!)).email); }
    catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível confirmar. Tente de novo.'); }
    finally { setBusy(false); }
  }

  let body: ReactNode = <Text style={vtext.body}>Carregando…</Text>;
  if (done) body = <Note icon={CircleCheck}>Pronto: o e-mail da sua autorização agora é {done}. A autorização continua valendo nos mesmos termos.</Note>;
  else if (invalid) body = <Note tone="danger" icon={TriangleAlert}>Link inválido, já usado ou vencido. Peça à administração do FOTOMAC um novo link.</Note>;
  else if (info) {
    body = (
      <View style={{ gap: 16 }}>
        <Text style={vtext.h3} accessibilityRole="header" aria-level={2}>Confirmação de troca de e-mail</Text>
        <Text style={[vtext.body, justified]}>
          Eu, {info.full_name}, confirmo que o meu e-mail institucional passou de {info.old_email} para {info.new_email}. A
          autorização de uso de imagem, de reconhecimento facial e de divulgação que assinei em{' '}
          {new Date(info.authorized_at).toLocaleDateString('pt-BR')} continua valendo nos mesmos termos, e os avisos e o link de
          revogação passam a ir para o novo endereço.
        </Text>
        <SignBox name={info.full_name} onChange={setSignature} />
        {error && <Note tone="danger" icon={TriangleAlert}>{error}</Note>}
        <View style={{ alignSelf: 'flex-end' }}>
          <VButton label="Assinar e confirmar" icon={MailCheck} loading={busy} disabled={!signature} onPress={confirm} />
        </View>
        <Text style={vtext.small}>Se você não pediu esta troca, feche esta página: nada muda.</Text>
      </View>
    );
  }

  const title = 'Confirmar novo e-mail';
  if (useWide()) {
    return (
      <WebPage>
        <PageBand crumbs={[{ label: title }]} title={title} sub="Pessoa institucional do Centro Universitário CESMAC." />
        <Wrap style={{ paddingVertical: 48 }}><View style={styles.card}>{body}</View></Wrap>
      </WebPage>
    );
  }
  return (
    <ScrollView style={styles.page} contentContainerStyle={{ paddingBottom: 48 }}>
      <VisitorHeader back />
      <Column narrow style={{ gap: 20, marginTop: 24 }}>
        <Text style={vtext.h1} accessibilityRole="header">{title}</Text>
        {body}
      </Column>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: visitor.page },
  card: { backgroundColor: visitor.surface, borderRadius: 16, padding: 32, maxWidth: 760, alignSelf: 'center', width: '100%',
          boxShadow: visitor.cardShadow },
});
