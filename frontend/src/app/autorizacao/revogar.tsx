import { useLocalSearchParams } from 'expo-router';
import { CircleCheck, ShieldOff, TriangleAlert } from 'lucide-react-native';
import { useEffect, useState, type ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { getRevocation, revoke } from '@/api/institutional';
import { VisitorHeader } from '@/components/visitor/Header';
import type { SignatureValue } from '@/components/signature/SignatureInput';
import { SignBox } from '@/components/visitor/SignBox';
import { Column, Note, useJustified, useWide, VButton, vtext } from '@/components/visitor/ui';
import { PageBand, WebPage, Wrap } from '@/components/visitor/web/Site';
import { visitor } from '@/theme/tokens';

type Info = Awaited<ReturnType<typeof getRevocation>>;

/**
 * Revocation by the person (LGPD Art. 8 §5: free, at any time, without a reason), from the link received when
 * signing or from the revocation term the administration sent at their request. Signed on the screen, like the
 * authorization. At once: reference photos, facial data and every mark are eliminated.
 */
export default function RevocationScreen() {
  const justified = useJustified();
  const { token } = useLocalSearchParams<{ token?: string }>();
  const [info, setInfo] = useState<Info | null>(null);
  const [invalid, setInvalid] = useState(!token);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [signature, setSignature] = useState<SignatureValue | null>(null);

  useEffect(() => {
    if (!token) return;
    getRevocation(token).then(setInfo).catch(() => setInvalid(true));
  }, [token]);

  async function confirm() {
    setBusy(true); setError(null);
    try {
      const r = await revoke(token!, signature!);
      setInfo((i) => (i ? { ...i, status: 'revoked', revoked_at: r.revoked_at } : i));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível revogar. Tente de novo.');
    } finally {
      setBusy(false);
    }
  }

  let body: ReactNode = <Text style={vtext.body}>Carregando…</Text>;
  if (invalid) body = <Note tone="danger" icon={TriangleAlert}>Link de revogação inválido.</Note>;
  else if (info?.status === 'revoked') {
    body = (
      <Note icon={CircleCheck}>
        Autorização revogada{info.revoked_at ? ` em ${new Date(info.revoked_at).toLocaleString('pt-BR')}` : ''}. As suas fotografias de
        referência, o vetor facial e todas as marcações foram eliminados. O termo assinado fica guardado apenas como prova.
      </Note>
    );
  } else if (info) {
    body = (
      <View style={{ gap: 16 }}>
        <Text style={vtext.h3} accessibilityRole="header" aria-level={2}>Termo de revogação</Text>
        <Text style={[vtext.body, justified]}>
          Eu, {info.full_name}, revogo a autorização de uso de imagem, de reconhecimento facial e de divulgação que assinei
          {info.authorized_at ? ` em ${new Date(info.authorized_at).toLocaleDateString('pt-BR')}` : ''}. A partir de agora, o FOTOMAC
          deixa de me localizar nas fotografias dos eventos, e o que foi guardado para isso (fotografias de referência, dados
          faciais e marcações) é eliminado na hora, sem volta. Não é preciso justificar. O que já foi publicado antes desta
          revogação não é desfeito.
        </Text>
        {/* Signed like the authorization (24/10/2026): the signature is the proof that the person asked. */}
        <SignBox name={info.full_name} onChange={setSignature} />
        {error && <Note tone="danger" icon={TriangleAlert}>{error}</Note>}
        <View style={{ alignSelf: 'flex-end' }}>
          <VButton label="Assinar e revogar" icon={ShieldOff} loading={busy} disabled={!signature} onPress={confirm} />
        </View>
      </View>
    );
  }

  const title = 'Revogar autorização';
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
