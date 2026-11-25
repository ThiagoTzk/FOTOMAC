import 'maplibre-gl/dist/maplibre-gl.css';
import type { Map as MapLibre, Marker } from 'maplibre-gl';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { API_URL } from '@/api/client';
import { fonts, panel } from '@/theme/tokens';

import type { EventMapHandle, EventMapProps, Point } from './types';

// The map is ours: the file of Brazil comes from our server and the drawing rules from public/map, so that opening an
// event connects the visitor to no outside service (RNF34). Light even in the dark mode: a map is for finding the way.
const TILES = `pmtiles://${API_URL}/api/v1/map/brasil.pmtiles`;
const BRAZIL: [[number, number], [number, number]] = [[-75, -35], [-33, 6.5]];   // there is no map outside it
const MACEIO: Point = { latitude: -9.6658, longitude: -35.7353 };
const ZOOM_CITY = 13;
const ZOOM_PLACE = 17;
const LOCATE_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#333" stroke-width="2" stroke-linecap="round" aria-hidden="true" style="display:block;margin:auto"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>';
const PIN_COLOR = '#C63D4A';

const LOCALE = {
  'AttributionControl.ToggleAttribution': 'Mostrar ou ocultar os créditos do mapa',
  'AttributionControl.MapFeedback': 'Sugerir uma correção no mapa',
  'NavigationControl.ZoomIn': 'Aproximar o mapa',
  'NavigationControl.ZoomOut': 'Afastar o mapa',
  'NavigationControl.ResetBearing': 'Apontar o mapa para o norte',
  'CooperativeGesturesHandler.WindowsHelpText': 'Use Ctrl e a rolagem do mouse para aproximar o mapa',
  'CooperativeGesturesHandler.MacHelpText': 'Use Cmd e a rolagem do mouse para aproximar o mapa',
  'CooperativeGesturesHandler.MobileHelpText': 'Use dois dedos para mover o mapa',
};

let protocolAdded = false;

/**
 * The map of the event (MapLibre + the map of Brazil on our own server, 02/11/2026). The library only arrives when this
 * is on the screen. The scroll wheel needs Ctrl or Cmd, or scrolling the page would get stuck zooming the map.
 */
export const EventMap = forwardRef<EventMapHandle, EventMapProps>(function EventMap(
  { pin, center, editable, onPin, label, height = 320 }, ref) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibre | null>(null);
  const marker = useRef<Marker | null>(null);
  const makeMarker = useRef<((p: Point) => Marker) | null>(null);
  const report = useRef(onPin);
  const back = useRef<HTMLButtonElement | null>(null);
  const pinNow = useRef(pin);
  const [failed, setFailed] = useState(false);
  const start = useRef({ pin, center, editable, label });

  useEffect(() => { report.current = onPin; }, [onPin]);

  // Lost on the map: one button back to the pin, or to Maceió when there is none (02/11/2026).
  useEffect(() => {
    pinNow.current = pin;
    const label = pin ? 'Voltar ao pin' : 'Voltar para Maceió';
    back.current?.setAttribute('aria-label', label);
    back.current?.setAttribute('title', label);
  }, [pin]);

  useEffect(() => {
    let gone = false;
    Promise.all([import('maplibre-gl'), import('pmtiles'), fetch('/map/style.json').then((r) => r.json())]).then(([mod, pmtiles, style]) => {
      if (gone || !box.current) return;
      const ml = (mod as unknown as { default?: typeof mod }).default ?? mod;
      if (!protocolAdded) {
        ml.addProtocol('pmtiles', new pmtiles.Protocol({ metadata: true }).tile);
        protocolAdded = true;
      }
      style.sources.protomaps.url = TILES;
      style.glyphs = `${location.origin}/map/fonts/{fontstack}/{range}.pbf`;
      style.sprite = `${location.origin}/map/sprites/light`;
      const first = start.current;
      const look = first.pin ?? first.center ?? MACEIO;
      let view: MapLibre;
      try {
        view = new ml.Map({
          container: box.current, style, center: [look.longitude, look.latitude], maxBounds: BRAZIL,
          zoom: first.pin || first.center ? ZOOM_PLACE : ZOOM_CITY, cooperativeGestures: true, locale: LOCALE,
          attributionControl: { compact: false },   // OpenStreetMap asks for the credits always in sight, not behind a button
        });
      } catch {   // no WebGL in this browser
        setFailed(true);
        return;
      }
      map.current = view;
      view.addControl(new ml.NavigationControl({ visualizePitch: false }), 'top-right');
      view.addControl({
        onAdd() {
          const group = document.createElement('div');
          group.className = 'maplibregl-ctrl maplibregl-ctrl-group';
          const button = document.createElement('button');
          button.type = 'button';
          button.innerHTML = LOCATE_ICON;
          button.setAttribute('aria-label', pinNow.current ? 'Voltar ao pin' : 'Voltar para Maceió');
          button.title = button.getAttribute('aria-label')!;
          button.addEventListener('click', () => {
            const to = pinNow.current ?? MACEIO;
            view.flyTo({ center: [to.longitude, to.latitude], zoom: pinNow.current ? ZOOM_PLACE : ZOOM_CITY, speed: 2 });
          });
          back.current = button;
          group.append(button);
          return group;
        },
        onRemove() { back.current = null; },
      }, 'top-right');
      view.getCanvas().setAttribute('aria-label', first.label);
      view.on('error', (e) => { if (!view.isStyleLoaded() && (e as { sourceId?: string }).sourceId === undefined) setFailed(true); });

      makeMarker.current = (p) => {
        const made = new ml.Marker({ color: PIN_COLOR, draggable: !!first.editable }).setLngLat([p.longitude, p.latitude]).addTo(view);
        made.getElement().setAttribute('aria-label', 'Pin do local do evento');
        made.on('dragend', () => {
          const at = made.getLngLat();
          report.current?.({ latitude: at.lat, longitude: at.lng });
        });
        return made;
      };
      if (first.pin) marker.current = makeMarker.current(first.pin);
      // Whoever edits always has a pin to drag, instead of placing and removing one until it lands right.
      else if (first.editable) report.current?.(look);
      if (first.editable) view.on('click', (e) => report.current?.({ latitude: e.lngLat.lat, longitude: e.lngLat.lng }));
    }).catch(() => setFailed(true));
    return () => {
      gone = true;
      map.current?.remove();
      map.current = marker.current = makeMarker.current = null;
    };
  }, []);

  // The pin follows the form: a click, the CEP, or "Remover o pin".
  useEffect(() => {
    if (!makeMarker.current) return;
    if (!pin) {
      marker.current?.remove();
      marker.current = null;
    } else if (marker.current) {
      marker.current.setLngLat([pin.longitude, pin.latitude]);
    } else {
      marker.current = makeMarker.current(pin);
    }
  }, [pin]);

  useImperativeHandle(ref, () => ({
    pinAtCenter() {
      const at = map.current?.getCenter();
      if (at) report.current?.({ latitude: at.lat, longitude: at.lng });
    },
    lookAt(point) { map.current?.flyTo({ center: [point.longitude, point.latitude], zoom: ZOOM_PLACE, speed: 2 }); },
  }), []);

  if (failed) {
    return (
      <View style={[styles.failed, { height }]}>
        <Text style={styles.failedText}>Não foi possível abrir o mapa agora. Tente de novo mais tarde.</Text>
      </View>
    );
  }
  return <div ref={box} style={{ height, width: '100%', borderRadius: 12, overflow: 'hidden' }} />;
});

const styles = StyleSheet.create({
  failed: { alignItems: 'center', justifyContent: 'center', padding: 16, borderRadius: 12, borderWidth: 1, borderColor: panel.border,
            backgroundColor: panel.page },
  failedText: { fontFamily: fonts.regular, fontSize: 14, color: panel.text, textAlign: 'center' },
});
