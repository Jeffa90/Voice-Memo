# Voice-Memo — System Design

**Status:** design pass complete, ready for implementation
**Date:** 2026-09-21
**Audience:** the implementing session, plus anyone reviewing the architecture before build starts
**Handoff brief for a fresh build session:** [`docs/HANDOFF.md`](./HANDOFF.md)

---

## 0. Scoping decisions taken

These four answers drove everything below. If any changes, the affected sections are named.

| Decision | Choice | What it drove |
|---|---|---|
| Data residency | Audio + transcripts stored in Australia; **overseas processing permitted under explicit consent** | §3 vendor choice (AssemblyAI viable), §5 hosting (Sydney), §4 APP 8 consent flow |
| v1 buyer | B2C patients now, **clinic tenancy stubbed into the schema** | §7.2 data model (`organisations` from day one), §7.4 roadmap |
| Ops appetite | Managed services now, **documented swap path** to self-hosting | §3 provider interface, §5 queue choice |
| Languages | English only (incl. Australian accents) | §3 vendor scoring, §7.4 (multilingual is phase 5) |
| Recording consent | Per-jurisdiction disclaimer, acknowledged on **every** upload. State/territory collected, nothing more | §4.6, §7.2 (`jurisdiction_disclaimers`) |
| Carer access | **No delegated access in v1** — a carer uses their own account | §7.2, §7.4 |
| Billing | **Free in v1 behind a hard usage cap.** Stripe deferred to phase 2 | §5.2, §7.3, §7.4, §7.5 |

### Four pushbacks on the brief

**1. The buyer problem is bigger than the build problem.** "Heidi but for patients" is a clean framing technically, but Heidi sells to clinicians who feel the pain every day and have a budget line. A patient who has one GP visit a year will not hold a subscription. The users with recurring need are narrower: people managing a chronic or newly-diagnosed condition, carers (especially adult children managing an ageing parent's appointments), and patients in complex specialist pathways (oncology, fertility, paediatric). Recommend targeting that ICP explicitly in v1 copy and onboarding, because it changes retention far more than any architecture decision here. It is also the reason stubbing clinic tenancy is the right call — the clinic paying to reduce "what did the doctor say?" callbacks is a plausible second buyer, and you want the schema ready.

**2. Recording consent is a real legal risk that the brief does not mention.** Surveillance/listening device laws in Australia are **state-based, not federal**, and they differ materially. In NSW (Surveillance Devices Act 2007) recording a private conversation generally requires consent of all principal parties; Victoria permits a party to the conversation to record it; Queensland similarly. A patient recording their GP without asking may be committing an offence in some states. This is squarely a product problem. **Resolved in this design:** the app collects the user's state/territory, shows the disclaimer written for that jurisdiction, and requires an explicit acknowledgement that all parties consented — on *every single upload*, never once at signup. Full design in §4.6.

**3. "Domain as a config layer" is right, but the prompt is the easy part — the *eval* is what actually varies.** A meeting summary that drops an action item is an annoyance. A medical summary that drops a medication dose change, or invents one, is a harm. These need different quality bars, not just different prompts. Build a golden-set eval harness for the medical template in v1 (§3.4), not as a later nicety. It is ~2 days of work and it is the difference between shipping responsibly and hoping.

**4. Agree live recording is out of MVP — and when it returns, it returns on web first.** Browser `MediaRecorder` with chunked upload is a few days of work and reuses the entire existing pipeline. Mobile background audio capture is a different animal (iOS background modes, interruption handling, call detection, battery). Sequencing them together would let the hard one block the easy one.

---

## 1. Product framing

Voice-Memo turns a recorded conversation into structured, useful text.

**First use case (v1):** a patient — or a carer, or clinic staff acting for the patient — uploads a recording of a medical consultation and receives a plain-language summary, key points, action items, and the labelled transcript.

**Architecturally, nothing is medical.** The pipeline is `upload → transcribe → diarize → relabel → extract → render → export`. "Medical" is one row in a `domain_templates` table. Meetings, lectures and personal voice notes are other rows in the same table running through identical code.

### What is common vs. what varies per domain

| Layer | Common across all domains | Varies by domain |
|---|---|---|
| Ingest | Formats, size/duration caps, virus scan, audio QC, storage, encryption | — |
| Transcription | Provider call, diarization, segments, timestamps, confidence | Optional keyterm boost list (medical vocabulary vs. company jargon) |
| Speaker handling | Speaker keys, relabel UI, confirmation state | Role vocabulary (`clinician`/`patient`/`interpreter` vs. `chair`/`presenter`/`attendee` vs. `lecturer`/`student`) |
| Extraction | One Anthropic call, one strict output envelope, transcript-grounding rule | System prompt, section list, section schema, action-item semantics |
| Output | `summary`, `key_points[]`, `action_items[]`, `sections[]`, `disclaimers[]`, `segment_refs` grounding | Which section keys are expected; disclaimer text |
| Export | PDF/Markdown/clipboard renderer | Header/branding, disclaimer block, section ordering |

The output envelope is fixed. Only `sections[]` content and the prompt/schema that produce it change. That is the whole of the domain abstraction — a template is a prompt plus a JSON schema plus a section manifest, stored as data and versioned.

### Domain templates (initial set)

**`medical_visit`** (v1, the only one built)
Reason for visit · What was discussed · Diagnosis or assessment (plain language) · Medications discussed (name / dose / change / why) · Tests, scans & referrals ordered · What to do before the next visit · Warning signs to watch for · Questions to ask next time · Follow-up & next appointment

**`meeting`** (phase 2)
Purpose · Decisions made · Discussion by topic · Action items (owner + due) · Open questions · Next meeting

**`lecture`** (phase 2)
Topic & scope · Key concepts (term + definition) · Worked examples · Assigned reading & assessment · Likely exam material · Glossary

**`personal`** (phase 2)
Summary · Commitments made · Things to remember · Follow-ups

---

## 2. Core functionality (v1 scope)

| Capability | v1 | Notes |
|---|---|---|
| Upload pre-recorded audio | **Yes** | mp3, m4a, wav, aac, ogg, flac, mp4/mov (audio extracted). Cap 3 hours / 500 MB. |
| Live recording capture | No — **phase 3** | Web `MediaRecorder` first. See pushback 4. |
| Transcription | **Yes** | Managed API, see §3 |
| Speaker diarization | **Yes** | 2–6 speakers typical |
| Manual speaker relabel | **Yes** | "Speaker A" → "Dr Chen", plus a role. AI suggests, human confirms. |
| Summary generation | **Yes** | |
| Key point extraction | **Yes** | |
| Action item extraction | **Yes** | Stored as rows, checkable |
| Domain templates | **One** (`medical_visit`) | Table + registry built for four; only one populated |
| Export | **PDF + Markdown + copy** | |
| Share links | No — phase 2 | |
| Regenerate output | **Yes** | After relabelling speakers, re-run extraction; outputs are versioned |

### The speaker relabel flow (worth spelling out)

This is the highest-leverage UI in the product and the main reason transcription quality complaints get defused.

1. Provider returns speaker keys `A`, `B`, `C` with segments.
2. A **Haiku 4.5** pass reads the first ~2,000 tokens and proposes `{speaker_key, suggested_label, suggested_role, confidence}` — e.g. `A → "Clinician"` because A asks diagnostic questions and uses clinical vocabulary.
3. UI shows suggestions pre-filled but unconfirmed, with a first-utterance sample per speaker.
4. User edits/confirms in one screen, `PATCH /v1/recordings/{id}/speakers`.
5. Confirming triggers regeneration of the output with real names. Extraction quality improves materially when the model knows which voice is the clinician.

Design rule: **the AI never silently commits a speaker identity.** Suggestions are always visibly unconfirmed until a human confirms. In a medical context, attributing "you should stop taking the warfarin" to the wrong speaker is a serious error.

---

## 3. AI / processing pipeline

Two model layers, deliberately separated so either can be swapped without touching the other.

```
audio ──► [ Layer 1: ASR + diarization ]──► transcript + speaker turns
                                                  │
                                                  ▼
                                    [ Layer 2: Anthropic LLM ]
                                     ├─ Haiku 4.5  → speaker label suggestions
                                     └─ Sonnet 5   → summary / key points / actions
```

### 3.1 Layer 1 — transcription + diarization

Evaluated on cost per audio-minute, diarization accuracy, and residency/compliance posture.

| Option | Cost per audio-hour (USD) | Diarization | Residency | Compliance | Ops burden |
|---|---|---|---|---|---|
| **AssemblyAI** Universal-2 + diarization | **$0.15 + $0.02 = $0.17** | Best-rated of the managed APIs; async diarization included as a cheap add-on | US or EU (Dublin) self-serve. **No AU region.** | SOC 2 Type 2, PCI-DSS L1, HIPAA BAA available (since Oct 2025), no-training setting | None |
| AssemblyAI Universal-3.5 Pro + diarization | $0.21 + $0.02 = $0.23 | Higher accuracy tier | same | same | None |
| **Deepgram** Nova-3 batch | **$0.258** (diarization included on pre-recorded) | Good; slightly behind AssemblyAI on conversational audio | **Runs on Australian infrastructure** | SOC 2 Type 2, HIPAA BAA (Enterprise), zero retention by default | None |
| **OpenAI** `gpt-4o-transcribe` / `-diarize` | $0.36 | Newer, less field-proven for multi-speaker consultations | US | No AU region | None |
| **Self-hosted WhisperX + pyannote** | ~$0.02–0.07 at high utilisation; **effectively $150–400/mo floor** regardless of volume | DER ~11–19% on standard benchmarks (AMI/CallHome/DIHARD); degrades on overlap and 4+ speakers | Wherever you put the GPU — full control | Yours to certify | High: GPU provisioning, model pinning, queue autoscaling, on-call |

**Recommendation for MVP: AssemblyAI Universal-2 with speaker diarization, $0.17 per audio-hour.**

Why:
- **Cheapest credible option** — 34% below Deepgram, 53% below OpenAI, and it bills per second with no idle cost. Self-hosting is roughly 3× more expensive at early-stage volume once GPU idle time is counted, which is the opposite of most people's intuition.
- **Best diarization for the actual workload.** The hard case here is a two-to-three speaker consultation with interruptions and overlap. AssemblyAI is consistently top of the managed pack on conversational diarization.
- **Compliance posture is adequate** under the chosen residency stance: SOC 2 Type 2, a HIPAA BAA already available (which is the US seam pre-solved), a contractual no-training setting, and a documented DPA. The cross-border disclosure is handled by consent + contract per §4.
- **Keyterm/word boost** lets you push a medication and condition vocabulary in, which is where generic ASR usually fails on medical audio.

**What would change this recommendation:**

| Trigger | New recommendation |
|---|---|
| Residency tightens to AU-only (enterprise deal, clinic procurement, legal advice) | **Deepgram Nova-3 on AU infrastructure.** ~52% more expensive; the swap is one adapter class. |
| Volume exceeds ~3,000–5,000 audio-hours/month sustained | **Self-host WhisperX + pyannote on `ap-southeast-2` GPU.** Crossover math in §7.5. Solves residency and cost simultaneously. |
| Medical terminology accuracy complaints | **Upgrade to Universal-3.5 Pro first** (+$0.06/hr) and add keyterm boosting *before* changing vendor. Vendor churn is expensive; a tier bump is a config change. |
| US expansion with clinic customers | Stay on AssemblyAI, execute the BAA, add region routing per `organisations.data_region`. |

**The swap path is a hard architectural requirement, not a nice-to-have.** All provider access goes behind:

```ts
interface TranscriptionProvider {
  readonly name: string;
  submit(input: {
    audioUrl: string;            // short-lived signed URL
    languageCode: 'en_au';
    diarize: boolean;
    keyterms?: string[];
    webhookUrl: string;
    idempotencyKey: string;
  }): Promise<{ providerJobId: string }>;

  parseWebhook(headers: Record<string,string>, body: unknown):
    Promise<{ providerJobId: string; status: 'completed'|'failed'; error?: string }>;

  fetchResult(providerJobId: string): Promise<NormalisedTranscript>;
}

// Provider-agnostic shape everything downstream depends on:
interface NormalisedTranscript {
  languageCode: string;
  durationMs: number;
  segments: Array<{
    index: number; speakerKey: string;      // 'A' | '0' | ...
    startMs: number; endMs: number;
    text: string; confidence: number | null;
  }>;
  providerRaw: unknown;                     // stored for reprocessing/debug
}
```

Nothing downstream of `NormalisedTranscript` may import a provider SDK. That single rule is what makes the Deepgram or WhisperX swap a one-file change.

### 3.2 Layer 2 — language understanding (Anthropic API)

| Job | Model | Why |
|---|---|---|
| Summary, key points, action items, sections | **`claude-sonnet-5`** ($2/MTok in, $10/MTok out) | The quality-sensitive step. This is the product. |
| Speaker label suggestions | **`claude-haiku-4-5`** ($1/MTok in, $5/MTok out) | Short prompt, simple classification, needs to be fast and cheap. Only the transcript head is sent. |
| Audio quality triage / "is this actually a consultation?" | **`claude-haiku-4-5`** | Cheap gate before spending on Sonnet |

**Request shape for extraction:**

- `output_config.format` — strict structured output against the template's JSON schema. Do not parse free text.
- **Prompt caching** — the template system prompt plus the section manifest is a stable prefix (~2,000 tokens). Cache it; the transcript goes after the last breakpoint. Verify with `usage.cache_read_input_tokens`.
- `thinking: { type: "adaptive" }` — the extraction is a genuine reasoning task (working out which medication change was actually agreed vs. merely mentioned).
- `output_config.effort` — start at `medium`, measure against the eval set, raise only if the eval says so.
- **Batch API (50% discount)** applies to backfills and bulk re-templating, *not* to the interactive path where a user is waiting.
- No prefill (rejected on Sonnet 5). Use structured outputs instead.

**Grounding rule — the most important prompt constraint in the product.** Every `key_point`, `action_item` and `section` must carry `segment_refs: number[]` pointing at transcript segment indices. After generation, a deterministic validator drops any item whose `segment_refs` are empty or out of range, and flags the output as `partially_validated`. This is the anti-hallucination control, and it also makes the UI able to show "the doctor said this at 14:32" — which is the single most trust-building feature you can ship.

**Scope rule (TGA + App Store, see §4.5 and §6):** the system prompt states that the assistant reports only what was said in the recording, in plainer language; it never adds clinical advice, never interprets results not interpreted in the room, never suggests actions the clinician did not state, and never speculates about diagnosis. Enforced in the prompt *and* checked by the grounding validator.

### 3.3 Pipeline state machine

```
created → uploading → uploaded → queued → transcribing → transcribed
        → suggesting_speakers → awaiting_speaker_confirmation
        → summarising → ready
```
Failure states: `failed_upload`, `failed_audio_qc`, `failed_quota_exceeded`, `failed_transcription`, `failed_extraction`. Terminal: `deleted`.

`awaiting_speaker_confirmation` is non-blocking — a first-pass output is generated with suggested labels so the user sees something immediately; confirming labels enqueues a regeneration that supersedes it. Blocking the summary on a human step would gut the perceived speed of the product.

### 3.4 Eval harness (build this in v1)

`evals/medical_visit/` — 20–30 consultation transcripts (synthetic plus consented real, de-identified) with hand-written gold outputs. Graded on:

- **Medication fidelity** (hard gate): every medication name, dose and change stated in the transcript appears in the output; nothing appears that is not in the transcript. Any failure is a release blocker.
- **Action item recall**: fraction of gold action items captured.
- **Grounding**: fraction of output items with valid `segment_refs`.
- **Hallucination rate**: claims with no transcript support, judged by `claude-opus-5` as grader against the transcript.
- **Readability**: target grade 8 or below for patient-facing text.

Run it on every prompt or template change and record the scores in-repo. The medication gate is what lets you change prompts without fear.

---

## 4. Compliance and data handling

> Not legal advice. This is an engineering-side reading; get an Australian privacy lawyer to review the privacy policy, consent copy and terms before onboarding real patients. Several points below (especially §4.5 and §4.6) are the kind that genuinely need a lawyer.

### 4.1 Which law applies

**Privacy Act 1988 (Cth)** and the 13 Australian Privacy Principles.

The point most startups get wrong: **the small business exemption will very likely not save you.** Section 6D(4)(b) provides that an entity is not a small business operator if it *provides a health service and holds health information*. The $3M turnover threshold is irrelevant to such an entity. Whether a patient-side summarisation tool "provides a health service" within the Act's broad definition is arguable and needs legal advice — but the safe and recommended engineering assumption is **you are an APP entity from day one**. Build to the APPs from the first commit; retrofitting audit logs and consent records into a live system holding health information is miserable.

**Health information is "sensitive information"** under the Act. Consequences that bite:
- **APP 3.3** — you generally need *consent* to collect it, and the collection must be reasonably necessary for your functions.
- **APP 6** — you may only use or disclose it for the primary purpose it was collected for. Using transcripts to improve models is a secondary purpose and requires separate consent (recommendation: don't, and say so in the policy).

### 4.2 APP 8 — cross-border disclosure (the one your architecture turns on)

Sending audio to AssemblyAI (US/EU) and transcripts to the Anthropic API (US/global) are **cross-border disclosures**. Under APP 8 and s 16C you remain accountable: if the overseas recipient mishandles the information, **you are deemed to have breached the APPs**. Guidance was last updated October 2025 and the December 2024 amendments apply to disclosures made after 11 December 2024 regardless of when the information was collected.

Two available bases, and you should rely on both:

1. **Reasonable steps (APP 8.1)** — contractual. Execute a DPA with AssemblyAI binding APP-equivalent handling, no training on your data, breach notification, deletion on request, and subprocessor disclosure. Same with Anthropic; request **zero data retention** for your organisation (available for Sonnet 5 and Haiku 4.5).
2. **Informed consent (APP 8.2(b))** — must be *express, informed, specific, voluntary and current*. Not a checkbox buried in the ToS. A distinct consent screen that names the countries, names what is sent, and cannot be pre-ticked.

**Engineering obligations this creates:**
- A `consents` table recording type, **version**, timestamp, IP and user agent. When you change subprocessors or countries, you bump the version and re-ask. This table is your evidence if OAIC ever asks.
- A **subprocessor register** in the repo (`docs/SUBPROCESSORS.md`) listing every third party that touches personal information, what it receives, and where it processes. This doubles as the source for the Apple Privacy Nutrition Label (§6).
- **APP 1.4(f)/(g)**: the privacy policy must state that you disclose overseas and name the likely countries (United States, Ireland).

**Design rule:** no content — no audio, no transcript, no summary text — ever goes to a third party that is not on the register. That specifically means **job payloads carry record IDs only, never transcript content**, so that any observability, queue or error-tracking vendor never becomes an undisclosed recipient of health information. Scrub PII from Sentry-equivalent breadcrumbs.

### 4.3 APP 11 — security, retention and destruction

APP 11.1 requires reasonable steps to protect the information. APP 11.2 requires you to **destroy or de-identify** it when it is no longer needed. That second half is a design input, not a policy line.

| Artefact | Default retention | Rationale |
|---|---|---|
| **Raw audio** | **Deleted 7 days after successful processing** (user can opt to keep, org policy can override) | The most sensitive artefact, the least useful after transcription, and the one with the worst breach consequences. 7 days exists only so reprocessing after a bug is possible. |
| Transcript + segments | Until user deletes; org default 24 months | This is the product |
| Outputs | Until user deletes | Versioned; supersession keeps history |
| Audit log | 7 years | Evidentiary; also aligns with the HIPAA 6-year rule for the US seam |
| Consent records (incl. per-upload attestations) | 7 years after account closure | Evidentiary — this is the record you would rely on if a recording's lawfulness were ever challenged |
| Deleted account | Hard purge within 30 days | Audit stub retained with user id hashed |

Controls:
- **In transit:** TLS 1.2+ everywhere. No plaintext internal hops.
- **At rest:** AES-256 via Supabase/S3 SSE. Phase 2: envelope encryption for audio objects with per-recording data keys wrapped by a KMS key, so a storage compromise alone does not expose audio. Not in v1 because AssemblyAI needs to fetch plaintext audio via signed URL, and doing this properly means a decrypt-and-stream proxy — real work, deferred deliberately.
- **Signed URLs ≤ 15 minutes**, single-use where the storage layer supports it. No public buckets, ever. Verify this in CI.
- **Raw audio access:** no staff access by default. Any operator read of an audio object or transcript goes through an explicit break-glass path that writes to `audit_log` and **emails the affected user**. Make the expensive-feeling thing expensive to do.
- **Audit logging** of every read and mutation of health information, with actor, resource, IP and timestamp (APP 11/12 evidence, and the US seam).

### 4.4 Other Australian obligations

- **Notifiable Data Breaches scheme** (Privacy Act Part IIIC) — eligible breaches must be notified to the OAIC and affected individuals. You need a written incident response runbook before launch, not after. `docs/INCIDENT-RESPONSE.md`.
- **State health records legislation** — becomes live when you serve clinics: Health Records and Information Privacy Act 2002 (NSW), Health Records Act 2001 (Vic), Health Records (Privacy and Access) Act 1997 (ACT). These impose Health Privacy Principles that overlap the APPs but are not identical. Flag for phase 3 (clinic tenancy), not v1.
- **My Health Records Act 2012** — applies only if you integrate with the My Health Record system. **Recommendation: do not, for a long time.** Integration triggers a separate registration and compliance regime with criminal penalties for unauthorised collection/use. It is not a feature, it is a company-level commitment.
- **2024 reforms now in force:**
  - **Statutory tort for serious invasions of privacy**, commenced 10 June 2025. Misuse of health information is close to the paradigm case. This raises the cost of a breach well above the regulatory fine.
  - **Automated decision-making transparency** — obligations commence **10 December 2026** (roughly three months out). If summaries are used in ways that significantly affect an individual's rights or interests, your privacy policy must disclose the automated decision-making. Cheap to comply with if you write the policy now with it in mind; annoying to retrofit.

### 4.5 TGA / Software as a Medical Device — the scope line

If the software diagnoses, screens, monitors, predicts, or recommends treatment, it can be a medical device under the Therapeutic Goods Act 1989 and need TGA inclusion. That is a different company.

**The line, stated as a product rule:** *Voice-Memo reports what was said in the room, in plainer language. It does not add, interpret, infer, advise, or triage.*

Enforced in three places so it cannot drift:
1. System prompt constraint in every template.
2. The `segment_refs` grounding validator — anything not traceable to the transcript is dropped.
3. A `disclaimers[]` array in the output envelope, rendered on screen, in PDF, and in any share — never optional, never dismissible.

Anything that would cross this line (symptom checking, "you should ask about X", risk scoring, medication interaction warnings) is out of scope indefinitely, regardless of how easy it looks.

### 4.6 Recording consent — jurisdiction-specific, acknowledged every time

Surveillance and listening device legislation in Australia is **state-based and materially inconsistent**. Broadly, some jurisdictions require the consent of all principal parties to record a private conversation, while others permit a party to the conversation to record it — but the exceptions, definitions and penalties differ enough that a single national disclaimer would be either wrong or useless. The eight jurisdictions each need their own wording: NSW, VIC, QLD, SA, WA, TAS, NT, ACT.

**The design:**

1. **Collect state/territory only.** A dropdown on the profile. Not a street address, not a postcode. This is the APP 3 data-minimisation position: it is exactly what the disclaimer logic needs and nothing more, so there is no high-value address data to leak and nothing to justify holding. See also §4.3.
2. **Jurisdiction is a property of the recording, not the person.** The applicable law generally follows where the conversation occurred, not where the uploader lives. So `recordings.recorded_in_state` is its own field, pre-filled from the profile and changeable at upload with a dropdown. This matters for interstate specialists and travel — common for exactly the complex-care patients most likely to use this product. (Telehealth across state lines is genuinely unsettled; the disclaimer copy should acknowledge that rather than assert a clean answer.)
3. **Acknowledge on every upload, never once at signup.** The user is attesting to a fact about *this specific recording* — that all parties consented. A one-time signup checkbox cannot carry that meaning, and would be worth very little if ever tested.
4. **Stamp what was shown.** Each recording stores `recorded_in_state`, `consent_disclaimer_state`, `consent_disclaimer_version` and `consent_attested_at`. Disclaimer copy lives in a versioned `jurisdiction_disclaimers` table (§7.2), so you can later prove the exact wording a given user acknowledged on a given day. Changing the copy bumps the version; old recordings keep their original reference.
5. **Terms clause** placing responsibility for lawful recording on the uploader, and an onboarding explainer along the lines of *"Recording laws differ by state. In some states everyone present has to agree before you record a private conversation. Ask your doctor first — most will say yes."*
6. **Nothing that encourages covert recording.** No hidden capture, no disguised UI, no auto-start, no "discreet mode". This is a product-values line as much as a legal one, and App Review will read it that way too.

> The per-jurisdiction copy must be drafted or reviewed by an Australian lawyer before real patient recordings. The table structure is the engineering deliverable; the words in it are not.

### 4.7 The HIPAA seam (US later — flag only, do not build)

If you later serve US clinics you are likely a **Business Associate**. Direct-to-consumer patient-uploaded data may fall outside HIPAA entirely but lands under the **FTC Health Breach Notification Rule**, so there is no "no rules" path either.

Where the seams need to be, so they cost days rather than months:

| Seam | Built now? | Detail |
|---|---|---|
| `organisations.data_region` column | **Yes, day one** | `'au'` default. Every storage key, DB partition decision and provider endpoint reads from it. Adding this column later means backfilling every record. |
| BAAs with subprocessors | Flag only | AssemblyAI and Anthropic both offer them; nothing to build |
| Audit log with actor/resource/timestamp | **Yes, day one** | Already required by APP 11; HIPAA needs 6-year retention — set it to 7 |
| Minimum-necessary access controls | **Yes, day one** | RBAC + break-glass already required |
| Region-pinned storage buckets | Design only | Bucket naming must include region from the start: `vm-audio-au`, not `vm-audio` |
| Encryption + key management | Partial | SSE now, envelope encryption phase 2 |

---

## 5. Tech stack

Designed for this workload specifically: large binary uploads, minutes-long asynchronous jobs with external webhook waits, an LLM layer, Australian data residency, a solo/small team, and a mobile client consuming the same backend later.

### 5.1 Recommendations

| Concern | Recommendation | Why for *this* app |
|---|---|---|
| **Backend** | **TypeScript + Fastify** (Node 22 LTS) | The work is I/O-bound orchestration, not compute — no reason to reach for Python. TypeScript end-to-end means one language across API, web, and (if React Native) mobile, with **shared Zod schemas generating both server validation and client types**. Fastify over Express because its schema-first design generates the OpenAPI spec from the same schemas that validate requests — so the contract the mobile app depends on cannot silently drift from the implementation. Over NestJS because the DI/decorator overhead buys nothing at this size. |
| **Transcription worker** | **Separate deployable, same repo** | Today it is thin TypeScript calling AssemblyAI. When self-hosting arrives it becomes a Python GPU service consuming the same queue and writing the same `NormalisedTranscript`. Keeping it a separate process from day one is what makes that swap a deployment change rather than a rewrite. |
| **Frontend** | **Vite + React + TanStack Router + TanStack Query** | Deliberately *not* Next.js. The app is entirely behind auth (no SEO value) and a mobile client must consume the same API. A plain SPA **forces** every capability through `/v1` — which is exactly the discipline that protects the mobile path. Next.js is fine technically, but Server Actions and route handlers are a constant temptation to put logic server-side where mobile can't reach it, and its SSR layer would put PHI in whatever region you deploy it to. Marketing/landing pages ship separately as static content. |
| **Database** | **Supabase Postgres, `ap-southeast-2` (Sydney)** | Postgres is the right database (JSONB for provider payloads and output envelopes, full-text search for transcripts later, relational integrity for the tenancy model). Supabase specifically because it puts **Postgres + Auth + Storage in Sydney under one vendor** — which collapses three residency problems into one — and because Row Level Security gives tenant isolation enforced *in the database*, not just in application code. That is a meaningful control for health data. And it is just Postgres, so the escape hatch is a `pg_dump`. |
| **Auth** | **Supabase Auth** (email + magic link + OAuth), JWT bearer | Do not build auth for health data. JWT bearer + refresh (not cookie sessions) because that is what a mobile client needs — choosing cookies now would mean an auth rewrite at mobile time. |
| **Object storage** | **Supabase Storage (Sydney)** for v1; S3 `ap-southeast-2` at scale | S3-compatible, so the abstraction is trivial and the migration is `rclone`. Bucket naming carries the region: `vm-audio-au`. |
| **Queue / jobs** | **pg-boss** (Postgres-backed) in a dedicated Node worker | No new vendor, no new region to reason about, and **enqueue is transactional with the database write** — which eliminates the classic "row committed but job lost" bug class. Critically, it keeps job payloads (IDs only) inside your own Postgres rather than a third-party queue that would become an undisclosed recipient of health information (§4.2). Upgrade to Inngest/Trigger.dev when the pipeline grows fan-out and human-in-the-loop steps — but only if payloads stay ID-only. |
| **Job status → frontend** | **Polling** `GET /v1/recordings/{id}`, 2s interval with backoff | Transcription takes 30s–3min. One lightweight endpoint, polled, works through every proxy and corporate network, behaves identically from a mobile client, needs no connection state, and survives a worker restart. WebSockets earn their keep with many concurrent live updates or true streaming — i.e. phase 3 live recording. **Free upgrade path:** you are already on Supabase, so Supabase Realtime can push `recordings` row changes over WebSocket whenever you want it, with no new infrastructure. Poll first. |
| **Hosting** | **Fly.io `syd`** for API + worker; **Cloudflare Pages** for the SPA | Fly has a Sydney region, deploys containers, and runs the API and worker as separate process groups from one config — which is exactly the shape here. The SPA is static JS with no PHI at rest, so its edge location is irrelevant. Migration path when you need VPC isolation, Bedrock Sydney, or enterprise procurement: AWS `ap-southeast-2` on ECS Fargate. |
| **Payments** | **None in v1.** Build `entitlements` + the usage cap; Stripe (AUD, Australian entity) deferred to phase 2 | See §5.2. Building the table and the quota read now means adding Stripe — and later Apple IAP — is a new *writer*, not a refactor. The cap is not optional: a free tier over a metered AI pipeline is an open tab. |
| **Observability** | Structured JSON logs, OpenTelemetry traces, Sentry-equivalent with **PII scrubbing on by default** | Error tracking is a subprocessor. Scrub aggressively, send IDs not content, and put it on the register. |
| **CI** | GitHub Actions: typecheck, lint, unit, integration against ephemeral Postgres, and a **public-bucket assertion** | The bucket check is a one-line test that would have prevented a large share of real-world health data breaches. |

### 5.2 Entitlements, the usage cap, and the payments seam

v1 ships **free**, with no checkout. But free over a metered AI pipeline is an open tab: at ~$0.22 per audio-hour, one enthusiastic user uploading 100 hours costs $22 and generates no billing signal to notice it by. So the quota machinery ships in v1 even though the paywall does not — and it is the same machinery the paid tier will use, so none of it is throwaway.

**The table, built now:**

```
entitlements (
  org_id, plan, status,
  source        enum('none','stripe','apple','google','manual'),
  external_ref  text,          -- stripe sub id | apple original_transaction_id
  audio_seconds_per_period int,   -- the cap. free tier default: 36000 (10 hours)
  period_start, current_period_end timestamptz,
  ...
)
```

Signup creates a `plan='free', source='none'` row. **Every authorisation and quota check in the app reads `entitlements`. Nothing ever calls Stripe to ask whether a user is paid.** In phase 2 the Stripe webhook becomes one writer to this table; in phase 4 Apple in-app purchase (via RevenueCat or StoreKit Server Notifications) becomes a second. Neither changes a single read.

Why the abstraction matters even before there is money: Apple generally requires digital subscriptions consumed inside an iOS app to go through in-app purchase. The post-*Epic* US external-link carve-out exists but is jurisdiction-specific and has already moved more than once — do not architect on the assumption it is permanent. Do **not** integrate RevenueCat or StoreKit now.

**Usage accounting — `usage_ledger`, not a `SUM` over recordings.**

Counting current usage by summing `recordings.duration_ms` has an obvious hole: delete a recording, get your quota back, repeat forever. Instead, every processed recording writes an immutable ledger row that **survives deletion of the recording itself**:

```
usage_ledger(id, org_id, recording_id, period_ym, audio_seconds, created_at)
```

Quota remaining = `entitlements.audio_seconds_per_period − SUM(usage_ledger.audio_seconds WHERE period_ym = current)`. The ledger holds no content, so it is unaffected by deletion and retention rules.

**Three enforcement points, because the client cannot be trusted:**

| Point | Check | Behaviour on failure |
|---|---|---|
| `POST /v1/uploads` | Soft check against the client-supplied `duration_hint` | Reject before upload — pure UX, saves a pointless 400 MB transfer. Never the real gate. |
| `audio-qc` worker | **Hard check** against the server-probed actual duration | `failed_quota_exceeded`, **purge the audio immediately** (never hold audio you will not process), surface a clear message |
| In-flight concurrency | Max 3 recordings in a non-terminal state per org | Reject with `429` — stops burst abuse while quota is still being computed |

**Plus a platform-level circuit breaker.** A configured monthly ceiling on total platform audio-hours; crossing it stops accepting new uploads and alerts. Cheap insurance for a free beta where you have no billing signal to watch. Per-recording duration is separately capped at 3 hours.

Signup is magic-link verified, which raises the cost of trivial multi-account abuse. Don't build more than that for a beta.

### 5.3 The RLS honesty note

Supabase RLS is a real security asset, but it is bypassed by the service-role key that a server-side Fastify API would normally use. Pretending otherwise is how teams end up with the appearance of database-level isolation and none of the substance.

The recommendation:
- Keep RLS **enabled and correct** on every table holding personal information, written as if clients connected directly.
- Have the API pass the user's JWT through to Postgres (`SET LOCAL role`/`request.jwt.claims`) on request-scoped connections so RLS actually applies to normal traffic.
- Reserve the service-role key for the worker and for explicitly-marked admin paths, all of which write to `audit_log`.
- Enforce tenant scoping in a **single data-access module** as well. Belt and braces, because the cost of being wrong here is a health data breach.

### 5.4 Repository layout

```
/apps
  /api        Fastify, REST /v1, OpenAPI generated from Zod
  /worker     pg-boss consumers: transcribe, suggest-speakers, extract, export, purge
  /web        Vite + React SPA
/packages
  /shared     Zod schemas, generated API client types, output envelope, status enums
  /providers  TranscriptionProvider implementations (assemblyai, deepgram, whisperx-stub)
  /templates  domain template definitions + JSON schemas + prompts
/evals        golden sets + grader + scores
/docs         DESIGN.md, HANDOFF.md, SUBPROCESSORS.md, INCIDENT-RESPONSE.md
/infra        migrations, fly.toml, GH Actions
```

---

## 6. Mobile / App Store (informs today's decisions only)

**API-first is the whole requirement.** Every capability goes through `/v1`. No logic lives in the web app that the API cannot perform. The OpenAPI spec generated from the Fastify schemas is the mobile contract. JWT bearer + refresh, never cookie sessions. This is already satisfied by §5.1 — the SPA choice exists largely to enforce it.

**Framework, when the time comes:**

| Option | Picks it if |
|---|---|
| **React Native + Expo** | Upload-and-view stays the core interaction. Shares Zod schemas, types and validation with web; one team, one language. **Most likely right.** |
| **Flutter** | You want maximum UI consistency across iOS/Android and are willing to maintain a second language and a duplicated client model layer. |
| **Native Swift/SwiftUI** | Live background recording becomes the core product — call interruption handling, background audio modes, battery behaviour and Files integration are materially better native. |

The deciding question is therefore **"does live recording become core?"**, which you will know by the end of phase 3. Until then Expo is the default.

**Apple constraints that affect architecture *now*:**

1. **Guideline 1.4.1 — health scrutiny.** Medical apps get reviewed harder; apps that could be used for diagnosing or treating patients face extra scrutiny, must not make unsupportable accuracy claims, and should remind users to consult a doctor. → The `disclaimers[]` array in the output envelope (§3.2, §4.5) must exist from v1 so the disclaimer is structurally present on web, PDF and mobile, not bolted on at submission time.
2. **Guideline 3.1.1 — in-app purchase.** → The entitlements abstraction in §5.2. Build it now; integrate Apple later.
3. **Privacy Nutrition Label.** Health data + audio recordings is the most scrutinised disclosure category, and the label must be accurate per data type and linkage. → The subprocessor register (§4.2) is the source of truth for this. Keep it current from commit one; reconstructing it at submission time is how apps get rejected.
4. **Guideline 5.1.1(v) — in-app account deletion** is mandatory for apps with account creation. → `DELETE /v1/me` with a genuine purge cascade, built properly in v1, not stubbed. It is also APP 11.2 compliance, so it pays for itself twice.
5. **Microphone permission strings and background audio mode** — only relevant once live recording ships, but worth knowing the Info.plist usage description must describe the actual use specifically.

---

## 7. Deliverables

### 7.1 System architecture

```
┌──────────────┐        ┌──────────────────────────────────────────────┐
│  Web SPA     │        │  Cloudflare Pages (static, no PHI)           │
│  React/Vite  │◄───────┤                                              │
└──────┬───────┘        └──────────────────────────────────────────────┘
       │ HTTPS, JWT bearer
       ▼
┌────────────────────────────────────────────────────────────────┐
│  API — Fastify /v1              Fly.io  syd  (Sydney)          │
│  authz · validation · presigned URLs · OpenAPI · webhooks      │
└───┬─────────────┬───────────────────────────┬──────────────────┘
    │ enqueue     │ read/write                │ signed PUT/GET
    │ (txn)       ▼                           ▼
    │     ┌──────────────────┐        ┌────────────────────┐
    │     │ Supabase Postgres│        │ Supabase Storage   │
    │     │ ap-southeast-2   │        │ ap-southeast-2     │
    │     │ + Auth + RLS     │        │ vm-audio-au        │
    │     │ + pg-boss queue  │        │ SSE, 15-min URLs   │
    │     └──────────────────┘        └────────────────────┘
    ▼
┌────────────────────────────────────────────────────────────────┐
│  Worker  (Fly.io syd, separate process group)                  │
│   audio-qc → transcribe → suggest-speakers → extract           │
│            → render-export → purge-audio (scheduled)           │
└───┬───────────────────────────────────────┬────────────────────┘
    │ signed audio URL                      │ transcript text
    ▼                                       ▼
┌───────────────────────┐        ┌──────────────────────────────┐
│ AssemblyAI (US/EU)    │        │ Anthropic API                │
│ ASR + diarization     │        │ Sonnet 5  → extraction       │
│ ── webhook ──────────►│        │ Haiku 4.5 → speaker labels   │
│ CROSS-BORDER (APP 8)  │        │ CROSS-BORDER (APP 8)         │
└───────────────────────┘        └──────────────────────────────┘

entitlements ◄── quota reads (v1)    ◄── Stripe webhook (phase 2) ◄── Apple IAP (phase 4)
```

**Flow:** client requests an upload slot → API creates `recordings` row + presigned PUT → client uploads directly to storage (never through the API) → client calls `/complete` → API transactionally enqueues `audio-qc` → worker chain runs → AssemblyAI calls back to a signature-verified webhook → worker extracts with Sonnet 5 → status reaches `ready` → the polling client sees it.

**Residency boundary:** everything at rest is in Sydney. Two egress points cross the border, both named on the subprocessor register, both covered by consent + DPA, both replaceable behind an interface.

**Quota boundary:** `audio-qc` is the only place the real usage decision is made, because it is the first point at which the server knows the actual duration. Everything upstream of it is advisory.

### 7.2 Data model

```sql
-- Tenancy. For B2C, signup auto-creates a personal org. This is the clinic stub.
organisations(
  id uuid pk, name text, kind enum('personal','clinic') default 'personal',
  data_region text default 'au' not null,        -- the US/HIPAA seam
  retention_days int default 730,
  audio_retention_days int default 7,
  created_at, deleted_at)

users(id uuid pk /* = supabase auth.users.id */, email citext unique,
      display_name,
      state_territory text,                        -- NSW|VIC|QLD|SA|WA|TAS|NT|ACT. Default for
                                                   -- recordings.recorded_in_state. No address, no
                                                   -- postcode — see §4.6 and APP 3 minimisation.
      created_at, deleted_at)

memberships(id, org_id fk, user_id fk, role enum('owner','admin','member','viewer'),
            created_at, unique(org_id,user_id))

recordings(
  id uuid pk, org_id fk, owner_user_id fk,
  title text, domain_template_key text not null default 'medical_visit',
  status text not null,                          -- see §3.3 state machine
  failure_reason text,
  storage_bucket text, storage_key text, content_type text,
  byte_size bigint, duration_ms int, checksum_sha256 text,
  recorded_at timestamptz,
  -- Recording-consent evidence (§4.6). Jurisdiction follows the conversation,
  -- not the uploader, so this is per-recording and pre-filled from the profile.
  recorded_in_state text not null,
  consent_disclaimer_state text not null,
  consent_disclaimer_version int not null,
  consent_attested_at timestamptz not null,
  audio_delete_at timestamptz, audio_deleted_at timestamptz,
  created_at, updated_at, deleted_at)

recording_events(id, recording_id fk, from_status, to_status,
                 detail jsonb, created_at)       -- pipeline timeline / debugging

transcripts(id, recording_id fk unique, provider text, provider_job_id text,
            language_code text, provider_raw jsonb, created_at)

transcript_segments(
  id, transcript_id fk, idx int not null,        -- the target of segment_refs
  speaker_key text not null, start_ms int, end_ms int,
  text text, confidence real,
  unique(transcript_id, idx))

speakers(
  id, transcript_id fk, speaker_key text not null,
  suggested_label text, suggested_role text, suggested_confidence real,
  display_label text, role text,                 -- clinician|patient|interpreter|carer|other
  confirmed_by_user_id fk null, confirmed_at timestamptz null,
  unique(transcript_id, speaker_key))

domain_templates(
  key text, version int, name text, description text,
  system_prompt text, output_schema jsonb, section_manifest jsonb,
  speaker_roles text[], disclaimers text[], is_active bool,
  primary key(key, version))

outputs(
  id, recording_id fk, template_key text, template_version int,
  model text, envelope_version int,
  content jsonb not null,                        -- the output envelope
  content_markdown text,
  validation_status enum('validated','partially_validated','failed'),
  dropped_items jsonb,                           -- ungrounded items the validator removed
  input_tokens int, output_tokens int, cache_read_tokens int,
  superseded_by uuid null fk outputs(id),
  created_at)

action_items(
  id, output_id fk, idx int, text text,
  owner_hint text, due_hint text,
  segment_refs int[] not null,
  completed_at timestamptz null, edited_text text)

consents(                                        -- account-level consents
  id, user_id fk, org_id fk,
  type enum('terms','privacy','overseas_disclosure'),
  version text not null, granted_at, ip inet, user_agent text, revoked_at)

jurisdiction_disclaimers(                        -- per-upload recording-consent copy
  state_code text,                               -- NSW|VIC|QLD|SA|WA|TAS|NT|ACT
  version int,
  body_markdown text not null,                   -- what the law requires in that state
  acknowledgement_label text not null,           -- the exact checkbox wording
  is_active bool,
  created_at,
  primary key(state_code, version))              -- copy is lawyer-drafted; versions are immutable

entitlements(
  id, org_id fk unique, plan text, status text,  -- v1: plan='free', source='none'
  source enum('none','stripe','apple','google','manual'), external_ref text,
  audio_seconds_per_period int not null default 36000,   -- 10 hours; the v1 cap
  period_start timestamptz, current_period_end timestamptz,
  created_at, updated_at)

usage_ledger(                                    -- immutable; survives recording deletion
  id, org_id fk, recording_id uuid,              -- NOT a FK: the recording may be purged
  period_ym text not null,                       -- 'YYYY-MM'
  audio_seconds int not null, created_at,
  index(org_id, period_ym))                      -- holds no content, so retention rules don't touch it

audit_log(
  id, org_id, actor_user_id, actor_kind enum('user','worker','admin','system'),
  action text,                                   -- audio.read, transcript.read, output.export...
  resource_type text, resource_id uuid,
  ip inet, user_agent text, break_glass bool default false,
  created_at)                                    -- retain 7 years

shares(                                          -- phase 2
  id, output_id fk, token_hash text, expires_at, revoked_at,
  created_by fk, view_count int)
```

**Notes on the shape.**
`key_points` live inside `outputs.content` because they are read-only prose. `action_items` are a real table because they get checked off, edited and queried across recordings — they have a lifecycle of their own. `transcript_segments.idx` is the grounding anchor: `segment_refs` in the output envelope are indices into it, which is what lets the UI jump from "Dr Chen said to halve the dose" to 14:32 in the transcript. `organisations.data_region` exists on day one even though every row says `'au'`, because backfilling a region column across health records later is exactly the kind of migration nobody wants to run.

Two tables exist purely to make something provable. `jurisdiction_disclaimers` is versioned and immutable so that, for any recording, you can reconstruct the exact consent wording the user was shown on the day they uploaded it — a `consents` row that merely says "attested" proves very little. `usage_ledger` is deliberately not a `SUM` over `recordings`, because a user who can delete a recording to reclaim quota has no quota; it stores durations only, no content, so purging a recording never touches it.

**Output envelope** (`outputs.content`, common to all domains):

```jsonc
{
  "envelope_version": 1,
  "summary": "string (plain language, grade 8 reading level)",
  "key_points": [{ "text": "...", "segment_refs": [12, 13] }],
  "action_items": [{ "text": "...", "owner_hint": "you"|"clinic"|null,
                     "due_hint": "within 2 weeks"|null, "segment_refs": [41] }],
  "sections": [{ "key": "medications_discussed", "title": "Medications discussed",
                 "body_markdown": "...", "segment_refs": [22, 24, 25] }],
  "disclaimers": ["This is a summary of what was said in your appointment. It is not medical advice..."],
  "confidence_notes": ["Audio was unclear between 12:10 and 12:40."]
}
```

### 7.3 API contract

REST, `/v1`, JSON, JWT bearer. Errors as RFC 9457 `application/problem+json`. Cursor pagination. `Idempotency-Key` accepted on all POSTs.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/me` | User, orgs, memberships, entitlements, outstanding consents |
| `DELETE` | `/v1/me` | Account deletion + purge cascade (Apple 5.1.1(v), APP 11.2) |
| `POST` | `/v1/consents` | `{type, version}` → records consent with IP/UA |
| `GET` | `/v1/templates` | Active domain templates + section manifests |
| `GET` | `/v1/jurisdictions/{state}/disclaimer` | Active disclaimer body + acknowledgement label + version for a state |
| `GET` | `/v1/usage` | `{period_ym, audio_seconds_used, audio_seconds_limit, in_flight_count}` |
| `POST` | `/v1/uploads` | `{filename, content_type, byte_size, duration_hint, template_key, recorded_in_state, consent_disclaimer_version, consent_attested: true}` → `{recording_id, upload_url, expires_at}`. Soft quota check. |
| `POST` | `/v1/recordings/{id}/complete` | `{checksum_sha256}` → validates object, enqueues pipeline, `202` |
| `GET` | `/v1/recordings` | List. `?status=&template_key=&cursor=&limit=` |
| `GET` | `/v1/recordings/{id}` | **Poll target.** `{status, progress_pct, failure_reason, duration_ms, latest_output_id, speakers_confirmed}` |
| `PATCH` | `/v1/recordings/{id}` | Rename, change template (triggers regeneration) |
| `DELETE` | `/v1/recordings/{id}` | Soft-delete + immediate audio purge + cascade |
| `GET` | `/v1/recordings/{id}/transcript` | `{segments[], speakers[]}`. `?format=json|text` |
| `GET` | `/v1/recordings/{id}/speakers` | Speaker list with suggestions and confirmation state |
| `PATCH` | `/v1/recordings/{id}/speakers` | Bulk: `[{speaker_key, display_label, role}]` → confirms and enqueues regeneration |
| `POST` | `/v1/recordings/{id}/outputs` | `{template_key?, template_version?}` → `202`, generates a new version |
| `GET` | `/v1/recordings/{id}/outputs` | Version history, newest first |
| `GET` | `/v1/outputs/{id}` | Full output envelope |
| `PATCH` | `/v1/outputs/{id}/action-items/{aid}` | `{completed?, edited_text?}` |
| `POST` | `/v1/outputs/{id}/export` | `{format: 'pdf'\|'markdown'\|'docx'}` → `{url, expires_at}` (sync for md, `202` + poll for pdf) |
| `POST` | `/v1/outputs/{id}/shares` | *Phase 2.* `{expires_in_days}` → `{url}` |
| `POST` | `/v1/webhooks/assemblyai` | Signature-verified provider callback (unauthenticated route, verified by HMAC) |
| ~~`/v1/billing/*`~~ | | **Phase 2.** No checkout in v1 — see §5.2 |

**Polling contract.** `GET /v1/recordings/{id}` is cheap (single indexed row read, no joins into segments). Client polls every 2s while status is non-terminal, backing off to 5s after 60s, 15s after 5min. Server sends `Retry-After` on `202` responses. When status reaches `ready` or a `failed_*`, the client stops.

**Upload contract.** Audio never transits the API — the client PUTs directly to storage with a presigned URL. This keeps the API tier small and stateless and means a 400 MB upload doesn't occupy an API worker for minutes.

**Consent contract.** `POST /v1/uploads` rejects with `422` unless `recorded_in_state`, a `consent_disclaimer_version` that is *currently active for that state*, and `consent_attested: true` are all present. The server does not accept a stale or mismatched disclaimer version — if the copy changed between page load and submit, the client re-fetches and re-prompts. This is the whole point of versioning it.

### 7.4 Phased roadmap

**Phase 0 — prep (before code).** Supabase project in `ap-southeast-2`. AssemblyAI account + DPA + no-training setting. Anthropic org + zero-data-retention request. Privacy policy, ToS, overseas-disclosure consent copy, and **per-jurisdiction recording-consent copy for all eight states/territories** drafted — and lawyer-reviewed before real patients. (Stripe AU entity moves to phase 2.) `docs/SUBPROCESSORS.md` + `docs/INCIDENT-RESPONSE.md` written.

**Phase 1 — MVP. This is v1.**
Auth (email + magic link) · personal org auto-created on signup · state/territory on profile · account consent capture (terms, privacy, overseas disclosure) · **per-upload jurisdiction disclaimer + consent attestation** · upload mp3/m4a/wav/aac/ogg/flac (≤3h, ≤500MB) · audio QC gate · **free-tier usage cap with `usage_ledger`, three enforcement points and a platform circuit breaker** · AssemblyAI transcription + diarization · Haiku speaker suggestions · speaker relabel UI · **`medical_visit` template only** · Sonnet 5 extraction with grounding validator · summary / key points / action items / sections view with click-to-transcript · action item checkboxes · PDF + Markdown + copy export · delete recording (audio purge) · delete account · audit log · scheduled audio purge job · eval harness with the medication gate.

*No checkout in v1.* `entitlements` is built and read on every upload; it just has no paid writer yet.

**Phase 2 — breadth and money.** **Stripe checkout + customer portal + webhook writing to `entitlements`** (the quota read is already there; this adds a writer) · `meeting`, `lecture`, `personal` templates + picker · template switching with regeneration · share links with expiry and revocation — *this is also the carer story, see below* · transcript search across recordings · transcript inline editing · email delivery of finished summaries.

**Phase 3 — capture and tenancy.** Live recording on **web** (`MediaRecorder`, chunked upload, resumable) · clinic tenancy UI (invites, roles, patient records under an org) · **delegated carer access, if the beta shows demand share links don't satisfy** · state health records act review · envelope encryption for audio.

**Phase 4 — mobile.** Expo React Native consuming the existing `/v1` · Apple IAP via RevenueCat writing to `entitlements` · Privacy Nutrition Label from the subprocessor register · App Review submission with disclaimer evidence.

**Phase 5 — scale and residency.** Self-hosted WhisperX+pyannote on `ap-southeast-2` GPU *or* Deepgram AU (whichever the §7.5 crossover and any residency tightening dictates) · Claude via Bedrock Sydney for in-country inference · US region + BAAs · multilingual.

**Explicitly out of v1:** payments/checkout, live recording, multi-domain templates, sharing, delegated carer access, clinic tenancy UI, mobile, multilingual, EHR/My Health Record integration, any clinical inference.

### 7.5 Cost model (AI layer)

**Assumptions.** USD. A 30-minute consultation ≈ 8,000 input tokens after speaker labels and timestamps (≈16,000 for an hour). Summary output ≈ 1,500 tokens. Prompt caching on a ~2,000-token template prefix. Haiku speaker pass reads the transcript head only.

**Per audio-hour:**

| Component | Rate | Cost |
|---|---|---|
| AssemblyAI Universal-2 + diarization | $0.17 / audio-hour | **$0.170** |
| Sonnet 5 input | 16,000 tok × $2/MTok | $0.032 |
| Sonnet 5 output | 1,500 tok × $10/MTok | $0.015 |
| Haiku 4.5 speaker pass | ~2,000 in / 200 out | $0.003 |
| **Total** | | **≈ $0.22 per audio-hour** |

A typical 30-minute consultation therefore costs **≈ $0.11** in AI spend.

**Volume tiers (monthly):**

| Audio-hours/mo | ≈ 30-min recordings | Transcription | LLM | **Total** |
|---|---|---|---|---|
| 50 | 100 | $8.50 | $2.50 | **≈ $11** |
| 500 | 1,000 | $85 | $25 | **≈ $110** |
| 5,000 | 10,000 | $850 | $250 | **≈ $1,100** |
| 25,000 | 50,000 | $4,250 | $1,250 | **≈ $5,500** |

**Free-tier exposure (v1).** With a 10 audio-hour monthly cap, the worst case is **≈ US$2.20 per fully-saturated account per month**. Realistically most beta users will use well under an hour. Useful ceilings to hold in mind:

| Beta accounts | If every account maxed the cap | Realistic (≈1 hr/account/mo) |
|---|---|---|
| 50 | $110/mo | $11/mo |
| 250 | $550/mo | $55/mo |
| 1,000 | $2,200/mo | $220/mo |

The per-account cap bounds the tail; the platform circuit breaker (§5.2) bounds the total. Set the breaker at a number you are willing to see on a card — for a beta, somewhere around $300–500/month of audio — and revisit it rather than raising it reflexively.

**Margin sanity check for when pricing arrives.** At A$15/month for a plan covering four 30-minute recordings (2 audio-hours), COGS is ≈ US$0.44 ≈ A$0.67. AI cost is not the constraint on this business; customer acquisition is. That is worth knowing before optimising the pipeline.

**Self-hosting crossover.** A `g5.xlarge`-class GPU in `ap-southeast-2` is roughly $875/month always-on. At 25–30× realtime, that is ~18,000 audio-hours of theoretical capacity — but real utilisation on bursty consumer traffic is 20–40%, so plan on 4,000–7,000 usable hours. Against $0.17/hr managed, the **break-even sits around 3,000–5,000 audio-hours/month**, and that ignores the DevOps time, which pushes the honest crossover later still. Revisit when you are sustaining ~5,000 audio-hours/month, or sooner if residency tightens — at which point self-hosting solves two problems at once and the calculation changes.

**Other cost levers, in order:**
1. Prompt caching on the template prefix (free, already in the design).
2. Batch API at 50% off for backfills and bulk re-templating (not the interactive path).
3. `output_config.effort` tuned down against the eval set — measure before assuming.
4. Reject bad audio at the QC gate before spending on transcription.
5. Only then consider self-hosting.

### 7.6 Principal risks

| Risk | Mitigation |
|---|---|
| Diarization errors on overlapping consultation speech | Relabel UI is in v1, not deferred; low-confidence banner; `confidence_notes` in the envelope |
| Poor audio (phone in a pocket, noisy waiting room) | Audio QC gate before transcription — duration, sample rate, silence ratio, clipping — warn and refuse rather than deliver a bad summary |
| Hallucinated medications or advice | Strict structured output + `segment_refs` grounding validator + medication gate in the eval harness |
| Cross-border disclosure challenged | Consent + DPA both in place; versioned consent records; subprocessor register |
| Recording made unlawfully by the user | Onboarding education, per-upload attestation, terms clause (§4.6) |
| Scope creep into clinical advice | The §4.5 scope rule enforced in prompt, validator and disclaimer |
| Long uploads blowing cost | 3-hour per-recording cap; per-account quota read from `entitlements` |
| **Free tier abused or simply over-used** | 10-hour monthly cap enforced on server-probed duration; `usage_ledger` immune to delete-and-retry; 3 concurrent in-flight limit; platform-wide circuit breaker; magic-link verified signup |
| User acknowledges consent without it being true | The attestation is per-upload, jurisdiction-specific and version-stamped — it shifts responsibility and is provable, which is the realistic goal. It is not, and cannot be, verification. |
| Buyer never materialises | Narrow the ICP per pushback 1 before scaling spend |

---

## 8. Open questions for the product owner

Resolved in this pass: residency posture, v1 buyer, ops appetite, languages, recording-consent mechanism, address scope, carer access, billing shape. What remains:

1. **Legal review gate.** The per-jurisdiction recording-consent copy, privacy policy, overseas-disclosure consent and ToS all need an Australian privacy lawyer. The engineering question is only *when*: before a closed beta on synthetic/own-recordings, or before the first real patient recording. Recommendation: build and test against placeholder copy, get the review before any third party's voice is uploaded.
2. **Transcript visible by default, or summary only?** Recommendation: **visible**. Click-to-source is the product's trust mechanism and it is hard to have one without the other. Flagging it because it changes the answer to "who can see raw health information", which the privacy policy has to state.
3. **Free-tier cap number.** 10 audio-hours/month is a starting guess (≈US$2.20/account worst case). Watch actual beta usage for a month and set it from data — the mechanism doesn't change, only the integer.
4. **Does the beta need an invite gate?** Free with no card is the least-friction way to get users and the least-friction way to get abused. An invite code is ~2 hours of work and would let you skip some of the circuit-breaker anxiety. Worth deciding before launch, not before build.
5. **Product name.** `Voice-Memo` is the repo. Worth settling before the App Store phase, since the bundle identifier and the privacy policy URL both want to be stable.
