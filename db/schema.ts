import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, pgTable, primaryKey, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

const now = sql`CURRENT_TIMESTAMP::text`;

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  clerkId: text("clerk_id").notNull(),
  displayName: text("display_name").notNull().default("VyapaarCart seller"),
  role: text("role").notNull().default("buyer"),
  staffForSellerId: integer("staff_for_seller_id"),
  sellerApprovalStatus: text("seller_approval_status").notNull().default("not_requested"),
  sellerApprovalRequestedAt: text("seller_approval_requested_at"),
  sellerApprovedAt: text("seller_approved_at"),
  sellerApprovedById: integer("seller_approved_by_id"),
  createdAt: text("created_at").notNull().default(now),
}, (table) => [uniqueIndex("idx_users_clerk_id").on(table.clerkId)]);

export const sellerApprovalAudits = pgTable("seller_approval_audits", {
  id: text("id").primaryKey(),
  sellerId: integer("seller_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  adminId: integer("admin_id").references(() => users.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  previousStatus: text("previous_status").notNull(),
  nextStatus: text("next_status").notNull(),
  createdAt: text("created_at").notNull().default(now),
}, (table) => [index("idx_seller_approval_audits_seller_created_at").on(table.sellerId, table.createdAt)]);

export const stores = pgTable("stores", {
  id: text("id").primaryKey(),
  ownerId: integer("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  description: text("description").notNull(),
  city: text("city").notNull(),
  isPublic: boolean("is_public").notNull().default(true),
  createdAt: text("created_at").notNull().default(now),
  updatedAt: text("updated_at").notNull().default(now),
}, (table) => [uniqueIndex("idx_stores_slug").on(table.slug), index("idx_stores_owner_id").on(table.ownerId)]);

export const storeProducts = pgTable("store_products", {
  id: text("id").primaryKey(),
  storeId: text("store_id").notNull().references(() => stores.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description").notNull(),
  price: integer("price").notNull(),
  status: text("status").notNull().default("active"),
  createdAt: text("created_at").notNull().default(now),
  updatedAt: text("updated_at").notNull().default(now),
}, (table) => [index("idx_store_products_store_status").on(table.storeId, table.status)]);

export const categories = pgTable("categories", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  createdAt: text("created_at").notNull().default(now),
}, (table) => [uniqueIndex("idx_categories_slug").on(table.slug)]);

export const products = pgTable("products", {
  id: text("id").primaryKey(),
  storeId: text("store_id").notNull().references(() => stores.id, { onDelete: "cascade" }),
  categoryId: text("category_id").notNull().references(() => categories.id, { onDelete: "restrict" }),
  title: text("title").notNull(),
  description: text("description").notNull(),
  price: integer("price").notNull(),
  status: text("status").notNull().default("active"),
  createdAt: text("created_at").notNull().default(now),
  updatedAt: text("updated_at").notNull().default(now),
}, (table) => [
  index("idx_products_store_status").on(table.storeId, table.status),
  index("idx_products_category_status").on(table.categoryId, table.status),
  index("idx_products_title").on(table.title),
  index("idx_products_search").using("gin", sql`(setweight(to_tsvector('english', ${table.title}), 'A') || setweight(to_tsvector('english', ${table.description}), 'B'))`),
  index("idx_products_browse").on(table.status, table.createdAt, table.id),
]);

export const productImages = pgTable("product_images", {
  id: text("id").primaryKey(),
  productId: text("product_id").notNull().references(() => products.id, { onDelete: "restrict" }),
  objectKey: text("object_key").notNull(),
  altText: text("alt_text").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  position: integer("position").notNull(),
  status: text("status").notNull().default("pending"),
  createdAt: text("created_at").notNull().default(now),
}, (table) => [
  uniqueIndex("idx_product_images_object_key").on(table.objectKey),
  index("idx_product_images_order").on(table.productId, table.status, table.position),
  check("product_images_size_bytes_check", sql`${table.sizeBytes} > 0 AND ${table.sizeBytes} <= 5242880`),
  check("product_images_position_check", sql`${table.position} >= 0`),
  check("product_images_status_check", sql`${table.status} IN ('pending', 'active', 'deleting')`),
]);

export const productAttributes = pgTable("product_attributes", {
  productId: text("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  value: text("value").notNull(),
  createdAt: text("created_at").notNull().default(now),
}, (table) => [
  primaryKey({ columns: [table.productId, table.key] }),
  index("idx_product_attributes_key_value").on(table.key, table.value),
]);

export const productVariants = pgTable("product_variants", {
  id: text("id").primaryKey(),
  productId: text("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  sku: text("sku").notNull(),
  price: integer("price").notNull(),
  status: text("status").notNull().default("active"),
  createdAt: text("created_at").notNull().default(now),
  updatedAt: text("updated_at").notNull().default(now),
}, (table) => [
  uniqueIndex("idx_product_variants_sku").on(table.sku),
  index("idx_product_variants_product_status").on(table.productId, table.status),
]);

export const warehouses = pgTable("warehouses", {
  id: text("id").primaryKey(),
  storeId: text("store_id").notNull().references(() => stores.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  address: text("address").notNull(),
  city: text("city").notNull(),
  postcode: text("postcode").notNull(),
  createdAt: text("created_at").notNull().default(now),
  updatedAt: text("updated_at").notNull().default(now),
}, (t) => [index("idx_warehouses_store").on(t.storeId)]);

export const warehouseStock = pgTable("warehouse_stock", {
  warehouseId: text("warehouse_id").notNull().references(() => warehouses.id, { onDelete: "restrict" }),
  variantId: text("variant_id").notNull().references(() => productVariants.id, { onDelete: "restrict" }),
  quantity: integer("quantity").notNull().default(0),
  version: integer("version").notNull().default(1),
  updatedAt: text("updated_at").notNull().default(now),
}, (t) => [primaryKey({ columns: [t.warehouseId, t.variantId] }), index("idx_warehouse_stock_variant").on(t.variantId), check("warehouse_stock_quantity_check", sql`${t.quantity} >= 0 AND ${t.quantity} <= 1000000`)]);

export const inventoryAudits = pgTable("inventory_audits", {
  id: text("id").primaryKey(),
  storeId: text("store_id").notNull().references(() => stores.id, { onDelete: "restrict" }),
  warehouseId: text("warehouse_id").notNull().references(() => warehouses.id, { onDelete: "restrict" }),
  variantId: text("variant_id").notNull().references(() => productVariants.id, { onDelete: "restrict" }),
  actorId: integer("actor_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  actorRole: text("actor_role").notNull(),
  sku: text("sku").notNull(),
  previousQuantity: integer("previous_quantity").notNull(),
  quantity: integer("quantity").notNull(),
  stockVersion: integer("stock_version").notNull(),
  reason: text("reason").notNull(),
  createdAt: text("created_at").notNull().default(now),
}, (t) => [index("idx_inventory_audits_warehouse_created").on(t.warehouseId, t.createdAt), uniqueIndex("idx_inventory_audits_stock_version").on(t.warehouseId, t.variantId, t.stockVersion)]);

export const inventoryReservations = pgTable("inventory_reservations", {
  id: text("id").primaryKey(),
  buyerId: integer("buyer_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  variantId: text("variant_id").notNull().references(() => productVariants.id, { onDelete: "restrict" }),
  quantity: integer("quantity").notNull(),
  unitPrice: integer("unit_price").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  releasedAt: timestamp("released_at", { withTimezone: true }),
  releaseReason: text("release_reason"),
}, t => [
  uniqueIndex("inventory_reservations_buyer_id_idempotency_key_key").on(t.buyerId, t.idempotencyKey),
  index("idx_reservations_variant_expiry").on(t.variantId, t.expiresAt),
  check("inventory_reservations_quantity_check", sql`${t.quantity} BETWEEN 1 AND 20`),
  check("inventory_reservations_unit_price_check", sql`${t.unitPrice} > 0`),
  check("inventory_reservations_check", sql`${t.expiresAt} > ${t.createdAt}`),
  check("inventory_reservations_release_check", sql`(${t.releasedAt} IS NULL AND ${t.releaseReason} IS NULL) OR (${t.releasedAt} IS NOT NULL AND ${t.releaseReason} = 'payment_failed')`),
]);

export const inventoryReservationAllocations = pgTable("inventory_reservation_allocations", {
  reservationId: text("reservation_id").notNull().references(() => inventoryReservations.id, { onDelete: "cascade" }),
  warehouseId: text("warehouse_id").notNull(),
  variantId: text("variant_id").notNull(),
  quantity: integer("quantity").notNull(),
}, t => [primaryKey({ columns: [t.reservationId, t.warehouseId] }), foreignKey({ columns: [t.warehouseId, t.variantId], foreignColumns: [warehouseStock.warehouseId, warehouseStock.variantId] }).onDelete("restrict"), index("idx_reservation_allocations_stock").on(t.variantId, t.warehouseId), check("inventory_reservation_allocations_quantity_check", sql`${t.quantity} > 0`)]);

export const carts = pgTable("carts", {
  id: text("id").primaryKey(),
  buyerId: integer("buyer_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, t => [uniqueIndex("carts_buyer_id_key").on(t.buyerId)]);

export const cartItems = pgTable("cart_items", {
  cartId: text("cart_id").notNull().references(() => carts.id, { onDelete: "cascade" }),
  variantId: text("variant_id").notNull().references(() => productVariants.id, { onDelete: "restrict" }),
  quantity: integer("quantity").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, t => [
  primaryKey({ columns: [t.cartId, t.variantId] }),
  index("idx_cart_items_variant").on(t.variantId),
  check("cart_items_quantity_check", sql`${t.quantity} BETWEEN 1 AND 20`),
]);

export const commerceOrders = pgTable("commerce_orders", {
  id: text("id").primaryKey(),
  buyerId: integer("buyer_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("pending_payment"),
  currency: text("currency").notNull().default("INR"),
  total: integer("total").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, t => [index("idx_commerce_orders_buyer_created").on(t.buyerId, t.createdAt), check("commerce_orders_total_check", sql`${t.total} > 0`)]);

export const commerceOrderItems = pgTable("commerce_order_items", {
  orderId: text("order_id").notNull().references(() => commerceOrders.id, { onDelete: "cascade" }),
  variantId: text("variant_id").notNull().references(() => productVariants.id, { onDelete: "restrict" }),
  reservationId: text("reservation_id").notNull().references(() => inventoryReservations.id, { onDelete: "restrict" }),
  storeId: text("store_id").notNull().references(() => stores.id, { onDelete: "restrict" }),
  sellerId: integer("seller_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  quantity: integer("quantity").notNull(),
  unitPrice: integer("unit_price").notNull(),
  lineTotal: integer("line_total").notNull(),
}, t => [primaryKey({ columns: [t.orderId, t.variantId] }), uniqueIndex("commerce_order_items_reservation_id_key").on(t.reservationId), check("commerce_order_items_quantity_check", sql`${t.quantity} BETWEEN 1 AND 20`), check("commerce_order_items_price_check", sql`${t.unitPrice} > 0 AND ${t.lineTotal} = ${t.unitPrice} * ${t.quantity}`)]);

export const paymentIntents = pgTable("payment_intents", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull().references(() => commerceOrders.id, { onDelete: "cascade" }),
  provider: text("provider").notNull().default("internal_test"),
  status: text("status").notNull().default("requires_payment_method"),
  amount: integer("amount").notNull(),
  currency: text("currency").notNull().default("INR"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
}, t => [uniqueIndex("payment_intents_order_id_key").on(t.orderId), check("payment_intents_amount_check", sql`${t.amount} > 0`)]);

export const outboxEvents = pgTable("outbox_events", {
  id: text("id").primaryKey(),
  aggregateType: text("aggregate_type").notNull(),
  aggregateId: text("aggregate_id").notNull(),
  eventType: text("event_type").notNull(),
  payload: text("payload").notNull(),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  publishedAt: timestamp("published_at", { withTimezone: true }),
}, t => [index("idx_outbox_events_status_created").on(t.status, t.createdAt), uniqueIndex("outbox_events_aggregate_event_key").on(t.aggregateType, t.aggregateId, t.eventType)]);

export const productVariantAttributes = pgTable("product_variant_attributes", {
  variantId: text("variant_id").notNull().references(() => productVariants.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  value: text("value").notNull(),
  createdAt: text("created_at").notNull().default(now),
}, (table) => [
  primaryKey({ columns: [table.variantId, table.key] }),
  index("idx_product_variant_attributes_key_value").on(table.key, table.value),
]);

// Refresh tokens are deliberately stored only as one-way hashes. A token can be
// used once, then is replaced by a new token in the same family.
export const refreshTokenSessions = pgTable("refresh_token_sessions", {
  id: text("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  familyId: text("family_id").notNull(),
  tokenHash: text("token_hash").notNull(),
  expiresAt: text("expires_at").notNull(),
  revokedAt: text("revoked_at"),
  revocationReason: text("revocation_reason"),
  replacedById: text("replaced_by_id"),
  createdAt: text("created_at").notNull().default(now),
}, (table) => [
  uniqueIndex("idx_refresh_token_sessions_token_hash").on(table.tokenHash),
  index("idx_refresh_token_sessions_family_id").on(table.familyId),
  index("idx_refresh_token_sessions_user_id").on(table.userId),
]);

export const organizations = pgTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  ownerId: integer("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: text("created_at").notNull().default(now),
}, (table) => [uniqueIndex("idx_organizations_slug").on(table.slug), index("idx_organizations_owner_id").on(table.ownerId)]);

export const organizationMembers = pgTable("organization_members", {
  organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("member"),
  createdAt: text("created_at").notNull().default(now),
}, (table) => [
  primaryKey({ columns: [table.organizationId, table.userId] }),
  index("idx_organization_members_user_id").on(table.userId),
]);

export const listings = pgTable("listings", {
  id: text("id").primaryKey(),
  sellerId: integer("seller_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description").notNull(),
  category: text("category").notNull(),
  price: integer("price").notNull(),
  city: text("city").notNull(),
  conditionLabel: text("condition_label").notNull(),
  status: text("status").notNull().default("active"),
  imageKey: text("image_key"),
  createdAt: text("created_at").notNull().default(now),
  updatedAt: text("updated_at").notNull().default(now),
}, (table) => [
  index("idx_listings_status_created_at").on(table.status, table.createdAt),
  index("idx_listings_seller_id").on(table.sellerId),
]);

export const favourites = pgTable("favourites", {
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  listingId: text("listing_id").notNull().references(() => listings.id, { onDelete: "cascade" }),
  createdAt: text("created_at").notNull().default(now),
}, (table) => [
  primaryKey({ columns: [table.userId, table.listingId] }),
  index("idx_favourites_user_created_at").on(table.userId, table.createdAt),
]);

export const conversations = pgTable("conversations", {
  id: text("id").primaryKey(),
  listingId: text("listing_id").notNull().references(() => listings.id, { onDelete: "cascade" }),
  buyerId: integer("buyer_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  sellerId: integer("seller_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: text("created_at").notNull().default(now),
}, (table) => [
  uniqueIndex("idx_conversations_listing_buyer").on(table.listingId, table.buyerId),
  index("idx_conversations_seller_created_at").on(table.sellerId, table.createdAt),
]);

export const messages = pgTable("messages", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  senderId: integer("sender_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  body: text("body").notNull(),
  createdAt: text("created_at").notNull().default(now),
}, (table) => [index("idx_messages_conversation_created_at").on(table.conversationId, table.createdAt)]);

export const orders = pgTable("orders", {
  id: text("id").primaryKey(),
  listingId: text("listing_id").notNull().references(() => listings.id, { onDelete: "cascade" }),
  buyerId: integer("buyer_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  sellerId: integer("seller_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("requested"),
  paymentMethod: text("payment_method").notNull().default("cash_on_pickup"),
  paymentStatus: text("payment_status").notNull().default("unpaid"),
  razorpayOrderId: text("razorpay_order_id"),
  razorpayPaymentId: text("razorpay_payment_id"),
  shippingName: text("shipping_name"),
  shippingEmail: text("shipping_email"),
  shippingPhone: text("shipping_phone"),
  shippingAddress: text("shipping_address"),
  shippingCity: text("shipping_city"),
  shippingState: text("shipping_state"),
  shippingPincode: text("shipping_pincode"),
  createdAt: text("created_at").notNull().default(now),
  updatedAt: text("updated_at").notNull().default(now),
}, (table) => [
  uniqueIndex("idx_orders_listing_buyer").on(table.listingId, table.buyerId),
  index("idx_orders_seller_status").on(table.sellerId, table.status),
  index("idx_orders_buyer_status").on(table.buyerId, table.status),
]);

export const shipments = pgTable("shipments", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),
  provider: text("provider").notNull().default("sandbox"),
  trackingNumber: text("tracking_number").notNull(),
  status: text("status").notNull().default("label_created"),
  eta: text("eta").notNull(),
  shiprocketShipmentId: text("shiprocket_shipment_id"),
  awbCode: text("awb_code"),
  courierName: text("courier_name"),
  createdAt: text("created_at").notNull().default(now),
  updatedAt: text("updated_at").notNull().default(now),
}, (table) => [
  uniqueIndex("idx_shipments_order_id").on(table.orderId),
  uniqueIndex("idx_shipments_tracking_number").on(table.trackingNumber),
  index("idx_shipments_status_updated_at").on(table.status, table.updatedAt),
]);

export const shipmentEvents = pgTable("shipment_events", {
  id: text("id").primaryKey(),
  shipmentId: text("shipment_id").notNull().references(() => shipments.id, { onDelete: "cascade" }),
  status: text("status").notNull(),
  message: text("message").notNull(),
  occurredAt: text("occurred_at").notNull().default(now),
}, (table) => [index("idx_shipment_events_shipment_occurred_at").on(table.shipmentId, table.occurredAt)]);

export const sellerPickupProfiles = pgTable("seller_pickup_profiles", {
  sellerId: integer("seller_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  pickupLocation: text("pickup_location").notNull(),
  contactName: text("contact_name").notNull(),
  email: text("email").notNull(),
  phone: text("phone").notNull(),
  address: text("address").notNull(),
  city: text("city").notNull(),
  state: text("state").notNull(),
  pincode: text("pincode").notNull(),
  country: text("country").notNull().default("India"),
  updatedAt: text("updated_at").notNull().default(now),
});
