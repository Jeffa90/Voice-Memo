# Voice-Memo

Turns recorded conversations into structured, useful text.

The first use case is patients: upload a recording of a medical consultation and
get back a plain-language summary, key points, action items, and a
speaker-labelled transcript. Under the hood nothing is medical — the same
`upload → transcribe → diarize → extract` pipeline extends to meetings, lectures
and personal voice notes, with "domain" as a template layer on top.

## Status

Design pass complete. Implementation not started.

## Documentation

| Document | Purpose |
|---|---|
| [`docs/DESIGN.md`](docs/DESIGN.md) | Full system design: product framing, AI pipeline and vendor selection, Australian privacy compliance, tech stack, data model, API contract, roadmap, cost model |
| [`docs/HANDOFF.md`](docs/HANDOFF.md) | Self-contained build spec — decisions, non-negotiable rules, API surface |
| [`docs/BUILD-PLAN.md`](docs/BUILD-PLAN.md) | Sequenced ticket backlog for v1, with dependencies and acceptance criteria |

`DESIGN.md` is the reasoning, `HANDOFF.md` is the spec, `BUILD-PLAN.md` is the work.
To start building, open `BUILD-PLAN.md` and begin at milestone M0.
