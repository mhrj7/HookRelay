"use client";

import Link from "next/link";
import { SignInButton, useAuth } from "@clerk/nextjs";
import { useCallback, useEffect, useState } from "react";

type Seller = { id: number; displayName: string; status: string; requestedAt: string | null };
type Product = { id: string; title: string; status: string; price: number; createdAt: string; storeName: string; categoryName: string };
type Order = { id: string; kind: "Marketplace" | "Checkout"; status: string; paymentStatus: string; total: number; createdAt: string; reference: string };
type Metrics = { users: number; stores: number; catalogProducts: number; marketplaceListings: number; marketplaceOrders: number; checkoutOrders: number };
type Operations = { metrics: Metrics; sellers: Seller[]; products: Product[]; orders: Order[] };

const rupees = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });

function dateTime(value: string | null) {
  return value ? new Date(value).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "Not recorded";
}

export default function AdminOperationsPage() {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const [operations, setOperations] = useState<Operations | null>(null);
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const request = useCallback(async (path: string, init: RequestInit = {}) => {
    const token = await getToken();
    const headers = new Headers(init.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return fetch(path, { ...init, headers, cache: "no-store" });
  }, [getToken]);

  const load = useCallback(async () => {
    if (!isLoaded || !isSignedIn) return;
    const response = await request("/api/admin/operations");
    const data = await response.json();
    if (response.ok) {
      setOperations(data);
      setNotice("");
    } else {
      setOperations(null);
      setNotice(data.error ?? "Could not load admin operations.");
    }
  }, [isLoaded, isSignedIn, request]);

  useEffect(() => { void load(); }, [load]);

  async function decideSeller(sellerId: number, decision: "approved" | "rejected") {
    setBusyId(`seller-${sellerId}`);
    const response = await request("/api/admin/seller-approvals", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sellerId, decision }),
    });
    const data = await response.json();
    setBusyId(null);
    setNotice(response.ok ? `Seller ${decision}.` : data.error ?? "Could not save the seller decision.");
    if (response.ok) await load();
  }

  async function setProductStatus(product: Product) {
    const nextStatus = product.status === "active" ? "archived" : "active";
    setBusyId(`product-${product.id}`);
    const response = await request(`/api/admin/products/${product.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: nextStatus }),
    });
    const data = await response.json();
    setBusyId(null);
    setNotice(response.ok ? `Product ${nextStatus}.` : data.error ?? "Could not update the product.");
    if (response.ok) await load();
  }

  if (!isLoaded) return <main className="admin-shell"><p className="state">Loading administrator session…</p><AdminStyles /></main>;
  if (!isSignedIn) return <main className="admin-shell"><AdminStyles /><section className="access-card"><p className="eyebrow">VYAPAARCART ADMIN</p><h1>Sign in to access operations.</h1><SignInButton><button className="primary">Sign in</button></SignInButton></section></main>;

  return <main className="admin-shell"><AdminStyles /><header className="topbar"><Link href="/" className="brand">V<span>yapaar</span>Cart</Link><nav><Link href="/dashboard">Seller workspace</Link><Link href="/orders">Orders</Link><Link href="/notifications">Notifications</Link></nav></header><section className="hero"><div><p className="eyebrow">ADMIN OPERATIONS</p><h1>Marketplace control room.</h1><p>Review seller onboarding, catalog activity, order queues, and operating volume from one authorized workspace.</p></div><button className="secondary" onClick={() => void load()}>Refresh queues</button></section>{notice && <p role="alert" className="notice">{notice}</p>}{operations && <><section className="metrics" aria-label="Marketplace metrics"><Metric label="Users" value={operations.metrics.users} /><Metric label="Stores" value={operations.metrics.stores} /><Metric label="Catalog products" value={operations.metrics.catalogProducts} /><Metric label="Marketplace listings" value={operations.metrics.marketplaceListings} /><Metric label="Marketplace orders" value={operations.metrics.marketplaceOrders} /><Metric label="Checkout orders" value={operations.metrics.checkoutOrders} /></section><section className="queue-grid"><section className="queue"><QueueHeading label="Seller queue" count={operations.sellers.length} detail="Pending seller approvals" /><div className="queue-content">{operations.sellers.length === 0 ? <Empty text="No seller approvals are waiting." /> : operations.sellers.map((seller) => <article key={seller.id}><div><strong>{seller.displayName}</strong><small>Requested {dateTime(seller.requestedAt)}</small></div><div className="actions"><button disabled={busyId === `seller-${seller.id}`} onClick={() => void decideSeller(seller.id, "approved")}>Approve</button><button disabled={busyId === `seller-${seller.id}`} className="danger" onClick={() => void decideSeller(seller.id, "rejected")}>Reject</button></div></article>)}</div></section><section className="queue"><QueueHeading label="Product queue" count={operations.products.length} detail="Latest catalog products" /><div className="queue-content">{operations.products.length === 0 ? <Empty text="No catalog products have been created." /> : operations.products.map((product) => <article key={product.id}><div><strong>{product.title}</strong><small>{product.storeName} · {product.categoryName} · {rupees.format(product.price)}</small><small>Added {dateTime(product.createdAt)}</small></div><div className="actions"><span className={`status ${product.status}`}>{product.status}</span><button disabled={busyId === `product-${product.id}`} onClick={() => void setProductStatus(product)}>{product.status === "active" ? "Archive" : "Restore"}</button></div></article>)}</div></section><section className="queue orders"><QueueHeading label="Order queue" count={operations.orders.length} detail="Latest marketplace and checkout orders" /><div className="queue-content">{operations.orders.length === 0 ? <Empty text="No orders have been placed." /> : operations.orders.map((order) => <article key={`${order.kind}-${order.id}`}><div><strong>{order.reference}</strong><small>{order.kind} · {rupees.format(order.total)} · {dateTime(order.createdAt)}</small></div><div className="order-state"><span className="status">{order.status.replaceAll("_", " ")}</span><small>{order.paymentStatus.replaceAll("_", " ")}</small></div></article>)}</div></section></section></>}</main>;
}

function Metric({ label, value }: { label: string; value: number }) {
  return <article><span>{label}</span><strong>{value.toLocaleString("en-IN")}</strong></article>;
}

function QueueHeading({ label, count, detail }: { label: string; count: number; detail: string }) {
  return <header className="queue-heading"><div><p className="eyebrow">{detail}</p><h2>{label}</h2></div><span>{count}</span></header>;
}

function Empty({ text }: { text: string }) {
  return <p className="empty">{text}</p>;
}

function AdminStyles() {
  return <style>{`
    .admin-shell{min-height:100vh;background:#f8f7f1;color:#17251f;padding:0 5vw 72px}.topbar,.hero,.metrics,.queue-grid,.notice,.state,.access-card{max-width:1220px;margin-left:auto;margin-right:auto}.topbar{height:82px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #dfe2d9}.brand{font-size:21px;font-weight:800;color:#17251f;text-decoration:none;letter-spacing:-1px}.brand span,.eyebrow{color:#1f8a58}.topbar nav{display:flex;gap:20px}.topbar nav a{color:#55625b;text-decoration:none;font-size:13px;font-weight:700}.hero{display:flex;align-items:end;justify-content:space-between;gap:24px;padding:70px 0 38px}.eyebrow{font:700 10px ui-monospace,SFMono-Regular,monospace;letter-spacing:.13em;margin:0 0 8px}.hero h1,.access-card h1{font-size:clamp(42px,6vw,70px);letter-spacing:-4px;line-height:.92;margin:0 0 17px}.hero>div>p:not(.eyebrow){max-width:620px;color:#68746e;line-height:1.55;margin:0}.primary,.secondary,.actions button{border:0;border-radius:9px;padding:10px 13px;font-weight:800;font-size:12px;cursor:pointer}.primary,.actions button{background:#17251f;color:#fff}.secondary{background:#d9fa6a;color:#17251f}.notice{background:#fff8d9;border:1px solid #f0df9a;border-radius:11px;padding:12px 14px;color:#6e5410;font-size:13px}.metrics{display:grid;grid-template-columns:repeat(6,1fr);gap:10px}.metrics article,.queue{background:#fff;border:1px solid #e4e5df;border-radius:17px;box-shadow:0 8px 22px rgba(31,53,41,.035)}.metrics article{padding:16px}.metrics span{display:block;color:#68746e;font-size:11px;font-weight:700}.metrics strong{display:block;margin-top:9px;font-size:27px;letter-spacing:-1.2px}.queue-grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:18px}.queue.orders{grid-column:1 / -1}.queue-heading{display:flex;align-items:start;justify-content:space-between;padding:22px 23px;border-bottom:1px solid #edf0ea}.queue-heading h2{margin:0;font-size:25px;letter-spacing:-1px}.queue-heading>span{display:grid;place-items:center;min-width:29px;height:29px;border-radius:50%;background:#d9fa6a;font:700 11px ui-monospace,monospace}.queue-content{padding:0 23px}.queue article{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:15px 0;border-bottom:1px solid #edf0ea}.queue article:last-child{border-bottom:0}.queue article>div:first-child{display:grid;gap:4px;min-width:0}.queue strong{font-size:13px;overflow-wrap:anywhere}.queue small{color:#68746e;font-size:11px;line-height:1.35}.actions,.order-state{display:flex;align-items:center;gap:8px;flex-shrink:0}.actions button.danger{background:#8d3b33}.actions button:disabled{opacity:.55;cursor:wait}.status{display:inline-block;border-radius:999px;background:#ecf5eb;color:#1f8a58;font:700 10px ui-monospace,monospace;text-transform:uppercase;padding:4px 7px;white-space:nowrap}.status.archived{background:#eeeef0;color:#68746e}.order-state{display:grid;justify-items:end;gap:5px}.empty{color:#68746e;font-size:13px;padding:18px 0}.state{padding:70px 0;color:#68746e}.access-card{max-width:600px;padding:110px 0}.access-card .primary{margin-top:12px}@media(max-width:900px){.metrics{grid-template-columns:repeat(3,1fr)}.queue-grid{grid-template-columns:1fr}.queue.orders{grid-column:auto}}@media(max-width:620px){.admin-shell{padding:0 20px 45px}.topbar{height:67px}.topbar nav{gap:12px}.topbar nav a{font-size:11px}.hero{padding:48px 0 27px;align-items:start;flex-direction:column}.hero h1,.access-card h1{letter-spacing:-2.5px}.metrics{grid-template-columns:repeat(2,1fr)}.queue-heading,.queue-content{padding-left:16px;padding-right:16px}.queue article{align-items:flex-start;flex-direction:column}.actions,.order-state{justify-items:start;flex-wrap:wrap}.order-state{display:flex}}
  `}</style>;
}
