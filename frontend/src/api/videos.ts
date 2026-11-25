import { API_URL, accountHeaders, api, followSession } from '@/api/client';
import { sendFile } from '@/components/panel/files';

export type VideoFilter = 'all' | 'in_review' | 'published' | 'discarded' | 'processing' | 'failed' | 'pending_approval' | 'rejected';

export type VideoItem = {
  id: string;
  event_id: string;
  review_status: 'in_review' | 'discarded' | 'published';
  processing_status: 'pending' | 'processing' | 'ready' | 'failed';
  failure: string | null;
  credit: string;
  uploaded_at: string;
  captured_at: string | null;
  size_bytes: number;
  web_bytes: number | null;
  duration_seconds: number;
  width: number;
  height: number;
  video_codec: string;
  audio_codec: string | null;
  source_format: string;
  converted: boolean;
  mine: boolean;
  can_manage: boolean;
  can_download: boolean;
  uploaded_by_name: string;
  approval: 'pending' | 'approved' | 'rejected' | null;
  approved_by_name: string | null;
  rejection_reason: string | null;
  eliminated_at: string | null;
  /** Facial recognition of the published video (RF035, 04/11/2026). */
  indexing_status: 'not_queued' | 'pending' | 'indexing' | 'processed' | 'no_faces' | 'failed';
  face_seconds: number | null;
  /** Different people found in it (only the count, 05/11/2026). */
  face_people: number | null;
  /** A person found in it asked for it to go: deleted at this moment. */
  removal_deadline: string | null;
};

export type VideoList = {
  items: VideoItem[];
  counts: Record<VideoFilter | 'ready', number>;
  can_upload: boolean;
  storage_bytes: number;
  max_bytes: number;
  max_seconds: number;
  available: boolean;
};

export const listVideos = (eventId: string, filter: VideoFilter) => api<VideoList>(`/events/${eventId}/videos?filter=${filter}`);
export const getVideo = (id: string) => api<VideoItem>(`/videos/${id}`);
export const publishVideos = (eventId: string) => api<{ published: number; discarded: number }>(`/events/${eventId}/videos/publish`, { method: 'POST' });
export const discardVideo = (id: string) => api<VideoItem>(`/videos/${id}/discard`, { method: 'POST' });
export const restoreVideo = (id: string) => api<VideoItem>(`/videos/${id}/restore`, { method: 'POST' });
export const retryVideo = (id: string) => api<VideoItem>(`/videos/${id}/retry`, { method: 'POST' });
export const deleteVideo = (id: string) => api<void>(`/videos/${id}`, { method: 'DELETE' });
export const videoDownloadLink = (id: string) => api<{ url: string }>(`/videos/${id}/download-link`, { method: 'POST' });
export const decideVideo = (id: string, approve: boolean, reason?: string) =>
  api<VideoItem>(`/videos/${id}/approval`, { method: 'POST', body: { approve, reason } });
/** One face per person found in the video, cut from it now (05/11/2026): only for whoever manages it, never stored. */
export const videoPeople = (id: string) => api<{ people: { second: number; image: string }[] }>(`/videos/${id}/people`);
export const videoThumbUrl = (id: string) => `${API_URL}/api/v1/videos/${id}/thumb`;
export const videoPlayUrl = (id: string) => `${API_URL}/api/v1/videos/${id}/play`;

export const formatDuration = (seconds: number) => {
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

const REASONS: Record<string, string> = {
  corrupted: 'O vídeo está corrompido e não pôde ser lido.',
  // 05/11/2026: the same video may go to other events, only not twice to the same one.
  duplicate: 'Este vídeo já está neste evento (o mesmo arquivo foi escolhido de novo). Em outro evento ele pode entrar.',
  event_limit: 'O evento atingiu o limite de 1.000 mídias.',
};
const NETWORK = 'Falha de transmissão. Verifique a conexão e tente novamente.';

export type UploadResult = { video: VideoItem; error?: undefined } | { video?: undefined; error: string };

/** With its progress (the browser's XMLHttpRequest, or the phone's upload in the app). The signal stops it (a logout). */
export async function uploadVideo(eventId: string, file: File, onProgress: (percent: number) => void,
                                  signal?: AbortSignal): Promise<UploadResult> {
  const r = await sendFile(`${API_URL}/api/v1/events/${eventId}/videos`, file, accountHeaders(), onProgress, signal);
  if (r.status === -1) return { error: 'Envio interrompido.' };
  if (r.status === 201) {
    try { return { video: JSON.parse(r.body) as VideoItem }; } catch { return { error: NETWORK }; }
  }
  let message = NETWORK;
  try {
    const detail = JSON.parse(r.body).detail;
    if (r.status === 409 && detail?.reason === 'account_changed') followSession();
    message = typeof detail === 'string' ? detail : REASONS[detail?.reason] ?? detail?.message ?? message;
  } catch { /* keep generic */ }
  return { error: message };
}
