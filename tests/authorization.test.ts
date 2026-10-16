import assert from "node:assert/strict";
import test from "node:test";
import { canAccessAdminOperations, canApproveSellers, canBuy, canInviteOrganizationStaff, canManageOwnRecord, canManageSeller, canOperateStore, sellerAccountId, type Actor } from "../lib/authorization";

const buyer: Actor = { id: 1, clerkId: "buyer", role: "buyer", staffForSellerId: null, sellerApprovalStatus: "not_requested" };
const seller: Actor = { id: 2, clerkId: "seller", role: "seller", staffForSellerId: null, sellerApprovalStatus: "approved" };
const staff: Actor = { id: 3, clerkId: "staff", role: "seller_staff", staffForSellerId: 2, sellerApprovalStatus: "approved" };
const pendingSeller: Actor = { id: 5, clerkId: "pending-seller", role: "seller", staffForSellerId: null, sellerApprovalStatus: "pending" };
const admin: Actor = { id: 4, clerkId: "admin", role: "admin", staffForSellerId: null, sellerApprovalStatus: "not_requested" };

test("seller staff can manage only their assigned seller account", () => {
  assert.equal(sellerAccountId(staff), 2);
  assert.equal(canManageSeller(staff, 2), true);
  assert.equal(canManageSeller(staff, 9), false);
  assert.equal(canManageSeller(buyer, 2), false);
  assert.equal(canManageSeller(admin, 9), true);
});

test("buyer permissions and personal ownership rules are explicit", () => {
  assert.equal(canBuy(buyer), true);
  assert.equal(canBuy(seller), true);
  assert.equal(canBuy(staff), false);
  assert.equal(canManageOwnRecord(buyer, 1), true);
  assert.equal(canManageOwnRecord(buyer, 2), false);
  assert.equal(canManageOwnRecord(admin, 2), true);
});

test("only the seller owner or an admin can invite organization staff", () => {
  assert.equal(canInviteOrganizationStaff(seller, 2), true);
  assert.equal(canInviteOrganizationStaff(seller, 9), false);
  assert.equal(canInviteOrganizationStaff(staff, 2), false);
  assert.equal(canInviteOrganizationStaff(buyer, 2), false);
  assert.equal(canInviteOrganizationStaff(admin, 2), true);
});

test("seller approval gates store operation and reserves decisions for administrators", () => {
  assert.equal(canOperateStore(seller), true);
  assert.equal(canOperateStore(staff), true);
  assert.equal(canOperateStore(pendingSeller), false);
  assert.equal(canManageSeller(pendingSeller, 5), false);
  assert.equal(canOperateStore(admin), true);
  assert.equal(canApproveSellers(admin), true);
  assert.equal(canApproveSellers(seller), false);
  assert.equal(canAccessAdminOperations(admin), true);
  assert.equal(canAccessAdminOperations(seller), false);
});
