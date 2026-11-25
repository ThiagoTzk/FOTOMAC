import { Image } from '@/ui/Image';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Baby, CalendarClock, CalendarDays, Camera, ChevronDown, ChevronUp, Images, MapPin, ScanFace } from 'lucide-react-native';
import { useCallback, useEffect, useRef, useState, type ComponentRef } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  checkCaptureStep, endVisit, failureReason, getPublicEvent, giveConsent, publicCoverUrl, searchFaces, startCapture, type PublicEvent,
  type ResultItem, type VideoResult,
} from '@/api/public';
import { ThemeIcon } from '@/components/icons/themeIcons';
import { EventPlace } from '@/components/map/EventPlace';
import { discardFrames, frameSource, releaseSource } from '@/components/capture/camera';
import type { Frame } from '@/components/capture/camera.types';
import { GuidedCapture, type Step } from '@/components/capture/GuidedCapture';
import { ConsentModal } from '@/components/visitor/ConsentModal';
import { Meta } from '@/components/visitor/EventCard';
import { VisitorHeader } from '@/components/visitor/Header';
import { PhotoViewer } from '@/components/visitor/PhotoViewer';
import { RemovalModal } from '@/components/visitor/Removal';
import { Results } from '@/components/visitor/Results';
import { VideoRemovalModal, VideoViewer } from '@/components/visitor/VideoViewer';
import { SearchCard } from '@/components/visitor/SearchCard';
import { SearchTips } from '@/components/visitor/SearchTips';
import { Column, eventDate, Note, ThemePills, useWide, VButton, vtext } from '@/components/visitor/ui';
import { PageBand, web, WebPage, Wrap } from '@/components/visitor/web/Site';
import { poppins, visitor } from '@/theme/tokens';

/**
 * Event page with a PRIVATE gallery + facial search.
 *
 * No photo of the event is ever listed here before a search — the server would refuse it
 * anyway. After the search, only the photos found for THIS visitor appear.
 */
export default function EventPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [event, setEvent] = useState<PublicEvent | null>(null);
  const [notFound, setNotFound] = useState<string | null>(null);
  const [consented, setConsented] = useState(false);
  const [results, setResults] = useState<ResultItem[] | null>(null);
  const [selfie, setSelfie] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [consentOpen, setConsentOpen] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [viewer, setViewer] = useState<number | null>(null);
  const [removing, setRemoving] = useState<ResultItem | null>(null);
  // RF035 (04/11/2026): the videos where the visitor was found, the one playing and the one asked to go.
  const [videos, setVideos] = useState<VideoResult[]>([]);
  // The tab of the result (photos or videos) lives here, so a redraw of the result never sends the person back.
  const [resultTab, setResultTab] = useState<'photos' | 'videos'>('photos');
  const [playing, setPlaying] = useState<VideoResult | null>(null);
  const [removingVideo, setRemovingVideo] = useState<VideoResult | null>(null);
  const [expanded, setExpanded] = useState(false);
  const consentAnswer = useRef<((ok: boolean) => void) | null>(null);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const resultsY = useRef(0);
  const resultsBox = useRef<ComponentRef<typeof View>>(null);
  const wide = useWide();

  useEffect(() => {
    getPublicEvent(id).then(setEvent).catch((e) => setNotFound(e.status === 404 ? 'Evento não encontrado ou não está mais disponível.' : e.message));
  }, [id]);

  // The result exists only while this page is ON SCREEN. Entering ends any previous visit;
  // leaving (back, home, menu, another event) ends this one — on the server AND in this page's
  // memory. Focus, not mount: the router may keep a left screen alive underneath the next one,
  // and coming back would show the old photos. On a shared computer the next person must never
  // see someone else's photos.
  useFocusEffect(useCallback(() => {
    endVisit();
    return () => {
      endVisit();
      setResults(null);
      setVideos([]);
      setPlaying(null);
      setRemovingVideo(null);
      setSelfie(null);
      setConsented(false);
      setViewer(null);
      setRemoving(null);
      setCameraOpen(false);
      setSearchError(null);
    };
    // "id": opening ANOTHER event in this same screen also starts a clean visit.
  }, [id])); // eslint-disable-line react-hooks/exhaustive-deps

  // Closing or reloading the tab also ends the visit.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    window.addEventListener('pagehide', endVisit);
    return () => window.removeEventListener('pagehide', endVisit);
  }, []);

  // The preview of the frontal frame exists only while this page shows it; it is released when leaving (in the app the
  // file itself is deleted).
  const selfieFrame = useRef<Frame | null>(null);
  useEffect(() => {
    const shown = selfieFrame.current;   // the frame of THIS selfie: a new search replaces the ref before this cleanup runs
    return () => {
      if (selfie) releaseSource(selfie);
      if (shown) discardFrames([shown]);
    };
  }, [selfie]);

  function askConsent() {
    setConsentOpen(true);
    return new Promise<boolean>((resolve) => { consentAnswer.current = resolve; });
  }
  function answerConsent(ok: boolean) {
    setConsentOpen(false);
    consentAnswer.current?.(ok);
    consentAnswer.current = null;
  }

  function openCapture() {
    setSearchError(null);
    setCameraOpen(true);
  }

  // Both buttons of the page come through here: the consent notice always comes before the camera.
  async function startSearch() {
    if (consented || (await askConsent())) openCapture();
  }

  /** The order of the movements comes from the server, asked when "Começar" is pressed. */
  async function getOrder(): Promise<Step[]> {
    try {
      return (await startCapture(id)).order;
    } catch (e) {
      if (failureReason(e) === 'consent_required') {  // the visit expired: close and ask the consent again
        setConsented(false);
        setCameraOpen(false);
        setSearchError(e instanceof Error ? e.message : 'Confirme o aviso de permissão novamente.');
      }
      throw e;
    }
  }

  async function search(frames: Frame[], steps: Step[]) {
    setCameraOpen(false);
    setBusy(true);
    setSearchError(null);
    const front = frames[steps.indexOf('frente')];
    setSelfie(front ? frameSource(front) : null);
    selfieFrame.current = front ?? null;
    try {
      const r = await searchFaces(id, frames, steps);
      setResults(r.items);
      setVideos(r.videos ?? []);
      setResultTab(r.items.length ? 'photos' : 'videos');
      setTimeout(() => {
        // Web layout: the results sit deep inside the page's bands, so the browser itself scrolls
        // to them (a ScrollView offset would be relative to the wrong parent).
        if (wide && Platform.OS === 'web') (resultsBox.current as unknown as HTMLElement | null)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
        else scroll.current?.scrollTo({ y: Math.max(0, resultsY.current - 16), animated: true });
      }, 50);
    } catch (e) {
      if (failureReason(e) === 'consent_required') setConsented(false); // session expired: ask again
      setSearchError(e instanceof Error ? e.message : 'Não foi possível concluir a busca.');
    } finally {
      setBusy(false);
      discardFrames(frames.filter((f) => f !== front));   // sent and answered: only the selfie stays, while shown
    }
  }

  if (notFound && wide) {
    return (
      <WebPage>
        <PageBand crumbs={[{ label: 'Eventos', href: '/explorar' }, { label: 'Evento' }]} title="Evento indisponível" />
        <Wrap style={{ paddingVertical: 48 }}><Note tone="danger">{notFound}</Note></Wrap>
      </WebPage>
    );
  }
  if (notFound) {
    return (
      <View style={styles.page}>
        <VisitorHeader back="/" />
        <Column style={{ marginTop: 32 }}><Note tone="danger">{notFound}</Note></Column>
      </View>
    );
  }
  if (!event) return <View style={[styles.page, { justifyContent: 'center' }]}><ActivityIndicator color={visitor.primary} /></View>;

  const longText = event.description.length > 220;
  const photos = event.photos === 1 ? '1 foto' : `${event.photos} fotos`;
  const until = event.expires_on.split('-').reverse().join('/');
  // How to find the event: read here, changed only by whoever created it (in the panel). It never goes above the face
  // search (02/11/2026): beside it on a computer; on a phone, below the search button, before the explanation
  // of the search (06/11/2026). With a pin the map comes open; without one, the written location takes its place.
  const place = (
    <EventPlace latitude={event.latitude} longitude={event.longitude} note={event.location_note} location={event.location}
                textColor={visitor.text} fontFamily={poppins.regular} style={[styles.webAbout, wide && { flex: 1 }]} fillMap={wide}
                mapHeight={240}
                header={<Text style={vtext.h3} accessibilityRole="header">Como encontrar o local</Text>} />
  );
  // 04/11/2026: an event with children says so, even if faces were blurred. 05/11/2026: with the event's
  // information, near its photo, not below the search.
  const CHILDREN = 'Este evento contém imagens com crianças. O uso dessas imagens tem a autorização dos responsáveis, coletada pelo CESMAC.';
  const modals = (
    <>
      <ConsentModal visible={consentOpen} onClose={() => answerConsent(false)}
                    onAccept={async () => { await giveConsent(id); setConsented(true); answerConsent(true); }} />
      <GuidedCapture visible={cameraOpen} variant="search" getOrder={getOrder} aside={<SearchTips />}
                     checkStep={(fronts, step, frames) => checkCaptureStep(id, fronts, step, frames)}
                     onClose={() => setCameraOpen(false)} onDone={search} />
      <PhotoViewer items={results ?? []} index={viewer} eventName={event.name} eventDate={event.date_label} onIndex={setViewer}
                   onRemove={(item) => { setViewer(null); setRemoving(item); }} />
      <RemovalModal item={removing} fallbackDate={event.date_label} onClose={() => setRemoving(null)}
                    onRemoved={(rid) => setResults((r) => r?.filter((x) => x.id !== rid) ?? null)} />
      <VideoViewer item={playing} eventName={event.name} eventDate={event.date_label} onClose={() => setPlaying(null)}
                   onRemove={(v) => { setPlaying(null); setRemovingVideo(v); }} />
      <VideoRemovalModal item={removingVideo} fallbackDate={event.date_label} onClose={() => setRemovingVideo(null)}
                         onRemoved={(vid) => setVideos((list) => list.filter((x) => x.id !== vid))} />
    </>
  );

  // The windows (notice, camera, photo, video) are mounted ONCE, outside the two layouts: a tablet turned from upright
  // to lying down swaps the layout, and the capture under way started over at "Começar" (06/11/2026).
  const layout = wide ? (
      <WebPage scrollRef={scroll}>
        <PageBand crumbs={[{ label: 'Eventos', href: '/explorar' }, { label: event.name }]}>
          <View style={styles.webEvent}>
            {/* The cover is the only photo of the event shown before a search. */}
            <View style={styles.webCover}>
              <Image source={publicCoverUrl(event.id)} style={StyleSheet.absoluteFill} contentFit="cover" accessible={false} accessibilityLabel="" />
            </View>
            <View style={{ flex: 1, gap: 14 }}>
              <Text style={styles.webName} accessibilityRole="header">{event.name}</Text>
              {event.themes.length > 0 && (
                <View style={styles.chips}>
                  {event.themes.map((t) => (
                    <View key={t.id} style={styles.webTheme}>
                      <ThemeIcon name={t.icon} size={15} color={web.yellow} strokeWidth={1.8} absoluteStrokeWidth />
                      <Text style={styles.webThemeText}>{t.name}</Text>
                    </View>
                  ))}
                </View>
              )}
              <View style={{ gap: 8 }}>
                <WebMeta icon={CalendarDays} text={eventDate(event)} />
                <WebMeta icon={MapPin} text={event.location} />
                <WebMeta icon={Images} text={photos} />
                {/* Who covered the event, and the institution. */}
                <WebMeta icon={Camera} text={`${event.credits.join(', ')} · CESMAC`} />
                {/* The retention actually practised, from the event's own expiry date. */}
                <WebMeta icon={CalendarClock} text={`Fotos disponíveis até ${until}`} />
                {event.has_children && <WebMeta icon={Baby} text={CHILDREN} />}
              </View>
              {/* In the band, so the page below it opens with the search and the map side by side. A long text stays
                  short here, or it would push the search down (02/11/2026). */}
              {!!event.description && (
                <View style={{ gap: 4 }}>
                  <Text style={styles.webAboutTitle}>Sobre o evento</Text>
                  <Text style={styles.webAboutText} numberOfLines={longText && !expanded ? 3 : undefined}>{event.description}</Text>
                  {longText && (
                    <Pressable accessibilityRole="button" onPress={() => setExpanded((x) => !x)} style={{ alignSelf: 'flex-start' }}>
                      <Text style={styles.webAboutMore}>{expanded ? 'Mostrar menos' : 'Mostrar mais'}</Text>
                    </Pressable>
                  )}
                </View>
              )}
            </View>
          </View>
        </PageBand>
        <Wrap style={{ paddingVertical: 48, gap: 32 }}>
          {/* 06/11/2026: after the search the "Procure suas fotos" card goes away: the result takes its place,
              with "Buscar de novo", and the map stays below it. */}
          {results === null ? (
            <View style={styles.webRow}>
              <View style={{ flex: 1, gap: 16, maxWidth: 560 }}>
                <SearchCard onStart={startSearch} busy={busy} style={{ flex: 1 }} />
                {searchError && <Note tone="danger">{searchError}</Note>}
              </View>
              <View style={{ flex: 1 }}>{place}</View>
            </View>
          ) : (
            <>
              <View ref={resultsBox} style={{ scrollMarginTop: 24, gap: 16 } as object}>
                {searchError && <Note tone="danger">{searchError}</Note>}
                <Results items={results} selfie={selfie} onOpen={setViewer} videos={videos} onPlay={setPlaying} tab={resultTab} onTab={setResultTab}
                         onSearchAgain={startSearch} busy={busy} />
              </View>
              <View style={{ maxWidth: 560 }}>{place}</View>
            </>
          )}
        </Wrap>
      </WebPage>
  ) : (
    <ScrollView ref={scroll} style={styles.page} contentContainerStyle={{ paddingBottom: 48 }}>
      <VisitorHeader back="/" />
      <View style={styles.cover}>
        <Image source={publicCoverUrl(event.id)} style={StyleSheet.absoluteFill} contentFit="cover" accessible={false} accessibilityLabel="" />
      </View>
      <View style={styles.info}>
        <Column style={{ gap: 8, paddingVertical: 16 }}>
          <View style={{ gap: 4 }}>
            <Text style={styles.name} accessibilityRole="header">{event.name}</Text>
            <ThemePills names={event.themes.map((t) => t.name)} size="md" />
          </View>
          <View style={{ gap: 4 }}>
            <Meta icon="date" text={eventDate(event)} size={13} />
            <Meta icon="place" text={event.location} size={13} />
          </View>
          <View style={styles.chips}>
            <View style={styles.chip}>
              <Images size={16} color={visitor.heading} strokeWidth={1.6} absoluteStrokeWidth />
              <Text style={styles.chipText}>{photos}</Text>
            </View>
            {/* Who covered the event, and the institution. */}
            <View style={styles.chip}>
              <Camera size={16} color={visitor.heading} strokeWidth={1.6} absoluteStrokeWidth style={{ flexShrink: 0 }} />
              <Text style={styles.chipText}>{event.credits.join(', ')} · CESMAC</Text>
            </View>
          </View>
          {event.has_children && (
            <View style={styles.children}>
              <Baby size={16} color={visitor.heading} strokeWidth={1.6} absoluteStrokeWidth />
              <Text style={[styles.chipText, { flex: 1 }]}>{CHILDREN}</Text>
            </View>
          )}
          {!!event.description && (
            <View>
              <Text style={styles.about}>Sobre o evento</Text>
              <Text style={styles.description} numberOfLines={longText && !expanded ? 4 : undefined}>{event.description}</Text>
              {longText && (
                <Pressable accessibilityRole="button" accessibilityLabel={expanded ? 'Mostrar menos' : 'Mostrar mais'}
                           onPress={() => setExpanded((x) => !x)} style={{ alignSelf: 'center', padding: 4 }}>
                  {expanded ? <ChevronUp size={24} color={visitor.heading} strokeWidth={1.6} absoluteStrokeWidth />
                    : <ChevronDown size={24} color={visitor.heading} strokeWidth={1.6} absoluteStrokeWidth />}
                </Pressable>
              )}
            </View>
          )}
          {/* 06/11/2026: the search button after "Sobre o evento", right above the date the photos stay. */}
          <VButton icon={ScanFace} label={busy ? 'Buscando suas fotos…' : 'Buscar minhas fotos'} loading={busy} onPress={startSearch} />
          {/* The retention actually practised, from the event's own expiry date. */}
          <Text style={vtext.small}>Fotos disponíveis até {until}.</Text>
        </Column>
      </View>

      {/* 06/11/2026: the map came only after the whole explanation of the search, at the end of the page. Now:
          what came of the search (error or photos) right under the button, then how to get there, then the explanation
          (the same notice also opens before the camera). */}
      <Column style={{ gap: 16, marginTop: 24 }}>
        {searchError && <Note tone="danger">{searchError}</Note>}
        {results !== null && (
          <View onLayout={(e) => { resultsY.current = e.nativeEvent.layout.y; }}>
            <Results items={results} selfie={selfie} onOpen={setViewer} videos={videos} onPlay={setPlaying} tab={resultTab} onTab={setResultTab}
                     onSearchAgain={startSearch} busy={busy} />
          </View>
        )}
        {place}
        {/* Gone once the result is on screen: the search was made (06/11/2026). */}
        {results === null && <SearchCard onStart={startSearch} busy={busy} button={false} />}
      </Column>
    </ScrollView>
  );
  return <>{layout}{modals}</>;
}

function WebMeta({ icon: Icon, text }: { icon: typeof Camera; text: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <Icon size={18} color={web.yellow} strokeWidth={1.7} absoluteStrokeWidth />
      <Text style={styles.webMeta}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: visitor.page },
  cover: { height: 120, backgroundColor: visitor.chip },
  info: { backgroundColor: visitor.surface, boxShadow: visitor.headerShadow },
  name: { fontFamily: poppins.bold, fontSize: 20, color: visitor.heading },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  // maxWidth and flexShrink: several photographers in the credit ran past the right edge (06/11/2026, event Legolas).
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4, paddingHorizontal: 8, borderRadius: 12,
          backgroundColor: visitor.chip, maxWidth: '100%' },
  chipText: { flexShrink: 1, fontFamily: poppins.regular, fontSize: 12, color: visitor.muted },
  children: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, padding: 8, borderRadius: 10, backgroundColor: visitor.chip },
  about: { fontFamily: poppins.semiBold, fontSize: 13, color: visitor.text },
  webEvent: { flexDirection: 'row', gap: 40, alignItems: 'center', marginTop: 24 },
  webCover: { width: 440, aspectRatio: 16 / 11, borderRadius: 16, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.12)',
              boxShadow: '0px 16px 40px rgba(0,0,0,0.25)' },
  webName: { fontFamily: poppins.bold, fontSize: 34, lineHeight: 42, color: '#FFFFFF' },
  webTheme: { maxWidth: '100%', flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 5, paddingHorizontal: 12, borderRadius: 999,
              backgroundColor: 'rgba(255,255,255,0.12)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)' },
  webThemeText: { flexShrink: 1, fontFamily: poppins.medium, fontSize: 13, color: '#FFFFFF' },
  webMeta: { flex: 1, fontFamily: poppins.regular, fontSize: 15, color: 'rgba(255,255,255,0.9)' },
  webAboutTitle: { fontFamily: poppins.semiBold, fontSize: 15, color: '#FFFFFF' },
  webAboutText: { fontFamily: poppins.regular, fontSize: 14, lineHeight: 21, color: 'rgba(255,255,255,0.9)' },
  webAboutMore: { fontFamily: poppins.semiBold, fontSize: 14, color: web.yellow, textDecorationLine: 'underline' },
  webRow: { flexDirection: 'row', gap: 32, alignItems: 'stretch', zIndex: 5 },
  webAbout: { backgroundColor: visitor.surface, borderRadius: 12, padding: 20, gap: 8, boxShadow: visitor.cardShadow },
  description: { fontFamily: poppins.regular, fontSize: 12, lineHeight: 18, color: visitor.muted },   // phone only: not justified
});
