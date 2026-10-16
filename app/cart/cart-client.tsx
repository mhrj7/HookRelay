"use client";

import Link from "next/link";
import { SignInButton, useAuth } from "@clerk/nextjs";
import { useCallback, useEffect, useState } from "react";

type CartItem = { variantId: string; title: string; name: string; sku: string; slug: string; quantity: number; unitPrice: number; lineTotal: number; active: boolean };
type Cart = { id: string | null; items: CartItem[]; total: number; itemCount: number };
type CheckoutResponse = { error?: string; reservation?: { id: string }; reservationId?: string; order?: { orderId: string; paymentIntentId: string; total: number; currency: string } };

export default function CartClient() {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const [cart, setCart] = useState<Cart | null>(null);
  const [drafts, setDrafts] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");

  const request = useCallback(async (init?: RequestInit) => {
    const token = await getToken();
    const headers = new Headers(init?.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const response = await fetch("/api/cart", { ...init, headers, cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Could not load your cart.");
    return data.cart as Cart;
  }, [getToken]);

  const post = useCallback(async (path: string, body: unknown) => {
    const token = await getToken();
    const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    return { response, data: await response.json() as CheckoutResponse };
  }, [getToken]);

  const load = useCallback(async () => {
    if (!isSignedIn) return;
    try {
      const current = await request();
      setCart(current);
      setDrafts(Object.fromEntries(current.items.map(item => [item.variantId, item.quantity])));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not load your cart.");
    }
  }, [isSignedIn, request]);

  useEffect(() => { void load(); }, [load]);

  async function update(item: CartItem) {
    const quantity = drafts[item.variantId];
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
      setNotice("Quantity must be a whole number from 1 to 20.");
      return;
    }
    setBusy(item.variantId); setNotice("");
    try {
      const current = await request({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ variantId: item.variantId, quantity }) });
      setCart(current); setNotice("Cart updated using the SKU's current price.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not update the cart."); }
    finally { setBusy(""); }
  }

  async function remove(item: CartItem) {
    setBusy(item.variantId); setNotice("");
    try {
      const current = await request({ method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ variantId: item.variantId }) });
      setCart(current); setNotice("Item removed.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not remove the item."); }
    finally { setBusy(""); }
  }

  async function checkout() {
    if (!cart || cart.items.length === 0 || cart.items.some(item => !item.active)) {
      setNotice("Remove unavailable SKUs before checkout.");
      return;
    }
    setBusy("checkout"); setNotice("Reserving current stock…");
    try {
      const reservationIds: string[] = [];
      for (const item of cart.items) {
        const { response, data } = await post("/api/checkout/reservations", { variantId: item.variantId, quantity: item.quantity, key: crypto.randomUUID() });
        const reservationId = data.reservation?.id ?? data.reservationId;
        if (!response.ok && !reservationId) throw new Error(data.error ?? `Could not reserve ${item.sku}.`);
        if (!reservationId) throw new Error(`Could not reserve ${item.sku}.`);
        reservationIds.push(reservationId);
      }
      setNotice("Creating the order, payment intent, and event record…");
      const { response, data } = await post("/api/checkout/orders", { key: crypto.randomUUID(), reservationIds });
      if (!response.ok || !data.order) throw new Error(data.error ?? "Could not create the order.");
      await load();
      setNotice(`Order ${data.order.orderId} created for ₹${data.order.total.toLocaleString("en-IN")}. Payment intent ${data.order.paymentIntentId} is ready; no payment has been taken.`);
    } catch (error) {
      setNotice(`${error instanceof Error ? error.message : "Checkout failed."} Any successful stock holds remain visible until their 10-minute expiry.`);
    } finally { setBusy(""); }
  }

  return <main className="cart-page"><style>{cartStyles}</style><header><Link href="/">← Marketplace</Link><b>Vyapaar<span>Cart</span></b></header>{!isLoaded ? <section className="gate"><h1>Loading your cart…</h1></section> : !isSignedIn ? <section className="gate"><p>BUYER CART</p><h1>Save SKUs for checkout.</h1><span>Your cart is attached to your signed-in buyer account.</span><SignInButton mode="modal"><button>Sign in to view cart</button></SignInButton></section> : <><section className="intro"><p>BUYER CART · {cart?.itemCount ?? 0} UNITS</p><h1>Your cart</h1><span>Prices and totals are recalculated from active SKU prices whenever this page loads or changes.</span></section><section className="cart-panel">{cart === null ? <p>Loading cart…</p> : cart.items.length === 0 ? <div className="empty"><h2>Your cart is empty.</h2><Link href="/products">Browse products →</Link></div> : <><div className="items">{cart.items.map(item => <article key={item.variantId} className={!item.active ? "inactive" : ""}><div><Link href={`/stores/${item.slug}`}>{item.title}</Link><p>{item.name} · {item.sku}</p><small>{item.active ? `Current price ₹${item.unitPrice.toLocaleString("en-IN")}` : "SKU is no longer active; excluded from total"}</small></div><label htmlFor={`qty-${item.variantId}`}>Quantity<input id={`qty-${item.variantId}`} type="number" min={1} max={20} step={1} value={drafts[item.variantId] ?? item.quantity} disabled={busy === item.variantId || !item.active} onChange={event => setDrafts(current => ({ ...current, [item.variantId]: Number(event.target.value) }))} /></label><div className="line"><strong>₹{item.lineTotal.toLocaleString("en-IN")}</strong><button disabled={busy === item.variantId || !item.active} onClick={() => void update(item)}>Update</button><button className="remove" disabled={busy === item.variantId} onClick={() => void remove(item)}>Remove</button></div></article>)}</div><footer><span>Total from active SKUs</span><strong>₹{cart.total.toLocaleString("en-IN")}</strong><button className="checkout" disabled={Boolean(busy) || cart.items.some(item => !item.active)} onClick={() => void checkout()}>{busy === "checkout" ? "Creating order…" : "Reserve stock & create order"}</button></footer></>}</section><p className="notice" aria-live="polite">{notice}</p></>}</main>;
}

const cartStyles = `.cart-page{min-height:100vh;background:#f8f7f1;color:#17251f;padding:0 5vw 70px}.cart-page header,.cart-page>section,.cart-page>.notice{max-width:980px;margin-left:auto;margin-right:auto}.cart-page header{height:78px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #dfe2d9}.cart-page header a,.cart-page a{color:#1f8a58;text-decoration:none;font-weight:700}.cart-page header span,.intro>p,.gate>p{color:#1f8a58}.intro,.gate{padding:70px 0 35px}.intro>p,.gate>p{font:600 10px ui-monospace,monospace;letter-spacing:.13em}.intro h1,.gate h1{font-size:clamp(42px,7vw,72px);letter-spacing:-4px;line-height:.9;margin:12px 0}.intro>span,.gate>span{color:#68746e;display:block;max-width:650px;line-height:1.6}.gate button{margin-top:24px;border:0;border-radius:10px;background:#17251f;color:white;padding:13px 18px;font-weight:700}.cart-panel{background:white;border:1px solid #e4e5df;border-radius:18px;padding:26px}.items{display:grid;gap:0}.items article{display:grid;grid-template-columns:1fr 120px 150px;gap:18px;align-items:center;padding:19px 0;border-bottom:1px solid #edf0ea}.items article.inactive{opacity:.65}.items p,.items small{color:#68746e;margin:5px 0;font-size:12px}.items label{font-size:11px;font-weight:700;display:grid;gap:6px}.items input{width:75px;border:1px solid #d8ddd6;border-radius:8px;padding:9px}.line{display:grid;justify-items:end;gap:7px}.line button{border:0;background:none;color:#1f8a58;font-weight:700}.line .remove{color:#bd5341}.cart-panel footer{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center;padding-top:24px}.cart-panel footer strong{font-size:24px}.cart-panel .checkout{grid-column:1/-1;border:0;border-radius:10px;background:#17251f;color:white;padding:13px 18px;font-weight:700}.cart-panel .checkout:disabled{opacity:.55}.empty{text-align:center;padding:60px}.notice{color:#1f8a58;font-size:13px;padding-top:12px}@media(max-width:700px){.cart-page{padding:0 20px 45px}.items article{grid-template-columns:1fr 75px}.line{grid-column:1/-1;display:flex;align-items:center;justify-content:flex-end}.intro h1,.gate h1{letter-spacing:-2.5px}.cart-panel{padding:18px}}`;
