# Gate A spike status

Verified on 2026-09-28, locally, in the Workers runtime via
`@cloudflare/vitest-pool-workers`. `npm test` runs the full suite — 100+ tests
across the test files — in that runtime. The read-only vertical slice is
complete against fixtures; the proofs below are separated by how far they have
actually been exercised.

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
| D1 read path is bounded and index-backed | `D1MailRepository` caps pages, chunks IN lists to 40, and uses opaque page tokens. |
| A stale classification cannot overwrite a newer one | A classify job whose input revision has moved on is discarded, not stored. |
| A model body never reaches D1 | The classify test asserts the body text is absent from the stored classification row. |
| A first login binds the installation | A second identity is rejected, and the partial unique index holds under a simulated race. |
| Only `gmail.readonly` is requested | The scope list is asserted to contain neither `modify` nor `send`. |
| The grant is never stored in plaintext | The stored account row is asserted to contain no `ya29.` or `1//` token. |
| The credential IV is stored beside the ciphertext | Migration `0003`; without it a stored refresh token cannot be decrypted. |

## Wired but not exercised against Google

The OAuth code paths exist and are unit-tested, but no request has ever been
made to Google's servers from this checkout.

| Path | What is proven locally | What still needs a real client |
|---|---|---|
| Authorization URL | Offline access, scope list, and state are set correctly | That Google accepts the client and returns a code |
| Code exchange | Request shape and error mapping | A real authorization code producing a refresh token |
| Refresh | The stored grant is decrypted and exchanged | That a refreshed token actually works against Gmail |
| Callback binding | First-login-binds, rejection, reconnect keeps the account id | A real redirect round trip |
| Body fetch | The fetcher builds a real adapter from a stored grant | A real `messages.get` returning a parseable body |

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

## Implemented but not exercised (needs credentials or a deployment)

These paths exist in code and are unit-tested, but cannot be exercised from this
checkout. They are **not** faked and **not** marked done.

| Proof | Blocked by | Cheapest next step |
|---|---|---|
| Production-status OAuth grant survives a Worker restart | Needs a Google Cloud project and an authorized mailbox | Publish the consent screen to `In production`, then grant `gmail.readonly`. |
| No Google token in any browser response, cookie, log, or bundle | Same | Inspect a real session once the first grant completes. |
| A real scheduled invocation updates a checkpoint | Requires a deployed Worker | After the first deploy, watch the cron log. |
| A queue job delivered twice completes once in production | Requires a deployed Worker and a real queue | Trigger a duplicate delivery against the deployed queue. |
| Jev returns typed answers with absent confidence preserved | The adapter matches Cloudflare's published response shape, but no live call has been made | One request through the AI binding once it is configured. See the retention boundary below. |
| A real read count on a real mailbox page | Needs a connected mailbox, and no read-accounting script exists in this repo | Add remote read accounting, then measure after the first sync. |
| Installed PWA on Android | Needs a physical device | Manual install from Chrome. |
| Live D1 reads fail closed for anonymous callers | A signed session is required before any live (D1) data is served, and the synthetic-fixtures demo stays open; verified only in the Workers test runtime so far | Send an unauthenticated request to the deployed Worker. |

## Not implemented yet

These are gaps, not blocked proofs. The docs must not describe them as merely
"awaiting credentials".

| Proof | What is missing | Cheapest next step |
|---|---|---|
| Better Auth database sessions (the planned design) | A minimal signed-cookie session boundary now gates the live D1 path as a stopgap; Better Auth itself is not wired | Replace the stopgap with Better Auth sessions, then assert server-side token storage. |
| The reader returns a real message body | The body loader is a stub (`const bodyLoader: BodyLoader = async () => null` in `src/worker.ts`), so a connected mailbox would still render no body | Build the fetch path from a stored grant, behind auth. |
| Jev produces live classifications in a deployed Worker | Classification needs a Workers AI binding, which is not configured in `wrangler.jsonc` | Add and bind the AI provider, then run one request. |
| Sync, evaluate, apply, and reconcile run | Only `classify` has a handler; the consumer settles the other kinds without doing the work | Implement each handler behind its own gate. |

## Unresolved: Jev / provider data-retention boundary

Classification sends message content to the configured Jev provider. This
repository does not settle that provider's data-retention, logging, or
training-use policy — those are a deployment concern and an open question, not a
property this repo can assert. The app never persists, logs, or queues a body
itself, but once a body is handed to the provider, its handling is governed by
that provider's terms. See
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

## Known deviations from PLAN-v2

- **Compatibility date is `2026-08-22`,** the newest the bundled workerd
  supports. Raising it requires bumping workerd first; deploy and test must
  agree.
- **The aggregate test-schema file is generated** from the numbered migrations,
  because the Workers test runtime has no filesystem. A script fails the build
  if the two drift. It sits outside `migrations/` so `wrangler` never applies it
  as a migration.
- **Vitest runs on its own config, not the Vite plugin.** Vitest 4 forces
  `resolve.external` onto every environment, which the Cloudflare Vite plugin
  rejects. The dev server keeps the plugin; the tests use the pool directly.
- **Only the `classify` job is wired.** The queue consumer routes `classify`
  jobs to a real handler; `sync`, `evaluate`, `apply`, and `reconcile` have no
  handler and are settled as succeeded on delivery, deliberately, rather than
  retried forever. A settled job is not evidence the work happened.
