import { LocateFixed, MapPinned, Search, Trash2 } from 'lucide-react-native';
import { useRef, useState } from 'react';
import { Platform, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { ApiError } from '@/api/client';
import { lookupCep } from '@/api/events';
import { EventMap } from '@/components/map/EventMap';
import type { EventMapHandle, Point } from '@/components/map/types';
import { Button, Field, Input } from '@/components/panel/ui';
import { fonts, panel } from '@/theme/tokens';
import { useTapWord } from '@/theme/accessibility';

export type Place = { postal: string; pin: Point | null; note: string };

/** 57051160 → 57051-160 while typing. */
export const maskCep = (text: string) => {
  const digits = text.replace(/\D/g, '').slice(0, 8);
  return digits.length > 5 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : digits;
};

/**
 * Where the event is, on a map (01/11/2026). All optional. A CEP is a stretch of street, so its pin is a first
 * guess: the person drags it to the entrance and writes how to find it. With a pin the map comes open.
 * The app too (08/11/2026: after "Buscar CEP" no map came up on the iPhone to place the pin; it was drawn on
 * the site only). The app's map is the same page in a web view (components/map/EventMap.tsx).
 */
export function PlacePicker({ value, onChange, onStreet, error }: {
  value: Place; onChange: (p: Place) => void; onStreet: (street: string) => void; error?: string;
}) {
  const tap = useTapWord();
  const [open, setOpen] = useState(!!value.pin);
  const [center, setCenter] = useState<Point | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);
  const map = useRef<EventMapHandle>(null);
  // Almost square, as on the site (460 of 520), but never taller than the phone's width allows.
  const { width } = useWindowDimensions();
  const mapHeight = Platform.OS === 'web' ? 460 : Math.min(460, Math.round(width - 48));

  async function find() {
    if (value.postal.replace(/\D/g, '').length !== 8) return setMessage({ text: 'Informe o CEP com 8 números.', bad: true });
    setBusy(true);
    setMessage(null);
    try {
      const place = await lookupCep(value.postal);
      const street = [place.street, place.district].filter(Boolean).join(', ');
      const where = [street, `${place.city}/${place.state}`].filter(Boolean).join(', ');
      onStreet(street || where);
      setOpen(true);
      if (place.latitude !== null && place.longitude !== null) {
        const point = { latitude: place.latitude, longitude: place.longitude };
        setCenter(point);
        map.current?.lookAt(point);
        // A new CEP moves the pin too: the map goes there, and an old pin would stay behind, out of sight.
        onChange({ ...value, pin: point });
        setMessage({ text: `${where}. O CEP aponta para a rua: arraste o pin até a entrada.`, bad: false });
      } else {
        setMessage({ text: `${where}. Não achamos este ponto no mapa: arraste o pin até o local.`, bad: false });
      }
    } catch (e) {
      setMessage({ text: e instanceof ApiError ? `${e.message} Você ainda pode arrastar o pin no mapa.` : 'Não foi possível consultar o CEP.', bad: true });
      setOpen(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.box}>
      <View style={{ gap: 2 }}>
        <Text style={styles.title}>Mapa do local (opcional)</Text>
        <Text style={styles.help}>O visitante vê o pin e a descrição na página do evento. Só quem criou o evento pode alterá-los.</Text>
      </View>
      {!!error && <Text style={styles.error}>{error}</Text>}
      <View style={styles.row}>
        <Field label="CEP" style={styles.cep}>
          <Input value={value.postal} onChangeText={(t) => onChange({ ...value, postal: maskCep(t) })} placeholder="00000-000" inputMode="numeric"
                 maxLength={9} accessibilityLabel="CEP do local" />
        </Field>
        <Button variant="secondary" icon={Search} label="Buscar CEP" onPress={find} loading={busy} />
        {!open && (
          <Button variant="secondary" icon={MapPinned} label="Abrir o mapa" onPress={() => setOpen(true)} />
        )}
      </View>
      {!!message && <Text style={message.bad ? styles.error : styles.help} accessibilityLiveRegion="polite">{message.text}</Text>}
      {open && (
        <View style={styles.mapRow}>
          <View style={styles.mapBox}>
            <EventMap ref={map} pin={value.pin} center={center} editable height={mapHeight} label="Mapa para escolher o local do evento"
                      onPin={(pin) => onChange({ ...value, pin })} />
          </View>
          <View style={styles.mapSide}>
            <Text style={styles.help}>
              Arraste o pin até a entrada, ou {tap} no ponto do mapa.{Platform.OS === 'web' ? ' Pelo teclado: leve o foco ao mapa, mova com as setas e use “Colocar o pin no centro”.' : ''}
            </Text>
            <View style={{ alignItems: 'flex-start', gap: 8 }}>
              <Button variant="secondary" icon={LocateFixed} label="Colocar o pin no centro" onPress={() => map.current?.pinAtCenter()} />
              {value.pin && <Button variant="secondary" icon={Trash2} label="Remover o pin" onPress={() => onChange({ ...value, pin: null })} />}
            </View>
          </View>
        </View>
      )}
      <Field label="Como encontrar o local" help={`${value.note.length} de 300 caracteres. Não escreva nomes nem telefones de pessoas.`}>
        <Input multiline value={value.note} onChangeText={(note) => onChange({ ...value, note })} maxLength={300}
               placeholder="Ex.: a entrada é vermelha, com a logo do ginásio." accessibilityLabel="Como encontrar o local" />
      </Field>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: 12 },
  row: { flexDirection: 'row', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' },
  cep: { width: 150 },
  mapRow: { flexDirection: 'row', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' },
  mapBox: { width: '100%', maxWidth: 520 },
  mapSide: { flex: 1, minWidth: 220, gap: 12 },
  title: { fontFamily: fonts.semiBold, fontSize: 14, color: panel.text },
  help: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 18, color: panel.muted },
  error: { fontFamily: fonts.medium, fontSize: 12, lineHeight: 18, color: panel.danger },
});
