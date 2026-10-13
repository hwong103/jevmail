# Jevmail — product truth

Derived from `CONTEXT.md` and `PLAN-v2.md`. Where this file and those disagree,
those files win.

## What it is

Self-hostable Gmail triage. Gmail stays the canonical mailbox; Jev classifies
each message into a tray; the owner reviews and corrects; only then does
anything get automated. One Gmail mailbox per installation — the owner is
whoever signs in first (`first-login-binds`).

## Who it is for

A single owner running their own deployment of a public repo, who wants their
inbox sorted and wants to see and correct the reasoning rather than trust an
opaque score. The default runtime is Cloudflare Workers + D1 + React/Vite; the
read-only slice runs on synthetic fixtures and stays open and unauthenticated.

## The shape of it

- Gmail is the source of truth. D1 holds decisions, not mail.
- Cron polls `history.list` from a committed cursor. A queue consumer classifies
  each message through Jev. A policy engine observes decisions and proposes
  actions. It cannot execute in v1.
- PWA surface: trays, a reader, and the audit of what Jev decided and why.

## Non-negotiable rules

These come straight from `CONTEXT.md` and are not design choices:

- **Metadata only.** Message bodies are never persisted, logged, or queued. The
  schema has no column for a body. Bodies are fetched on demand, held in memory,
  and dropped on navigation.
- **No compose.** Compose, reply, send, and attachment upload are out of scope
  for v1 and hand off to Gmail via deep links. The action vocabulary has no send
  and no draft; the restriction is enforced in code, not by scope.
- **Explicit ids.** Actions name explicit `messageIds`. Thread-level
  modification is never used, because it would touch mail no evaluation saw.
- **Jev is advisory.** Jev never calls Gmail. Corrections from the owner always
  beat model output and override it permanently until cleared.
- **Absent stays absent.** An invalid answer becomes an explicit `unknown`,
  never a silent default. A missing body must never become a confident
  "low priority".
- **Unreviewed ≠ correct.** Unreviewed mail is never counted as a correct
  prediction; reviewed coverage and measured accuracy are reported separately.
- **Automation off.** All automation ships disabled. No auto-archive in v1.
- **Honest recovery.** A crashed action reconciles against Gmail; it is never
  blindly retried. Undo reverses only the delta the app actually applied.

## What this UI must not claim

There are no mutation endpoints. The surface states what is true ("read-only",
"automation off") and links out to Gmail for anything Gmail owns. It never shows
archive, delete, or checkbox affordances it cannot honour, and it never invents
per-tray counts, because only one tray is loaded at a time.
