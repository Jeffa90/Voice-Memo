import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, fmtDuration, STATUS_LABEL, TERMINAL, type Recording, type Usage } from "../lib/api";
import Upload from "./Upload";

const chipClass = (s: Recording["status"]) =>
  s === "ready" ? "chip ok" : s.startsWith("failed_") ? "chip bad" : "chip busy";

export default function Dashboard() {
  const [recs, setRecs] = useState<Recording[] | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    try {
      const [r, u] = await Promise.all([api.recordings(), api.usage()]);
      setRecs(r.recordings); setUsage(u); setErr(null);
    } catch (e) { setErr((e as Error).message); }
  }

  useEffect(() => { load(); }, []);

  // Poll only while something is actually in flight.
  useEffect(() => {
    if (!recs?.some((r) => !TERMINAL.includes(r.status))) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [recs]);

  return (
    <>
      <Upload usage={usage} onDone={load} />

      {err && <div className="notice err">{err}</div>}

      <h2>Your appointments</h2>
      {recs === null ? (
        <div className="center"><span className="spin" /></div>
      ) : recs.length === 0 ? (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>
            Nothing here yet. Upload a recording above and you'll get a summary back in a few minutes.
          </p>
        </div>
      ) : (
        recs.map((r) => (
          <Link key={r.id} to={`/r/${r.id}`} className="card tight" style={{ display: "block", textDecoration: "none", color: "inherit" }}>
            <div className="row">
              <div className="grow">
                <h3 style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.title ?? "Appointment"}
                </h3>
                <div className="small muted">
                  {new Date(r.recorded_at ?? r.created_at).toLocaleDateString("en-AU", { dateStyle: "medium" })}
                  {r.duration_ms ? ` · ${fmtDuration(r.duration_ms)}` : ""}
                </div>
              </div>
              <span className={chipClass(r.status)}>
                {!TERMINAL.includes(r.status) && <span className="spin" style={{ marginRight: 6 }} />}
                {STATUS_LABEL[r.status]}
              </span>
            </div>
            {r.failure_reason && <div className="small muted" style={{ marginTop: 6 }}>{r.failure_reason}</div>}
          </Link>
        ))
      )}
    </>
  );
}
