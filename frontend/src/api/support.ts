/** Support page: the team writes to the administration, and both sides talk until it is solved (28/10 and 31/10/2026). */
import { api } from '@/api/client';

export type SupportKind = 'problem' | 'suggestion' | 'question' | 'access';
export type SupportStatus = 'open' | 'analyzing' | 'fixing' | 'resolved';
export type SupportEntry = {
  from_admin: boolean; author_name: string | null; body: string | null;
  /** Set when the administration changed the status (with an optional note in body). */
  status: SupportStatus | null; status_label: string | null; created_at: string;
};
export type SupportMessage = {
  id: string; kind: SupportKind; kind_label: string; subject: string; message: string; page: string | null;
  status: SupportStatus; status_label: string; created_at: string; resolved_at: string | null;
  entries: SupportEntry[];
  /** The other side did something this side has not read yet. */
  unread: boolean;
  /** Only in the administrator's list: who wrote, and the situation of that account. */
  author_id: string | null; author_name: string | null; author_email: string | null; author_role: string | null;
  author_status: string | null; author_status_label: string | null;
};

export const SUPPORT_KINDS: { value: SupportKind; label: string }[] = [
  { value: 'problem', label: 'Problema' }, { value: 'suggestion', label: 'Sugestão' }, { value: 'question', label: 'Dúvida' },
  { value: 'access', label: 'Acesso à conta' },
];
export const SUPPORT_STATUSES: { value: SupportStatus; label: string }[] = [
  { value: 'open', label: 'Aberta' }, { value: 'analyzing', label: 'Em análise' }, { value: 'fixing', label: 'Em correção' },
  { value: 'resolved', label: 'Resolvida' },
];

export const sendSupport = (body: { kind: SupportKind; subject: string; message: string; page: string | null }) =>
  api<SupportMessage>('/support', { body });
export const mySupport = () => api<SupportMessage[]>('/support/mine');
export const replyMine = (id: string, body: string) => api<SupportMessage>(`/support/${id}/replies`, { body: { body } });
export const seenMine = (id: string) => api<void>(`/support/${id}/seen`, { method: 'POST' });

export type InboxFilter = 'active' | SupportStatus | 'all';
export const allSupport = (filter: InboxFilter) =>
  api<SupportMessage[]>(`/admin/support${filter === 'all' ? '' : `?status=${filter}`}`);
export const replyAsAdmin = (id: string, body: string) => api<SupportMessage>(`/admin/support/${id}/replies`, { body: { body } });
// Only the status: a message is sent by its own button (31/10/2026).
export const setSupportStatus = (id: string, status: SupportStatus) =>
  api<SupportMessage>(`/admin/support/${id}/status`, { body: { status, note: null } });
export const seenAsAdmin = (id: string) => api<void>(`/admin/support/${id}/seen`, { method: 'POST' });
