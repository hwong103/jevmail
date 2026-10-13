# Jevmail

Self-hostable Gmail triage. Gmail stays the canonical mailbox; Jev classifies;
the owner reviews and corrects; only then does anything get automated.

## What this is

One Gmail mailbox per installation. Read-only first. Compose, reply, send, and
attachment upload are deliberately out of scope for v1 and hand off to Gmail
via deep links.

## Architecture in one paragraph

Cron polls `history.list` and commits message metadata, the sync cursor, the
jobs that follow, and the outbox rows that publish them in a single D1
transaction. A queue consumer classifies each message through Jev, storing a
versioned decision with per-question confidence. Corrections from the owner
override the model permanently until cleared. A separate policy engine observes
those decisions and proposes actions but cannot execute in v1.

## Rules that are not negotiable

- Message bodies are never persisted, logged, or queued. Only metadata lives in
  D1, and the schema has no column for it.
- Actions name explicit `messageIds`. Thread-level modification is never used,
  because it would touch mail no evaluation ever saw.
- The action vocabulary has no send and no draft. `gmail.modify` authorizes
  both, so the restriction is enforced in code, not by scope.
- Absent confidence stays absent. An invalid answer becomes an explicit
  `unknown`, never a silent default.
- Unreviewed mail is never counted as a correct prediction. Reviewed coverage
  and measured accuracy are reported separately.
- A crashed action reconciles against Gmail; it is never blindly retried.
- Undo reverses only the delta the app actually applied.

## Commands

```bash
npm test          # migration sync check plus the full suite in the Workers runtime
npm run typecheck # tsc --noEmit
npm run dev       # vite dev server
npm run deploy    # wrangler deploy
```

## Current state

Gate A spike, partially proven. Nothing is deployed. `npm test` runs 145 tests
in the Workers runtime. The read-only slice runs on synthetic fixtures, and that
demo stays open and unauthenticated; the live Gmail data path is now implemented
in code (sync driver, outbox publish, on-demand reader body loader, AI binding,
version threading) but has never been exercised against real Google or a real
deploy. A minimal signed-cookie session boundary gates the live D1 path as a
stopgap (not Better Auth) and fails closed for anonymous callers. See
`docs/spike-status.md` for what is verified versus what is not implemented.

## Plan

`PLAN-v2.md` holds the approved plan, contracts, gates, and ownership map.
