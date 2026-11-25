import { router } from 'expo-router';
import { ChevronDown, ChevronUp, Video as VideoIcon, X } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { formatBytes } from '@/api/images';
import { useAuth } from '@/auth/AuthContext';
import { ProgressBar } from '@/components/panel/Progress';
import { clearFinished, resetVideos, setCornerHeight, useVideoQueue, videoCornerHidden, type QueuedVideo } from '@/components/panel/videoQueue';
import { fonts, panel } from '@/theme/tokens';

function stageText(v: QueuedVideo): string {
  if (v.stage === 'waiting') return 'Na fila';
  if (v.stage === 'sending') return v.progress < 100 ? `Enviando: ${v.progress}%` : 'Recebido. Removendo a localização…';
  if (v.stage === 'converting') return 'Convertendo no servidor';
  if (v.stage === 'ready') {
    if (v.canPublish) return 'Pronto. Falta publicar';
    return v.awaitsApproval ? 'Pronto. Aguarda a aprovação' : 'Pronto. Quem publica é o responsável pelo evento';
  }
  return v.error ?? 'Falha';
}

function IconButton({ label, onPress, children }: { label: string; onPress: () => void; children: React.ReactNode }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
               style={({ hovered }: any) => [styles.icon, hovered && { backgroundColor: panel.primarySoft }]}>
      {children}
    </Pressable>
  );
}

type Group = { eventId: string; eventName: string; items: QueuedVideo[] };

/** One block per event (05/11/2026): "Enviando 10 vídeos para Colação de grau", its own button. */
function groupsOf(items: QueuedVideo[]): Group[] {
  const out: Group[] = [];
  for (const v of items) {
    const g = out.find((x) => x.eventId === v.eventId);
    if (g) g.items.push(v); else out.push({ eventId: v.eventId, eventName: v.eventName, items: [v] });
  }
  return out;
}

const videos = (n: number) => `${n} ${n === 1 ? 'vídeo' : 'vídeos'}`;

/** What is happening with this event's videos now, in one sentence, and whether it still needs someone. */
function summary(g: Group, waitingForPhotos: boolean): { text: string; tone: 'muted' | 'warning' | 'success' | 'danger'; open: boolean } {
  const n = g.items.length;
  const count = (stage: QueuedVideo['stage']) => g.items.filter((v) => v.stage === stage).length;
  const sending = g.items.find((v) => v.stage === 'sending');
  const waiting = count('waiting');
  const converting = count('converting');
  const ready = g.items.filter((v) => v.stage === 'ready');
  const toPublish = ready.filter((v) => v.canPublish).length;
  const failed = count('failed');
  const problem = failed ? ` ${failed} com problema.` : '';
  if (sending) {
    const sent = g.items.indexOf(sending) + 1;
    return { text: `Enviando ${sent} de ${n}: ${sending.progress < 100 ? `${sending.progress}%` : 'removendo a localização'}.${problem}`, tone: 'muted', open: true };
  }
  if (waiting) {
    return { text: `${videos(waiting)} na fila${waitingForPhotos ? ', depois das fotos' : ''}.${problem}`, tone: 'muted', open: true };
  }
  if (converting) return { text: `Convertendo ${converting} de ${n} no servidor. Pode fechar a aba.${problem}`, tone: 'muted', open: true };
  if (toPublish) {
    return { text: `${toPublish === 1 ? 'O vídeo terminou de enviar' : `Os ${toPublish} vídeos terminaram de enviar`}. Falta publicar.${problem}`,
             tone: 'warning', open: true };
  }
  if (ready.some((v) => v.awaitsApproval)) {
    return { text: `${videos(ready.length)} ${ready.length === 1 ? 'pronto, aguarda' : 'prontos, aguardam'} a aprovação da administração.${problem}`, tone: 'success', open: false };
  }
  // A collaborator: done on its side; the responsible for the event publishes.
  if (ready.length) return { text: `${videos(ready.length)} ${ready.length === 1 ? 'pronto' : 'prontos'}. Quem publica é o responsável pelo evento.${problem}`, tone: 'success', open: false };
  return { text: `Terminou, mas ${videos(failed)} ${failed === 1 ? 'teve' : 'tiveram'} problema. Veja os detalhes.`, tone: 'danger', open: false };
}

const TONE = { muted: panel.muted, warning: panel.warning, success: panel.success, danger: panel.danger };

/**
 * The videos on their way, in a corner of every page (03/11/2026), one block per event (05/11/2026): what
 * happens with that event's videos, its bar, and a button to its Vídeos tab. A block whose videos are converted
 * keeps saying "Falta publicar" until they are published: the work is not done when the upload ends. Mounted once,
 * in the root layout (a copy per screen would pile up, see nao-criar-janela-global-por-tela).
 */
export function VideoProgress() {
  const { account } = useAuth();
  const { items, waitingForPhotos } = useVideoQueue();
  const { width } = useWindowDimensions();
  const [small, setSmall] = useState(false);
  const [details, setDetails] = useState(false);
  const owner = useRef<string | null>(null);

  // The line belongs to whoever chose the files: a logout or another account stops it and forgets the names.
  useEffect(() => {
    const id = account?.id ?? null;
    if (owner.current && owner.current !== id) resetVideos();
    owner.current = id;
  }, [account?.id]);

  if (Platform.OS !== 'web' || !account || !items.length || videoCornerHidden()) return null;

  const groups = groupsOf(items);
  const total = items.length;
  const done = items.filter((v) => v.stage === 'ready' || v.stage === 'failed').length;
  const moving = items.some((v) => v.stage === 'waiting' || v.stage === 'sending');
  const toPublish = items.filter((v) => v.stage === 'ready' && v.canPublish).length;
  const title = moving || items.some((v) => v.stage === 'converting')
    ? `Vídeos: ${done} de ${total} ${total === 1 ? 'pronto' : 'prontos'}`
    : toPublish ? `Vídeos: ${toPublish} para publicar` : 'Vídeos';
  const box = { width: Math.min(380, width - 32) };

  if (small) {
    return (
      <Pressable accessibilityRole="button" accessibilityLabel={`${title}. Mostrar o envio de vídeos`} onPress={() => setSmall(false)}
                 style={[styles.frame, styles.pill]}>
        <VideoIcon size={18} color={panel.primary} strokeWidth={1.8} absoluteStrokeWidth />
        <Text style={styles.pillText}>{toPublish && !moving ? `${toPublish} para publicar` : `${done}/${total}`}</Text>
        <ChevronUp size={16} color={panel.muted} strokeWidth={1.8} absoluteStrokeWidth />
      </Pressable>
    );
  }

  return (
    <View role="region" aria-label="Envio de vídeos" style={[styles.frame, styles.card, box]}
          onLayout={(e) => setCornerHeight(e.nativeEvent.layout.height)}>
      <View style={styles.head}>
        <VideoIcon size={18} color={panel.primary} strokeWidth={1.8} absoluteStrokeWidth />
        {/* Read aloud each time one more video is ready; the percentages are not, they change every second. */}
        <Text style={styles.title} accessibilityLiveRegion="polite" aria-live="polite">{title}</Text>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: details }} aria-expanded={details}
                   onPress={() => setDetails(!details)} style={styles.link}>
          <Text style={styles.linkText}>{details ? 'Menos' : 'Detalhes'}</Text>
        </Pressable>
        <IconButton label="Minimizar o envio de vídeos" onPress={() => setSmall(true)}>
          <ChevronDown size={18} color={panel.muted} strokeWidth={1.8} absoluteStrokeWidth />
        </IconButton>
      </View>

      <ScrollView style={styles.groups} contentContainerStyle={{ gap: 10 }}>
        {groups.map((g) => {
          const info = summary(g, waitingForPhotos);
          const finished = g.items.filter((v) => v.stage === 'ready' || v.stage === 'failed').length;
          return (
            <View key={g.eventId} style={styles.group} accessibilityLabel={`${g.eventName}: ${info.text}`}>
              <View style={styles.head}>
                <Text style={styles.event} numberOfLines={1}>
                  {videos(g.items.length)} para {g.eventName}
                </Text>
                {!info.open && (
                  <IconButton label={`Fechar o aviso de ${g.eventName}`} onPress={() => clearFinished(g.eventId)}>
                    <X size={16} color={panel.muted} strokeWidth={1.8} absoluteStrokeWidth />
                  </IconButton>
                )}
              </View>
              <ProgressBar percent={(100 * finished) / g.items.length} height={5} />
              <Text style={[styles.line, { color: TONE[info.tone] }]}>{info.text}</Text>
              {/* The reason at once for the last failures (a refused format says which ones are accepted). */}
              {!details && g.items.filter((v) => v.stage === 'failed').slice(-2).map((v) => (
                <Text key={v.key} style={[styles.line, { color: panel.danger }]} numberOfLines={3}>{v.name}: {v.error}</Text>
              ))}
              {details && g.items.map((v) => (
                <View key={v.key} style={{ gap: 1 }}>
                  <Text style={styles.name} numberOfLines={1}>{v.name} · {formatBytes(v.size)}</Text>
                  <Text style={[styles.line, v.stage === 'failed' && { color: panel.danger }, v.stage === 'ready' && { color: panel.success }]}>
                    {stageText(v)}
                  </Text>
                </View>
              ))}
              <Pressable accessibilityRole="link" onPress={() => router.navigate(`/eventos/${g.eventId}/videos`)} style={styles.go}>
                <Text style={styles.goText}>{info.tone === 'warning' ? `Publicar em Vídeos de ${g.eventName}` : `Ir para Vídeos de ${g.eventName}`}</Text>
              </Pressable>
            </View>
          );
        })}
      </ScrollView>

      {moving && <Text style={[styles.note, { color: panel.warning }]}>Não feche esta aba até o envio terminar. Pode usar outras telas.</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    position: 'fixed' as any, right: 16, bottom: 16, zIndex: 40, backgroundColor: panel.surface,
    borderWidth: 1, borderColor: panel.border, boxShadow: '0 6px 24px rgba(7, 45, 68, 0.18)',
  } as any,
  card: { borderRadius: 14, padding: 14, gap: 8 },
  pill: { borderRadius: 999, paddingHorizontal: 14, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 8 },
  pillText: { fontFamily: fonts.bold, fontSize: 14, color: panel.text },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { flex: 1, fontFamily: fonts.bold, fontSize: 15, color: panel.text },
  icon: { width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  line: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 18, color: panel.muted },
  note: { fontFamily: fonts.medium, fontSize: 13, lineHeight: 18, color: panel.muted },
  groups: { maxHeight: 360 },
  group: { gap: 6, paddingTop: 10, borderTopWidth: 1, borderColor: panel.borderSoft },
  event: { flex: 1, fontFamily: fonts.bold, fontSize: 14, color: panel.text },
  go: { alignSelf: 'flex-start', paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8, backgroundColor: panel.primarySoft },
  goText: { fontFamily: fonts.bold, fontSize: 13, color: panel.primaryText },
  name: { fontFamily: fonts.bold, fontSize: 13, color: panel.text },
  link: { paddingVertical: 4, paddingHorizontal: 4 },
  linkText: { fontFamily: fonts.bold, fontSize: 13, color: panel.primaryText, textDecorationLine: 'underline' },
});
