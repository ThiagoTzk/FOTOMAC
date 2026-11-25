/** Administrator: accounts. The server re-checks the role. */
import { api, API_URL } from './client';

export type Role = 'admin' | 'photographer' | 'marketing' | 'contractor';
export type AccountStatus = 'pending' | 'active' | 'inactive' | 'suspended' | 'expired';

export type AccountRow = {
  id: string;
  full_name: string;
  email: string;
  role: Role;
  role_label: string;
  status: AccountStatus;
  status_label: string;
  photographer_signature: string | null;
  locked: boolean;
  activation_link: 'valid' | 'expired' | null;
  created_at: string;
  /** The profile photo the person chose to send; null = initials. */
  photo_version: string | null;
};
export const accountPhotoUrl = (id: string, version: string) => `${API_URL}/api/v1/admin/accounts/${id}/photo?v=${version}`;
export type AccountDetail = AccountRow & {
  owned_events: number;
  is_me: boolean;
  dev_link_available: boolean; // TEMPORÁRIO — remover antes da implantação (só em desenvolvimento)
  /** Only on creation: false when the account was saved but the mail server did not take the link. */
  link_sent?: boolean;
  /** Temporary account of a hired photographer. The CPF comes masked from the server. */
  contractor: {
    event_id: string | null; event_name: string | null; contract_number: string | null; valid_until: string | null;
    contract_hours: number | null;
    cpf: string | null; birth_date: string | null; identity_erased_at: string | null; photos: number; photos_pending: number;
  } | null;
};
export type AccountInput = {
  full_name: string; email?: string; role: Role; photographer_signature: string | null;
  bound_event_id?: string | null; contract_number?: string | null; contract_hours?: number;
};

export function listAccounts(f: { q?: string; role?: Role | null; status?: AccountStatus | null }) {
  const p = new URLSearchParams();
  if (f.q?.trim()) p.set('q', f.q.trim());
  if (f.role) p.set('role', f.role);
  if (f.status) p.set('status', f.status);
  return api<{ items: AccountRow[]; counts: Record<AccountStatus, number>; institutional_domain: string }>(`/admin/accounts?${p}`);
}
export const getAccount = (id: string) => api<AccountDetail>(`/admin/accounts/${id}`);
export const createAccount = (body: AccountInput) => api<AccountDetail>('/admin/accounts', { body });
export const updateAccount = (id: string, body: AccountInput) => api<AccountDetail>(`/admin/accounts/${id}`, { method: 'PUT', body });
export const changeStatus = (id: string, status: AccountStatus) => api<AccountDetail>(`/admin/accounts/${id}/status`, { body: { status } });
export const resendLink = (id: string) => api<void>(`/admin/accounts/${id}/activation-link`, { method: 'POST' });
/** Hired photographer: a new coverage (event, contract, period) or more hours on the current one. */
export const renewContract = (id: string, body: { event_id: string; contract_number: string; hours: number }) =>
  api<AccountDetail>(`/admin/accounts/${id}/contract`, { body });
export const unlockAccount = (id: string) => api<AccountDetail>(`/admin/accounts/${id}/unlock`, { method: 'POST' });

// TEMPORÁRIO — REMOVER ANTES DA IMPLANTAÇÃO. Mostra o link de definição de senha ao administrador, só para
// demonstração; o servidor só atende em desenvolvimento (e-mails viram arquivo). Em produção o link vai
// apenas ao e-mail do titular.
export const devActivationLink = (id: string) =>
  api<{ url: string }>(`/admin/accounts/${id}/activation-link/dev`, { method: 'POST' });
