import { useEffect, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { useMode } from '@/theme/mode';

import { SIGNATURE_FONTS, useSignatureFonts, type SignatureFont } from './fonts';
import { initialsOf, renderTypedSignature } from './render';
import { SignaturePad } from './SignaturePad';

export type SignatureKind = 'typed' | 'drawn' | 'initials';

/** What the person adopted: the image (PNG data URL) plus how it was made, for the proof. */
export type SignatureValue = { png: string; kind: SignatureKind; text: string | null; font: SignatureFont | null };

export type SignatureTheme = { primary: string; text: string; muted: string; border: string; surface: string; soft: string; font?: string };

// The ink of the signature IMAGE: it is printed on the white term (PDF), so it is a plain dark colour in both modes.
// The screen shows it inverted in dark mode (see SignaturePad and the preview below).
const INK = '#14232F';

const DEFAULT_THEME: SignatureTheme = {
  primary: '#0070B0', text: '#1F2937', muted: '#6B7280', border: '#D1D5DB', surface: '#FFFFFF', soft: '#E8F5FC',
};

const MODES: { key: SignatureKind; label: string; help: string }[] = [
  { key: 'typed', label: 'Digitar', help: 'Escreva o nome como quer assinar e escolha o estilo de letra.' },
  { key: 'drawn', label: 'Desenhar', help: 'Assine dentro do quadro com o mouse, o dedo ou a caneta.' },
  { key: 'initials', label: 'Rubrica', help: 'Para quem assina só com a rubrica: digite as iniciais e escolha o estilo, ou desenhe.' },
];

type Props = {
  /** The person's name: the starting text of the typed signature and of the initials. */
  name: string;
  onChange: (value: SignatureValue | null) => void;
  theme?: Partial<SignatureTheme>;
};

/**
 * Electronic signature in three ways, like the known signing services: TYPED (the name, which the person
 * can edit, written in a handwriting font of their choice), DRAWN (mouse, finger or pen) or a RUBRICA
 * (initials typed in a handwriting font, or drawn). Any of them is valid; the result is always a PNG with
 * a transparent background plus the kind, the text and the font, for the record.
 */
export function SignatureInput({ name, onChange, theme: custom }: Props) {
  const t = { ...DEFAULT_THEME, ...custom };
  const dark = useMode() === 'dark';
  const fontsReady = useSignatureFonts();
  const [mode, setMode] = useState<SignatureKind>('typed');
  const [typed, setTyped] = useState(name);
  const [initials, setInitials] = useState(initialsOf(name));
  const [font, setFont] = useState<SignatureFont>(SIGNATURE_FONTS[0].family);
  const [drawRubrica, setDrawRubrica] = useState(false);
  const [drawn, setDrawn] = useState<string | null>(null);
  const [clear, setClear] = useState(0);
  // The image that will be signed, tagged with what produced it: shown only while it matches the screen.
  const [preview, setPreview] = useState<{ key: string; png: string } | null>(null);

  const text = mode === 'typed' ? typed : initials;
  const drawing = mode === 'drawn' || (mode === 'initials' && drawRubrica);
  const key = `${mode}|${text.trim()}|${font}`;

  // Every change produces the image again (or none, while there is nothing valid to sign with).
  useEffect(() => {
    let alive = true;
    if (drawing) {
      onChange(drawn ? { png: drawn, kind: mode, text: null, font: null } : null);
      return;
    }
    if (!fontsReady || text.trim().length < (mode === 'typed' ? 2 : 1)) { onChange(null); return; }
    renderTypedSignature(text, font, INK).then((png) => {
      if (!alive) return;
      setPreview(png ? { key, png } : null);
      onChange(png ? { png, kind: mode, text: text.trim(), font } : null);
    });
    return () => { alive = false; };
  }, [mode, text, font, drawing, drawn, fontsReady]); // eslint-disable-line react-hooks/exhaustive-deps

  function choose(next: SignatureKind) {
    setMode(next);
    setDrawn(null);
    setClear((n) => n + 1);
  }

  const s = styles;
  return (
    <View style={{ gap: 12 }}>
      <View style={[s.tabs, { borderColor: t.border }]} role="tablist" accessibilityLabel="Como você quer assinar">
        {MODES.map((m) => {
          const on = m.key === mode;
          return (
            <Pressable key={m.key} accessibilityRole="tab" accessibilityState={{ selected: on }} aria-selected={on} onPress={() => choose(m.key)}
                       style={[s.tab, on && { backgroundColor: t.primary }]}>
              <Text style={[s.tabText, { color: on ? '#FFFFFF' : t.text, fontFamily: t.font }]}>{m.label}</Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={[s.help, { color: t.muted, fontFamily: t.font }]}>{MODES.find((m) => m.key === mode)!.help}</Text>

      {mode === 'initials' && (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {[false, true].map((d) => (
            <Pressable key={String(d)} accessibilityRole="radio" accessibilityState={{ checked: drawRubrica === d }} aria-checked={drawRubrica === d}
                       onPress={() => { setDrawRubrica(d); setDrawn(null); setClear((n) => n + 1); }}
                       style={[s.chip, { borderColor: drawRubrica === d ? t.primary : t.border, backgroundColor: drawRubrica === d ? t.soft : t.surface }]}>
              <Text style={[s.chipText, { color: drawRubrica === d ? t.primary : t.text, fontFamily: t.font }]}>
                {d ? 'Desenhar a rubrica' : 'Digitar as iniciais'}</Text>
            </Pressable>
          ))}
        </View>
      )}

      {drawing ? (
        <View style={{ gap: 8 }}>
          <SignaturePad onChange={setDrawn} clearSignal={clear} ink={INK} border={t.border} surface={t.surface}
                        label={mode === 'initials' ? 'Quadro da rubrica: desenhe com o mouse, o dedo ou a caneta' : undefined} />
          <Pressable accessibilityRole="button" onPress={() => setClear((n) => n + 1)} disabled={!drawn} style={{ alignSelf: 'flex-start' }}>
            <Text style={[s.link, { color: drawn ? t.primary : t.muted, fontFamily: t.font }]}>Limpar e desenhar de novo</Text>
          </Pressable>
        </View>
      ) : (
        <View style={{ gap: 10 }}>
          <TextInput value={text} onChangeText={mode === 'typed' ? setTyped : (v) => setInitials(v.replace(/\s+/g, '').slice(0, 6))}
                     maxLength={mode === 'typed' ? 80 : 6} autoCapitalize={mode === 'typed' ? 'words' : 'characters'}
                     accessibilityLabel={mode === 'typed' ? 'Nome da assinatura' : 'Iniciais da rubrica'}
                     placeholder={mode === 'typed' ? 'Seu nome' : 'Suas iniciais'}
                     style={[s.input, { borderColor: t.border, color: t.text, fontFamily: t.font, backgroundColor: t.surface }]} />
          <View style={s.fonts} role="radiogroup" accessibilityLabel="Estilo de letra">
            {SIGNATURE_FONTS.map((f) => {
              const on = f.family === font;
              return (
                <Pressable key={f.family} accessibilityRole="radio" accessibilityState={{ checked: on }} aria-checked={on}
                           accessibilityLabel={`Estilo ${f.label}`} onPress={() => setFont(f.family)}
                           style={[s.fontCard, { borderColor: on ? t.primary : t.border, backgroundColor: on ? t.soft : t.surface }]}>
                  {/* The size follows the length, so a long name fits the card whole (no "Maria S. …"). */}
                  <Text numberOfLines={1}
                        style={[s.sample, { fontFamily: fontsReady ? f.family : undefined, color: t.text,
                                            fontSize: Math.min(34, 330 / Math.max(text.trim().length, 1)) * f.size }]}>
                    {text.trim() || (mode === 'typed' ? 'Seu nome' : 'Iniciais')}
                  </Text>
                  <Text style={[s.fontLabel, { color: on ? t.primary : t.muted, fontFamily: t.font }]}>{f.label}</Text>
                </Pressable>
              );
            })}
          </View>
          {preview?.key === key && text.trim() && (
            <View style={{ gap: 4 }}>
              <Text style={[s.help, { color: t.muted, fontFamily: t.font }]}>Assim vai ficar:</Text>
              <View style={[s.preview, { borderColor: t.border, backgroundColor: t.surface }]}>
                <Image source={{ uri: preview.png }} style={[s.previewImg, dark && s.inverted]} resizeMode="contain"
                       accessibilityLabel={mode === 'typed' ? 'Prévia da assinatura' : 'Prévia da rubrica'} />
                <View style={[s.line, { backgroundColor: t.text }]} />
              </View>
            </View>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  tabs: { flexDirection: 'row', borderWidth: 1, borderRadius: 10, padding: 3, alignSelf: 'flex-start', gap: 3 },
  tab: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8 },
  tabText: { fontSize: 14, fontWeight: '600' },
  help: { fontSize: 13, lineHeight: 19 },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  chipText: { fontSize: 13 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, maxWidth: 600 },
  fonts: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, maxWidth: 620 },
  fontCard: { width: 190, height: 92, borderWidth: 1.5, borderRadius: 10, paddingHorizontal: 10, paddingTop: 6, paddingBottom: 6,
              justifyContent: 'space-between', overflow: 'hidden' },
  sample: { textAlign: 'center', lineHeight: 52 },
  fontLabel: { fontSize: 11, textAlign: 'center' },
  link: { fontSize: 13, fontWeight: '600' },
  preview: { borderWidth: 1, borderRadius: 10, maxWidth: 600, paddingHorizontal: 24, paddingTop: 6, paddingBottom: 14 },
  previewImg: { width: '100%', aspectRatio: 3, maxHeight: 150 },
  line: { height: 1, opacity: 0.5 },
  inverted: { filter: 'invert(1) hue-rotate(180deg)' } as object,
});
