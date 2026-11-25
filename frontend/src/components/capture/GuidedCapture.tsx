import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CircleCheck, CircleX, ScanFace, Volume2, VolumeX, X } from 'lucide-react-native';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Easing, Modal, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Svg, { Circle, Ellipse, Path } from 'react-native-svg';

import { themed } from '@/theme/tokens';
import { SafeWindow } from '@/ui/SafeWindow';

import { discardFrames, useCaptureCamera } from './camera';
import type { Frame } from './camera.types';
import { buzz, plin, rememberVoice, speak, stopSpeaking, unlockSound, voicePreferred } from './feedback';

// Dark mode (31/10/2026): the sheet follows the sun/moon button like the rest of the site. The camera, the doll and
// the "Começar" button keep their colours (they read well on both).
const cap = themed('cap', {
  sheet: '#FFFFFF', heading: '#0F172A', icon: '#334155', text: '#475569', chip: '#F1F5F9', chipText: '#334155',
  nowBg: '#E0F2FE', accent: '#0284C7', doneBg: '#DCFCE7', done: '#15835D', track: '#E2E8F0', error: '#C63D4A',
  errorBg: '#FDE8EA',
}, {
  sheet: '#17212B', heading: '#E6EDF2', icon: '#C2CED8', text: '#A9B6C2', chip: '#22303C', chipText: '#C2CED8',
  nowBg: '#12324A', accent: '#38A9EE', doneBg: '#12342A', done: '#55C792', track: '#2B3A46', error: '#F07884',
  errorBg: '#3A1E24',
});

export type Step = 'frente' | 'esquerda' | 'direita' | 'cima' | 'baixo';
type Props = {
  visible: boolean;
  onClose: () => void;
  /** The frames go to whoever called: in the app they are files, deleted by the caller after the search (discardFrames). */
  onDone: (frames: Frame[], steps: Step[], order: Step[]) => void;
  /** Where the order of the movements comes from. The public search asks the SERVER,
   *  when "Começar" is pressed — so the order is unknown until the capture starts. Default: drawn here. */
  getOrder?: () => Promise<Step[]>;
  /** "search": the visitor's search (frames deleted right after it); "bench": the precision test. */
  variant?: 'bench' | 'search';
  /** Shown beside the camera before the capture starts (the search tips). */
  aside?: ReactNode;
  /** Checks one movement while the person is still in front of the camera (the public search, 04/11/2026): the
   *  screen says at once whether it worked and asks again for the one that failed. Without it, no check. */
  checkStep?: (fronts: Frame[], step: Step, frames: Frame[]) => Promise<{ ok: boolean; reason: string | null }>;
};

export type CheckResult = { ok: boolean; reason: string | null };

const MOVES: Step[] = ['esquerda', 'direita', 'cima', 'baixo'];
// 04/11/2026, the coordinator's test: say HOW LONG to hold. Each pose is held for HOLD_SECONDS, counted on screen.
const HOLD_SECONDS = 3;
const SETTLE_MS = 800;      // the head turns first; frames are taken after
const MAX_TRIES = 3;        // a movement that fails is asked again, up to this many times
// The server counts a capture ended here as a failed liveness check (RF024): atypical.CAPTURE_TRIES in
// backend/app/security/atypical.py must stay equal to MAX_TRIES.
const OK_MS = 900;          // how long "Deu certo!" stays before the next movement
const REQUIRED: Step[] = ['esquerda', 'direita'];   // the turns that decide the liveness check (server: poses.REQUIRED)
// Between two movements the head comes back to the centre: every turn then starts from the middle.
// Real captures (17/10/2026) showed a turn to the right right after one to the left had no time to
// cross from side to side. The centre frames also strengthen the frontal reference.
const CENTER_MS = 1000;
const CENTER_FRAMES = 2;
const FRAMES_PER_STEP = 6;
const FRAME_GAP_MS = 180;
// The pose is counted only after its instruction BEGINS to be said (15/11/2026, the author's old Android: the voice came
// late and the step was over when it said "olhe para a câmera"). A voice that never starts holds nothing up for longer.
const VOICE_WAIT_MS = 3000;
const TEXT: Record<Step, string> = {
  frente: 'Olhe para a câmera', esquerda: 'Vire o rosto para a sua esquerda', direita: 'Vire o rosto para a sua direita',
  // "Um pouco" (05/11/2026, user test): a head thrown far back loses the face in the camera.
  cima: 'Olhe um pouco para cima', baixo: 'Olhe um pouco para baixo',
};
// What the voice says when the movement is asked again.
const AGAIN: Record<Step, string> = {
  frente: 'Olhe para a câmera de novo', esquerda: 'Vire o rosto para a sua esquerda de novo',
  direita: 'Vire o rosto para a sua direita de novo', cima: 'Olhe um pouco para cima de novo', baixo: 'Olhe um pouco para baixo de novo',
};
// The preview is a mirror: the person's left is on the screen's left, and so is the doll's.
const TARGET: Record<Step, { x: number; y: number }> = {
  frente: { x: 0, y: 0 }, esquerda: { x: -1, y: 0 }, direita: { x: 1, y: 0 }, cima: { x: 0, y: -1 }, baixo: { x: 0, y: 1 },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A new random order for every recording: a video recorded before cannot follow it. */
const draw = () => [...MOVES].sort(() => Math.random() - 0.5);

/**
 * Guided face recording: a large written instruction, read aloud, says which way to turn, in an order drawn at
 * random, and frames are taken while the person holds the pose for a few counted seconds. In the public search each
 * movement is checked at once: a "plin" when it worked, or "não deu certo" and the same movement again (04/11/2026,
 * the coordinator's test: the doll alone was less useful than the text). The doll stays as a small support.
 * NO video is recorded or sent: only still frames, each tagged with the movement asked at that moment, so the server
 * can check that the head really followed the order (liveness). The same capture in the site and in the app (06/11/2026):
 * only the camera changes (camera.web.tsx, camera.tsx).
 */
export function GuidedCapture({ visible, onClose, onDone, getOrder, variant = 'bench', aside, checkStep }: Props) {
  const cam = useCaptureCamera(visible);
  const cancelled = useRef(false);
  // Every frame taken in this capture: deleted here if the capture stops before the end (in the app they are files).
  const taken = useRef<Frame[]>([]);
  // 'failed': a movement could not be confirmed after the tries; the camera is off until "Tentar de novo".
  const [phase, setPhase] = useState<'intro' | 'countdown' | 'recording' | 'done' | 'failed'>('intro');
  const [failure, setFailure] = useState<string | null>(null);
  const [failedStart, setError] = useState<string | null>(null);
  const error = failedStart ?? cam.error;
  const ready = cam.ready;
  const [count, setCount] = useState(3);
  const [sequence, setSequence] = useState<Step[]>([]);
  const [current, setCurrent] = useState(0);
  const [centering, setCentering] = useState(false);
  const [hold, setHold] = useState<number | null>(null);            // seconds left to hold the pose
  const [checking, setChecking] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [voice, setVoice] = useState(voicePreferred);
  // Read inside the long-running capture loop, so a change made during the capture is followed at once.
  const voiceOn = useRef(voice);
  useEffect(() => { voiceOn.current = voice; }, [voice]);
  const say = useCallback((text: string) => (voiceOn.current ? speak(text) : Promise.resolve()), []);

  useEffect(() => {
    if (!visible) return;
    cancelled.current = false;
    return () => {
      cancelled.current = true;
      discardFrames(taken.current);   // closed before the end: nothing taken is kept
      taken.current = [];
      stopSpeaking();
      setPhase('intro'); setError(null); setCurrent(0); setSequence([]); setCentering(false);
      setHold(null); setChecking(false); setFeedback(null); setFailure(null);
    };
  }, [visible]);

  /** "Tentar de novo" after a failed capture: the camera opens again only at this click. */
  function again() {
    setFailure(null); setFeedback(null); setCurrent(0); setSequence([]); setPhase('intro'); setError(null);
    cam.restart();
  }

  async function frame(): Promise<Frame | null> {
    const f = await cam.frame();
    if (f) taken.current.push(f);
    return f;
  }

  /** Holds the pose for HOLD_SECONDS, counted on screen, taking `count` frames after the head settled. */
  async function holdPose(count: number): Promise<Frame[] | null> {
    const shots: Frame[] = [];
    const began = Date.now();
    const end = began + HOLD_SECONDS * 1000;
    setHold(HOLD_SECONDS);
    // The number on the screen follows the clock (15/11/2026: on the old Android it stopped at 2 one time and
    // at 1 another): it used to change only when a picture was taken, and a slow phone takes 2 or 3 pictures.
    const ticker = setInterval(() => setHold(Math.max(1, HOLD_SECONDS - Math.floor((Date.now() - began) / 1000))), 200);
    try {
      await sleep(SETTLE_MS);
      const gap = (HOLD_SECONDS * 1000 - SETTLE_MS) / (count + 1);
      // 15/11/2026, the author's old Android (Moto G8 Power): each picture took almost a second, so the 6 frames stretched
      // "segure por 3 segundos" to about 7. The person had already come back from the pose, and the late frames were
      // judged as part of it. Now the time a picture takes counts in the gap, and no picture starts that would end
      // after the hold. A fast phone takes the same 6 frames as before.
      let took = 0;
      for (let k = 0; k < count; k++) {
        if (cancelled.current) return null;
        if (k > 0 && Date.now() + took > end) break;
        const t0 = Date.now();
        const shot = await frame();
        took = Date.now() - t0;
        if (shot) shots.push(shot);
        await sleep(Math.max(0, gap - took));
      }
      await sleep(Math.max(0, HOLD_SECONDS * 1000 - (Date.now() - began)));
    } finally {
      clearInterval(ticker);
      setHold(null);
    }
    return shots;
  }

  async function start() {
    unlockSound();   // inside the click: Safari plays sound only after a gesture
    let order: Step[];
    try {
      order = getOrder ? await getOrder() : draw();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível iniciar a captura.');
      return;
    }
    const steps: Step[] = ['frente', ...order];
    setSequence(steps);
    setCount(0);   // no number until the voice begins
    setPhase('countdown');
    // The first step says "Olhe para a câmera" itself (it was said twice, 05/11/2026). The 3, 2, 1 starts with the
    // voice (15/11/2026, the author's old Android: "Vamos começar" came when he was already doing the movement).
    await Promise.race([say('Vamos começar.'), sleep(VOICE_WAIT_MS)]);
    if (cancelled.current) return;
    for (let n = 3; n > 0; n--) {
      setCount(n);
      await sleep(800);
      if (cancelled.current) return;
    }
    setPhase('recording');
    const frames: Frame[] = [];
    const labels: Step[] = [];
    let fronts: Frame[] = [];
    for (let i = 0; i < steps.length; i++) {
      const st = steps[i];
      setCurrent(i);
      for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
        if (cancelled.current) return;
        // Back to the centre before each movement (tagged "frente"): every turn starts from the middle.
        const centre: Frame[] = [];
        if (i > 1 || attempt > 1) {
          setCentering(true);
          setFeedback((f) => (f?.ok ? null : f));
          if (attempt === 1) say('Volte para o centro.');
          await sleep(CENTER_MS - CENTER_FRAMES * FRAME_GAP_MS);
          for (let k = 0; k < CENTER_FRAMES; k++) {
            if (cancelled.current) return;
            const shot = await frame();
            if (shot) centre.push(shot);
            await sleep(FRAME_GAP_MS);
          }
          setCentering(false);
        }
        setFeedback(null);
        // The pose is counted from the moment its instruction begins to be said (VOICE_WAIT_MS at most).
        await Promise.race([say(attempt === 1 ? `${TEXT[st]}. Segure por ${HOLD_SECONDS} segundos.` : AGAIN[st]),
          sleep(VOICE_WAIT_MS)]);
        if (cancelled.current) return;
        const posed = await holdPose(FRAMES_PER_STEP);
        if (!posed) return;
        let result: CheckResult = { ok: true, reason: null };
        // 11/11/2026 (a tester covered the camera with a finger and "Olhe para a câmera" said "Deu certo!"): the first
        // step is checked too, by the same face rule as the final search. Its own frames are the reference.
        if (checkStep && (st === 'frente' || fronts.length)) {
          setChecking(true);
          try {
            result = await checkStep(st === 'frente' ? posed.slice(0, 3) : fronts.slice(0, 3), st, posed);
          } catch (e) {
            // The check itself failed (network, expired capture): say so, and let the final search decide.
            result = { ok: true, reason: null };
            if (e instanceof Error && /expirou/.test(e.message)) { setChecking(false); setError(e.message); setPhase('intro'); return; }
          } finally {
            setChecking(false);
          }
        }
        if (cancelled.current) return;
        // The face looking at the camera and the side turns decide the liveness check: after their last try the
        // capture stops and explains, instead of making the person wait for a search that cannot work. Up and down are a
        // bonus: after the tries, it goes on, unless the head went clearly the OTHER way (08/11/2026), turned to a side
        // (09/11/2026) or did not move the right way at all ("movement", poses.NOD_MIN, 09/11/2026). 11/11/2026: going on
        // after a weak nod was tried and undone by the author; a too subtle nod asks for a bigger one.
        const opposite = result.reason === 'opposite';
        const sideways = result.reason === 'sideways';
        const wrong = opposite || sideways || result.reason === 'movement';
        // The face looking at the camera is required like the turns: without it nothing else can be checked.
        const faceProblem = result.reason === 'no_face' || result.reason === 'low_quality' || result.reason === 'no_front';
        if (!result.ok && attempt === MAX_TRIES && (st === 'frente' || REQUIRED.includes(st) || wrong)) {
          buzz();
          cam.stop();   // the camera light goes off
          discardFrames(taken.current);   // a capture that cannot work keeps nothing
          taken.current = [];
          const message = faceProblem
            ? 'Não encontramos o seu rosto na câmera. Procure um lugar com boa luz, deixe o rosto inteiro dentro do círculo, sem nada na frente da câmera, e tente de novo.'
            // One plain message for any wrong movement (09/11/2026: "movimento errado, tente novamente").
            : `Movimento errado em “${TEXT[st].toLowerCase()}”. Siga a seta da tela, devagar, e tente novamente.`;
          say(faceProblem ? 'Não encontramos o seu rosto. Tente de novo com boa luz.'
            : 'Movimento errado. Tente novamente.');
          setFeedback(null);
          setFailure(message);
          setPhase('failed');
          return;
        }
        if (result.ok || attempt === MAX_TRIES) {
          frames.push(...centre, ...posed);
          labels.push(...centre.map(() => 'frente' as Step), ...posed.map(() => st));
          if (st === 'frente') fronts = posed;
          if (result.ok) {
            plin();
            setFeedback({ ok: true, text: 'Deu certo!' });
            // 05/11/2026: the next step cleared it in the same instant, so "Deu certo!" was almost never seen.
            if (st !== 'frente') await sleep(OK_MS);
          }
          break;
        }
        buzz();
        const why = !faceProblem ? 'Movimento errado.'
          : result.reason === 'low_quality' ? 'O rosto está pequeno ou pouco nítido. Chegue mais perto, com boa luz.'
            : st === 'cima' || st === 'baixo' ? 'Não encontramos o seu rosto. Mexa a cabeça um pouco menos.'
              : 'Não encontramos o seu rosto. Deixe o rosto inteiro dentro do círculo.';
        setFeedback({ ok: false, text: `${why} ${AGAIN[st]}.` });
        say(`${why} Tente novamente.`);
        await sleep(1400);
      }
    }
    setCurrent(steps.length);
    setPhase('done');
    say('Pronto! Buscando.');
    cam.stop();
    await sleep(900);
    if (cancelled.current) return;
    // From here the caller owns the frames sent; the ones left out (tries that failed) are deleted now.
    discardFrames(taken.current.filter((f) => !frames.includes(f)));
    taken.current = [];
    onDone(frames, labels, order);
  }

  const step = phase === 'recording' && !centering ? sequence[current] ?? 'frente' : 'frente';
  const instruction = phase === 'countdown' ? 'Prepare-se…' : phase === 'done' ? 'Pronto!' : centering ? 'Volte para o centro'
    : checking ? 'Conferindo o movimento…' : TEXT[step];
  const progress = sequence.length ? Math.min(1, current / sequence.length) : 0;
  // A small phone (320 px) cut the camera circle at both sides (06/11/2026): the circle follows the screen's width,
  // and the window's margins are smaller there.
  const { width: screen } = useWindowDimensions();
  const small = screen < 600;
  const pad = small ? 16 : 24;
  const box = Math.min(320, screen - 2 * (small ? 12 : 16) - 2 * pad);
  const lens = { width: box - 40, height: box - 40, borderRadius: (box - 40) / 2 };
  // "Começar" right under the doll's face (06/11/2026): on a phone it was below all the tips, out of sight.
  const startButton = (
    <Pressable accessibilityRole="button" disabled={!ready} onPress={start} style={[s.start, !ready && { opacity: 0.5 }]}>
      <ScanFace size={20} color="#FFFFFF" strokeWidth={1.8} absoluteStrokeWidth />
      <Text style={s.startText}>{ready ? 'Começar' : 'Abrindo a câmera…'}</Text>
    </Pressable>
  );

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <SafeWindow style={s.dim}>
      <View style={[s.overlay, small && { padding: 12 }]}>
        <View style={[s.sheet, { padding: pad }]} role="dialog" aria-modal aria-label={variant === 'search' ? 'Busca pelo seu rosto' : 'Gravação guiada do rosto'}>
          <View style={s.header}>
            <Text style={s.title}>{variant === 'search' ? 'Busca pelo seu rosto' : 'Gravação guiada do rosto'}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
              <Pressable accessibilityRole="switch" accessibilityState={{ checked: voice }} aria-checked={voice}
                         accessibilityLabel="Instruções faladas" hitSlop={8} style={s.voice}
                         onPress={() => { const on = !voice; setVoice(on); rememberVoice(on); if (!on) stopSpeaking(); }}>
                {voice ? <Volume2 size={20} color={cap.accent} strokeWidth={1.8} absoluteStrokeWidth />
                  : <VolumeX size={20} color={cap.icon} strokeWidth={1.8} absoluteStrokeWidth />}
                <Text style={s.voiceText}>{voice ? 'Voz ligada' : 'Voz desligada'}</Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel="Fechar" onPress={onClose} hitSlop={8}>
                <X size={22} color={cap.icon} strokeWidth={1.8} absoluteStrokeWidth />
              </Pressable>
            </View>
          </View>

          {/* A failed capture explains at the top, where the eyes are, with the way to try again. */}
          {phase === 'failed' && failure && (
            <View style={[s.banner, { backgroundColor: cap.errorBg }]}>
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
                <View style={{ flexShrink: 0 }}><CircleX size={24} color={cap.error} strokeWidth={2} absoluteStrokeWidth /></View>
                <Text style={[s.feedbackText, { color: cap.error }]} role="alert">{failure}</Text>
              </View>
              <Pressable accessibilityRole="button" onPress={again} style={s.start}>
                <ScanFace size={20} color="#FFFFFF" strokeWidth={1.8} absoluteStrokeWidth />
                <Text style={s.startText}>Tentar de novo</Text>
              </Pressable>
            </View>
          )}
          {/* The instruction is the main guide (04/11/2026): big, near the camera, read aloud and by screen readers. */}
          {phase !== 'intro' && phase !== 'failed' && (
            <View style={s.banner} accessibilityLiveRegion="polite" aria-live="polite">
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
                {phase === 'recording' && !centering && <Arrow step={step} />}
                <Text style={s.instruction}>{instruction}</Text>
              </View>
              {phase === 'recording' && !centering && !checking && <Text style={s.holdText}>Segure por {HOLD_SECONDS} segundos</Text>}
              {feedback && (
                <View style={[s.feedback, { backgroundColor: feedback.ok ? cap.doneBg : cap.errorBg }]}>
                  <View style={{ flexShrink: 0 }}>
                    {feedback.ok ? <CircleCheck size={20} color={cap.done} strokeWidth={2} absoluteStrokeWidth />
                      : <CircleX size={20} color={cap.error} strokeWidth={2} absoluteStrokeWidth />}
                  </View>
                  <Text style={[s.feedbackText, { color: feedback.ok ? cap.done : cap.error }]}>{feedback.text}</Text>
                </View>
              )}
            </View>
          )}

          <ScrollView contentContainerStyle={{ gap: 18 }} style={{ flexShrink: 1 }}>
          <View style={[s.stage, small && { gap: 8 }]}>
            <View style={[s.cameraBox, { width: box, height: box }]}>
              <Ring progress={progress} size={box} />
              <View style={[s.camera, lens]}>
                {cam.view}
              </View>
              {phase === 'countdown' && count > 0 && <View style={[s.countdown, lens]}><Text style={s.countdownText}>{count}</Text></View>}
              {/* How long to hold, counted down inside the circle. */}
              {phase === 'recording' && hold !== null && !centering && (
                <View style={s.holdBadge}><Text style={s.holdNumber}>{hold}</Text></View>
              )}
              {checking && <View style={[s.countdown, lens]}><Text style={s.checkingText}>Conferindo…</Text></View>}
            </View>
            <View style={[s.guide, { minWidth: Math.min(280, box) }, small && { gap: 10 }]}>
              {/* A small support only: the written instruction above is the guide. */}
              {/* The scale does not shrink the room the doll takes: on a phone the room is cut too, so "Começar" fits on
                  the smallest screen without scrolling. */}
              <View style={small ? { height: 96, justifyContent: 'center', transform: [{ scale: 0.62 }] } : { transform: [{ scale: 0.75 }] }}>
                <Doll step={phase === 'recording' && !centering ? step : 'frente'} />
              </View>
              {phase === 'intro' && !error && startButton}
              {phase === 'intro' && <Text style={s.introTitle}>Siga as instruções da tela</Text>}
              {/* The order exists only after the draw: showing a default order before it would mislead. */}
              <View style={[s.chips, !sequence.length && { display: 'none' }]}>
                {sequence.map((st, i) => (
                  <View key={st} style={[s.chip, i < current && s.chipDone, phase === 'recording' && i === current && s.chipNow]}>
                    {i < current ? <CircleCheck size={14} color={cap.done} strokeWidth={2} absoluteStrokeWidth /> : null}
                    <Text style={[s.chipText, i < current && { color: cap.done }]}>{st}</Text>
                  </View>
                ))}
              </View>
            </View>
          </View>

          {phase === 'intro' && aside}
          {error ? <Text style={s.error} role="alert">{error}</Text> : phase === 'intro' && (
            <View style={{ gap: 12 }}>
              <Text style={s.text}>
                São cerca de 25 segundos. Com o rosto inteiro no círculo e boa luz, siga a instrução escrita no topo, que
                também é falada (dá para desligar a voz no alto da janela). Cada movimento é segurado por {HOLD_SECONDS}{' '}
                segundos, contados no círculo.{checkStep ? ' Quando der certo, toca um som; se não der, a tela pede o mesmo movimento de novo.' : ''}{' '}
                A ordem é sorteada a cada gravação: assim o sistema confirma que é uma pessoa de verdade, e não uma foto ou
                um vídeo gravado antes. Nenhum vídeo é gravado: só alguns quadros,{' '}
                {variant === 'search' ? 'apagados logo depois da busca.' : 'e só enquanto o teste estiver aberto.'}
              </Text>
            </View>
          )}
          </ScrollView>
        </View>
      </View>
      </SafeWindow>
    </Modal>
  );
}

function Arrow({ step }: { step: Step }) {
  const props = { size: 34, color: cap.accent, strokeWidth: 2.4, absoluteStrokeWidth: true };
  if (step === 'esquerda') return <ArrowLeft {...props} />;
  if (step === 'direita') return <ArrowRight {...props} />;
  if (step === 'cima') return <ArrowUp {...props} />;
  if (step === 'baixo') return <ArrowDown {...props} />;
  return null;
}

/** Progress ring around the camera (Face ID style). */
function Ring({ progress, size }: { progress: number; size: number }) {
  const m = size / 2, r = m - 8, c = 2 * Math.PI * r;
  return (
    <Svg width={size} height={size} style={{ position: 'absolute' }} pointerEvents="none">
      <Circle cx={m} cy={m} r={r} stroke={cap.track} strokeWidth={6} fill="none" />
      <Circle cx={m} cy={m} r={r} stroke="#16A34A" strokeWidth={6} fill="none" strokeLinecap="round"
              strokeDasharray={`${c} ${c}`} strokeDashoffset={c * (1 - progress)} transform={`rotate(-90 ${m} ${m})`} />
    </Svg>
  );
}

/** The doll: a head whose face slides toward the asked direction, like a head turning. */
function Doll({ step }: { step: Step }) {
  const [pos] = useState(() => new Animated.ValueXY({ x: 0, y: 0 }));
  useEffect(() => {
    const target = TARGET[step];
    // Turn, hold, come back a little and turn again — a gentle "this way" loop while the step lasts.
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pos, { toValue: target, duration: 520, easing: Easing.inOut(Easing.quad), useNativeDriver: false }),
      Animated.delay(420),
      Animated.timing(pos, { toValue: { x: target.x * 0.55, y: target.y * 0.55 }, duration: 380, easing: Easing.inOut(Easing.quad), useNativeDriver: false }),
    ]));
    if (step === 'frente') {
      Animated.timing(pos, { toValue: target, duration: 400, useNativeDriver: false }).start();
      return;
    }
    loop.start();
    return () => loop.stop();
  }, [step, pos]);
  const squash = pos.x.interpolate({ inputRange: [-1, 0, 1], outputRange: [0.86, 1, 0.86] });
  const nod = pos.y.interpolate({ inputRange: [-1, 0, 1], outputRange: [0.9, 1, 0.9] });
  return (
    <View style={{ width: 150, height: 150, alignItems: 'center', justifyContent: 'center' }} accessibilityLabel={`Bonequinho: ${TEXT[step]}`}>
      <Animated.View style={{ position: 'absolute', transform: [{ scaleX: squash }, { scaleY: nod }] }}>
        <Svg width={130} height={140}>
          <Ellipse cx={65} cy={74} rx={52} ry={60} fill="#FDE2C8" stroke="#E7B48F" strokeWidth={2} />
          <Path d="M17 62 C 22 20, 108 20, 113 62 C 100 40, 30 40, 17 62 Z" fill="#5B4636" />
        </Svg>
      </Animated.View>
      <Animated.View style={{ position: 'absolute', top: 58, transform: [
        { translateX: Animated.multiply(pos.x, 26) }, { translateY: Animated.multiply(pos.y, 14) },
      ] }}>
        <Svg width={70} height={60}>
          <Circle cx={18} cy={14} r={5.5} fill="#1E293B" />
          <Circle cx={52} cy={14} r={5.5} fill="#1E293B" />
          <Path d="M35 20 L 31 34 L 39 34" stroke="#C98C66" strokeWidth={3} fill="none" strokeLinecap="round" strokeLinejoin="round" />
          <Path d="M24 45 Q 35 53, 46 45" stroke="#B4533C" strokeWidth={3.5} fill="none" strokeLinecap="round" />
        </Svg>
      </Animated.View>
    </View>
  );
}

const s = StyleSheet.create({
  dim: { backgroundColor: 'rgba(9, 38, 56, 0.72)' },
  overlay: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16 },
  sheet: { width: '100%', maxWidth: 820, maxHeight: '100%', backgroundColor: cap.sheet, borderRadius: 18, padding: 24, gap: 18 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 },   // gap: on a phone the title touched "Voz ligada"
  title: { fontFamily: 'Inter_700Bold', fontSize: 18, color: cap.heading, flexShrink: 1 },
  stage: { flexDirection: 'row', gap: 28, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'center' },
  cameraBox: { width: 320, height: 320, alignItems: 'center', justifyContent: 'center' },
  camera: { width: 280, height: 280, borderRadius: 140, overflow: 'hidden', backgroundColor: '#0F172A' },
  countdown: { position: 'absolute', width: 280, height: 280, borderRadius: 140, backgroundColor: 'rgba(15,23,42,0.45)',
               alignItems: 'center', justifyContent: 'center' },
  countdownText: { fontFamily: 'Inter_800ExtraBold', fontSize: 72, color: '#FFFFFF' },
  guide: { flex: 1, minWidth: 280, alignItems: 'center', gap: 14 },
  instruction: { fontFamily: 'Inter_800ExtraBold', fontSize: 30, lineHeight: 38, color: cap.heading, textAlign: 'center', flexShrink: 1 },
  introTitle: { fontFamily: 'Inter_700Bold', fontSize: 20, color: cap.heading, textAlign: 'center' },
  banner: { gap: 8, alignItems: 'center', paddingVertical: 12, paddingHorizontal: 16, borderRadius: 14, backgroundColor: cap.nowBg },
  holdText: { fontFamily: 'Inter_600SemiBold', fontSize: 16, color: cap.text },
  feedback: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 10 },
  feedbackText: { fontFamily: 'Inter_700Bold', fontSize: 17, flexShrink: 1 },
  holdBadge: { position: 'absolute', bottom: 28, width: 64, height: 64, borderRadius: 32, backgroundColor: 'rgba(2, 132, 199, 0.92)',
               alignItems: 'center', justifyContent: 'center' },
  holdNumber: { fontFamily: 'Inter_800ExtraBold', fontSize: 34, color: '#FFFFFF' },
  checkingText: { fontFamily: 'Inter_700Bold', fontSize: 20, color: '#FFFFFF' },
  voice: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  voiceText: { fontFamily: 'Inter_500Medium', fontSize: 13, color: cap.text },
  chips: { flexDirection: 'row', gap: 6, flexWrap: 'wrap', justifyContent: 'center' },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4, paddingHorizontal: 10, borderRadius: 999,
          backgroundColor: cap.chip },
  chipNow: { backgroundColor: cap.nowBg, borderWidth: 1, borderColor: cap.accent },
  chipDone: { backgroundColor: cap.doneBg },
  chipText: { fontFamily: 'Inter_500Medium', fontSize: 12, color: cap.chipText },
  text: { fontFamily: 'Inter_400Regular', fontSize: 14, lineHeight: 21, color: cap.text },
  error: { fontFamily: 'Inter_500Medium', fontSize: 14, color: cap.error },
  start: { flexDirection: 'row', alignSelf: 'center', alignItems: 'center', gap: 8, height: 46, paddingHorizontal: 22, borderRadius: 12,
           backgroundColor: '#0070B0' },
  startText: { fontFamily: 'Inter_700Bold', fontSize: 15, color: '#FFFFFF' },
});
