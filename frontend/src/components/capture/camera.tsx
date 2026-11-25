import { CameraView, useCameraPermissions } from 'expo-camera';
import { File } from 'expo-file-system';
import { useEffect, useRef, useState } from 'react';
import { Linking, StyleSheet } from 'react-native';

import type { CaptureCamera, Frame } from './camera.types';

const MAX_SIDE = 1280;   // the same limit as the site: a bigger frame only makes the search slower

/**
 * The phone's front camera (06/11/2026, the app). Each frame is a JPEG file in the app's cache, upright (the phone's
 * rotation already applied) and at most MAX_SIDE wide. The files are deleted as soon as they are not needed:
 * discardFrames below, called after the search or when the capture stops (LGPD: "os quadros são apagados logo depois").
 */
export function useCaptureCamera(active: boolean): CaptureCamera {
  const camera = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [on, setOn] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!active) return;
    let gone = false;
    (async () => {
      const answer = permission?.granted ? permission : await requestPermission();
      if (gone) return;
      if (answer.granted) { setError(null); setOn(true); return; }
      setError('O acesso à câmera não foi permitido. Libere a câmera para o FOTOMAC nas configurações do celular.');
      if (!answer.canAskAgain) Linking.openSettings().catch(() => undefined);
    })();
    return () => { gone = true; setOn(false); setReady(false); };   // closed: the camera goes off
  }, [active]);   // eslint-disable-line react-hooks/exhaustive-deps

  async function chooseSize() {
    // The largest picture size that is not bigger than MAX_SIDE (the default would be the full sensor: megabytes each).
    const sizes = (await camera.current?.getAvailablePictureSizesAsync().catch(() => [])) ?? [];
    const parsed = sizes.map((s) => ({ s, side: Math.max(...s.split('x').map(Number)) })).filter((x) => x.side > 0);
    const fits = parsed.filter((x) => x.side <= MAX_SIDE).sort((a, b) => b.side - a.side)[0]
      ?? parsed.sort((a, b) => a.side - b.side)[0];
    setSize(fits?.s);
  }

  async function frame(): Promise<Frame | null> {
    if (!camera.current || !ready) return null;
    try {
      const shot = await camera.current.takePictureAsync({ quality: 0.85, shutterSound: false });
      return shot?.uri ? { uri: shot.uri } : null;
    } catch {
      return null;
    }
  }

  return {
    view: on ? (
      <CameraView ref={camera} facing="front" mirror={false} animateShutter={false} pictureSize={size}
                  style={StyleSheet.absoluteFill} accessibilityLabel="Imagem da câmera"
                  onCameraReady={() => { setReady(true); if (!size) chooseSize(); }}
                  onMountError={() => setError('Não foi possível abrir a câmera. Feche outros apps que estejam usando a câmera e tente de novo.')} />
    ) : null,
    ready, error, frame,
    stop: () => { setOn(false); setReady(false); },   // unmounting the view turns the camera (and its light) off
    restart: () => { setReady(false); setOn(true); },
  };
}

/** Deletes the frame files from the phone (they are in the app's cache until then). */
export function discardFrames(frames: Frame[]): void {
  for (const f of frames) {
    if ('uri' in f) try { new File(f.uri).delete(); } catch { /* already gone */ }
  }
}

/** The address to show a frame on the screen (the visitor's own selfie in the result). */
export const frameSource = (frame: Frame) => ('uri' in frame ? frame.uri : '');
export const releaseSource = (_src: string) => {};
