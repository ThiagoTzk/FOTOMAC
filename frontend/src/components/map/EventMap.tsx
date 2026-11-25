import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ComponentRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';

import { API_URL, SITE_URL } from '@/api/client';
import { useScrollLock } from '@/components/panel/scrollLock';
import { fonts, panel } from '@/theme/tokens';

import type { EventMapHandle, EventMapProps, Point } from './types';

/**
 * One piece of the map file, fetched by the app for the map page (08/11/2026): on the iPhone the page itself could not
 * reach the API, the app can. Base64, because messages to a web page carry text only.
 */
async function mapPiece(offset: number, length: number): Promise<string> {
  const r = await fetch(`${API_URL}/api/v1/map/brasil.pmtiles`, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
  if (r.status !== 206 && r.status !== 200) throw new Error(`HTTP ${r.status}`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/**
 * The map in the app (06/11/2026, the author's choice): the SAME map as the site (MapLibre + the map of Brazil on our own
 * server), opened in a web view from our own site (public/map/app.html). No outside service learns who opened an event
 * (RNF34). The page answers with the pin moved; the app tells it where to put the pin or where to look.
 */
export const EventMap = forwardRef<EventMapHandle, EventMapProps>(function EventMap(
  { pin, center, editable, onPin, label, height = 320 }, ref) {
  const view = useRef<ComponentRef<typeof WebView>>(null);
  const report = useRef(onPin);
  const ready = useRef(false);
  const [failed, setFailed] = useState(false);
  // Editing: while the finger is on the map the page does not scroll, so dragging moves the pin (scrollLock.ts).
  const lock = useScrollLock();
  const hold = editable ? { onTouchStart: () => lock(true), onTouchEnd: () => lock(false), onTouchCancel: () => lock(false) } : {};
  useEffect(() => () => lock(false), [lock]);
  useEffect(() => { report.current = onPin; }, [onPin]);

  // The address is decided once: later changes of the pin go by message, without reloading the map.
  const [source] = useState(() => {
    const q = new URLSearchParams({ api: API_URL, label, editable: editable ? '1' : '0' });
    if (pin) { q.set('lat', String(pin.latitude)); q.set('lng', String(pin.longitude)); }
    if (center) { q.set('clat', String(center.latitude)); q.set('clng', String(center.longitude)); }
    return { uri: `${SITE_URL}/map/app.html?${q}` };
  });
  const run = (code: string) => { if (ready.current) view.current?.injectJavaScript(`window.fotomac && ${code}; true;`); };

  useEffect(() => { run(`fotomac.setPin(${JSON.stringify(pin)})`); }, [pin]);
  useImperativeHandle(ref, () => ({
    pinAtCenter() { run('fotomac.pinAtCenter()'); },
    lookAt(point: Point) { run(`fotomac.lookAt(${JSON.stringify(point)})`); },
  }), []);

  if (failed) {
    return (
      <View style={[styles.failed, { height }]}>
        <Text style={styles.failedText}>Não foi possível abrir o mapa agora. Tente de novo mais tarde.</Text>
      </View>
    );
  }
  return (
    <View style={[styles.box, { height }]} accessible accessibilityLabel={label} {...hold}>
      {/* nestedScrollEnabled (Android): the map tells the page not to take the touch, so dragging moves the pin
          instead of scrolling the form. Only when editing: elsewhere a finger on the map still scrolls the page. */}
      <WebView ref={view} source={source} originWhitelist={[SITE_URL]} setSupportMultipleWindows={false}
               nestedScrollEnabled={!!editable}
               // Only our map page: a link inside the map (the credits) never opens another site in the app.
               onShouldStartLoadWithRequest={(r) => r.url.startsWith(SITE_URL)}
               onError={() => setFailed(true)} onHttpError={() => setFailed(true)}
               onMessage={(e) => {
                 const msg = JSON.parse(e.nativeEvent.data) as {
                   ready?: boolean; pin?: Point; error?: string; bytes?: { id: number; offset: number; length: number };
                 };
                 if (msg.bytes) {
                   const { id, offset, length } = msg.bytes;
                   mapPiece(offset, length).then(
                     (b64) => view.current?.injectJavaScript(`window.fotomacBytes(${id}, "${b64}"); true;`),
                     (err) => view.current?.injectJavaScript(`window.fotomacBytes(${id}, null, ${JSON.stringify(String(err))}); true;`));
                 }
                 if (msg.error && __DEV__) console.warn('[mapa] ' + msg.error);   // only in development, for diagnosis
                 if (msg.ready) ready.current = true;
                 if (msg.pin) report.current?.(msg.pin);
               }} />
    </View>
  );
});

const styles = StyleSheet.create({
  box: { width: '100%', borderRadius: 12, overflow: 'hidden' },
  failed: { borderRadius: 12, backgroundColor: panel.page, alignItems: 'center', justifyContent: 'center', padding: 16 },
  failedText: { fontFamily: fonts.regular, fontSize: 14, color: panel.muted, textAlign: 'center' },
});
