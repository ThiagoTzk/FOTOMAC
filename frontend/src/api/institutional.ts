import { API_URL, api } from '@/api/client';
import type { SignatureValue } from '@/components/signature/SignatureInput';

/** The adopted signature as the server receives it: the image and how it was made (typed, drawn, rubrica). */
const signed = (s: SignatureValue) => ({ signature: s.png, kind: s.kind, text: s.text, font: s.font });

/** Institutional people and the photos where they were found. */
export type InstitutionalStatus = 'awaiting' | 'active' | 'revoked';
export type MarkCounts = { pending: number; confirmed: number; rejected: number };

export type PersonRow = {
  id: string; full_name: string; position: string; unit: string | null; email: string;
  status: InstitutionalStatus; status_label: string; created_at: string; link_expires_at: string | null;
  authorized_at: string | null; revoked_at: string | null; marks: MarkCounts;
  /** When each field was corrected ("alterado", with the date on hover). */
  name_changed_at: string | null; position_changed_at: string | null; unit_changed_at: string | null;
  email_changed_at: string | null;
};
export type PersonDetail = PersonRow & {
  /** Only on creation: false when the person was saved but the mail server did not take the link. */
  link_sent?: boolean;
  photos: { id: string; position: number; faces_found: number | null }[];
  term_version: string | null; document_sha256: string | null; authorized_ip: string | null;
  revoked_by: 'holder' | 'admin' | null; scan_status: 'idle' | 'pending' | 'done'; scanned_at: string | null;
  signed: boolean;
  /** New e-mail waiting for the person's signed confirmation. */
  pending_email: string | null;
  /** How the authorization was signed: typed (name in a handwriting font), drawn, or a rubrica. */
  signature_kind: 'typed' | 'drawn' | 'initials' | null; signature_font: string | null;
  /** Revocation term sent at the person's request, not signed yet. */
  revoke_requested_at: string | null;
  dev_link_available: boolean;   // TEMPORÁRIO — remover antes da implantação
};

// ---------------------------------------------------------------- administrator
const ADMIN = '/admin/institutional';
export const listPeople = () => api<PersonRow[]>(ADMIN);
export const getPerson = (id: string) => api<PersonDetail>(`${ADMIN}/${id}`);
export const createPerson = (form: FormData) => api<PersonDetail>(ADMIN, { body: form });
export const resendLink = (id: string) => api<void>(`${ADMIN}/${id}/link`, { method: 'POST' });
/** TEMPORÁRIO — REMOVER ANTES DA IMPLANTAÇÃO: shows the link while e-mails are not really sent. */
export const devLink = (id: string) => api<{ url: string }>(`${ADMIN}/${id}/link/dev`, { method: 'POST' });
export const endAuthorization = (id: string) => api<PersonDetail>(`${ADMIN}/${id}/end`, { method: 'POST' });
export const rescan = (id: string) => api<void>(`${ADMIN}/${id}/rescan`, { method: 'POST' });
export const updatePerson = (id: string, body: { full_name: string; position: string; unit: string | null }) =>
  api<PersonDetail>(`${ADMIN}/${id}`, { method: 'PUT', body });
export const changeEmail = (id: string, email: string) => api<PersonDetail>(`${ADMIN}/${id}/email`, { body: { email } });
export const sendRevocationRequest = (id: string) => api<PersonDetail>(`${ADMIN}/${id}/revocation-request`, { method: 'POST' });
export const deletePerson = (id: string) => api<void>(`${ADMIN}/${id}`, { method: 'DELETE' });
export const personPhotoUrl = (id: string, photoId: string, small = false) =>
  `${API_URL}/api/v1${ADMIN}/${id}/photos/${photoId}${small ? '?small=true' : ''}`;
export const signatureUrl = (id: string) => `${API_URL}/api/v1${ADMIN}/${id}/signature`;
export const formUrl = (id: string) => `${API_URL}/api/v1${ADMIN}/${id}/form.pdf`;

// ---------------------------------------------------------------- the person (public page, by link)
const PUBLIC = '/public/institutional';
export type AuthorizationPage = {
  full_name: string; position: string; unit: string | null; photos: string[]; expires_at: string;
  term: { version: string; title: string; paragraphs: string[] };
};
export const getAuthorization = (token: string) =>
  api<AuthorizationPage>(`${PUBLIC}/authorization?token=${encodeURIComponent(token)}`);
export const authorizationPhotoUrl = (token: string, photoId: string) =>
  `${API_URL}/api/v1${PUBLIC}/authorization/photos/${photoId}?token=${encodeURIComponent(token)}`;
export const sign = (token: string, signature: SignatureValue) =>
  api<{ signed: boolean }>(`${PUBLIC}/authorization`, { body: { token, ...signed(signature) } });
export const refuse = (token: string) => api<void>(`${PUBLIC}/refusal`, { body: { token } });
export const getRevocation = (token: string) =>
  api<{ full_name: string; status: InstitutionalStatus; authorized_at: string | null; revoked_at: string | null }>(
    `${PUBLIC}/revocation?token=${encodeURIComponent(token)}`);
/** Revoking is signed on the screen, like authorizing (24/10/2026). */
export const revoke = (token: string, signature: SignatureValue) =>
  api<{ revoked_at: string }>(`${PUBLIC}/revocation`, { body: { token, ...signed(signature) } });
export const getEmailChange = (token: string) =>
  api<{ full_name: string; old_email: string; new_email: string; authorized_at: string; expires_at: string }>(
    `${PUBLIC}/email-change?token=${encodeURIComponent(token)}`);
export const confirmEmailChange = (token: string, signature: SignatureValue) =>
  api<{ email: string }>(`${PUBLIC}/email-change`, { body: { token, ...signed(signature) } });

// ---------------------------------------------------------------- consultation (photographer, marketing, admin)
export type Person = {
  id: string; full_name: string; position: string; unit: string | null;
  photo_id?: string | null;   // the first reference photo (the list)
  photo_ids?: string[];       // every reference photo of the signed term (the person's page)
  name_changed_at?: string | null; position_changed_at?: string | null; unit_changed_at?: string | null;
};
export type PersonEvent = {
  id: string; name: string; date_label: string; location: string; marked: number; total: number;
  cover_version: string | null;   // null: the event has no cover
};
export type MarkedImage = {
  image_id: string; status: 'pending' | 'confirmed'; similarity: number; credit: string; signature: string;
  captured_at: string | null; version: string;
};
export const consultPeople = () => api<Person[]>('/institutional/people');
/** A reference photo, for the team that confirms the marks (31/10/2026; term v4, section 2). */
export const referencePhotoUrl = (id: string, photoId: string, small = false) =>
  `${API_URL}/api/v1/institutional/people/${id}/reference/${photoId}${small ? '?small=true' : ''}`;
export function personEvents(id: string, f: { date_from?: string | null }) {
  const q = new URLSearchParams();
  if (f.date_from) q.set('date_from', f.date_from);
  return api<{ person: Person; events: PersonEvent[] }>(`/institutional/people/${id}/events?${q}`);
}
export type EventMarks = {
  person: Person;
  event: { id: string; name: string; location: string; date_label: string; total: number; themes: string[] };
  images: MarkedImage[];
};
export const personEventImages = (id: string, eventId: string) =>
  api<EventMarks>(`/institutional/people/${id}/events/${eventId}/images`);
export const markedImageUrl = (id: string, imageId: string, variant: 'thumb' | 'preview', v?: string) =>
  `${API_URL}/api/v1/institutional/people/${id}/images/${imageId}/${variant}${v ? `?v=${v}` : ''}`;
/** The person's page (24/10/2026): every event with the person, each with the person's photos. */
export type ProfileEvent = PersonEvent & { can_open: boolean; images: MarkedImage[] };
export type Profile = { person: Person; press_allowed: boolean; events: ProfileEvent[] };
export function personProfile(id: string, f: { date_from?: string | null; date_to?: string | null }) {
  const q = new URLSearchParams();
  if (f.date_from) q.set('date_from', f.date_from);
  if (f.date_to) q.set('date_to', f.date_to);
  return api<Profile>(`/institutional/people/${id}/profile?${q}`);
}
/** The photo for the press, named after the person (confirmed marks only; term v2). */
export const namedDownloadLink = (id: string, imageId: string) =>
  api<{ url: string }>(`/institutional/people/${id}/images/${imageId}/download-link`, { method: 'POST' });
export const decideMarks = (id: string, imageIds: string[], confirm: boolean) =>
  api<{ decided: number }>(`/institutional/people/${id}/marks`, { body: { image_ids: imageIds, confirm } });
