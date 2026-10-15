CREATE TABLE IF NOT EXISTS carts (
  id text PRIMARY KEY,
  buyer_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (buyer_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS carts_buyer_id_key ON carts(buyer_id);

CREATE TABLE IF NOT EXISTS cart_items (
  cart_id text NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  variant_id text NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 20),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (cart_id, variant_id)
);
CREATE INDEX IF NOT EXISTS idx_cart_items_variant ON cart_items(variant_id);
