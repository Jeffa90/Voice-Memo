/**
 * Voice-Memo REST API. Everything the web app can do goes through here, so a
 * mobile client can do the same later without a backend change (DESIGN §6).
 *
 * Served at /functions/v1/api/*  — verify_jwt is on, so Supabase has already
 * validated the bearer token before we see it.
 */
import { serviceClient, userClient, transition, audit, kickPipeline, AUDIO_BUCKET } from "../_shared/db.ts";
import { renderMarkdown } from "../_shared/markdown.ts";
import { json, problem, cors } from "../_shared/cors.ts";

const svc = serviceClient();
const BASE = "/api";

const ALLOWED_TYPES = new Set([
  "audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/wav", "audio/x-wav",
  "audio/aac", "audio/ogg", "audio/flac", "audio/webm", "video/mp4", "video/quicktime",
]);
const MAX_BYTES = 500 * 1024 * 1024;
const MAX_SECONDS = 3 * 60 * 60;
const MAX_INFLIGHT = Number(Deno.env.get("MAX_INFLIGHT_PER_ORG") ?? 3);
const TERMINAL = ["ready", "deleted", "failed_upload", "failed_audio_qc",
  "failed_quota_exceeded", "failed_transcription", "failed_extraction"];

interface Ctx { userId: string; orgId: string; db: ReturnType<typeof userClient>; req: Request }

const meta = (req: Request) => ({
  ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
  user_agent: req.headers.get("user-agent"),
});

async function remainingSeconds(orgId: string) {
  const period = new Date().toISOString().slice(0, 7);
  const { data: ent } = await svc.from("entitlements")
    .select("audio_seconds_per_period").eq("org_id", orgId).single();
  const { data: rows } = await svc.from("usage_ledger")
    .select("audio_seconds").eq("org_id", orgId).eq("period_ym", period);
  const used = (rows ?? []).reduce((a, r) => a + r.audio_seconds, 0);
  const limit = ent?.audio_seconds_per_period ?? 36000;
  return { used, limit, remaining: Math.max(0, limit - used), period };
}

/** Confirms the recording belongs to the caller's org before anything touches it. */
async function ownRecording(ctx: Ctx, id: string) {
  const { data } = await ctx.db.from("recordings").select("*").eq("id", id).is("deleted_at", null).single();
  return data;
}

async function purgeAudio(storageKey: string | null) {
  if (storageKey) await svc.storage.from(AUDIO_BUCKET).remove([storageKey]);
}

// ---------------------------------------------------------------- routes

type Handler = (ctx: Ctx, params: Record<string, string>, body: any) => Promise<Response>;
const routes: Array<{ method: string; pattern: URLPattern; handler: Handler }> = [];
const route = (method: string, path: string, handler: Handler) =>
  routes.push({ method, pattern: new URLPattern({ pathname: BASE + path }), handler });

route("GET", "/me", async (ctx) => {
  const { data: user } = await ctx.db.from("users").select("*").eq("id", ctx.userId).single();
  const { data: org } = await ctx.db.from("organisations").select("*").eq("id", ctx.orgId).single();
  const { data: ent } = await ctx.db.from("entitlements").select("*").eq("org_id", ctx.orgId).single();
  const { data: consents } = await ctx.db.from("consents").select("type, version, granted_at").eq("user_id", ctx.userId);
  return json({ user, org, entitlement: ent, consents: consents ?? [] });
});

route("PATCH", "/me", async (ctx, _p, body) => {
  const patch: Record<string, unknown> = {};
  if (typeof body.display_name === "string") patch.display_name = body.display_name;
  if (typeof body.state_territory === "string") patch.state_territory = body.state_territory;
  const { data, error } = await ctx.db.from("users").update(patch).eq("id", ctx.userId).select().single();
  if (error) return problem(400, "Could not update profile", error.message);
  return json(data);
});

route("DELETE", "/me", async (ctx) => {
  // Real purge cascade — Apple 5.1.1(v) and APP 11.2 both depend on this.
  const { data: recs } = await svc.from("recordings").select("id, storage_key").eq("org_id", ctx.orgId);
  for (const r of recs ?? []) await purgeAudio(r.storage_key);
  await audit(svc, { org_id: ctx.orgId, actor_user_id: ctx.userId, action: "account.delete", ...meta(ctx.req) });
  await svc.from("organisations").delete().eq("id", ctx.orgId);
  await svc.auth.admin.deleteUser(ctx.userId);
  return json({ deleted: true });
});

route("GET", "/templates", async (ctx) => {
  const { data } = await ctx.db.from("domain_templates")
    .select("key, version, name, description, section_manifest, speaker_roles, disclaimers")
    .eq("is_active", true).order("version", { ascending: false });
  return json({ templates: data ?? [] });
});

route("GET", "/jurisdictions/:state/disclaimer", async (ctx, p) => {
  const { data } = await ctx.db.from("jurisdiction_disclaimers")
    .select("state_code, version, body_markdown, acknowledgement_label")
    .eq("state_code", p.state.toUpperCase()).eq("is_active", true)
    .order("version", { ascending: false }).limit(1).single();
  if (!data) return problem(404, "No disclaimer for that jurisdiction");
  return json(data);
});

route("GET", "/usage", async (ctx) => {
  const u = await remainingSeconds(ctx.orgId);
  const { count } = await svc.from("recordings").select("id", { count: "exact", head: true })
    .eq("org_id", ctx.orgId).not("status", "in", `(${TERMINAL.join(",")})`).is("deleted_at", null);
  return json({
    period_ym: u.period, audio_seconds_used: u.used,
    audio_seconds_limit: u.limit, audio_seconds_remaining: u.remaining,
    in_flight_count: count ?? 0, in_flight_limit: MAX_INFLIGHT,
  });
});

route("POST", "/uploads", async (ctx, _p, body) => {
  const { filename, content_type, byte_size, duration_hint_seconds,
          template_key = "medical_visit", recorded_in_state,
          consent_disclaimer_version, consent_attested, title, recorded_at } = body ?? {};

  if (!ALLOWED_TYPES.has(content_type)) return problem(415, "Unsupported audio format", content_type);
  if (!byte_size || byte_size > MAX_BYTES) return problem(413, "File too large", "Maximum 500 MB");
  if (duration_hint_seconds && duration_hint_seconds > MAX_SECONDS) {
    return problem(413, "Recording too long", "Maximum 3 hours per recording");
  }

  // Recording-consent gate (§4.6). The disclaimer version must be the one
  // currently active for that state — a stale one means the copy changed
  // between page load and submit, and the user must see the new wording.
  if (!recorded_in_state || !consent_attested || !consent_disclaimer_version) {
    return problem(422, "Recording consent required",
      "recorded_in_state, consent_disclaimer_version and consent_attested are all required");
  }
  const { data: disc } = await svc.from("jurisdiction_disclaimers")
    .select("version").eq("state_code", recorded_in_state).eq("is_active", true)
    .order("version", { ascending: false }).limit(1).single();
  if (!disc || disc.version !== consent_disclaimer_version) {
    return problem(422, "Consent wording out of date",
      "Re-fetch the disclaimer for this state and confirm the current wording");
  }

  const { count } = await svc.from("recordings").select("id", { count: "exact", head: true })
    .eq("org_id", ctx.orgId).not("status", "in", `(${TERMINAL.join(",")})`).is("deleted_at", null);
  if ((count ?? 0) >= MAX_INFLIGHT) {
    return problem(429, "Too many recordings in progress", `Wait for one of your ${MAX_INFLIGHT} to finish`);
  }

  // Soft quota check against the client's hint. The real gate runs server-side
  // once the provider reports the true duration.
  const u = await remainingSeconds(ctx.orgId);
  if (duration_hint_seconds && duration_hint_seconds > u.remaining) {
    return problem(402, "Monthly allowance exceeded",
      `${Math.round(u.remaining / 60)} minutes left this month of ${Math.round(u.limit / 60)}`);
  }

  const ext = (filename?.split(".").pop() ?? "bin").toLowerCase().slice(0, 5);
  const { data: rec, error } = await ctx.db.from("recordings").insert({
    org_id: ctx.orgId, owner_user_id: ctx.userId,
    title: title ?? filename ?? "Appointment", domain_template_key: template_key,
    status: "uploading", content_type, byte_size, storage_bucket: AUDIO_BUCKET,
    recorded_at: recorded_at ?? null,
    recorded_in_state, consent_disclaimer_state: recorded_in_state,
    consent_disclaimer_version, consent_attested_at: new Date().toISOString(),
  }).select().single();
  if (error) return problem(400, "Could not create recording", error.message);

  const key = `${ctx.orgId}/${rec.id}.${ext}`;
  const { data: signed, error: sErr } = await svc.storage.from(AUDIO_BUCKET).createSignedUploadUrl(key);
  if (sErr) return problem(500, "Could not create upload URL", sErr.message);

  await ctx.db.from("recordings").update({ storage_key: key }).eq("id", rec.id);
  await audit(svc, { org_id: ctx.orgId, actor_user_id: ctx.userId, action: "recording.create",
    resource_type: "recording", resource_id: rec.id, ...meta(ctx.req) });

  return json({ recording_id: rec.id, storage_path: key, upload_token: signed.token, bucket: AUDIO_BUCKET }, 201);
});

route("POST", "/recordings/:id/complete", async (ctx, p) => {
  const rec = await ownRecording(ctx, p.id);
  if (!rec) return problem(404, "Recording not found");

  const { data: obj } = await svc.storage.from(AUDIO_BUCKET)
    .list(ctx.orgId, { search: rec.storage_key?.split("/").pop() });
  if (!obj?.length) return problem(409, "Audio not uploaded", "No stored object for this recording");

  await transition(svc, rec.id, "queued", { byte_size: obj[0].metadata?.size });
  kickPipeline(rec.id, "transcribe");
  return json({ status: "queued" }, 202);
});

route("GET", "/recordings", async (ctx, _p, _b) => {
  const { data } = await ctx.db.from("recordings")
    .select("id, title, status, failure_reason, duration_ms, domain_template_key, created_at, recorded_at, audio_deleted_at")
    .is("deleted_at", null).order("created_at", { ascending: false }).limit(100);
  return json({ recordings: data ?? [] });
});

route("GET", "/recordings/:id", async (ctx, p) => {
  const rec = await ownRecording(ctx, p.id);
  if (!rec) return problem(404, "Recording not found");
  const { data: out } = await ctx.db.from("outputs").select("id")
    .eq("recording_id", rec.id).is("superseded_by", null)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  const { data: tr } = await ctx.db.from("transcripts").select("id").eq("recording_id", rec.id).maybeSingle();
  let speakersConfirmed = false;
  if (tr) {
    const { count } = await ctx.db.from("speakers").select("id", { count: "exact", head: true })
      .eq("transcript_id", tr.id).is("confirmed_at", null);
    speakersConfirmed = (count ?? 0) === 0;
  }
  return json({ ...rec, latest_output_id: out?.id ?? null, has_transcript: !!tr, speakers_confirmed: speakersConfirmed });
});

route("PATCH", "/recordings/:id", async (ctx, p, body) => {
  const rec = await ownRecording(ctx, p.id);
  if (!rec) return problem(404, "Recording not found");
  const patch: Record<string, unknown> = {};
  if (typeof body.title === "string") patch.title = body.title;
  const { data } = await ctx.db.from("recordings").update(patch).eq("id", rec.id).select().single();
  return json(data);
});

route("DELETE", "/recordings/:id", async (ctx, p) => {
  const rec = await ownRecording(ctx, p.id);
  if (!rec) return problem(404, "Recording not found");
  await purgeAudio(rec.storage_key);
  await audit(svc, { org_id: ctx.orgId, actor_user_id: ctx.userId, action: "recording.delete",
    resource_type: "recording", resource_id: rec.id, ...meta(ctx.req) });
  // usage_ledger is deliberately untouched: deleting cannot reclaim quota.
  await svc.from("recordings").delete().eq("id", rec.id);
  return json({ deleted: true });
});

route("GET", "/recordings/:id/transcript", async (ctx, p) => {
  const rec = await ownRecording(ctx, p.id);
  if (!rec) return problem(404, "Recording not found");
  const { data: tr } = await ctx.db.from("transcripts").select("id, language_code, provider").eq("recording_id", rec.id).maybeSingle();
  if (!tr) return problem(404, "No transcript yet");
  const { data: segs } = await ctx.db.from("transcript_segments")
    .select("idx, speaker_key, start_ms, end_ms, text, confidence").eq("transcript_id", tr.id).order("idx");
  const { data: spk } = await ctx.db.from("speakers").select("*").eq("transcript_id", tr.id).order("speaker_key");
  await audit(svc, { org_id: ctx.orgId, actor_user_id: ctx.userId, action: "transcript.read",
    resource_type: "recording", resource_id: rec.id, ...meta(ctx.req) });
  return json({ transcript: tr, segments: segs ?? [], speakers: spk ?? [] });
});

route("GET", "/recordings/:id/speakers", async (ctx, p) => {
  const rec = await ownRecording(ctx, p.id);
  if (!rec) return problem(404, "Recording not found");
  const { data: tr } = await ctx.db.from("transcripts").select("id").eq("recording_id", rec.id).maybeSingle();
  if (!tr) return problem(404, "No transcript yet");
  const { data: spk } = await ctx.db.from("speakers").select("*").eq("transcript_id", tr.id).order("speaker_key");
  const { data: segs } = await ctx.db.from("transcript_segments")
    .select("speaker_key, text, idx").eq("transcript_id", tr.id).order("idx").limit(200);
  // First thing each speaker says — the UI shows it so a human can tell who's who.
  const sample: Record<string, string> = {};
  for (const s of segs ?? []) if (!sample[s.speaker_key]) sample[s.speaker_key] = s.text;
  return json({ speakers: (spk ?? []).map((s) => ({ ...s, first_utterance: sample[s.speaker_key] ?? null })) });
});

route("PATCH", "/recordings/:id/speakers", async (ctx, p, body) => {
  const rec = await ownRecording(ctx, p.id);
  if (!rec) return problem(404, "Recording not found");
  const { data: tr } = await ctx.db.from("transcripts").select("id").eq("recording_id", rec.id).maybeSingle();
  if (!tr) return problem(404, "No transcript yet");
  if (!Array.isArray(body?.speakers)) return problem(400, "Expected { speakers: [...] }");

  for (const s of body.speakers) {
    await ctx.db.from("speakers").update({
      display_label: s.display_label, role: s.role,
      confirmed_by_user_id: ctx.userId, confirmed_at: new Date().toISOString(),
    }).eq("transcript_id", tr.id).eq("speaker_key", s.speaker_key);
  }
  // Confirmed names materially improve extraction, so regenerate.
  await transition(svc, rec.id, "summarising", { reason: "speakers confirmed" });
  kickPipeline(rec.id, "extract");
  return json({ updated: body.speakers.length, regenerating: true }, 202);
});

route("POST", "/recordings/:id/outputs", async (ctx, p) => {
  const rec = await ownRecording(ctx, p.id);
  if (!rec) return problem(404, "Recording not found");
  if (!["ready", "failed_extraction", "awaiting_speaker_confirmation"].includes(rec.status)) {
    return problem(409, "Not ready to regenerate", `Recording is ${rec.status}`);
  }
  await transition(svc, rec.id, "summarising", { reason: "manual regenerate" });
  kickPipeline(rec.id, "extract");
  return json({ regenerating: true }, 202);
});

route("GET", "/recordings/:id/outputs", async (ctx, p) => {
  const rec = await ownRecording(ctx, p.id);
  if (!rec) return problem(404, "Recording not found");
  const { data } = await ctx.db.from("outputs")
    .select("id, template_key, template_version, model, validation_status, created_at, superseded_by")
    .eq("recording_id", rec.id).order("created_at", { ascending: false });
  return json({ outputs: data ?? [] });
});

route("GET", "/outputs/:id", async (ctx, p) => {
  const { data: out } = await ctx.db.from("outputs").select("*").eq("id", p.id).single();
  if (!out) return problem(404, "Output not found");
  const { data: items } = await ctx.db.from("action_items").select("*").eq("output_id", out.id).order("idx");
  await audit(svc, { org_id: ctx.orgId, actor_user_id: ctx.userId, action: "output.read",
    resource_type: "output", resource_id: out.id, ...meta(ctx.req) });
  return json({ ...out, action_items: items ?? [] });
});

route("PATCH", "/outputs/:id/action-items/:aid", async (ctx, p, body) => {
  const patch: Record<string, unknown> = {};
  if (typeof body.completed === "boolean") patch.completed_at = body.completed ? new Date().toISOString() : null;
  if (typeof body.edited_text === "string") patch.edited_text = body.edited_text;
  const { data, error } = await ctx.db.from("action_items").update(patch)
    .eq("id", p.aid).eq("output_id", p.id).select().single();
  if (error) return problem(400, "Could not update action item", error.message);
  return json(data);
});

route("GET", "/outputs/:id/export", async (ctx, p) => {
  const { data: out } = await ctx.db.from("outputs").select("*, recordings(title, recorded_at)").eq("id", p.id).single();
  if (!out) return problem(404, "Output not found");
  await audit(svc, { org_id: ctx.orgId, actor_user_id: ctx.userId, action: "output.export",
    resource_type: "output", resource_id: out.id, ...meta(ctx.req) });
  const md = out.content_markdown ?? renderMarkdown(
    (out as any).recordings?.title ?? "Appointment summary",
    out.content, out.content?.disclaimers ?? [], (out as any).recordings?.recorded_at);
  return new Response(md, {
    headers: { ...cors, "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="summary.md"` },
  });
});

// ---------------------------------------------------------------- dispatch

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const auth = req.headers.get("Authorization");
  if (!auth) return problem(401, "Missing bearer token");

  const db = userClient(auth);
  const { data: { user }, error: uErr } = await db.auth.getUser();
  if (uErr || !user) return problem(401, "Invalid or expired token");

  const { data: m } = await db.from("memberships").select("org_id").eq("user_id", user.id).limit(1).maybeSingle();
  if (!m) return problem(403, "No organisation for this account");

  const ctx: Ctx = { userId: user.id, orgId: m.org_id, db, req };
  const url = new URL(req.url);

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const match = r.pattern.exec({ pathname: url.pathname });
    if (!match) continue;
    let body: any = undefined;
    if (["POST", "PATCH", "PUT"].includes(req.method)) {
      try { body = await req.json(); } catch { body = {}; }
    }
    try {
      return await r.handler(ctx, match.pathname.groups as Record<string, string>, body);
    } catch (e) {
      console.error(`${req.method} ${url.pathname} failed`, e);
      return problem(500, "Request failed", String((e as Error)?.message ?? e));
    }
  }
  return problem(404, "No such endpoint", `${req.method} ${url.pathname}`);
});
