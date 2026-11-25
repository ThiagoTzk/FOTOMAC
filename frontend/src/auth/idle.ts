/**
 * When the person last USED the system (moved the mouse, typed, scrolled, tapped), shared by every tab of the
 * browser through localStorage — working in one tab keeps the others alive. Inactivity ends the session
 * (25/10/2026); the server has the final word, this only tells it that the person is there.
 */
import { api } from '@/api/client';

const KEY = 'fotomac-last-use';
const PING_MS = 60_000;      // the server is told about use at most once a minute
let lastUse = Date.now();
let lastPing = 0;
let holds = 0;               // work in progress that counts as use (an upload of many photos)
let asking = false;          // "Você ainda está aí?" is open: only its button counts as use (28/10/2026)

function stored(): number {
  try { return Number(localStorage.getItem(KEY)) || 0; } catch { return 0; }
}

/** The person did something. force = a deliberate action (the warning's button, the login, an upload). */
export function markUse(force = false): void {
  const now = Date.now();
  // While the warning is open, moving the mouse does not answer it: the person has to click "Continuar conectado".
  if (!force && asking) return;
  if (!force && now - lastUse < 2000) return;   // mouse moves fire constantly: once every 2 s is enough
  lastUse = now;
  try { localStorage.setItem(KEY, String(now)); } catch { /* private window: this tab only */ }
  if (force || now - lastPing > PING_MS) {
    lastPing = now;
    api('/auth/activity', { method: 'POST' }).catch(() => undefined);
  }
}

/** The most recent use in any tab (or now, while some work holds the session). */
export function lastUseAt(): number {
  if (holds > 0) { markUse(); return Date.now(); }
  return Math.max(lastUse, stored());
}

/** Keeps the session in use while a long task runs (e.g. sending 500 photos); call the returned function at the end. */
export function holdSession(): () => void {
  holds += 1;
  markUse(true);
  let released = false;
  return () => { if (!released) { released = true; holds -= 1; markUse(true); } };
}

/** The warning opened or closed. */
export function setAsking(open: boolean): void {
  asking = open;
}

/** Told by the server how many seconds were left: lines this tab up with the use made elsewhere. */
export function syncFromServer(leftSeconds: number, idleMinutes: number): void {
  const seen = Date.now() - (idleMinutes * 60 - leftSeconds) * 1000;
  if (seen > lastUse) lastUse = seen;
}

export const IDLE_LOGOUT_FLAG = 'fotomac-idle-logout';
