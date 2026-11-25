import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Image } from '@/ui/Image';
import { Baby, Clock, Eye, Trash2, TriangleAlert, Undo2 } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { cancelDeletion, coverUrl, getEvent, isoToBr, requestDeletion, type EventItem } from '@/api/events';
import { EventPlace } from '@/components/map/EventPlace';
import { EventProgress } from '@/components/panel/EventProgress';
import { EventSettings } from '@/components/panel/EventSettings';
import { AccessEnded } from '@/components/panel/AccessEnded';
import { AskCollaboration } from '@/components/panel/CollaborationRequests';
import { EventTabs } from '@/components/panel/EventTabs';
import { Modal } from '@/components/panel/Modal';
import { useAuth } from '@/auth/AuthContext';
import { MONTH_NAMES } from '@/components/panel/dates';
import { PageHeader } from '@/components/panel/PageHeader';
import { Button, Card, InfoItem, Notice, SectionTitle, StatusPill, statusLabel } from '@/components/panel/ui';
import { fonts, panel } from '@/theme/tokens';

function longDate(e: EventItem) {
  if (e.date_precision !== 'day') return e.date_label;
  const [y, m, d] = e.date_start.split('-').map(Number);
  return `${d} de ${MONTH_NAMES[m - 1].toLowerCase()} de ${y}`;
}

/** An event: its data, its progress and its settings ("Configuração"). */
export default function EventDetailsScreen() {
  const { id, aba } = useLocalSearchParams<{ id: string; aba?: string }>();
  const [event, setEvent] = useState<EventItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  // In the URL: Imagens links back to a tab ("colaboracao" is the old name, kept for links already open).
  const tab = aba === 'configuracao' || aba === 'colaboracao' ? 'info' : 'overview';
  const [restored, setRestored] = useState(false);            // deletion just undone: event left unpublished
  const [saving, setSaving] = useState(false);
  const { account } = useAuth();
  const [deleting, setDeleting] = useState<string | null>(null);  // the date the photos would go, if confirmed now

  useFocusEffect(useCallback(() => { getEvent(id).then(setEvent).catch((e) => setError(e.message)); }, [id]));

  if (error) return <Notice tone="danger" icon={TriangleAlert} title="Evento indisponível" description={error} />;
  if (!event) return <Card><ActivityIndicator color={panel.primary} /></Card>;

  const viewer = event.relation === 'viewer';           // marketing on someone else's published event
  const contractor = event.relation === 'contractor';   // hired photographer, temporary account
  const outsider = event.relation === 'outsider';       // found in the list, does not work on it: summary only
  const scheduled = !!event.deletion_due_at;          // "Excluir evento" asked: out of the site, can be undone
  const toImages = (filter?: string) => router.navigate(`/eventos/${event.id}/imagens${filter ? `?filtro=${filter}` : ''}`);
  const dueLabel = (iso: string) => new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

  async function confirmDeletion() {
    setSaving(true);
    try { setEvent(await requestDeletion(event!.id)); setDeleting(null); } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível excluir.'); setDeleting(null);
    } finally { setSaving(false); }
  }
  async function undoDeletion() {
    setSaving(true);
    try { setEvent(await cancelDeletion(event!.id)); setRestored(true); } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível desfazer.');
    } finally { setSaving(false); }
  }
  const photographers = event.collaborators.length
    ? event.collaborators.map((c) => c.signature).join(', ')
    : event.owner.full_name;

  return (
    <>
      <PageHeader crumbs={[{ label: 'Eventos', href: '/eventos' }, { label: event.name }]} title={event.name}
                  badge={<StatusPill status={event.status} deleting={scheduled} />}
                  actions={event.status !== 'expired' ? (
                    <>
                      {event.can_manage && !scheduled && <Button variant="secondary" label="Editar evento" onPress={() => router.navigate(`/eventos/${event.id}/editar`)} />}
                      {event.can_manage && !scheduled && <Button variant="danger" icon={Trash2} label="Excluir evento"
                                                                    onPress={() => setDeleting(new Date(Date.now() + event.deletion_grace_days * 86400000).toLocaleDateString('pt-BR'))} />}
                    </>) : undefined} />
      {/* Sending and publishing images live in the Imagens tab; the overview keeps what is about the
          event itself — edit and delete (17/10/2026). */}
      <EventTabs event={event} value={tab} />

      {/* The notices come first (31/10/2026: nothing important at the end of the page). */}
      {tab === 'overview' && (
        <>
          {/* 01/11/2026: ask the responsible to collaborate (or to accept RAW), and the answer. */}
          {!event.can_manage && <AskCollaboration event={event} onEvent={setEvent} />}
          {event.failed > 0 && !viewer && (
            <Notice tone="danger" icon={TriangleAlert}
                    title={`Erro em ${event.failed} ${event.failed === 1 ? 'imagem' : 'imagens'}`}
                    description={event.failed === 1
                      ? 'O processamento de rostos desta imagem falhou: ela está publicada, mas ninguém a encontra pela busca facial. Abra para ver o erro e tentar de novo.'
                      : 'O processamento de rostos destas imagens falhou: elas estão publicadas, mas ninguém as encontra pela busca facial. Abra para ver os erros e tentar de novo.'}
                    actionLabel="Ver os erros" onAction={() => toImages('failed')} />
          )}
          {scheduled && (
            <Notice tone="danger" icon={Trash2} title={`Exclusão agendada para ${dueLabel(event.deletion_due_at!)}`}
                    description="O evento já saiu do site e os dados de reconhecimento facial foram apagados. Até a data acima as fotos continuam guardadas e a exclusão pode ser desfeita: o evento volta despublicado, para você conferir e publicar de novo. Depois, tudo é eliminado definitivamente."
                    actionLabel={event.can_manage ? 'Desfazer exclusão' : undefined} onAction={event.can_manage ? undoDeletion : undefined} />
          )}
          {restored && !scheduled && event.status === 'editing' && (
            <Notice tone="warning" icon={Undo2} title="Exclusão desfeita: o evento não está publicado"
                    description="As imagens voltaram para a conferência e o evento não aparece no site. Confira, exclua o que não deve voltar e publique de novo: só então o evento volta ao site e os rostos são indexados outra vez."
                    actionLabel="Conferir e publicar" onAction={() => toImages('in_review')} />
          )}
          {viewer && (
            <Notice tone="info" icon={Eye} title="Só visualização"
                    description="Você vê as imagens publicadas deste evento para escolher o que divulgar e pode baixá-las, uma a uma ou em pacote, sem marca d'água e com o aviso de propriedade do CESMAC no arquivo. As imagens em conferência e as que tiveram remoção pedida não aparecem. Cada download fica registrado."
                    actionLabel="Ir para Imagens" onAction={() => toImages()} />
          )}
          <AccessEnded event={event} />
          {/* 04/11/2026: who declared the guardians' authorisation and where the terms are, for the whole team. */}
          {event.has_children && (
            <Notice tone="info" icon={Baby} title="Este evento contém imagens com crianças"
                    description={`O visitante também vê este aviso. ${event.children_declared_by ? `Autorização dos responsáveis declarada por ${event.children_declared_by}` : 'Autorização dos responsáveis declarada'}${event.children_declared_at ? ` em ${new Date(event.children_declared_at).toLocaleDateString('pt-BR')}` : ''}. Termos: ${event.children_authorization_ref ?? 'não informado'}. Para borrar o rosto de uma criança, abra a imagem e use “Borrar rostos”.`} />
          )}
          {contractor && account?.valid_until && (
            <Notice tone="warning" icon={Clock}
                    title={`Conta temporária: vale até ${new Date(account.valid_until).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}`}
                    description="Você vê e gerencia só as imagens que enviou. Elas são publicadas depois da aprovação da administração, com o seu crédito."
                    actionLabel="Ir para Imagens" onAction={() => toImages()} />
          )}
          {account?.role === 'admin' && event.approvals_pending > 0 && (
            <Notice tone="warning" icon={Clock}
                    title={`${event.approvals_pending} ${event.approvals_pending === 1 ? 'imagem aguarda' : 'imagens aguardam'} a sua aprovação`}
                    description="Enviadas por fotógrafo contratado. Só entram na publicação depois de aprovadas."
                    actionLabel="Revisar" onAction={() => toImages('pending_approval')} />
          )}
          {account?.role === 'admin' && event.video_approvals_pending > 0 && (
            <Notice tone="warning" icon={Clock}
                    title={`${event.video_approvals_pending} ${event.video_approvals_pending === 1 ? 'vídeo aguarda' : 'vídeos aguardam'} a sua aprovação`}
                    description="Enviados por fotógrafo contratado. Só entram na publicação depois de aprovados."
                    actionLabel="Revisar" onAction={() => router.navigate(`/eventos/${event.id}/videos?filtro=pending_approval`)} />
          )}
          {/* 02/11/2026: everything on one page. Photo and progress on the left, the details on the right. */}
          <View style={styles.summary}>
            <View style={styles.side}>
              <Card padding={12}>
                <Image source={{ uri: coverUrl(event.id) }} style={styles.cover} contentFit="cover"
                       accessibilityLabel={`Capa do evento ${event.name}`} />
              </Card>
              {/* D1 (17/10/2026): one card with the steps of the event instead of a pile of notices. */}
              {!viewer && !contractor && !outsider && !scheduled && <EventProgress event={event} style={{ flexGrow: 1 }} />}
            </View>
            <Card padding={20} style={styles.infoCard}>
              <SectionTitle title="Detalhes do Evento" />
              <InfoItem label="Nome" value={event.name} />
              <View style={styles.infoRow}>
                <InfoItem label="Temas" value={event.themes.map((t) => t.name).join(' · ')} style={styles.cell} />
                <InfoItem label="Data" value={longDate(event)} style={styles.cell} />
                <InfoItem label="Local" value={event.location} style={styles.cell} />
              </View>
              <InfoItem label="Descrição" value={event.description} />
              <EventPlace latitude={event.latitude} longitude={event.longitude} note={event.location_note}
                          textColor={panel.text} fontFamily={fonts.regular} mapHeight={240} />
              <View style={styles.divider} />
              <View style={styles.infoRow}>
                <InfoItem label={event.collaborators.length > 1 ? 'Fotógrafos' : 'Fotógrafo'} value={photographers} style={styles.cell} />
                <InfoItem label="Criado por" value={`${event.owner.full_name}${event.owner.team ? ` (${event.owner.team})` : ''}`} style={styles.cell} />
                <InfoItem label="Status" value={statusLabel(event.status, scheduled)} style={styles.cell} />
                <InfoItem label="Quantidade de imagens" value={String(event.photos)} style={styles.cell} />
                <InfoItem label="Expiração do acervo" value={isoToBr(event.expires_on)} style={styles.cell} />
              </View>
            </Card>
          </View>
        </>
      )}

      {tab === 'info' && !outsider && <EventSettings event={event} onEvent={setEvent} />}
      <Modal visible={!!deleting} onClose={() => setDeleting(null)} icon={Trash2} tone="danger" title="Excluir este evento?" width={520}>
        <View style={{ gap: 12 }}>
          <Text style={styles.text}>
            “{event.name}” sai do site agora e os dados de reconhecimento facial das fotos são apagados na hora.
          </Text>
          <Text style={styles.text}>
            As {event.photos} {event.photos === 1 ? 'foto fica guardada' : 'fotos ficam guardadas'} por {event.deletion_grace_days}{' '}
            {event.deletion_grace_days === 1 ? 'dia' : 'dias'} (até {deleting}). Nesse prazo você pode desfazer a exclusão: o evento
            volta despublicado, para você conferir e publicar de novo. Depois,
            fotos, capa e pacotes são eliminados definitivamente e não há como recuperar.
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, justifyContent: 'flex-end' }}>
            <Button variant="secondary" label="Cancelar" onPress={() => setDeleting(null)} />
            <Button variant="danger" label="Excluir evento" loading={saving} onPress={confirmDeletion} />
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  summary: { flexDirection: 'row', gap: 24, flexWrap: 'wrap', alignItems: 'stretch' },
  side: { flexGrow: 3, flexBasis: 520, flexShrink: 1, minWidth: 0, maxWidth: '100%', gap: 16 },
  // A wide cut, with a ceiling: on a big monitor the column grows and the photo would push the progress off the screen.
  cover: { width: '100%', aspectRatio: 2, maxHeight: 340, borderRadius: 10, backgroundColor: panel.page },
  infoCard: { flexGrow: 2, flexBasis: 380, flexShrink: 1, minWidth: 0, maxWidth: '100%', gap: 14 },
  infoRow: { flexDirection: 'row', columnGap: 16, rowGap: 12, flexWrap: 'wrap' },
  cell: { flexGrow: 1, flexBasis: 110 },
  infoLabel: { fontFamily: fonts.bold, fontSize: 12, color: panel.muted },
  infoValue: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: panel.text },
  divider: { height: 1, backgroundColor: panel.border },
  text: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: panel.muted },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  switchText: { fontFamily: fonts.bold, fontSize: 14, color: panel.text },
  collabRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8, borderTopWidth: 1, borderColor: panel.borderSoft },
});
