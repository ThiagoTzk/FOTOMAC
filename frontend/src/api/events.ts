import { API_URL, api } from '@/api/client';
import { rememberEventName } from '@/components/DocumentTitle';
import type { EventStatus } from '@/components/panel/ui';

export type Theme = { id: number; name: string; icon: string };
export type DatePrecision = 'day' | 'month' | 'month_range';

export type EventItem = {
  id: string;
  name: string;
  date_precision: DatePrecision;
  date_start: string;
  date_end: string;
  date_label: string;
  location: string;
  description: string;
  /** Optional: the CEP, the pin and how to find the place. */
  postal_code: string | null;
  latitude: number | null;
  longitude: number | null;
  location_note: string | null;
  /** The map belongs to who created the event; the administrator only where that account is no longer active. */
  can_edit_map: boolean;
  themes: Theme[];
  status: EventStatus;
  collaboration_open: boolean;
  expires_on: string;
  owner: { id: string; full_name: string; team: string | null };
  /** viewer: the marketing team on someone else's published event, published photos only. outsider: an event found
   *  in the list that this account does not work on; the summary only, and the way to ask to collaborate. */
  relation: 'owner' | 'collaborator' | 'admin' | 'contractor' | 'viewer' | 'outsider';
  can_manage: boolean;
  photos: number;
  published: number;
  collaborators: { signature: string; photos: number }[];
  /** Photos of a hired photographer awaiting the administrator's approval. */
  approvals_pending: number;
  /** Videos of a hired photographer awaiting the administrator's approval (05/11/2026). */
  video_approvals_pending: number;
  /** Published photos whose face processing failed: "Erro em N imagens" beside the status. */
  failed: number;
  /** Photos and videos someone asked to remove, waiting for the deadline (team only, 05/11/2026). */
  removals: number;
  /** Videos converted and not published yet (team only, 05/11/2026). */
  videos_ready: number;
  /** Changes with the cover (cache); null = the event has no cover. */
  cover_version: string | null;
  /** The event accepts camera RAW files: its own switch, off by default. */
  raw_enabled: boolean;
  /** "Este evento contém imagens com crianças" (04/11/2026), with who declared the guardians' authorisation,
   *  when, and where the signed terms are (the last three for the team only). */
  has_children: boolean;
  children_authorization_ref: string | null;
  children_declared_by: string | null;
  children_declared_at: string | null;
  /** This account may send photos to the event now (server rule: status, collaboration, its access). */
  can_upload: boolean;
  /** This account's access was turned off in "Configuração do evento". */
  access_blocked: boolean;
  /** "Excluir evento": out of the site now, eliminated at this moment unless undone. */
  deletion_due_at: string | null;
  deletion_grace_days: number;
  /** This account may ask the responsible to send photos here / to accept RAW files here (01/11/2026). */
  ask_upload: boolean;
  ask_raw: boolean;
  /** This account's latest request on the event. */
  my_request: CollaborationRequest | null;
  /** For whoever manages the event: requests waiting for an answer. */
  requests_waiting: number;
};

/** A request to work on someone else's event (01/11/2026): send photos and/or accept RAW files. */
export type CollaborationRequest = {
  id: string; status: 'pending' | 'accepted' | 'declined' | 'cancelled'; wants_upload: boolean; wants_raw: boolean;
  message: string | null; reply: string | null; raw_turned_on: boolean; created_at: string; decided_at: string | null;
  requester_id: string; requester_name: string; requester_role: string; requester_signature: string | null;
  decider_name: string | null; seen: boolean;
  /** The conversation (01/11/2026): how many messages, one from the other side not read yet, and whether this
   *  account takes part in it (the administrator only where the responsible's account is not active). */
  messages: number; unread: boolean; can_chat: boolean;
};

export type ChatItem = {
  kind: 'request' | 'answer' | 'cancelled' | 'message'; author_name: string; mine: boolean;
  text: string | null; note: string | null; created_at: string;
};
/** `closed`: why this account can only read the conversation now (null = it writes). */
export type Chat = { items: ChatItem[]; closed: string | null };

export type EventPage = { items: EventItem[]; total: number; page: number; page_size: number };

export type Dashboard = {
  events_owned: number;
  processing: number;
  attention: number;
  photos_published: number;
  indexing_failures: number;
  removal_requests: number;
  oldest_removal_request: string | null;
  /** Administrator: events where photos of a hired photographer wait for approval. */
  approvals_pending: { event_id: string; event_name: string; photos: number }[];
  /** Administrator only: the whole system, not "my events". */
  active_events: number | null;
  approvals_total: number | null;
};

/** What needs this account's attention (the bell), computed by the server on every call. */
export type PanelNotice = {
  kind: string; tone: 'danger' | 'warning' | 'info'; urgent: boolean; title: string; description: string; href: string;
  since: string;   // when it began or last grew: the bell lists the newest first
  key: string;     // which notice it is, to dismiss it
  dismissed: boolean;   // removed from the bell by the person (08/11/2026); the overview still shows it
};
const TONE_ORDER: Record<PanelNotice['tone'], number> = { danger: 0, warning: 1, info: 2 };
/** The overview keeps the notices by importance (the bell, by date). */
export const byImportance = (items: PanelNotice[]) =>
  [...items].sort((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone] || a.title.localeCompare(b.title));

export type EventFilters = {
  q?: string; theme_id?: number | null; status?: EventStatus | null;
  period_start?: string | null; period_end?: string | null; scope?: 'all' | 'enabled' | 'mine' | 'collaborations'; page?: number;
};

export function listEvents(f: EventFilters): Promise<EventPage> {
  const params = new URLSearchParams();
  Object.entries(f).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') params.set(k, String(v)); });
  return api<EventPage>(`/events?${params}`);
}

// The browser tab is named after the event (FOTOMAC - <evento>).
export const getEvent = (id: string) => api<EventItem>(`/events/${id}`).then((e) => { rememberEventName(e.id, e.name); return e; });
/** Leaves the public area and erases the face data now; the photos wait the grace period. */
export const requestDeletion = (id: string) => api<EventItem>(`/events/${id}/deletion`, { method: 'POST' });
export const cancelDeletion = (id: string) => api<EventItem>(`/events/${id}/deletion`, { method: 'DELETE' });
export const listThemes = () => api<Theme[]>('/themes');
/** A new theme (tag) created while filling in an event; the creator owns it. */
export const createEventTheme = (name: string, icon: string) => api<Theme>('/themes', { body: { name, icon } });
export const getDashboard = () => api<Dashboard>('/dashboard');
/** unseen: notices that appeared after the bell was last opened (its counter). */
export const getNotifications = () => api<{ items: PanelNotice[]; urgent: number; unseen: number }>('/notifications');
export const markNotificationsSeen = () => api<void>('/notifications/seen', { method: 'POST' });
/** Removes one notice from the bell (it comes back if something new happens behind it). */
export const dismissNotification = (key: string) =>
  api<void>('/notifications/dismiss', { body: { key } });
export type CepPlace = { postal_code: string; street: string; district: string; city: string; state: string; latitude: number | null; longitude: number | null };
export const lookupCep = (cep: string) => api<CepPlace>(`/geo/cep/${cep.replace(/\D/g, '')}`);
export const setCollaboration = (id: string, open: boolean) =>
  api<EventItem>(`/events/${id}/collaboration`, { method: 'PUT', body: { open } });
export const setRaw = (id: string, enabled: boolean) => api<EventItem>(`/events/${id}/raw`, { method: 'PUT', body: { enabled } });
export const setChildren = (id: string, enabled: boolean, reference?: string, declared?: boolean) =>
  api<EventItem>(`/events/${id}/children`, { method: 'PUT', body: { enabled, reference: reference ?? null, declared: !!declared } });

const requests = (id: string) => `/events/${id}/collaboration-requests`;
export const askCollaboration = (id: string, body: { wants_upload: boolean; wants_raw: boolean; message: string | null }) =>
  api<EventItem>(requests(id), { body });
export const cancelCollaborationRequest = (id: string, requestId: string) =>
  api<EventItem>(`${requests(id)}/${requestId}`, { method: 'DELETE' });
export const listCollaborationRequests = (id: string) => api<CollaborationRequest[]>(requests(id));
export const decideCollaborationRequest = (id: string, requestId: string,
                                           body: { accept: boolean; reply: string | null; turn_raw_on: boolean }) =>
  api<CollaborationRequest>(`${requests(id)}/${requestId}/decision`, { body });
export const markCollaborationAnswerSeen = (id: string, requestId: string) =>
  api<void>(`${requests(id)}/${requestId}/seen`, { method: 'POST' });
export const getCollaborationChat = (id: string, requestId: string) => api<Chat>(`${requests(id)}/${requestId}/messages`);
export const writeCollaborationChat = (id: string, requestId: string, body: string) =>
  api<Chat>(`${requests(id)}/${requestId}/messages`, { body: { body } });
export const markCollaborationChatRead = (id: string, requestId: string) =>
  api<void>(`${requests(id)}/${requestId}/read`, { method: 'POST' });

/** Who works on the event ("Configuração do evento"), for whoever manages it. */
export type EventMember = {
  account_id: string; full_name: string; signature: string | null; role_label: string; photos: number; owner: boolean;
  allowed: boolean;
};
export const listMembers = (id: string) => api<EventMember[]>(`/events/${id}/members`);
export const setMemberAccess = (id: string, accountId: string, allowed: boolean) =>
  api<EventMember>(`/events/${id}/members/${accountId}`, { method: 'PUT', body: { allowed } });

/** The cover is served through the API (session checked) and then a short signed link. */
export const coverUrl = (id: string, version?: string) => `${API_URL}/api/v1/events/${id}/cover${version ? `?v=${version}` : ''}`;

/** "2026-09-18" → "18/09/2026" without time-zone surprises. */
/** Who sends images to the event — decided by the server (responsible/admin always; others while
 *  collaboration is open; the hired photographer on its own event; nobody whose access was turned off). */
export const canUploadTo = (e: EventItem) => e.can_upload;
export const isoToBr = (iso: string) => iso.split('-').reverse().join('/');
