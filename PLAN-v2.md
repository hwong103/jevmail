# Jevmail Self-Host — Implementation Plan (v2, for approval)

**Status:** awaiting approval. Nothing is built. Workspace is empty.
**Supersedes:** the original brief's parallel-execution section.
**Review basis:** three Astra review passes (2026-09-28), MIT licence and Google
OAuth/scope facts verified against primary sources.

---

## 1. Decisions locked

| # | Decision |
|---|---|
| 1 | Public repo, self-hosted. One Gmail mailbox **per installation**. |
| 2 | Owner is **whoever signs in first** (`first-login-binds`). No `OWNER_EMAIL`, no setup token. Accepted risk documented in §11. |
| 3 | Better Auth with **database sessions** (never JWT), Google social provider, Drizzle/SQLite adapter on D1. |
| 4 | Compose / reply / send / attachment upload: **cut from v1.** Gmail deep links. |
| 5 | D1 stores **metadata only** — sender, subject, dates, flags, IDs, decisions, audit. Message bodies are fetched on demand, held in memory, never persisted. |
| 6 | Jev is **advisory only**. It never calls Gmail. Corrections always beat model output. |
| 7 | All automation ships **disabled**. No auto-archive in v1. |
| 8 | Runtime: **React/Vite + Hono Worker**. Not Next.js. |
| 9 | Unreviewed mail is **never** counted as a correct prediction. Reviewed coverage and measured accuracy are reported separately. |
| 10 | Actions target explicit `messageIds`. `threads.modify` is **never** used. |

### Accepted risk from decision 2

A URL discoverable before the owner first signs in can be bound by a stranger, who
then locks the owner out of their own deployment. Mitigation is an optional
`OWNER_EMAIL` env var (off by default) that pre-pins the principal; this is a
documented escape hatch, not the default path.

---

## 2. Architecture

```
Gmail API (canonical)  ──▶  Sync Worker ──▶ D1 outbox ──▶ Queue
                                                            │
                                       ┌────────────────────┴──────────┐
                                       ▼                               ▼
                              Jev classifier                  Policy evaluator
                                       │                               │
                                       └──────────▶ D1 ◀───────────────┘
                                                      │
                                                      ▼
                                            PWA (trays, reader, audit)
```

- **Sync** — Cron-driven `history.list` from a committed cursor. No Pub/Sub in v1.
- **Classify** — Queue consumer; fetch body → normalize → Jev → persist decision.
- **Evaluate** — Pure function over a decision. Observe-only. Never mutates.
- **Act** — Queue consumer; manual intent only. Applies label deltas, records attempts.
- **Reconcile** — Re-reads Gmail to resolve `unknown` outcomes. Never blind-retries.

Gmail remains the source of truth. D1 holds decisions, not mail.

---

## 3. Frozen contracts

Authoritative source: `src/contracts/domain.ts`, owned by the integrator only.
Runtime validators ship alongside — TypeScript alone cannot validate Gmail or Jev
responses.

```ts
export type Id = string;
export type TimeMs = number;
export type NonEmpty<T> = readonly [T, ...T[]];

export type Category =
  | "personal" | "work" | "transactional" | "newsletter"
  | "marketing" | "cold_outreach" | "notification" | "other";
export type Rating = 1 | 2 | 3 | 4 | 5;

export interface AnswerValues {
  category: Category;
  needsReply: boolean;
  needsAction: boolean;
  urgency: Rating;
  importance: Rating;
  senderType: "person" | "organization" | "automated" | "unknown";
}
export type Question = keyof AnswerValues;

export type Answer<T> =
  | {
      state: "value";
      value: T;
      // Absent stays absent. Never fabricate certainty.
      confidence: number | null;
      distribution: readonly { value: T; probability: number }[] | null;
    }
  | {
      state: "unknown";
      reason: "missing" | "invalid" | "abstained" | "provider_error";
    };
export type Answers = { [Q in Question]: Answer<AnswerValues[Q]> };

export type InputQuality = "complete" | "truncated" | "missing_body" | "unsupported";

export interface InputRevision {
  inputHash: string;
  threadContextHash: string;
  contextMessageIds: readonly Id[];
  normalizerVersion: number;
  quality: InputQuality;
}

// TRANSIENT. Never persisted, never logged, never queued.
export interface NormalizedMessage {
  accountId: Id;
  messageId: Id;
  threadId: Id;
  sender: string;
  subject: string;
  receivedAt: TimeMs;
  text: string | null;
  revision: InputRevision;
}

export interface Classification {
  id: Id;                          // stable PK, referenced by evaluations
  accountId: Id;
  gmailMessageId: Id;
  gmailThreadId: Id;
  input: InputRevision;
  modelVersion: string;
  promptVersion: number;
  schemaVersion: number;
  answers: Answers;
  status: "complete" | "review" | "failed" | "stale";
  createdAt: TimeMs;
  supersedesId: Id | null;
}

export interface Principal {
  id: Id;
  googleSub: string;               // bound on first successful login
  email: string;
  boundAt: TimeMs;
  isOwner: boolean;                // exactly one row has true
}

export type CorrectionChange = {
  [Q in Question]:
    | { question: Q; operation: "set"; value: AnswerValues[Q] }
    | { question: Q; operation: "clear" }
}[Question];

export interface Correction {
  id: Id;
  accountId: Id;
  gmailMessageId: Id;
  revision: number;                // monotonic per message, allocated by compare-and-set
  changes: readonly CorrectionChange[];
  observedInputHash: string | null;
  createdAt: TimeMs;
  actorId: Id;                     // server-derived. Never caller-supplied.
}

export type EditableLabel =
  | { type: "system"; id: "INBOX" | "UNREAD" | "STARRED" }
  | { type: "user"; id: string };

export interface LabelDelta {
  add: readonly EditableLabel[];
  remove: readonly EditableLabel[];
}

export interface LabelSnapshot {
  messageId: Id;
  threadId: Id;
  historyId: string;               // opaque string, never a JS number
  labelIds: readonly string[];
}

export interface ActionPrecondition {
  snapshot: LabelSnapshot;
  classificationId: Id | null;
  inputHash: string | null;
  correctionRevision: number;
}

export type ActionOrigin =
  | { type: "manual"; actorId: Id }
  | { type: "simulation"; evaluationId: Id }
  | { type: "undo"; originalIntentId: Id; actorId: Id };

export type ActionOutcome =
  | "pending" | "applied" | "satisfied_unattributed"
  | "skipped" | "failed" | "unknown" | "reconciling";

export interface ActionAttempt {
  id: Id;
  intentId: Id;
  messageId: Id;
  number: number;
  leaseToken: string;
  state: "prepared" | "calling" | "settled";
  before: LabelSnapshot;
  after: LabelSnapshot | null;
  actualDelta: LabelDelta | null;  // what actually changed — the only thing undo may reverse
  outcome: ActionOutcome;
  acknowledgement: "received" | "not_received";
  startedAt: TimeMs;
  finishedAt: TimeMs | null;
  errorCode: string | null;
}

export interface GmailAction {
  intentId: Id;
  accountId: Id;
  kind: "archive" | "markRead" | "markUnread" | "star" | "unstar"
      | "labels" | "undo";
  origin: ActionOrigin;
  messageIds: NonEmpty<Id>;        // explicit. threads.modify is never used.
  delta: LabelDelta;
  preconditions: NonEmpty<ActionPrecondition>;
  requestHash: string;
  requestedAt: TimeMs;
  expiresAt: TimeMs;
  state: "proposed" | "pending" | "running" | "applied"
       | "partially_applied" | "skipped" | "failed"
       | "unknown" | "reconciling";
  attempts: readonly ActionAttempt[];
}

export interface PolicyEvaluation {
  id: Id;
  accountId: Id;
  classificationId: Id;
  correctionRevision: number;
  ruleId: Id;
  ruleVersion: number;
  mode: "observe";                 // v1 cannot execute
  evaluatedAt: TimeMs;
  outcome: "skipped" | "proposed";
  reasons: readonly string[];
  actions: readonly GmailAction[]; // proposals only. No send. No trash. No createDraft.
}

export interface Lease { token: string; expiresAt: TimeMs; }

export type JobPayload =
  | { kind: "sync"; checkpointVersion: number }
  | { kind: "classify"; messageId: Id; expectedMessageRevision: number }
  | { kind: "evaluate"; classificationId: Id; correctionRevision: number }
  | { kind: "apply"; intentId: Id }
  | { kind: "reconcile_action"; intentId: Id };

export interface JobRecord {
  id: Id;
  accountId: Id;
  payload: JobPayload;
  dedupeKey: string;
  state: "ready" | "leased" | "blocked_auth" | "succeeded" | "dead";
  attempts: number;
  availableAt: TimeMs;
  lease: Lease | null;
  lastErrorCode: string | null;
}

export interface OutboxRecord {
  id: Id;
  jobId: Id;
  state: "pending" | "publishing" | "published";
  attempts: number;
  availableAt: TimeMs;
  lease: Lease | null;
  publishedAt: TimeMs | null;
}

export interface QueueEnvelope { version: 1; jobId: Id; }  // IDs only, never bodies

export interface SyncCheckpoint {
  accountId: Id;
  version: number;
  mode: "backfill" | "incremental" | "reconcile";
  committedHistoryId: string | null;
  pageToken: string | null;
  scanId: Id | null;
}
```

### Contract invariants

1. Targets must be non-empty and unique; exactly one precondition per target.
   User-label IDs resolve against this account's Gmail label catalogue.
2. Reject at the boundary: drafts, sending, trash, arbitrary endpoints, and every
   `simulation`-origin execution.
3. Effective answers = latest correction per message/question. A `set` beats all
   model versions until cleared. Corrections do **not** acquire probability 1.
4. Hash the exact normalized input, completeness flags, and included thread
   context. Store prompt/model/schema versions separately. Label-only changes must
   not re-invoke Jev.
5. Ingest changes, checkpoint, jobs, and outbox rows commit in **one D1
   transaction**. A history cursor advances only after every page's work is
   durably represented.

### Deduplication, crash recovery, undo

- `(accountId, intentId)` is unique. Canonical hash covers targets, operation,
  delta, origin, preconditions. Same intent + different hash = conflict.
- Persist `calling` **before** calling Gmail. A crashed or timed-out `calling`
  attempt becomes `unknown`, then `reconciling`. Never blindly replay a mutation.
- Re-read Gmail. Desired state with no acknowledged result becomes
  `satisfied_unattributed` — no automatic undo. Conflicting state needs fresh
  owner intent.
- Undo is a **new intent** reversing only the recorded `actualDelta`, after
  confirming the acknowledged post-state is still current. Never restore a whole
  old label set.

**Verified limitation:** `messages.modify` exposes no documented compare-and-set
precondition and no request idempotency key. Gmail and D1 cannot be one
transaction. We do not promise exactly-once mutations or unconditional undo.

---

## 4. D1 schema (indicative — integrator owns final shape)

`principal`, `account_credentials`, `sync_checkpoint`, `messages`,
`classifications`, `corrections`, `jobs`, `outbox`, `action_intents`,
`action_attempts`, `policy_rules`, `policy_evaluations`, `protected_senders`,
`audit_log`.

Every FK access path is indexed. Composite indexes combine account + filter +
`ORDER BY` columns. `EXPLAIN QUERY PLAN` must show `USING INDEX` or
`USING COVERING INDEX`; a `SCAN` of the hot table fails the test.

---

## 5. Gate A — integrator-only spike

**Nothing else starts until all of these pass.** These are checks to be created,
not checks already run.

| Proof | Acceptance |
|---|---|
| Ownership | Public template contains no installation-specific identifiers. Deploy-time config is generic. |
| Runtime | Worker boots; `/health` returns build id; anonymous `/api/mail` returns 401. |
| D1 | Migrations apply from empty. Hot queries run with `EXPLAIN QUERY PLAN`; indexed access asserted; `meta.rows_read` recorded. |
| Credentials | AES-GCM round-trip succeeds. Wrong AAD and ciphertext tampering both fail. |
| Queue | One job published as ID-only; delivered **twice**; completes durably **once**. |
| Cron | A real scheduled invocation updates a synthetic checkpoint. Local-only is not sufficient. |
| Auth | Better Auth with **database sessions**; first login binds `sub`; a second `sub` is rejected. **Assert no Google access or refresh token appears in any browser response, cookie, log, or bundle.** |
| Jev | One synthetic email returns all typed answers; absent confidence stays `null`. Record package/model versions and validated response shape. |

**Explicitly out of the spike:** UI polish, real inbox backfill, Gmail mutations,
rule editing, Pub/Sub, compose, attachments, automation activation.

---

## 6. Ownership map

One integrator owns the shared spine. Nobody else edits it.

| Owner | Owns | Must not edit |
|---|---|---|
| **Integrator** | `src/contracts/**`, `src/db/**`, `migrations/**`, `src/worker.ts`, `src/routes.ts`, `src/runtime/**`, `tests/integration/**`, `tests/fixtures/**`, root configs, `package.json`, lockfile, `wrangler.jsonc`, `CONTEXT.md`, `docs/adr/**`, `THIRD_PARTY_NOTICES.md`, setup guide | Worker-owned code without coordinating |
| **A** Gmail/Auth/Sync | `src/server/auth/**`, `src/server/gmail/**`, `src/server/sync/**`, `tests/gmail/**` | Shared spine; B/C/D dirs |
| **B** Classification | `src/server/classification/**`, `tests/classification/**` | Gmail transport, DB, shared spine, UI |
| **C** Actions/Policies | `src/server/actions/**`, `src/server/policies/**`, `tests/actions/**` | OAuth/Gmail transport, shared spine, UI |
| **D** UI/PWA | `src/client/**`, `public/**`, `tests/ui/**`, `docs/ui-decision.md` | Server modules, shared spine, lockfile |

Before hand-off the integrator supplies: DB ports with fake implementations
(paginated reads, transactional sync-page commit, job/outbox leases, conditional
classification completion, correction compare-and-set, action-attempt
persistence), one shared synthetic fixture set, and mock HTTP handlers for D.

Workers export routers and job handlers. **Only the integrator mounts them.**
B owns effective-decision and tray derivation; D displays B's result and does not
reimplement it.

---

## 7. Dependency order

1. Integrator passes Gate A → freezes contracts → ports, fakes, fixtures, mocks.
2. A, B, D start concurrently. C builds simulator and executor against fakes.
3. Integrate A → B → D: prove the **read-only vertical slice** on a bounded batch.
4. Integrate C against A's adapter; prove mutation failure paths on fixtures.
5. Enable live manual controls only after explicit incremental scope consent.

**The naive collision** to avoid: separate runtime, sync, classifier, and policy
workers each changing schema, bindings, dependencies, or route files.

---

## 8. Acceptance per slice

| Slice | Evidence |
|---|---|
| Integrator | `rtk npm run test:db` — rollback before commit leaves neither cursor nor jobs; crash after commit / before enqueue is recovered by the outbox; duplicate delivery completes once. `rtk npm run verify:read-budget -- --remote` — real `meta.rows_read` on preview and production. |
| A | `rtk npm run test:gmail` — owner/sub mismatch, refresh response omitting a new refresh token, revoked grant, pagination, history expiry, archive/read/trash/deletion reconciliation, MIME alternatives, charset, oversized input. Expired cursor starts bounded reconciliation without premature deletion. |
| B | `rtk npm run test:classification` — invalid category/distribution → Review; absent probabilities stay `null`; unchanged input skips inference; late stale completion cannot overwrite newer input; correction beats reclassification; provider timeout surfaces a retryable failure. |
| C | `rtk npm run test:actions` — only explicit message IDs change; source/precondition/kill-switch checked **at execution**; crash after Gmail call reconciles without blind retry; mixed batch records per-message outcomes; undo changes only its delta; conflicting Gmail state blocks execution; simulation never enqueues mutations. |
| D | `rtk npm run test:ui` plus in-app-browser evidence at desktop and narrow mobile: reader, back navigation, correction, stale/pending states, reconnect, action status, undo conflict, Gmail handoff. Cache inspection shows app shell only — no bodies or tokens in Cache Storage, IndexedDB, local storage, or service-worker responses. |

### Resource acceptance is part of done

- Precomputed thread-list projections. No per-row correlated scans, no
  mailbox-wide counts on list or status requests.
- Caps: 50 threads/page, 25 messages/thread, 50 messages/classification batch.
- Initial budget: **300 D1 rows read per mailbox page**, including auth queries.
  Record production `meta.rows_read`; fix or narrow scope if exceeded.
- Usage alerts near 50% before any real backfill.
- Polling stops on hidden tab; visible polling backs off when idle.
- Quota exhaustion is a **full outage including auth** — document it as such, not
  as a login bug.

Destructive and concurrency tests use synthetic fixtures. The first live pass
only reads and classifies.

---

## 9. Reading experience (v1)

Click a message → in-app reader, body fetched fresh from Gmail at that moment,
held in memory only, cleared on navigation and logout. **Opening does not change
read state.** Controls: archive, label, read/unread, star, undo, and *Open in
Gmail*. Reply, compose, attachments, and rich HTML hand off to Gmail.

Three failure modes to design for from the start:

1. **HTML-only and nested MIME.** Walk MIME parts; decode charset and base64url
   correctly; prefer `text/plain`; convert HTML to text safely. Never inject mail
   HTML or load remote resources.
2. **Attachment-only or oversized mail.** Show an explicit unavailable/truncated
   state plus a Gmail link. Record `InputQuality`. Missing content must never
   become confident "low priority".
3. **Thread ambiguity on mobile.** A tray row may contain unclassified new
   messages. Show the selected message and a pending count. Full-screen reader
   with Back on mobile — never two cramped columns.

---

## 10. Worked inbox risks

| Example | Expected behaviour | Owner |
|---|---|---|
| Classified marketing + new unclassified reply in one thread | Show pending state; proposal names only evaluated IDs; never `threads.modify`. | A/B/C/D |
| "Invoice attached" with no useful text body | Reader flags missing content, links Gmail; classification records incomplete input. | A/B/D |
| Large newsletter exceeds extraction budget | Explicit truncation, bounded processing, Gmail fallback. | A/B/D |
| Owner replies in Gmail after "needs reply" | History detects the change; context-dependent results invalidated; late old inference cannot become current. | A/B |
| Owner archives while an action waits | Precondition fails; show conflict; do not fight Gmail. | C/D |
| Grant expires mid-test | Pause dependent work, retain progress, reconnect same principal, reconcile uncertain actions. | A/C/D |

---

## 11. Deploy promise

**Ship this wording, not "one click":**

> **Deploy to Cloudflare with guided Google setup.**
> The button provisions your Worker, D1 database, and queue, then asks for
> secrets. Google does not allow any tool to create or configure your Google
> Cloud project on your behalf, so OAuth setup is a short guided walkthrough
> (about 20–40 minutes).

Required manual steps: create/select a Google Cloud project → enable the Gmail
API → configure the OAuth consent screen → create a Web application client →
register the installation's exact callback URL (guide ships it ready to copy) →
supply client ID, client secret, and a Jev provider key as Worker secrets →
authorize.

**Audience status matters:** `Testing` grants expire after 7 days. The guide must
tell deployers to publish to `In production`. Self-hosters using their own Google
project and their own client are **not** covered by our verification posture, and
publishing this repo creates no verification submission for us. Deployers will
see Google's unverified-app warning; that is expected.

We never ship a hosted sign-up service, shared OAuth client, or mailbox proxy —
any of those would change this answer.

---

## 12. Licensing and provenance

Upstream Jevmail at `f6f20af9c2805efd924c29cbea59547e72c558fc` is **MIT**,
`Copyright (c) 2026 Fazle Rahman`. Verified at the pinned commit; not yet verified
against a local checkout, since nothing is cloned.

- Retain the copyright notice and full permission text for redistributed code.
- No NOTICE filename, no branding clause, no copyleft obligation.
- Record provenance in `THIRD_PARTY_NOTICES.md`; preserve copied copyright headers.
- Original code may carry its own licence; MIT throughout is simplest.

---

## 13. Seed corpus

20–50 personally reviewed messages, scrubbed, covering personal, banking/security,
receipts, marketing, newsletters, cold outreach, and action requests. Used to
inspect per-question accuracy and calibrate thresholds from evidence.

- Reported as **reviewed coverage** and **measured accuracy**, separately.
- Unreviewed mail is never counted as correct.
- 50 independent cases with zero failures still admits a ~5.8% one-sided 95%
  upper error bound. Treat it as a seed suite, not proof.
- **Contribution policy:** synthetic examples with provenance and explicit
  contribution rights only. Reject real inbox exports, identifiers, tokens, and
  screenshots containing mail.

---

## 14. Residual risks

| Risk | Cheapest resolution |
|---|---|
| Better Auth token storage and retention behaviour under D1 sessions | Read the source before relying on it; assert no token reaches the browser. Fall back to our own encryption before persisting. |
| Jev / gateway retention and training terms | One synthetic request, then read the terms. Disclose exactly what leaves the installation. Google's verification exemptions do not waive Google's data policy. |
| Real-inbox MIME coverage | Read-only pass over the first 50 messages; record parser outcome counts only; promote scrubbed failures into fixtures. |
| Concurrent Gmail edits remain non-atomic | Deterministic race fixtures first; keep `unknown` and `satisfied_unattributed` visible in the UI. Never paper over them. |

**Unproven claims we will not make:** long-lived OAuth on any deployment,
installed-PWA behaviour on Android (emulation is not installation), and the
20–40 minute setup estimate (judgement until someone times a clean-room install).

---

## 15. Gates to release

- **A** — credential-free CI and preview from empty D1 on synthetic fixtures.
  Contributors need no mailbox and no CI secrets.
- **B** — clean install through the real deploy button with different worker and
  database names, owner, origin, and secrets. Proves no `hwong103` config leaks
  into the template. *Needs an independent tester; their install must be theirs.*
- **C** — real OAuth consent, callback, refresh, revoke/reconnect, and
  wrong-account rejection on a disposable installation. Fixtures prove the build;
  only this proves Google.
- **D** — owner installs the public template privately under `hwong103`. First
  real classification batch runs there, bounded and observe-only.
- **E** — simulated action failures, then explicitly approved manual actions.
  Everything ships with automation disabled.
