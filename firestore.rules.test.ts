import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const rulesPath = path.resolve(process.cwd(), 'DRAFT_firestore.rules');
const finalRulesPath = path.resolve(process.cwd(), 'firestore.rules');

function readRules(): string {
  if (fs.existsSync(finalRulesPath)) return fs.readFileSync(finalRulesPath, 'utf8');
  return fs.readFileSync(rulesPath, 'utf8');
}

// Dirty Dozen payload definitions verifying schema & invariant rejection guarantees
const DIRTY_DOZEN_CASES = [
  {
    name: '1. Identity Spoofing on /farms/{farmId}',
    collection: 'farms',
    payload: { id: 'farm_1', ownerId: 'victim_uid' },
    requiredGuard: 'data.ownerId == request.auth.uid',
  },
  {
    name: '2. Ghost Field / Shadow Write (isVerified: true)',
    collection: 'farms',
    payload: { id: 'farm_1', isVerified: true },
    requiredGuard: 'data.keys().hasOnly([',
  },
  {
    name: '3. Self-Assigned Admin Role on /users/{userId}',
    collection: 'users',
    payload: { uid: 'attacker_uid', role: 'PLATFORM_ADMIN' },
    requiredGuard: "data.role == 'FARMER'",
  },
  {
    name: '4. PII Cross-Tenant Read on /users/{userId}/private/{docId}',
    collection: 'users/private',
    payload: { operation: 'get', requester: 'attacker_uid', target: 'victim_uid' },
    requiredGuard: 'isOwner(userId) || isAdmin()',
  },
  {
    name: '5. Unverified Email Bypass (email_verified: false)',
    collection: 'auth',
    payload: { email_verified: false },
    requiredGuard: 'request.auth.token.email_verified == true',
  },
  {
    name: '6. Orphaned Subcollection Create (/farms/{farmId}/fields/{fieldId})',
    collection: 'fields',
    payload: { id: 'f_1', farmId: 'nonexistent_farm' },
    requiredGuard: 'isFarmOwner(farmId)',
  },
  {
    name: '7. Immutable Owner/CreatedAt Overwrite on update',
    collection: 'farms',
    payload: { ownerId: 'new_owner', createdAt: '1999-01-01' },
    requiredGuard: 'incoming().ownerId == existing().ownerId',
  },
  {
    name: '8. Terminal State Unlock on COMPLETED task',
    collection: 'tasks',
    payload: { existingStatus: 'COMPLETED', status: 'UPCOMING' },
    requiredGuard: "existing().status != 'COMPLETED'",
  },
  {
    name: '9. Client Timestamp Forgery',
    collection: 'farms',
    payload: { createdAt: '2020-01-01T00:00:00Z' },
    requiredGuard: 'incoming().createdAt == request.time',
  },
  {
    name: '10. Resource Exhaustion / ID Poisoning (500-char ID)',
    collection: 'farms',
    payload: { id: 'a'.repeat(500) },
    requiredGuard: 'id.size() <= 128',
  },
  {
    name: '11. Blanket List Query Scraping without ownerId filter',
    collection: 'farms',
    payload: { operation: 'list', filter: null },
    requiredGuard: 'allow list: if isVerifiedUser() && resource.data.ownerId == request.auth.uid',
  },
  {
    name: '12. Value Poisoning on whitelisted update key (farmerFeedback: true)',
    collection: 'tasks',
    payload: { farmerFeedback: true },
    requiredGuard: 'isValidFarmTask(incoming(), farmId, taskId)',
  },
];

test('Security Spec Dirty Dozen invariants are structurally enforced in Firestore rules', () => {
  const rules = readRules();
  assert.ok(rules.includes("rules_version = '2';"));
  assert.ok(rules.includes('allow read, write: if false;'));
  assert.ok(!rules.includes('allow read: if true'));
  assert.ok(!rules.includes('allow list: if isSignedIn();'));

  for (const tc of DIRTY_DOZEN_CASES) {
    assert.ok(
      rules.includes(tc.requiredGuard),
      `Missing mandatory security guard for ${tc.name}: expected ${tc.requiredGuard}`
    );
  }
});
