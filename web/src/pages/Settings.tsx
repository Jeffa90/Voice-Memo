import { useEffect, useState } from "react";
import { api, type Usage } from "../lib/api";
import { supabase } from "../lib/supabase";

const STATES = ["NSW", "VIC", "QLD", "SA", "WA", "TAS", "NT", "ACT"];

export default function Settings() {
  const [me, setMe] = useState<any>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirm, setConfirm] = useState("");

  useEffect(() => {
    api.me().then(setMe).catch(() => {});
    api.usage().then(setUsage).catch(() => {});
  }, []);

  async function save(patch: Record<string, string>) {
    await api.updateMe(patch);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function deleteAccount() {
    await api.deleteMe();
    await supabase.auth.signOut();
  }

  if (!me) return <div className="center"><span className="spin" /></div>;

  return (
    <>
      <h2>Your details</h2>
      <div className="card">
        <div className="small muted">{me.user?.email}</div>
        <label htmlFor="stt">Usual state or territory</label>
        <select id="stt" defaultValue={me.user?.state_territory ?? ""}
                onChange={(e) => save({ state_territory: e.target.value })}>
          <option value="">Not set</option>
          {STATES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <div className="small muted" style={{ marginTop: 6 }}>
          Used to pre-fill the recording-consent question. You can change it per recording.
        </div>
        {saved && <div className="small" style={{ color: "var(--ok)", marginTop: 8 }}>Saved</div>}
      </div>

      <h2>This month</h2>
      <div className="card">
        {usage ? (
          <>
            <div className="bar">
              <i style={{ width: `${Math.min(100, (usage.audio_seconds_used / usage.audio_seconds_limit) * 100)}%` }} />
            </div>
            <div className="small muted" style={{ marginTop: 6 }}>
              {Math.round(usage.audio_seconds_used / 60)} of {Math.round(usage.audio_seconds_limit / 60)} minutes used
            </div>
          </>
        ) : <span className="spin" />}
      </div>

      <h2>Privacy</h2>
      <div className="card small muted stack">
        <div>Your recordings and transcripts are stored in Sydney, Australia.</div>
        <div>Audio is deleted automatically 7 days after it has been summarised. Transcripts and summaries stay until you delete them.</div>
        <div>To produce a transcript and summary, audio and transcript text are sent to service providers overseas (United States, Ireland). They are contractually prohibited from training on your data.</div>
      </div>

      <h2>Delete account</h2>
      <div className="card">
        <p className="small muted" style={{ marginTop: 0 }}>
          This permanently removes every recording, transcript and summary, and cannot be undone.
          Type <strong>delete</strong> to confirm.
        </p>
        <input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="delete" />
        <button className="danger" style={{ width: "100%", marginTop: 10 }}
                disabled={confirm !== "delete"} onClick={deleteAccount}>
          Delete my account and everything in it
        </button>
      </div>
    </>
  );
}
