# Setup

> **Status: deployment is supported; the live path is not yet proven.** The
> steps below provision infrastructure and a Google OAuth client, and
> `npm run deploy` now does the whole Cloudflare side. But no deployment has
> been shown to sync or classify real mail. See the [README](../README.md) and
> [spike-status.md](spike-status.md) for what runs today.

About 20 to 40 minutes, most of it in the Google Cloud console. Do these steps in
order; step 2 is the one people get wrong and it costs a week of reconnects.

## 1. Create a Google Cloud project

1. Open the [Cloud Console](https://console.cloud.google.com/) and create a project.
2. With that project selected, go to **APIs & Services > Library**.
3. Search for **Gmail API** and enable it.
4. Open **APIs & Services > OAuth consent screen**.

## 2. Set the consent screen to In production

This is the step that matters most.

1. On the OAuth consent screen choose **External**. A personal Gmail account
   cannot use Google's "Internal" audience, which requires a Workspace
   organisation.
2. Fill in the app name, support email, and developer contact.
3. Under **Publishing status**, click **Publish app**. Confirm it reads
   **In production**.

**Why this is not optional.** While an app is in Google's default **Testing**
mode, Gmail authorisations expire after **7 days**: the refresh token stops
working and you must reconnect the account every week. Publishing to
**In production** removes that expiry.

You do **not** need to request verification. Google exempts personal-use apps
from OAuth verification, so a single-owner deployment can publish without
submitting anything. You will see an "unverified app" warning screen during
sign-in; that is expected and harmless for your own use.

## 3. Create the OAuth client

1. **APIs & Services > Credentials**.
2. **Create credentials > OAuth client ID**.
3. Application type: **Web application**.
4. Under **Authorised redirect URIs**, add exactly:

   ```text
   https://YOUR-DEPLOYMENT-HOSTNAME/auth/callback
   ```

   Replace `YOUR-DEPLOYMENT-HOSTNAME` with the hostname of your deployment. For a
   Cloudflare Workers deployment that is
   `https://<worker-name>.<subdomain>.workers.dev`. Google requires an exact
   match, including the path and no trailing slash.

5. Save, then copy the **Client ID** and **Client secret**.

## 4. Add yourself as a test user

If the app is still in Testing when you first sign in, add your Google account
under **OAuth consent screen > Test users**, or Google will refuse to authorise
it at all. Once published to In production this is unnecessary.

## 5. Deploy to Cloudflare

```bash
git clone https://github.com/hwong103/jevmail.git
cd jevmail
npm install
npm run deploy
```

`npm run deploy` does the whole Cloudflare side in one idempotent pass:

1. Builds the Worker **and** the PWA (`vite build` + `tsc -p tsconfig.server.json`).
2. Resolves your D1 database by name (default `jevmail`), creating it if absent.
3. Creates the `jevmail-jobs` queue and its `jevmail-jobs-dlq` dead-letter queue.
4. Applies migrations to the remote database.
5. Deploys and prints the Worker URL plus the remaining secrets to set.

Re-running is safe: the database and queues are reused, not recreated. Override
the resource names with `JEVMAIL_DB_NAME` (default `jevmail`) and
`JEVMAIL_QUEUE_NAME` (default `jevmail-jobs`).

The build strips the `.dev.vars` the Cloudflare Vite plugin emits into
`dist/jevmail/`, and `wrangler deploy` never uploads it in any case, so your
local secrets cannot end up in a deployed artifact. If the account has hit the
D1 database limit, the script stops with the three ways to proceed (delete a
database, upgrade the plan, or reuse one via `JEVMAIL_DB_NAME`).

Preview the plan first — this reads your account and prints what it *would* do,
but writes nothing at all to Cloudflare:

```bash
npm run deploy -- --dry-run
```

The committed `wrangler.jsonc` stays a generic template holding the placeholder
D1 id; your real database id is written only into the gitignored generated
config (`dist/jevmail/wrangler.json`) at deploy time. If you need the bare
command, `npm run deploy:raw` runs `wrangler deploy` directly against that
generated config.

When it finishes it prints your Worker URL, e.g.
`https://jevmail.<your-subdomain>.workers.dev`. That hostname is what goes in
the OAuth redirect URI from step 3.

## 6. Set the secrets

`npm run deploy` prints this exact checklist when it finishes. Set all four
secrets; the script already sets the `CREDENTIAL_KEY_VERSION` var to `1` for you.

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put CREDENTIAL_KEY
npx wrangler secret put SESSION_SECRET
```

Generate `CREDENTIAL_KEY` and `SESSION_SECRET` with:

```bash
openssl rand -base64 32
```

Keep both values safe. `CREDENTIAL_KEY` encrypts the stored Gmail refresh token;
losing it means reconnecting the account. `SESSION_SECRET` signs the session
cookie that gates live (D1) reads, so a missing or rotated value simply forces a
re-sign-in rather than exposing mail. All four values are server-side only and
are never sent to the browser.

## 7. Optional: choose your classifier

By default classification runs through the Workers AI `AI` binding and needs no
key. To classify through the Command Code Provider API instead, set its key:

```bash
npx wrangler secret put JEV_API_KEY
```

Setting `JEV_API_KEY` (or its alias `CMD_API_KEY`) switches the classifier to
Command Code and wins over the `AI` binding; `JEV_BASE_URL` overrides the
default endpoint `https://api.commandcode.ai`. It is the same model
(`typesafe/jev`) over a different transport, so no other setting changes. A
bad or expired key parks classification as an auth problem rather than retrying
forever, so a later sweep resumes once the key is fixed. Read the retention
boundary in [spike-status.md](spike-status.md) before sending real mail to it.

## 8. Optional: pre-pin the owner

By default, whoever signs in first owns the installation. If your deployment URL
might be discovered before you sign in, set an owner email so nobody else can
bind it:

```bash
npx wrangler secret put OWNER_EMAIL
```

Any other Google identity is then rejected.

## 9. Connect Gmail (not enabled yet)

The live path is implemented in code but has never been exercised against real
Google or a deploy, so signing in does not yet sync or classify real mail. Once
that path is verified, the first sign-in will bind the installation, and the app
will sync recent mail, classify it, and file it into trays. Today, expect the
synthetic fixtures only.

## Troubleshooting

**"Google did not return a refresh token."** The consent screen is probably
still in Testing. The authorization request sets `prompt=consent`; if you are
reconnecting, revoke the existing grant at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions)
first, then try again.

**Reconnect every week.** The consent screen is in Testing. Publish it to
In production.

**"Not allowed: installation_already_owned".** A different Google identity
already owns this deployment. If that was you on another account, delete the D1
database and start over, or set `OWNER_EMAIL` before the first sign-in.

**The app shows fixtures rather than your mail.** Expected today. The app runs on
the synthetic fixtures bundled in the repository; the live Gmail path is not
wired end to end yet, so there is nothing else for it to show. When the live path
lands it will require an authenticated session and return nothing to anonymous
callers, so an unauthenticated view will still not expose mail.

**"Connection required" while offline.** Jevmail caches only the app shell. Mail
is never cached, so offline it has nothing to show rather than showing stale
mail. That is deliberate.

**A message is missing.** Check the Review tray first: anything the model was
unsure about, or any message with no readable body, lands there rather than
being filed confidently.
