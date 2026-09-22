import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  api, fmtTime, STATUS_LABEL, TERMINAL,
  type Output, type Recording, type Segment, type Speaker,
} from "../lib/api";

const ROLES = ["clinician", "patient", "interpreter", "carer", "other"];

export default function RecordingPage() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const [rec, setRec] = useState<Recording | null>(null);
  const [out, setOut] = useState<Output | null>(null);
  const [segs, setSegs] = useState<Segment[]>([]);
  const [speakers, setSpeakers] = useState<Speaker[]>([]);
  const [tab, setTab] = useState<"summary" | "transcript">("summary");
  const [hit, setHit] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const delay = useRef(2000);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const r = await api.recording(id);
      setRec(r);
      if (r.has_transcript && segs.length === 0) {
        const t = await api.transcript(id);
        setSegs(t.segments);
      }
      if (r.has_transcript) {
        const s = await api.speakers(id);
        setSpeakers(s.speakers);
      }
      if (r.latest_output_id && r.latest_output_id !== out?.id) {
        setOut(await api.output(r.latest_output_id));
      }
      setErr(null);
    } catch (e) { setErr((e as Error).message); }
  }, [id, out?.id, segs.length]);

  useEffect(() => { load(); }, [id]);

  // Back off as the wait gets longer: 2s, then 5s after a minute, then 15s.
  useEffect(() => {
    if (!rec || TERMINAL.includes(rec.status)) return;
    const started = Date.now();
    const tick = () => {
      const age = Date.now() - started;
      delay.current = age > 300_000 ? 15_000 : age > 60_000 ? 5_000 : 2_000;
      load();
    };
    const t = setInterval(tick, delay.current);
    return () => clearInterval(t);
  }, [rec?.status, load]);

  function jump(refs: number[]) {
    if (!refs?.length) return;
    setTab("transcript");
    setHit(refs[0]);
    requestAnimationFrame(() => {
      document.getElementById(`seg-${refs[0]}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }

  async function remove() {
    if (!id || !confirm("Delete this recording, its transcript and its summary? This cannot be undone.")) return;
    await api.deleteRecording(id);
    nav("/");
  }

  if (!rec) return <div className="center">{err ? <div className="notice err">{err}</div> : <span className="spin" />}</div>;

  const working = !TERMINAL.includes(rec.status);
  const needsSpeakers = rec.has_transcript && speakers.some((s) => !s.confirmed_at);

  return (
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        <button className="link" onClick={() => nav("/")}>← All appointments</button>
        <div className="grow" />
        <button className="danger" onClick={remove}>Delete</button>
      </div>

      <h3 style={{ fontSize: 22, letterSpacing: "-0.02em" }}>{rec.title ?? "Appointment"}</h3>
      <div className="small muted" style={{ marginBottom: 16 }}>
        {new Date(rec.recorded_at ?? rec.created_at).toLocaleDateString("en-AU", { dateStyle: "full" })}
        {rec.audio_deleted_at && " · audio deleted"}
      </div>

      {working && (
        <div className="card">
          <div className="row"><span className="spin" /><strong>{STATUS_LABEL[rec.status]}</strong></div>
          <div className="small muted" style={{ marginTop: 6 }}>
            This usually takes a couple of minutes. You can leave this page and come back.
          </div>
        </div>
      )}

      {rec.status.startsWith("failed_") && (
        <div className="notice err">
          <strong>{STATUS_LABEL[rec.status]}</strong>
          {rec.failure_reason && <div className="small" style={{ marginTop: 4 }}>{rec.failure_reason}</div>}
        </div>
      )}

      {needsSpeakers && <Speakers id={id!} speakers={speakers} onSaved={load} />}

      {(out || segs.length > 0) && (
        <>
          <div className="row" style={{ margin: "22px 0 4px" }}>
            <button className={tab === "summary" ? "primary" : ""} onClick={() => setTab("summary")}>Summary</button>
            <button className={tab === "transcript" ? "primary" : ""} onClick={() => setTab("transcript")}>
              Transcript
            </button>
            <div className="grow" />
            {out && <a className="btn" href={api.exportUrl(out.id)}>Export</a>}
          </div>

          {tab === "summary"
            ? (out ? <Summary out={out} onJump={jump} onRefresh={load} /> : <div className="card muted">No summary yet.</div>)
            : <Transcript segs={segs} speakers={speakers} hit={hit} />}
        </>
      )}
    </>
  );
}

function Speakers({ id, speakers, onSaved }: { id: string; speakers: Speaker[]; onSaved: () => void }) {
  const [draft, setDraft] = useState(() =>
    speakers.map((s) => ({
      speaker_key: s.speaker_key,
      display_label: s.display_label ?? s.suggested_label ?? `Speaker ${s.speaker_key}`,
      role: s.role ?? s.suggested_role ?? "other",
    })));
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try { await api.saveSpeakers(id, draft); onSaved(); } finally { setBusy(false); }
  }

  return (
    <div className="card">
      <h3>Who was in the room?</h3>
      <p className="small muted" style={{ marginTop: 0 }}>
        These are suggestions — nothing is confirmed until you say so. Getting the names right
        makes the summary noticeably better.
      </p>
      {speakers.map((s, i) => (
        <div key={s.speaker_key} style={{ borderTop: i ? "1px solid var(--border)" : "none", paddingTop: i ? 12 : 0, marginTop: i ? 12 : 0 }}>
          {s.first_utterance && (
            <div className="small muted" style={{ fontStyle: "italic", marginBottom: 6 }}>
              “{s.first_utterance.slice(0, 120)}{s.first_utterance.length > 120 ? "…" : ""}”
            </div>
          )}
          <div className="row">
            <input className="grow" value={draft[i]?.display_label ?? ""}
                   onChange={(e) => setDraft((d) => d.map((x, j) => j === i ? { ...x, display_label: e.target.value } : x))} />
            <select style={{ width: 140 }} value={draft[i]?.role ?? "other"}
                    onChange={(e) => setDraft((d) => d.map((x, j) => j === i ? { ...x, role: e.target.value } : x))}>
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          {s.suggested_confidence !== null && s.suggested_confidence < 0.7 && (
            <div className="small" style={{ color: "var(--warn)", marginTop: 4 }}>Low confidence — worth checking</div>
          )}
        </div>
      ))}
      <button className="primary" style={{ width: "100%", marginTop: 14 }} disabled={busy} onClick={save}>
        {busy ? <span className="spin" /> : "Confirm and rewrite the summary"}
      </button>
    </div>
  );
}

function Summary({ out, onJump, onRefresh }: { out: Output; onJump: (r: number[]) => void; onRefresh: () => void }) {
  const c = out.content ?? {};
  const [items, setItems] = useState(out.action_items ?? []);
  useEffect(() => setItems(out.action_items ?? []), [out.id]);

  async function toggle(itemId: string, completed: boolean) {
    setItems((xs) => xs.map((x) => x.id === itemId ? { ...x, completed_at: completed ? new Date().toISOString() : null } : x));
    try { await api.toggleActionItem(out.id, itemId, completed); } catch { onRefresh(); }
  }

  return (
    <>
      {out.validation_status === "partially_validated" && (
        <div className="notice">
          Some of what the model wrote could not be traced back to the recording, so it was
          removed rather than shown to you.
        </div>
      )}

      <div className="card"><p style={{ margin: 0 }}>{c.summary}</p></div>

      {!!c.key_points?.length && (
        <>
          <h2>Key points</h2>
          <div className="card">
            {c.key_points.map((k: any, i: number) => (
              <div className="item" key={i}>
                <div className="grow">{k.text}</div>
                <button className="cite" onClick={() => onJump(k.segment_refs)} title="Show where this was said">
                  {k.segment_refs?.length ? "hear it" : ""}
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      {!!items.length && (
        <>
          <h2>What to do</h2>
          <div className="card">
            {items.map((a) => (
              <div className="item" key={a.id}>
                <input type="checkbox" style={{ width: 18, height: 18, flex: "0 0 auto", marginTop: 3 }}
                       checked={!!a.completed_at} onChange={(e) => toggle(a.id, e.target.checked)} />
                <div className="grow" style={{ textDecoration: a.completed_at ? "line-through" : "none", opacity: a.completed_at ? 0.55 : 1 }}>
                  {a.edited_text ?? a.text}
                  {a.due_hint && <span className="small muted"> · {a.due_hint}</span>}
                </div>
                <button className="cite" onClick={() => onJump(a.segment_refs)}>hear it</button>
              </div>
            ))}
          </div>
        </>
      )}

      {(c.sections ?? []).filter((s: any) => s.body_markdown?.trim()).map((s: any) => (
        <div key={s.key}>
          <h2>{s.title}</h2>
          <div className="card md">
            <Body text={s.body_markdown} />
            {!!s.segment_refs?.length && (
              <button className="cite" onClick={() => onJump(s.segment_refs)}>hear it</button>
            )}
          </div>
        </div>
      ))}

      {!!c.confidence_notes?.length && (
        <>
          <h2>Notes on this summary</h2>
          <div className="card small muted">
            {c.confidence_notes.map((n: string, i: number) => <div key={i}>{n}</div>)}
          </div>
        </>
      )}

      <div className="row" style={{ marginTop: 18 }}>
        <button onClick={async () => { await api.regenerate(out.recording_id); onRefresh(); }}>
          Rewrite summary
        </button>
      </div>

      <div className="disclaimer">
        {(c.disclaimers ?? []).map((d: string, i: number) => <p key={i}>{d}</p>)}
        <p className="small">Written by {out.model}.</p>
      </div>
    </>
  );
}

/** Deliberately tiny: paragraphs and bullets only. No markdown dependency. */
function Body({ text }: { text: string }) {
  return (
    <>
      {text.split(/\n{2,}/).map((block, i) => {
        const lines = block.split("\n");
        if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
          return <ul key={i}>{lines.map((l, j) => <li key={j}>{l.replace(/^\s*[-*]\s+/, "")}</li>)}</ul>;
        }
        return <p key={i}>{block}</p>;
      })}
    </>
  );
}

function Transcript({ segs, speakers, hit }: { segs: Segment[]; speakers: Speaker[]; hit: number | null }) {
  const label = (key: string) => {
    const s = speakers.find((x) => x.speaker_key === key);
    return s?.display_label ?? s?.suggested_label ?? `Speaker ${key}`;
  };
  if (!segs.length) return <div className="card muted">No transcript yet.</div>;
  return (
    <div className="card">
      {segs.map((s) => (
        <div key={s.idx} id={`seg-${s.idx}`} className={`seg${hit === s.idx ? " hit" : ""}`}>
          <div className="row" style={{ gap: 8, marginBottom: 2 }}>
            <span className="who">{label(s.speaker_key)}</span>
            <span className="small muted">{fmtTime(s.start_ms)}</span>
          </div>
          <div>{s.text}</div>
        </div>
      ))}
    </div>
  );
}
