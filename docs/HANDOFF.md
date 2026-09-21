# Build Handoff Brief — Voice-Memo

**Read this first. You have no prior context on this project and don't need any.**
Full reasoning and trade-off analysis is in [`docs/DESIGN.md`](./DESIGN.md) — read it before writing code, but this brief is the build spec. Where they disagree, DESIGN.md wins.

---

## What you are building

A web app that turns a recorded conversation into structured text. A patient (or their carer) uploads an audio recording of a medical consultation and gets back a plain-language summary, key points, action items, and a speaker-labelled transcript.

Under the hood **nothing is medical**. The pipeline is `upload → transcribe → diarize → relabel speakers → extract → render → export`, and "medical" is one row in a `domain_templates` table. Meetings, lectures and personal voice notes are future rows running the same code. Build the abstraction; populate only the medical row.

**A mobile app comes later.** Every capability must go through the REST API. Nothing the web app can do may live outside `/v1`.

---

## Decisions already made — do not relitigate these

| Area | Decision |
|---|---|
| Backend | TypeScript, **Fastify**, Node 22 LTS. OpenAPI generated from Zod schemas. |
| Frontend | **Vite + React + TanStack Router + TanStack Query**. A plain SPA. *Not Next.js* — the SPA constraint is deliberate, it forces everything through the API for the future mobile client. |
| Database / Auth / Storage | **Supabase, `ap-southeast-2` (Sydney)**. Postgres + Auth + Storage. RLS enabled everywhere. |
| Queue | **pg-boss** on the same Postgres. Worker is a separate deployable. Job payloads carry **IDs only, never transcript content**. |
| Transcription | **AssemblyAI** Universal-2 + speaker diarization, async, webhook callback. Behind a `TranscriptionProvider` interface. |
| LLM | **Anthropic API.** `claude-sonnet-5` for extraction, `claude-haiku-4-5` for speaker-label suggestions and audio triage. |
| Job status → UI | **Polling** `GET /v1/recordings/{id}`, 2s → 5s → 15s backoff. Not WebSockets. |
| Hosting | **Fly.io `syd`** (API + worker as separate process groups), **Cloudflare Pages** (SPA). |
| Payments | **Stripe** (AUD) writing into an `entitlements` table. The app never asks Stripe anything at request time. |
| Languages | **English only** (incl. Australian accents). Reject non-English uploads with a clear message. |
| Live recording | **Out of scope.** Phase 3. Do not design around it. |

---

## Five rules that are not negotiable

These exist for legal and safety reasons. Breaking any of them is a defect, not a style preference.

**1. Grounding.** Every `key_point`, `action_item` and `section` in an LLM output must carry `segment_refs: number[]` — indices into `transcript_segments.idx`. After generation a deterministic validator drops any item with empty or out-of-range refs and marks the output `partially_validated`. This is the anti-hallucination control *and* the feature that lets the UI jump from a claim to the moment it was said.

**2. Scope.** The product reports what was said, in plainer language. It never adds clinical advice, never interprets results the clinician didn't interpret, never suggests actions nobody stated, never speculates about diagnosis. Enforced in the system prompt, in the grounding validator, and by a non-dismissible `disclaimers[]` block rendered on screen, in PDF, and in any export. Crossing this line makes the software a regulated medical device.

**3. Residency.** Everything at rest lives in Sydney. Exactly two things cross the border: audio to AssemblyAI and transcript text to the Anthropic API. Both are consented and contracted. **No other third party may receive audio, transcript or summary content** — that specifically includes error tracking and observability vendors, so scrub PII from breadcrumbs and send IDs, not content.

**4. Audio is transient.** Raw audio is deleted 7 days after successful processing by a scheduled purge job. This is a legal requirement (destroy when no longer needed), not a cost optimisation. No public buckets ever — add a CI test that asserts it. Signed URLs expire in ≤15 minutes.

**5. The AI never silently commits a speaker identity.** Haiku suggests labels; they render as visibly unconfirmed until a human confirms. Attributing "stop taking the warfarin" to the wrong person is a serious error.

---

## Build order

Work top to bottom. Each step should leave the app in a working state.

### 0. Scaffold
Monorepo (pnpm workspaces):
```
/apps/api      Fastify, /v1, OpenAPI from Zod
/apps/worker   pg-boss consumers
/apps/web      Vite + React SPA
/packages/shared     Zod schemas, output envelope, status enums, generated client types
/packages/providers  TranscriptionProvider impls
/packages/templates  domain templates: prompt + JSON schema + section manifest
/evals               golden sets + grader
/infra               migrations, fly.toml, GH Actions
```
CI: typecheck, lint, unit, integration against ephemeral Postgres, **public-bucket assertion**.

### 1. Data model + auth
Run the schema in DESIGN.md §7.2 as the first migration. Every table listed there, including `organisations.data_region` (always `'au'` for now — it exists so a US region doesn't require backfilling health records later) and `audit_log`.

Supabase Auth, email + magic link. **JWT bearer + refresh, not cookie sessions** — mobile needs bearer tokens and switching later is an auth rewrite.

Signup auto-creates a `kind='personal'` organisation with the user as `owner`. Every query is org-scoped through a **single data-access module**. RLS stays enabled and correct on every table holding personal information; the API passes the user JWT through to Postgres on request-scoped connections so RLS actually applies. Service-role key is for the worker and explicitly-marked admin paths only, all of which write to `audit_log`.

### 2. Consent + upload
Consent screen recording `terms`, `privacy` and `overseas_disclosure` into `consents` with **type, version, timestamp, IP, user agent**. The overseas-disclosure consent must be a distinct, unticked choice that names what is sent and to which countries (United States, Ireland) — not a line buried in the ToS. Version bumps re-ask.

Per-upload attestation checkbox: *"I had consent to make this recording."* → `recordings.consent_attested_at`. Recording laws differ by Australian state; onboarding must say so.

`POST /v1/uploads` → `recordings` row + presigned PUT. **Client uploads directly to storage; audio never transits the API.** `POST /v1/recordings/{id}/complete` validates the object and transactionally enqueues the pipeline.

Accept mp3, m4a, wav, aac, ogg, flac, mp4/mov. Cap 3 hours / 500 MB.

### 3. Pipeline
State machine on `recordings.status`, with transitions written to `recording_events`:
```
created → uploading → uploaded → queued → transcribing → transcribed
        → suggesting_speakers → awaiting_speaker_confirmation
        → summarising → ready
failures: failed_upload | failed_audio_qc | failed_transcription | failed_extraction
```

Workers, in order:
- **`audio-qc`** — duration, sample rate, silence ratio, clipping. Reject junk *before* spending on transcription.
- **`transcribe`** — submit to AssemblyAI with a ≤15-min signed URL, `language_code: en_au`, diarization on, medical keyterm boost list. Store `provider_job_id`. AssemblyAI calls back to `POST /v1/webhooks/assemblyai` (HMAC-verified, unauthenticated route); the handler transitions state and enqueues the next job. Normalise into `transcript_segments`; keep the provider payload in `transcripts.provider_raw`.
- **`suggest-speakers`** — Haiku 4.5 over the first ~2,000 tokens → `{speaker_key, suggested_label, suggested_role, confidence}` into `speakers`. Unconfirmed.
- **`extract`** — Sonnet 5, details below.
- **`purge-audio`** — scheduled; deletes objects past `audio_delete_at`.

`awaiting_speaker_confirmation` is **non-blocking**: generate a first output with suggested labels so the user sees something immediately. Confirming labels enqueues a regeneration that supersedes it via `outputs.superseded_by`.

### 4. Extraction (the product)
```
model: claude-sonnet-5
output_config.format: <the template's JSON schema>   // strict structured output, never parse free text
output_config.effort: "medium"                        // tune against the eval set, don't guess
thinking: { type: "adaptive" }
prompt caching on the ~2k-token template prefix; transcript after the last breakpoint
```
Verify caching works via `usage.cache_read_input_tokens` — if it's zero across runs, something in the prefix is varying. Do not use assistant prefill (rejected on Sonnet 5). Batch API (50% off) is for backfills and bulk re-templating only, never the interactive path.

Output envelope, identical across all domains — only `sections[]` varies:
```jsonc
{
  "envelope_version": 1,
  "summary": "plain language, grade 8 reading level",
  "key_points":   [{ "text": "...", "segment_refs": [12, 13] }],
  "action_items": [{ "text": "...", "owner_hint": "you"|"clinic"|null,
                     "due_hint": "within 2 weeks"|null, "segment_refs": [41] }],
  "sections":     [{ "key": "medications_discussed", "title": "Medications discussed",
                     "body_markdown": "...", "segment_refs": [22, 24] }],
  "disclaimers": ["This is a summary of what was said in your appointment. It is not medical advice..."],
  "confidence_notes": ["Audio was unclear between 12:10 and 12:40."]
}
```
Then run the grounding validator. Persist `action_items` as rows (they get checked off and edited); `key_points` stay inside `outputs.content`.

**`medical_visit` sections:** Reason for visit · What was discussed · Diagnosis or assessment (plain language) · Medications discussed (name / dose / change / why) · Tests, scans & referrals ordered · What to do before the next visit · Warning signs to watch for · Questions to ask next time · Follow-up & next appointment.

### 5. Web UI
Upload with progress · recording list with status chips · processing view polling `GET /v1/recordings/{id}` · **speaker relabel screen** (suggestions pre-filled, first-utterance sample per speaker, one-screen confirm) · output view with summary, key points, action items (checkable), sections, and **click-a-claim-to-jump-to-transcript** · transcript view with speaker names and timestamps · export to PDF / Markdown / clipboard · delete recording · delete account.

Click-to-source is the trust mechanism of this product. Don't treat it as a nice-to-have.

### 6. Billing
Stripe Checkout + customer portal. The webhook writes `entitlements(org_id, plan, status, source='stripe', external_ref, current_period_end)`. **Every authorisation check reads `entitlements`; nothing calls Stripe at request time.** Apple in-app purchase becomes a second writer to the same table later — that is the entire reason this abstraction exists. Do not integrate RevenueCat or StoreKit now.

### 7. Eval harness — build it, don't defer it
`/evals/medical_visit/` — 20–30 consultation transcripts (synthetic plus consented, de-identified real) with hand-written gold outputs. Grade on:
- **Medication fidelity — hard release gate.** Every medication name, dose and change stated in the transcript appears in the output; nothing appears that isn't in the transcript. Any failure blocks release.
- Action item recall · grounding rate · hallucination rate (graded by `claude-opus-5` against the transcript) · readability (grade 8 or below).

Run on every prompt or template change; commit the scores. This is what lets you change prompts without fear.

---

## API surface (implement all of these in v1)

```
GET    /v1/me                                  user, orgs, entitlements, outstanding consents
DELETE /v1/me                                  account deletion + purge cascade
POST   /v1/consents                            {type, version}
GET    /v1/templates
POST   /v1/uploads                             → {recording_id, upload_url, expires_at}
POST   /v1/recordings/{id}/complete            → 202, enqueues pipeline
GET    /v1/recordings                          ?status=&template_key=&cursor=&limit=
GET    /v1/recordings/{id}                     POLL TARGET — cheap single-row read
PATCH  /v1/recordings/{id}                     rename / change template
DELETE /v1/recordings/{id}                     soft delete + immediate audio purge
GET    /v1/recordings/{id}/transcript          ?format=json|text
GET    /v1/recordings/{id}/speakers
PATCH  /v1/recordings/{id}/speakers            bulk relabel → confirms + regenerates
POST   /v1/recordings/{id}/outputs             → 202, new version
GET    /v1/recordings/{id}/outputs             version history
GET    /v1/outputs/{id}
PATCH  /v1/outputs/{id}/action-items/{aid}     {completed?, edited_text?}
POST   /v1/outputs/{id}/export                 {format: pdf|markdown|docx}
POST   /v1/billing/checkout
POST   /v1/billing/portal
POST   /v1/webhooks/assemblyai                 HMAC-verified
POST   /v1/webhooks/stripe                     signature-verified
```
Errors as RFC 9457 `application/problem+json`. Cursor pagination. `Idempotency-Key` honoured on all POSTs. `Retry-After` on every `202`.

`DELETE /v1/me` must perform a real purge cascade — it is both an Apple App Store requirement (Guideline 5.1.1(v)) and an Australian privacy obligation. Do not stub it.

---

## Definition of done for v1

- [ ] A user signs up, consents, uploads a 30-minute m4a, and sees a grounded summary with action items within ~3 minutes
- [ ] Speakers can be relabelled and the output regenerates with real names
- [ ] Every key point and action item links to a transcript moment
- [ ] PDF export carries the disclaimer block
- [ ] Deleting a recording removes the audio object; deleting an account purges everything
- [ ] Audio auto-purges 7 days after processing, verified by a test
- [ ] `audit_log` has a row for every read and mutation of health information
- [ ] Consent records carry type, version, timestamp, IP and user agent
- [ ] Stripe checkout grants entitlement; the app never calls Stripe to authorise
- [ ] Eval harness runs in CI and the medication gate passes
- [ ] CI asserts no public storage buckets
- [ ] OpenAPI spec generates from the Zod schemas and is committed

---

## Explicitly out of scope for v1

Live recording · meeting/lecture/personal templates · share links · clinic tenancy UI · mobile app · Apple IAP · multilingual · transcript editing · EHR or My Health Record integration · any clinical inference, interpretation or advice.

Build the `domain_templates` table and the template registry so a second template is a data change. Populate only `medical_visit`.

---

## Cost reference

≈ **$0.22 USD per audio-hour** all-in (AssemblyAI $0.17 + Sonnet 5 ~$0.047 + Haiku ~$0.003). A 30-minute consultation costs about **$0.11**. AI spend is not this product's constraint — do not micro-optimise it at the expense of output quality. Full model and volume tiers in DESIGN.md §7.5.

---

## If you get stuck or disagree

DESIGN.md records *why* each choice was made, including what would change the recommendation. If a decision looks wrong once you're in the code, check §3.1, §5.1 and §5.3 first — the reasoning and the escape hatches are written down. Raise it rather than silently substituting a different approach; several of these choices exist for legal reasons that aren't obvious from the code.
