# Build Plan — v1

Sequenced work breakdown for the MVP. Read [`HANDOFF.md`](./HANDOFF.md) first for the build spec and the non-negotiable rules; read [`DESIGN.md`](./DESIGN.md) when you need the reasoning behind a decision.

**Ticket format.** Each ticket names what it depends on, what it delivers, and what "done" means. Take one ticket per session where you can. Don't start a ticket whose dependencies aren't merged.

**Branching.** One branch and one PR per milestone, not per ticket — milestone-sized PRs stay reviewable while ticket-sized ones drown you in overhead.

**Honest sizing.** ~45 tickets, roughly 30 focused sessions. Full-time with AI assistance that's 2–3 weeks; evenings and weekends, more like 6–10. The long poles are M7 (extraction quality) and M8 (the web app). Everything before M5 is plumbing and moves fast.

---

## Before you write any code

Accounts and keys to have in hand. The build stalls without them.

| Service | Needed for | Notes |
|---|---|---|
| Supabase project in **`ap-southeast-2`** | DB, auth, storage | Region is not changeable later. Verify it says Sydney before doing anything else. |
| AssemblyAI API key | Transcription | Free credit is enough for the whole build |
| Anthropic API key | Extraction | Request zero-data-retention for the org (DESIGN §4.2) |
| Fly.io account | Hosting | `syd` region |
| Cloudflare account | SPA hosting | Free tier is fine |
| GitHub Actions | CI | Already have it |

**Environment variables** (validate all of these at boot and fail fast — a missing key discovered three minutes into a transcription job is a bad time):

```
DATABASE_URL                    # Supabase Postgres, ap-southeast-2
SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY       # worker + admin paths only, never the request path
SUPABASE_JWT_SECRET             # for verifying user JWTs in the API
STORAGE_BUCKET_AUDIO            # vm-audio-au
ASSEMBLYAI_API_KEY
ASSEMBLYAI_WEBHOOK_SECRET       # HMAC verification
ANTHROPIC_API_KEY
TRANSCRIPTION_PROVIDER          # 'stub' | 'assemblyai'  — see 5.1
FREE_TIER_AUDIO_SECONDS         # 36000
MAX_INFLIGHT_PER_ORG            # 3
PLATFORM_MONTHLY_AUDIO_HOURS_CAP  # circuit breaker
AUDIO_RETENTION_DAYS            # 7
PUBLIC_WEB_ORIGIN
```

---

## M0 — Foundations

No product behaviour. Get the machine working.

### 0.1 — Monorepo scaffold
**Depends on:** nothing
**Deliver:** pnpm workspaces per DESIGN §5.4 (`apps/api`, `apps/worker`, `apps/web`, `packages/shared`, `packages/providers`, `packages/templates`, `evals`, `infra`). TypeScript strict, ESLint, Prettier, Vitest. Root scripts: `build`, `typecheck`, `lint`, `test`.
**Done when:** `pnpm install && pnpm typecheck && pnpm lint && pnpm test` passes on a clean clone with zero source files of substance.

### 0.2 — Config loading
**Depends on:** 0.1
**Deliver:** `packages/shared/src/config.ts` — a Zod schema over the env vars above, parsed once at boot, exported typed. No `process.env` access anywhere else in the codebase.
**Done when:** starting any app with a missing or malformed var exits non-zero with a message naming the variable. A lint rule or test forbids `process.env` outside `config.ts`.

### 0.3 — Shared types
**Depends on:** 0.1
**Deliver:** `packages/shared` — recording status enum (incl. `failed_quota_exceeded`), the output envelope Zod schema (DESIGN §7.2), `NormalisedTranscript`, RFC 9457 problem shape, cursor pagination helpers.
**Done when:** Types are importable from `api`, `worker` and `web`, and the envelope schema round-trips a hand-written example fixture.

### 0.4 — CI
**Depends on:** 0.1
**Deliver:** GitHub Actions: typecheck, lint, unit tests, integration tests against an ephemeral Postgres service container.
**Done when:** CI is green on a PR and fails on a deliberately broken type.

---

## M1 — Data layer

### 1.1 — Core schema migration
**Depends on:** 0.1
**Deliver:** `infra/migrations/001_core.sql` — every table in DESIGN §7.2: `organisations`, `users`, `memberships`, `recordings`, `recording_events`, `transcripts`, `transcript_segments`, `speakers`, `domain_templates`, `outputs`, `action_items`, `consents`, `jurisdiction_disclaimers`, `entitlements`, `usage_ledger`, `audit_log`. Plus a migration runner (`pnpm db:migrate`).
**Done when:** Migration runs clean against a fresh database and is idempotent on re-run. `usage_ledger.recording_id` is **not** a foreign key (the recording gets purged). `organisations.data_region` defaults `'au'`.

### 1.2 — RLS policies
**Depends on:** 1.1
**Deliver:** `infra/migrations/002_rls.sql` — RLS enabled on every table holding personal information, with policies written as if clients connected directly (DESIGN §5.3).
**Done when:** An integration test proves a user JWT scoped to org A cannot read org B's recordings, transcripts, outputs or usage.

### 1.3 — Data access module
**Depends on:** 1.2
**Deliver:** `apps/api/src/db/` — a single module owning all queries. Every function takes an org context. Request-scoped connections set the JWT claims so RLS applies; the service-role client is separate, explicitly named, and used only by the worker and admin paths.
**Done when:** No SQL or Supabase client call exists outside this module. A test asserts the service-role client is not importable from request handlers.

### 1.4 — Seed data
**Depends on:** 1.1
**Deliver:** `infra/seeds/` — `domain_templates` with `medical_visit` v1 (sections per DESIGN §1); `jurisdiction_disclaimers` with all eight states/territories at version 1, containing **clearly-marked placeholder copy**.
**Done when:** Seeds run after migration. Placeholder disclaimer text is visibly marked as such (e.g. prefixed `[PLACEHOLDER — NOT LEGAL COPY]`) so it can never ship by accident.

---

## M2 — API skeleton and auth

### 2.1 — Fastify bootstrap
**Depends on:** 0.2, 0.3
**Deliver:** `apps/api` — Fastify, `/v1` prefix, health check, RFC 9457 error handler, structured JSON request logging with **PII scrubbing** (DESIGN §4.2), CORS for `PUBLIC_WEB_ORIGIN`, graceful shutdown.
**Done when:** `GET /v1/health` returns 200; a thrown error renders as `application/problem+json`; logs contain no request bodies.

### 2.2 — Auth middleware
**Depends on:** 1.3, 2.1
**Deliver:** JWT bearer verification against `SUPABASE_JWT_SECRET`, populating a typed request context `{userId, orgId, role}`. Request-scoped DB connection carrying the claims.
**Done when:** A protected route returns 401 without a token, 401 on an expired token, and resolves the right org with a valid one.

### 2.3 — Identity endpoints
**Depends on:** 2.2
**Deliver:** `GET /v1/me` (user, orgs, entitlements, outstanding consents, `state_territory`), `PATCH /v1/me` (display name, state/territory), `DELETE /v1/me`.
**Done when:** `DELETE /v1/me` performs a real purge cascade — audio objects gone, recordings/transcripts/outputs gone, `audit_log` stub retained with the user id hashed, `usage_ledger` retained. Apple Guideline 5.1.1(v) and APP 11.2 both depend on this working properly. Do not stub it.

### 2.4 — Signup side-effects
**Depends on:** 2.3
**Deliver:** On first authenticated request for an unknown user: create the user row, a `kind='personal'` organisation, an `owner` membership, and an `entitlements` row (`plan='free'`, `source='none'`, `audio_seconds_per_period=FREE_TIER_AUDIO_SECONDS`).
**Done when:** A fresh magic-link signup lands with a usable org and entitlement in one transaction. Concurrent first requests don't create two orgs.

### 2.5 — Consent and reference endpoints
**Depends on:** 2.2, 1.4
**Deliver:** `POST /v1/consents` (type, version → stores timestamp, IP, user agent), `GET /v1/templates`, `GET /v1/jurisdictions/{state}/disclaimer`.
**Done when:** `GET /v1/me` reports outstanding consents when a stored version is older than the current one. The disclaimer endpoint returns body, acknowledgement label and version for each of the eight jurisdictions.

### 2.6 — Audit log
**Depends on:** 1.3, 2.2
**Deliver:** An `audit()` helper plus wiring on every read and mutation of health information. Fields per DESIGN §7.2, including `break_glass`.
**Done when:** Reading a transcript, exporting an output, and deleting a recording each produce exactly one row with actor, resource, IP and user agent.

### 2.7 — OpenAPI generation
**Depends on:** 2.1
**Deliver:** OpenAPI 3.1 generated from the Fastify/Zod route schemas, written to `infra/openapi.json`, committed, with a CI check that it is current.
**Done when:** CI fails if a route schema changes without regenerating. This file is the future mobile contract — it is not decoration.

---

## M3 — Upload and quota

### 3.1 — Quota service
**Depends on:** 1.3, 2.4
**Deliver:** `apps/api/src/quota/` — `remainingSeconds(orgId)` from `entitlements` minus `SUM(usage_ledger)` for the current `period_ym`; `inFlightCount(orgId)`; `recordUsage(orgId, recordingId, seconds)`; platform circuit-breaker check.
**Done when:** Unit tests cover period rollover, an org with no ledger rows, and the delete-doesn't-restore-quota property. **That last one is the whole point of the ledger — test it explicitly.**

### 3.2 — `GET /v1/usage`
**Depends on:** 3.1
**Deliver:** `{period_ym, audio_seconds_used, audio_seconds_limit, in_flight_count}`.
**Done when:** Reflects reality immediately after a recording completes `audio-qc`.

### 3.3 — `POST /v1/uploads`
**Depends on:** 3.1, 2.5
**Deliver:** Validates `recorded_in_state`, a `consent_disclaimer_version` that is **currently active for that state**, and `consent_attested: true` — `422` otherwise. Soft quota check against `duration_hint`. In-flight limit → `429`. Creates the `recordings` row and returns a ≤15-minute presigned PUT.
**Done when:** Tests cover: missing consent → 422; stale disclaimer version → 422; wrong state's version → 422; over in-flight limit → 429; happy path returns a working upload URL. Audio never transits the API.

### 3.4 — `POST /v1/recordings/{id}/complete`
**Depends on:** 3.3
**Deliver:** Verifies the object exists and matches the declared checksum and size, transitions state, and **transactionally** enqueues `audio-qc`.
**Done when:** A crash between the status update and the enqueue cannot leave a recording stranded — proven by a test that aborts the transaction.

### 3.5 — Recording CRUD
**Depends on:** 3.4
**Deliver:** `GET /v1/recordings` (cursor paginated, filterable), `GET /v1/recordings/{id}` (the poll target — single indexed row read, no joins into segments), `PATCH` (rename, change template), `DELETE` (soft delete + immediate audio purge + cascade).
**Done when:** The poll endpoint is provably cheap (assert query count and absence of segment joins). Delete removes the storage object and leaves `usage_ledger` intact.

---

## M4 — Worker and pipeline

### 4.1 — Worker bootstrap
**Depends on:** 1.1, 0.2
**Deliver:** `apps/worker` — pg-boss on the app Postgres, job registry, graceful shutdown, a `transition(recordingId, from, to, detail)` helper writing `recording_events`, and retry/backoff policy per job type.
**Done when:** A trivial job enqueues from the API and runs in the worker. An invalid state transition throws rather than silently corrupting the machine. **Job payloads carry IDs only** — a test asserts no payload field contains transcript text.

### 4.2 — `audio-qc` job
**Depends on:** 4.1, 3.1
**Deliver:** Probe duration, sample rate, channels, silence ratio, clipping (ffprobe/ffmpeg). Reject junk. **Hard quota gate on the probed duration** — over quota → `failed_quota_exceeded`, purge the audio object immediately, stop. On pass, write the `usage_ledger` row and enqueue `transcribe`.
**Done when:** A 10-minute file against a 5-minute remaining allowance fails, the audio object is gone, and no ledger row is written. A silent file fails QC before any provider call.

### 4.3 — `purge-audio` scheduled job
**Depends on:** 4.1
**Deliver:** Runs hourly; deletes storage objects past `audio_delete_at`, sets `audio_deleted_at`, writes audit rows. Sets `audio_delete_at = now() + AUDIO_RETENTION_DAYS` when a recording reaches `ready`.
**Done when:** A test with a backdated `audio_delete_at` proves the object is deleted and the transcript survives.

### 4.4 — Circuit breaker
**Depends on:** 4.2, 3.3
**Deliver:** Platform-wide monthly audio-hour ceiling. Crossing it rejects new uploads with a clear message and emits a loud log/alert.
**Done when:** Test forces the breaker and asserts uploads are refused while existing in-flight work still completes.

---

## M5 — Transcription

> **Build 5.1 first and build the stub properly.** Everything in M6, M7 and M8 can then be developed and tested instantly, offline, deterministically, without burning credits or waiting minutes per iteration. This is the highest-leverage ticket in the plan.

### 5.1 — Provider interface + stub
**Depends on:** 0.3
**Deliver:** `packages/providers` — the `TranscriptionProvider` interface from DESIGN §3.1 and a `StubProvider` returning a canned multi-speaker medical consultation transcript instantly. Selected by `TRANSCRIPTION_PROVIDER=stub`.
**Done when:** The stub returns a realistic `NormalisedTranscript` with 3 speakers, ~60 segments, timestamps and a couple of medication mentions. Used by default in tests and local dev.

### 5.2 — AssemblyAI adapter
**Depends on:** 5.1
**Deliver:** `submit` (signed URL, `en_au`, diarization on, medical keyterm list), `parseWebhook` (HMAC verification), `fetchResult` → `NormalisedTranscript`.
**Done when:** Contract tests run the adapter against recorded fixtures. **Nothing outside `packages/providers` imports the AssemblyAI SDK** — enforce with a lint rule.

### 5.3 — `transcribe` job + webhook
**Depends on:** 5.2, 4.1
**Deliver:** The job submits and parks; `POST /v1/webhooks/assemblyai` (unauthenticated route, HMAC-verified) transitions state and enqueues the next job. Handles duplicate and out-of-order callbacks idempotently.
**Done when:** A replayed webhook does not double-process. An unverifiable signature is rejected with 401 and logged.

### 5.4 — Transcript persistence and read
**Depends on:** 5.3
**Deliver:** Write `transcripts` + `transcript_segments` (with `idx` — the grounding anchor) + initial `speakers` rows. `GET /v1/recordings/{id}/transcript?format=json|text`.
**Done when:** Segment indices are contiguous from 0 and stable. `providerRaw` is retained for reprocessing.

---

## M6 — Speakers

### 6.1 — `suggest-speakers` job
**Depends on:** 5.4
**Deliver:** Haiku 4.5 over the first ~2,000 tokens → `{speaker_key, suggested_label, suggested_role, confidence}` written to `speakers`, **unconfirmed**. Then enqueue `extract` (non-blocking — see DESIGN §3.3).
**Done when:** On the stub transcript it identifies the clinician. `confirmed_at` stays null. A low-confidence result still proceeds rather than stalling.

### 6.2 — Speaker endpoints
**Depends on:** 6.1
**Deliver:** `GET /v1/recordings/{id}/speakers` (with a first-utterance sample per speaker), `PATCH` (bulk relabel → sets confirmation → enqueues regeneration).
**Done when:** Confirming labels produces a new output version that supersedes the previous one. Unconfirmed suggestions are distinguishable from confirmed labels in the response — the UI depends on that distinction.

---

## M7 — Extraction

The hardest milestone. Budget accordingly.

### 7.1 — Template registry
**Depends on:** 1.4, 0.3
**Deliver:** `packages/templates` — loads `domain_templates` rows into a typed registry: system prompt, output JSON schema, section manifest, speaker roles, disclaimers. `medical_visit` v1 populated with the sections from DESIGN §1.
**Done when:** Adding a second template is a data change, not a code change — prove it by adding a throwaway `meeting` row in a test and rendering it.

### 7.2 — `extract` job
**Depends on:** 7.1, 6.1
**Deliver:** Sonnet 5 with `output_config.format` (strict structured output against the template schema), `thinking: {type:"adaptive"}`, `effort: "medium"`, prompt caching on the template prefix with the transcript after the last breakpoint. Persist token usage.
**Done when:** `usage.cache_read_input_tokens` is non-zero on the second run with the same template — if it's zero, something in the prefix is varying and you must find it. Output parses against the schema without string manipulation.

### 7.3 — Grounding validator
**Depends on:** 7.2
**Deliver:** Deterministic post-pass: drop any `key_point`, `action_item` or `section` whose `segment_refs` are empty or out of range; record what was dropped in `outputs.dropped_items`; set `validation_status`.
**Done when:** A synthetic output with a fabricated claim is stripped and marked `partially_validated`. This is the anti-hallucination control — test it adversarially, not happy-path.

### 7.4 — Output persistence
**Depends on:** 7.3
**Deliver:** Write `outputs` with template key/version, model, envelope version, token counts; `action_items` as rows with `segment_refs`; supersession via `superseded_by`.
**Done when:** Regenerating produces a new row and marks the old one superseded. History is queryable. `key_points` stay inside `outputs.content`; `action_items` are rows.

### 7.5 — Output endpoints
**Depends on:** 7.4
**Deliver:** `POST /v1/recordings/{id}/outputs` (202, regenerate), `GET /v1/recordings/{id}/outputs` (version history), `GET /v1/outputs/{id}`, `PATCH /v1/outputs/{id}/action-items/{aid}`.
**Done when:** End-to-end with the stub provider: upload → `ready` with a grounded, validated output, entirely offline.

---

## M8 — Web app

### 8.1 — SPA scaffold
**Depends on:** 2.7
**Deliver:** Vite + React + TanStack Router + TanStack Query. Typed API client generated from `infra/openapi.json`. Supabase Auth magic-link flow with bearer token + refresh. Protected route wrapper.
**Done when:** Sign in, land on an empty dashboard, refresh the page and stay signed in. **No API types are hand-written.**

### 8.2 — Onboarding
**Depends on:** 8.1, 2.5
**Deliver:** Consent screens (terms, privacy, and a **distinct, unticked** overseas-disclosure consent naming what is sent and to which countries), state/territory selection, and the recording-laws-differ-by-state explainer.
**Done when:** Overseas disclosure cannot be accepted by accepting the ToS. A consent version bump re-prompts an existing user.

### 8.3 — Upload flow
**Depends on:** 8.2, 3.3
**Deliver:** File picker with format/size validation, `recorded_in_state` dropdown pre-filled from profile, disclaimer fetched and re-fetched on state change, acknowledgement tick, direct-to-storage PUT with progress, then `/complete`. Remaining-allowance indicator.
**Done when:** Changing the state dropdown visibly swaps the disclaimer. Submitting without the tick is blocked client-side and rejected server-side. A `422` from a stale version re-fetches and re-prompts rather than erroring out.

### 8.4 — List and processing views
**Depends on:** 8.3, 3.5
**Deliver:** Recording list with status chips; processing view polling `GET /v1/recordings/{id}` at 2s → 5s after 60s → 15s after 5min, stopping on terminal states. Clear, specific failure messaging — especially `failed_quota_exceeded` and `failed_audio_qc`.
**Done when:** Polling provably stops on terminal states (assert no further requests). A quota failure explains the limit and when it resets.

### 8.5 — Speaker relabel screen
**Depends on:** 8.4, 6.2
**Deliver:** One screen: each speaker with its suggested label, role dropdown, a first-utterance sample, and **visible unconfirmed state**. Confirm all in one action.
**Done when:** Suggestions are never styled as confirmed. Confirming triggers regeneration and the UI reflects the new version.

### 8.6 — Output view
**Depends on:** 8.5, 7.5
**Deliver:** Summary, key points, action items with checkboxes, sections. **Click any claim to jump to that transcript moment.** Non-dismissible disclaimer block. Version history access.
**Done when:** Click-to-source works for every item carrying `segment_refs`. Items the validator dropped are simply absent — never rendered ungrounded.

### 8.7 — Transcript view
**Depends on:** 8.6, 5.4
**Deliver:** Speaker names, timestamps, scroll-to-segment target for click-to-source, low-confidence indicators, `confidence_notes` surfaced.
**Done when:** Deep-linking to a segment scrolls and highlights it.

### 8.8 — Settings
**Depends on:** 8.4
**Deliver:** Usage (`GET /v1/usage`), profile/state, delete recording with confirmation, delete account with a serious confirmation.
**Done when:** Account deletion works end-to-end from the UI and is irreversible as advertised.

---

## M9 — Export

### 9.1 — Markdown and clipboard
**Depends on:** 7.5
**Deliver:** `POST /v1/outputs/{id}/export` with `format: 'markdown'` (synchronous), plus client-side copy.
**Done when:** Output includes the disclaimer block and speaker names.

### 9.2 — PDF
**Depends on:** 9.1
**Deliver:** `render-export` worker job, `format: 'pdf'` returns 202 + poll, signed download URL with short expiry.
**Done when:** PDF carries the disclaimer, renders correctly at A4, and the download link expires.

---

## M10 — Evals

### 10.1 — Harness
**Depends on:** 7.3
**Deliver:** `evals/medical_visit/` — 20–30 transcripts with hand-written gold outputs. Runner scoring medication fidelity, action-item recall, grounding rate, hallucination rate (graded by `claude-opus-5` against the transcript), readability. Results committed per run.
**Done when:** `pnpm eval` produces a scorecard. Start with 10 cases if that's what you can write — a small honest eval beats a large imagined one.

### 10.2 — Medication gate in CI
**Depends on:** 10.1
**Deliver:** CI job on changes to prompts, templates or the extraction path. **Any medication-fidelity failure fails the build.**
**Done when:** A deliberately sabotaged prompt fails CI.

---

## M11 — Deploy

### 11.1 — Fly.io
**Depends on:** M7 complete
**Deliver:** `fly.toml` with API and worker as separate process groups in `syd`. Secrets configured. Health checks. Migrations run on deploy.
**Done when:** A push to main deploys and the worker picks up jobs.

### 11.2 — Cloudflare Pages
**Depends on:** 8.8
**Deliver:** SPA build and deploy, API origin configured, CORS verified.
**Done when:** The production URL completes a full upload-to-summary run.

### 11.3 — Security assertions in CI
**Depends on:** 11.1
**Deliver:** Tests asserting no public storage buckets, signed URLs ≤15 minutes, no service-role key reachable from request handlers, no provider SDK imported outside `packages/providers`, no `process.env` outside `config.ts`.
**Done when:** Each assertion fails when deliberately violated. These are cheap and they catch the class of mistake that becomes a breach notification.

---

## Critical path

```
M0 → M1 → M2 → M3 → M4 → 5.1(stub) ─┬─► M6 → M7 → M8 → M9 → M11
                                     └─► 5.2–5.4 (real provider, parallel)
M10 can start any time after 7.3
```

Once 5.1 lands, the real AssemblyAI integration (5.2–5.4) and the downstream product work (M6–M8) are independent. If you ever have two sessions running, that's the split.

**Milestone you should feel good about:** end of M7. At that point, with `TRANSCRIPTION_PROVIDER=stub`, you can upload a file and get a grounded summary back through the API — the entire product, minus a UI, provable with `curl`.

---

## Guardrails for the implementing session

1. **Don't relitigate the stack.** DESIGN.md §5 explains every choice and what would change it. If something looks wrong in practice, raise it — don't silently substitute.
2. **Don't invent tables.** The schema is in DESIGN.md §7.2. If you need a new one, say so and why.
3. **The seven rules in HANDOFF.md are not style preferences.** Grounding, scope, residency, transient audio, speaker confirmation, per-upload consent, server-side quota. Several exist for legal reasons that aren't visible from the code.
4. **Stub first, integrate second.** Don't develop M6–M8 against a live transcription API. It's slow, costs money, and is non-deterministic.
5. **Placeholder legal copy stays visibly placeholder.** Prefix it so it cannot ship by accident.

---

## First session

Paste this into a fresh Sonnet session:

> Read `docs/HANDOFF.md` and `docs/BUILD-PLAN.md` in this repo. Then implement milestone M0 (tickets 0.1 through 0.4) on branch `build/m0-foundations`. Follow the ticket acceptance criteria exactly. Don't start M1.
