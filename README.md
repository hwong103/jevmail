# Jevmail

[![CI](https://github.com/hwong103/jevmail/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/hwong103/jevmail/actions/workflows/ci.yml)

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

## Running it today

This is a read-only prototype. It runs against the **synthetic fixtures**
bundled in the repository, and that demo path is open — anyone can load it and
see the trays. **Deployment is now supported end to end (`npm run deploy`), but
the live Gmail path has not been verified against real Google.** The path that
reads and classifies a real mailbox is **implemented in code** — the sync driver,
outbox publish, on-demand body fetch, and AI-backed classification all exist —
but it has **never been exercised against real Google or a real deploy**, so no
self-hosted deployment has synced or classified a real mailbox yet. Everything
below about Google consent is forward-looking, not a proven install.

Local development and tests work today:

```bash
git clone https://github.com/hwong103/jevmail.git
cd jevmail
npm install
npm test        # migration sync check plus the test suite
npm run dev     # dev server against synthetic fixtures
```

## Deployment

`npm run deploy` provisions and deploys the whole installation in one idempotent
pass. It:

1. Builds the Worker **and** the PWA (`vite build` + `tsc -p tsconfig.server.json`),
   which emits the app shell and an `assets` binding.
2. Resolves your D1 database by name (default `jevmail`), creating it if absent.
3. Ensures the `jevmail-jobs` queue and its `jevmail-jobs-dlq` dead-letter queue.
4. Applies migrations to the remote database.
5. Runs `wrangler deploy`, then prints the Worker URL and the secrets still to
   set.

The committed `wrangler.jsonc` stays a **generic public template**: it carries
the placeholder D1 id `00000000-0000-0000-0000-000000000000` and never an
installation-specific id. The real database id and queue names are written at
deploy time into the gitignored generated config (`dist/jevmail/wrangler.json`)
only. Override the resource names with `JEVMAIL_DB_NAME` and
`JEVMAIL_QUEUE_NAME`.

```bash
npm run deploy              # build, provision, migrate, deploy
npm run deploy -- --dry-run # print the plan; writes nothing to Cloudflare
npm run deploy:raw          # escape hatch: bare `wrangler deploy`
```

See [docs/setup.md](docs/setup.md) for the full walkthrough, including the
secrets checklist and the Google OAuth redirect to register.

**Not yet proven:** no self-hosted deployment has synced or classified a real
mailbox. The deploy path ships and is idempotent, but the live Gmail path is
still unexercised end to end — no live OAuth round trip, no real cron or queue
invocation, no production D1 read counts. See
[docs/spike-status.md](docs/spike-status.md) for exactly what runs and what does
not.

## Google setup (forward-looking)

The live path is not enabled yet. The intended self-hosting model is documented
so the moving parts are visible and the setup is ready when the path lands, but
none of it makes a deployment classify real mail today.

Google does not allow any tool to create or configure your Google Cloud project
on your behalf, so OAuth setup is a manual walkthrough — about 20 to 40 minutes.
See [docs/setup.md](docs/setup.md) for the exact clicks, including the callback
URL to copy.

Every self-hoster would use their **own** Google Cloud project and their **own**
OAuth client. This repository never operates a shared OAuth app on your behalf,
and publishing it creates no verification submission for anyone. You would see
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

This is the intended design. What is actually wired today — and what is not —
is spelled out in [docs/spike-status.md](docs/spike-status.md).

### Choose your classifier

Classification always asks the same model (`typesafe/jev`); only the transport
changes. **Workers AI is the default** — the `AI` binding in `wrangler.jsonc`
needs no key. **Command Code is optional**: set `JEV_API_KEY`
(`wrangler secret put JEV_API_KEY`) and the app calls the Command Code Provider
API at `https://api.commandcode.ai/provider/v1/systemone` instead. A set key
wins over the AI binding. `JEV_PROVIDER=fixture` is a local-only override that
wins over both. See [docs/setup.md](docs/setup.md) for how to set the key.

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
| `npm run deploy` | Build, provision (D1 + queues), migrate, and deploy the whole installation. `-- --dry-run` prints the plan and writes nothing. |
| `npm run deploy:raw` | Escape hatch: bare `wrangler deploy` against the generated config |
| `npm run db:migrate` | Apply migrations to the remote database |

## Status

Gate A of the plan. The read-only vertical slice is built and tested against
**synthetic fixtures**, and that demo path is open. The live Gmail path is now
**implemented in code** — the sync driver, outbox publish, on-demand reader body
loader, AI binding, and version threading all exist — but it has **never been
exercised against real Google or a real deploy**: no live OAuth consent or
refresh round trip, no real cron or queue invocation, and no production D1 read
counts. Nothing is deployed. Session auth is still a signed-cookie stopgap, not
Better Auth. See [docs/spike-status.md](docs/spike-status.md) for what is
proven, what is implemented but unexercised, and what is not implemented yet.

## Licence

MIT. Derived work from [Jevmail](https://github.com/fazlerocks/jevmail)
(Copyright (c) 2026 Fazle Rahman, MIT); see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
