"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Show, SignInButton, UserButton, useAuth } from "@clerk/nextjs";

type Listing = {
  id: string | number;
  title: string;
  price: number;
  location: string;
  category: string;
  condition: string;
  seller: string;
  time: string;
  createdAt?: string;
  imageUrl?: string | null;
  hue: string;
  emoji: string;
  description: string;
};

function relativePostedTime(value?: string) {
  if (!value) return null;
  const postedAt = new Date(value).getTime();
  if (Number.isNaN(postedAt)) return null;
  const minutes = Math.max(0, Math.floor((Date.now() - postedAt) / 60000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

const listings: Listing[] = [
  {
    id: 1,
    title: "Sony WH-1000XM5 headphones",
    price: 21800,
    location: "Indiranagar, Bengaluru",
    category: "Electronics",
    condition: "Like new",
    seller: "Aarav K.",
    time: "Today",
    hue: "violet",
    emoji: "🎧",
    description:
      "Barely used noise-cancelling headphones with original case and cable. Bill available.",
  },
  {
    id: 2,
    title: "Herman Miller-style ergonomic chair",
    price: 9500,
    location: "Koramangala, Bengaluru",
    category: "Furniture",
    condition: "Good",
    seller: "Nisha R.",
    time: "Today",
    hue: "orange",
    emoji: "🪑",
    description:
      "Adjustable lumbar support, armrests and mesh back. Pickup preferred.",
  },
  {
    id: 3,
    title: "iPhone 15, 128 GB, Blue",
    price: 46500,
    location: "HSR Layout, Bengaluru",
    category: "Mobiles",
    condition: "Like new",
    seller: "Sanjay P.",
    time: "Yesterday",
    hue: "blue",
    emoji: "📱",
    description:
      "Purchased in January. Battery health 98%. Includes box, cable and invoice.",
  },
  {
    id: 4,
    title: "Trek Marlin 5 mountain bike",
    price: 26500,
    location: "Whitefield, Bengaluru",
    category: "Bikes",
    condition: "Good",
    seller: "Meera S.",
    time: "Yesterday",
    hue: "green",
    emoji: "🚲",
    description:
      "Medium frame, recently serviced and ready to ride. Helmet included.",
  },
  {
    id: 5,
    title: "Canon EOS R50 creator kit",
    price: 49800,
    location: "Jayanagar, Bengaluru",
    category: "Electronics",
    condition: "Like new",
    seller: "Rohan M.",
    time: "2 days ago",
    hue: "rose",
    emoji: "📷",
    description:
      "Mirrorless camera with 18-45 mm kit lens, two batteries and travel bag.",
  },
  {
    id: 6,
    title: "Study desk with drawer",
    price: 3200,
    location: "BTM Layout, Bengaluru",
    category: "Furniture",
    condition: "Good",
    seller: "Ishita D.",
    time: "2 days ago",
    hue: "yellow",
    emoji: "🪵",
    description:
      "Solid wood work desk with storage drawer. Compact and ideal for a home office.",
  },
  {
    id: 7,
    title: "Royal Enfield Classic 350",
    price: 148000,
    location: "Malleshwaram, Bengaluru",
    category: "Bikes",
    condition: "Good",
    seller: "Vikram N.",
    time: "3 days ago",
    hue: "red",
    emoji: "🏍️",
    description:
      "Single-owner bike with service history. Transfer paperwork ready.",
  },
  {
    id: 8,
    title: "MacBook Air M2, 16 GB RAM",
    price: 73500,
    location: "MG Road, Bengaluru",
    category: "Electronics",
    condition: "Like new",
    seller: "Ananya G.",
    time: "3 days ago",
    hue: "teal",
    emoji: "💻",
    description:
      "Midnight finish, 512 GB storage. Great for engineering and design work.",
  },
];

const categories = [
  ["All", "✨"],
  ["Mobiles", "📱"],
  ["Electronics", "💻"],
  ["Bikes", "🏍️"],
  ["Furniture", "🪑"],
  ["Jobs", "💼"],
  ["Property", "🏠"],
  ["Fashion", "👟"],
];
const money = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

export default function Home() {
  const { getToken, isSignedIn } = useAuth();
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState("All");
  const [locationFilter, setLocationFilter] = useState("");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [sortBy, setSortBy] = useState<"newest" | "price_low" | "price_high">(
    "newest",
  );
  const [selected, setSelected] = useState<Listing | null>(null);
  const [favourites, setFavourites] = useState<Array<string | number>>([3]);
  const [cart, setCart] = useState<Listing[]>([]);
  const [showCart, setShowCart] = useState(false);
  const [showSell, setShowSell] = useState(false);
  const [toast, setToast] = useState("");
  const [marketListings, setMarketListings] = useState<Listing[]>([]);
  const sourceListings = marketListings.length ? marketListings : listings;
  const visibleListings = useMemo(() => {
    const location = locationFilter.trim().toLowerCase();
    const minimum = Number(minPrice) || 0;
    const maximum = Number(maxPrice) || Number.POSITIVE_INFINITY;
    return [...sourceListings]
      .filter((item) => {
        const matchesCategory =
          activeCategory === "All" || item.category === activeCategory;
        const q = query.trim().toLowerCase();
        return (
          matchesCategory &&
          (!q ||
            `${item.title} ${item.category} ${item.location} ${item.description}`
              .toLowerCase()
              .includes(q)) &&
          (!location || item.location.toLowerCase().includes(location)) &&
          item.price >= minimum &&
          item.price <= maximum
        );
      })
      .sort((a, b) =>
        sortBy === "price_low"
          ? a.price - b.price
          : sortBy === "price_high"
            ? b.price - a.price
            : 0,
      );
  }, [
    activeCategory,
    locationFilter,
    maxPrice,
    minPrice,
    query,
    sortBy,
    sourceListings,
  ]);
  useEffect(() => {
    void fetch("/api/listings")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!data?.listings?.length) return;
        const hues = [
          "violet",
          "orange",
          "blue",
          "green",
          "rose",
          "yellow",
          "red",
          "teal",
        ];
        const iconByCategory: Record<string, string> = {
          Electronics: "💻",
          Mobiles: "📱",
          Furniture: "🪑",
          Bikes: "🏍️",
          Fashion: "👟",
        };
        setMarketListings(
          data.listings.map(
            (
              item: {
                id: number;
                title: string;
                price: number;
                city: string;
                category: string;
                conditionLabel: string;
                sellerName: string;
                description: string;
                createdAt: string;
                imageUrl: string | null;
              },
              index: number,
            ) => ({
              id: item.id,
              title: item.title,
              price: item.price,
              location: item.city,
              category: item.category,
              condition: item.conditionLabel,
              seller: item.sellerName,
              time: relativePostedTime(item.createdAt) || "Recently posted",
              createdAt: item.createdAt,
              imageUrl: item.imageUrl,
              hue: hues[index % hues.length],
              emoji: iconByCategory[item.category] || "✨",
              description: item.description,
            }),
          ),
        );
      })
      .catch(() => undefined);
  }, []);
  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2500);
  }
  async function toggleFavourite(id: string | number) {
    if (!isSignedIn) {
      notify("Sign in to save listings.");
      return;
    }
    const saved = favourites.includes(id);
    const token = await getToken();
    const response = await fetch("/api/favourites", {
      method: saved ? "DELETE" : "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ listingId: String(id) }),
    });
    if (!response.ok) {
      notify("Could not update your saved listings.");
      return;
    }
    setFavourites((current) =>
      saved ? current.filter((entry) => entry !== id) : [...current, id],
    );
  }
  async function contactSeller(listingId: string | number) {
    if (!isSignedIn) {
      notify("Sign in to contact the seller.");
      return;
    }
    const token = await getToken();
    const response = await fetch("/api/conversations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ listingId: String(listingId) }),
    });
    const data = await response.json();
    notify(
      response.ok
        ? "Conversation opened. Your secure inbox is ready next."
        : data.error || "Could not start a conversation.",
    );
  }
  async function requestPickup(listingId: string | number) {
    if (!isSignedIn) {
      notify("Sign in to request local pickup.");
      return;
    }
    const token = await getToken();
    const response = await fetch("/api/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        listingId: String(listingId),
        paymentMethod: "cash_on_pickup",
      }),
    });
    const data = await response.json();
    if (response.ok) {
      setSelected(null);
      notify("Pickup request sent. Pay only when you meet the seller.");
    } else notify(data.error || "Could not send your pickup request.");
  }
  function addToCart(item: Listing) {
    if (!cart.some((entry) => entry.id === item.id))
      setCart((current) => [...current, item]);
    setSelected(null);
    setShowCart(true);
  }

  return (
    <main className="min-h-screen">
      <div className="announcement">
        <span>Free delivery protection on eligible purchases</span>
        <button
          onClick={() =>
            notify("You are already seeing protected listings first.")
          }
        >
          Learn more →
        </button>
      </div>
      <header className="site-header">
        <Link href="/products" aria-label="Browse product catalog">Products</Link>
        <button
          className="brand"
          aria-label="VyapaarCart home"
          onClick={() => {
            setActiveCategory("All");
            setQuery("");
          }}
        >
          <span className="brand-mark">V</span>
          <span>
            Vyapaar<span>Cart</span>
          </span>
        </button>
        <div className="searchbar">
          <span className="search-icon">⌕</span>
          <input
            aria-label="Search listings"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search for cars, phones, furniture and more"
          />
          <button
            onClick={() =>
              document.getElementById("fresh-picks")?.scrollIntoView({
                behavior: "smooth",
              })
            }
          >
            Search
          </button>
        </div>
        <div className="header-actions">
          <button className="location">
            ⌖ Bengaluru <span>⌄</span>
          </button>
          <Show when="signed-out">
            <SignInButton>
              <button
                className="sign-in-button"
                style={{
                  border: 0,
                  background: "none",
                  color: "var(--ink)",
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                Sign in
              </button>
            </SignInButton>
          </Show>
          <Show when="signed-in">
            <a href="/orders" className="link-button">
              Orders
            </a>
            <a href="/inbox" className="link-button">
              Inbox
            </a>
            <a href="/dashboard" className="link-button">
              My listings
            </a>
            <UserButton />
          </Show>
          <button
            className="cart-button"
            onClick={() => window.location.assign("/cart")}
            aria-label="Open your saved buyer cart"
          >
            ⌁ <span>Cart</span>
          </button>
          <button
            className="sell-button"
            onClick={() => window.location.assign("/dashboard")}
          >
            ＋ Sell
          </button>
        </div>
      </header>
      <section className="category-row" aria-label="Categories">
        {categories.map(([label, icon]) => (
          <button
            key={label}
            className={
              activeCategory === label ? "category active" : "category"
            }
            onClick={() => setActiveCategory(label)}
          >
            <span>{icon}</span>
            {label}
          </button>
        ))}
      </section>
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">BUY SMART. SELL SIMPLY.</p>
          <h1>
            Find good things.
            <br />
            <em>Give them a next life.</em>
          </h1>
          <p>
            India’s friendly marketplace for pre-loved tech, furniture, vehicles
            and local finds.
          </p>
          <div className="hero-buttons">
            <button
              className="primary"
              onClick={() =>
                document
                  .getElementById("fresh-picks")
                  ?.scrollIntoView({ behavior: "smooth" })
              }
            >
              Browse listings <span>→</span>
            </button>
            <button
              className="secondary"
              onClick={() => window.location.assign("/dashboard")}
            >
              Start selling
            </button>
          </div>
          <div className="hero-proof">
            <span className="faces">● ● ● ●</span>
            <b>18,000+</b> neighbours buying and selling this week
          </div>
        </div>
        <div className="hero-art" aria-hidden="true">
          <div className="orbit orbit-one">★</div>
          <div className="orbit orbit-two">✦</div>
          <div className="hero-card phone-card">
            <span>📱</span>
            <b>Great finds</b>
            <small>near you</small>
          </div>
          <div className="hero-card chair-card">
            <span>🪑</span>
            <b>Second life</b>
            <small>for good stuff</small>
          </div>
          <div className="hero-ring" />
          <div className="hero-bubble">
            Trusted local
            <br />
            <b>commerce</b> ✦
          </div>
        </div>
      </section>
      <section className="trust-strip">
        <div>
          <span>✦</span>
          <b>Verified community</b>
          <small>Profiles and safety checks</small>
        </div>
        <div>
          <span>◒</span>
          <b>Protected payments</b>
          <small>Pay only when you’re ready</small>
        </div>
        <div>
          <span>♡</span>
          <b>Local by default</b>
          <small>Meet nearby or arrange delivery</small>
        </div>
        <div>
          <span>◌</span>
          <b>Support that listens</b>
          <small>Here when a deal needs help</small>
        </div>
      </section>
      <section id="fresh-picks" className="content-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">CURATED FOR YOU</p>
            <h2>Fresh picks nearby</h2>
          </div>
          <button
            className="text-link"
            onClick={() => {
              setActiveCategory("All");
              setQuery("");
              setLocationFilter("");
              setMinPrice("");
              setMaxPrice("");
              setSortBy("newest");
            }}
          >
            Clear filters <span>×</span>
          </button>
        </div>
        <div className="filter-row">
          <button
            className={activeCategory === "All" ? "filter active" : "filter"}
            onClick={() => setActiveCategory("All")}
          >
            All listings
          </button>
          <button
            className={
              activeCategory === "Electronics" ? "filter active" : "filter"
            }
            onClick={() => setActiveCategory("Electronics")}
          >
            Electronics
          </button>
          <button
            className={
              activeCategory === "Furniture" ? "filter active" : "filter"
            }
            onClick={() => setActiveCategory("Furniture")}
          >
            Home & furniture
          </button>
          <button
            className={activeCategory === "Bikes" ? "filter active" : "filter"}
            onClick={() => setActiveCategory("Bikes")}
          >
            Vehicles
          </button>
          <button
            className={maxPrice === "10000" ? "filter active" : "filter"}
            onClick={() => setMaxPrice(maxPrice === "10000" ? "" : "10000")}
          >
            Under ₹10,000
          </button>
        </div>
        <div className="discovery-controls" aria-label="Listing filters">
          <label>
            Location
            <input
              value={locationFilter}
              onChange={(event) => setLocationFilter(event.target.value)}
              placeholder="e.g. Bengaluru"
            />
          </label>
          <label>
            Min price
            <input
              inputMode="numeric"
              value={minPrice}
              onChange={(event) =>
                setMinPrice(event.target.value.replace(/\D/g, ""))
              }
              placeholder="₹ 0"
            />
          </label>
          <label>
            Max price
            <input
              inputMode="numeric"
              value={maxPrice}
              onChange={(event) =>
                setMaxPrice(event.target.value.replace(/\D/g, ""))
              }
              placeholder="No limit"
            />
          </label>
          <label>
            Sort
            <select
              value={sortBy}
              onChange={(event) =>
                setSortBy(
                  event.target.value as "newest" | "price_low" | "price_high",
                )
              }
            >
              <option value="newest">Newest first</option>
              <option value="price_low">Price: low to high</option>
              <option value="price_high">Price: high to low</option>
            </select>
          </label>
          <span className="result-count">
            {visibleListings.length}{" "}
            {visibleListings.length === 1 ? "listing" : "listings"}
          </span>
        </div>
        <div className="listing-grid">
          {visibleListings.map((item) => (
            <article className="listing-card" key={item.id}>
              <button
                className={
                  favourites.includes(item.id) ? "heart favourited" : "heart"
                }
                onClick={() => toggleFavourite(item.id)}
                aria-label={`Save ${item.title}`}
              >
                {favourites.includes(item.id) ? "♥" : "♡"}
              </button>
              <button
                className={`listing-image ${item.hue}`}
                onClick={() => setSelected(item)}
                aria-label={`View ${item.title}`}
              >
                {item.imageUrl ? (
                  <img src={item.imageUrl} alt={item.title} />
                ) : (
                  <span>{item.emoji}</span>
                )}
                <small>{item.condition}</small>
              </button>
              <div className="listing-body">
                <div className="price">{money.format(item.price)}</div>
                {item.createdAt ? (
                  <a className="listing-title" href={`/listings/${item.id}`}>
                    {item.title}
                  </a>
                ) : (
                  <button
                    className="listing-title"
                    onClick={() => setSelected(item)}
                  >
                    {item.title}
                  </button>
                )}
                <p>{item.location}</p>
                <div className="listing-meta">
                  <span>{relativePostedTime(item.createdAt) || item.time}</span>
                  <span>•</span>
                  <span>{item.category}</span>
                </div>
              </div>
            </article>
          ))}
        </div>
        {visibleListings.length === 0 && (
          <div className="empty-state">
            No listings match that search. Try a wider search or another
            category.
          </div>
        )}
      </section>
      <section className="seller-cta">
        <div>
          <p className="eyebrow">TURN CLUTTER INTO CASH</p>
          <h2>
            That thing you don’t use?
            <br />
            <em>Someone nearby needs it.</em>
          </h2>
          <p>
            Post in less than two minutes. Chat with genuine buyers. Stay in
            control of every deal.
          </p>
          <button
            className="primary light"
            onClick={() => window.location.assign("/dashboard")}
          >
            List an item for free <span>→</span>
          </button>
        </div>
        <div className="seller-shapes" aria-hidden="true">
          <div className="sticker one">₹</div>
          <div className="sticker two">★</div>
          <div className="bag">♧</div>
        </div>
      </section>
      <footer>
        <button className="brand footer-brand">
          <span className="brand-mark">V</span>
          <span>
            Vyapaar<span>Cart</span>
          </span>
        </button>
        <span>Good things deserve another story.</span>
        <span>© 2026 VyapaarCart</span>
      </footer>
      {selected && (
        <div
          className="overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Listing details"
          onMouseDown={() => setSelected(null)}
        >
          <div
            className="listing-modal"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button className="close" onClick={() => setSelected(null)}>
              ×
            </button>
            <div className={`modal-image ${selected.hue}`}>
              {selected.imageUrl ? (
                <img src={selected.imageUrl} alt={selected.title} />
              ) : (
                <span>{selected.emoji}</span>
              )}
              <small>{selected.condition}</small>
            </div>
            <div className="modal-content">
              <p className="eyebrow">
                {selected.category} · {selected.location}
              </p>
              <h2>{selected.title}</h2>
              <div className="modal-price">{money.format(selected.price)}</div>
              <p className="description">{selected.description}</p>
              <a className="detail-link" href={`/listings/${selected.id}`}>
                Open shareable listing page →
              </a>
              <div className="seller-box">
                <span className="seller-avatar">{selected.seller[0]}</span>
                <div>
                  <b>{selected.seller}</b>
                  <small>Verified seller · Replies within an hour</small>
                </div>
                <button
                  className="text-link"
                  onClick={() => void contactSeller(selected.id)}
                >
                  Chat
                </button>
              </div>
              <div className="modal-actions">
                <button
                  className="secondary"
                  onClick={() => void requestPickup(selected.id)}
                >
                  Request pickup
                </button>
                <button className="primary" onClick={() => addToCart(selected)}>
                  Save for later <span>→</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {showCart && (
        <div
          className="overlay cart-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Shopping cart"
          onMouseDown={() => setShowCart(false)}
        >
          <aside
            className="cart-drawer"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="drawer-header">
              <div>
                <p className="eyebrow">YOUR CART</p>
                <h2>Ready when you are</h2>
              </div>
              <button className="close" onClick={() => setShowCart(false)}>
                ×
              </button>
            </div>
            {cart.length ? (
              <>
                <div className="cart-items">
                  {cart.map((item) => (
                    <div className="cart-item" key={item.id}>
                      <div className={`cart-thumb ${item.hue}`}>
                        {item.emoji}
                      </div>
                      <div>
                        <b>{item.title}</b>
                        <small>{item.location}</small>
                        <strong>{money.format(item.price)}</strong>
                      </div>
                      <button
                        onClick={() =>
                          setCart((current) =>
                            current.filter((entry) => entry.id !== item.id),
                          )
                        }
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
                <div className="cart-total">
                  <span>Total</span>
                  <b>
                    {money.format(
                      cart.reduce((sum, item) => sum + item.price, 0),
                    )}
                  </b>
                </div>
                <button
                  className="primary checkout"
                  onClick={() =>
                    notify(
                      "Checkout is ready to connect to a payment provider.",
                    )
                  }
                >
                  Continue to checkout <span>→</span>
                </button>
              </>
            ) : (
              <div className="cart-empty">
                <span>⌁</span>
                <h3>Your cart is empty</h3>
                <p>Add a listing to start a protected purchase.</p>
                <button
                  className="secondary"
                  onClick={() => setShowCart(false)}
                >
                  Keep browsing
                </button>
              </div>
            )}
          </aside>
        </div>
      )}
      {showSell && (
        <div
          className="overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Create listing"
          onMouseDown={() => setShowSell(false)}
        >
          <div
            className="sell-modal"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button className="close" onClick={() => setShowSell(false)}>
              ×
            </button>
            <p className="eyebrow">SELL ON VYAPAARCART</p>
            <h2>What are you ready to pass on?</h2>
            <p>
              Start a listing now. You’ll be able to add photos, set your price
              and choose safe delivery options.
            </p>
            <label>
              Listing title
              <input placeholder="e.g. Teak wood study desk" />
            </label>
            <div className="two-fields">
              <label>
                Category
                <select defaultValue="">
                  <option value="" disabled>
                    Choose a category
                  </option>
                  <option>Mobiles</option>
                  <option>Electronics</option>
                  <option>Furniture</option>
                  <option>Bikes</option>
                </select>
              </label>
              <label>
                Expected price
                <input placeholder="₹ 0" />
              </label>
            </div>
            <button
              className="primary wide"
              onClick={() => {
                setShowSell(false);
                notify("Your seller workspace is ready for the next step.");
              }}
            >
              Continue to seller workspace <span>→</span>
            </button>
          </div>
        </div>
      )}
      {toast && <div className="toast">✦ {toast}</div>}
    </main>
  );
}
