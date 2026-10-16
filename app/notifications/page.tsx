"use client";

import Link from "next/link";
import { SignInButton, useAuth } from "@clerk/nextjs";
import { useCallback, useEffect, useState } from "react";

type Notification = { id: string; title: string; body: string; eventType: string; readAt: string | null; createdAt: string; status: string };

export default function NotificationsPage() {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const [items, setItems] = useState<Notification[]>([]);
  const [notice, setNotice] = useState("");
  const request = useCallback(async (path: string, init: RequestInit = {}) => {
    const token = await getToken();
    const headers = new Headers(init.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return fetch(path, { ...init, headers, cache: "no-store" });
  }, [getToken]);

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    void request("/api/notifications").then(async response => {
      const data = await response.json();
      if (response.ok) setItems(data.notifications);
      else setNotice(data.error ?? "Could not load notifications.");
    });
  }, [isLoaded, isSignedIn, request]);

  async function markRead(id: string) {
    const response = await request(`/api/notifications/${id}`, { method: "PATCH" });
    const data = await response.json();
    if (!response.ok) return setNotice(data.error ?? "Could not update notification.");
    setItems(current => current.map(item => item.id === id ? { ...item, readAt: data.notification.readAt } : item));
  }

  if (!isSignedIn) return <main className="notifications"><Style /><section className="gate"><p>VYAPAARCART UPDATES</p><h1>Every order update,<br /><em>in one place.</em></h1><span>Sign in to see the updates meant for your account.</span><SignInButton><button>Sign in to view updates</button></SignInButton><Link href="/">← Back to marketplace</Link></section></main>;

  return <main className="notifications"><Style /><header><Link className="logo" href="/">V<span>yapaar</span>Cart</Link><nav><Link href="/orders">Orders</Link><Link href="/dashboard">My listings</Link></nav></header><section className="intro"><p>ACCOUNT UPDATES</p><h1>Your notifications</h1><span>Order and delivery updates addressed to your account appear here.</span></section><section className="list">{items.length ? items.map(item => <article className={item.readAt ? "read" : "unread"} key={item.id}><div><p>{item.eventType.replaceAll(".", " ")}</p><h2>{item.title}</h2><span>{item.body}</span><small>{new Date(item.createdAt).toLocaleString()}</small></div>{!item.readAt && <button onClick={() => markRead(item.id)}>Mark read</button>}</article>) : <div className="empty">You have no account notifications yet.</div>}{notice && <p className="notice">{notice}</p>}</section></main>;
}

function Style() { return <style>{`
.notifications{min-height:100vh;background:#f8f7f1;color:#17251f;padding:0 5vw 60px}.notifications header{height:82px;border-bottom:1px solid #dfe2d9;max-width:900px;margin:auto;display:flex;justify-content:space-between;align-items:center}.notifications a{color:#1f8a58;text-decoration:none;font-size:13px;font-weight:700}.logo{color:#17251f!important;font-size:21px!important;letter-spacing:-1px}.logo span{color:#1f8a58}.notifications nav{display:flex;gap:20px}.intro,.list{max-width:900px;margin:auto}.intro{padding:62px 0 34px}.intro p,.list article p,.gate p{font:600 10px ui-monospace,monospace;letter-spacing:.13em;color:#1f8a58;margin:0 0 10px;text-transform:uppercase}.intro h1,.gate h1{font-size:54px;line-height:.9;letter-spacing:-2.8px;margin:0 0 14px}.intro>span,.gate>span{color:#68746e;font-size:14px;line-height:1.5}.list{display:grid;gap:11px}.list article{background:#fff;border:1px solid #e1e5dc;border-radius:14px;padding:20px 22px;display:flex;justify-content:space-between;gap:18px;align-items:start}.list article.unread{border-left:4px solid #1f8a58}.list article.read{opacity:.74}.list h2{font-size:17px;letter-spacing:-.5px;margin:0 0 7px}.list span,.list small{display:block;color:#6e7a73;font-size:12px;line-height:1.5}.list small{margin-top:9px;font-size:10px}.list button,.gate button{border:0;border-radius:9px;background:#17251f;color:#fff;padding:10px 12px;font-size:11px;font-weight:700;white-space:nowrap}.empty{background:#fff;border:1px dashed #cfd8cf;border-radius:14px;padding:60px;text-align:center;color:#718078;font-size:13px}.notice{font-size:12px;color:#b45040}.gate{max-width:620px;margin:auto;text-align:center;padding:135px 0}.gate h1 em{font-family:Georgia,serif;font-weight:400}.gate>span{display:block;margin:0 auto 23px}.gate>a{display:block;margin-top:20px}@media(max-width:650px){.notifications{padding:0 20px 30px}.notifications header{height:65px}.notifications nav{gap:12px}.intro{padding:42px 0 25px}.intro h1,.gate h1{font-size:43px;letter-spacing:-2px}.list article{flex-direction:column}.list button{width:100%}}
`}</style>; }
