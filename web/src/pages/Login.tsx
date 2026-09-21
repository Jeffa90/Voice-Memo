import { useState } from "react";
import { supabase } from "../lib/supabase";

export default function Login() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    const { error } = await supabase.auth.signInWithOtp({
      email, options: { emailRedirectTo: window.location.origin },
    });
    setBusy(false);
    if (error) setErr(error.message); else setSent(true);
  }

  return (
    <div className="wrap" style={{ maxWidth: 420, paddingTop: 80 }}>
      <h1 style={{ fontSize: 26, marginBottom: 6, letterSpacing: "-0.02em" }}>Voice Memo</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        Turn a recording of your appointment into a clear summary you can actually use.
      </p>

      {sent ? (
        <div className="card">
          <h3>Check your email</h3>
          <p className="muted small" style={{ margin: 0 }}>
            We sent a sign-in link to <strong>{email}</strong>. Open it on this device.
          </p>
        </div>
      ) : (
        <form onSubmit={send} className="card">
          <label htmlFor="email">Email address</label>
          <input id="email" type="email" required autoComplete="email" value={email}
                 onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          <button className="primary" style={{ width: "100%", marginTop: 14 }} disabled={busy || !email}>
            {busy ? <span className="spin" /> : "Email me a sign-in link"}
          </button>
          {err && <div className="notice err">{err}</div>}
        </form>
      )}

      <p className="disclaimer">
        Voice Memo summarises what was said at your appointment. It is not medical advice and
        it can make mistakes. Always check with your doctor before acting on anything it produces.
      </p>
    </div>
  );
}
