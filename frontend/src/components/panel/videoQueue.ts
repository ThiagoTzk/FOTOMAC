/**
 * The line of videos being sent, ONE for the whole site (03/11/2026). It used to live inside the screen that
 * sent them: leaving that screen ("Conferir e publicar", a link in the menu) stopped the videos without a word.
 * Here it survives any navigation; only closing the tab, a logout or another account stops it.
 *
 * - One video at a time: a video is large, several at once would slow all of them.
 * - Photos go first: while the upload screen has photos to send, the next video waits (the one already on its way
 *   finishes). Photos are small and are what the person publishes first.
 * - After the transfer the server converts in the background; this file follows it until "pronto" or "falha".
 * - 05/11/2026: a converted video is not the end. While it waits for "Publicar" it stays in the line, under
 *   its event, saying "falta publicar"; it leaves only when published (or discarded, or deleted).
 *
 * The files stay only in this tab's memory, never in the browser's storage: they may show people (LGPD).
 */
import { useEffect, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';

import { ApiError } from '@/api/client';
import { getVideo, listVideos, uploadVideo, type VideoItem } from '@/api/videos';
import { holdSession } from '@/auth/idle';

export type VideoStage = 'waiting' | 'sending' | 'converting' | 'ready' | 'failed';

export type QueuedVideo = {
  key: number;
  eventId: string;
  eventName: string;
  name: string;
  size: number;
  stage: VideoStage;
  progress: number;
  error?: string;
  videoId?: string;
  /** This account publishes it: it publishes the EVENT (responsible or administrator) and no approval is pending. */
  canPublish?: boolean;
  /** A hired photographer's video, waiting for the administrator. */
  awaitsApproval?: boolean;
  /** The account publishes in this event. A collaborator manages its own video but does not publish (05/11/2026). */
  eventPublishes: boolean;
};

/** cornerHeight: how tall the corner is on screen, so the page leaves that much room below its last button. */
export type VideoQueue = { items: QueuedVideo[]; waitingForPhotos: boolean; cornerHeight: number };

const CHECK_MS = 4000;
const FAILED = 'Não foi possível converter este vídeo. Tente de novo na aba Vídeos.';

let state: VideoQueue = { items: [], waitingForPhotos: false, cornerHeight: 0 };
let cornerHeight = 0;
const listeners = new Set<() => void>();
const files = new Map<number, File>();
let lastKey = 0;
let running = false;
let photoHolds = 0;
// Bumped by a reset: a transfer or a check started before it must not write into the new, empty line.
let generation = 0;
let abort: AbortController | null = null;
let releaseSession: (() => void) | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let guarded = false;

const moving = (v: QueuedVideo) => v.stage === 'waiting' || v.stage === 'sending';

function publish(items: QueuedVideo[]) {
  state = { items, waitingForPhotos: photoHolds > 0 && items.some((v) => v.stage === 'waiting'), cornerHeight };
  listeners.forEach((l) => l());
  followConversion();
  guardTab();
}

function patch(key: number, change: Partial<QueuedVideo>) {
  publish(state.items.map((v) => (v.key === key ? { ...v, ...change } : v)));
}

function afterUpload(item: QueuedVideo, video: VideoItem): Partial<QueuedVideo> {
  // video.can_manage is also true for the collaborator who sent it, who does not publish: the event decides.
  const awaitsApproval = video.approval === 'pending';
  const canPublish = item.eventPublishes && !awaitsApproval;
  if (video.processing_status === 'ready') return { stage: 'ready', videoId: video.id, progress: 100, canPublish, awaitsApproval };
  if (video.processing_status === 'failed') return { stage: 'failed', videoId: video.id, error: video.failure ?? FAILED };
  return { stage: 'converting', videoId: video.id, progress: 100, canPublish, awaitsApproval };
}

/** Converted, and only "Publicar" is missing: followed until it leaves the review. */
const waitingToPublish = (v: QueuedVideo) => v.stage === 'ready' && !!v.canPublish;

async function pump() {
  if (running) return;
  running = true;
  const run = generation;
  while (run === generation && photoHolds === 0) {
    const next = state.items.find((v) => v.stage === 'waiting');
    if (!next) break;
    // Nobody touches the mouse during a long upload: it counts as use, or the idle logout would cut it.
    releaseSession ??= holdSession();
    patch(next.key, { stage: 'sending', progress: 0 });
    abort = new AbortController();
    const result = await uploadVideo(next.eventId, files.get(next.key)!, (progress) => {
      if (run === generation) patch(next.key, { progress });
    }, abort.signal);
    if (run !== generation) return;
    files.delete(next.key);
    patch(next.key, result.video ? afterUpload(next, result.video) : { stage: 'failed', error: result.error });
  }
  if (run !== generation) return;
  running = false;
  if (!state.items.some((v) => v.stage === 'sending')) { releaseSession?.(); releaseSession = null; }
}

/** Every few seconds, while something converts or waits to be published: what happened to OUR videos. */
function followConversion() {
  const following = state.items.some((v) => v.stage === 'converting' || waitingToPublish(v));
  if (following && !timer) timer = setInterval(() => { void check(); }, CHECK_MS);
  if (!following && timer) { clearInterval(timer); timer = null; }
}

async function check() {
  const run = generation;
  // Published, discarded or deleted: it left the review, so it leaves the line too.
  for (const eventId of new Set(state.items.filter(waitingToPublish).map((v) => v.eventId))) {
    let review: Set<string>;
    try {
      review = new Set((await listVideos(eventId, 'in_review')).items.map((v) => v.id));
    } catch { continue; }
    if (run !== generation) return;
    publish(state.items.filter((v) => !(v.eventId === eventId && waitingToPublish(v) && !review.has(v.videoId!))));
  }
  const events = [...new Set(state.items.filter((v) => v.stage === 'converting').map((v) => v.eventId))];
  for (const eventId of events) {
    let still: Set<string>;
    try {
      still = new Set((await listVideos(eventId, 'processing')).items.map((v) => v.id));
    } catch { continue; }   // offline for a moment: the next round tries again
    for (const v of state.items.filter((i) => i.eventId === eventId && i.stage === 'converting' && !still.has(i.videoId!))) {
      try {
        const video = await getVideo(v.videoId!);
        if (run !== generation) return;
        patch(v.key, afterUpload(v, video));
      } catch (e) {
        if (run !== generation) return;
        // Deleted (or the access ended) while converting: it will not finish here.
        if (e instanceof ApiError && (e.status === 404 || e.status === 403)) patch(v.key, { stage: 'failed', error: 'Este vídeo não está mais disponível.' });
      }
    }
  }
}

// returnValue as well: older Safari only asks when it is set.
const warnBeforeClosing = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };

/** Closing the tab stops the transfer (the conversion goes on in the server): the browser asks first. */
function guardTab() {
  if (Platform.OS !== 'web') return;
  const need = state.items.some(moving);
  if (need === guarded) return;
  guarded = need;
  if (need) window.addEventListener('beforeunload', warnBeforeClosing);
  else window.removeEventListener('beforeunload', warnBeforeClosing);
}

/** Puts videos at the end of the line. A new choice during a send only makes the total grow. */
export function enqueueVideos(eventId: string, eventName: string, chosen: File[], eventPublishes: boolean) {
  const fresh = chosen.map((file) => {
    const key = ++lastKey;
    files.set(key, file);
    return { key, eventId, eventName, name: file.name, size: file.size, stage: 'waiting' as const, progress: 0, eventPublishes };
  });
  publish([...state.items, ...fresh]);
  void pump();
}

/** The upload screen has photos to send: the next video waits. Call the returned function when they are done. */
export function holdForPhotos(): () => void {
  photoHolds += 1;
  publish(state.items);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    photoHolds -= 1;
    publish(state.items);
    void pump();
  };
}

/** A video is on its way now: a logout would cut it. */
export const videoBeingSent = () => state.items.some((v) => v.stage === 'sending');

/** "Fechar" on one event: takes away its failed videos and the ones this account does not publish. A video waiting
 *  for this account's "Publicar" stays: that is still work to do. */
export function clearFinished(eventId: string) {
  publish(state.items.filter((v) => v.eventId !== eventId || v.stage === 'waiting' || v.stage === 'sending'
    || v.stage === 'converting' || waitingToPublish(v)));
}

/** The Vídeos screen published or discarded something: check now instead of in a few seconds. */
export function refreshVideoQueue() {
  if (state.items.some(waitingToPublish)) void check();
}

/** Logout or another account: stops the transfer and forgets the line, files included. */
export function resetVideos() {
  generation += 1;
  abort?.abort();
  abort = null;
  running = false;
  files.clear();
  releaseSession?.();
  releaseSession = null;
  publish([]);
}

// A side menu open on a small screen: the count steps aside, or it would cover "Sair" (03/11/2026, 320 px test).
let menus = 0;
export function useHideVideoCorner(hidden: boolean) {
  useEffect(() => {
    if (!hidden) return undefined;
    menus += 1;
    publish(state.items);
    return () => { menus -= 1; publish(state.items); };
  }, [hidden]);
}
export const videoCornerHidden = () => menus > 0;

/** The corner covered "Iniciar envio" (05/11/2026, e2e): the page below it needs room to scroll out from under it. */
export function setCornerHeight(height: number) {
  if (Math.abs(height - cornerHeight) < 4) return;
  cornerHeight = height;
  publish(state.items);
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const EMPTY: VideoQueue = { items: [], waitingForPhotos: false, cornerHeight: 0 };
export const useVideoQueue = () => useSyncExternalStore(subscribe, () => state, () => EMPTY);
