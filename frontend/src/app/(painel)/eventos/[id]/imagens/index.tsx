import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Baby, CircleCheck, Download, EyeOff, Images, Info, ListChecks, LoaderCircle, RefreshCw, ScanFace, Send, Trash2, TriangleAlert, Upload, X } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { api } from '@/api/client';
import { canUploadTo, getEvent, type EventItem } from '@/api/events';
import { decideApprovals, getProcessing, listImages, publishEvent, type ImageCounts, type ImageFilter, type ImageItem,
         type Processing } from '@/api/images';
import { useAuth } from '@/auth/AuthContext';
import { AccessEnded } from '@/components/panel/AccessEnded';
import { canBlur } from '@/components/panel/BlurEditor';
import { BlurSequence } from '@/components/panel/BlurSequence';
import { EventTabs } from '@/components/panel/EventTabs';
import { ImageCard, gridStyle } from '@/components/panel/ImageCard';
import { Indicator, Indicators } from '@/components/panel/Indicator';
import { Modal } from '@/components/panel/Modal';
import { PageHeader } from '@/components/panel/PageHeader';
import { Button, Card, Field, Input, Notice, Pill } from '@/components/panel/ui';
import { usePhone, useTapWord } from '@/theme/accessibility';
import { fonts, panel } from '@/theme/tokens';

const PAGE = 60;

/** The photos of an event: filters, selection, publication and approvals. */
export default function ImagesScreen() {
  const tap = useTapWord();
  const { id, filtro } = useLocalSearchParams<{ id: string; filtro?: ImageFilter }>();
  const [event, setEvent] = useState<EventItem | null>(null);
  const [filter, setFilter] = useState<ImageFilter>(filtro ?? 'all');
  const [data, setData] = useState<{ items: ImageItem[]; counts: ImageCounts } | null>(null);
  const [proc, setProc] = useState<Processing | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState(false);
  const [confirmReject, setConfirmReject] = useState(false);
  const [reason, setReason] = useState('');
  const [publishing, setPublishing] = useState<'all' | 'selected' | null>(null);   // confirmation open
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE);
  const [blurQueue, setBlurQueue] = useState<ImageItem[] | null>(null);   // the photos of "Borrar rostos nas selecionadas"
  const { account } = useAuth();
  const isAdmin = account?.role === 'admin';
  const phone = usePhone();

  const load = useCallback(() => {
    getEvent(id).then(setEvent).catch(() => undefined);
    listImages(id, filter).then(setData).catch(() => undefined);
    getProcessing(id).then(setProc).catch(() => undefined);
  }, [id, filter]);
  useFocusEffect(load);

  if (!event || !data || !proc) return <Card><ActivityIndicator color={panel.primary} /></Card>;
  const c = data.counts;
  const filters: { key: ImageFilter; label: string; bg?: string; fg?: string }[] = [
    { key: 'all', label: `Todas · ${c.all}` },
    { key: 'in_review', label: `Em conferência · ${c.in_review}` },
    { key: 'published', label: `Publicada · ${c.published}` },
    { key: 'discarded', label: `Descartada · ${c.discarded}` },
    { key: 'no_faces', label: `Sem faces detectadas · ${c.no_faces}` },
    { key: 'failed', label: `Falha · ${c.failed}` },
    // Removal requests get their own highlight.
    { key: 'removal', label: `Remoção solicitada · ${c.removal}`, ...(c.removal > 0 && { bg: panel.dangerSoft, fg: panel.danger }) },
    // Photos of a hired photographer waiting for the administrator.
    ...(c.pending_approval > 0 ? [{ key: 'pending_approval' as ImageFilter, label: `Aguardando aprovação · ${c.pending_approval}`,
                                    bg: panel.warningSoft, fg: panel.warning }] : []),
    // 22/10/2026: rejected with a reason, visible until they are eliminated (7 days).
    ...(c.rejected > 0 ? [{ key: 'rejected' as ImageFilter, label: `Recusadas · ${c.rejected}`, bg: panel.dangerSoft, fg: panel.danger }] : []),
  ];
  const filterPills = filters.map((f) => (
    <Pressable key={f.key} accessibilityRole="tab" accessibilityState={{ selected: filter === f.key }} aria-selected={filter === f.key}
               onPress={() => { setFilter(f.key); setShown(PAGE); }}>
      <Pill label={f.label} bg={filter === f.key ? panel.primarySoft : f.bg ?? panel.page}
            fg={filter === f.key ? panel.primaryText : f.fg ?? panel.muted} />
    </Pressable>
  ));
  const deletable = [...selected].filter((sid) => data.items.find((i) => i.id === sid)?.can_manage);
  const approvable = [...selected].filter((sid) => data.items.find((i) => i.id === sid)?.approval === 'pending');
  const pendingHere = data.items.filter((i) => i.approval === 'pending');
  // Under review and not waiting for the administrator: what can be published now.
  const isReady = (i?: ImageItem) => !!i && i.review_status === 'in_review' && i.approval !== 'pending';
  const publishable = [...selected].filter((sid) => isReady(data.items.find((i) => i.id === sid)));
  const canPublish = event.can_manage && !event.deletion_due_at && event.status !== 'expired';
  const toPublish = publishing === 'all' ? c.ready : publishable.length;
  const blurrable = data.items.filter((i) => selected.has(i.id) && canBlur(i, account?.role));
  const allSelected = data.items.length > 0 && data.items.every((i) => selected.has(i.id));

  /** "Selecionar para publicar": shows the images under review with every ready one already selected. */
  async function selectReady() {
    const r = await listImages(id, 'in_review');
    setFilter('in_review'); setShown(PAGE); setData(r);
    setSelected(new Set(r.items.filter(isReady).map((i) => i.id))); setSelecting(true);
  }

  /** Publishing is what allows the face indexing. All the ready ones, or only the selected. */
  async function publish() {
    setBusy(true); setError(null);
    try {
      await publishEvent(id, publishing === 'selected' ? publishable : undefined);
      router.navigate(`/eventos/${id}/processamento`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível publicar.');
    } finally { setBusy(false); setPublishing(null); }
  }

  /** Approve or reject the selected photos at once. Who approved each one is recorded. */
  async function decide(approve: boolean) {
    setBusy(true);
    try {
      const r = await decideApprovals(id, approvable, approve, approve ? undefined : reason);
      setMessage(approve
        ? `${r.decided} ${r.decided === 1 ? 'foto aprovada' : 'fotos aprovadas'}. Já podem ser publicadas: use “Publicar” abaixo.`
        : `${r.decided} ${r.decided === 1 ? 'foto recusada' : 'fotos recusadas'}: o fotógrafo contratado vê o motivo, e elas são excluídas em 7 dias.`);
      setSelected(new Set()); setSelecting(false); setConfirmReject(false); setReason('');
      load();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Não foi possível registrar a decisão.');
    } finally { setBusy(false); }
  }

  async function deleteSelected() {
    setBusy(true);
    try {
      const r = await api<{ deleted: number; refused: number }>(`/events/${id}/images/delete`, { body: { ids: deletable } });
      setMessage(`${r.deleted} ${r.deleted === 1 ? 'imagem excluída' : 'imagens excluídas'}, com os dados de indexação facial.`);
      setSelected(new Set()); setSelecting(false); setConfirm(false);
      load();
    } finally { setBusy(false); }
  }

  async function reprocessFailed() {
    const r = await api<{ queued: number }>(`/events/${id}/images/reprocess-failed`, { method: 'POST' });
    setMessage(r.queued ? `${r.queued} ${r.queued === 1 ? 'imagem voltou' : 'imagens voltaram'} para a fila de indexação.` : 'Nenhuma imagem elegível para reprocessamento.');
    load();
  }

  const processingLabel = proc.total === 0 ? '-' : proc.pending > 0 ? `${proc.percent}%` : 'Concluído';
  return (
    <>
      <PageHeader crumbs={[{ label: 'Eventos', href: '/eventos' }, { label: event.name, href: `/eventos/${id}` }, { label: 'Imagens' }]}
                  title="Imagens"
                  actions={(
                    <>
                      {c.published > 0 && (
                        <Button variant="secondary" icon={Download} label={event.can_manage ? 'Baixar acervo' : event.relation === 'viewer' ? 'Baixar para divulgação' : 'Baixar minhas imagens'}
                                onPress={() => router.navigate(`/eventos/${id}/download`)} />)}
                      {canUploadTo(event) && (
                        <Button icon={Upload} label="Enviar imagens" onPress={() => router.navigate(`/eventos/${id}/enviar`)} />)}
                    </>)} />
      <EventTabs event={event} value="images" />
      <AccessEnded event={event} />
      <Indicators>
        <Indicator label="Total de imagens" value={c.all} icon={Images} bg={panel.primarySoft} fg={panel.primary} />
        <Indicator label="Faces indexadas" value={proc.faces} icon={ScanFace} bg={panel.primarySoft} fg={panel.primary} />
        <Indicator label="Processamento" value={processingLabel} icon={proc.pending > 0 ? LoaderCircle : CircleCheck}
                   bg={panel.successSoft} fg={panel.success} />
      </Indicators>
      {/* Sticky: with hundreds of photos, select 675, 687 and 598 and delete them
          without scrolling back to the top — the actions follow the scroll. */}
      {/* On a phone (06/11/2026) the bar took half the screen while scrolling: not fixed there, and the filters on one
          line that scrolls sideways. */}
      <View style={[styles.toolbar, !phone && styles.sticky]}>
        {phone ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, width: '100%' }}
                      contentContainerStyle={[styles.filters, { flexWrap: 'nowrap' }]} accessibilityRole="tablist">
            {filterPills}
          </ScrollView>
        ) : (
          <View style={[styles.filters, styles.filtersBox]} accessibilityRole="tablist">{filterPills}</View>
        )}
        <View style={styles.bulk}>
          {selecting && <Text style={styles.selectedCount}>{selected.size} {selected.size === 1 ? 'selecionada' : 'selecionadas'}</Text>}
          <Button variant="secondary" label={selecting ? 'Cancelar seleção' : 'Selecionar'}
                  onPress={() => { setSelecting(!selecting); setSelected(new Set()); }} />
          {/* 05/11/2026: "selecionar todas > borrar rostos". Every photo of the open filter, also the ones
              behind "Carregar mais", so the count on the action buttons is the real one. */}
          {selecting && data.items.length > 0 && (allSelected
            ? <Button variant="secondary" icon={ListChecks} label="Desmarcar todas" onPress={() => setSelected(new Set())} />
            : <Button variant="secondary" icon={ListChecks} label={`Selecionar todas (${data.items.length})`}
                      onPress={() => setSelected(new Set(data.items.map((i) => i.id)))} />)}
          {canPublish && selecting && publishable.length > 0 && (
            <Button icon={Send} label={`Publicar selecionadas (${publishable.length})`} onPress={() => setPublishing('selected')} />)}
          {selecting && blurrable.length > 0 && (
            <Button variant="secondary" icon={EyeOff} label={`Borrar rostos nas selecionadas (${blurrable.length})`} onPress={() => setBlurQueue(blurrable)} />)}
          {isAdmin && selecting && pendingHere.length > 0 && (
            <Button variant="secondary" icon={ListChecks} label={`Selecionar as que aguardam aprovação (${pendingHere.length})`}
                    onPress={() => setSelected(new Set(pendingHere.map((i) => i.id)))} />
          )}
          {isAdmin && approvable.length > 0 && (
            <>
              <Button icon={CircleCheck} label={`Aprovar selecionadas (${approvable.length})`} loading={busy} onPress={() => decide(true)} />
              <Button variant="danger" icon={X} label={`Recusar (${approvable.length})`} onPress={() => setConfirmReject(true)} />
            </>
          )}
          <Button variant="secondary" icon={Trash2} label={`Excluir selecionadas${deletable.length ? ` (${deletable.length})` : ''}`}
                  disabled={!deletable.length} onPress={() => setConfirm(true)} />
          <Button variant="secondary" icon={RefreshCw} label={c.failed ? `Tentar de novo as que falharam (${c.failed})` : 'Nenhuma falha para reprocessar'}
                  disabled={!c.failed} onPress={reprocessFailed} />
        </View>
      </View>
      {message && <Notice tone="success" icon={CircleCheck} title={message} />}
      {error && <Notice tone="danger" icon={TriangleAlert} title={error} />}
      {/* 24/10/2026: a failure says what happened and what to do, not only a red label on the photo. */}
      {c.failed > 0 && filter !== 'failed' && (
        <Notice tone="danger" icon={TriangleAlert}
                title={`${c.failed} ${c.failed === 1 ? 'foto não foi processada' : 'fotos não foram processadas'} pelo reconhecimento facial`}
                description="Elas não aparecem na busca dos visitantes. Abra cada uma para ver o motivo, ou tente de novo todas de uma vez. Se a falha continuar, substitua o arquivo ou avise o administrador."
                actionLabel="Ver as que falharam" onAction={() => { setFilter('failed'); setShown(PAGE); }} />
      )}
      {/* 05/11/2026: the blur was only inside each photo, and nobody found it. Here, where the photos are
          checked before publishing; stronger in an event marked with children. It never replaces the guardians'
          authorisation (nao-tratar-borrao-como-excecao-de-autorizacao). */}
      {/* 05/11/2026 (2): in every event with photos, published ones too (they can be blurred and are indexed again),
          and with the way to do it written out: select, then one photo after the other. */}
      {c.all - c.discarded > 0 && account?.role !== 'contractor' && event.can_manage && !selecting && (
        <Notice tone={event.has_children ? 'warning' : 'info'} icon={event.has_children ? Baby : EyeOff}
                title={event.has_children ? 'Evento com crianças: confira os rostos' : 'Apareceu uma criança por acaso numa foto?'}
                description={`${event.has_children ? 'Por segurança, o sistema tem a função “Borrar rostos”: ela esconde o rosto no próprio arquivo, e o rosto borrado não entra no reconhecimento facial. ' : 'Use a função “Borrar rostos”: ela esconde o rosto no próprio arquivo, e o rosto borrado não entra no reconhecimento facial. Serve para qualquer pessoa que não deva aparecer. '}Como fazer: ${tap} em “Selecionar”, marque as fotos (ou “Selecionar todas”) e ${tap} em “Borrar rostos nas selecionadas”. As fotos abrem uma por uma: ${tap} nos rostos que devem sumir e em “Borrar e ir para a próxima”, ou pule a foto que não tem nada a borrar.${event.has_children ? ' O borrão não substitui a autorização dos responsáveis.' : ''}`}
                actionLabel="Selecionar fotos para borrar" onAction={() => { setSelecting(true); setSelected(new Set()); }} />
      )}
      {/* 17/10/2026: publishing happens here, where the images are reviewed — all the ready ones or a selection. */}
      {canPublish && c.ready > 0 && (
        <Card padding={18} style={styles.publishBar}>
          <View style={{ gap: 4, flex: 1, minWidth: 260 }}>
            <Text style={styles.big}>{c.ready} {c.ready === 1 ? 'imagem pronta' : 'imagens prontas'} para publicação</Text>
            <Text style={styles.text}>
              {event.status === 'published' ? 'O evento continua no site enquanto as novas imagens são indexadas.'
                : 'O evento vai para o site quando a indexação facial terminar.'}
              {c.pending_approval > 0 ? ` ${c.pending_approval} aguardando aprovação ${c.pending_approval === 1 ? 'fica' : 'ficam'} de fora.` : ''}
            </Text>
          </View>
          <View style={styles.bulk}>
            {/* While selecting, "Publicar selecionadas" is in the sticky bar above, next to the selection. */}
            {!selecting && <Button variant="secondary" icon={ListChecks} label="Selecionar para publicar" onPress={selectReady} />}
            <Button icon={Send} variant={selecting && publishable.length > 0 ? 'secondary' : 'primary'}
                    label={`Publicar todas (${c.ready})`} onPress={() => setPublishing('all')} />
          </View>
        </Card>
      )}
      {!event.can_manage && event.relation !== 'viewer' && c.ready > 0 && (
        <Notice tone="info" icon={Info} title={`${c.ready} ${c.ready === 1 ? 'imagem aguarda' : 'imagens aguardam'} publicação pelo responsável`}
                description={`Quem publica é ${event.owner.full_name}, responsável pelo evento, ou a administração.`} />
      )}
      {data.items.length === 0 ? (
        <Notice tone="info" icon={Images} title="Nenhuma imagem neste filtro" />
      ) : (
        <View style={gridStyle.grid}>
          {data.items.slice(0, shown).map((img) => (
            <ImageCard key={img.id} image={img} selectable={selecting} selected={selected.has(img.id)}
                       onToggle={() => setSelected((s) => { const n = new Set(s); if (n.has(img.id)) n.delete(img.id); else n.add(img.id); return n; })}
                       onOpen={() => router.navigate(`/eventos/${id}/imagens/${img.id}?filtro=${filter}`)}
                       action={{ label: 'Abrir', onPress: () => router.navigate(`/eventos/${id}/imagens/${img.id}?filtro=${filter}`) }} />
          ))}
        </View>
      )}
      {data.items.length > shown && <View style={{ alignItems: 'center' }}><Button variant="secondary" label={`Carregar mais (${data.items.length - shown})`} onPress={() => setShown(shown + PAGE)} /></View>}

      <Modal visible={confirmReject} onClose={() => setConfirmReject(false)} icon={X} tone="danger"
             title={`Recusar ${approvable.length} ${approvable.length === 1 ? 'foto' : 'fotos'}?`} width={520}>
        <Text style={styles.text}>
          O fotógrafo contratado vê o motivo. As fotos recusadas nunca são publicadas nem geram dado biométrico, e são excluídas
          automaticamente em 7 dias. A recusa fica registrada com o seu nome.
        </Text>
        <Field label="Motivo da recusa" help={`${reason.trim().length} de 300 · obrigatório`}>
          <Input multiline value={reason} onChangeText={setReason} maxLength={300} placeholder="Ex.: fora de foco; não pertence a este evento"
                 accessibilityLabel="Motivo da recusa" />
        </Field>
        <View style={styles.actions}>
          <Button variant="secondary" label="Cancelar" onPress={() => setConfirmReject(false)} />
          <Button variant="danger" label="Recusar" onPress={() => decide(false)} loading={busy} disabled={reason.trim().length < 5} />
        </View>
      </Modal>

      <Modal visible={!!publishing} onClose={() => setPublishing(null)} icon={Send}
             title={`Publicar ${toPublish} ${toPublish === 1 ? 'imagem' : 'imagens'}?`} width={520}>
        <Text style={styles.text}>
          Só imagens publicadas passam pela indexação facial e podem ser encontradas pelos visitantes.
          {publishing === 'selected' && c.ready > toPublish ? ` As outras ${c.ready - toPublish} continuam em conferência.` : ''}
        </Text>
        {c.discarded > 0 && (
          <Notice tone="warning" icon={TriangleAlert}
                  title={`${c.discarded} ${c.discarded === 1 ? 'imagem descartada será excluída' : 'imagens descartadas serão excluídas'} definitivamente`} />
        )}
        <View style={styles.actions}>
          <Button variant="secondary" label="Cancelar" onPress={() => setPublishing(null)} />
          <Button icon={Send} label={`Publicar ${toPublish} ${toPublish === 1 ? 'imagem' : 'imagens'}`} onPress={publish} loading={busy} />
        </View>
      </Modal>

      <Modal visible={!!blurQueue} onClose={() => { setBlurQueue(null); load(); }} icon={EyeOff} title="Borrar rostos nas selecionadas" width={1000}>
        {blurQueue && (
          <BlurSequence images={blurQueue} onFinished={(blurred, skipped) => {
            setBlurQueue(null); setSelected(new Set()); setSelecting(false);
            setMessage(`${blurred} ${blurred === 1 ? 'foto borrada' : 'fotos borradas'}${skipped ? `, ${skipped} sem nada a borrar` : ''}.`);
            load();
          }} />
        )}
      </Modal>

      {/* Batch deletion informs the quantity before confirming. */}
      <Modal visible={confirm} onClose={() => setConfirm(false)} icon={Trash2} tone="danger"
             title={`Excluir ${deletable.length} ${deletable.length === 1 ? 'imagem' : 'imagens'}?`} width={500}>
        <Text style={styles.text}>
          As imagens selecionadas, suas cópias e os dados associados à indexação facial serão removidos definitivamente. Esta ação não poderá ser desfeita.
        </Text>
        {selected.size > deletable.length && (
          <Notice tone="warning" icon={TriangleAlert} title={`${selected.size - deletable.length} selecionadas são de outros fotógrafos e não serão excluídas.`} />
        )}
        <View style={styles.actions}>
          <Button variant="secondary" label="Cancelar" onPress={() => setConfirm(false)} />
          <Button variant="danger" label="Excluir imagens" onPress={deleteSelected} loading={busy} />
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  toolbar: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' },
  // The page's own background, so the photos pass UNDER the bar; a hairline marks its edge.
  sticky: { position: 'sticky' as never, top: 0, zIndex: 5, backgroundColor: panel.page, marginHorizontal: -12,
            paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: panel.border },
  selectedCount: { alignSelf: 'center', fontFamily: fonts.semiBold, fontSize: 13, color: panel.primaryText, paddingHorizontal: 4 },
  filtersBox: { flex: 1, minWidth: 300 },
  filters: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  // maxWidth: without it the row grows past the page instead of wrapping (with "Selecionar todas" the last button was cut).
  bulk: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', flexShrink: 1, maxWidth: '100%' },
  text: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 21, color: panel.muted },
  actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 12 },
  publishBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 },
  big: { fontFamily: fonts.regular, fontSize: 16, color: panel.text },
});
