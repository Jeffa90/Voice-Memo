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
| Payments | **None in v1.** Build the `entitlements` table and a hard usage cap; Stripe comes in phase 2 as a *writer* to that table. |
| Free-tier cap | **10 audio-hours per org per month**, enforced on server-probed duration. Plus 3 concurrent in-flight recordings and a platform-wide circuit breaker. |
| Recording consent | Per-jurisdiction disclaimer, acknowledged on **every** upload. Collect **state/territory only** — no address, no postcode. |
| Carer access | **No delegated access in v1.** A carer signs up and uploads under their own account. |
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

**6. Recording consent is acknowledged on every upload, never once at signup.** Australian surveillance-device law is state-based and inconsistent — in some jurisdictions every party must agree before a private conversation is recorded, in others a participant may record. The user is attesting to a fact about *this specific recording*, so a signup checkbox cannot carry that meaning. The disclaimer shown is the one for `recorded_in_state`, and the recording stores which state and which disclaimer **version** was acknowledged, so the exact wording is reconstructable later.

**7. Never trust the client for quota.** The soft check at `POST /v1/uploads` uses a client-supplied duration hint and exists only to avoid a pointless 400 MB upload. The real gate runs in the `audio-qc` worker against the **server-probed** duration.

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

Signup auto-creates a `kind='personal'` organisation with the user as `owner`, plus an `entitlements` row (`plan='free'`, `source='none'`, `audio_seconds_per_period=36000`). Profile carries `state_territory` (a dropdown of the eight states/territories) — **not** an address and **not** a postcode; it is all the disclaimer logic needs, and holding more is an APP 3 data-minimisation problem. Every query is org-scoped through a **single data-access module**. RLS stays enabled and correct on every table holding personal information; the API passes the user JWT through to Postgres on request-scoped connections so RLS actually applies. Service-role key is for the worker and explicitly-marked admin paths only, all of which write to `audit_log`.

### 2. Consent + upload

**Account-level consents.** A screen recording `terms`, `privacy` and `overseas_disclosure` into `consents` with **type, version, timestamp, IP, user agent**. The overseas-disclosure consent must be a distinct, unticked choice naming what is sent and to which countries (United States, Ireland) — not a line buried in the ToS. A version bump re-asks.

**Per-upload recording consent.** Seed `jurisdiction_disclaimers` with a row per state/territory (NSW, VIC, QLD, SA, WA, TAS, NT, ACT), version 1. Use clearly-marked placeholder copy — **the real wording is lawyer-drafted and is not your call.** The structure is the deliverable.

The upload form:
1. Shows a `recorded_in_state` dropdown, **pre-filled from the profile but changeable** — the applicable law follows where the conversation happened, not where the uploader lives, which matters for interstate specialists and travel.
2. Fetches `GET /v1/jurisdictions/{state}/disclaimer` and renders the active body for that state, re-fetching when the dropdown changes.
3. Requires an explicit tick of that state's `acknowledgement_label` — all parties consented to being recorded.
4. Submits `recorded_in_state`, `consent_disclaimer_version` and `consent_attested: true`.

The server returns `422` unless all three are present **and** the version is currently active for that state. If the copy changed between page load and submit, the client re-fetches and re-prompts. That strictness is the entire point of versioning it. Store `recorded_in_state`, `consent_disclaimer_state`, `consent_disclaimer_version`, `consent_attested_at` on the recording.

Onboarding copy must say plainly that recording laws differ by state and to ask the doctor first. **Build nothing that enables covert recording** — no hidden capture, no auto-start, no "discreet mode".

**Upload mechanics.** `POST /v1/uploads` → soft quota check → `recordings` row + presigned PUT. **Client uploads directly to storage; audio never transits the API.** `POST /v1/recordings/{id}/complete` validates the object and transactionally enqueues the pipeline.

Accept mp3, m4a, wav, aac, ogg, flac, mp4/mov. Cap 3 hours / 500 MB per recording.

### 3. Pipeline
State machine on `recordings.status`, with transitions written to `recording_events`:
```
created → uploading → uploaded → queued → transcribing → transcribed
        → suggesting_speakers → awaiting_speaker_confirmation
        → summarising → ready
failures: failed_upload | failed_audio_qc | failed_quota_exceeded | failed_transcription | failed_extraction
```

Workers, in order:
- **`audio-qc`** — probe duration, sample rate, silence ratio, clipping. Reject junk *before* spending on transcription. **This is also the hard quota gate:** if the probed duration would exceed the org's remaining allowance, transition to `failed_quota_exceeded`, **purge the audio immediately** (never hold audio you will not process) and stop. On success, write the immutable `usage_ledger` row.
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

### 6. Usage cap (there is no billing in v1)

v1 is free — **no Stripe, no checkout, no RevenueCat, no StoreKit.** But free over a metered AI pipeline is an open tab: at ~$0.22 per audio-hour, one user uploading 100 hours costs $22 and nothing bills to make you notice. So build the quota machinery now. It is the exact machinery the paid tier will use, so none of it is throwaway.

**Usage accounting.** Do **not** compute usage as a `SUM` over `recordings` — delete a recording, reclaim quota, repeat forever. Instead every processed recording writes an immutable row that survives deletion of the recording itself:
```
usage_ledger(id, org_id, recording_id, period_ym, audio_seconds, created_at)
```
`recording_id` is deliberately **not** a foreign key, because the recording gets purged. The ledger holds durations only, no content, so retention and deletion rules never touch it.

Remaining = `entitlements.audio_seconds_per_period − SUM(usage_ledger.audio_seconds WHERE period_ym = current)`.

**Four limits:**

| Limit | Value | Enforced |
|---|---|---|
| Monthly allowance | 10 audio-hours / org | Soft at `POST /v1/uploads` (client hint, UX only); **hard in `audio-qc` on probed duration** |
| Per recording | 3 hours / 500 MB | At upload and in `audio-qc` |
| Concurrent in-flight | 3 non-terminal recordings / org | `POST /v1/uploads` → `429` |
| Platform circuit breaker | Configurable monthly total audio-hours | Stops accepting uploads, alerts |

`GET /v1/usage` returns `{period_ym, audio_seconds_used, audio_seconds_limit, in_flight_count}` so the UI can show remaining allowance.

**Every authorisation and quota check reads `entitlements`. Nothing calls a payment provider at request time.** In phase 2 Stripe's webhook becomes one writer to that table; in phase 4 Apple IAP becomes a second. Neither changes a single read. That is the whole reason to build it this way before there is any money.

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
GET    /v1/jurisdictions/{state}/disclaimer    active body + acknowledgement label + version
GET    /v1/usage                               {period_ym, used, limit, in_flight_count}
POST   /v1/uploads                             → {recording_id, upload_url, expires_at}
                                               422 unless recorded_in_state +
                                               active consent_disclaimer_version +
                                               consent_attested:true; 429 if in-flight limit hit
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
POST   /v1/webhooks/assemblyai                 HMAC-verified

# /v1/billing/* is PHASE 2. No checkout in v1.
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
- [ ] Account consent records carry type, version, timestamp, IP and user agent
- [ ] Every upload stores the state and the disclaimer version acknowledged; a stale version is rejected with 422
- [ ] Changing `recorded_in_state` on the upload form swaps the disclaimer shown
- [ ] Quota is enforced on server-probed duration, not the client hint; over-quota audio is purged, not retained
- [ ] Deleting a recording does **not** restore quota (`usage_ledger` proves it)
- [ ] `GET /v1/usage` reflects reality after a completed upload
- [ ] Eval harness runs in CI and the medication gate passes
- [ ] CI asserts no public storage buckets
- [ ] OpenAPI spec generates from the Zod schemas and is committed

---

## Explicitly out of scope for v1

Payments and checkout of any kind · live recording · meeting/lecture/personal templates · share links · delegated carer access · clinic tenancy UI · mobile app · Apple IAP · multilingual · transcript editing · EHR or My Health Record integration · any clinical inference, interpretation or advice.

A carer who wants to manage someone's appointments signs up for their own account and uploads there — delegated access raises questions about authority over another person's health information that need legal input, so it is deliberately deferred. The schema supports adding it without migration.

Build the `domain_templates` table and the template registry so a second template is a data change. Populate only `medical_visit`.

---

## Cost reference

≈ **$0.22 USD per audio-hour** all-in (AssemblyAI $0.17 + Sonnet 5 ~$0.047 + Haiku ~$0.003). A 30-minute consultation costs about **$0.11**. A fully-saturated free account (10 hours) costs ≈ **$2.20/month** — that number is why the cap exists. AI spend is not this product's constraint — do not micro-optimise it at the expense of output quality. Full model and volume tiers in DESIGN.md §7.5.

---

## If you get stuck or disagree

DESIGN.md records *why* each choice was made, including what would change the recommendation. If a decision looks wrong once you're in the code, check §3.1, §5.1 and §5.3 first — the reasoning and the escape hatches are written down. Raise it rather than silently substituting a different approach; several of these choices exist for legal reasons that aren't obvious from the code.
