import type { ReactNode } from 'react';

/** A frame of the guided capture: a JPEG Blob in the browser, a JPEG file of the camera in the app. */
export type Frame = Blob | { uri: string };

/**
 * The camera of the guided capture, one per platform (06/11/2026): the browser's (camera.web.tsx) and the phone's
 * (camera.tsx). The capture itself (GuidedCapture.tsx) is the same for the site and the app.
 */
export type CaptureCamera = {
  /** The live image, mirrored like a mirror; it fills the circle it is placed in. */
  view: ReactNode;
  /** The camera is on and frames can be taken. */
  ready: boolean;
  /** Why the camera could not open, in words for the person. */
  error: string | null;
  /** One still frame (the real image, not the mirror), or null if the camera is not giving images. */
  frame: () => Promise<Frame | null>;
  /** Turns the camera off now (its light goes out). */
  stop: () => void;
  /** Turns it on again ("Tentar de novo"). */
  restart: () => void;
};
