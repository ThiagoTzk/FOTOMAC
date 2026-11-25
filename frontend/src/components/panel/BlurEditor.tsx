import { Image } from '@/ui/Image';
import { EyeOff, TriangleAlert } from 'lucide-react-native';
import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { blurFaces, locateFaces, previewUrl, type Box, type ImageItem } from '@/api/images';
import { Button, Notice } from '@/components/panel/ui';
import { usePhone } from '@/theme/accessibility';
import { fonts, panel } from '@/theme/tokens';

type Props = {
  image: ImageItem; onDone: (updated: ImageItem) => void; height?: number;
  /** In the sequence of selected photos (05/11/2026): what the main button says, and "Pular" beside it. */
  applyLabel?: string; secondary?: React.ReactNode;
};

/** Who may blur this photo: whoever manages it, except the hired photographer, and never a discarded or refused photo
 *  (the server refuses the same). */
export const canBlur = (image: ImageItem, role?: string) =>
  image.can_manage && image.review_status !== 'discarded' && image.approval !== 'rejected' && role !== 'contractor';
type Pick = { box: Box; on: boolean; drawn: boolean };

/**
 * "Borrar rostos" (back on 04/11/2026): hides faces IN THE FILE, typically of a child, or of anyone who should not
 * appear. The detector only says where the faces are: no age, no biometric vector. Click a face to select it; drag to
 * draw a face the detector missed (small or turned children). The file is replaced and nothing with the face is
 * kept; a published photo is analysed again, and the blurred face gives no vector.
 */
export function BlurEditor({ image, onDone, height = 560, applyLabel, secondary }: Props) {
  const area = useRef<ComponentRef<typeof View>>(null);
  // 06/11/2026: on a phone a fixed 480-560 px area pushed the buttons out of the window, and scrolling over the photo
  // draws a box instead: the area takes the photo's proportion, at most a bit under half the screen.
  const phone = usePhone();
  const screen = useWindowDimensions();
  const areaSize = phone ? { width: '100%' as const, aspectRatio: image.width / image.height, maxHeight: Math.min(height, screen.height * 0.45) }
    : { height };
  const [picks, setPicks] = useState<Pick[] | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [draft, setDraftState] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  // The responder may call the release handler of an older render: the drag start is read from a ref, never stale.
  const drag = useRef<typeof draft>(null);
  const setDraft = (d: typeof draft | ((d: typeof draft) => typeof draft)) => {
    const next = typeof d === 'function' ? d(drag.current) : d;
    drag.current = next;
    setDraftState(next);
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    locateFaces(image.id).then((r) => alive && setPicks(r.faces.map((box) => ({ box, on: false, drawn: false }))))
      .catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, [image.id, image.version]);

  // The photo at its own proportion inside the area: one scale for drawing and for the boxes.
  const k = size.w && size.h ? Math.min(size.w / image.width, size.h / image.height) : 0;
  const offset = { x: (size.w - image.width * k) / 2, y: (size.h - image.height * k) / 2 };
  const point = (e: any) => {
    // The app (06/11/2026): the touch comes already relative to the area (its children do not take touches).
    if (Platform.OS !== 'web') {
      const px = (e.nativeEvent.locationX - offset.x) / k;
      const py = (e.nativeEvent.locationY - offset.y) / k;
      return { x: Math.max(0, Math.min(image.width, px)), y: Math.max(0, Math.min(image.height, py)) };
    }
    const r = (area.current as unknown as HTMLElement).getBoundingClientRect();
    // The site is drawn slightly reduced (CSS zoom, 31/10/2026): the screen measures the area smaller than its
    // layout size, so the click is brought back to layout pixels before the photo's scale (04/11/2026).
    const zoom = r.width && size.w ? r.width / size.w : 1;
    const px = ((e.nativeEvent.pageX - window.scrollX - r.left) / zoom - offset.x) / k;
    const py = ((e.nativeEvent.pageY - window.scrollY - r.top) / zoom - offset.y) / k;
    return { x: Math.max(0, Math.min(image.width, px)), y: Math.max(0, Math.min(image.height, py)) };
  };

  function release(e: any) {
    const draft = drag.current;
    if (!draft) return;
    const end = point(e);
    const [x, y] = [Math.min(draft.x0, end.x), Math.min(draft.y0, end.y)];
    const [w, h] = [Math.abs(end.x - draft.x0), Math.abs(end.y - draft.y0)];
    setDraft(null);
    if (w * k > 10 && h * k > 10) {  // a drag: a face the detector missed
      setPicks((list) => list && [...list, { box: [Math.round(x), Math.round(y), Math.round(w), Math.round(h)], on: true, drawn: true }]);
      return;
    }
    // A click: toggles the face under it (the smallest, when boxes overlap).
    setPicks((list) => {
      if (!list) return list;
      const hit = list.map((p, i) => ({ p, i })).filter(({ p }) => end.x >= p.box[0] && end.x <= p.box[0] + p.box[2]
        && end.y >= p.box[1] && end.y <= p.box[1] + p.box[3]).sort((a, b) => a.p.box[2] * a.p.box[3] - b.p.box[2] * b.p.box[3])[0];
      return hit ? list.map((p, i) => (i === hit.i ? { ...p, on: !p.on } : p)) : list;
    });
  }

  const chosen = (picks ?? []).filter((p) => p.on);
  async function apply() {
    setBusy(true); setError(null);
    try { onDone(await blurFaces(image.id, chosen.map((p) => p.box))); } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível borrar.');
    } finally { setBusy(false); }
  }

  return (
    <View style={{ gap: 12 }}>
      <View ref={area} style={[s.area, areaSize]} onLayout={(e) => setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
            onStartShouldSetResponder={() => true} onResponderGrant={(e) => { const p = point(e); setDraft({ x0: p.x, y0: p.y, x1: p.x, y1: p.y }); }}
            onResponderMove={(e) => { const p = point(e); setDraft((d) => d && { ...d, x1: p.x, y1: p.y }); }} onResponderRelease={release}
            accessibilityLabel={`Foto: ${phone ? 'toque' : 'clique'} num rosto para borrar, ou arraste para marcar um rosto não detectado`}>
        {k > 0 && (
          <View pointerEvents="none" style={{ position: 'absolute', left: offset.x, top: offset.y, width: image.width * k, height: image.height * k }}>
            <Image source={previewUrl(image.id, image.version)} style={StyleSheet.absoluteFill} contentFit="contain" />
            {(picks ?? []).map((p, i) => (
              <View key={i} testID={p.on ? 'blur-face-on' : 'blur-face'} style={[s.box, { left: p.box[0] * k, top: p.box[1] * k, width: p.box[2] * k, height: p.box[3] * k },
                                    p.on ? s.boxOn : s.boxOff]} />
            ))}
            {draft && (
              <View style={[s.box, s.draft, { left: Math.min(draft.x0, draft.x1) * k, top: Math.min(draft.y0, draft.y1) * k,
                                               width: Math.abs(draft.x1 - draft.x0) * k, height: Math.abs(draft.y1 - draft.y0) * k }]} />
            )}
          </View>
        )}
        {!picks && !error && <ActivityIndicator color="#FFFFFF" style={{ position: 'absolute', top: '45%', alignSelf: 'center' }} />}
      </View>
      {error && <Notice tone="danger" icon={TriangleAlert} title={error} />}
      <Text style={s.help}>
        {picks ? `${picks.filter((p) => !p.drawn).length} rosto(s) detectado(s). ` : ''}{phone ? 'Toque' : 'Clique'} nos rostos que devem ser borrados;
        arraste para marcar um rosto que o detector não achou. Borrar substitui o arquivo original, e não dá para desfazer.
      </Text>
      <View style={s.actions}>
        {secondary}
        <Button variant="danger" icon={EyeOff} label={chosen.length ? applyLabel ?? `Borrar ${chosen.length} rosto(s) e substituir o original` : 'Selecione os rostos'}
                disabled={!chosen.length || busy} loading={busy} onPress={apply} />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  area: { backgroundColor: '#0B0F14', borderRadius: 10, overflow: 'hidden', cursor: 'crosshair' } as object,
  box: { position: 'absolute', borderWidth: 2, borderRadius: 3 },
  boxOff: { borderColor: 'rgba(255,255,255,0.85)', borderStyle: 'dashed' },
  boxOn: { borderColor: '#EF4444', backgroundColor: 'rgba(239,68,68,0.28)' },
  draft: { borderColor: '#FACC15', borderStyle: 'dashed' },
  help: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 18, color: panel.muted },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, flexWrap: 'wrap' },
});
