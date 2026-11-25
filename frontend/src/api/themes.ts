/**
 * Temas screen (RF027), for the administrator, photographers and marketing (11/11/2026). One list for all,
 * with the author of each theme; only the author or the administrator changes a theme. The server applies
 * that rule: can_change only decides which buttons the screen shows.
 */
import { api } from './client';
import { createEventTheme } from './events';

export type ThemeRow = {
  id: number; name: string; icon: string; active: boolean; events: number;
  /** null: the account is gone, or the theme came with the system (then only the administrator changes it). */
  author: string | null;
  mine: boolean;
  can_change: boolean;
};

export const listManagedThemes = () => api<ThemeRow[]>('/themes/manage');
/** The same creation as in the event form: the creator owns the theme. */
export const createTheme = createEventTheme;
export const renameTheme = (id: number, name: string, icon: string) =>
  api<ThemeRow>(`/themes/${id}`, { method: 'PUT', body: { name, icon } });
export const setThemeActive = (id: number, active: boolean) => api<ThemeRow>(`/themes/${id}/status`, { body: { active } });
export const deleteTheme = (id: number) => api<void>(`/themes/${id}`, { method: 'DELETE' });
