import { Image } from '@/ui/Image';
import { router, useIsFocused, useLocalSearchParams } from 'expo-router';
import { FileImage, Info, TriangleAlert, Video as VideoIcon, X } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { getEvent, type EventItem } from '@/api/events';
import { formatBytes, getUploadRules, type UploadRules } from '@/api/images';
import { Dropzone } from '@/components/panel/Dropzone';
import { PageHeader } from '@/components/panel/PageHeader';
import { ProgressBar } from '@/components/panel/Progress';
import { VIDEO_ACCEPT, isVideoFile, sizeLabel } from '@/components/panel/VideoUpload';
import { enqueueVideos, holdForPhotos, useVideoQueue } from '@/components/panel/videoQueue';
import { Button, Card, Notice, Pill, SectionTitle } from '@/components/panel/ui';
import { MAX_FILES_PER_BATCH, kindLabel, newEntries, previewable, runQueue, takesPlace, validate, type Entry, type EntryStatus } from '@/components/panel/upload';
import { fonts, panel } from '@/theme/tokens';
import { releasePreview } from '@/components/panel/files';
import { usePhone } from '@/theme/accessibility';

const PILL: Record<EntryStatus, { label: string; bg: string; fg: string }> = {
  checking: { label: 'Verificando', bg: panel.page, fg: panel.muted },
  valid: { label: 'Válido', bg: panel.successSoft, fg: panel.success },
  invalid: { label: 'Inválido', bg: panel.dangerSoft, fg: panel.danger },
  duplicate: { label: 'Duplicado', bg: panel.warningSoft, fg: panel.warning },
  waiting: { label: 'Aguardando', bg: panel.page, fg: panel.muted },
  sending: { label: 'Enviando', bg: panel.primarySoft, fg: panel.primaryText },
  done: { label: 'Concluído', bg: panel.successSoft, fg: panel.success },
  failed: { label: 'Falha', bg: panel.dangerSoft, fg: panel.danger },
};

function FileRow({ entry, sending, onRemove }: { entry: Entry; sending: boolean; onRemove?: () => void }) {
  const p = PILL[entry.status];
  // 06/11/2026 (seen in the app): the row was made for a computer and "Concluído" ran past a phone's edge. On a phone the
  // name takes the room left and the progress bar goes to the line below, the whole width.
  const phone = usePhone();
  const progress = (
    <View style={phone ? { width: '100%', gap: 5 } : { flex: 1, gap: 5, minWidth: 80 }}>
      <ProgressBar percent={entry.progress} height={6} danger={entry.status === 'failed'} />
      <Text style={styles.tiny}>{entry.progress}%</Text>
    </View>
  );
  return (
    <View style={[styles.file, phone && { flexWrap: 'wrap', rowGap: 8 }]}>
      {/* Drawn only when it CAN be drawn: never while checking (a RAW's own address is swapped for its preview). */}
      {previewable(entry.kind) || entry.embeddedPreview ? <Image source={{ uri: entry.previewUrl }} style={styles.thumb} contentFit="cover" accessibilityLabel="Prévia da imagem" /> : (
        // The browser cannot draw HEIC or RAW: the server makes the JPEG copy after the upload.
        <View style={[styles.thumb, styles.noPreview]}>
          <FileImage size={20} color={panel.muted} strokeWidth={1.6} absoluteStrokeWidth />
          <Text style={styles.tiny}>{entry.status === 'checking' ? '…' : entry.kind === 'raw' ? 'RAW' : entry.kind === 'heic' ? 'HEIC' : '?'}</Text>
        </View>
      )}
      <View style={phone ? { flex: 1, minWidth: 0, gap: 4 } : { width: 300, maxWidth: '40%', gap: 4 }}>
        <Text style={styles.fileName} numberOfLines={1}>{entry.file.name}</Text>
        <Text style={styles.small}>{formatBytes(entry.file.size)} · {entry.status === 'checking' ? '…' : kindLabel(entry)}</Text>
        {entry.message && entry.status !== 'duplicate' && <Text style={[styles.small, { color: panel.danger }]}>{entry.message}</Text>}
      </View>
      {!phone && (sending ? progress : <View style={{ flex: 1 }} />)}
      {/* Pills align to the top by default (made for columns); in a row they must be centred. */}
      <View style={{ alignSelf: 'center' }}><Pill label={p.label} bg={p.bg} fg={p.fg} /></View>
      {onRemove && (
        <Pressable accessibilityRole="button" accessibilityLabel={`Remover ${entry.file.name}`} onPress={onRemove}>
          <X size={17} color={panel.muted} strokeWidth={1.6} absoluteStrokeWidth />
        </Pressable>
      )}
      {phone && sending && progress}
    </View>
  );
}

/** The file chooser's filter. Only a convenience: the type is checked by the signature, here and on the server. */
function accept(rules: UploadRules): string {
  const types = 'image/jpeg,.jpg,.jpeg,image/png,.png,image/webp,.webp,image/heic,image/heif,.heic,.heif';
  return rules.raw_enabled ? `${types},${rules.raw_extensions.map((e) => `.${e}`).join(',')}` : types;
}

/** Send photos to an event: choose the files, check them, and follow the upload. */
export default function UploadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [event, setEvent] = useState<EventItem | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [phase, setPhase] = useState<'select' | 'sending' | 'finished'>('select');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rules, setRules] = useState<UploadRules | null>(null);
  const files = useRef(new Map<string, File>());
  const cancelled = useRef(false);
  // 28/10/2026: the files beyond the 500 of a batch WAIT instead of being dropped. Duplicates and invalid files
  // do not take a place, so the waiting ones come in as soon as there is room, or in the next batch.
  const waitingFiles = useRef<File[]>([]);
  const [waitingCount, setWaitingCount] = useState(0);
  const current = useRef<Entry[]>([]);
  const videoQueue = useVideoQueue();
  useEffect(() => { current.current = entries; }, [entries]);

  // 03/11/2026: photos first. While photos are being sent, or wait here for "Iniciar envio", the next video
  // waits. Photos left behind on another page do not hold them: the router keeps this screen mounted in the history.
  const focused = useIsFocused();
  const photosPending = phase === 'sending'
    || (focused && phase === 'select' && entries.some((e) => e.status === 'checking' || e.status === 'valid'));
  useEffect(() => (photosPending ? holdForPhotos() : undefined), [photosPending]);

  useEffect(() => { getEvent(id).then(setEvent).catch((e) => setError(e.message)); }, [id]);
  // What this event accepts: RAW only if whoever manages it turned it on in the event form.
  useEffect(() => { getUploadRules(id).then(setRules).catch((e) => setError(e.message)); }, [id]);
  // Free the previews when leaving the screen. Read from the ref: `entries` here would be the list of the first render
  // (empty), so nothing was freed (08/11/2026). In the app a RAW preview is a file with the photo (files.native.ts).
  useEffect(() => () => current.current.forEach((e) => releasePreview(e.previewUrl)), []);

  // Warn before closing the tab in the middle of a batch (web).
  useEffect(() => {
    if (Platform.OS !== 'web' || phase !== 'sending') return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };   // returnValue: older Safari
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [phase]);

  const update = useCallback((key: string, patch: Partial<Entry>) => {
    setEntries((list) => list.map((e) => (e.key === key ? { ...e, ...patch } : e)));
  }, []);

  /** 02/11/2026: this is where a person goes to send, so a video goes in here too, on its own way: into the line
   *  of videos, counted in the corner of the screen. It has no checks to confirm in the list of photos. */
  function choose(selected: File[]) {
    const video = selected.filter(isVideoFile);
    const photos = selected.filter((f) => !isVideoFile(f));
    // The photos hold the line from this instant: the hold above only starts after the next render, and by then
    // the first video would already be on its way.
    const bridge = photos.length ? holdForPhotos() : undefined;
    if (video.length && event) enqueueVideos(id, event.name, video, event.can_manage);
    if (photos.length) void addFiles(photos).finally(bridge);
  }

  async function addFiles(selected: File[], base: Entry[] = current.current) {
    if (!rules) return;
    setError(null);
    const room = Math.max(0, MAX_FILES_PER_BATCH - base.filter(takesPlace).length);
    waitingFiles.current = [...waitingFiles.current, ...selected.slice(room)];
    setWaitingCount(waitingFiles.current.length);
    const fresh = newEntries(selected.slice(0, room));
    if (!fresh.length) return;
    fresh.forEach((e) => files.current.set(e.key, e.file));
    let list = [...base, ...fresh];
    setEntries(list);
    setChecking(true);
    try {
      const listed = base.filter((e) => e.sha256 && takesPlace(e)).map((e) => e.sha256!);
      const checked = await validate(id, fresh, rules, listed);
      list = list.map((e) => checked.find((c) => c.key === e.key) ?? e);
      setEntries(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível verificar os arquivos.');
      return;
    } finally {
      setChecking(false);
    }
    await fillRoom(list);
  }

  /** Brings in the waiting files while there is room in the batch. */
  async function fillRoom(list: Entry[]) {
    if (waitingFiles.current.length && list.filter(takesPlace).length < MAX_FILES_PER_BATCH) {
      const next = waitingFiles.current;
      waitingFiles.current = [];
      await addFiles(next, list);
    }
  }

  function remove(keys: string[]) {
    const list = current.current.filter((e) => !keys.includes(e.key));
    // The RAW preview of a removed row goes at once (in the app it is a file with the photo: files.native.ts).
    current.current.filter((e) => keys.includes(e.key)).forEach((e) => releasePreview(e.previewUrl));
    keys.forEach((k) => files.current.delete(k));
    setEntries(list);
    void fillRoom(list);
  }

  /** After a batch: the next files that were waiting, in a new batch. */
  function nextBatch() {
    const next = waitingFiles.current;
    waitingFiles.current = [];
    files.current.clear();
    current.current.forEach((e) => releasePreview(e.previewUrl));
    setEntries([]);
    setPhase('select');
    void addFiles(next, []);
  }

  async function start(keys: string[]) {
    setPhase('sending');
    cancelled.current = false;
    keys.forEach((k) => update(k, { status: 'waiting', progress: 0, message: undefined }));
    await runQueue(id, keys, update, (k) => files.current.get(k), () => cancelled.current);
    setPhase('finished');
  }

  if (error && !event) return <Notice tone="danger" icon={TriangleAlert} title="Evento indisponível" description={error} />;
  if (!event || !rules) return <Card><ActivityIndicator color={panel.primary} /></Card>;

  const valid = entries.filter((e) => e.status === 'valid');
  const duplicates = entries.filter((e) => e.status === 'duplicate');
  const raws = valid.filter((e) => e.kind === 'raw');
  const sent = entries.filter((e) => e.status === 'done').length;
  const failed = entries.filter((e) => e.status === 'failed');
  const queue = entries.filter((e) => ['waiting', 'sending', 'done', 'failed'].includes(e.status));
  const waiting = entries.filter((e) => e.status === 'waiting' || e.status === 'sending').length;
  const percent = queue.length ? Math.round(queue.reduce((s, e) => s + e.progress, 0) / queue.length) : 0;

  // Only what still has to leave this computer: once sent, the count in the corner follows the conversion.
  const videosHere = videoQueue.items.filter((v) => v.eventId === id && (v.stage === 'waiting' || v.stage === 'sending')).length;
  const videoBlock = videosHere > 0 && (
    <Notice tone="info" icon={VideoIcon}
            title={videosHere === 1 ? '1 vídeo na fila de envio' : `${videosHere} vídeos na fila de envio`}
            description={photosPending
              ? 'Vídeos demoram mais para enviar. As fotos vão primeiro; os vídeos começam sozinhos logo depois, um por vez. Acompanhe a contagem no canto da tela.'
              : 'Vídeos demoram mais para enviar: vão um por vez. Acompanhe a contagem no canto da tela e continue trabalhando em outras telas, sem fechar esta aba.'} />
  );

  if (phase !== 'select') {
    return (
      <>
        {/* The way back exists while sending too (31/10/2026); leaving mid-batch stops it, so it asks first. */}
        <PageHeader crumbs={[{ label: 'Eventos', href: '/eventos' }, { label: event.name, href: `/eventos/${id}` },
                             { label: phase === 'finished' ? 'Envio concluído' : 'Enviando imagens' }]}
                    title={phase === 'finished' ? 'Envio concluído' : 'Enviando imagens'} subtitle={event.name}
                    confirmLeave={phase === 'finished' ? undefined : 'As imagens ainda estão sendo enviadas. Se sair agora, o envio para. Sair mesmo assim?'} />
        {videoBlock}
        <Card padding={22} style={{ gap: 12 }}>
          <View style={styles.between}>
            <Text style={styles.big}>{sent} de {queue.length} imagens enviadas</Text>
            <Text style={styles.percent}>{percent}%</Text>
          </View>
          <ProgressBar percent={percent} />
          <Text style={styles.small}>
            {phase === 'finished' ? 'Lote finalizado. As imagens estão em conferência e ainda não são públicas.'
              : 'Mantenha esta página aberta enquanto o lote é enviado.'}
          </Text>
        </Card>
        <Card padding={18}>
          <View style={[styles.between, { flexWrap: 'wrap', gap: 16 }]}>
            {[['Enviadas com sucesso', sent], ['Falhas', failed.length], ['Na fila', waiting]].map(([label, value]) => (
              <View key={label as string} style={{ gap: 5, flexGrow: 1, minWidth: 140 }}>
                <Text style={styles.small}>{label}</Text>
                <Text style={styles.big20}>{value}</Text>
              </View>
            ))}
            {/* D5 (17/10/2026): ends in the Imagens tab, on what was just sent, with "Publicar" at hand. */}
            {phase === 'finished' && waitingCount > 0 ? (
              <Button label={`Enviar as próximas ${waitingCount}`} onPress={nextBatch} />
            ) : (
              <Button label="Conferir e publicar" disabled={phase !== 'finished' || sent === 0}
                      onPress={() => router.replace(`/eventos/${id}/imagens?filtro=in_review`)} />
            )}
          </View>
        </Card>
        {/* 31/10/2026: the totals, the button and the failures before the list of files (up to 500 rows). */}
        {failed.length > 0 && (
          // The photo identifies the file (images have no name in the system).
          <Notice tone="danger" icon={TriangleAlert}
                  title={failed.length === 1 ? 'Esta imagem não conseguiu ser renderizada ou enviada' : `${failed.length} imagens não conseguiram ser renderizadas ou enviadas`}
                  description="As demais imagens seguem normalmente. Tente reenviar somente os arquivos com falha."
                  actionLabel={phase === 'finished' ? 'Tentar novamente' : undefined}
                  onAction={() => start(failed.map((e) => e.key))} />
        )}
        <Card padding={18} style={{ gap: 4 }}>
          {queue.map((e, i) => (
            <View key={e.key}>
              {i > 0 && <View style={styles.divider} />}
              <FileRow entry={e} sending />
            </View>
          ))}
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader crumbs={[{ label: 'Eventos', href: '/eventos' }, { label: event.name, href: `/eventos/${id}` }, { label: 'Enviar imagens e vídeos' }]}
                  title="Enviar imagens e vídeos" />
      {videoBlock}
      <Dropzone onFiles={choose} accept={`${accept(rules)},${VIDEO_ACCEPT}`} title="Arraste suas fotos e vídeos aqui" phoneTitle="Toque para escolher fotos e vídeos" />
      <Card padding={16}>
        <View style={styles.rules}>
          <Pill label={`${rules.formats.join(', ')}${rules.raw_enabled ? ' e RAW' : ''}`} />
          <Pill label="Máximo de 25 MB por imagem" bg={panel.page} fg={panel.muted} />
          {rules.raw_enabled && rules.max_raw_bytes && (
            <Pill label={`RAW até ${Math.round(rules.max_raw_bytes / 1024 ** 2)} MB`} bg={panel.page} fg={panel.muted} />)}
          <Pill label={`Máximo de ${MAX_FILES_PER_BATCH} arquivos por envio`} bg={panel.page} fg={panel.muted} />
          <Pill label={`Vídeos MP4, MOV e outros, até ${sizeLabel(rules.max_video_bytes)} e ${Math.round(rules.max_video_seconds / 60)} minutos`} bg={panel.page} fg={panel.muted} />
          <Pill label="Máximo de 1.000 mídias por evento" bg={panel.page} fg={panel.muted} />
        </View>
      </Card>
      {error && <Notice tone="danger" icon={TriangleAlert} title={error} />}
      {/* 21/10/2026: RAW is free to send (nobody approves it); whoever sends is told the cost and decides. */}
      {raws.length > 0 && (
        <Notice tone="warning" icon={Info}
                title={raws.length === 1 ? '1 arquivo RAW selecionado' : `${raws.length} arquivos RAW selecionados`}
                description={`Arquivos RAW ocupam de 3 a 5 vezes o espaço de um JPEG (${formatBytes(raws.reduce((t, e) => t + e.file.size, 0))} nesta seleção) e demoram mais para enviar e processar; muitos de uma vez podem sobrecarregar o servidor. Além disso, o sistema revela o RAW com os ajustes padrão da câmera, sem a sua edição. Recomendado: enviar a fotografia editada e exportada em JPEG de alta qualidade (até 25 MB). Se preferir o RAW, o envio segue normalmente.`} />
      )}
      {entries.length > 0 && (
        <Card padding={18} style={{ gap: 8 }}>
          <SectionTitle title={`Arquivos selecionados · ${entries.length}`} action={checking ? <ActivityIndicator color={panel.primary} /> : undefined} />
          {/* On top: with hundreds of files, a notice at the end of the list is never seen. */}
          {duplicates.length > 0 && (
            <Notice tone="warning" icon={Info}
                    title={duplicates.length === 1 ? '1 arquivo duplicado' : `${duplicates.length} arquivos duplicados`}
                    description="Já estão no acervo do evento (ou repetidos na seleção) e não serão enviados de novo. Eles não ocupam lugar entre os 500 do envio."
                    actionLabel="Tirar os duplicados da lista" onAction={() => remove(duplicates.map((e) => e.key))} />
          )}
          {waitingCount > 0 && (
            <Notice tone="info" icon={Info}
                    title={waitingCount === 1 ? '1 arquivo aguarda a vez' : `${waitingCount} arquivos aguardam a vez`}
                    description={`Cada envio leva até ${MAX_FILES_PER_BATCH} imagens. Eles entram na lista quando houver lugar (ao tirar duplicados ou arquivos) ou no próximo envio, logo depois deste.`} />
          )}
          {entries.map((e, i) => (
            <View key={e.key}>
              {i > 0 && <View style={styles.divider} />}
              <FileRow entry={e} sending={false} onRemove={() => remove([e.key])} />
            </View>
          ))}
          <View style={styles.actions}>
            <Button variant="secondary" label="Cancelar" onPress={() => router.navigate(`/eventos/${id}`)} />
            <Button label={valid.length ? `Iniciar envio (${valid.length})` : 'Iniciar envio'} disabled={!valid.length || checking}
                    onPress={() => start(valid.map((e) => e.key))} />
          </View>
        </Card>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  rules: { flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 },
  file: { minHeight: 62, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6 },
  thumb: { width: 54, height: 42, borderRadius: 10, backgroundColor: panel.page },
  noPreview: { alignItems: 'center', justifyContent: 'center', gap: 1 },
  fileName: { fontFamily: fonts.bold, fontSize: 14, color: panel.text },
  small: { fontFamily: fonts.regular, fontSize: 12, color: panel.muted },
  tiny: { fontFamily: fonts.regular, fontSize: 11, color: panel.muted },
  divider: { height: 1, backgroundColor: panel.border },
  actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 12, marginTop: 8 },
  between: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  big: { fontFamily: fonts.regular, fontSize: 16, color: panel.text },
  big20: { fontFamily: fonts.regular, fontSize: 20, color: panel.text },
  percent: { fontFamily: fonts.bold, fontSize: 14, color: panel.primary },
});
