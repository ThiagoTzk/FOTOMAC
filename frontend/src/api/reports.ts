/** Registros (RF024, RNF14): the administrator's summary of a period and the export of the records. */
import { API_URL, api } from './client';

export type AtypicalAlert = {
  at: string; kind: 'searches' | 'liveness'; label: string; count: number; minutes: number; event: string | null;
};
export type ReportSummary = {
  start: string; end: string;
  operations: number;
  public: { searches: number; found: number; no_result: number; liveness_refused: number; other_refused: number; downloads: number };
  consents: number;
  institutional_queries: number;
  authorizations: { authorized: number; revoked: number };
  publicity_downloads: number;
  alerts: AtypicalAlert[];
  alerts_total: number;
};
export type ReportPeriod = { start: string | null; end: string | null };

const query = (p: ReportPeriod) =>
  new URLSearchParams(Object.entries(p).filter(([, v]) => v) as [string, string][]).toString();

export const reportSummary = (p: ReportPeriod) => api<ReportSummary>(`/admin/reports/summary?${query(p)}`);
/** The ZIP (a CSV per kind of record + LEIA-ME); saved by the browser with the session cookie, like the signed term. */
export const reportExportUrl = (p: ReportPeriod) => `${API_URL}/api/v1/admin/reports/export.zip?${query(p)}`;
