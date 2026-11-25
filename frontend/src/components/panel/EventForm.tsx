import { Image } from '@/ui/Image';
import { router } from 'expo-router';
import { Calendar, Camera, ImagePlus, Info, Plus, Square, SquareCheck, TriangleAlert } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { api, ApiError, appendFile } from '@/api/client';
import { ChildrenDeclaration, childrenProblem, NO_CHILDREN } from '@/components/panel/ChildrenDeclaration';
import { coverUrl, createEventTheme, isoToBr, listThemes, type DatePrecision, type EventItem, type Theme } from '@/api/events';
import { useAuth } from '@/auth/AuthContext';
import { ThemeIcon } from '@/components/icons/themeIcons';
import { discardPicked, pickJpeg } from '@/components/panel/files';
import { IconPicker } from '@/components/panel/IconPicker';
import { Modal } from '@/components/panel/Modal';
import { maskCep, PlacePicker, type Place } from '@/components/panel/PlacePicker';
import { Select } from '@/components/panel/Select';
import { Button, Card, Field, Input, Notice } from '@/components/panel/ui';
import { fonts, panel } from '@/theme/tokens';

const PRECISIONS: { value: DatePrecision; label: string }[] = [
  { value: 'day', label: 'Data exata' },
  { value: 'month', label: 'Mês' },
  { value: 'month_range', label: 'Intervalo de meses' },
];

/** "dd/mm/aaaa" or "mm/aaaa" typed by the person → ISO date, or null when incomplete/invalid. */
export function parseBrDate(text: string, precision: 'day' | 'month'): string | null {
  const m = precision === 'day' ? text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/) : text.match(/^(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const [d, mo, y] = precision === 'day' ? [+m[1], +m[2], +m[3]] : [1, +m[1], +m[2]];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

/** Inserts the slashes while typing: 18092026 → 18/09/2026. */
function mask(text: string, precision: 'day' | 'month'): string {
  const digits = text.replace(/\D/g, '').slice(0, precision === 'day' ? 8 : 6);
  if (precision === 'month') return digits.length > 2 ? `${digits.slice(0, 2)}/${digits.slice(2)}` : digits;
  return [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4)].filter(Boolean).join('/');
}

const toBr = (iso: string, precision: 'day' | 'month') => {
  const [y, m, d] = iso.split('-');
  return precision === 'day' ? `${d}/${m}/${y}` : `${m}/${y}`;
};

type Cover = { name: string; size: number; uri: string; file?: File };

function formatSize(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

/** Shared by "03 — Criar evento" and "04 — Editar evento". */
export function EventForm({ event }: { event?: EventItem }) {
  const { account } = useAuth();
  const editing = !!event;
  const [themes, setThemes] = useState<Theme[]>([]);
  const [name, setName] = useState(event?.name ?? '');
  const [themeIds, setThemeIds] = useState<number[]>(event?.themes.map((t) => t.id) ?? []);
  const [precision, setPrecision] = useState<DatePrecision>(event?.date_precision ?? 'day');
  const [start, setStart] = useState(event ? toBr(event.date_start, event.date_precision === 'day' ? 'day' : 'month') : '');
  const [end, setEnd] = useState(event && event.date_precision === 'month_range' ? toBr(event.date_end, 'month') : '');
  const [location, setLocation] = useState(event?.location ?? '');
  const [description, setDescription] = useState(event?.description ?? '');
  const [place, setPlace] = useState<Place>({
    postal: maskCep(event?.postal_code ?? ''), note: event?.location_note ?? '',
    pin: event?.latitude != null && event.longitude != null ? { latitude: event.latitude, longitude: event.longitude } : null,
  });
  const [raw, setRaw] = useState(event?.raw_enabled ?? false);
  const [children, setChildren] = useState(NO_CHILDREN);
  const [cover, setCover] = useState<Cover | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // The preview is stored with the dates that produced it, so a stale answer is never shown.
  const [preview, setPreview] = useState<{ key: string; expires_on: string } | null>(null);
  // "+ Novo tema": the tags are the photographer's — created here, while filling in the event.
  const [newTheme, setNewTheme] = useState<{ name: string; icon: string; error: string | null; saving: boolean } | null>(null);

  useEffect(() => { listThemes().then(setThemes).catch(() => undefined); }, []);
  // A theme the administrator inactivated is no longer offered — but an event that already has
  // it keeps it, so it stays in this event's list, marked as inactive.
  const themeOptions = [
    ...themes.map((t) => ({ value: t.id, label: t.name })),
    ...(event?.themes ?? []).filter((t) => !themes.some((a) => a.id === t.id)).map((t) => ({ value: t.id, label: `${t.name} (inativo)` })),
  ];

  async function saveTheme() {
    if (!newTheme) return;
    setNewTheme({ ...newTheme, saving: true, error: null });
    try {
      const theme = await createEventTheme(newTheme.name.trim(), newTheme.icon);
      setThemes((list) => [...list, theme].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')));
      edit('themes', setThemeIds)([...themeIds, theme.id]);  // already chosen for this event
      setNewTheme(null);
    } catch (e) {
      setNewTheme((n) => n && { ...n, saving: false, error: e instanceof ApiError ? e.message : 'Não foi possível criar o tema.' });
    }
  }

  /** Wraps a setter so the field's error disappears as soon as the person edits it. */
  const edit = <T,>(key: string, setter: (v: T) => void) => (v: T) => {
    setter(v);
    if (errors[key]) setErrors((e) => ({ ...e, [key]: '' }));
  };

  const startPrecision = precision === 'day' ? 'day' : 'month';
  const startIso = parseBrDate(start, startPrecision);
  const endIso = precision === 'month_range' ? parseBrDate(end, 'month') : null;

  // Show the NEW expiry date before the change is confirmed.
  const previewKey = editing && startIso && (precision !== 'month_range' || endIso) ? `${precision}|${startIso}|${endIso}` : null;
  useEffect(() => {
    if (!previewKey) return;
    const params = new URLSearchParams({ date_precision: precision, date_start: startIso! });
    if (endIso) params.set('date_end', endIso);
    api<{ expires_on: string }>(`/events/expiry-preview?${params}`)
      .then((r) => setPreview({ key: previewKey, expires_on: r.expires_on })).catch(() => undefined);
  }, [previewKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const newExpiry = preview && preview.key === previewKey ? preview.expires_on : null;

  // The app asks Galeria or Arquivos (08/11/2026); the site opens the browser's chooser, as before.
  async function pickCover() {
    const a = await pickJpeg('Capa do evento');
    if (!a) return;
    if (a.type !== 'image/jpeg') {
      discardPicked(a.uri);
      setErrors((e) => ({ ...e, cover: 'A capa precisa ser uma foto JPEG. Esta imagem é de outro formato (por exemplo, captura de tela).' }));
      return;
    }
    if (cover && cover.uri !== a.uri) discardPicked(cover.uri);
    setCover({ name: a.name, size: a.size, uri: a.uri, file: a.file });
    setErrors((e) => ({ ...e, cover: '' }));
  }
  // The gallery's copy of the chosen cover (it may show people) is deleted when the form closes.
  const coverUri = useRef<string | null>(null);
  useEffect(() => { coverUri.current = cover?.uri ?? null; }, [cover]);
  useEffect(() => () => { if (coverUri.current) discardPicked(coverUri.current); }, []);

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = 'Informe o nome do evento.';
    if (!themeIds.length) e.themes = 'Selecione ao menos um tema.';
    if (!startIso) e.start = precision === 'day' ? 'Informe a data no formato dd/mm/aaaa.' : 'Informe o mês no formato mm/aaaa.';
    if (precision === 'month_range' && !endIso) e.end = 'Informe o mês final no formato mm/aaaa.';
    if (!location.trim()) e.location = 'Informe o local do evento.';
    if (!description.trim()) e.description = 'Informe a descrição do evento.';
    if (place.postal && place.postal.replace(/\D/g, '').length !== 8) e.place = 'Informe o CEP com 8 números, ou deixe em branco.';
    if (!editing && !cover) e.cover = 'Selecione a imagem de capa (JPEG).';
    if (cover && cover.size > 25 * 1024 * 1024) e.cover = 'A capa deve ter no máximo 25 MB.';
    const missing = editing ? null : childrenProblem(children);
    if (missing) e.children = missing;
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function submit() {
    setServerError(null);
    if (!validate()) return;
    const form = new FormData();
    form.append('name', name.trim());
    themeIds.forEach((id) => form.append('theme_ids', String(id)));
    form.append('date_precision', precision);
    form.append('date_start', startIso!);
    if (endIso) form.append('date_end', endIso);
    form.append('location', location.trim());
    form.append('description', description.trim());
    if (place.postal) form.append('postal_code', place.postal);
    if (place.pin) {
      form.append('latitude', place.pin.latitude.toFixed(6));
      form.append('longitude', place.pin.longitude.toFixed(6));
    }
    if (place.note.trim()) form.append('location_note', place.note.trim());
    // Editing leaves RAW alone: it is switched in "Configuração do evento" (24/10/2026).
    if (!editing) form.append('raw_enabled', String(raw));
    // The children switch, like RAW, is changed later in "Configuração do evento".
    if (!editing && children.on) {
      form.append('has_children', 'true');
      form.append('children_declared', String(children.declared));
      form.append('children_reference', children.reference.trim());
    }
    if (cover) {
      // The browser's file, or the phone's (sent as expo-file-system's File by the app's fetch: api/upload.native.ts).
      appendFile(form, 'cover', Platform.OS === 'web' && cover.file ? cover.file : { uri: cover.uri, type: 'image/jpeg' }, cover.name);
    }
    setSaving(true);
    try {
      const saved = await api<EventItem>(event ? `/events/${event.id}` : '/events',
                                         { method: editing ? 'PUT' : 'POST', body: form });
      router.replace(`/eventos/${saved.id}`);
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Não foi possível salvar o evento.');
    } finally {
      setSaving(false);
    }
  }

  const ownerName = event?.owner.full_name ?? account?.full_name ?? '';
  return (
    <Card padding={24} style={{ gap: 20 }}>
      {serverError && <Notice tone="danger" icon={TriangleAlert} title="Não foi possível salvar" description={serverError} />}

      {/* zIndex on the whole row: the themes menu must open ABOVE the sections below it
          (on the web a z-index only competes with siblings of the same parent). */}
      <View style={[styles.row, { zIndex: 40 }]}>
        <Field label="Nome do evento" error={errors.name} style={styles.half}>
          <Input placeholder="Digite o nome do evento" value={name} onChangeText={edit('name', setName)} maxLength={150}
                 invalid={!!errors.name} accessibilityLabel="Nome do evento" />
        </Field>
        <Field label="Temas" error={errors.themes} style={[styles.half, { zIndex: 30 }]}>
          {/* Wraps: on a phone the field takes the whole line and "Novo tema" goes under it (the text was cut). */}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'flex-start' }}>
            <View style={{ flexGrow: 1, flexBasis: 220, minWidth: 0 }}>
              <Select multiple placeholder="Selecione um ou mais temas" accessibilityLabel="Temas"
                      options={themeOptions} value={themeIds}
                      onChange={edit('themes', setThemeIds)} invalid={!!errors.themes} />
            </View>
            <Button variant="secondary" icon={Plus} label="Novo tema" onPress={() => setNewTheme({ name: '', icon: 'tag', error: null, saving: false })} />
          </View>
        </Field>
      </View>

      <View style={{ gap: 10 }}>
        <Text style={styles.label}>Data</Text>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }} accessibilityRole="radiogroup">
          {PRECISIONS.map((p) => {
            const on = p.value === precision;
            return (
              <Pressable key={p.value} accessibilityRole="radio" accessibilityState={{ checked: on }} aria-checked={on}
                         onPress={() => { setPrecision(p.value); setStart(''); setEnd(''); }}
                         style={[styles.chip, { backgroundColor: on ? panel.primarySoft : panel.page }]}>
                <Text style={[styles.chipText, { color: on ? panel.primaryText : panel.muted }]}>{p.label}</Text>
              </Pressable>
            );
          })}
        </View>
        <View style={styles.row}>
          <View style={[styles.half, { flexDirection: 'row', gap: 12 }]}>
            <Field error={errors.start} style={{ flex: 1 }}>
              <Input icon={Calendar} value={start} onChangeText={edit('start', (t: string) => setStart(mask(t, startPrecision)))}
                     placeholder={startPrecision === 'day' ? 'dd/mm/aaaa' : precision === 'month' ? 'mm/aaaa' : 'Início (mm/aaaa)'}
                     keyboardType="number-pad" invalid={!!errors.start}
                     accessibilityLabel={precision === 'month_range' ? 'Mês inicial' : 'Data do evento'} />
            </Field>
            {precision === 'month_range' && (
              <Field error={errors.end} style={{ flex: 1 }}>
                <Input icon={Calendar} value={end} onChangeText={edit('end', (t: string) => setEnd(mask(t, 'month')))} placeholder="Fim (mm/aaaa)"
                       keyboardType="number-pad" invalid={!!errors.end} accessibilityLabel="Mês final" />
              </Field>
            )}
          </View>
          <Field label="Local" error={errors.location} style={styles.half}>
            {/* Free text: the place is a string; the design had a fixed list. */}
            <Input placeholder="Campus, unidade ou espaço" value={location} onChangeText={edit('location', setLocation)} maxLength={150}
                   invalid={!!errors.location} accessibilityLabel="Local" />
          </Field>
        </View>
        <Text style={styles.help}>Para intervalos, informe início e fim. O intervalo máximo é de 12 meses.</Text>
      </View>

      <Field label="Descrição" error={errors.description} help={`${description.length} de 300 caracteres`}>
        <Input multiline placeholder="Descreva o evento e seu contexto institucional." value={description}
               onChangeText={edit('description', setDescription)} maxLength={300} invalid={!!errors.description} accessibilityLabel="Descrição" />
      </Field>

      {!event || event.can_edit_map ? (
        <PlacePicker value={place} error={errors.place} onChange={edit('place', setPlace)}
                     onStreet={(street) => { if (!location.trim()) edit('location', setLocation)(street.slice(0, 150)); }} />
      ) : (
        <Notice tone="info" icon={Info} title="Mapa do local" description="Só quem criou o evento altera o mapa e a descrição de como encontrar o local." />
      )}

      {/* 22/10/2026: the RAW switch belongs to the event (off by default), with its costs in plain sight. Only when
          creating: afterwards it is switched in "Configuração do evento" (24/10/2026). */}
      {!editing && <View style={{ gap: 10 }}>
        <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: raw }} aria-checked={raw} accessibilityLabel="Aceitar arquivos RAW"
                   onPress={() => setRaw((v) => !v)} style={styles.rawRow}>
          {raw ? <SquareCheck size={22} color={panel.primary} strokeWidth={1.8} absoluteStrokeWidth />
            : <Square size={22} color={panel.muted} strokeWidth={1.8} absoluteStrokeWidth />}
          <View style={{ flex: 1, gap: 2 }}>
            <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
              <Camera size={16} color={panel.text} strokeWidth={1.8} absoluteStrokeWidth />
              <Text style={styles.label}>Aceitar arquivos RAW (formato bruto de câmera)</Text>
            </View>
            <Text style={styles.help}>DNG, CR2, CR3, NEF, ARW e similares. Desligado, o evento recebe JPEG, PNG, HEIC e WebP.</Text>
          </View>
        </Pressable>
        {raw && (
          <Notice tone="warning" icon={TriangleAlert} title="Antes de usar RAW neste evento"
                  description="O RAW chega ao público SEM a edição do fotógrafo: o sistema revela com os ajustes padrão da câmera. Cada arquivo ocupa de 3 a 5 vezes o espaço de um JPEG e demora mais para enviar e processar; muitos de uma vez podem sobrecarregar o servidor. Recomendado: enviar a fotografia editada e exportada em JPEG de alta qualidade. Quem colabora no evento também poderá enviar RAW. Dá para ligar e desligar depois, em “Configuração do evento”." />
        )}
      </View>}

      {!editing && (
        <ChildrenDeclaration value={children} error={errors.children}
                             onChange={(v) => { setChildren(v); setErrors(({ children: _, ...rest }) => rest); }} />
      )}

      <View style={{ gap: 10 }}>
        <Text style={styles.label}>Capa do evento</Text>
        {cover || editing ? (
          <View style={styles.coverRow}>
            <Image source={{ uri: cover ? cover.uri : coverUrl(event?.id ?? '') }} style={styles.coverThumb} contentFit="cover"
                   accessibilityLabel="Capa do evento" />
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={styles.coverName} numberOfLines={1}>{cover ? cover.name : 'Capa atual'}</Text>
              {cover && <Text style={styles.help}>JPEG · {formatSize(cover.size)}</Text>}
            </View>
            <Button variant="secondary" label={editing || cover ? 'Substituir capa' : 'Selecionar capa'} onPress={pickCover} />
          </View>
        ) : (
          <Pressable accessibilityRole="button" onPress={pickCover} style={[styles.drop, !!errors.cover && { borderColor: panel.danger }]}>
            <ImagePlus size={24} color={panel.primary} strokeWidth={1.6} absoluteStrokeWidth />
            <Text style={styles.dropText}>Selecionar capa JPEG</Text>
          </Pressable>
        )}
        {!!errors.cover && <Text style={styles.error}>{errors.cover}</Text>}
        <Text style={styles.help}>
          Use uma imagem pública representativa, sem identificação proeminente de participantes. Ela é a única foto do evento
          exibida publicamente sem reconhecimento facial.
        </Text>
      </View>

      {event && newExpiry && newExpiry !== event.expires_on && (
        <Notice tone="warning" icon={TriangleAlert} title="Atenção à data"
                description={`A expiração do acervo passará de ${isoToBr(event.expires_on)} para ${isoToBr(newExpiry)} ao salvar.`} />
      )}
      <Notice tone="info" icon={Info} title={editing ? 'Fotógrafo responsável' : 'Associação automática'}
              description={editing ? `${ownerName} é o responsável por este evento.`
                : `O fotógrafo autenticado, ${ownerName}, será associado automaticamente ao evento.`} />

      <View style={styles.actions}>
        <Button variant="secondary" label="Cancelar" onPress={() => (router.canGoBack() ? router.back() : router.replace('/eventos'))} />
        <Button label={editing ? 'Salvar alterações' : 'Criar evento'} onPress={submit} loading={saving} />
      </View>
      <Modal visible={!!newTheme} onClose={() => setNewTheme(null)} icon={Plus} title="Novo tema" width={720}>
        {newTheme && (
          <View style={{ gap: 16 }}>
            <Text style={styles.help}>
              O tema vira um filtro público para todos os eventos. Ele já entra selecionado neste evento.
            </Text>
            <View style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-end' }}>
              <View style={styles.themePreview}><ThemeIcon name={newTheme.icon} size={24} color={panel.primary} strokeWidth={1.7} absoluteStrokeWidth /></View>
              <Field label="Nome do tema" error={newTheme.error ?? undefined} style={{ flex: 1 }}>
                <Input value={newTheme.name} maxLength={50} placeholder="Ex.: Robótica" accessibilityLabel="Nome do novo tema"
                       onChangeText={(t) => setNewTheme((n) => n && { ...n, name: t, error: null })} invalid={!!newTheme.error} />
              </Field>
            </View>
            <Text style={styles.label}>Símbolo</Text>
            <ScrollView style={{ maxHeight: 300 }}>
              <IconPicker value={newTheme.icon} onChange={(icon) => setNewTheme((n) => n && { ...n, icon })} />
            </ScrollView>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 10 }}>
              <Button variant="secondary" label="Cancelar" onPress={() => setNewTheme(null)} />
              <Button label="Criar tema" loading={newTheme.saving} disabled={newTheme.name.trim().length < 2} onPress={saveTheme} />
            </View>
          </View>
        )}
      </Modal>
    </Card>
  );
}

const styles = StyleSheet.create({
  rawRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', padding: 14, borderRadius: 10, borderWidth: 1, borderColor: panel.border },
  row: { flexDirection: 'row', gap: 18, flexWrap: 'wrap', alignItems: 'flex-end' },
  half: { flexGrow: 1, flexBasis: 300, flexShrink: 1, maxWidth: '100%' },
  label: { fontFamily: fonts.bold, fontSize: 12, color: panel.text },
  help: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 17, color: panel.muted },
  themePreview: { width: 46, height: 46, borderRadius: 23, backgroundColor: panel.primarySoft, alignItems: 'center', justifyContent: 'center' },
  error: { fontFamily: fonts.regular, fontSize: 12, color: panel.danger },
  chip: { minHeight: 26, paddingVertical: 3, borderRadius: 999, paddingHorizontal: 10, justifyContent: 'center' },
  chipText: { fontFamily: fonts.bold, fontSize: 12 },
  drop: { height: 118, borderWidth: 1, borderColor: panel.border, borderRadius: panel.radius, alignItems: 'center',
          justifyContent: 'center', gap: 8, borderStyle: 'dashed' },
  dropText: { fontFamily: fonts.bold, fontSize: 14, color: panel.primary },
  coverRow: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 12, borderWidth: 1, borderColor: panel.border,
              borderRadius: panel.radius, flexWrap: 'wrap' },
  coverThumb: { width: 96, height: 64, borderRadius: 8, backgroundColor: panel.page },
  coverName: { fontFamily: fonts.bold, fontSize: 14, color: panel.text },
  actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 12 },
});
