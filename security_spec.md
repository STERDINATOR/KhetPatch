# KhetPatch Firestore Security Specification (Phase 0)

## 1. Data Invariants

1. **Identity & Verification Invariant**: All document writes and private reads require `request.auth != null` and `request.auth.token.email_verified == true`.
2. **PII Isolation Invariant**: `/users/{userId}` stores only non-PII workspace metadata (`uid`, `displayName`, `role`). Sensitive PII (`email`, `phone`) is isolated in `/users/{userId}/private/{docId}` and readable/writable exclusively by `request.auth.uid == userId` (or `isAdmin()`).
3. **Self-Assigned Privilege Prevention**: Client writes on `/users/{userId}` enforce `role == 'FARMER'` strictly; `/admins/{userId}` denies all client writes.
4. **Master Gate Relational Sync**: Every subcollection document under `/farms/{farmId}/fields/{fieldId}`, `/farms/{farmId}/rotationPlans/{planId}`, and `/farms/{farmId}/tasks/{taskId}` validates parent existence via `exists()` on create and parent ownership (`get(/databases/$(database)/documents/farms/$(farmId)).data.ownerId == request.auth.uid`) on read/write.
5. **Temporal Integrity**: All `createdAt` fields on create and `updatedAt` fields on create/update must equal `request.time`.
6. **Immutability & Terminal State Locking**:
   - `ownerId`, `id`, `farmId`, and `createdAt` are immutable after creation.
   - A `Farm` with `status == 'ARCHIVED'` cannot be mutated by non-admin clients.
   - A `RotationPlan` with `status in ['COMPLETED', 'ARCHIVED']` is terminally locked against non-admin mutations.
   - A `FarmTask` with `status == 'COMPLETED'` is terminally locked against non-admin mutations.
7. **Strict Size & Regex Guards**: All document IDs (`userId`, `farmId`, `fieldId`, `planId`, `taskId`) match `^[a-zA-Z0-9_\\-]+$` and `<= 128` chars. Every string field checks bounded `.size()`.
8. **Secure List Queries**: Every `allow list` rule evaluates `resource.data.ownerId == request.auth.uid` (no blanket `isSignedIn()` list access, no `get()` inside `list`).

## 2. The "Dirty Dozen" Adversarial Payloads

| # | Attack Vector | Target Path | Malicious Payload / Operation | Expected Result |
|---|---------------|-------------|-------------------------------|-----------------|
| 1 | **Identity Spoofing** | `/farms/farm_1` | `create` with `ownerId: "victim_uid"` while signed in as `attacker_uid` | `PERMISSION_DENIED` |
| 2 | **Ghost Field / Shadow Write** | `/farms/farm_1` | `create` with valid fields + `isVerified: true` | `PERMISSION_DENIED` |
| 3 | **Self-Assigned Admin Role** | `/users/attacker_uid` | `create` with `role: "PLATFORM_ADMIN"` | `PERMISSION_DENIED` |
| 4 | **PII Cross-Tenant Read** | `/users/victim_uid/private/info` | `get` signed in as `attacker_uid` | `PERMISSION_DENIED` |
| 5 | **Unverified Email Bypass** | `/farms/farm_1` | `create` with `request.auth.token.email_verified: false` | `PERMISSION_DENIED` |
| 6 | **Orphaned Subcollection Create** | `/farms/nonexistent/fields/f_1` | `create` referencing non-existent parent farm | `PERMISSION_DENIED` |
| 7 | **Immutable Owner Overwrite** | `/farms/farm_1` | `update` modifying `ownerId` or `createdAt` | `PERMISSION_DENIED` |
| 8 | **Terminal State Unlock** | `/farms/farm_1/tasks/t_1` | `update` changing `status` from `COMPLETED` back to `UPCOMING` | `PERMISSION_DENIED` |
| 9 | **Client Timestamp Forgery** | `/farms/farm_1` | `create` with backdated `createdAt: "2020-01-01T00:00:00Z"` instead of `request.time` | `PERMISSION_DENIED` |
| 10 | **Resource Exhaustion (ID/String Poisoning)** | `/farms/` + 500-char ID | `create` with oversized/invalid character ID or 10KB `name` string | `PERMISSION_DENIED` |
| 11 | **Blanket List Query Scraping** | `/farms` | Unfiltered `list` query by authenticated user without `where("ownerId", "==", uid)` | `PERMISSION_DENIED` |
| 12 | **Value Poisoning on Update** | `/farms/farm_1/tasks/t_1` | `update` whitelisted `farmerFeedback` with non-string boolean `true` or 5000-char string | `PERMISSION_DENIED` |
