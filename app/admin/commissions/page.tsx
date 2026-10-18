'use client';

import Link from 'next/link';
import { SignInButton, useAuth } from '@clerk/nextjs';
import { useEffect, useState } from 'react';

type Item = { orderId: string; variantId: string; storeId: string; quantity: number; lineTotal: number; commissionRateBps: number; orderStatus: string; refundId: string | null; refundStatus: string | null; grossCommissionPaise: number; reversalPaise: number; netCommissionPaise: number };
type Report = { items: Item[]; totals: { grossCommissionPaise: number; reversalPaise: number; netCommissionPaise: number } };
const money = (paise: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(paise / 100);

export default function CommissionPage() {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const [report, setReport] = useState<Report | null>(null);
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    let active = true;
    void (async () => {
      try {
        const token = await getToken();
        const response = await fetch('/api/admin/commissions', { headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: 'no-store' });
        const data = await response.json();
        if (active) {
          if (response.ok) setReport(data);
          else setMessage(data.error ?? 'Could not load commissions.');
        }
      } catch { if (active) setMessage('Could not load commissions. Please try again.'); }
    })();
    return () => { active = false; };
  }, [isLoaded, isSignedIn, getToken]);
  return <main className="commission"><header><Link href="/admin">← Admin operations</Link><h1>Platform commissions</h1><p>Paid checkout items only. Each item retains its checkout commission rate; successful whole-order refunds reverse that item’s commission. The current test policy is 5%. This is a calculated report, not a payout.</p></header>{!isLoaded ? <p>Loading session…</p> : !isSignedIn ? <SignInButton><button>Sign in</button></SignInButton> : message ? <p role="alert">{message}</p> : !report ? <p>Loading report…</p> : <><section className="totals"><div>Gross commission<strong>{money(report.totals.grossCommissionPaise)}</strong></div><div>Refund reversals<strong>{money(report.totals.reversalPaise)}</strong></div><div>Net commission<strong>{money(report.totals.netCommissionPaise)}</strong></div></section><h2>Order item details</h2>{report.items.length === 0 ? <p>No paid checkout items to report yet.</p> : <div className="table"><table><thead><tr><th>Order / variant</th><th>Item value</th><th>Commission</th><th>Refund</th><th>Reversal</th><th>Net</th></tr></thead><tbody>{report.items.map(item => <tr key={`${item.orderId}:${item.variantId}`}><td><strong>{item.orderId}</strong><br />Variant: {item.variantId}<br />Store: {item.storeId} · Qty {item.quantity}</td><td>{money(item.lineTotal * 100)}</td><td>{money(item.grossCommissionPaise)}<br />{(item.commissionRateBps / 100).toFixed(2)}%</td><td>{item.refundId ? <>{item.refundStatus}<br />{item.refundId}</> : 'None'}</td><td>{money(item.reversalPaise)}</td><td>{money(item.netCommissionPaise)}</td></tr>)}</tbody></table></div>}</>}<style>{`.commission{max-width:1200px;margin:auto;padding:48px 24px;color:#17251f}.commission a{color:#198453}.commission h1{font-size:42px;letter-spacing:-2px}.commission p{color:#66746c;max-width:760px;line-height:1.5}.totals{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:32px 0}.totals div{background:#f2f6ee;padding:18px;border-radius:12px}.totals strong{display:block;font-size:24px;margin-top:8px}.table{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;border-bottom:1px solid #ddd;padding:14px 10px;vertical-align:top;overflow-wrap:anywhere}th{color:#66746c}td:first-child{max-width:300px}@media(max-width:650px){.totals{grid-template-columns:1fr}}`}</style></main>;
}
