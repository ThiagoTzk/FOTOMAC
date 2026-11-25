import { API_URL, api } from '@/api/client';

export type ReviewStatus = 'in_review' | 'discarded' | 'published';
export type IndexingStatus = 'not_queued' | 'pending' | 'processed' | 'no_faces' | 'failed';

export type ImageItem = {
  id: string;
  event_id: string;
  review_status: ReviewStatus;
  indexing_status: IndexingStatus;
  faces_count: number | null;
  credit: string;
  signature: string;
  uploaded_at: string;
  captured_at: string | null;
  size_bytes: number;
  width: number;
  height: number;
  mine: boolean;
  can_manage: boolean;
  removal_deadline: string | null;
  version: string;
  /** Photos of a hired photographer: 'pending' until the administrator approves them. */
  approval: 'pending' | 'approved' | 'rejected' | null;
  /** Rejected by the administrator (22/10/2026): the reason the sender reads, and when it leaves the system. */
  rejection_reason: string | null;
  /** Why the facial indexing failed (or is being retried), in plain words, and what to do. */
  failure?: string | null;
  rejected_at: string | null;
  eliminated_at: string | null;
  uploaded_by_name: string;          // who sent it (accountability)
  approved_by_name: string | null;   // who reviewed and approved it
  approved_at: string | null;
  /** Sent as PNG, WebP, HEIC or RAW: the original is kept beside its JPEG copy. */
  source_format: string | null;
  /** Individual download in the panel, without watermark: author, responsible, admin, marketing. */
  can_download: boolean;
  /** Faces hidden in the file with "Borrar rostos" (04/11/2026). */
  faces_blurred: number;
  /** "Pessoa institucional localizada": only on the single-image route. */
  institutional?: string[];
};

export type ImageCounts = Record<'all' | 'mine' | 'in_review' | 'discarded' | 'published' | 'no_faces' | 'failed' | 'removal' | 'pending_approval' | 'rejected' | 'ready', number>;
/** 'last_batch': the photos of the last "Publicar" (the processing screen). */
export type ImageFilter = keyof ImageCounts | 'last_batch';

export type Processing = {
  total: number; processed: number; pending: number; no_faces: number; failed: number; faces: number;
  percent: number; event_status: string;
  /** The last publication alone (null before the first one). */
  batch: { total: number; pending: number; processed: number; no_faces: number; failed: number; percent: number } | null;
};

export type PackageJob = {
  id: string; status: 'pending' | 'running' | 'ready' | 'failed' | 'expired'; file_name: string;
  image_count: number; size_bytes: number; progress: number; only_own: boolean;
  /** Marketing's package of someone else's event: the JPEG copies, for publicity. */
  publicity: boolean;
};

export type PackageEstimate = { images: number; size_bytes: number; only_own: boolean; publicity: boolean; other_formats: number };

/** What the upload screen accepts right now; RAW depends on the administrator. */
export type UploadRules = {
  formats: string[]; max_photo_bytes: number; raw_enabled: boolean; raw_extensions: string[]; max_raw_bytes: number | null;
  max_video_bytes: number; max_video_seconds: number;
};
/** What the upload screen accepts in THIS event: RAW only where its manager turned it on. */
export const getUploadRules = (eventId: string) => api<UploadRules>(`/events/${eventId}/upload-rules`);

export function listImages(eventId: string, filter: ImageFilter = 'all') {
  const mine = filter === 'mine';
  return api<{ items: ImageItem[]; counts: ImageCounts }>(
    `/events/${eventId}/images?filter=${mine ? 'all' : filter}${mine ? '&mine=true' : ''}`);
}

export const getImage = (id: string) => api<ImageItem>(`/images/${id}`);
/** A link signed for this login session; the JPEG then comes through the API, without watermark. */
export const imageDownloadLink = (id: string) => api<{ url: string }>(`/images/${id}/download-link`, { method: 'POST' });
export const discardImage = (id: string) => api<ImageItem>(`/images/${id}/discard`, { method: 'POST' });
export const restoreImage = (id: string) => api<ImageItem>(`/images/${id}/restore`, { method: 'POST' });
export const deleteImage = (id: string) => api<void>(`/images/${id}`, { method: 'DELETE' });
export const reprocessImage = (id: string) => api<ImageItem>(`/images/${id}/reprocess`, { method: 'POST' });
/** Publishes every image ready for publication, or only `ids` (the ones selected in the Images tab). */
export const publishEvent = (eventId: string, ids?: string[]) =>
  api<{ sent: number; discarded: number; published: number }>(`/events/${eventId}/publish`,
                                                               { method: 'POST', body: ids ? { ids } : undefined });
export const getProcessing = (eventId: string) => api<Processing>(`/events/${eventId}/processing`);

/** Reduced copies for the screens; the original stays in the storage untouched. */
// `v` changes only when the file is replaced, so the browser cache is reused while scrolling.
export const thumbUrl = (id: string, v?: string) => `${API_URL}/api/v1/images/${id}/thumb${v ? `?v=${v}` : ''}`;
/** A face as [x, y, width, height] in pixels of the stored file. */
export type Box = [number, number, number, number];
/** Where the faces are, to choose which to blur: boxes only, no biometric vector. */
export const locateFaces = (id: string) => api<{ width: number; height: number; faces: Box[] }>(`/images/${id}/faces`);
/** Blurs the chosen faces IN THE FILE: the file with the faces is not kept. */
export const blurFaces = (id: string, boxes: Box[]) => api<ImageItem>(`/images/${id}/blur`, { body: { boxes } });
export const previewUrl = (id: string, v?: string) => `${API_URL}/api/v1/images/${id}/preview${v ? `?v=${v}` : ''}`;

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1).replace('.', ',')} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1).replace('.', ',')} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} às ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export const formatDate = (iso: string) => formatDateTime(iso).slice(0, 10);

/** Administrator: approve a hired photographer's photo (it may then be published) or reject it —
 *  a rejected photo is deleted without ever producing a biometric vector. */
export const decideApproval = (id: string, approve: boolean, reason?: string) =>
  api<{ image: ImageItem }>(`/images/${id}/approval`, { body: { approve, reason } });

/** Administrator: approve or reject at once the selected photos of a hired photographer.
 *  Each approved photo keeps who approved it and when. */
export const decideApprovals = (eventId: string, imageIds: string[], approve: boolean, reason?: string) =>
  api<{ decided: number }>(`/events/${eventId}/images/approval`, { body: { image_ids: imageIds, approve, reason } });

/** "Detalhes" of the file, read by the server from the original (the RAW, HEIC… when there is one). */
export type ImageDetails = {
  summary: { label: string; value: string }[];
  groups: { name: string; items: { label: string; value: string }[] }[];
  /** false: the server could not read the file's data now; the summary has only what it already knew. */
  complete: boolean;
};
export const getImageDetails = (id: string, personId?: string) =>
  api<ImageDetails>(personId ? `/institutional/people/${personId}/images/${id}/details` : `/images/${id}/details`);
