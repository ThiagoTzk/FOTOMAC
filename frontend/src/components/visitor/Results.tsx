import { Image } from '@/ui/Image';
import { Images, Play, ScanFace, SearchX, Video as VideoIcon, type LucideIcon } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { resultImageUrl, resultVideoThumbUrl, type ResultItem, type VideoResult } from '@/api/public';
import { poppins, visitor } from '@/theme/tokens';

import { ResponsibleUse, VButton, vtext } from './ui';
import { durationText } from './VideoViewer';
import { useLayoutWidth } from '@/theme/accessibility';

type Props = {
  items: ResultItem[]; selfie: string | null; onOpen: (index: number) => void;
  /** The videos where the visitor was found (RF035, 04/11/2026). */
  videos?: VideoResult[]; onPlay?: (video: VideoResult) => void;
  /** The open tab, kept by the page (a redraw of this list must not reset it). */
  tab: 'photos' | 'videos'; onTab: (tab: 'photos' | 'videos') => void;
  /** 06/11/2026: with the result on screen the "Procure suas fotos" card goes away; searching again is here. */
  onSearchAgain: () => void; busy: boolean;
};

/**
 * Only the photos and videos where the visitor was found. Every thumbnail comes from a route that checks THIS
 * session's result on the server. 05/11/2026: with 50 videos the photos were far down the page; photos and
 * videos are now two tabs with their counts, photos first, and one list never pushes the other.
 */
export function Results({ items, selfie, onOpen, videos = [], onPlay, tab, onTab, onSearchAgain, busy }: Props) {
  const width = useLayoutWidth();
  // Phones keep the Figma's three columns; on a computer the photos are much larger (~280 px
  // instead of ~130 px — smaller ones were too small to recognise anyone).
  const columns = width >= 1024 ? 4 : 3;
  const videoColumns = width >= 1024 ? 4 : width >= 600 ? 3 : 2;

  const again = <VButton variant="ghost" icon={ScanFace} label={busy ? 'Buscando…' : 'Buscar de novo'} loading={busy} onPress={onSearchAgain} />;
  if (items.length === 0 && videos.length === 0) return <EmptyResult again={again} />;
  const found = [
    items.length ? (items.length === 1 ? '1 foto encontrada' : `${items.length} fotos encontradas`) : null,
    videos.length ? (videos.length === 1 ? '1 vídeo encontrado' : `${videos.length} vídeos encontrados`) : null,
  ].filter(Boolean).join(' e ');
  const both = items.length > 0 && videos.length > 0;
  const showing = both ? tab : items.length ? 'photos' : 'videos';
  return (
    <View style={{ gap: 16 }}>
      <View style={styles.head}>
        {/* The visitor's own selfie, only in this page's memory (never sent back by the server). */}
        {selfie && <Image source={selfie} style={styles.selfie} contentFit="cover" accessibilityLabel="Sua foto de busca" />}
        {/* minWidth: on a phone "Buscar de novo" squeezed the title into one word per line; now the button goes below. */}
        <View style={{ flex: 1, minWidth: 190 }}>
          <Text style={vtext.h2} accessibilityRole="header">{items.length ? 'Suas fotos' : 'Seus vídeos'}</Text>
          <Text style={styles.count}>{found}</Text>
        </View>
        {again}
      </View>
      {/* Above the photos (31/10/2026), never under up to 200 of them. */}
      <ResponsibleUse />
      {both && (
        <View style={styles.tabs} role="tablist" aria-label="Fotos e vídeos encontrados">
          <Tab icon={Images} label={`Fotos · ${items.length}`} on={showing === 'photos'} onPress={() => onTab('photos')} />
          <Tab icon={VideoIcon} label={`Vídeos · ${videos.length}`} on={showing === 'videos'} onPress={() => onTab('videos')} />
        </View>
      )}
      {showing === 'videos' ? (
        <View style={styles.grid} role={both ? 'tabpanel' : undefined}>
          {videos.map((v, i) => (
            <Pressable key={v.id} accessibilityRole="button" accessibilityLabel={`Assistir ao vídeo ${i + 1} de ${videos.length}, ${durationText(v.duration_seconds)}`}
                       onPress={() => onPlay?.(v)} style={[styles.videoCell, { width: `${100 / videoColumns}%` }]}>
              <View style={styles.videoFrame}>
                <Image source={resultVideoThumbUrl(v.id)} style={styles.thumb} contentFit="cover" accessibilityLabel="" />
                <View style={styles.play}><Play size={20} color="#FFFFFF" fill="#FFFFFF" strokeWidth={1.6} absoluteStrokeWidth /></View>
                <View style={styles.duration}><Text style={styles.durationText}>{durationText(v.duration_seconds)}</Text></View>
              </View>
              <Text style={styles.videoLabel} numberOfLines={1}>Vídeo {i + 1}</Text>
            </Pressable>
          ))}
        </View>
      ) : (
        <View style={styles.grid} role={both ? 'tabpanel' : undefined}>
          {items.map((it, i) => (
            <Pressable key={it.id} accessibilityRole="button" accessibilityLabel={`Abrir foto ${i + 1} de ${items.length}`}
                       onPress={() => onOpen(i)} style={[styles.cell, { width: `${100 / columns}%` }]}>
              <Image source={resultImageUrl(it.id, 'thumb')} style={styles.thumb} contentFit="cover" accessibilityLabel="" />
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

function Tab({ icon: Icon, label, on, onPress }: { icon: LucideIcon; label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="tab" accessibilityState={{ selected: on }} aria-selected={on} onPress={onPress}
               style={[styles.tab, on && styles.tabOn]}>
      <Icon size={16} color={on ? '#FFFFFF' : visitor.primary} strokeWidth={1.8} absoluteStrokeWidth />
      <Text style={[styles.tabText, on && { color: '#FFFFFF' }]}>{label}</Text>
    </Pressable>
  );
}

/** "Nenhuma foto encontrada": possible causes + try again. */
function EmptyResult({ again }: { again: ReactNode }) {
  return (
    <View style={styles.empty} accessibilityLiveRegion="polite">
      <SearchX size={40} color={visitor.placeholder} strokeWidth={1.4} absoluteStrokeWidth />
      <Text style={[vtext.h3, { color: visitor.text, textAlign: 'center' }]}>Nenhuma foto encontrada</Text>
      <Text style={styles.emptyLead}>Não encontramos fotos suas neste evento.</Text>
      <Text style={styles.emptyText}>
        Tente novamente com uma foto bem iluminada, com o rosto visível e olhando para a câmera. Se você não foi
        fotografado neste evento, nenhuma foto aparecerá.
      </Text>
      {again}
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  zipHelp: { fontFamily: poppins.regular, fontSize: 13, color: visitor.muted, marginTop: -8 },
  selfie: { width: 64, height: 64, borderRadius: 999, backgroundColor: visitor.chip },
  count: { fontFamily: poppins.semiBold, fontSize: 14, color: visitor.primary },
  grid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -5 },
  cell: { padding: 5, aspectRatio: 1 },
  videoCell: { padding: 5, gap: 4 },
  videoFrame: { aspectRatio: 16 / 9 },
  videoLabel: { fontFamily: poppins.medium, fontSize: 12, color: visitor.muted, paddingHorizontal: 2 },
  tabs: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  tab: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 16, borderRadius: 999,
         borderWidth: 1, borderColor: visitor.primary },
  tabOn: { backgroundColor: visitor.primary },
  tabText: { fontFamily: poppins.semiBold, fontSize: 14, color: visitor.primary },
  play: { position: 'absolute', top: '50%', left: '50%', marginTop: -22, marginLeft: -22, width: 44, height: 44, borderRadius: 22,
          backgroundColor: 'rgba(0, 0, 0, 0.55)', alignItems: 'center', justifyContent: 'center' },
  duration: { position: 'absolute', right: 6, bottom: 6, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4,
              backgroundColor: 'rgba(0, 0, 0, 0.65)' },
  durationText: { fontFamily: poppins.medium, fontSize: 12, color: '#FFFFFF' },
  thumb: { flex: 1, borderRadius: 6, backgroundColor: visitor.chip },
  empty: { alignItems: 'center', gap: 4, paddingVertical: 16 },
  emptyLead: { fontFamily: poppins.medium, fontSize: 14, color: visitor.muted, textAlign: 'center' },
  emptyText: { fontFamily: poppins.regular, fontSize: 13, lineHeight: 20, color: visitor.muted, textAlign: 'center', maxWidth: 420 },
});
