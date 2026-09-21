import { useEffect, useState } from "react";
import { Routes, Route, Link, Navigate, useNavigate } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import RecordingPage from "./pages/Recording";
import Settings from "./pages/Settings";

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (!ready) return <div className="center"><span className="spin" /></div>;
  if (!session) return <Login />;

  return (
    <>
      <Header />
      <div className="wrap">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/r/:id" element={<RecordingPage />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </>
  );
}

function Header() {
  const nav = useNavigate();
  return (
    <header className="top">
      <div className="wrap">
        <h1><Link to="/" style={{ color: "inherit", textDecoration: "none" }}>Voice Memo</Link></h1>
        <button className="link" onClick={() => nav("/settings")}>Settings</button>
        <button className="link" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </div>
    </header>
  );
}
