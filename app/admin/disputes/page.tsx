"use client";

import Link from "next/link";
import { SignInButton, useAuth } from "@clerk/nextjs";
import { useCallback, useEffect, useState } from "react";

type Order = { id: string; total: number; status: string; createdAt: string };
type Dispute = { id: string; orderId: string; status: "open" | "under_review" | "resolved" | "rejected"; reason: string; resolution: string | null; createdAt: string; updatedAt: string; orderTotal: number; orderStatus: string };
type Data = { disputes: Dispute[]; orders: Order[] };
const rupees = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const dateTime = (value: string) => new Date(value).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });

export default function DisputesPage() {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const [data, setData] = useState<Data | null>(null);
  const [orderId, setOrderId] = useState("");
  const [reason, setReason] = useState("");
  const [resolution, setResolution] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const request = useCallback(async (path: string, init: RequestInit = {}) => {
    const token = await getToken();
    const headers = new Headers(init.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return fetch(path, { ...init, headers, cache: "no-store" });
  }, [getToken]);

  const load = useCallback(async () => {
    if (!isLoaded || !isSignedIn) return;
    const response = await request("/api/admin/disputes");
    const responseData = await response.json();
    if (response.ok) {
      setData(responseData);
      setOrderId((current) => current || responseData.orders[0]?.id || "");
      setNotice("");
    } else { setData(null); setNotice(responseData.error ?? "Could not load disputes."); }
  }, [isLoaded, isSignedIn, request]);

  useEffect(() => { void load(); }, [load]);

  async function createDispute(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("create");
    const response = await request("/api/admin/disputes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orderId, reason }) });
    const responseData = await response.json();
    setBusy(null);
    setNotice(response.ok ? "Dispute opened." : responseData.error ?? "Could not open the dispute.");
    if (response.ok) { setReason(""); await load(); }
  }

  async function transition(dispute: Dispute, status: "under_review" | "resolved" | "rejected") {
    setBusy(dispute.id);
    const response = await request(`/api/admin/disputes/${dispute.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status, resolution: resolution[dispute.id] ?? "" }) });
    const responseData = await response.json();
    setBusy(null);
    setNotice(response.ok ? `Dispute ${status.replaceAll("_", " ")}.` : responseData.error ?? "Could not update the dispute.");
    if (response.ok) await load();
  }

  if (!isLoaded) return <main className="disputes"><p>Loading administrator session…</p><Styles /></main>;
  if (!isSignedIn) return <main className="disputes"><Styles /><section className="access"><p>ADMIN DISPUTES</p><h1>Sign in to review disputes.</h1><SignInButton><button>Sign in</button></SignInButton></section></main>;

  const disputedOrders = new Set(data?.disputes.map((dispute) => dispute.orderId) ?? []);
  return <main className="disputes"><Styles /><header><Link href="/admin">← Admin operations</Link><p>ADMIN DISPUTES</p><h1>Resolve with a record.</h1><span>Every dispute stays linked to its checkout order and carries its final resolution.</span></header>{notice && <p role="alert" className="notice">{notice}</p>}<section className="layout"><form className="card" onSubmit={createDispute}><p>NEW DISPUTE</p><h2>Open a case</h2><label>Checkout order<select required value={orderId} onChange={(event) => setOrderId(event.target.value)}><option value="" disabled>Choose an order</option>{data?.orders.filter((order) => !disputedOrders.has(order.id)).map((order) => <option key={order.id} value={order.id}>{order.id.slice(0, 8)} · {rupees.format(order.total)} · {order.status}</option>)}</select></label><label>Reason<textarea required minLength={5} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="What needs an admin decision?" /></label><button disabled={busy === "create" || !orderId}>{busy === "create" ? "Opening…" : "Open dispute"}</button></form><section className="card cases"><p>OPERATIONAL QUEUE</p><h2>Disputes</h2>{!data ? <p>Loading disputes…</p> : data.disputes.length === 0 ? <p className="empty">No disputes are open or awaiting review.</p> : data.disputes.map((dispute) => <article key={dispute.id}><div className="case-head"><div><span className={`status ${dispute.status}`}>{dispute.status.replaceAll("_", " ")}</span><h3>Order {dispute.orderId.slice(0, 8)} · {rupees.format(dispute.orderTotal)}</h3></div><small>Updated {dateTime(dispute.updatedAt)}</small></div><p><b>Reason:</b> {dispute.reason}</p>{dispute.resolution && <p><b>Resolution:</b> {dispute.resolution}</p>}{dispute.status === "open" && <button disabled={busy === dispute.id} onClick={() => void transition(dispute, "under_review")}>{busy === dispute.id ? "Updating…" : "Start review"}</button>}{(dispute.status === "open" || dispute.status === "under_review") && <div className="decision"><textarea minLength={5} maxLength={1000} value={resolution[dispute.id] ?? ""} onChange={(event) => setResolution((current) => ({ ...current, [dispute.id]: event.target.value }))} placeholder="Resolution or rejection reason" /><button disabled={busy === dispute.id} onClick={() => void transition(dispute, "resolved")}>Resolve</button><button disabled={busy === dispute.id} className="reject" onClick={() => void transition(dispute, "rejected")}>Reject</button></div>}</article>)}</section></section></main>;
}

function Styles() { return <style>{`.disputes{min-height:100vh;background:#f8f7f1;color:#17251f;padding:0 5vw 70px}.disputes header,.layout,.notice,.access{max-width:1120px;margin-left:auto;margin-right:auto}.disputes header{padding:65px 0 32px;border-bottom:1px solid #dfe2d9}.disputes header>a{color:#1f8a58;text-decoration:none;font-size:13px;font-weight:700}.disputes header p,.card>p,.access>p{font:700 10px ui-monospace,monospace;letter-spacing:.13em;color:#1f8a58;margin:28px 0 8px}.disputes h1,.access h1{font-size:clamp(42px,6vw,70px);letter-spacing:-4px;line-height:.92;margin:0 0 14px}.disputes header span{color:#68746e}.notice{margin-top:18px;padding:12px 14px;border-radius:10px;background:#fff8d9;color:#6e5410;font-size:13px}.layout{display:grid;grid-template-columns:360px 1fr;gap:20px;margin-top:28px;align-items:start}.card{background:white;border:1px solid #e4e5df;border-radius:17px;padding:24px;box-shadow:0 8px 22px rgba(31,53,41,.035)}.card>p{margin-top:0}.card h2{font-size:28px;letter-spacing:-1px;margin:0 0 18px}.card label{display:grid;gap:7px;font-size:12px;font-weight:700;margin:13px 0}.card select,.card textarea{font:inherit;border:1px solid #d8ddd6;border-radius:9px;background:#fff;padding:11px 12px;color:#17251f}.card textarea{min-height:110px;resize:vertical}.card button,.access button{border:0;border-radius:9px;background:#17251f;color:#fff;padding:11px 13px;font-size:12px;font-weight:800}.card button:disabled{opacity:.55}.cases article{border-top:1px solid #edf0ea;padding:18px 0}.case-head{display:flex;gap:16px;justify-content:space-between}.case-head h3{font-size:14px;margin:9px 0 0}.case-head small{color:#68746e;font-size:11px}.cases article>p{font-size:13px;line-height:1.5}.status{display:inline-block;padding:4px 7px;border-radius:999px;font:700 10px ui-monospace,monospace;text-transform:uppercase;background:#f7eed3;color:#806415}.status.under_review{background:#e5effe;color:#315d96}.status.resolved{background:#e6f4e7;color:#1f8a58}.status.rejected{background:#f7e5e2;color:#983d35}.decision{display:grid;grid-template-columns:1fr auto auto;gap:8px;margin-top:12px}.decision textarea{min-height:44px}.decision button.reject{background:#8d3b33}.empty{color:#68746e;font-size:13px}.access{max-width:620px;padding:110px 0}@media(max-width:760px){.disputes{padding:0 20px 42px}.layout{grid-template-columns:1fr}.disputes h1,.access h1{letter-spacing:-2.5px}.case-head{flex-direction:column;gap:7px}.decision{grid-template-columns:1fr}.decision button{width:100%}}`}</style>; }
