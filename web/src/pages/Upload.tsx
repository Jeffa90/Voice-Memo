import { useEffect, useRef, useState } from "react";
import { api, probeDuration, uploadToStorage, type Disclaimer, type Usage } from "../lib/api";

const STATES = ["NSW", "VIC", "QLD", "SA", "WA", "TAS", "NT", "ACT"];

export default function Upload({ usage, onDone }: { usage: Usage | null; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<string>("");
  const [disc, setDisc] = useState<Disclaimer | null>(null);
  const [attested, setAttested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  // Default the jurisdiction from the profile, but it stays changeable: the law
  // follows where the conversation happened, not where you live.
  useEffect(() => {
    api.me().then((m) => setState((s) => s || m.user?.state_territory || "")).catch(() => {});
  }, []);

  useEffect(() => {
    setDisc(null); setAttested(false);
    if (!state) return;
    api.disclaimer(state).then(setDisc).catch((e) => setErr(e.message));
  }, [state]);

  async function submit() {
    if (!file || !disc) return;
    setBusy(true); setErr(null);
    try {
      setProgress("Checking the file…");
      const seconds = await probeDuration(file);

      setProgress("Preparing upload…");
      const slot = await api.createUpload({
        filename: file.name,
        content_type: file.type || "audio/mpeg",
        byte_size: file.size,
        duration_hint_seconds: seconds,
        recorded_in_state: state,
        consent_disclaimer_version: disc.version,
        consent_attested: true,
        title: file.name.replace(/\.[^.]+$/, ""),
        recorded_at: new Date(file.lastModified).toISOString(),
      });

      setProgress("Uploading…");
      await uploadToStorage(slot.bucket, slot.storage_path, slot.upload_token, file);

      setProgress("Starting…");
      await api.completeUpload(slot.recording_id);

      setFile(null); setAttested(false);
      if (input.current) input.current.value = "";
      onDone();
    } catch (e) {
      const msg = (e as Error).message;
      // A stale disclaimer version means the wording changed — re-fetch and re-ask.
      if (/wording out of date/i.test(msg) && state) {
        api.disclaimer(state).then(setDisc);
        setAttested(false);
        setErr("The consent wording has been updated. Please read it again and confirm.");
      } else setErr(msg);
    } finally {
      setBusy(false); setProgress(null);
    }
  }

  const remaining = usage ? Math.round(usage.audio_seconds_remaining / 60) : null;
  const ready = file && state && disc && attested && !busy;

  return (
    <div className="card">
      <h3>New appointment</h3>

      <label htmlFor="f">Recording</label>
      <input id="f" ref={input} type="file" accept="audio/*,video/mp4,video/quicktime"
             onChange={(e) => { setFile(e.target.files?.[0] ?? null); setErr(null); }} />

      {file && (
        <>
          <label htmlFor="st">Which state or territory was this recorded in?</label>
          <select id="st" value={state} onChange={(e) => setState(e.target.value)}>
            <option value="">Choose…</option>
            {STATES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>

          {disc && (
            <>
              <div className="notice">{disc.body_markdown.replace(/\*\*/g, "")}</div>
              <label className="row" style={{ cursor: "pointer", alignItems: "flex-start", marginTop: 4 }}>
                <input type="checkbox" style={{ width: 18, height: 18, marginTop: 2, flex: "0 0 auto" }}
                       checked={attested} onChange={(e) => setAttested(e.target.checked)} />
                <span className="grow" style={{ color: "var(--text)", fontSize: 14 }}>
                  {disc.acknowledgement_label}
                </span>
              </label>
            </>
          )}

          <button className="primary" style={{ width: "100%", marginTop: 14 }} disabled={!ready} onClick={submit}>
            {busy ? <><span className="spin" /> {progress}</> : "Upload and summarise"}
          </button>
        </>
      )}

      {err && <div className="notice err">{err}</div>}

      {remaining !== null && usage && (
        <div style={{ marginTop: 14 }}>
          <div className="bar">
            <i style={{ width: `${Math.min(100, (usage.audio_seconds_used / usage.audio_seconds_limit) * 100)}%` }} />
          </div>
          <div className="small muted" style={{ marginTop: 5 }}>
            {remaining} of {Math.round(usage.audio_seconds_limit / 60)} minutes left this month
            {usage.in_flight_count > 0 && ` · ${usage.in_flight_count} in progress`}
          </div>
        </div>
      )}
    </div>
  );
}
