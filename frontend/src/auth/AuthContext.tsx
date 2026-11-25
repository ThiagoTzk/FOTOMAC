import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

import { api, followSession, IS_APP, setAppToken, setShownAccount } from '@/api/client';
import { keepToken, storedToken } from '@/auth/appSession';
import { videoBeingSent } from '@/components/panel/videoQueue';
import { confirmAsync } from '@/ui/confirm';

export type Account = {
  id: string;
  full_name: string;
  email: string;
  role: 'admin' | 'photographer' | 'marketing' | 'contractor';
  role_label: string;
  photographer_signature: string | null;
  /** Temporary account of the hired photographer: when it stops working, and its only event. */
  valid_until: string | null;
  bound_event_id: string | null;
  /** Minutes without use before the session ends, and the seconds left; null with "Manter conectado". */
  idle_minutes: number | null;
  idle_left_seconds: number | null;
  /** Optional profile photo: changes with the photo; null = the initials. */
  photo_version: string | null;
  /** "active", or suspended / inactive / expired: then the panel shows only the restricted page (31/10/2026). */
  status: 'active' | 'suspended' | 'inactive' | 'expired';
  status_label: string;
  /** Only for a blocked account: since when, and the last time it really entered the system. */
  blocked: { since: string | null; last_login_at: string | null } | null;
};

type AuthState = {
  account: Account | null;
  /** true until the first /auth/me answer: avoids flashing the login screen on reload. */
  loading: boolean;
  /** remember = "Manter conectado": the session survives closing the browser (30 days). */
  login: (email: string, password: string, remember?: boolean) => Promise<void>;
  logout: () => Promise<void>;
  setAccount: (account: Account | null) => void;
  /** Asks the server again (e.g. the temporary account's clock reached zero, or a blocked account was reactivated). */
  refresh: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

/**
 * Keeps "who is logged in" for the screens. It is only a convenience for the interface:
 * the server re-checks the session cookie on every request.
 */
// Tabs of the same browser tell each other when someone logs in or out, so none keeps showing a name
// that is no longer the session's (the server refuses that case anyway).
const CHANNEL = 'fotomac-session';
// Pages that do not belong to an account: the public site, the links received by e-mail and the password
// screens. There a change of account only updates what is shown (the site's header). Anywhere else (the
// panel) the tab reopens fresh, because its page may belong to the old account. Decided by the address and
// not by which layout is mounted: a panel screen stays mounted under the site after "Ver o site".
const ACCOUNTLESS = /^\/($|explorar|evento|como-funciona|privacidade|creditos|autorizacao|recuperar-senha|redefinir-senha|primeiro-acesso)/;
const announce = (id: string | null) => {
  if (typeof BroadcastChannel !== 'undefined') new BroadcastChannel(CHANNEL).postMessage({ id });
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [account, setAccountState] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);
  // What this tab shows. Set by the first /auth/me WITHOUT telling the other tabs: only a login, a first
  // access or a logout made HERE is news to them (announcing every page load would make the tabs reload
  // each other in a loop).
  const shown = useRef<string | null>(null);
  const shownStatus = useRef<string | null>(null);
  const show = useCallback((next: Account | null) => {
    shown.current = next?.id ?? null;
    shownStatus.current = next?.status ?? null;
    setShownAccount(shown.current);
    setAccountState(next);
  }, []);
  const setAccount = useCallback((next: Account | null) => {
    const changed = (next?.id ?? null) !== shown.current;
    show(next);
    if (changed) announce(next?.id ?? null);
  }, [show]);

  // Asks the server who the session is NOW and makes this tab agree. Runs when another tab announces a
  // login/logout and whenever this tab comes back into view: the announcement alone is not enough (a tab
  // opened before an update, or a browser without BroadcastChannel, would miss it).
  const sync = useCallback(async () => {
    const now = await api<Account>('/auth/me', { asIs: true }).catch((e) => (e?.status === 401 ? null : undefined));
    if (now === undefined) return;   // offline
    if ((now?.id ?? null) === shown.current) {
      // Same account, another situation (suspended, expired, or reactivated): the panel switches between the
      // restricted page and the full one, without leaving the address.
      if (now && now.status !== shownStatus.current) show(now);
      return;
    }
    const path = typeof window !== 'undefined' ? window.location.pathname : '';
    // The login screen enters with whoever just logged in; the public pages only show the new state; the
    // panel reopens with the new account (or goes to the login).
    if (path === '/login') { if (now) followSession(); }
    else if (ACCOUNTLESS.test(path)) show(now);
    else followSession();
  }, [show]);

  useEffect(() => {
    // Tabs and their visibility exist only in a browser: the app is one screen at a time.
    if (IS_APP || typeof window === 'undefined') return;
    const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL) : null;
    if (channel) channel.onmessage = () => { sync(); };
    const onVisible = () => { if (document.visibilityState === 'visible') sync(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      channel?.close();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [sync]);

  useEffect(() => {
    // The app: the session kept in the phone's safe ("Manter conectado"), if any, before asking who it is.
    (IS_APP ? storedToken().then(setAppToken) : Promise.resolve())
      .then(() => api<Account>('/auth/me'))
      .then(show)
      .catch(() => show(null))
      .finally(() => setLoading(false));
  }, [show]);

  const login = useCallback(async (email: string, password: string, remember = false) => {
    const { session_token: token, ...next } = await api<Account & { session_token?: string }>('/auth/login', { body: { email, password, remember } });
    if (IS_APP && token) {
      setAppToken(token);
      await keepToken(token, remember);
    }
    setAccount(next);
  }, [setAccount]);

  const refresh = useCallback(async () => {
    const now = await api<Account>('/auth/me', { asIs: true }).catch((e) => (e?.status === 401 ? null : undefined));
    if (now !== undefined) show(now);
  }, [show]);

  const logout = useCallback(async () => {
    // A video on its way would be cut. The idle logout never lands here then: the transfer holds the session.
    if (videoBeingSent() && !(await confirmAsync('Um vídeo ainda está sendo enviado. Se sair agora, o envio para. Sair mesmo assim?', 'Sair'))) return;
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    if (IS_APP) {
      setAppToken(null);
      await keepToken(null, false);
    }
    setAccount(null);
  }, [setAccount]);

  return (
    <AuthContext.Provider value={{ account, loading, login, logout, setAccount, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
