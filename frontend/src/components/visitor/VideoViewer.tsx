import { Image } from '@/ui/Image';
import { Download, Flag, X } from 'lucide-react-native';
import { createElement, useEffect, useState } from 'react';
import { Modal as RNModal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { requestVideoRemoval, resultVideoPlayUrl, resultVideoThumbUrl, videoDownloadUrl, type VideoResult } from '@/api/public';
import { poppins, visitor } from '@/theme/tokens';
import { saveFile } from '@/ui/saveFile';
import { VideoPlayer } from '@/components/panel/VideoPlayer';
import { SafeWindow } from '@/ui/SafeWindow';


import { shortDate } from './PhotoViewer';
import { RemovalDone, RemovalForm } from './Removal';
import { Sheet, VButton } from './ui';

export const durationText = (seconds: number) => {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

type Props = { item: VideoResult | null; eventName: string; eventDate: string; onClose: () => void; onRemove: (v: VideoResult) => void };

/**
 * A video where the search found the visitor (RF035, decision of 04/11/2026): watched here, before downloading,
 * and downloaded WHOLE, with the CESMAC mark. It may show other people: the notice says so, next to the buttons.
 * The player asks the API for parts of the file, and each part checks this session's result.
 */
export function VideoViewer({ item, eventName, eventDate, onClose, onRemove }: Props) {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (Platform.OS !== 'web' || !item) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [item, onClose]);

  async function download(id: string) {
    setDownloading(true);
    setError(null);
    try {
      await saveFile(await videoDownloadUrl(id), 'Salvar vídeo');   // the site: the browser saves it; the app: the phone's Salvar/Compartilhar
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível baixar. Tente novamente.');
    } finally {
      setDownloading(false);
    }
  }

  return (
    <RNModal visible={!!item} transparent animationType="fade" onRequestClose={onClose}>
      {item && (
        <SafeWindow style={styles.screen}><View style={{ flex: 1 }} role="dialog" aria-modal aria-label="Vídeo em que você aparece">
          <View style={styles.top}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.counter}>Vídeo em que você aparece</Text>
              <Text style={styles.event} numberOfLines={1}>{eventName}</Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="Fechar" onPress={onClose} hitSlop={8}
                       style={({ hovered }: any) => [styles.close, hovered && { backgroundColor: 'rgba(255,255,255,0.12)' }]}>
              <X size={26} color="#FFFFFF" strokeWidth={1.8} absoluteStrokeWidth />
            </Pressable>
          </View>
          <View style={styles.stage}>
            {Platform.OS === 'web' ? createElement('video', {
              key: item.id, src: resultVideoPlayUrl(item.id), poster: resultVideoThumbUrl(item.id), controls: true,
              playsInline: true, preload: 'metadata', 'aria-label': 'Vídeo em que você aparece',
              // No "download" in the player's own menu: the download goes through the button below, with the mark.
              controlsList: 'nodownload', onContextMenu: (e: Event) => e.preventDefault(),
              style: { width: '100%', height: '100%', objectFit: 'contain', backgroundColor: '#000' },
            }) : <VideoPlayer key={item.id} src={resultVideoPlayUrl(item.id)} label="Vídeo em que você aparece" fill />}
          </View>
          <View style={styles.bottom}>
            <View style={{ flex: 1, minWidth: 220, gap: 2 }}>
              <Text style={styles.credit}>{item.credit}</Text>
              <Text style={styles.date}>{item.captured_at ? shortDate(item.captured_at) : eventDate} · {durationText(item.duration_seconds)}</Text>
              <Text style={styles.hint}>
                O vídeo pode mostrar outras pessoas. Use apenas para você: não publique nem compartilhe a imagem de outras pessoas sem autorização.
              </Text>
            </View>
            <View style={styles.actions}>
              <Pressable accessibilityRole="button" accessibilityLabel="Solicitar remoção deste vídeo" onPress={() => onRemove(item)}
                         style={({ hovered }: any) => [styles.flag, hovered && { opacity: 0.85 }]}>
                <Flag size={20} color="#FFD84D" strokeWidth={1.6} absoluteStrokeWidth />
                <Text style={styles.flagText}>Solicitar remoção</Text>
              </Pressable>
              <VButton label="Baixar vídeo" icon={Download} onPress={() => download(item.id)} loading={downloading} />
            </View>
            {error && <Text style={styles.error} accessibilityRole="alert">{error}</Text>}
          </View>
        </View></SafeWindow>
      )}
    </RNModal>
  );
}

/** "Solicitar remoção" of a video: the whole video goes, for everyone in it (decision of 04/11/2026). */
export function VideoRemovalModal({ item, fallbackDate, onClose, onRemoved }: {
  item: VideoResult | null; fallbackDate: string; onClose: () => void; onRemoved: (id: string) => void;
}) {
  const [done, setDone] = useState(false);
  const close = () => { setDone(false); onClose(); };
  return (
    <Sheet visible={!!item} title="Solicitar remoção" onClose={close}>
      {item && (done ? <RemovalDone video onClose={close} /> : (
        <RemovalForm
          noun="este vídeo"
          onCancel={close}
          send={async (email, reason) => { await requestVideoRemoval(item.id, email, reason); setDone(true); onRemoved(item.id); }}
          target={(
            <View style={styles.target}>
              <Image source={resultVideoThumbUrl(item.id)} style={styles.targetThumb} contentFit="cover"
                     accessibilityLabel="O vídeo escolhido para remoção" />
              <Text style={styles.targetText}>Vídeo selecionado. Ele sai do sistema inteiro, para todas as pessoas que aparecem nele.</Text>
              <Text style={styles.targetDate}>{item.captured_at ? shortDate(item.captured_at) : fallbackDate}</Text>
            </View>
          )} />
      ))}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0B0F14' },
  top: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingHorizontal: 20, paddingVertical: 12 },
  counter: { fontFamily: poppins.semiBold, fontSize: 16, color: '#FFFFFF' },
  event: { fontFamily: poppins.regular, fontSize: 13, color: 'rgba(255, 255, 255, 0.7)' },
  close: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  stage: { flex: 1, marginHorizontal: 8 },
  bottom: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 12, paddingHorizontal: 20, paddingVertical: 14,
            borderTopWidth: 1, borderTopColor: 'rgba(255, 255, 255, 0.08)' },
  credit: { fontFamily: poppins.medium, fontSize: 13, color: '#FFFFFF' },
  date: { fontFamily: poppins.regular, fontSize: 12, color: 'rgba(255, 255, 255, 0.7)' },
  hint: { fontFamily: poppins.regular, fontSize: 12, lineHeight: 17, color: '#FFD84D' },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  flag: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8 },
  flagText: { fontFamily: poppins.medium, fontSize: 14, color: '#FFD84D' },
  error: { width: '100%', fontFamily: poppins.medium, fontSize: 13, color: '#FF8A8A' },
  target: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 8, borderRadius: 8, backgroundColor: 'rgba(12, 12, 12, 0.08)' },
  targetThumb: { width: 62, height: 62, borderRadius: 6 },
  targetText: { flex: 1, fontFamily: poppins.medium, fontSize: 12, color: visitor.muted },
  targetDate: { fontFamily: poppins.medium, fontSize: 12, color: visitor.text, alignSelf: 'flex-end' },
});
