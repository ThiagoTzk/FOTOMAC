import { router } from 'expo-router';
import { Platform } from 'react-native';

/**
 * The ONLY door from the screens to the server. Every screen calls the Python API through
 * here — the same contract the mobile app will use.
 */
export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8000';
/** The site itself: the app opens a few of its pages, like the map (public/map/app.html). */
export const SITE_URL = process.env.EXPO_PUBLIC_SITE_URL ?? 'http://localhost:8081';


/**
 * The mobile app (06/11/2026) has no browser cookies. It says it is the app and sends its sessions in headers: the
 * login as "Authorization: Bearer" and the visitor's facial-search visit as "X-Fotomac-Visit". Both tokens live in
 * this module's memory (the login one is also in the phone's safe with "Manter conectado": auth/appSession).
 */
export const IS_APP = Platform.OS !== 'web';
let appToken: string | null = null;
let visitToken: string | null = null;
export const setAppToken = (token: string | null) => { appToken = token; };
export const setVisitToken = (token: string | null) => { visitToken = token; };
export function appHeaders(): Record<string, string> {
  if (!IS_APP) return {};
  return { 'X-Fotomac-Client': 'app', ...(appToken ? { Authorization: `Bearer ${appToken}` } : {}),
           ...(visitToken ? { 'X-Fotomac-Visit': visitToken } : {}) };
}

export { appendFile, type Upload } from './upload';

/** An image of the API (a thumbnail, a result): in the app it carries the session headers, like any other request. */
export function apiImage(url: string): string | { uri: string; headers: Record<string, string> } {
  return IS_APP ? { uri: url, headers: appHeaders() } : url;
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public detail?: unknown) {
    super(message);
  }
}

const NETWORK_ERROR = 'Não foi possível conectar ao servidor. Verifique sua conexão e tente novamente.';

/**
 * The account THIS tab shows. One browser keeps one session cookie for all its tabs: logging in with
 * another account in another tab changes who this tab acts as, while it still shows the old name.
 * Every request says who the screen believes it is; the server refuses (409) when the session is
 * someone else, and the page reloads (22/10/2026).
 */
let shownAccountId: string | null = null;
export const setShownAccount = (id: string | null) => { shownAccountId = id; };
export const accountHeaders = (): Record<string, string> => (shownAccountId ? { 'X-Fotomac-Account': shownAccountId } : {});

/**
 * One account per browser at a time, and every tab follows it — like Google or GitHub.
 * The browser has ONE session cookie, so when the account changes in any tab, this tab leaves the page it
 * was on (which may belong to the old account) and opens the panel fresh: with the account now in the
 * session, or the login when nobody is. It never keeps showing a name the session no longer has.
 */
export function followSession(): void {
  shownAccountId = null;
  if (IS_APP) router.replace('/painel');
  else if (typeof window !== 'undefined') window.location.replace('/painel');
}

function reloadIfAnotherAccount(status: number, detail: { reason?: string } | undefined): void {
  if (status === 409 && detail?.reason === 'account_changed') followSession();
}

/** asIs: ask without saying which account the tab shows — only to find out who the session is now. */
export async function api<T>(path: string, options: { method?: string; body?: unknown; asIs?: boolean } = {}): Promise<T> {
  let response: Response;
  // Forms with files (event cover, photos) go as multipart; the browser sets the boundary.
  const isForm = typeof FormData !== 'undefined' && options.body instanceof FormData;
  try {
    response = await fetch(`${API_URL}/api/v1${path}`, {
      method: options.method ?? (options.body ? 'POST' : 'GET'),
      // "include": send the HttpOnly session cookie. JavaScript never sees the token itself.
      credentials: 'include',
      headers: { ...appHeaders(), ...(options.asIs ? {} : accountHeaders()), ...(options.body && !isForm ? { 'Content-Type': 'application/json' } : {}) },
      body: isForm ? (options.body as FormData) : options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch (e) {
    if (__DEV__) console.warn(`[api] ${path}: ${e instanceof Error ? e.message : String(e)}`);   // only while developing
    throw new ApiError(0, NETWORK_ERROR);
  }
  if (response.status === 204) return undefined as T;
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    // The API sends user-safe Portuguese messages in "detail" (string or {message, ...}).
    const detail = data?.detail;
    reloadIfAnotherAccount(response.status, detail);
    const message = typeof detail === 'string' ? detail : detail?.message ?? 'Algo deu errado. Tente novamente.';
    throw new ApiError(response.status, message, detail);
  }
  return data as T;
}
