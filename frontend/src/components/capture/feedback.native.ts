import { createAudioPlayer, setAudioModeAsync, setIsAudioActiveAsync, type AudioPlayer } from 'expo-audio';
import * as Haptics from 'expo-haptics';
import * as SecureStore from 'expo-secure-store';
import * as Speech from 'expo-speech';
import { Platform } from 'react-native';

/**
 * Voice, sounds and vibration of the guided capture in the app (06/11/2026): the same as the site
 * (feedback.ts), made by the phone itself. The voice is the phone's own speech synthesis (the text never leaves the
 * phone); the two tones are files made by scripts/make-sounds.py.
 */
const VOICE_KEY = 'fotomac.capture.voice';

/** The person's choice of voice on or off, remembered in this phone (a convenience, no personal data). */
export function voicePreferred(): boolean {
  try { return SecureStore.getItem(VOICE_KEY) !== 'off'; } catch { return true; }
}

export function rememberVoice(on: boolean) {
  try { SecureStore.setItem(VOICE_KEY, on ? 'on' : 'off'); } catch { /* not remembered, that is all */ }
}

/**
 * The Brazilian voice, chosen by name (15/11/2026 on Android: "uma voz feminina inglesa tentando falar
 * português"). language 'pt-BR' alone is only a wish: Android's engine keeps the phone's default voice when its
 * Portuguese one is not picked explicitly. A voice of the phone itself first ("-local", or no "network" in the name):
 * a network voice would send the sentence out (it is only the instruction, but the site makes the same choice).
 */
let voiceId: string | undefined;
let voiceAsked = false;

function brazilianVoice(): string | undefined {
  // The iPhone already speaks with its Brazilian voice (Luciana), approved by the author: left as it was.
  if (Platform.OS !== 'android') return undefined;
  if (!voiceAsked) {
    voiceAsked = true;
    Speech.getAvailableVoicesAsync().then((voices) => {
      const pt = voices.filter((v) => v.language?.toLowerCase().replace('_', '-').startsWith('pt-br'));
      const local = pt.filter((v) => !/network/i.test(v.identifier));
      // The phone's own default Brazilian voice ("pt-BR-language") first, the closest to the iPhone's.
      voiceId = (local.find((v) => /-language$/i.test(v.identifier)) ?? local[0] ?? pt[0])?.identifier;
    }).catch(() => undefined);
  }
  return voiceId;
}

brazilianVoice();   // asked when the app opens: the first sentence of a capture already has it

/**
 * A sentence is never cut (08/11/2026: "olhe para ci…", and after a first fix still once in the middle of
 * "olhe para baixo"). A new sentence used to stop the one being said; now it waits for it to end. Only ONE waits:
 * a newer sentence takes its place, so the voice is never more than one sentence behind the screen.
 */
let speaking = false;
let next: { text: string; started: () => void } | null = null;
let starting: (() => void) | null = null;   // tells the capture the sentence being said has begun
let guard: ReturnType<typeof setTimeout> | null = null;
let said = 0;   // which sentence is being said: a late "ended" of an older one changes nothing
// If the phone never says the sentence ended (it happens when the system takes the sound), the line moves on anyway.
const LONGEST_MS = 8000;

/** A function that does its work only the first time (a sentence "starts" once, whichever signal comes first). */
function once(fn: () => void): () => void {
  let done = false;
  return () => { if (!done) { done = true; fn(); } };
}

function sayNow(text: string, started: () => void) {
  const mine = ++said;
  speaking = true;
  starting = started;
  if (guard) clearTimeout(guard);
  const ended = () => {
    if (mine !== said) return;
    said++;
    started();   // a phone that never sent "start" has at least ended the sentence
    if (guard) clearTimeout(guard);
    guard = null;
    speaking = false;
    const waiting = next;
    next = null;
    if (waiting) sayNow(waiting.text, waiting.started);
  };
  // No end after LONGEST_MS: the synthesizer is stuck, and a new sentence would only queue behind the stuck one (the
  // silence of 09/11/2026). It is emptied first, and the next sentence comes a moment later.
  guard = setTimeout(() => {
    if (mine !== said) return;
    said++;
    started();
    guard = null;
    speaking = false;
    const waiting = next;
    next = null;
    Speech.stop();
    if (!waiting) return;
    speaking = true;
    const turn = said;   // stopSpeaking in these 200 ms drops it
    setTimeout(() => {
      if (turn !== said) { waiting.started(); return; }
      speaking = false;
      sayNow(waiting.text, waiting.started);
    }, 200);
  }, LONGEST_MS);
  Speech.speak(text, {
    language: 'pt-BR', voice: brazilianVoice(), rate: 1.0,
    onStart: started, onDone: ended, onStopped: ended, onError: ended,
  });
}

/**
 * Says the text after the sentence being said, if any. The promise resolves when THIS sentence begins to be said (or
 * is dropped): 15/11/2026, the author's old Android: the voice started late, and the step had been counted before it said
 * "olhe para a câmera". The capture now waits for the instruction to begin before counting the pose.
 */
export function speak(text: string): Promise<void> {
  return new Promise((resolve) => {
    const started = once(resolve);
    if (speaking) {
      next?.started();   // the older waiting sentence is replaced: it will never be said
      next = { text, started };
    } else {
      sayNow(text, started);
    }
  });
}

/** Silence now (the capture closed, the voice turned off): what waits is dropped. */
export function stopSpeaking() {
  next?.started();
  next = null;
  starting?.();
  starting = null;
  said++;
  speaking = false;
  if (guard) clearTimeout(guard);
  guard = null;
  Speech.stop();
}

let players: { plin: AudioPlayer; buzz: AudioPlayer } | null = null;

/** Called at "Começar": the sounds are loaded, and they play even with the iPhone's silent switch on. */
export function unlockSound() {
  brazilianVoice();   // the list of voices comes before the first sentence
  // mixWithOthers: the "plin" and the voice play together; one no longer silences or cuts the other (08/11/2026).
  // The session is opened here, at "Começar", and not by the first sound: the first "plin" opened it while playing and
  // was often silent (09/11/2026: "de primeira não funcionou").
  setAudioModeAsync({ playsInSilentMode: true, interruptionMode: 'mixWithOthers' })
    .then(() => setIsAudioActiveAsync(true)).catch(() => undefined);
  // keepAudioSessionActive (09/11/2026: the voice was cut at the first step, then neither voice nor "plin" came
  // back). On the iPhone the voice and the sounds share the app's audio session, and expo-audio CLOSES it 0.1 s after
  // each sound ends unless told otherwise: a sentence being said at that moment was cut, and the synthesizer could stay
  // stuck for the rest of the capture. Kept open, the end of a "plin" no longer touches the voice.
  const options = { keepAudioSessionActive: true };
  players ??= {
    plin: createAudioPlayer(require('../../../assets/sounds/plin.wav'), options),
    buzz: createAudioPlayer(require('../../../assets/sounds/buzz.wav'), options),
  };
}

function play(which: 'plin' | 'buzz') {
  const p = players?.[which];
  if (!p) return;
  // Back to the start FIRST: played before the seek ended, a sound already played once started at its end and was
  // silent (the "plin" that failed now and then).
  p.seekTo(0).then(() => p.play(), () => p.play());
}

/** "Plin": a movement worked. */
export function plin() {
  play('plin');
}

/** A low, short tone and a vibration: a movement did not work. */
export function buzz() {
  play('buzz');
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
}
