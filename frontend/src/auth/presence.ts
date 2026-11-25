/**
 * Closing the browser ends a session without "Manter conectado" (28/10/2026). The session cookie has no expiry
 * date, but a browser that reopens "where it left off" restores it, so the server is told instead:
 * - every open tab gives a sign of life once a minute (GET /auth/presence — not "use" for the idle limit);
 * - the LAST open tab, when it closes, says so (POST /auth/presence/closed). A reload comes back within seconds
 *   and keeps the session; a closed browser does not, and its next page lands on the login.
 * The tabs know about each other through localStorage (a background tab may write only once a minute or two).
 */
import { api, API_URL } from '@/api/client';

const KEY = 'fotomac-tabs';
const BEAT_MS = 60_000;
const ALIVE_MS = 180_000;   // a tab that wrote less than this ago is still open
const tabId = Math.random().toString(36).slice(2);

function tabs(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, number>; } catch { return {}; }
}

function save(all: Record<string, number>): void {
  const now = Date.now();
  const alive = Object.fromEntries(Object.entries(all).filter(([, at]) => now - at < ALIVE_MS));
  try { localStorage.setItem(KEY, JSON.stringify(alive)); } catch { /* private window: the 5-minute rule still holds */ }
}

/** Starts this tab's signs of life; returns the function that stops them. */
export function startPresence(): () => void {
  const beat = () => {
    save({ ...tabs(), [tabId]: Date.now() });
    api('/auth/presence').catch(() => undefined);
  };
  const leave = () => {
    const all = tabs();
    delete all[tabId];
    save(all);
    const now = Date.now();
    if (!Object.values(all).some((at) => now - at < ALIVE_MS)) {
      navigator.sendBeacon?.(`${API_URL}/api/v1/auth/presence/closed`);
    }
  };
  const back = (e: PageTransitionEvent) => { if (e.persisted) beat(); };   // returned from the back/forward cache
  beat();
  const timer = setInterval(beat, BEAT_MS);
  window.addEventListener('pagehide', leave);
  window.addEventListener('pageshow', back);
  return () => {
    clearInterval(timer);
    window.removeEventListener('pagehide', leave);
    window.removeEventListener('pageshow', back);
    const all = tabs();
    delete all[tabId];
    save(all);
  };
}
