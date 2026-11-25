import { useFocusEffect } from 'expo-router';
import { MapPinOff, MapPinned } from 'lucide-react-native';
import { useCallback, useState, type ReactNode } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { EventMap } from '@/components/map/EventMap';

type Props = {
  latitude: number | null;
  longitude: number | null;
  note: string | null;
  /** Without a pin the written location stands in for the map. The panel leaves it out: it shows the location already. */
  location?: string;
  textColor: string;
  fontFamily: string;
  /** Drawn only when there is something to show, so the page never gets an empty card. */
  header?: ReactNode;
  mapHeight?: number;
  /** The map takes the height left in the card: the card beside it decides how tall both are. */
  fillMap?: boolean;
  style?: StyleProp<ViewStyle>;
};

/** How to find the event, for whoever only reads it. Nobody edits it here. */
export function EventPlace({ latitude, longitude, note, location, textColor, fontFamily, header, mapHeight, fillMap, style }: Props) {
  // The router keeps visited pages mounted, and a browser only holds a few maps at once: only the page on screen has one.
  const [onScreen, setOnScreen] = useState(true);
  useFocusEffect(useCallback(() => {
    setOnScreen(true);
    return () => setOnScreen(false);
  }, []));
  const pin = latitude !== null && longitude !== null ? { latitude, longitude } : null;
  const hasMap = !!pin;   // the site and the app (06/11/2026: the app opens the same map, components/map/EventMap.tsx)
  if (!hasMap && !note && !location) return null;
  const map = (height?: number | '100%') => <EventMap key={`${latitude},${longitude}`} pin={pin} height={height} label="Mapa com o local do evento marcado por um pin" />;
  return (
    <View style={[styles.box, style]}>
      {header}
      {!!note && (
        <View style={styles.note}>
          <MapPinned size={18} color={textColor} strokeWidth={1.8} absoluteStrokeWidth />
          <Text style={[styles.noteText, { color: textColor, fontFamily }]}>{note}</Text>
        </View>
      )}
      {/* flex 0: in a column, a growing text pushed the "no map" box to the bottom of the card. */}
      {!hasMap && !!location && <Text style={[styles.noteText, { flex: 0, color: textColor, fontFamily }]}>{location}</Text>}
      {/* 05/11/2026: the space of the map, beside the search, said nothing when there was no pin. */}
      {!hasMap && !!location && (
        <View style={[styles.noMap, fillMap && { flexGrow: 1 }]}>
          <MapPinOff size={26} color={textColor} strokeWidth={1.6} absoluteStrokeWidth />
          <Text style={[styles.noteText, styles.noMapText, { color: textColor, fontFamily }]}>Este evento não possui mapa.</Text>
        </View>
      )}
      {/* The key starts the map over when this same screen opens another event. */}
      {hasMap && onScreen && (fillMap
        ? <View style={styles.fill}><View style={StyleSheet.absoluteFill}>{map('100%')}</View></View>
        : map(mapHeight))}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: 10 },
  fill: { flexGrow: 1, minHeight: 320 },
  note: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  noteText: { flex: 1, fontSize: 14, lineHeight: 21 },
  noMap: { minHeight: 160, borderRadius: 12, borderWidth: 1, borderStyle: 'dashed', borderColor: 'rgba(120,130,140,0.45)',
           alignItems: 'center', justifyContent: 'center', gap: 8, padding: 16 },
  noMapText: { flex: 0, textAlign: 'center', opacity: 0.8 },
});
