# Gate A spike status

Verified on 2026-09-28, locally, in the Workers runtime via
`@cloudflare/vitest-pool-workers`. `npm test` runs 46 assertions across 6 files.

## Proven locally

| Proof | How it is verified |
|---|---|
| Migrations apply from empty | `tests/gate-a.test.ts` replays the real schema against a fresh D1. |
| Schema stores no message body | `PRAGMA table_info(messages)` is asserted to contain no `body`, `snippet`, `text`, `content`, or `extracted` column. |
| Single owner is a database invariant | A partial unique index rejects a second `is_owner = 1` row. |
| D1 `batch()` is atomic | A batch containing a real constraint violation rolls back the cursor update too. This was verified rather than assumed, and the whole cursor-commits-with-jobs design rests on it. |
| Crash after commit is recoverable | The outbox row survives a post-commit failure, so the publish sweep can finish the work. |
| Duplicate job keys are rejected | The unique dedupe index rejects a second job with the same key. |
| Hot queries use indexes | `EXPLAIN QUERY PLAN` is asserted to show `USING INDEX` and no `SCAN` on `messages` and `jobs`. |
| Worker boots and stays quiet | `/health` returns 200 and echoes no address, secret, token, or key. |
| Cron is harmless with no mailbox | `runSync` returns `skipped: no_account_connected`. |
| Queue envelopes are id-only | Extra fields, wrong versions, arrays, and non-objects are all rejected, so a body could never reach the queue or the dead-letter queue. |
| Credentials round-trip and fail closed | AES-GCM round-trips; a different account id and a flipped ciphertext byte both throw. |
| Tray placement is conservative | Missing body, unanswered questions, and low-confidence `needs_action` all route to Review rather than to a confident verdict. |
| Corrections beat the model | A `set` overrides the model and carries `confidence: null` rather than a fabricated 1; a `clear` re-exposes the model answer. |
| MIME handling | HTML-only mail converts to text, `text/plain` wins, oversized bodies are truncated, attachment-only mail is `missing_body`. |
| Read side is read-only | There is no mutation endpoint; `/api/actions`, `/api/archive`, and `/api/send` all 404. |
| List rows carry no body | A list row has no `body`, `text`, or `snippet` field; bodies come from a separate one-per-request route marked `no-store`. |
| DTOs are validated at runtime | Zod schemas reject a confidence above 1, an unknown question, and a rating outside 1..5. |
| A correction survives the next read | Regression test: the Worker originally built a repository per request, so corrections were acknowledged then discarded. |

## Verified in the browser

Driven through the Codex in-app browser against the dev server.

- Five trays render; switching trays filters the list.
- An attachment-only message shows every answer as "not answered" rather than a
  confident low-priority verdict, states why, and links to Gmail.
- Correcting a field persists and displays as "your call" with a `corrected`
  marker, never as a model confidence percentage.
- A thread with an unclassified new reply shows a "1 newer message" warning.
- At 390x844 the list is full width, the reader is full screen with a Back
  control, no text is clipped, and the page does not scroll horizontally.

## Not verifiable here, and why

These need credentials or a real Cloudflare deployment. They are **not** faked
and **not** marked done.

| Proof | Blocked by | Cheapest next step |
|---|---|---|
| Production-status OAuth grant survives a Worker restart | Needs a Google Cloud project and an authorized mailbox | Publish the consent screen to `In production`, then grant `gmail.readonly`. |
| No Google token in any browser response, cookie, log, or bundle | Same | Inspect a real session once auth is wired. |
| Better Auth stores tokens server-side under D1 sessions | Better Auth is not yet wired in | Read the library, then assert the property in a test. |
| A real scheduled invocation updates a checkpoint | Requires a deployed Worker | After the first deploy, watch the cron log. |
| A queue job delivered twice completes once in production | Requires a deployed Worker and a real queue | Trigger a duplicate delivery against the deployed queue. |
| Jev returns typed answers with absent confidence preserved | Needs a provider account and key | One synthetic request through the real adapter. |
| A real read count on a real mailbox page | Needs a connected mailbox | `npm run verify:read-budget -- --remote` after first sync. |
| Installed PWA on Android | Needs a physical device | Manual install from Chrome. |

## Known deviations from PLAN-v2

- **Compatibility date is `2026-08-22`,** the newest the bundled workerd
  supports. Raising it requires bumping workerd first; deploy and test must
  agree.
- **`migrations/0000.sql` is a generated aggregate** of the numbered
  migrations, because the Workers test runtime has no filesystem. A script
  fails the build if the two drift.
- **Vitest runs on its own config, not the Vite plugin.** Vitest 4 forces
  `resolve.external` onto every environment, which the Cloudflare Vite plugin
  rejects. The dev server keeps the plugin; the tests use the pool directly.
- **Job handlers are unwired.** The consumer validates envelopes and acks, so
  the build is honest about what exists: no handler pretends to do work.
