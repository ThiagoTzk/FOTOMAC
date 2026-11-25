/**
 * Voice and sounds of the guided capture (04/11/2026, the coordinator's test: the doll alone was not clear; he asked
 * for a spoken instruction and a "plin" when a movement works). Everything is made by the browser itself: the speech
 * synthesis of the device and two tones of the Web Audio API, without any file or outside service.
 */

const VOICE_KEY = 'fotomac.capture.voice';

/** The person's choice of voice on or off, remembered in this browser (a convenience, no personal data). */
export function voicePreferred(): boolean {
  try { return localStorage.getItem(VOICE_KEY) !== 'off'; } catch { return true; }
}

export function rememberVoice(on: boolean) {
  try { localStorage.setItem(VOICE_KEY, on ? 'on' : 'off'); } catch { /* private window: it only is not remembered */ }
}

function portugueseVoice(): SpeechSynthesisVoice | null {
  const voices = typeof speechSynthesis !== 'undefined' ? speechSynthesis.getVoices() : [];
  const pt = voices.filter((v) => v.lang?.toLowerCase().startsWith('pt'));
  // A voice of the device itself first: an online voice would send the text out (it is only the instruction, but
  // there is no reason to send it anywhere).
  return pt.find((v) => v.localService && v.lang.toLowerCase() === 'pt-br') ?? pt.find((v) => v.localService)
    ?? pt.find((v) => v.lang.toLowerCase() === 'pt-br') ?? pt[0] ?? null;
}

/**
 * A sentence is never cut (08/11/2026: "olhe para ci…", and after a first fix still once in the middle of
 * "olhe para baixo"). A new sentence used to cancel the one being said; now it waits for it to end. Only ONE waits:
 * a newer sentence takes its place, so the voice is never more than one sentence behind the screen.
 * The sentence being said is held in `current`: a browser stops it in the middle when nothing in the page refers to
 * it any more (Chrome and Safari throw it away as garbage).
 */
let current: SpeechSynthesisUtterance | null = null;
let next: { text: string; started: () => void } | null = null;
let starting: (() => void) | null = null;   // tells the capture the sentence being said has begun
let guard: ReturnType<typeof setTimeout> | null = null;
// If the browser never says the sentence ended (Safari skips "end" now and then), the line moves on anyway.
const LONGEST_MS = 8000;

/** A function that does its work only the first time (a sentence "starts" once, whichever signal comes first). */
function once(fn: () => void): () => void {
  let done = false;
  return () => { if (!done) { done = true; fn(); } };
}

function sayNow(text: string, started: () => void) {
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'pt-BR';
  utterance.rate = 1.05;
  const voice = portugueseVoice();
  if (voice) utterance.voice = voice;
  const ended = () => {
    started();   // a browser that never sent "start" has at least ended the sentence
    if (current !== utterance) return;   // already moved on (the guard, or both "end" and "error")
    if (guard) clearTimeout(guard);
    guard = null;
    current = null;
    const waiting = next;
    next = null;
    if (waiting) sayNow(waiting.text, waiting.started);
  };
  utterance.onstart = started;
  utterance.onend = ended;
  utterance.onerror = ended;
  current = utterance;
  starting = started;
  if (guard) clearTimeout(guard);
  guard = setTimeout(ended, LONGEST_MS);
  speechSynthesis.speak(utterance);
}

/**
 * Says the text after the sentence being said, if any. Silent where the browser has no speech synthesis. The promise
 * resolves when THIS sentence begins to be said (or is dropped): the capture waits for the instruction to begin before
 * counting the pose (15/11/2026, a slow phone said "olhe para a câmera" after the step had been counted).
 */
export function speak(text: string): Promise<void> {
  if (typeof speechSynthesis === 'undefined') return Promise.resolve();
  return new Promise((resolve) => {
    const started = once(resolve);
    if (current) {
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
  current = null;
  if (guard) clearTimeout(guard);
  guard = null;
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
}

let audio: AudioContext | null = null;

/** Must be called from a click: Safari only lets a page play sound after a gesture of the person. */
export function unlockSound() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    audio ??= new Ctx();
    void audio.resume();
  } catch { audio = null; }
}

function tone(frequency: number, start: number, length: number, type: OscillatorType, volume: number) {
  if (!audio) return;
  // Safari suspends the sound of a page now and then (another sound, the voice, a moment without sound): the "plin"
  // was then silent. Waking it up here is allowed, the person already clicked "Começar".
  if (audio.state !== 'running') void audio.resume();
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = type;
  osc.frequency.value = frequency;
  const t = audio.currentTime + start;
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(volume, t + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + length);
  osc.connect(gain).connect(audio.destination);
  osc.start(t);
  osc.stop(t + length + 0.02);
}

/** "Plin": a movement worked. */
export function plin() {
  tone(1047, 0, 0.18, 'sine', 0.25);
  tone(1568, 0.09, 0.3, 'sine', 0.22);
}

/** A low, short tone: a movement did not work. */
export function buzz() {
  tone(196, 0, 0.28, 'triangle', 0.3);
}
