# Voice-Memo

Turns recorded conversations into structured, useful text.

The first use case is patients: upload a recording of a medical consultation and
get back a plain-language summary, key points, action items, and a
speaker-labelled transcript. Under the hood nothing is medical — the same
`upload → transcribe → diarize → extract` pipeline extends to meetings, lectures
and personal voice notes, with "domain" as a template layer on top.

## Status

**Running.** Backend deployed to Supabase (Sydney), web app builds and deploys to Vercel.
Personal-use core is complete: sign in, upload, transcribe with speakers, relabel,
plain-language summary with action items and click-to-transcript, export, delete.

Start at [`docs/SETUP.md`](docs/SETUP.md) — about 10 minutes of configuration.

## Documentation

| Document | Purpose |
|---|---|
| [`docs/DESIGN.md`](docs/DESIGN.md) | Full system design: product framing, AI pipeline and vendor selection, Australian privacy compliance, tech stack, data model, API contract, roadmap, cost model |
| [`docs/HANDOFF.md`](docs/HANDOFF.md) | Self-contained build spec — decisions, non-negotiable rules, API surface |
| [`docs/BUILD-PLAN.md`](docs/BUILD-PLAN.md) | Sequenced ticket backlog for v1, with dependencies and acceptance criteria |
| [`docs/SETUP.md`](docs/SETUP.md) | **Start here.** What's deployed, the secrets to set, connecting Vercel, and the known gaps |

`SETUP.md` gets it running. `DESIGN.md` is the reasoning, `HANDOFF.md` is the spec,
`BUILD-PLAN.md` is the remaining work.

## Layout

```
supabase/migrations/   schema, RLS, seed data
supabase/functions/    api (REST) and process (pipeline + provider callback)
  _shared/providers.ts the only file that knows a transcription vendor exists
web/                   Vite + React SPA
docs/                  design, build plan, setup
```
