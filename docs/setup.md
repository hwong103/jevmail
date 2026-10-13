# Setup

> **Status: forward-looking.** The live Gmail path is not enabled yet. The steps
> below provision infrastructure and a Google OAuth client, but a deployment
> cannot yet sync or classify real mail. See the deployment status in the
> [README](../README.md) and [spike-status.md](spike-status.md) for what runs
> today.

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

This is **not** a one-click deploy, and it does not produce a working
installation today. If you still want to provision the Cloudflare side by hand:

```bash
git clone https://github.com/hwong103/jevmail.git
cd jevmail
npm install
npx wrangler d1 create jevmail     # note the database_id it prints
```

Put that `database_id` into `wrangler.jsonc`, then create the queues:

```bash
npx wrangler queues create jevmail-jobs
npx wrangler queues create jevmail-jobs-dlq
```

Apply migrations and deploy:

```bash
npm run db:migrate
npm run deploy
```

Note that `npm run deploy` ships the Worker only. There is no frontend build and
no `assets` binding in `wrangler.jsonc`, so this does not publish the PWA app
shell, and the live data path is incomplete regardless.

## 6. Set the secrets

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

## 7. Optional: pre-pin the owner

By default, whoever signs in first owns the installation. If your deployment URL
might be discovered before you sign in, set an owner email so nobody else can
bind it:

```bash
npx wrangler secret put OWNER_EMAIL
```

Any other Google identity is then rejected.

## 8. Connect Gmail (not enabled yet)

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
