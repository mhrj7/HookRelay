"use client";

import { SignInButton, useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type AuditEvent = {
  id: string; actorId: number; actorName: string; actorRole: string; action: string;
  targetType: string; targetId: string; beforeSummary: Record<string, unknown>;
  afterSummary: Record<string, unknown>; metadata: Record<string, unknown>; createdAt: string;
};

const json = (value: Record<string, unknown>) => JSON.stringify(value, null, 2);

export default function AuditLogsPage() {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    if (!isLoaded || !isSignedIn) return;
    const token = await getToken();
    const response = await fetch("/api/admin/audit-logs?limit=200", { headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: "no-store" });
    const data = await response.json();
    if (!response.ok) { setError(data.error ?? "Could not load audit events."); setEvents([]); return; }
    setError(""); setEvents(data.events ?? []);
  }, [getToken, isLoaded, isSignedIn]);
  useEffect(() => { void load(); }, [load]);

  if (!isLoaded) return <main className="audit-shell"><AuditStyles /><p>Loading administrator session…</p></main>;
  if (!isSignedIn) return <main className="audit-shell"><AuditStyles /><section className="access"><p className="eyebrow">ADMIN AUDIT LOG</p><h1>Sign in to inspect sensitive changes.</h1><SignInButton><button>Sign in</button></SignInButton></section></main>;
  return <main className="audit-shell"><AuditStyles /><header className="topbar"><Link href="/admin" className="brand">V<span>yapaar</span>Cart</Link><nav><Link href="/admin">Operations</Link><Link href="/admin/commissions">Commissions</Link><Link href="/admin/disputes">Disputes</Link></nav></header><section className="hero"><div><p className="eyebrow">IMMUTABLE ADMIN RECORD</p><h1>Audit logs</h1><p>Trace sensitive seller approvals, refunds, inventory edits, and organization role changes with the responsible actor and exact before/after state.</p></div><button onClick={() => void load()}>Refresh</button></section>{error && <p role="alert" className="error">{error}</p>}{!error && <section className="events" aria-label="Audit events">{events.length === 0 ? <p className="empty">No audit events have been recorded yet.</p> : events.map((event) => <article key={event.id}><header><div><span className="action">{event.action}</span><h2>{event.targetType}: {event.targetId}</h2></div><time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "medium" })}</time></header><p className="actor">Actor: <strong>{event.actorName}</strong> · user #{event.actorId} · {event.actorRole}</p><div className="diff"><section><h3>Before</h3><pre>{json(event.beforeSummary)}</pre></section><section><h3>After</h3><pre>{json(event.afterSummary)}</pre></section></div><details><summary>Metadata</summary><pre>{json(event.metadata)}</pre></details></article>)}</section>}</main>;
}

function AuditStyles() {
  return <style>{`
    .audit-shell{min-height:100vh;background:#f8f7f1;color:#17251f;padding:0 5vw 72px}.topbar,.hero,.events,.error,.access{max-width:1120px;margin-left:auto;margin-right:auto}.topbar{height:82px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #dfe2d9}.brand{font-size:21px;font-weight:800;color:#17251f;text-decoration:none;letter-spacing:-1px}.brand span,.eyebrow{color:#1f8a58}.topbar nav{display:flex;gap:20px}.topbar a{color:#55625b;text-decoration:none;font-size:13px;font-weight:700}.hero{display:flex;align-items:end;justify-content:space-between;gap:24px;padding:66px 0 35px}.eyebrow{font:700 10px ui-monospace,SFMono-Regular,monospace;letter-spacing:.13em;margin:0 0 8px}.hero h1,.access h1{font-size:clamp(45px,7vw,76px);letter-spacing:-4px;line-height:.9;margin:0 0 18px}.hero p:not(.eyebrow){max-width:720px;color:#68746e;line-height:1.55;margin:0}.hero button,.access button{border:0;border-radius:9px;padding:11px 15px;background:#17251f;color:#fff;font-weight:800;cursor:pointer}.events{display:grid;gap:14px}.events article{background:#fff;border:1px solid #e2e5de;border-radius:17px;padding:21px 23px;box-shadow:0 8px 22px rgba(31,53,41,.035)}.events article>header{display:flex;justify-content:space-between;gap:20px}.events h2{font-size:18px;margin:8px 0 0;overflow-wrap:anywhere}.action{display:inline-block;border-radius:999px;background:#d9fa6a;padding:5px 8px;font:700 10px ui-monospace,monospace;text-transform:uppercase}.events time,.actor{color:#68746e;font-size:12px}.actor{margin:14px 0}.diff{display:grid;grid-template-columns:1fr 1fr;gap:12px}.diff section,details{background:#f5f6f2;border-radius:10px;padding:12px}.diff h3{margin:0 0 8px;font:700 10px ui-monospace,monospace;text-transform:uppercase;color:#68746e}pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;font:11px/1.45 ui-monospace,SFMono-Regular,monospace}details{margin-top:12px}details summary{cursor:pointer;font-size:12px;font-weight:800}details pre{margin-top:10px}.error{background:#fff0ed;border:1px solid #f0c4bc;border-radius:10px;padding:13px;color:#8d3b33}.empty{background:#fff;border:1px solid #e2e5de;border-radius:17px;padding:25px;color:#68746e}.access{max-width:680px;padding-top:110px}@media(max-width:700px){.audit-shell{padding:0 20px 45px}.topbar{height:67px}.topbar nav{gap:10px}.topbar nav a{font-size:11px}.hero{align-items:start;flex-direction:column;padding:48px 0 27px}.hero h1,.access h1{letter-spacing:-2.5px}.events article>header{flex-direction:column}.diff{grid-template-columns:1fr}}
  `}</style>;
}
