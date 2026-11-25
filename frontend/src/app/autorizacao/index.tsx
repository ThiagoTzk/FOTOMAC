import { Image } from '@/ui/Image';
import { useLocalSearchParams } from 'expo-router';
import { CircleCheck, ShieldCheck, TriangleAlert } from 'lucide-react-native';
import { useEffect, useState, type ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { authorizationPhotoUrl, getAuthorization, refuse, sign, type AuthorizationPage } from '@/api/institutional';
import type { SignatureValue } from '@/components/signature/SignatureInput';
import { SignBox } from '@/components/visitor/SignBox';
import { VisitorHeader } from '@/components/visitor/Header';
import { Column, Note, Sheet, useJustified, useWide, VButton, vtext } from '@/components/visitor/ui';
import { PageBand, WebPage, Wrap } from '@/components/visitor/web/Site';
import { poppins, visitor } from '@/theme/tokens';

type Step = 'loading' | 'invalid' | 'form' | 'signed' | 'refused';

/**
 * The page an institutional person opens from the e-mail: reads the term, sees the photos
 * of them that will be used, and SIGNS on the screen — or refuses. Nothing about them is processed before
 * this. The link is single use: once signed or refused, it stops working.
 */
/** "N. Title" alone (short, no final period) is a section title of the term — the same rule as
 *  term.is_heading on the server, which uses it for the PDF. */
const isHeading = (p: string) => /^\d+\. [^.]{1,60}$/.test(p);

export default function AuthorizationScreen() {
  const justified = useJustified();
  const { token } = useLocalSearchParams<{ token?: string }>();
  const [page, setPage] = useState<AuthorizationPage | null>(null);
  const [step, setStep] = useState<Step>(token ? 'loading' : 'invalid');   // no token, nothing to load
  const [signature, setSignature] = useState<SignatureValue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    if (!token) return;
    getAuthorization(token).then((p) => { setPage(p); setStep('form'); }).catch(() => setStep('invalid'));
  }, [token]);

  async function submit(value: SignatureValue) {
    setBusy(true); setError(null);
    try {
      await sign(token!, value);
      setStep('signed');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível registrar a assinatura. Tente de novo.');
    } finally {
      setBusy(false);
    }
  }

  async function decline() {
    setBusy(true); setError(null);
    try { await refuse(token!); setStep('refused'); }
    catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível registrar. Tente de novo.'); }
    finally { setBusy(false); setAsking(false); }
  }

  const title = 'Autorização de uso de imagem';
  let body: ReactNode = <Text style={vtext.body}>Carregando…</Text>;
  if (step === 'invalid') {
    body = <Note tone="danger" icon={TriangleAlert}>Link inválido, já usado ou vencido. Se você ainda não assinou, peça à administração do FOTOMAC um novo link.</Note>;
  } else if (step === 'refused') {
    body = <Note icon={CircleCheck}>Pronto: você não autorizou. O seu cadastro e as suas fotografias foram apagados do FOTOMAC.</Note>;
  } else if (step === 'signed') {
    // 24/10/2026: the revocation link is no longer on the screen; it goes to the e-mail, and the person can also
    // ask the administration, which sends the revocation term to be signed.
    body = (
      <View style={{ gap: 14 }}>
        <Note icon={CircleCheck}>Autorização assinada. Enviamos a confirmação para o seu e-mail.</Note>
        <Text style={vtext.body}>
          Para revogar quando quiser, use o link que está nesse e-mail ou peça à administração do FOTOMAC: ela envia para
          o seu e-mail o termo de revogação, que você assina pelo link.
        </Text>
      </View>
    );
  } else if (page) {
    body = (
      <View style={{ gap: 22 }}>
        <View style={{ gap: 6 }}>
          <Text style={vtext.h2}>{page.term.title}</Text>
          <Text style={vtext.small}>Versão do termo: {page.term.version} · link válido até {new Date(page.expires_at).toLocaleDateString('pt-BR')}</Text>
        </View>
        <View style={{ gap: 10 }}>
          <Text style={styles.label}>Fotografias que serão usadas para localizar você</Text>
          <View style={styles.photos}>
            {page.photos.map((id) => (
              <Image key={id} source={{ uri: authorizationPhotoUrl(token!, id) }} style={styles.photo} contentFit="cover"
                     accessibilityLabel="Fotografia de referência" />
            ))}
          </View>
        </View>
        <View style={{ gap: 10 }}>
          {page.term.paragraphs.map((p) => (isHeading(p)
            ? <Text key={p} style={[vtext.h3, { marginTop: 6 }]} accessibilityRole="header" aria-level={2}>{p}</Text>
            : <Text key={p} style={[vtext.body, justified]}>{p}</Text>))}
        </View>
        <View style={{ gap: 10 }}>
          <SignBox name={page.full_name} onChange={setSignature} />
          <Text style={styles.name}>{page.full_name} · {page.position}{page.unit ? ` · ${page.unit}` : ''}</Text>
        </View>
        {error && <Note tone="danger" icon={TriangleAlert}>{error}</Note>}
        <View style={styles.actions}>
          <VButton label="Não autorizo" variant="ghost" onPress={() => setAsking(true)} disabled={busy} />
          <VButton label="Assinar e autorizar" icon={ShieldCheck} loading={busy} disabled={!signature}
                   onPress={() => signature && submit(signature)} />
        </View>
        <Sheet visible={asking} title="Não autorizar?" onClose={() => setAsking(false)} width={420}>
          <Text style={vtext.body}>O seu cadastro e as suas fotografias serão apagados do FOTOMAC, e este link deixará de funcionar.</Text>
          <View style={styles.actions}>
            <VButton label="Voltar" variant="ghost" onPress={() => setAsking(false)} />
            <VButton label="Não autorizo" loading={busy} onPress={decline} />
          </View>
        </Sheet>
      </View>
    );
  }

  const intro = 'Pessoa institucional do Centro Universitário CESMAC: leia com atenção antes de assinar.';
  if (useWide()) {
    return (
      <WebPage>
        <PageBand crumbs={[{ label: title }]} title={title} sub={intro} />
        <Wrap style={{ paddingVertical: 48 }}><View style={styles.card}>{body}</View></Wrap>
      </WebPage>
    );
  }
  return (
    <ScrollView style={styles.page} contentContainerStyle={{ paddingBottom: 48 }}>
      <VisitorHeader back />
      <Column narrow style={{ gap: 20, marginTop: 24 }}>
        <View style={{ gap: 6 }}>
          <Text style={vtext.h1} accessibilityRole="header">{title}</Text>
          <Text style={vtext.body}>{intro}</Text>
        </View>
        {body}
      </Column>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: visitor.page },
  card: { backgroundColor: visitor.surface, borderRadius: 16, padding: 32, maxWidth: 860, alignSelf: 'center', width: '100%',
          boxShadow: visitor.cardShadow },
  label: { fontFamily: poppins.semiBold, fontSize: 15, color: visitor.heading },
  photos: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  photo: { width: 104, height: 130, borderRadius: 10, backgroundColor: visitor.page },
  name: { fontFamily: poppins.regular, fontSize: 14, color: visitor.text },
  link: { color: visitor.primary },
  actions: { flexDirection: 'row', gap: 12, justifyContent: 'flex-end', flexWrap: 'wrap' },
});
