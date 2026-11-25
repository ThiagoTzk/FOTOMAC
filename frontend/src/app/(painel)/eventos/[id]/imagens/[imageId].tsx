import * as DocumentPicker from 'expo-document-picker';
import { Image } from '@/ui/Image';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { ArchiveRestore, ChevronLeft, ChevronRight, CircleCheck, Clock, Download, Expand, EyeOff, FileUp, RefreshCw, Trash2, TriangleAlert, X } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { getEvent, type EventItem } from '@/api/events';
import { API_URL, api, ApiError, appendFile } from '@/api/client';
import {
  decideApproval, deleteImage, discardImage, formatDateTime, getImage, imageDownloadLink, listImages, previewUrl,
  reprocessImage, restoreImage, thumbUrl,
  type ImageFilter, type ImageItem,
} from '@/api/images';
import { useAuth } from '@/auth/AuthContext';
import { BlurEditor, canBlur } from '@/components/panel/BlurEditor';
import { FileDetails } from '@/components/panel/FileDetails';
import { FullscreenViewer } from '@/components/panel/FullscreenViewer';
import { imageStatus } from '@/components/panel/ImageCard';
import { Modal } from '@/components/panel/Modal';
import { PageHeader } from '@/components/panel/PageHeader';
import { Button, Card, Field, Input, Notice, Pill, SectionTitle } from '@/components/panel/ui';
import { usePhone } from '@/theme/accessibility';
import { fonts, panel } from '@/theme/tokens';
import { saveFile } from '@/ui/saveFile';

const REPLACE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/x-adobe-dng', 'image/*'];

const INDEXING: Record<string, string> = {
  not_queued: 'Aguardando publicação', pending: 'Na fila de indexação', processed: 'Processada',
  no_faces: 'Sem faces detectadas', failed: 'Falha no processamento',
};

function Info({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ gap: 5 }}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value}>{value}</Text>
    </View>
  );
}

/** One photo of an event: details, the decisions on it, and the full-screen view. */
export default function ImageScreen() {
  const { id, imageId, filtro } = useLocalSearchParams<{ id: string; imageId: string; filtro?: ImageFilter }>();
  const filter: ImageFilter = filtro ?? 'all';
  const [ids, setIds] = useState<string[]>([]);  // the photos of the list it was opened from, in order
  const [event, setEvent] = useState<EventItem | null>(null);
  const [image, setImage] = useState<ImageItem | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [blurring, setBlurring] = useState(false);
  const { account } = useAuth();
  const phone = usePhone();   // no keyboard on a phone: no "use ← →" hint
  // The photo asked for last: a slow answer for a photo already left behind (fast ← →) is ignored.
  const wanted = useRef(imageId);

  useFocusEffect(useCallback(() => {
    getEvent(id).then(setEvent).catch(() => undefined);
    listImages(id, filter).then((r) => setIds(r.items.map((i) => i.id))).catch(() => undefined);
  }, [id, filter]));
  // The previous photo stays on screen until the next one arrives: no blank page, no jump to the top.
  useFocusEffect(useCallback(() => {
    wanted.current = imageId;
    getImage(imageId).then((img) => { if (wanted.current === img.id) setImage(img); }).catch((e) => setError(e.message));
  }, [imageId]));

  // Previous / next photo of the same list, without going back to the grid (buttons, ← → keys, swipe).
  const pos = ids.indexOf(imageId);
  const prev = pos > 0 ? ids[pos - 1] : undefined;
  const next = pos >= 0 && pos < ids.length - 1 ? ids[pos + 1] : undefined;
  // setParams, not a new route: the screen stays mounted, so the scroll position and the full-screen
  // view survive the change of photo (it used to go back to the top every time).
  const open = useCallback((target?: string, list: ImageFilter = filter) => {
    if (target) { setError(null); router.setParams({ imageId: target, filtro: list }); }
  }, [filter]);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const onKey = (e: KeyboardEvent) => {
      // Never while typing (the reason of a rejection is a multi-line box) or with a dialog open.
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName) || confirm || rejecting || blurring) return;
      // The same keys inside the full-screen view: it is a view of this page, not another page.
      if (e.key === 'ArrowLeft') open(prev);
      if (e.key === 'ArrowRight') open(next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [prev, next, open, confirm, rejecting, blurring]);

  if (error && !image) return <Notice tone="danger" icon={TriangleAlert} title="Imagem indisponível" description={error} />;
  if (!event || !image) return <Card><ActivityIndicator color={panel.primary} /></Card>;

  async function remove() {
    setBusy(true);
    try { await deleteImage(image!.id); router.replace(`/eventos/${id}/imagens`); }
    catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível excluir.'); setConfirm(false); }
    finally { setBusy(false); }
  }

  /** Discarding is reversible until the publication; then it becomes definitive. */
  async function toggleDiscard() {
    setError(null);
    try { setImage(await (image!.review_status === 'discarded' ? restoreImage(image!.id) : discardImage(image!.id))); }
    catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível alterar a imagem.'); }
  }

  /** An edited version replaces the file before publication. A hired photographer's photo goes
   *  back to the administrator's approval: the approval was about the old file. */
  async function replaceFile() {
    // The same formats as the upload; the server checks the binary signature.
    const r = await DocumentPicker.getDocumentAsync({ type: REPLACE_TYPES, copyToCacheDirectory: false });
    if (r.canceled || !r.assets?.[0]) return;
    const a = r.assets[0] as DocumentPicker.DocumentPickerAsset & { file?: File };
    const form = new FormData();
    appendFile(form, 'file', Platform.OS === 'web' && a.file ? a.file : { uri: a.uri, type: a.mimeType ?? 'application/octet-stream' }, a.name);
    setBusy(true); setError(null);
    try { setImage(await api<ImageItem>(`/images/${image!.id}/file`, { method: 'PUT', body: form })); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Não foi possível substituir o arquivo.'); }
    finally { setBusy(false); }
  }

  /** JPEG with the credits and the ownership notice, WITHOUT watermark: the accounts work for CESMAC.
   *  The id is a parameter (React Compiler: never read `image` inside a memoized function). */
  async function download(imageId: string) {
    setError(null);
    try {
      const { url } = await imageDownloadLink(imageId);
      await saveFile(`${API_URL}${url}`, 'Salvar imagem');   // the site: the browser saves it; the app: Salvar/Compartilhar
    } catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível baixar. Tente novamente.'); }
  }

  async function reprocess() {
    setError(null);
    try { setImage(await reprocessImage(image!.id)); } catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível reprocessar.'); }
  }

  /** The administrator decides on a hired photographer's photo. Rejecting needs a reason
   *  (22/10/2026): the sender reads it, and the photo is eliminated 7 days later. */
  async function decide(approve: boolean, why?: string) {
    setError(null);
    try {
      const r = await decideApproval(image!.id, approve, why);
      setRejecting(false); setReason('');
      // Straight to the next photo still waiting — reviewing 200 photos must not mean 200 round trips.
      const waiting = (await listImages(id, 'pending_approval')).items.map((i) => i.id);
      if (waiting.length) open(waiting[0], 'pending_approval');
      else setImage(r.image);
    } catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível registrar a decisão.'); }
  }

  const faces = image.faces_count === null ? 'Ainda não processada'
    : image.faces_count === 0 ? 'Nenhum rosto detectado' : `${image.faces_count} ${image.faces_count === 1 ? 'rosto detectado e indexado' : 'rostos detectados e indexados'}`;
  const published = image.review_status === 'published';
  return (
    <>
      {/* Images have no name: the breadcrumb says "Imagem", identified by the photo itself. */}
      <PageHeader crumbs={[{ label: 'Eventos', href: '/eventos' }, { label: event.name, href: `/eventos/${id}` },
                           { label: 'Imagens', href: `/eventos/${id}/imagens` }, { label: 'Imagem' }]}
                  title={published ? 'Imagem publicada' : image.review_status === 'discarded' ? 'Imagem descartada'
                    : image.approval === 'rejected' ? 'Imagem recusada' : 'Imagem em conferência'}
                  actions={image.can_manage || image.can_download ? (
                    <>
                      {image.can_download && <Button variant="secondary" icon={Download} label="Baixar imagem" onPress={() => download(image.id)} />}
                      {image.can_manage && published && <Button variant="secondary" icon={RefreshCw} label="Reprocessar imagem" onPress={reprocess} />}
                      {/* 22/10/2026: the hired photographer sends a new image instead of replacing (the server refuses it too). */}
                      {image.can_manage && image.review_status === 'in_review' && image.approval !== 'rejected' && account?.role !== 'contractor' && (
                        <Button variant="secondary" icon={FileUp} label="Substituir arquivo" onPress={replaceFile} loading={busy} />)}
                      {/* Like replacing the file, not for the hired photographer (the server refuses it too). */}
                      {canBlur(image, account?.role) && (
                        <Button variant="secondary" icon={EyeOff} label="Borrar rostos" onPress={() => setBlurring(true)} />)}
                      {image.can_manage && !published && image.approval !== 'rejected' && (
                        <Button variant="secondary" icon={image.review_status === 'discarded' ? ArchiveRestore : X}
                                label={image.review_status === 'discarded' ? 'Desfazer descarte' : 'Descartar'} onPress={toggleDiscard} />)}
                      {image.can_manage && <Button variant="danger" icon={Trash2} label="Excluir imagem" onPress={() => setConfirm(true)} />}
                    </>) : undefined} />
      {image.removal_deadline && (
        // Deletion is automatic at the deadline.
        <Notice tone="danger" icon={TriangleAlert} title="Remoção solicitada"
                description={`Uma pessoa retratada pediu a remoção desta imagem. Ela já não aparece nas buscas e será excluída automaticamente em ${formatDateTime(image.removal_deadline)}, caso não seja excluída antes.`} />
      )}
      {image.approval === 'pending' && (
        <Notice tone="warning" icon={Clock} title="Aguardando aprovação da administração"
                description={account?.role === 'admin'
                  ? 'Foto enviada por fotógrafo contratado. Ela só entra na publicação depois de aprovada. Recusada, o fotógrafo vê o motivo e ela é excluída em 7 dias, sem nunca gerar dado biométrico.'
                  : 'Foto enviada por fotógrafo contratado. Ela só entra na publicação depois que a administração aprovar.'} />
      )}
      {image.approval === 'pending' && account?.role === 'admin' && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, justifyContent: 'flex-end' }}>
          <Button variant="danger" icon={X} label="Recusar foto" onPress={() => setRejecting(true)} />
          <Button icon={CircleCheck} label="Aprovar foto" onPress={() => decide(true)} />
        </View>
      )}
      {image.failure && (
        <Notice tone={image.indexing_status === 'failed' ? 'danger' : 'warning'} icon={TriangleAlert}
                title={image.indexing_status === 'failed' ? 'O reconhecimento facial não processou esta foto' : 'Processando de novo'}
                description={`${image.failure}${image.indexing_status === 'failed' ? ' Enquanto isso, esta foto não aparece na busca dos visitantes.' : ''}`}
                actionLabel={image.indexing_status === 'failed' && image.can_manage ? 'Reprocessar imagem' : undefined}
                onAction={image.indexing_status === 'failed' && image.can_manage ? reprocess : undefined} />
      )}
      {image.approval === 'rejected' && (
        // The reason apart from the title: it is what the photographer came to read.
        <Notice tone="danger" icon={X} title="Recusada pela administração"
                description={`Esta foto não será publicada${image.eliminated_at ? ` e será excluída automaticamente em ${formatDateTime(image.eliminated_at)}` : ''}. Para enviar outra versão, envie-a como uma nova imagem.`}>
          <View style={styles.reason}>
            <Text style={styles.reasonLabel}>Motivo</Text>
            <Text style={styles.reasonText}>{image.rejection_reason}</Text>
          </View>
        </Notice>
      )}
      {error && <Notice tone="danger" icon={TriangleAlert} title={error} />}
      {ids.length > 1 && pos >= 0 && (
        <View style={styles.nav}>
          <Button variant="secondary" icon={ChevronLeft} label="Anterior" disabled={!prev} onPress={() => open(prev)} />
          <Text style={styles.navText}>
            Foto {pos + 1} de {ids.length}{filter === 'pending_approval' ? ' aguardando aprovação' : ''}{phone ? '' : ' · use ← → no teclado'}
          </Text>
          <Button variant="secondary" icon={ChevronRight} label="Próxima" disabled={!next} onPress={() => open(next)} />
        </View>
      )}
      <View style={styles.row}>
        <Card padding={12} style={styles.photoCard}>
          {/* Click = full screen with zoom. The photo here is only to recognise it. */}
          <Pressable accessibilityRole="button" accessibilityLabel="Ver a foto em tela cheia" onPress={() => setFullscreen(true)}
                     style={({ hovered }: any) => [styles.photoButton, hovered && { opacity: 0.94 }]}>
            <Image source={{ uri: previewUrl(image.id, image.version) }} placeholder={{ uri: thumbUrl(image.id, image.version) }}
                   style={styles.photo} contentFit="contain" recyclingKey={image.id} transition={0}
                   accessibilityLabel={`Imagem enviada por ${image.signature}`} />
            <View style={styles.expand}>
              <Expand size={15} color="#FFFFFF" strokeWidth={1.8} absoluteStrokeWidth />
              <Text style={styles.expandText}>Tela cheia</Text>
            </View>
          </Pressable>
        </Card>
        <Card padding={22} style={styles.meta}>
          <SectionTitle title="Detalhes" />
          <Info label="Evento" value={event.name} />
          <Info label="Data de envio" value={formatDateTime(image.uploaded_at)} />
          {image.captured_at && <Info label="Data de captura" value={formatDateTime(image.captured_at)} />}
          <Info label="Crédito do fotógrafo" value={image.credit} />
          <Info label="Enviada por" value={image.uploaded_by_name} />
          {image.approved_by_name && image.approved_at && (
            <Info label="Revisada e aprovada por" value={`${image.approved_by_name} em ${formatDateTime(image.approved_at)}`} />
          )}
          {!!image.institutional?.length && <Info label="Pessoa institucional localizada" value={image.institutional.join(', ')} />}
          <Info label="Status de processamento" value={INDEXING[image.indexing_status]} />
          <Info label="Indexação facial" value={faces} />
          <View style={styles.divider} />
          <Text style={styles.label}>ARQUIVO</Text>
          <FileDetails imageId={image.id} />
          <View style={styles.divider} />
          <Text style={styles.note}>Informações biométricas internas não são exibidas nesta área.</Text>
        </Card>
      </View>

      <FullscreenViewer visible={fullscreen} onClose={() => setFullscreen(false)}
                        uri={previewUrl(image.id, image.version)} placeholder={thumbUrl(image.id, image.version)}
                        alt={`Imagem enviada por ${image.signature}`}
                        title={pos >= 0 && ids.length ? `Foto ${pos + 1} de ${ids.length}` : 'Foto'}
                        subtitle={`${event.name} · ${image.credit}`}
                        onPrev={prev ? () => open(prev) : undefined} onNext={next ? () => open(next) : undefined}
                        info={<Pill label={imageStatus(image).label} bg={imageStatus(image).bg} fg={imageStatus(image).fg} />}
                        details={<FileDetails imageId={image.id} dark />}>
        {image.approval === 'pending' && account?.role === 'admin' && (
          <>
            <Button variant="danger" icon={X} label="Recusar foto" onPress={() => setRejecting(true)} />
            <Button icon={CircleCheck} label="Aprovar foto" onPress={() => decide(true)} />
          </>
        )}
        {image.can_manage && !published && image.approval !== 'rejected' && image.approval !== 'pending' && (
          <Button variant="secondary" icon={image.review_status === 'discarded' ? ArchiveRestore : X}
                  label={image.review_status === 'discarded' ? 'Desfazer descarte' : 'Descartar'} onPress={toggleDiscard} />)}
        {image.can_download && <Button variant="secondary" icon={Download} label="Baixar imagem" onPress={() => download(image.id)} />}
      </FullscreenViewer>
      <Modal visible={rejecting} onClose={() => setRejecting(false)} icon={X} tone="danger" title="Recusar esta foto?" width={520}>
        <Text style={styles.text}>
          O fotógrafo contratado vê o motivo. A foto nunca é publicada nem gera dado biométrico, e é excluída automaticamente em 7 dias.
        </Text>
        <Field label="Motivo da recusa" help={`${reason.trim().length} de 300 · obrigatório`}>
          <Input multiline value={reason} onChangeText={setReason} maxLength={300} placeholder="Ex.: fora de foco; não pertence a este evento"
                 accessibilityLabel="Motivo da recusa" />
        </Field>
        <View style={styles.actions}>
          <Button variant="secondary" label="Cancelar" onPress={() => setRejecting(false)} />
          <Button variant="danger" label="Recusar" disabled={reason.trim().length < 5} onPress={() => decide(false, reason)} />
        </View>
      </Modal>
      <Modal visible={blurring} onClose={() => setBlurring(false)} icon={EyeOff} title="Borrar rostos" width={1000}>
        {blurring && <BlurEditor image={image} height={540} onDone={(updated) => { setImage(updated); setBlurring(false); }} />}
      </Modal>
      <Modal visible={confirm} onClose={() => setConfirm(false)} icon={Trash2} tone="danger" title="Excluir imagem?" width={500}>
        <Image source={{ uri: thumbUrl(image.id, image.version) }} style={styles.modalPhoto} contentFit="cover"
               accessibilityLabel="A imagem desta página" />
        <Text style={styles.text}>
          {published ? 'Excluir esta foto publicada também removerá os dados associados à indexação facial. ' : ''}Esta ação não poderá ser desfeita.
        </Text>
        <View style={styles.actions}>
          <Button variant="secondary" label="Cancelar" onPress={() => setConfirm(false)} />
          <Button variant="danger" label="Excluir imagem" onPress={remove} loading={busy} />
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  nav: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' },
  navText: { fontFamily: fonts.regular, fontSize: 13, color: panel.muted },
  row: { flexDirection: 'row', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' },
  // Shrinks below 420 px on a phone, instead of running past the screen.
  photoCard: { flexGrow: 2, flexBasis: 420, flexShrink: 1, minWidth: 0, maxWidth: '100%' },
  photoButton: { cursor: 'zoom-in' as never },
  photo: { width: '100%', aspectRatio: 696 / 520, maxHeight: '75vh' as never, borderRadius: 10, backgroundColor: panel.page },
  expand: { position: 'absolute', right: 10, bottom: 10, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10,
            paddingVertical: 6, borderRadius: 8, backgroundColor: 'rgba(9, 38, 56, 0.72)' },
  expandText: { fontFamily: fonts.semiBold, fontSize: 12, color: '#FFFFFF' },
  meta: { flexGrow: 1, flexBasis: 300, flexShrink: 1, minWidth: 0, maxWidth: '100%', gap: 18 },
  label: { fontFamily: fonts.bold, fontSize: 12, color: panel.muted },
  value: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: panel.text },
  divider: { height: 1, backgroundColor: panel.border },
  note: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 17, color: panel.muted },
  modalPhoto: { width: '100%', height: 210, borderRadius: 10, backgroundColor: panel.page },
  text: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 21, color: panel.muted },
  actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 12 },
  reason: { marginTop: 8, padding: 12, borderRadius: 8, backgroundColor: panel.surface, gap: 3 },
  reasonLabel: { fontFamily: fonts.bold, fontSize: 12, color: panel.danger },
  reasonText: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: panel.text },
});
