import { Image } from '@/ui/Image';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { ChevronDown, ChevronRight, CircleCheck, Download, ExternalLink, Image as ImageIcon, ShieldAlert, TriangleAlert, UserX } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { API_URL } from '@/api/client';
import { coverUrl } from '@/api/events';
import { formatDate } from '@/api/images';
import {
  decideMarks, markedImageUrl, namedDownloadLink, personProfile, referencePhotoUrl, type MarkedImage, type Profile, type ProfileEvent,
} from '@/api/institutional';
import { ChangedTag } from '@/components/panel/ChangedTag';
import { maskDay, parseDay } from '@/components/panel/dates';
import { FileDetails } from '@/components/panel/FileDetails';
import { FullscreenViewer } from '@/components/panel/FullscreenViewer';
import { PageHeader } from '@/components/panel/PageHeader';
import { Select } from '@/components/panel/Select';
import { Button, Card, Field, Input, Notice, Pill } from '@/components/panel/ui';
import { fonts, panel } from '@/theme/tokens';
import { saveFile } from '@/ui/saveFile';

const PERIODS = [
  // A real option (28/10/2026): as only the placeholder, it disappeared once another period was chosen.
  { value: 'all', label: 'Todo o período' },
  { value: 'm1', label: 'Último mês' },
  { value: 'm2', label: 'Últimos 2 meses' },
  { value: 'm3', label: 'Últimos 3 meses' },
  { value: 'm6', label: 'Últimos 6 meses' },
  { value: 'm12', label: 'Último ano' },
  { value: 'custom', label: 'Escolher as datas…' },
] as const;
type Period = (typeof PERIODS)[number]['value'];

/** The dates sent to the server: a "last N months" choice, or the days typed (de … até …). */
function range(p: Period | null, from: string, to: string): { date_from: string | null; date_to: string | null } {
  if (!p || p === 'all') return { date_from: null, date_to: null };
  if (p === 'custom') return { date_from: parseDay(from), date_to: parseDay(to) };
  const d = new Date();
  d.setMonth(d.getMonth() - Number(p.slice(1)));
  return { date_from: d.toISOString().slice(0, 10), date_to: null };
}

type Photo = MarkedImage & { event: ProfileEvent };

/**
 * The reference photos of the signed term (31/10/2026): one large, the others small below; a click on a
 * small one brings it up. On the person's card, and beside the photo in full screen to compare the two faces.
 */
function ReferencePhotos({ personId, ids, name, large, dark = false }: {
  personId: string; ids: string[]; name: string; large: { width: number; height: number }; dark?: boolean;
}) {
  const [shown, setShown] = useState(0);
  const current = ids[Math.min(shown, ids.length - 1)];
  if (!current) return null;
  return (
    <View style={{ gap: 8 }}>
      <Image source={{ uri: referencePhotoUrl(personId, current) }} contentFit="cover" recyclingKey={current}
             accessibilityLabel={`Foto de referência ${shown + 1} de ${name}`}
             style={[large, styles.reference, dark && { backgroundColor: '#0B0F14' }]} />
      {ids.length > 1 && (
        <View style={styles.referenceRow}>
          {ids.map((photoId, i) => (
            <Pressable key={photoId} accessibilityRole="button" accessibilityState={{ selected: i === shown }} aria-pressed={i === shown}
                       accessibilityLabel={`Ver a foto de referência ${i + 1}`} onPress={() => setShown(i)}
                       style={[styles.referenceThumb, i === shown && { borderColor: panel.primary }]}>
              <Image source={{ uri: referencePhotoUrl(personId, photoId, true) }} style={styles.referenceSmall} contentFit="cover"
                     accessibilityLabel={`Foto de referência ${i + 1}`} />
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The person's page: who the person is and, event by event, the photos where
 * the person was found. Built for the photographer who has to send a photo of, say, the coordinator to a
 * journalist quickly: find the person, open a photo in full screen, confirm it is the person (or say it is
 * not), download it already named after the person. Events without the person do not appear.
 */
export default function PersonPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [period, setPeriod] = useState<Period>('all');
  const [from, setFrom] = useState('');   // "Escolher as datas…": dd/mm/aaaa
  const [to, setTo] = useState('');
  // Events start closed (a person with 50 events: a list of names, not a wall of photos); a click opens one.
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);   // the photo in full screen
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dates = range(period, from, to);
  const badRange = period === 'custom' && ((from && !dates.date_from) || (to && !dates.date_to)
    || (dates.date_from && dates.date_to && dates.date_from > dates.date_to));
  // Typing a date asks the server at each digit, and an older, slower answer ("desde 01/01/2020", without the end)
  // could arrive last and show the wrong events (01/11/2026). Only the newest request may fill the screen.
  const latest = useRef(0);
  const load = useCallback(() => {
    if (badRange) return;
    const n = ++latest.current;
    personProfile(id, dates).then((p) => { if (n === latest.current) { setProfile(p); setError(null); } })
      .catch((e) => { if (n === latest.current) setError(e.message); });
  }, [id, dates.date_from, dates.date_to, badRange]); // eslint-disable-line react-hooks/exhaustive-deps
  useFocusEffect(load);

  const photos: Photo[] = profile ? profile.events.flatMap((e) => e.images.map((img) => ({ ...img, event: e }))) : [];
  const pos = openId ? photos.findIndex((p) => p.image_id === openId) : -1;
  const open = pos >= 0 ? photos[pos] : null;
  const prevId = pos > 0 ? photos[pos - 1].image_id : null;
  const nextId = pos >= 0 && pos < photos.length - 1 ? photos[pos + 1].image_id : null;

  useEffect(() => {
    if (Platform.OS !== 'web' || !openId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' && prevId) setOpenId(prevId);
      if (e.key === 'ArrowRight' && nextId) setOpenId(nextId);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openId, prevId, nextId]);

  /** Decided inside the full screen. Confirmed, it moves on to the next photo; "não é esta pessoa", the photo
   *  leaves the list for good and the next one takes its place. Ids are PARAMETERS (React
   *  Compiler: never read the nullable state inside the handler). */
  async function decideOne(imageId: string, confirm: boolean, then: string | null) {
    setBusy(true); setError(null);
    try {
      await decideMarks(id, [imageId], confirm);
      setProfile(await personProfile(id, range(period, from, to)));
      setOpenId(then);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível registrar a decisão.');
    } finally {
      setBusy(false);
    }
  }

  async function download(imageId: string) {
    setError(null);
    try {
      const { url } = await namedDownloadLink(id, imageId);
      await saveFile(`${API_URL}${url}`, 'Salvar foto');   // the site: the browser saves it; the app: Salvar/Compartilhar
    } catch (e) { setError(e instanceof Error ? e.message : 'Não foi possível baixar. Tente novamente.'); }
  }

  if (!profile) return error ? <Notice tone="danger" icon={TriangleAlert} title={error} /> : <Card><ActivityIndicator color={panel.primary} /></Card>;
  const { person, events } = profile;
  const first = person.full_name.split(' ')[0];
  const pending = photos.filter((p) => p.status === 'pending').length;

  return (
    <View style={{ gap: 20 }}>
      <PageHeader crumbs={[{ label: 'Pessoas institucionais', href: '/pessoas-institucionais' }, { label: person.full_name }]}
                  title={person.full_name} subtitle={`${person.position}${person.unit ? ` · ${person.unit}` : ''}`}
                  badge={(
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, zIndex: 30 }}>
                      <Pill label="Pessoa autorizada" bg={panel.successSoft} fg={panel.success} />
                      {/* Name or position corrected after the registration: "alterado", with the date on hover. */}
                      <ChangedTag at={[person.name_changed_at, person.position_changed_at, person.unit_changed_at]
                        .filter(Boolean).sort().pop()} />
                    </View>)} />

      <Card padding={20} style={styles.personCard}>
        {person.photo_ids?.length ? (
          <ReferencePhotos personId={id} ids={person.photo_ids} name={person.full_name} large={{ width: 132, height: 132 }} />
        ) : null}
        <View style={{ flex: 1, minWidth: 220, gap: 6 }}>
          <Text style={styles.label}>Nome</Text>
          <Text style={styles.personName}>{person.full_name}</Text>
          <Text style={styles.label}>Cargo</Text>
          <Text style={styles.personValue}>{person.position}</Text>
          {person.unit && (<><Text style={styles.label}>Unidade</Text><Text style={styles.personValue}>{person.unit}</Text></>)}
          <Text style={styles.text}>As fotos ao lado são as do termo assinado. Use-as para conferir se cada foto encontrada é mesmo de {first}.</Text>
        </View>
      </Card>

      <Card padding={20} style={styles.summary}>
        <View style={{ flex: 1, minWidth: 240, gap: 4 }}>
          <Text style={styles.big}>{photos.length ? `${plural(photos.length, 'foto', 'fotos')} em ${plural(events.length, 'evento', 'eventos')}` : 'Nenhuma foto encontrada'}</Text>
          <Text style={styles.text}>
            {pending ? `${plural(pending, 'foto ainda não confirmada', 'fotos ainda não confirmadas')}. Abra a foto e diga se é ${first}.`
              : photos.length ? 'Todas as fotos confirmadas.' : `As fotos aparecem quando ${first} for localizado em algum evento publicado.`}
          </Text>
        </View>
        <Field label="Período (data do evento)" style={{ width: 240 }}>
          <Select placeholder="Todo o período" options={[...PERIODS]} value={period} onChange={(p) => setPeriod(p ?? 'all')} accessibilityLabel="Período" />
        </Field>
        {period === 'custom' && (
          <View style={styles.range}>
            <Field label="De" style={{ width: 150 }}>
              <Input value={from} onChangeText={(t) => setFrom(maskDay(t))} placeholder="dd/mm/aaaa" inputMode="numeric"
                     maxLength={10} accessibilityLabel="Data inicial (dd/mm/aaaa)" invalid={!!from && !dates.date_from} />
            </Field>
            <Field label="Até" style={{ width: 150 }}>
              <Input value={to} onChangeText={(t) => setTo(maskDay(t))} placeholder="dd/mm/aaaa" inputMode="numeric"
                     maxLength={10} accessibilityLabel="Data final (dd/mm/aaaa)" invalid={!!to && !dates.date_to} />
            </Field>
          </View>
        )}
      </Card>
      {badRange && <Notice tone="warning" icon={TriangleAlert} title="Confira as datas: use dd/mm/aaaa, e a data inicial não pode ser depois da final." />}

      {error && <Notice tone="danger" icon={TriangleAlert} title={error} />}
      {!profile.press_allowed && photos.length > 0 && (
        <Notice tone="warning" icon={ShieldAlert} title="Download com o nome indisponível para esta pessoa"
                description={`${person.full_name} assinou a versão anterior do termo, que não prevê o envio à imprensa com o nome. As fotos podem ser consultadas e confirmadas; para baixá-las com o nome, é preciso assinar a versão atual do termo.`} />
      )}

      {photos.length > 0 && (
        <Notice tone="warning" icon={ShieldAlert} title="Confirmação humana necessária"
                description={`O reconhecimento indica semelhança, não identidade. Antes de usar uma foto, confirme que ${person.full_name} aparece nela e que o contexto é adequado. Só fotos confirmadas podem ser baixadas.`} />
      )}
      {events.length > 1 && (
        <View style={styles.expandRow}>
          <Button variant="secondary" label={opened.size === events.length ? 'Fechar todos' : 'Abrir todos'}
                  onPress={() => setOpened(opened.size === events.length ? new Set() : new Set(events.map((e) => e.id)))} />
        </View>
      )}
      {events.map((e) => {
        const isOpen = events.length === 1 || opened.has(e.id);
        const Arrow = isOpen ? ChevronDown : ChevronRight;
        const toggle = () => setOpened((all) => { const n = new Set(all); if (n.has(e.id)) n.delete(e.id); else n.add(e.id); return n; });
        return (
        <Card key={e.id} padding={20} style={{ gap: 14 }}>
          <View style={styles.eventHead}>
            <Pressable accessibilityRole="button" accessibilityState={{ expanded: isOpen }} aria-expanded={isOpen} accessibilityLabel={`${e.name}: ${isOpen ? 'fechar' : 'ver as fotos'}`}
                       onPress={toggle} style={{ flex: 1, minWidth: 240, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              {/* 28/10/2026: the cover on the left tells the events apart; the arrow goes after the name. */}
              {e.can_open && e.cover_version ? (
                <Image source={{ uri: coverUrl(e.id, e.cover_version) }} style={styles.cover} contentFit="cover"
                       accessibilityLabel={`Capa do evento ${e.name}`} />
              ) : (
                <View style={[styles.cover, styles.noCover]}><ImageIcon size={20} color={panel.muted} strokeWidth={1.6} absoluteStrokeWidth /></View>
              )}
              <View style={{ flex: 1, gap: 3 }}>
                <Text style={styles.eventName}>{e.name}</Text>
                <Text style={styles.text}>{e.date_label} · {e.location} · {plural(e.images.length, 'foto', 'fotos')} de {e.total} do evento</Text>
              </View>
              <Arrow size={20} color={panel.primary} strokeWidth={2} absoluteStrokeWidth />
            </Pressable>
            {e.can_open && (
              <Button variant="secondary" icon={ExternalLink} label="Abrir evento" onPress={() => router.navigate(`/eventos/${e.id}`)} />)}
          </View>
          {isOpen && (
          <View style={styles.grid}>
            {e.images.map((img) => (
              <Pressable key={img.image_id} accessibilityRole="button" accessibilityLabel={`Abrir foto de ${e.name} em tela cheia`}
                         onPress={() => setOpenId(img.image_id)} style={({ hovered }: any) => [styles.card, hovered && { borderColor: panel.primary }]}>
                <Image source={{ uri: markedImageUrl(id, img.image_id, 'thumb', img.version) }} style={styles.photo}
                       contentFit="cover" recyclingKey={img.image_id} accessibilityLabel="" />
                <View style={styles.cardFoot}>
                  {img.status === 'confirmed'
                    ? <Pill label="Confirmada" bg={panel.successSoft} fg={panel.success} />
                    : <Pill label="A confirmar" bg={panel.warningSoft} fg={panel.warning} />}
                  <Text style={styles.meta} numberOfLines={1}>{img.captured_at ? formatDate(img.captured_at) : img.signature}</Text>
                </View>
              </Pressable>
            ))}
          </View>
          )}
        </Card>
        );
      })}


      {open && (
        <FullscreenViewer visible onClose={() => setOpenId(null)}
                          compare={person.photo_ids?.length ? {
                            label: 'Fotos do termo',
                            content: <ReferencePhotos personId={id} ids={person.photo_ids} name={person.full_name}
                                                      large={{ width: 328, height: 410 }} dark />,
                          } : undefined}
                          uri={markedImageUrl(id, open.image_id, 'preview', open.version)}
                          placeholder={markedImageUrl(id, open.image_id, 'thumb', open.version)}
                          alt={`Foto em que ${person.full_name} foi localizado`}
                          title={`${person.full_name} · foto ${pos + 1} de ${photos.length}`}
                          subtitle={`${open.event.name} · ${open.credit}`}
                          onPrev={prevId ? () => setOpenId(prevId) : undefined}
                          onNext={nextId ? () => setOpenId(nextId) : undefined}
                          details={<FileDetails imageId={open.image_id} personId={id} dark />}
                          info={(
                            <>
                              {open.status === 'confirmed'
                                ? <Pill label="Confirmada" bg={panel.successSoft} fg={panel.success} />
                                : <Pill label="A confirmar" bg={panel.warningSoft} fg={panel.warning} />}
                              <Text style={styles.viewerText}>Semelhança {Math.round(open.similarity * 100)}%</Text>
                            </>
                          )}>
          <Button variant="danger" icon={UserX} label={`Não é ${first}`} loading={busy}
                  onPress={() => decideOne(open.image_id, false, nextId ?? prevId)} />
          {open.status !== 'confirmed' && (
            <Button icon={CircleCheck} label={`É ${first}: confirmar`} loading={busy}
                    onPress={() => decideOne(open.image_id, true, nextId ?? open.image_id)} />)}
          {open.status === 'confirmed' && profile.press_allowed && (
            <Button icon={Download} label="Baixar com o nome" onPress={() => download(open.image_id)} />)}
        </FullscreenViewer>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  summary: { flexDirection: 'row', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' },
  personCard: { flexDirection: 'row', alignItems: 'flex-start', gap: 20, flexWrap: 'wrap' },
  personName: { fontFamily: fonts.bold, fontSize: 20, color: panel.text },
  personValue: { fontFamily: fonts.semiBold, fontSize: 15, color: panel.text },
  label: { fontFamily: fonts.regular, fontSize: 12, color: panel.muted, marginTop: 2 },
  reference: { borderRadius: 10, backgroundColor: panel.page },
  referenceRow: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  referenceThumb: { borderWidth: 2, borderColor: 'transparent', borderRadius: 8, padding: 1 },
  referenceSmall: { width: 40, height: 40, borderRadius: 6, backgroundColor: panel.page },
  big: { fontFamily: fonts.semiBold, fontSize: 17, color: panel.text },
  text: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: panel.muted },
  range: { flexDirection: 'row', gap: 12, alignItems: 'flex-end' },
  expandRow: { flexDirection: 'row', justifyContent: 'flex-end', marginBottom: -8 },
  eventHead: { flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  cover: { width: 72, height: 48, borderRadius: 8, backgroundColor: panel.page },
  noCover: { alignItems: 'center', justifyContent: 'center' },
  eventName: { fontFamily: fonts.semiBold, fontSize: 16, color: panel.text },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  card: { width: 186, backgroundColor: panel.surface, borderWidth: 1, borderColor: panel.border, borderRadius: 10, padding: 7, gap: 8,
          cursor: 'zoom-in' as never },
  photo: { width: 170, height: 118, borderRadius: 7, backgroundColor: panel.page },
  cardFoot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6 },
  meta: { fontFamily: fonts.regular, fontSize: 12, color: panel.muted, flexShrink: 1 },
  viewerText: { fontFamily: fonts.regular, fontSize: 13, color: 'rgba(255, 255, 255, 0.75)' },
});
