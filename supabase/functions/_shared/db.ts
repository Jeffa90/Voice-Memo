import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

export const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
export const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
export const AUDIO_BUCKET = "vm-audio-au";

/** Bypasses RLS. Worker and admin paths only — never a request handler. */
export const serviceClient = (): SupabaseClient =>
  createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

/** Carries the caller's JWT, so RLS applies to every query. */
export const userClient = (authHeader: string): SupabaseClient =>
  createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

export async function transition(
  db: SupabaseClient,
  recordingId: string,
  to: string,
  detail?: unknown,
) {
  const { data: prev } = await db.from("recordings").select("status").eq("id", recordingId).single();
  await db.from("recordings").update({ status: to, ...(to.startsWith("failed_") ? { failure_reason: String((detail as any)?.error ?? detail ?? "") } : {}) }).eq("id", recordingId);
  await db.from("recording_events").insert({
    recording_id: recordingId,
    from_status: prev?.status ?? null,
    to_status: to,
    detail: detail ? JSON.parse(JSON.stringify(detail)) : null,
  });
}

export async function audit(db: SupabaseClient, row: {
  org_id?: string | null; actor_user_id?: string | null;
  actor_kind?: "user" | "worker" | "admin" | "system";
  action: string; resource_type?: string; resource_id?: string;
  ip?: string | null; user_agent?: string | null;
}) {
  await db.from("audit_log").insert({ actor_kind: "user", ...row });
}

/** Fire-and-forget invoke of the pipeline worker. */
export function kickPipeline(recordingId: string, step: string) {
  const p = fetch(`${SUPABASE_URL}/functions/v1/process`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ recordingId, step }),
  }).catch((e) => console.error("pipeline kick failed", step, recordingId, e));
  // @ts-ignore EdgeRuntime is provided by the Supabase edge runtime
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(p);
  return p;
}
