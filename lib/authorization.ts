export const marketplaceRoles = ["buyer", "seller", "seller_staff", "admin"] as const;
export type MarketplaceRole = (typeof marketplaceRoles)[number];
export const sellerApprovalStatuses = ["not_requested", "pending", "approved", "rejected"] as const;
export type SellerApprovalStatus = (typeof sellerApprovalStatuses)[number];

export type Actor = {
  id: number;
  clerkId: string;
  role: MarketplaceRole;
  staffForSellerId: number | null;
  sellerApprovalStatus: SellerApprovalStatus;
};

export function isMarketplaceRole(value: string): value is MarketplaceRole {
  return marketplaceRoles.includes(value as MarketplaceRole);
}

export function sellerAccountId(actor: Actor) {
  return actor.role === "seller_staff" ? actor.staffForSellerId : actor.id;
}

export function isSellerApprovalStatus(value: string): value is SellerApprovalStatus {
  return sellerApprovalStatuses.includes(value as SellerApprovalStatus);
}

export function canOperateStore(actor: Actor) {
  return actor.role === "admin" ||
    ((actor.role === "seller" || actor.role === "seller_staff") && actor.sellerApprovalStatus === "approved");
}

export function canManageSeller(actor: Actor, sellerId: number) {
  return actor.role === "admin" ||
    (canOperateStore(actor) && (actor.role === "seller" || actor.role === "seller_staff") && sellerAccountId(actor) === sellerId);
}

export function canBuy(actor: Actor) {
  return actor.role === "buyer" || actor.role === "seller";
}

export function canManageOwnRecord(actor: Actor, ownerId: number) {
  return actor.role === "admin" || actor.id === ownerId;
}

export function canInviteOrganizationStaff(actor: Actor, organizationOwnerId: number) {
  return actor.role === "admin" || (actor.role === "seller" && actor.sellerApprovalStatus === "approved" && actor.id === organizationOwnerId);
}

export function canApproveSellers(actor: Actor) {
  return actor.role === "admin";
}

export function canAccessAdminOperations(actor: Actor) {
  return actor.role === "admin";
}
