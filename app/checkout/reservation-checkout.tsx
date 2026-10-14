"use client";
import { SignInButton, useAuth } from "@clerk/nextjs";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CheckoutItem, Reservation } from "../../lib/reservation-service";

export default function Checkout({ item, reservationId }: { item: CheckoutItem; reservationId?: string }) {
  const { isLoaded, isSignedIn } = useAuth();
  const [available, setAvailable] = useState(item.available);
  const [quantity, setQuantity] = useState(1);
  const [reservation, setReservation] = useState<Reservation | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const key = useRef<string | null>(null);
  const sending = useRef(false);
  const deadline = useRef(0);
  const accept = useCallback((value: Reservation) => {
    deadline.current = Date.now() + Math.max(0, Date.parse(value.expiresAt) - Date.parse(value.serverNow));
    setSeconds(Math.max(0, Math.ceil((deadline.current - Date.now()) / 1000)));
    setReservation(value);
  }, []);
  const refresh = useCallback(async () => {
    const response = await fetch(`/api/checkout/availability?variant=${encodeURIComponent(item.id)}`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || "Could not refresh stock.");
    setAvailable(data.item.available);
  }, [item.id]);
  useEffect(() => {
    if (!reservationId || !isSignedIn) return;
    let stopped = false;
    void (async () => {
      try {
        const response = await fetch(`/api/checkout/reservations/${encodeURIComponent(reservationId)}`, { cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw Error(data.error);
        if (data.reservation.variantId !== item.id) throw Error("Checkout SKU does not match.");
        if (!stopped) accept(data.reservation);
      } catch (error) { if (!stopped) setNotice(error instanceof Error ? error.message : "Could not load checkout."); }
    })();
    return () => { stopped = true; };
  }, [reservationId, isSignedIn, item.id, accept]);
  useEffect(() => {
    if (!reservation || reservation.status !== "held") return;
    const timer = setInterval(() => setSeconds(Math.max(0, Math.ceil((deadline.current - Date.now()) / 1000))), 1000);
    // Poll authoritative state too: the browser timer never decides stock validity.
    const poll = setInterval(() => { void (async () => {
      try {
        const response = await fetch(`/api/checkout/reservations/${encodeURIComponent(reservation.id)}`, { cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw Error(data.error);
        accept(data.reservation); await refresh();
      } catch (error) { setNotice(error instanceof Error ? error.message : "Could not verify checkout."); }
    })(); }, 5000);
    return () => { clearInterval(timer); clearInterval(poll); };
  }, [reservation, accept, refresh]);
  async function reserve() {
    if (sending.current) return;
    sending.current = true; setBusy(true); setNotice("");
    key.current ??= crypto.randomUUID(); setAttempted(true);
    try {
      const response = await fetch("/api/checkout/reservations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ variantId: item.id, quantity, key: key.current }) });
      const data = await response.json();
      if (!response.ok) {
        if (data.reservationId) window.location.assign(`/checkout?variant=${encodeURIComponent(item.id)}&reservation=${encodeURIComponent(data.reservationId)}`);
        throw Error(data.error);
      }
      accept(data.reservation);
      window.history.replaceState(null, "", `/checkout?variant=${encodeURIComponent(item.id)}&reservation=${encodeURIComponent(data.reservation.id)}`);
      await refresh();
    } catch (error) { setNotice(error instanceof Error ? error.message : "Request failed. Retry uses the same key to prevent duplicate holds."); }
    finally { sending.current = false; setBusy(false); }
  }
  return <section><h2>{item.title}</h2><p>{item.name} · {item.sku}</p><p>₹{item.price.toLocaleString("en-IN")} per unit</p><p aria-live="polite">Available to reserve: {available}</p>
    <button disabled={busy} onClick={() => void refresh().catch(e => setNotice(e.message))}>Refresh availability</button>
    {!isLoaded ? <p>Loading sign-in…</p> : !isSignedIn ? <SignInButton mode="modal"><button>Sign in to start checkout</button></SignInButton> : reservation ? <div aria-live="polite"><h3>{reservation.status === "held" ? "Stock reserved" : reservation.status === "released" ? "Reservation released after payment failure" : "Reservation expired"}</h3><p>{reservation.quantity} unit(s) · ₹{(reservation.unitPrice * reservation.quantity).toLocaleString("en-IN")}</p><p>Reservation: {reservation.id}</p><p>Expires: {new Date(reservation.expiresAt).toLocaleString()}</p>{reservation.status === "held" ? <p>Time remaining: {Math.floor(seconds / 60)}m {seconds % 60}s{seconds === 0 && " — confirming expiry…"}</p> : <><p>The hold no longer reduces available stock. Physical stock was not changed.</p><a href={`/checkout?variant=${encodeURIComponent(item.id)}`}>Start a new checkout</a></>}<p>No payment taken. This is a stock reservation, not a confirmed order.</p></div> : <form onSubmit={e => { e.preventDefault(); void reserve(); }}><label htmlFor="checkout-quantity">Quantity (1–20)</label><input id="checkout-quantity" type="number" min={1} max={20} required value={quantity} disabled={busy || attempted} onChange={e => setQuantity(Number(e.target.value))} /><button disabled={busy || available < quantity}>{busy ? "Reserving…" : attempted ? "Retry reservation" : "Reserve stock for checkout"}</button><p>Stock is checked again when you reserve. Availability can change.</p></form>}
    <p role="alert">{notice}</p><style>{`section{border:1px solid #dfe2d9;border-radius:16px;padding:24px;background:white}section button,section input{font:inherit;padding:12px;margin:8px;border-radius:8px;border:1px solid #dfe2d9}section button{background:#17251f;color:white;cursor:pointer}section button:disabled{opacity:.5}section form label{display:block}section p{overflow-wrap:anywhere}`}</style>
  </section>;
}
