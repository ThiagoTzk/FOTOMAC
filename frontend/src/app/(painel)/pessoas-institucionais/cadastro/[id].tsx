import { Image } from '@/ui/Image';
import { router, useLocalSearchParams } from 'expo-router';
import {
  CircleCheck, Copy, FileDown, FileSignature, Images, Link2, Mail, Pencil, RefreshCw, ScanFace, ShieldOff, Trash2, TriangleAlert,
} from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, View } from 'react-native';

import { emailProblem } from '@/auth/email-rules';
import { formatDateTime } from '@/api/images';
import {
  changeEmail, deletePerson, devLink, endAuthorization, formUrl, getPerson, personPhotoUrl, rescan, resendLink, sendRevocationRequest,
  signatureUrl, updatePerson, type PersonDetail,
} from '@/api/institutional';
import { ChangedTag } from '@/components/panel/ChangedTag';
import { SIGNATURE_FONTS } from '@/components/signature/fonts';
import { STATUS_PILL } from '@/components/admin/institutional';
import { Modal } from '@/components/panel/Modal';
import { PageHeader } from '@/components/panel/PageHeader';
import { Button, Card, Field, InfoItem, Input, Notice, Pill, SectionTitle } from '@/components/panel/ui';
import { fonts, panel } from '@/theme/tokens';
import { saveFile } from '@/ui/saveFile';

/**
 * One institutional registration, for the administrator: data, reference photos, the signature
 * as drawn by the person, the proof of the signature and the official copy in PDF.
 */
export default function InstitutionalPersonScreen() {
  const { id, link: sentLink } = useLocalSearchParams<{ id: string; link?: string }>();
  const [p, setP] = useState<PersonDetail | null>(null);
  const [error, setError] = useState<string | null>(sentLink === 'sem-email' ? 'Cadastro salvo, mas o e-mail com o link não pôde ser enviado agora: o servidor de e-mail não respondeu. Use “Reenviar link” em alguns minutos.' : null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<'end' | 'delete' | 'revocation' | null>(null);
  const [editing, setEditing] = useState<{ full_name: string; position: string; unit: string } | null>(null);
  const [newEmail, setNewEmail] = useState<string | null>(null);   // the "Trocar e-mail" box, open
  const [newEmailError, setNewEmailError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null); // TEMPORÁRIO — remover antes da implantação

  const load = useCallback(() => getPerson(id).then(setP).catch((e) => setError(e.message)), [id]);
  useEffect(() => { void load(); }, [load]);
  // While the collection is being searched, follow it.
  useEffect(() => {
    if (p?.scan_status !== 'pending') return;
    const t = setTimeout(() => void load(), 2500);
    return () => clearTimeout(t);
  }, [p, load]);

  async function run(action: () => Promise<unknown>, message: string) {
    setBusy(true); setError(null); setDone(null);
    try { await action(); setDone(message); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível concluir.'); }
    finally { setBusy(false); setConfirm(null); }
  }
  async function save(personId: string, data: { full_name: string; position: string; unit: string }) {
    setBusy(true); setError(null); setDone(null);
    try {
      setP(await updatePerson(personId, { ...data, unit: data.unit.trim() || null }));
      setEditing(null); setDone('Dados corrigidos. O termo assinado não muda: ele guarda os dados da data da assinatura.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível salvar.'); } finally { setBusy(false); }
  }
  async function sendEmail(personId: string, email: string, signed: boolean) {
    setBusy(true); setError(null); setDone(null);
    try {
      setP(await changeEmail(personId, email));
      setNewEmail(null);
      setDone(signed ? `Enviamos para ${email} o pedido de confirmação. O e-mail só troca quando a pessoa assinar.`
        : `E-mail trocado. O link de autorização foi enviado para ${email}; o anterior deixou de funcionar.`);
    } catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível trocar o e-mail.'); } finally { setBusy(false); }
  }

  // The id is a PARAMETER (React Compiler: never read `p` inside a memoized function).
  function downloadForm(personId: string) {
    saveFile(formUrl(personId), 'Salvar termo').catch(() => undefined);   // the site: the browser saves it; the app: Salvar/Compartilhar
  }

  if (!p) return error ? <Notice tone="danger" icon={TriangleAlert} title={error} /> : <Card><ActivityIndicator color={panel.primary} /></Card>;
  const pill = STATUS_PILL[p.status];
  const expired = p.status === 'awaiting' && p.link_expires_at && new Date(p.link_expires_at) < new Date();
  return (
    <View style={{ gap: 20 }}>
      <PageHeader crumbs={[{ label: 'Pessoas institucionais', href: '/pessoas-institucionais' },
                           { label: 'Cadastro', href: '/pessoas-institucionais/cadastro' }, { label: p.full_name }]}
                  title={p.full_name} badge={<Pill label={p.status_label} bg={pill.bg} fg={pill.fg} />}
                  subtitle={`${p.position}${p.unit ? ` · ${p.unit}` : ''}`}
                  actions={(
                    <>
                      {p.signed && <Button variant="secondary" icon={FileDown} label="Baixar formulário (PDF)" onPress={() => downloadForm(p.id)} />}
                      {p.status === 'active' && (
                        <Button icon={Images} label="Ver fotos" onPress={() => router.navigate(`/pessoas-institucionais/${p.id}`)} />)}
                    </>)} />
      {error && <Notice tone="danger" icon={TriangleAlert} title={error} />}
      {done && <Notice tone="success" icon={CircleCheck} title={done} />}

      {p.status === 'awaiting' && (
        <Notice tone="warning" icon={Mail} title={expired ? 'O link de autorização venceu' : 'Aguardando a assinatura da pessoa'}
                description={`O termo foi enviado para ${p.email}${p.link_expires_at ? `; o link ${expired ? 'venceu' : 'vale até'} ${formatDateTime(p.link_expires_at)}` : ''}. Até a assinatura, as fotos não são processadas. Sem assinatura em 30 dias, o cadastro é apagado.`}
                actionLabel="Reenviar link" onAction={() => run(() => resendLink(p.id), 'Link reenviado. O anterior deixou de funcionar.')} />
      )}
      {/* TEMPORÁRIO — REMOVER ANTES DA IMPLANTAÇÃO: link à mostra só em desenvolvimento, enquanto não há e-mail real. */}
      {p.dev_link_available && (
        <View style={styles.devBox}>
          <Text style={styles.devTag}>SÓ DEMONSTRAÇÃO · REMOVER ANTES DA IMPLANTAÇÃO</Text>
          <Text style={styles.text}>Gera um link novo (o anterior para de funcionar) e mostra aqui, para abrir numa janela anônima e assinar como a pessoa.</Text>
          <View style={styles.actions}>
            <Button label="Mostrar link" variant="secondary" icon={Link2} loading={busy}
                    onPress={() => { setError(null); devLink(p.id).then((r) => setLink(r.url)).catch((e) => setError(e.message)); }} />
            {link && Platform.OS === 'web' && (
              <Button label="Copiar" variant="secondary" icon={Copy}
                      onPress={() => { void navigator.clipboard?.writeText(link); setDone('Link copiado.'); }} />)}
          </View>
          {link && <Text selectable style={styles.devLink}>{link}</Text>}
        </View>
      )}
      {/* FIM DO TRECHO TEMPORÁRIO */}
      {p.status === 'active' && p.scan_status === 'pending' && (
        <Notice tone="info" icon={ScanFace} title="Procurando esta pessoa no acervo publicado…"
                description="A busca percorre todos os eventos publicados. As fotos novas são comparadas sozinhas quando publicadas." />
      )}
      {p.pending_email && (
        <Notice tone="warning" icon={Mail} title={`Aguardando a pessoa confirmar o novo e-mail: ${p.pending_email}`}
                description={`Enquanto ela não assinar a confirmação pelo link enviado ao novo endereço, os avisos continuam indo para ${p.email}.`} />
      )}
      {p.status === 'active' && p.revoke_requested_at && (
        <Notice tone="warning" icon={FileSignature} title={`Termo de revogação enviado em ${formatDateTime(p.revoke_requested_at)}`}
                description="Aguardando a pessoa assinar pelo link do e-mail. Ao assinar, os dados de reconhecimento são apagados na hora." />
      )}
      {p.status === 'revoked' && (
        <Notice tone="info" icon={ShieldOff} title={`Autorização revogada em ${formatDateTime(p.revoked_at!)}${p.revoked_by === 'holder' ? ', pela própria pessoa' : ', pela administração'}`}
                description="As fotografias de referência, o vetor facial e todas as marcações foram eliminados. O termo assinado fica guardado como prova." />
      )}

      <Card padding={24} style={{ gap: 16 }}>
        <SectionTitle title="Dados" action={p.status !== 'revoked' && !editing ? (
          <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
            <Button variant="secondary" icon={Pencil} label="Editar dados"
                    onPress={() => setEditing({ full_name: p.full_name, position: p.position, unit: p.unit ?? '' })} />
            <Button variant="secondary" icon={Mail} label="Trocar e-mail" onPress={() => setNewEmail('')} />
          </View>) : undefined} />
        {editing ? (
          <View style={{ gap: 14 }}>
            <Text style={styles.text}>
              Para corrigir o nome (inclusive para o nome social), o cargo ou a unidade. CPF e outros dados não existem aqui. A
              correção vale para as próximas fotos baixadas com o nome; o termo assinado guarda os dados da data da assinatura.
            </Text>
            <Field label="Nome completo *"><Input value={editing.full_name} maxLength={120} accessibilityLabel="Nome completo"
                                                 onChangeText={(t) => setEditing({ ...editing, full_name: t })} /></Field>
            <Field label="Cargo ou função *"><Input value={editing.position} maxLength={100} accessibilityLabel="Cargo ou função"
                                                   onChangeText={(t) => setEditing({ ...editing, position: t })} /></Field>
            <Field label="Unidade ou curso"><Input value={editing.unit} maxLength={100} accessibilityLabel="Unidade ou curso"
                                                  onChangeText={(t) => setEditing({ ...editing, unit: t })} /></Field>
            <View style={styles.actions}>
              <Button variant="secondary" label="Cancelar" onPress={() => setEditing(null)} />
              <Button label="Salvar correção" loading={busy} onPress={() => save(p.id, editing)} />
            </View>
          </View>
        ) : (
          <View style={styles.grid}>
            <Data label="Nome completo" value={p.full_name} changed={p.name_changed_at} />
            <Data label="Cargo ou função" value={p.position} changed={p.position_changed_at} />
            <Data label="Unidade ou curso" value={p.unit ?? 'Não informada'} changed={p.unit_changed_at} />
            <Data label="E-mail" value={p.email} changed={p.email_changed_at} />
            <InfoItem label="Cadastrada em" value={formatDateTime(p.created_at)} style={styles.cell} />
            {p.status === 'active' && (
              <InfoItem label="Fotos localizadas" value={`${p.marks.confirmed} confirmadas · ${p.marks.pending} a confirmar · ${p.marks.rejected} rejeitadas`} style={styles.cell} />)}
          </View>
        )}
      </Card>

      {p.photos.length > 0 && (
        <Card padding={24} style={{ gap: 14 }}>
          <SectionTitle title="Fotografias de referência" />
          <View style={styles.photos}>
            {p.photos.map((ph, i) => (
              <View key={ph.id} style={{ gap: 6 }}>
                <Image source={{ uri: personPhotoUrl(p.id, ph.id) }} style={styles.photo} contentFit="cover"
                       accessibilityLabel={`Foto de referência ${i + 1} de ${p.full_name}`} />
                {ph.faces_found !== null && (
                  <Text style={[styles.small, ph.faces_found === 0 && { color: panel.danger }]}>
                    {ph.faces_found === 0 ? 'Nenhum rosto encontrado' : 'Rosto encontrado'}</Text>)}
              </View>
            ))}
          </View>
        </Card>
      )}

      {p.signed && (
        <Card padding={24} style={{ gap: 14 }}>
          <SectionTitle title="Assinatura eletrônica" />
          <View style={styles.signature}>
            <Image source={{ uri: signatureUrl(p.id) }} style={styles.signatureImg} contentFit="contain"
                   accessibilityLabel={`Assinatura de ${p.full_name}`} />
            <View style={styles.signatureLine} />
            <Text style={styles.value}>{p.full_name}</Text>
          </View>
          <View style={styles.grid}>
            <InfoItem label="Assinado em" value={formatDateTime(p.authorized_at!)} style={styles.cell} />
            <InfoItem label="Versão do termo" value={p.term_version ?? 'Ainda não assinado'} style={styles.cell} />
            <InfoItem label="Forma da assinatura" style={styles.cell}
                      value={(() => {
                        const style = SIGNATURE_FONTS.find((f) => f.family === p.signature_font)?.label;
                        if (p.signature_kind === 'typed') return `Digitada${style ? ` (estilo ${style})` : ''}`;
                        if (p.signature_kind === 'initials') return `Rubrica${style ? ` digitada (estilo ${style})` : ' desenhada'}`;
                        return 'Desenhada';
                      })()} />
            <InfoItem label="Endereço de rede (IP)" value={p.authorized_ip ?? 'Não registrado'} style={styles.cell} />
          </View>
          <InfoItem label="Código de verificação (SHA-256)" value={p.document_sha256 ?? 'Ainda não assinado'} />
          <Text style={styles.small}>
            Assinatura feita na tela pela própria pessoa, a partir do link de uso único enviado ao e-mail institucional. O código de
            verificação muda se qualquer palavra do termo, foto de referência ou traço da assinatura for alterado.
          </Text>
        </Card>
      )}

      <View style={styles.actions}>
        {p.status === 'awaiting' && <Button variant="danger" icon={Trash2} label="Excluir cadastro" onPress={() => setConfirm('delete')} />}
        {p.status === 'active' && (
          <>
            <Button variant="secondary" icon={RefreshCw} label="Procurar de novo no acervo"
                    onPress={() => run(() => rescan(p.id), 'A busca no acervo vai ser refeita.')} />
            <Button variant="secondary" icon={FileSignature} label="Enviar termo de revogação" onPress={() => setConfirm('revocation')} />
            <Button variant="danger" icon={ShieldOff} label="Encerrar autorização" onPress={() => setConfirm('end')} />
          </>
        )}
      </View>

      <Modal visible={confirm === 'end'} onClose={() => setConfirm(null)} icon={ShieldOff} tone="danger" title="Encerrar a autorização?" width={520}>
        <Text style={styles.text}>
          Use na revisão anual ou quando a pessoa deixar a função. As fotografias de referência, o vetor facial e todas as marcações
          são eliminados na hora, sem volta. O termo assinado fica guardado como prova.
        </Text>
        <View style={styles.actions}>
          <Button variant="secondary" label="Cancelar" onPress={() => setConfirm(null)} />
          <Button variant="danger" label="Encerrar autorização" loading={busy}
                  onPress={() => run(() => endAuthorization(p.id), 'Autorização encerrada; dados biométricos eliminados.')} />
        </View>
      </Modal>
      <Modal visible={confirm === 'revocation'} onClose={() => setConfirm(null)} icon={FileSignature} title="Enviar o termo de revogação?" width={540}>
        <Text style={styles.text}>
          Use quando a própria pessoa pedir para revogar. O termo de revogação vai para {p.email}, e ela assina pelo link. Só então as
          fotografias de referência, os dados faciais e as marcações são apagados. O link de revogação que ela já recebeu continua
          funcionando.
        </Text>
        <Text style={styles.text}>Se a pessoa deixou a função e não vai assinar nada, use “Encerrar autorização”.</Text>
        <View style={styles.actions}>
          <Button variant="secondary" label="Cancelar" onPress={() => setConfirm(null)} />
          <Button label="Enviar termo" icon={FileSignature} loading={busy}
                  onPress={() => run(() => sendRevocationRequest(p.id), `Termo de revogação enviado para ${p.email}.`)} />
        </View>
      </Modal>
      <Modal visible={newEmail !== null} onClose={() => setNewEmail(null)} icon={Mail} title="Trocar o e-mail" width={540}>
        <Text style={styles.text}>
          {p.signed
            ? 'A pessoa recebe no novo endereço um pedido para confirmar a troca, assinando pelo link. Até lá, o e-mail atual continua valendo, e ele é avisado do pedido.'
            : 'Ainda não há assinatura: o e-mail é trocado agora e o link de autorização vai para o novo endereço (o anterior deixa de funcionar).'}
        </Text>
        <Field label="Novo e-mail institucional *" help="Do domínio @cesmac.edu.br (ou um subdomínio)."
               error={newEmailError ?? undefined}>
          <Input value={newEmail ?? ''} onChangeText={(t) => { setNewEmail(t); setNewEmailError(null); }} invalid={!!newEmailError} inputMode="email" autoCapitalize="none" maxLength={254}
                 accessibilityLabel="Novo e-mail institucional" />
        </Field>
        <View style={styles.actions}>
          <Button variant="secondary" label="Cancelar" onPress={() => setNewEmail(null)} />
          <Button label={p.signed ? 'Enviar pedido de confirmação' : 'Trocar e-mail'} loading={busy} disabled={!newEmail?.trim()}
                  onPress={() => {
                    // Says at once what is wrong with the address; the server checks it again.
                    const wrong = emailProblem(newEmail!.trim());
                    setNewEmailError(wrong);
                    if (!wrong) sendEmail(p.id, newEmail!.trim(), p.signed);
                  }} />
        </View>
      </Modal>
      <Modal visible={confirm === 'delete'} onClose={() => setConfirm(null)} icon={Trash2} tone="danger" title="Excluir o cadastro?" width={520}>
        <Text style={styles.text}>A pessoa ainda não assinou: o cadastro e as fotos são apagados e o link deixa de funcionar.</Text>
        <View style={styles.actions}>
          <Button variant="secondary" label="Cancelar" onPress={() => setConfirm(null)} />
          <Button variant="danger" label="Excluir cadastro" loading={busy}
                  onPress={() => run(() => deletePerson(p.id), 'Cadastro excluído.').then(() => router.replace('/pessoas-institucionais/cadastro'))} />
        </View>
      </Modal>
    </View>
  );
}

/** A piece of data with "alterado" (and when, on hover) if it was corrected after the registration. */
function Data({ label, value, changed }: { label: string; value: string; changed: string | null }) {
  return (
    <View style={[styles.cell, { gap: 4 }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, zIndex: 2 }}>
        <Text style={styles.label}>{label}</Text>
        <ChangedTag at={changed} />
      </View>
      <Text style={styles.value}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  label: { fontFamily: fonts.bold, fontSize: 12, color: panel.muted },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 16 },
  cell: { flexBasis: 220, flexGrow: 1 },
  photos: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  photo: { width: 120, height: 150, borderRadius: 10, backgroundColor: panel.page },
  signature: { alignSelf: 'flex-start', gap: 6, paddingVertical: 8 },
  signatureImg: { width: 320, height: 107 },
  signatureLine: { height: 1, backgroundColor: panel.text, width: 320 },
  value: { fontFamily: fonts.regular, fontSize: 14, color: panel.text },
  text: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 21, color: panel.muted },
  small: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 17, color: panel.muted },
  actions: { flexDirection: 'row', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' },
  // TEMPORÁRIO — remover junto com o link de demonstração.
  devBox: { gap: 10, padding: 14, borderRadius: 10, borderWidth: 1, borderStyle: 'dashed', borderColor: panel.warning, backgroundColor: panel.warningSoft },
  devTag: { fontFamily: fonts.bold, fontSize: 11, letterSpacing: 0.6, color: panel.warning },
  devLink: { fontFamily: fonts.regular, fontSize: 13, color: panel.text, backgroundColor: panel.surface, padding: 10, borderRadius: 8 },
});
