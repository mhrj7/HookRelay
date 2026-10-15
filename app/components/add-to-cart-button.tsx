"use client";

import Link from "next/link";
import { SignInButton, useAuth } from "@clerk/nextjs";
import { useState } from "react";

export default function AddToCartButton({ variantId }: { variantId: string }) {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  async function add() {
    setBusy(true);
    setNotice("");
    try {
      const token = await getToken();
      const response = await fetch("/api/cart", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ variantId, quantity: 1 }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not add this SKU.");
      setNotice("Added. ");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not add this SKU.");
    } finally {
      setBusy(false);
    }
  }

  if (!isLoaded) return <button disabled>Loading…</button>;
  if (!isSignedIn) return <SignInButton mode="modal"><button type="button">Sign in to add</button></SignInButton>;
  return <span className="cart-action"><button type="button" disabled={busy} onClick={() => void add()}>{busy ? "Adding…" : "Add to cart"}</button><span aria-live="polite">{notice}{notice === "Added. " && <Link href="/cart">View cart</Link>}</span></span>;
}
