import { Image } from '@/ui/Image';
import { router } from 'expo-router';
import { ChevronRight, Image as ImageIcon, MapPin } from 'lucide-react-native';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { coverUrl, type EventItem } from '@/api/events';
import { Pill, StatusPill } from '@/components/panel/ui';
import { fonts, panel } from '@/theme/tokens';
import { useLayoutWidth } from '@/theme/accessibility';

const RELATION_PILL: Partial<Record<EventItem['relation'], string>> = {
  collaborator: 'Colaboração', viewer: 'Só visualização', contractor: 'Contratado',
};
const owner = (e: EventItem) => `${e.owner.full_name}${e.owner.team ? ` (${e.owner.team})` : ''}`;

/** The event's cover beside its name, like the photo beside an account (31/10/2026); an icon when there is none. */
function Cover({ e }: { e: EventItem }) {
  return e.cover_version ? (
    <Image source={{ uri: coverUrl(e.id, e.cover_version) }} style={styles.cover} contentFit="cover"
           accessibilityLabel={`Capa do evento ${e.name}`} />
  ) : (
    <View style={[styles.cover, styles.noCover]} accessibilityLabel="Evento sem capa">
      <ImageIcon size={18} color={panel.muted} strokeWidth={1.6} absoluteStrokeWidth />
    </View>
  );
}

/** Published photos whose face processing failed: beside the status, so it is seen without opening the event. */
function Failed({ e }: { e: EventItem }) {
  if (!e.failed) return null;
  return <Pill label={`Erro em ${e.failed} ${e.failed === 1 ? 'imagem' : 'imagens'}`} bg={panel.dangerSoft} fg={panel.danger} />;
}

/** Converted videos waiting for "Publicar" (05/11/2026): pending work, like photos ready for publication. */
function VideosReady({ e }: { e: EventItem }) {
  if (!e.videos_ready) return null;
  return <Pill label={`${e.videos_ready} ${e.videos_ready === 1 ? 'vídeo' : 'vídeos'} a publicar`} bg={panel.warningSoft} fg={panel.warning} />;
}

/** Removal requests (05/11/2026): their own part of the row, with the number, since they have a deadline. */
function Removals({ e }: { e: EventItem }) {
  if (!e.removals) return <Text style={styles.cell}>Nenhuma</Text>;
  return <Pill label={`${e.removals} ${e.removals === 1 ? 'pendente' : 'pendentes'}`} bg={panel.dangerSoft} fg={panel.danger} />;
}

/** Collaboration requests (01/11/2026): waiting for this account's answer, or sent by it and not answered yet. */
function Requests({ e }: { e: EventItem }) {
  if (e.requests_waiting) {
    return <Pill label={`${e.requests_waiting} ${e.requests_waiting === 1 ? 'pedido' : 'pedidos'} de colaboração`} bg={panel.warningSoft} fg={panel.warning} />;
  }
  return e.my_request?.status === 'pending' ? <Pill label="Pedido enviado" /> : null;
}

/** "Tabela de eventos" of the Visão geral and Eventos screens. Rows open the event. */
export function EventsTable({ events }: { events: EventItem[] }) {
  const width = useLayoutWidth();
  // One card per event when the columns do not fit. Decided by the room the table really has, not by the window: at
  // 1024 px (a tablet lying down) the side menu was there too and the last columns were cut (06/11/2026).
  const [room, setRoom] = useState<number | null>(null);
  const compact = room === null ? width < 900 : room < TABLE_WIDTH;
  return (
    <View onLayout={(e) => setRoom(e.nativeEvent.layout.width)}>
      {compact ? <Cards events={events} /> : <Columns events={events} />}
    </View>
  );
}

// The fixed columns below, their padding and the arrow.
const TABLE_WIDTH = 310 + 130 + 145 + 120 + 160 + 130 + 32 + 40;

function Cards({ events }: { events: EventItem[] }) {
  return (
    <View style={{ gap: 10 }}>
      {events.map((e) => (
        <Pressable key={e.id} accessibilityRole="link" onPress={() => router.navigate(`/eventos/${e.id}`)} style={styles.cardRow}>
          <Cover e={e} />
          <View style={{ flex: 1, gap: 6 }}>
            <Text style={styles.name}>{e.name}</Text>
            <Text style={styles.cell}>{e.date_label} · {e.location} · {e.photos} {e.photos === 1 ? 'imagem' : 'imagens'}</Text>
            <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
              <StatusPill status={e.status} deleting={!!e.deletion_due_at} />
              <Failed e={e} />
              {RELATION_PILL[e.relation] && <Pill label={RELATION_PILL[e.relation]!} />}
              {e.approvals_pending + e.video_approvals_pending > 0 && <Pill label={`${e.approvals_pending + e.video_approvals_pending} a aprovar`} bg={panel.warningSoft} fg={panel.warning} />}
              <VideosReady e={e} />
              {e.removals > 0 && <Pill label={`${e.removals} ${e.removals === 1 ? 'remoção pendente' : 'remoções pendentes'}`} bg={panel.dangerSoft} fg={panel.danger} />}
              <Requests e={e} />
            </View>
          </View>
          <ChevronRight size={18} color={panel.muted} strokeWidth={1.6} absoluteStrokeWidth />
        </Pressable>
      ))}
    </View>
  );
}

function Columns({ events }: { events: EventItem[] }) {
  return (
    <View style={styles.table}>
      <View style={styles.head}>
        <Text style={[styles.th, { width: 310 }]}>EVENTO</Text>
        <Text style={[styles.th, { width: 130 }]}>DATA</Text>
        <Text style={[styles.th, { width: 145 }]}>LOCAL</Text>
        <Text style={[styles.th, { width: 120 }]}>IMAGENS</Text>
        <Text style={[styles.th, { width: 160 }]}>STATUS</Text>
        <Text style={[styles.th, { width: 130 }]}>REMOÇÃO PENDENTE</Text>
        <Text style={[styles.th, { flex: 1, textAlign: 'right' }]}>AÇÕES</Text>
      </View>
      {/* The rows are a list of items, each a link (a list may only hold list items: 31/10/2026, axe). */}
      <View role="list">
      {events.map((e) => (
        <View key={e.id} role="listitem">
        <Pressable accessibilityRole="link" accessibilityLabel={`Abrir ${e.name}`}
                   onPress={() => router.navigate(`/eventos/${e.id}`)}
                   style={({ hovered }: any) => [styles.row, hovered && { backgroundColor: panel.page }]}>
          <View style={{ width: 310, paddingRight: 12, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <Cover e={e} />
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={styles.name} numberOfLines={1}>{e.name}</Text>
              {/* Adaptation: events of other photographers with collaboration released. */}
              {RELATION_PILL[e.relation] && <Text style={styles.collab}>{RELATION_PILL[e.relation]} · responsável: {owner(e)}</Text>}
              {/* An event of someone else that this account does not work on (01/11/2026): whose it is. */}
              {e.relation !== 'owner' && !RELATION_PILL[e.relation] && (e.owner.team || e.relation === 'outsider')
                && <Text style={styles.collab}>Responsável: {owner(e)}</Text>}
            </View>
          </View>
          <Text style={[styles.cell, { width: 130 }]}>{e.date_label}</Text>
          <View style={{ width: 145, flexDirection: 'row', alignItems: 'center', gap: 6, paddingRight: 8 }}>
            <MapPin size={15} color={panel.muted} strokeWidth={1.6} absoluteStrokeWidth />
            <Text style={[styles.cell, { flex: 1 }]} numberOfLines={2}>{e.location}</Text>
          </View>
          <Text style={[styles.cell, { width: 120 }]}>{e.photos} {e.photos === 1 ? 'imagem' : 'imagens'}</Text>
          <View style={{ width: 160, gap: 4, alignItems: 'flex-start' }}>
            <StatusPill status={e.status} deleting={!!e.deletion_due_at} />
            <Failed e={e} />
            {/* Photos of a hired photographer waiting for the administrator. */}
            {e.approvals_pending + e.video_approvals_pending > 0 && <Pill label={`${e.approvals_pending + e.video_approvals_pending} a aprovar`} bg={panel.warningSoft} fg={panel.warning} />}
            <VideosReady e={e} />
            <Requests e={e} />
          </View>
          <View style={{ width: 130, alignItems: 'flex-start' }}>
            <Removals e={e} />
          </View>
          <View style={{ flex: 1, alignItems: 'flex-end' }}>
            <ChevronRight size={18} color={panel.muted} strokeWidth={1.6} absoluteStrokeWidth />
          </View>
        </Pressable>
        </View>
      ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  table: { borderWidth: 1, borderColor: panel.border, borderRadius: panel.cardRadius, overflow: 'hidden', backgroundColor: panel.surface },
  head: { height: 42, backgroundColor: panel.page, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16 },
  th: { fontFamily: fonts.bold, fontSize: 12, color: panel.muted },
  row: { minHeight: 60, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10,
         borderTopWidth: 1, borderColor: panel.borderSoft },
  name: { fontFamily: fonts.regular, fontSize: 14, color: panel.text },
  cover: { width: 64, height: 44, borderRadius: 8, backgroundColor: panel.page },
  noCover: { alignItems: 'center', justifyContent: 'center' },
  collab: { fontFamily: fonts.regular, fontSize: 12, color: panel.primaryText },
  cell: { fontFamily: fonts.regular, fontSize: 14, color: panel.muted },
  cardRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderWidth: 1, borderColor: panel.border,
             borderRadius: panel.radius, backgroundColor: panel.surface },
});
