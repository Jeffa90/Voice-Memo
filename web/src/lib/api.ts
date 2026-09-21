import { supabase, API } from "./supabase";

async function authHeaders() {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Not signed in");
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, { ...init, headers: { ...(await authHeaders()), ...init.headers } });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const p = await res.json();
      detail = p.detail ?? p.title ?? detail;
    } catch { /* non-JSON error body */ }
    const err = new Error(detail) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

// ---------------------------------------------------------------- types

export type Status =
  | "created" | "uploading" | "uploaded" | "queued" | "transcribing" | "transcribed"
  | "suggesting_speakers" | "awaiting_speaker_confirmation" | "summarising" | "ready"
  | "failed_upload" | "failed_audio_qc" | "failed_quota_exceeded"
  | "failed_transcription" | "failed_extraction" | "deleted";

export const TERMINAL: Status[] = [
  "ready", "deleted", "failed_upload", "failed_audio_qc",
  "failed_quota_exceeded", "failed_transcription", "failed_extraction",
];

export interface Recording {
  id: string; title: string | null; status: Status; failure_reason: string | null;
  duration_ms: number | null; created_at: string; recorded_at: string | null;
  audio_deleted_at: string | null; latest_output_id?: string | null;
  has_transcript?: boolean; speakers_confirmed?: boolean;
}

export interface Segment {
  idx: number; speaker_key: string; start_ms: number; end_ms: number;
  text: string; confidence: number | null;
}

export interface Speaker {
  id: string; speaker_key: string;
  suggested_label: string | null; suggested_role: string | null; suggested_confidence: number | null;
  display_label: string | null; role: string | null; confirmed_at: string | null;
  first_utterance?: string | null;
}

export interface ActionItem {
  id: string; idx: number; text: string; owner_hint: string | null;
  due_hint: string | null; segment_refs: number[];
  completed_at: string | null; edited_text: string | null;
}

export interface Output {
  id: string; recording_id: string; model: string; validation_status: string;
  created_at: string; content: any; content_markdown: string | null;
  dropped_items: any; action_items: ActionItem[];
}

export interface Usage {
  period_ym: string; audio_seconds_used: number; audio_seconds_limit: number;
  audio_seconds_remaining: number; in_flight_count: number; in_flight_limit: number;
}

export interface Disclaimer {
  state_code: string; version: number; body_markdown: string; acknowledgement_label: string;
}

// ---------------------------------------------------------------- calls

export const api = {
  me: () => call<any>("/me"),
  updateMe: (patch: { display_name?: string; state_territory?: string }) =>
    call<any>("/me", { method: "PATCH", body: JSON.stringify(patch) }),
  deleteMe: () => call<any>("/me", { method: "DELETE" }),

  usage: () => call<Usage>("/usage"),
  disclaimer: (state: string) => call<Disclaimer>(`/jurisdictions/${state}/disclaimer`),

  recordings: () => call<{ recordings: Recording[] }>("/recordings"),
  recording: (id: string) => call<Recording>(`/recordings/${id}`),
  renameRecording: (id: string, title: string) =>
    call<Recording>(`/recordings/${id}`, { method: "PATCH", body: JSON.stringify({ title }) }),
  deleteRecording: (id: string) => call<any>(`/recordings/${id}`, { method: "DELETE" }),

  createUpload: (body: Record<string, unknown>) =>
    call<{ recording_id: string; storage_path: string; upload_token: string; bucket: string }>(
      "/uploads", { method: "POST", body: JSON.stringify(body) }),
  completeUpload: (id: string) =>
    call<any>(`/recordings/${id}/complete`, { method: "POST", body: "{}" }),

  transcript: (id: string) =>
    call<{ segments: Segment[]; speakers: Speaker[] }>(`/recordings/${id}/transcript`),
  speakers: (id: string) => call<{ speakers: Speaker[] }>(`/recordings/${id}/speakers`),
  saveSpeakers: (id: string, speakers: Array<{ speaker_key: string; display_label: string; role: string }>) =>
    call<any>(`/recordings/${id}/speakers`, { method: "PATCH", body: JSON.stringify({ speakers }) }),

  output: (id: string) => call<Output>(`/outputs/${id}`),
  regenerate: (id: string) => call<any>(`/recordings/${id}/outputs`, { method: "POST", body: "{}" }),
  toggleActionItem: (outputId: string, itemId: string, completed: boolean) =>
    call<ActionItem>(`/outputs/${outputId}/action-items/${itemId}`, {
      method: "PATCH", body: JSON.stringify({ completed }),
    }),
  exportUrl: (outputId: string) => `${API}/outputs/${outputId}/export`,
};

/** Uploads straight to storage — audio never passes through the API. */
export async function uploadToStorage(bucket: string, path: string, token: string, file: File) {
  const { error } = await supabase.storage.from(bucket).uploadToSignedUrl(path, token, file);
  if (error) throw error;
}

/** Reads duration in the browser. A hint only — the server books real usage itself. */
export function probeDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement("audio");
    const done = (v: number | null) => { URL.revokeObjectURL(url); resolve(v); };
    el.preload = "metadata";
    el.onloadedmetadata = () => done(Number.isFinite(el.duration) ? Math.round(el.duration) : null);
    el.onerror = () => done(null);
    el.src = url;
    setTimeout(() => done(null), 8000);
  });
}

export const STATUS_LABEL: Record<Status, string> = {
  created: "Starting", uploading: "Uploading", uploaded: "Uploaded", queued: "Queued",
  transcribing: "Transcribing", transcribed: "Transcribed",
  suggesting_speakers: "Working out who's who", awaiting_speaker_confirmation: "Check the speakers",
  summarising: "Writing your summary", ready: "Ready", deleted: "Deleted",
  failed_upload: "Upload failed", failed_audio_qc: "Audio unusable",
  failed_quota_exceeded: "Monthly limit reached", failed_transcription: "Transcription failed",
  failed_extraction: "Summary failed",
};

export const fmtDuration = (ms: number | null) => {
  if (!ms) return "";
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`;
};

export const fmtTime = (ms: number) =>
  `${Math.floor(ms / 60000)}:${Math.floor((ms % 60000) / 1000).toString().padStart(2, "0")}`;
