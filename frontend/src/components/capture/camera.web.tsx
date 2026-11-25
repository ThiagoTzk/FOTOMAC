import { useCallback, useEffect, useRef, useState } from 'react';

import type { CaptureCamera, Frame } from './camera.types';

const MAX_SIDE = 1280;

/** The browser's camera: getUserMedia, a <video> for the image and a canvas for each frame. */
export function useCaptureCamera(active: boolean): CaptureCamera {
  const video = useRef<HTMLVideoElement | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [turn, setTurn] = useState(0);   // "Tentar de novo" opens the camera again

  const connect = useCallback(() => {
    const el = video.current;
    if (!el || !stream.current || el.srcObject === stream.current) return;
    el.srcObject = stream.current;
    el.play().catch(() => undefined);
    setReady(true);
  }, []);
  const videoRef = useCallback((el: HTMLVideoElement | null) => { video.current = el; connect(); }, [connect]);

  const stop = useCallback(() => {
    stream.current?.getTracks().forEach((t) => t.stop());   // the camera light never stays on
    stream.current = null;
  }, []);

  useEffect(() => {
    if (!active) return;
    let gone = false;
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {  // browsers allow the camera only on https (or localhost)
        setError('Este navegador não permite usar a câmera nesta página. Abra o site em https ou use outro navegador.');
        return;
      }
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 } }, audio: false });
        if (gone) { s.getTracks().forEach((t) => t.stop()); return; }
        stream.current = s;
        if (video.current) video.current.srcObject = null;
        connect();
      } catch (e) {
        const name = (e as DOMException)?.name;
        setError(name === 'NotAllowedError' ? 'O acesso à câmera não foi permitido. Libere a câmera nas configurações do navegador.'
          : name === 'NotFoundError' ? 'Nenhuma câmera foi encontrada neste dispositivo.'
            : 'Não foi possível abrir a câmera. Libere o acesso à câmera no navegador.');
      }
    })();
    return () => {
      gone = true;
      stop();
      setReady(false);
      setError(null);
    };
  }, [active, turn, connect, stop]);

  async function frame(): Promise<Frame | null> {
    const el = video.current;
    if (!el || !el.videoWidth) return null;
    const k = Math.min(1, MAX_SIDE / Math.max(el.videoWidth, el.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(el.videoWidth * k);
    canvas.height = Math.round(el.videoHeight * k);
    canvas.getContext('2d')?.drawImage(el, 0, 0, canvas.width, canvas.height);  // the real image, not the mirror
    return new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
  }

  return {
    view: <video ref={videoRef} playsInline muted aria-label="Imagem da câmera"
                 style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)', background: '#0F172A' }} />,
    ready, error, frame, stop,
    restart: () => { stop(); setReady(false); setTurn((t) => t + 1); },
  };
}

/** In the browser a frame is a Blob in memory: nothing to delete. */
export function discardFrames(_frames: Frame[]): void {}

/** The address to show a frame on the screen (the visitor's own selfie in the result). */
export const frameSource = (frame: Frame) => ('uri' in frame ? frame.uri : URL.createObjectURL(frame));
export const releaseSource = (src: string) => { if (src.startsWith('blob:')) URL.revokeObjectURL(src); };
