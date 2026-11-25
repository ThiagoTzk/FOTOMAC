import { Image } from '@/ui/Image';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Check, Clock, Download, Play, RefreshCw, RotateCcw, ScanFace, Send, Trash2, TriangleAlert, Video as VideoIcon, X } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { API_URL } from '@/api/client';
import { getEvent, type EventItem } from '@/api/events';
import { formatBytes } from '@/api/images';
import {
  decideVideo, deleteVideo, discardVideo, formatDuration, listVideos, publishVideos, restoreVideo, retryVideo,
  videoDownloadLink, videoPlayUrl, videoThumbUrl, type VideoFilter, type VideoItem, type VideoList,
} from '@/api/videos';
import { useAuth } from '@/auth/AuthContext';
import { AccessEnded } from '@/components/panel/AccessEnded';
import { Dropzone } from '@/components/panel/Dropzone';
import { EventTabs } from '@/components/panel/EventTabs';
import { Modal } from '@/components/panel/Modal';
import { VideoPeople } from '@/components/panel/VideoPeople';
import { PageHeader } from '@/components/panel/PageHeader';
import { VideoPlayer } from '@/components/panel/VideoPlayer';
import { VIDEO_ACCEPT, sizeLabel } from '@/components/panel/VideoUpload';
import { enqueueVideos, refreshVideoQueue, useVideoQueue } from '@/components/panel/videoQueue';
import { Button, Card, Field, Input, Notice, Pill } from '@/components/panel/ui';
import { usePhone, useTextScale } from '@/theme/accessibility';
import { fonts, panel } from '@/theme/tokens';
import { saveFile } from '@/ui/saveFile';

const REFRESH_MS = 4000;

/** Where the facial recognition of a published video is (RF035, 04/11/2026). */
function recognitionText(v: VideoItem): string | null {
  if (v.review_status !== 'published' || v.removal_deadline) return null;
  if (v.indexing_status === 'pending' || v.indexing_status === 'indexing') return 'Reconhecimento facial: analisando o vídeo…';
  if (v.indexing_status === 'processed') {
    // 05/11/2026: how many PEOPLE, not only in how many seconds; a second without a face is a head turned
    // away, out of focus or too small.
    const seconds = `${v.face_seconds ?? 0} de ${Math.max(1, Math.round(v.duration_seconds))} segundos`;
    if (v.face_people == null) return `Reconhecimento facial: rostos em ${seconds} do vídeo.`;
    if (v.face_people === 0) return `Reconhecimento facial: só rostos de passagem (menos de 2 segundos), em ${seconds}. Ninguém será encontrado neste vídeo.`;
    return `Reconhecimento facial: ${v.face_people} ${v.face_people === 1 ? 'pessoa encontrada' : 'pessoas encontradas'}, com o rosto visível em ${seconds}.`;
  }
  if (v.indexing_status === 'no_faces') return 'Reconhecimento facial: nenhum rosto encontrado.';
  if (v.indexing_status === 'failed') return 'Reconhecimento facial: a análise falhou. Exclua e envie o vídeo de novo se precisar dele na busca.';
  return null;
}

function statusOf(v: VideoItem): { label: string; bg: string; fg: string } {
  if (v.approval === 'rejected') return { label: 'Recusado', bg: panel.dangerSoft, fg: panel.danger };
  if (v.processing_status === 'failed') return { label: 'Falha na conversão', bg: panel.dangerSoft, fg: panel.danger };
  if (v.processing_status !== 'ready') return { label: 'Convertendo', bg: panel.primarySoft, fg: panel.primaryText };
  if (v.approval === 'pending') return { label: 'Aguardando aprovação', bg: panel.warningSoft, fg: panel.warning };
  if (v.review_status === 'published') return { label: 'Publicado', bg: panel.successSoft, fg: panel.success };
  if (v.review_status === 'discarded') return { label: 'Descartado', bg: panel.page, fg: panel.muted };
  return { label: 'Em conferência', bg: panel.page, fg: panel.muted };
}

/** The videos of an event (RF034). Only logged-in accounts reach this page: nothing here goes to the public site. */
export default function VideosScreen() {
  const phone = usePhone();
  const { id, filtro } = useLocalSearchParams<{ id: string; filtro?: VideoFilter }>();
  const { account } = useAuth();
  const scale = useTextScale();
  const [event, setEvent] = useState<EventItem | null>(null);
  // ?filtro=: the bell's notices open the tab on what they talk about, like Imagens.
  const [filter, setFilter] = useState<VideoFilter>(filtro ?? 'all');
  const [data, setData] = useState<VideoList | null>(null);
  const [watching, setWatching] = useState<VideoItem | null>(null);
  const [seek, setSeek] = useState<{ at: number; n: number } | null>(null);   // a face of "Pessoas neste vídeo" was clicked
  const [deleting, setDeleting] = useState<VideoItem | null>(null);
  const [rejecting, setRejecting] = useState<VideoItem | null>(null);
  const [reason, setReason] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(() => {
    getEvent(id).then(setEvent).catch(() => undefined);
    listVideos(id, filter).then(setData).catch((e) => setError(e.message));
  }, [id, filter]);
  useFocusEffect(load);
  // The videos go into the line of the whole site (counted in the corner): this page only reloads when one of them
  // reaches the server or finishes converting.
  const queue = useVideoQueue();
  const arrivedHere = queue.items.filter((v) => v.eventId === id && v.stage !== 'waiting' && v.stage !== 'sending').length;
  const queuedHere = queue.items.filter((v) => v.eventId === id && (v.stage === 'waiting' || v.stage === 'sending')).length;
  useEffect(() => { if (arrivedHere) load(); }, [arrivedHere]); // eslint-disable-line react-hooks/exhaustive-deps

  // While something converts, or is analysed by the facial recognition, the page follows it without a reload.
  const converting = !!data?.counts.processing
    || !!data?.items.some((v) => v.indexing_status === 'pending' || v.indexing_status === 'indexing');
  useEffect(() => {
    if (!converting) return undefined;
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [converting, load]);

  if (!event || !data) return <Card><ActivityIndicator color={panel.primary} /></Card>;
  const c = data.counts;
  const isAdmin = account?.role === 'admin';
  const canPublish = event.can_manage && !event.deletion_due_at && event.status !== 'expired';
  const filters: { key: VideoFilter; label: string; bg?: string; fg?: string }[] = [
    { key: 'all', label: `Todos · ${c.all}` },
    { key: 'in_review', label: `Em conferência · ${c.in_review}` },
    { key: 'published', label: `Publicados · ${c.published}` },
    { key: 'processing', label: `Convertendo · ${c.processing}` },
    { key: 'discarded', label: `Descartados · ${c.discarded}` },
    ...(c.failed > 0 ? [{ key: 'failed' as VideoFilter, label: `Falha · ${c.failed}`, bg: panel.dangerSoft, fg: panel.danger }] : []),
    ...(c.pending_approval > 0 ? [{ key: 'pending_approval' as VideoFilter, label: `Aguardando aprovação · ${c.pending_approval}`,
                                    bg: panel.warningSoft, fg: panel.warning }] : []),
    ...(c.rejected > 0 ? [{ key: 'rejected' as VideoFilter, label: `Recusados · ${c.rejected}`, bg: panel.dangerSoft, fg: panel.danger }] : []),
  ];

  async function act(action: () => Promise<unknown>, done?: string) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await action();
      if (done) setMessage(done);
      load();
      refreshVideoQueue();   // a published or discarded video leaves the corner's "Falta publicar" at once
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível concluir. Tente novamente.');
    } finally {
      setBusy(false);
    }
  }

  async function download(video: VideoItem) {
    await act(async () => {
      const { url } = await videoDownloadLink(video.id);
      await saveFile(`${API_URL}${url}`, 'Salvar vídeo');   // the site: the browser saves it; the app: Salvar/Compartilhar
    });
  }

  return (
    <>
      <PageHeader crumbs={[{ label: 'Eventos', href: '/eventos' }, { label: event.name, href: `/eventos/${event.id}` }, { label: 'Vídeos' }]}
                  title={event.name}
                  actions={canPublish && c.ready > 0
                    ? <Button icon={Send} label={`Publicar ${c.ready === 1 ? 'vídeo pronto' : `${c.ready} vídeos prontos`}`} onPress={() => setPublishing(true)} />
                    : undefined} />
      <EventTabs event={event} value="videos" />

      <Notice tone="info" icon={ScanFace} title="Os vídeos publicados entram na busca facial"
              description="Depois de publicado, cada vídeo passa pelo reconhecimento facial. Quem for encontrado no vídeo pela busca do site pode assistir e baixar o vídeo inteiro, com a marca CESMAC, mesmo que outras pessoas apareçam nele. Se uma pessoa pedir a remoção, o vídeo sai das buscas na hora e é excluído em 72 horas. Vídeos podem conter voz, que também é dado pessoal: envie apenas o que faz parte do evento." />
      <AccessEnded event={event} />
      {!data.available && <Notice tone="danger" icon={TriangleAlert} title="Envio de vídeos indisponível" description="O servidor está sem a ferramenta de vídeo. Avise o administrador." />}
      {c.failed > 0 && (
        <Notice tone="danger" icon={TriangleAlert} title={`Falha na conversão de ${c.failed} ${c.failed === 1 ? 'vídeo' : 'vídeos'}`}
                description="Abra a lista de falhas para tentar de novo." actionLabel="Ver as falhas" onAction={() => setFilter('failed')} />
      )}
      {isAdmin && c.pending_approval > 0 && (
        <Notice tone="warning" icon={Clock} title={`${c.pending_approval} ${c.pending_approval === 1 ? 'vídeo aguarda' : 'vídeos aguardam'} a sua aprovação`}
                description="Enviados por fotógrafo contratado. Só podem ser publicados depois de aprovados."
                actionLabel="Revisar" onAction={() => setFilter('pending_approval')} />
      )}
      {error && <Notice tone="danger" icon={TriangleAlert} title="Não foi possível concluir" description={error} />}
      {message && <Notice tone="success" icon={Check} title={message} />}

      {data.can_upload && data.available && (
        <Card style={{ gap: 12 }}>
          <Dropzone onFiles={(files) => { setError(null); setMessage(null); enqueueVideos(id, event.name, files, event.can_manage); }} accept={VIDEO_ACCEPT} title="Arraste seus vídeos aqui" phoneTitle="Toque para escolher vídeos" />
          <Text style={styles.small}>
            MP4, MOV, MKV, WEBM, AVI, WMV, MTS, MPG e outros formatos de celular e câmera, até {sizeLabel(data.max_bytes)} e {Math.round(data.max_seconds / 60)} minutos por vídeo. A localização gravada no arquivo é removida antes de guardar. Fora de MP4 e MOV, o original fica em MKV, com a mesma imagem e o mesmo som.
          </Text>
          {queuedHere > 0 && (
            <Text style={[styles.small, { color: panel.primaryText }]}>
              {queuedHere === 1 ? '1 vídeo na fila de envio.' : `${queuedHere} vídeos na fila de envio.`} Acompanhe a contagem no canto da tela.
            </Text>
          )}
        </Card>
      )}

      <View style={styles.filters}>
        {filters.map((f) => (
          <Pressable key={f.key} accessibilityRole="button" accessibilityState={{ selected: filter === f.key }} onPress={() => setFilter(f.key)}
                     style={[styles.filter, filter === f.key && styles.filterOn, f.bg ? { backgroundColor: f.bg } : null]}>
            <Text style={[styles.filterText, f.fg ? { color: f.fg } : null, filter === f.key && !f.fg && { color: panel.primaryText }]}>{f.label}</Text>
          </Pressable>
        ))}
      </View>

      {data.items.length === 0 ? (
        <Card style={styles.empty}>
          <VideoIcon size={30} color={panel.muted} strokeWidth={1.4} absoluteStrokeWidth />
          <Text style={styles.small}>{filter === 'all' ? 'Nenhum vídeo neste evento ainda.' : 'Nenhum vídeo neste filtro.'}</Text>
        </Card>
      ) : (
        <View style={styles.grid}>
          {data.items.map((v) => {
            const status = statusOf(v);
            const hasThumb = v.processing_status === 'ready';
            return (
              // A phone: one card per line. The app's layout squeezed the first card to a sliver instead of wrapping (06/11/2026).
              <Card key={v.id} padding={12} style={[styles.card, phone ? { width: '100%' } : { flexBasis: 300 * scale }]}>
                <Pressable accessibilityRole="button" accessibilityLabel={`Assistir ao vídeo de ${formatDuration(v.duration_seconds)}`}
                           disabled={!hasThumb} onPress={() => setWatching(v)} style={styles.thumbBox}>
                  {hasThumb && <Image source={{ uri: videoThumbUrl(v.id) }} style={styles.thumb} contentFit="cover" accessibilityLabel="" />}
                  {hasThumb ? <View style={styles.play}><Play size={22} color="#FFFFFF" fill="#FFFFFF" strokeWidth={1.6} absoluteStrokeWidth /></View>
                    : <ActivityIndicator color={panel.primary} />}
                  <View style={styles.duration}><Text style={styles.durationText}>{formatDuration(v.duration_seconds)}</Text></View>
                </Pressable>
                <View style={styles.statusRow}>
                  <Pill label={status.label} bg={status.bg} fg={status.fg} />
                  <Text style={styles.small}>{formatBytes(v.size_bytes)}{v.converted && v.web_bytes ? ` + cópia ${formatBytes(v.web_bytes)}` : ''}</Text>
                </View>
                <Text style={styles.name} numberOfLines={1}>{v.credit}</Text>
                <Text style={styles.small}>Enviado por {v.uploaded_by_name}{v.approved_by_name ? ` · aprovado por ${v.approved_by_name}` : ''}</Text>
                {recognitionText(v) && <Text style={styles.small}>{recognitionText(v)}</Text>}
                {v.removal_deadline && (
                  <Text style={styles.failure}>
                    Remoção pedida por quem aparece no vídeo: já saiu das buscas e será excluído em{' '}
                    {new Date(v.removal_deadline).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}.
                  </Text>
                )}
                {v.failure && <Text style={styles.failure}>{v.failure}</Text>}
                {v.rejection_reason && <Text style={styles.failure}>Motivo da recusa: {v.rejection_reason}</Text>}
                {v.eliminated_at && <Text style={styles.small}>Sai do sistema em {new Date(v.eliminated_at).toLocaleDateString('pt-BR')}.</Text>}
                <View style={styles.actions}>
                  {v.can_download && <Button variant="secondary" icon={Download} label="Baixar" onPress={() => download(v)} />}
                  {v.can_manage && v.processing_status === 'failed' && <Button variant="secondary" icon={RefreshCw} label="Tentar de novo" loading={busy} onPress={() => act(() => retryVideo(v.id))} />}
                  {v.can_manage && v.review_status === 'in_review' && v.approval !== 'rejected' && <Button variant="secondary" icon={X} label="Descartar" onPress={() => act(() => discardVideo(v.id))} />}
                  {v.can_manage && v.review_status === 'discarded' && <Button variant="secondary" icon={RotateCcw} label="Restaurar" onPress={() => act(() => restoreVideo(v.id))} />}
                  {isAdmin && v.approval === 'pending' && <Button icon={Check} label="Aprovar" onPress={() => act(() => decideVideo(v.id, true))} />}
                  {isAdmin && v.approval === 'pending' && <Button variant="danger" label="Recusar" onPress={() => { setReason(''); setRejecting(v); }} />}
                  {v.can_manage && v.processing_status !== 'processing' && <Button variant="danger" icon={Trash2} label="Excluir" onPress={() => setDeleting(v)} />}
                </View>
              </Card>
            );
          })}
        </View>
      )}

      <Modal visible={!!watching} onClose={() => { setWatching(null); setSeek(null); }} icon={Play} title="Assistir ao vídeo" width={860}>
        {watching && <VideoPlayer src={videoPlayUrl(watching.id)} poster={videoThumbUrl(watching.id)} label={`Vídeo do evento ${event.name}`} seek={seek ?? undefined} />}
        {/* 05/11/2026: who appears in it, for whoever manages it, once the recognition has analysed it. */}
        {watching && watching.can_manage && watching.review_status === 'published' && watching.indexing_status === 'processed' && !watching.removal_deadline && (
          <VideoPeople video={watching} onSeek={(at) => setSeek((s) => ({ at, n: (s?.n ?? 0) + 1 }))} />
        )}
        <View style={styles.modalActions}><Button variant="secondary" label="Fechar" onPress={() => { setWatching(null); setSeek(null); }} /></View>
      </Modal>

      <Modal visible={publishing} onClose={() => setPublishing(false)} icon={Send} title="Publicar os vídeos prontos?">
        <Text style={styles.text}>
          {c.ready} {c.ready === 1 ? 'vídeo fica disponível' : 'vídeos ficam disponíveis'} para as contas da equipe, inclusive o marketing, e {c.ready === 1 ? 'entra' : 'entram'} na busca facial do site: quem for encontrado pode assistir e baixar o vídeo inteiro.
          {c.discarded > 0 ? ` ${c.discarded === 1 ? 'O vídeo descartado é excluído' : `Os ${c.discarded} vídeos descartados são excluídos`} definitivamente.` : ''}
        </Text>
        <View style={styles.modalActions}>
          <Button variant="secondary" label="Cancelar" onPress={() => setPublishing(false)} />
          <Button label="Publicar" loading={busy} onPress={async () => { await act(() => publishVideos(id), 'Vídeos publicados.'); setPublishing(false); }} />
        </View>
      </Modal>

      <Modal visible={!!deleting} onClose={() => setDeleting(null)} icon={Trash2} tone="danger" title="Excluir este vídeo?">
        <Text style={styles.text}>O vídeo, a cópia convertida e a miniatura são apagados definitivamente. Não há como recuperar.</Text>
        <View style={styles.modalActions}>
          <Button variant="secondary" label="Cancelar" onPress={() => setDeleting(null)} />
          <Button variant="danger" label="Excluir vídeo" loading={busy} onPress={async () => { await act(() => deleteVideo(deleting!.id), 'Vídeo excluído.'); setDeleting(null); }} />
        </View>
      </Modal>

      <Modal visible={!!rejecting} onClose={() => setRejecting(null)} icon={X} tone="danger" title="Recusar este vídeo?">
        <Field label="Motivo da recusa" help="O fotógrafo contratado vai ler. De 5 a 300 caracteres.">
          <Input value={reason} onChangeText={setReason} maxLength={300} accessibilityLabel="Motivo da recusa" />
        </Field>
        <View style={styles.modalActions}>
          <Button variant="secondary" label="Cancelar" onPress={() => setRejecting(null)} />
          <Button variant="danger" label="Recusar vídeo" loading={busy} disabled={reason.trim().length < 5}
                  onPress={async () => { await act(() => decideVideo(rejecting!.id, false, reason)); setRejecting(null); }} />
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  small: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 18, color: panel.muted },
  text: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: panel.muted },
  name: { fontFamily: fonts.bold, fontSize: 14, color: panel.text },
  failure: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 18, color: panel.danger },
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  filter: { minHeight: 32, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 999, backgroundColor: panel.surface, borderWidth: 1, borderColor: panel.border },
  filterOn: { borderColor: panel.primary, backgroundColor: panel.primarySoft },
  filterText: { fontFamily: fonts.bold, fontSize: 13, color: panel.muted },
  empty: { alignItems: 'center', gap: 8, paddingVertical: 32 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 16 },
  card: { flexGrow: 1, flexShrink: 1, maxWidth: 460, gap: 8 },
  thumbBox: { width: '100%', aspectRatio: 16 / 9, borderRadius: 10, overflow: 'hidden', backgroundColor: panel.page, alignItems: 'center', justifyContent: 'center' },
  thumb: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  play: { width: 46, height: 46, borderRadius: 999, backgroundColor: 'rgba(0, 0, 0, 0.6)', alignItems: 'center', justifyContent: 'center' },
  duration: { position: 'absolute', right: 8, bottom: 8, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, backgroundColor: 'rgba(0, 0, 0, 0.72)' },
  durationText: { fontFamily: fonts.bold, fontSize: 12, color: '#FFFFFF' },
  statusRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  modalActions: { flexDirection: 'row', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' },
});
