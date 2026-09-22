/**
 * Pipeline worker. Not called by browsers — invoked with the service role key by
 * the api function and by the AssemblyAI webhook.
 *
 *   transcribe      → submit audio to the provider (or, for the stub, produce it inline)
 *   post_transcript → suggest speakers, then extract
 *   extract         → re-run extraction only (used after a speaker relabel)
 */
import { serviceClient, transition, AUDIO_BUCKET, SUPABASE_URL, SERVICE_KEY } from "../_shared/db.ts";
import { getProvider, MEDICAL_KEYTERMS, type NormalisedTranscript } from "../_shared/providers.ts";
import { suggestSpeakers, extract } from "../_shared/anthropic.ts";
import { validateGrounding } from "../_shared/grounding.ts";
import { renderMarkdown } from "../_shared/markdown.ts";
import { json, problem, cors } from "../_shared/cors.ts";

const db = serviceClient();

async function storeTranscript(recordingId: string, provider: string, jobId: string, t: NormalisedTranscript) {
  await db.from("transcripts").delete().eq("recording_id", recordingId);
  const { data: tr, error } = await db.from("transcripts").insert({
    recording_id: recordingId, provider, provider_job_id: jobId,
    language_code: t.languageCode, provider_raw: t.providerRaw,
  }).select("id").single();
  if (error) throw error;

  await db.from("transcript_segments").insert(
    t.segments.map((s) => ({
      transcript_id: tr.id, idx: s.index, speaker_key: s.speakerKey,
      start_ms: s.startMs, end_ms: s.endMs, text: s.text, confidence: s.confidence,
    })),
  );
  await db.from("speakers").insert(
    [...new Set(t.segments.map((s) => s.speakerKey))].map((k) => ({ transcript_id: tr.id, speaker_key: k })),
  );

  // Reconcile the real duration and book it against the org's allowance. This is
  // the point where usage becomes a fact rather than a client-supplied hint.
  const { data: rec } = await db.from("recordings").select("org_id, duration_ms").eq("id", recordingId).single();
  await db.from("recordings").update({ duration_ms: t.durationMs }).eq("id", recordingId);
  if (rec && !rec.duration_ms) {
    await db.from("usage_ledger").insert({
      org_id: rec.org_id, recording_id: recordingId,
      period_ym: new Date().toISOString().slice(0, 7),
      audio_seconds: Math.round(t.durationMs / 1000),
    });
  }
  return tr.id as string;
}

async function loadSegments(recordingId: string) {
  const { data: tr } = await db.from("transcripts").select("id").eq("recording_id", recordingId).single();
  if (!tr) throw new Error("no transcript");
  const { data: segs } = await db.from("transcript_segments")
    .select("idx, speaker_key, start_ms, end_ms, text, confidence")
    .eq("transcript_id", tr.id).order("idx");
  return {
    transcriptId: tr.id as string,
    segments: (segs ?? []).map((s) => ({
      index: s.idx, speakerKey: s.speaker_key, startMs: s.start_ms,
      endMs: s.end_ms, text: s.text, confidence: s.confidence,
    })),
  };
}

// ---------------------------------------------------------------- steps

async function runTranscribe(recordingId: string) {
  const { data: rec } = await db.from("recordings")
    .select("id, storage_key, org_id, domain_template_key").eq("id", recordingId).single();
  if (!rec?.storage_key) throw new Error("recording has no stored audio");

  await transition(db, recordingId, "transcribing");
  const provider = getProvider();

  // Short-lived signed URL. The provider fetches the audio directly; it is never
  // proxied through us, and the link dies in 15 minutes (§4.3).
  const { data: signed, error: sErr } = await db.storage.from(AUDIO_BUCKET)
    .createSignedUrl(rec.storage_key, 900);
  if (sErr) throw sErr;

  const { providerJobId, inline } = await provider.submit({
    audioUrl: signed.signedUrl,
    webhookUrl: `${SUPABASE_URL}/functions/v1/process`,
    keyterms: MEDICAL_KEYTERMS,
  });

  if (inline) {
    await storeTranscript(recordingId, provider.name, providerJobId, inline);
    await transition(db, recordingId, "transcribed", { provider: provider.name, inline: true });
    return runPostTranscript(recordingId);
  }
  // Async provider: park here. The webhook resumes the chain.
  await db.from("transcripts").upsert(
    { recording_id: recordingId, provider: provider.name, provider_job_id: providerJobId },
    { onConflict: "recording_id" },
  );
}

async function runPostTranscript(recordingId: string) {
  await transition(db, recordingId, "suggesting_speakers");
  const { transcriptId, segments } = await loadSegments(recordingId);

  const { data: rec } = await db.from("recordings").select("domain_template_key").eq("id", recordingId).single();
  const { data: tpl } = await db.from("domain_templates")
    .select("speaker_roles").eq("key", rec!.domain_template_key).eq("is_active", true)
    .order("version", { ascending: false }).limit(1).single();

  try {
    const suggestions = await suggestSpeakers(segments, tpl?.speaker_roles ?? ["clinician", "patient", "other"]);
    for (const s of suggestions) {
      await db.from("speakers").update({
        suggested_label: s.suggested_label,
        suggested_role: s.suggested_role,
        suggested_confidence: s.confidence,
      }).eq("transcript_id", transcriptId).eq("speaker_key", s.speaker_key);
    }
  } catch (e) {
    // A weak suggestion must never block the summary — the user can relabel by hand.
    console.error("speaker suggestion failed, continuing", e);
  }

  await transition(db, recordingId, "awaiting_speaker_confirmation");
  return runExtract(recordingId);
}

async function runExtract(recordingId: string) {
  await transition(db, recordingId, "summarising");
  const { transcriptId, segments } = await loadSegments(recordingId);
  if (!segments.length) throw new Error("transcript has no segments");

  const { data: rec } = await db.from("recordings")
    .select("domain_template_key, title, recorded_at").eq("id", recordingId).single();
  const { data: tpl } = await db.from("domain_templates")
    .select("*").eq("key", rec!.domain_template_key).eq("is_active", true)
    .order("version", { ascending: false }).limit(1).single();
  if (!tpl) throw new Error(`no active template ${rec!.domain_template_key}`);

  const { data: spk } = await db.from("speakers")
    .select("speaker_key, display_label, suggested_label").eq("transcript_id", transcriptId);
  const labels = Object.fromEntries(
    (spk ?? []).map((s) => [s.speaker_key, s.display_label ?? s.suggested_label ?? `Speaker ${s.speaker_key}`]),
  );

  const result = await extract(
    tpl.system_prompt, tpl.output_schema, tpl.section_manifest, segments, labels,
  );

  const maxIdx = Math.max(...segments.map((s) => s.index));
  const { content, dropped, status } = validateGrounding(result.content, maxIdx);
  if (status === "failed") throw new Error("extraction produced no usable summary");

  const envelope = { envelope_version: 1, ...content, disclaimers: tpl.disclaimers ?? [] };
  const markdown = renderMarkdown(rec!.title ?? "Appointment summary", envelope, tpl.disclaimers ?? [], rec!.recorded_at);

  const { data: out, error } = await db.from("outputs").insert({
    recording_id: recordingId, template_key: tpl.key, template_version: tpl.version,
    model: result.model, content: envelope, content_markdown: markdown,
    validation_status: status, dropped_items: dropped.length ? dropped : null,
    input_tokens: result.usage.input, output_tokens: result.usage.output,
    cache_read_tokens: result.usage.cacheRead,
  }).select("id").single();
  if (error) throw error;

  if (envelope.action_items?.length) {
    await db.from("action_items").insert(
      envelope.action_items.map((a: any, idx: number) => ({
        output_id: out.id, idx, text: a.text,
        owner_hint: a.owner_hint ?? null, due_hint: a.due_hint ?? null,
        segment_refs: a.segment_refs ?? [],
      })),
    );
  }

  // Supersede every earlier output for this recording.
  await db.from("outputs").update({ superseded_by: out.id })
    .eq("recording_id", recordingId).neq("id", out.id).is("superseded_by", null);

  const days = 7;
  await db.from("recordings").update({
    audio_delete_at: new Date(Date.now() + days * 86400_000).toISOString(),
  }).eq("id", recordingId);

  await transition(db, recordingId, "ready", {
    output_id: out.id, validation_status: status, dropped: dropped.length,
    cache_read_tokens: result.usage.cacheRead,
  });
}

const STEPS: Record<string, (id: string) => Promise<unknown>> = {
  transcribe: runTranscribe,
  post_transcript: runPostTranscript,
  extract: runExtract,
};

const FAIL_STATE: Record<string, string> = {
  transcribe: "failed_transcription",
  post_transcript: "failed_extraction",
  extract: "failed_extraction",
};

async function handleWebhook(body: any) {
  const jobId = body.transcript_id ?? body.id;
  if (!jobId) return problem(400, "Missing transcript_id");

  const { data: tr } = await db.from("transcripts").select("recording_id").eq("provider_job_id", jobId).single();
  if (!tr) return json({ ok: true, ignored: "unknown job" });   // 200 so they stop retrying
  const recordingId = tr.recording_id as string;

  // Replay guard: a duplicate or out-of-order delivery must not reprocess.
  const { data: rec } = await db.from("recordings").select("status").eq("id", recordingId).single();
  if (rec && !["transcribing", "queued", "uploaded"].includes(rec.status)) {
    return json({ ok: true, ignored: "already processed", status: rec.status });
  }

  if (body.status === "error") {
    await transition(db, recordingId, "failed_transcription", { error: body.error ?? "provider reported error" });
    return json({ ok: true });
  }

  const work = (async () => {
    try {
      const provider = getProvider();
      const t = await provider.fetchResult(jobId);
      await storeTranscript(recordingId, provider.name, jobId, t);
      await transition(db, recordingId, "transcribed", { provider: provider.name, segments: t.segments.length });
      await runPostTranscript(recordingId);
    } catch (e) {
      console.error("webhook processing failed", recordingId, e);
      await transition(db, recordingId, "failed_transcription", { error: String((e as Error)?.message ?? e) });
    }
  })();
  // @ts-ignore edge runtime global
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(work); else await work;
  return json({ ok: true });
}

/**
 * verify_jwt is off (the provider has no user JWT), so both entry points
 * authenticate themselves: the provider by shared secret header, the api
 * function by presenting the service role key.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  let body: any;
  try { body = await req.json(); } catch { return problem(400, "Malformed body"); }

  const webhookSecret = Deno.env.get("ASSEMBLYAI_WEBHOOK_SECRET");
  const presented = req.headers.get("x-vm-webhook-secret");
  if (presented) {
    if (!webhookSecret || presented !== webhookSecret) {
      console.error("webhook rejected: bad secret");
      return problem(401, "Unauthorised");
    }
    return handleWebhook(body);
  }

  const auth = req.headers.get("Authorization") ?? "";
  if (auth !== `Bearer ${SERVICE_KEY}`) return problem(401, "Unauthorised");

  const { recordingId, step } = body ?? {};
  const fn = STEPS[step];
  if (!fn) return problem(400, "Unknown step", String(step));

  const work = fn(recordingId).catch(async (e: any) => {
    console.error(`pipeline ${step} failed for ${recordingId}`, e);
    await transition(db, recordingId, FAIL_STATE[step] ?? "failed_extraction", { error: String(e?.message ?? e) });
  });
  // @ts-ignore edge runtime global
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(work); else await work;

  return json({ accepted: true, step, recordingId }, 202);
});
