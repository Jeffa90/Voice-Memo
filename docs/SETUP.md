# Setup — getting Voice Memo running

Infrastructure is already provisioned and the backend is already deployed. What
follows is the part I could not do from here: setting secrets (I have no tool that
can, which is the right outcome — a key pasted into a chat lives in that transcript
forever) and connecting Vercel.

Budget about 10 minutes.

## What already exists

| Thing | Value |
|---|---|
| Supabase project | `voice-memo` — ref `fowtgumnirjklfdonddk` |
| Region | `ap-southeast-2` (Sydney) — all data at rest stays here |
| Database | 16 tables, RLS on every one, seeded template and disclaimers |
| Storage bucket | `vm-audio-au` — private, 500 MB cap, audio MIME types only |
| Edge functions | `api` (JWT-verified) and `process` (pipeline + provider callback) |
| Project URL | `https://fowtgumnirjklfdonddk.supabase.co` |

---

## 1. Set the function secrets

**Dashboard → Project Settings → Edge Functions → Secrets** (or Functions → Secrets),
then add:

| Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | Your key from console.anthropic.com |
| `TRANSCRIPTION_PROVIDER` | `stub` to start with — see below |
| `ASSEMBLYAI_API_KEY` | Your key from assemblyai.com (only needed once you switch off the stub) |
| `ASSEMBLYAI_WEBHOOK_SECRET` | A random string you generate: `openssl rand -hex 32` |

**Start with `TRANSCRIPTION_PROVIDER=stub`.** The stub returns a realistic
three-speaker consultation transcript instantly, so you can watch the whole
pipeline work — speaker suggestions, summary, action items, click-to-transcript —
without spending a cent on transcription or waiting minutes per attempt. It also
means that if something breaks, you know it isn't AssemblyAI.

Once that works end to end, change the secret to `assemblyai` and upload a real
recording. Nothing else changes.

> While the stub is on, whatever audio you upload is stored and ignored — the
> transcript is canned. That is the point: it isolates the pipeline from the
> provider.

## 2. Point auth at your app

**Dashboard → Authentication → URL Configuration:**

- **Site URL**: your Vercel URL once you have it (step 3), e.g. `https://voice-memo.vercel.app`
- **Redirect URLs**: add both
  - `http://localhost:5173/**`
  - `https://<your-vercel-domain>/**`

Sign-in is a magic link, so if these are wrong the email link will bounce you to
the wrong place. This is the single most common thing to get wrong.

## 3. Connect Vercel

1. vercel.com → **Add New → Project** → import `Jeffa90/Voice-Memo`
2. **Root Directory**: `web`  ← the only setting you must change
3. Framework preset: Vite (auto-detected). Build command and output directory are correct by default.
4. Deploy.

No environment variables needed. The Supabase URL and publishable key are baked
into the code as defaults — the publishable key is public by design and every
table is protected by row level security, so it is safe in a client bundle. Set
`VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` only if you ever point the app at
a different project.

Every push to the repo redeploys automatically from here on.

## 4. Run it locally (optional)

```bash
cd web
npm install
npm run dev      # http://localhost:5173
```

Talks to the same live Sydney project.

---

## First run

1. Open the app, enter your email, click the link.
2. Settings → set your state or territory.
3. Back to the dashboard, pick any audio file.
4. Choose the state, read the consent notice, tick the box.
5. Upload.

With the stub you should reach a finished summary in roughly 30 seconds. Expected
sequence: `Queued → Transcribing → Working out who's who → Check the speakers →
Writing your summary → Ready`.

Then try the two things the product is actually for:

- **Confirm the speakers.** The names change and the summary gets rewritten with them.
- **Click "hear it"** next to any key point or action item. It jumps to the exact
  moment in the transcript. That traceability is the whole trust model — every
  claim is tied to a transcript segment, and anything that isn't gets deleted
  before you ever see it.

## If something goes wrong

Recordings carry their failure on the card, and every state change is recorded.

```sql
-- the pipeline's own timeline for a recording
select to_status, detail, created_at
from recording_events
where recording_id = '<id>'
order by created_at;
```

Edge function logs are under **Dashboard → Functions → api / process → Logs**.

I can read both of those through my Supabase connection, so if a run fails, tell
me and I'll look. I can't reach the deployed URL myself — this container's egress
policy blocks `*.supabase.co` — so the first end-to-end run has to be you clicking
it while I watch the logs and the database.

---

## Before anyone else's voice goes in

Fine for your own recordings. Required before a third party's:

1. **Replace the placeholder consent copy.** Every row in `jurisdiction_disclaimers`
   is marked `[PLACEHOLDER - NOT LEGAL COPY]` and must be drafted or reviewed by an
   Australian lawyer. The table structure is done; the words are not mine to write.
2. **Privacy policy, terms, and the overseas-disclosure consent screen** — none of
   which exist yet. `DESIGN.md` §4 says what they have to cover.
3. **Execute a DPA with AssemblyAI** with no-training enabled, and request
   zero-data-retention from Anthropic for your org.
4. **Write the incident response runbook** (`docs/INCIDENT-RESPONSE.md`) — the
   Notifiable Data Breaches scheme requires you to have one, not to write one
   after the fact.

## Known gaps in this build

Honest list of what is not there yet:

- **No server-side audio QC.** Deno's edge runtime can't run `ffprobe`, so duration
  is read in the browser and reconciled against what the provider reports. Usage
  is booked from the real duration, so the ledger is accurate — but a bad file is
  only detected when transcription fails, not before. `DESIGN.md` §5 covers the
  Fastify/Fly path that fixes this properly.
- **No PDF export.** Markdown export works; PDF is phase 2.
- **No evals.** The medication-fidelity gate in `BUILD-PLAN.md` M10 is not built.
  Until it is, treat every medication detail in a summary as unverified.
- **Edge functions execute outside Sydney** even though all data at rest is in
  Sydney. Acceptable for personal use, and a reason to move to Fly.io `syd` if this
  ever serves other people.
