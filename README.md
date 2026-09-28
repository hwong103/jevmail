# Jevmail

Private, ad-free Gmail triage. Gmail stays the canonical mailbox; Jev classifies;
you review and correct; only then does anything get automated.

One Gmail mailbox per installation. Read-only first: compose, reply, send, and
attachment upload are out of scope for v1 and hand off to Gmail.

## What it does

- Classifies incoming mail into focused trays — Needs reply, Action, Review,
  Updates, Low priority — using [Jev](https://docs.typesafe.ai).
- Shows *why* each message landed where it did, with per-question confidence.
- Lets you correct any answer. A correction sticks permanently until cleared,
  and is never overwritten by a later model run.
- Flags anything uncertain as Review rather than filing it confidently.

## What it deliberately does not do

- No compose, reply, send, or attachment upload. Those hand off to Gmail.
- No automatic archiving, labelling, or replying. All automation ships disabled.
- No multi-user accounts, signup, or team sharing. One mailbox per deployment.
- Never sends, never permanently deletes.

## Deploy to Cloudflare with guided Google setup

The deploy button provisions a Worker, a D1 database, and a queue, then asks for
secrets.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?deploy-from=github)

```bash
git clone https://github.com/hwong103/jevmail.git
cd jevmail
npm install
npm test
```

Google does not allow any tool to create or configure your Google Cloud project
on your behalf, so OAuth setup is a short guided walkthrough — about 20 to 40
minutes. See [docs/setup.md](docs/setup.md) for the exact clicks, including the
callback URL to copy.

## Deploy promise, stated honestly

This is not one click end to end. The button handles the Cloudflare side. The
Google side is manual because no tool may accept Google's terms on your behalf.

Every self-hoster uses their **own** Google Cloud project and their **own** OAuth
client. This repository never operates a shared OAuth app on your behalf, and
publishing it creates no verification submission for anyone. You will see
Google's unverified-app warning screen, and that is expected.

### Set the consent screen to "In production"

This matters more than anything else in setup. In Google's default **Testing**
mode, Gmail refresh tokens expire after **7 days**, and you will reconnect
weekly. Publishing to **In production** removes that expiry.

Google exempts personal-use apps from OAuth verification, so you do not need to
submit for verification. See Google's
[verification exceptions](https://support.google.com/cloud/answer/13464323).

## Architecture

```
Gmail API (canonical)  ->  Sync Worker  ->  D1 outbox  ->  Queue
                                                              |
                                        +---------------------+---------+
                                        v                               v
                               Jev classifier                  Policy evaluator
                                        |                               |
                                        +----------> D1 <---------------+
                                                      |
                                                      v
                                            PWA (trays, reader, audit)
```

- **Sync** — Cron polls Gmail `history.list` from a committed cursor.
- **Classify** — A queue consumer fetches the body, normalises it, calls Jev, and
  stores a versioned decision.
- **Evaluate** — A separate policy engine observes decisions. It cannot execute
  in v1.
- **Reconcile** — Re-reads Gmail to resolve uncertain outcomes. Never blind-retries.

## Design rules these tests enforce

- Message bodies are never persisted, logged, or queued. There is deliberately
  no body column in the schema.
- Actions name explicit message IDs. Thread-level modification is never used.
- The action vocabulary has no send and no draft.
- Absent confidence stays absent. An invalid answer becomes an explicit
  `unknown`, never a silent default.
- Unreviewed mail is never counted as a correct prediction.
- A Gmail history cursor only advances in the same transaction that stores the
  work it implies.
- A revoked grant parks the account instead of retrying forever.

## Commands

| Command | What it does |
| --- | --- |
| `npm test` | Migration sync check plus the test suite in the Workers runtime |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run dev` | Local dev server against synthetic fixtures |
| `npm run deploy` | `wrangler deploy` |
| `npm run db:migrate` | Apply migrations to the remote database |

## Status

Gate A of the plan, with the read-only vertical slice built and tested against
fixtures. OAuth and the live Gmail path are implemented but have not yet been
exercised against a real account. See
[docs/spike-status.md](docs/spike-status.md) for exactly what is proven, what is
wired but unexercised, and what remains unverified.

## Licence

MIT. Derived work from [Jevmail](https://github.com/fazlerocks/jevmail)
(Copyright (c) 2026 Fazle Rahman, MIT); see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
