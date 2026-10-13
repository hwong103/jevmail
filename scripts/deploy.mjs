// End-to-end deploy for a self-hosted Jevmail installation.
//
// The committed `wrangler.jsonc` is a public template: it carries a placeholder
// D1 id and must never hold installation-specific ids. `vite build` copies it to
// the gitignored `dist/jevmail/wrangler.json`, and this script patches that
// generated copy with the real database id and queue names right before deploy.
//
// Idempotent by design: it resolves the D1 database and queues, creating them
// only when absent. `--dry-run` performs no Cloudflare writes at all -- it reads
// (whoami, d1 list, queues list) and prints the exact plan.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const DRY_RUN = process.argv.slice(2).includes("--dry-run");
// Build-helper mode: `node scripts/deploy.mjs --clean-dist` runs only the
// secret strip below and exits. `npm run build` calls it after `vite build` so
// even a bare build never leaves the plugin-generated `.dev.vars` behind.
const CLEAN_DIST_ONLY = process.argv.slice(2).includes("--clean-dist");

const DB_NAME = process.env.JEVMAIL_DB_NAME ?? "jevmail";
const QUEUE_NAME = process.env.JEVMAIL_QUEUE_NAME ?? "jevmail-jobs";
const DLQ_NAME = `${QUEUE_NAME}-dlq`;
const KEY_VERSION = process.env.JEVMAIL_CREDENTIAL_KEY_VERSION ?? "1";

const GENERATED_CONFIG = "dist/jevmail/wrangler.json";
const BUILD_OUTPUT_DIR = "dist";

function log(message) {
  console.log(message);
}

function fail(message) {
  console.error(`\n[deploy] ${message}`);
  process.exit(1);
}

// Runs a command with output streamed to the terminal. Inherits stdio so build,
// create, migrate, and deploy progress is visible and prompts behave normally.
function runStreaming(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    fail(`\`${command} ${args.join(" ")}\` failed (exit ${result.status ?? "unknown"}).`);
  }
}

// Runs a command, capturing stdout while stderr still streams. Used for read
// commands whose output we parse. Pass captureStderr to also capture stderr
// (some wrangler errors, e.g. "already exists", land there). Returns
// { stdout, output, status, ok }.
function runCapture(command, args, { allowFailure = false, captureStderr = false } = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: captureStderr ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "inherit"],
  });
  const stdout = result.stdout ?? "";
  const stderr = captureStderr ? (result.stderr ?? "") : "";
  if (result.status !== 0 && !allowFailure) {
    if (stderr) process.stderr.write(stderr);
    fail(`\`${command} ${args.join(" ")}\` failed (exit ${result.status ?? "unknown"}).`);
  }
  return {
    stdout,
    output: `${stdout}\n${stderr}`,
    status: result.status,
    ok: result.status === 0,
  };
}

function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

// Removes every `.dev.vars` the Cloudflare Vite plugin emits into the build
// output (e.g. `dist/jevmail/.dev.vars`). That file is a local dev/preview
// artifact carrying real secrets. It is never part of a deploy -- the worker
// entry is `index.js`, `assets.directory` is `../client`, and the generated
// `dist/client/.assetsignore` already lists `.dev.vars` -- but deleting it here
// makes "a deployed or published artifact never carries `.dev.vars`" a hard
// guarantee instead of a property of wrangler's current upload rules.
// Returns the number of files removed.
function removeGeneratedSecrets(dir = BUILD_OUTPUT_DIR) {
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      removed += removeGeneratedSecrets(full);
    } else if (entry.name === ".dev.vars") {
      rmSync(full, { force: true });
      removed += 1;
    }
  }
  return removed;
}

function requireLoggedIn() {
  const result = spawnSync("npx", ["wrangler", "whoami"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = stripAnsi(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  if (
    result.status !== 0 ||
    /not authenticated|not logged in|no account/i.test(output)
  ) {
    fail(
      "No Cloudflare account is authenticated. Run `npx wrangler login` first, then re-run this script.",
    );
  }
  // Surface the account line so the operator can confirm the target account.
  const account = output
    .split("\n")
    .find((line) => /logged in with an OAuth Token/i.test(line));
  if (account) log(`[deploy] ${account.trim()}`);
}

// Reads `wrangler d1 list --json` and returns the record whose name matches
// DB_NAME, or undefined. The id is always resolved by name from this list --
// never parsed out of `d1 create`'s human output.
function findDatabaseByName() {
  const { stdout } = runCapture("npx", ["wrangler", "d1", "list", "--json"]);
  let databases;
  try {
    databases = JSON.parse(stdout);
  } catch {
    fail("Could not parse `wrangler d1 list --json`. Is wrangler authenticated?");
  }
  return (Array.isArray(databases) ? databases : []).find(
    (db) => db && db.name === DB_NAME,
  );
}

// Returns the D1 database uuid for DB_NAME, creating the database when absent.
// In dry-run mode it never creates; it reports what it would do instead.
function resolveDatabase() {
  const match = findDatabaseByName();
  if (match?.uuid) {
    log(`[deploy] found D1 database "${DB_NAME}" (${match.uuid})`);
    return match.uuid;
  }

  if (DRY_RUN) {
    log(
      `[deploy] database "${DB_NAME}" not found — would run: wrangler d1 create ${DB_NAME}`,
    );
    return null;
  }

  log(`[deploy] database "${DB_NAME}" not found — creating it`);
  // wrangler 4.x `d1 create` has no `--json` flag (it rejects the argument and
  // exits 1), so its output is never parsed. Instead: create, then re-list and
  // match by name. Re-listing also makes a concurrent create idempotent.
  const created = runCapture("npx", ["wrangler", "d1", "create", DB_NAME], {
    allowFailure: true,
    captureStderr: true,
  });
  const after = findDatabaseByName();
  if (after?.uuid) {
    log(
      created.status === 0
        ? `[deploy] created D1 database "${DB_NAME}" (${after.uuid})`
        : `[deploy] D1 database "${DB_NAME}" is now present (${after.uuid})`,
    );
    return after.uuid;
  }

  reportCreateFailure(created);
}

// Prints an actionable message when `wrangler d1 create` fails and the database
// still is not listed, then exits non-zero. The high-signal case is the
// per-account D1 database cap on the Workers Free plan.
function reportCreateFailure(created) {
  const output = stripAnsi(created.output ?? "");
  // Matches wrangler's own 7406 text (message or raw API error). The database
  // id is never taken from this output; it only picks the failure message.
  if (/maximum number of D1 databases|"code"\s*:\s*7406/i.test(output)) {
    console.error(
      `\n[deploy] Could not create D1 database "${DB_NAME}": this Cloudflare ` +
        "account has reached its D1 database limit.\n" +
        "         The Workers Free plan allows 10 D1 databases per account.\n\n" +
        "Pick one of these, then re-run `npm run deploy`:\n" +
        "  1. Delete a D1 database you no longer need:\n" +
        "       npx wrangler d1 list\n" +
        "       npx wrangler d1 delete <database-name>\n" +
        "  2. Upgrade the plan to raise the limit:\n" +
        "       https://dash.cloudflare.com/<account-id>/workers/plans\n" +
        "  3. Reuse an existing database by name:\n" +
        "       JEVMAIL_DB_NAME=<existing-database-name> npm run deploy\n",
    );
    process.exit(1);
  }
  if (created.output) process.stderr.write(created.output);
  const detail =
    created.status === 0
      ? "reported success, but the database is not listed"
      : `exit ${created.status ?? "unknown"}`;
  fail(
    `\`wrangler d1 create ${DB_NAME}\` failed (${detail}) and "${DB_NAME}" is still not in \`wrangler d1 list\`.`,
  );
}

// Returns the set of existing queue names. `wrangler queues list` has no --json
// flag, so the table is parsed: each data row's second column is the name.
function listQueues() {
  const { stdout } = runCapture("npx", ["wrangler", "queues", "list"]);
  const names = new Set();
  for (const rawLine of stripAnsi(stdout).split("\n")) {
    if (!rawLine.includes("│")) continue;
    const cells = rawLine.split("│").map((cell) => cell.trim());
    // Row shape: ["", id, name, created_on, modified_on, producers, consumers, ""]
    const name = cells[2];
    if (name && name !== "name") names.add(name);
  }
  return names;
}

function ensureQueue(name, existing) {
  if (existing.has(name)) {
    log(`[deploy] queue "${name}" already exists`);
    return;
  }
  if (DRY_RUN) {
    log(`[deploy] queue "${name}" not found — would run: wrangler queues create ${name}`);
    return;
  }
  log(`[deploy] creating queue "${name}"`);
  const result = runCapture("npx", ["wrangler", "queues", "create", name], {
    allowFailure: true,
    captureStderr: true,
  });
  if (result.status === 0) return;
  const output = stripAnsi(result.output);
  if (/already exists|already has a queue/i.test(output)) {
    log(`[deploy] queue "${name}" already exists`);
    return;
  }
  fail(`\`wrangler queues create ${name}\` failed (exit ${result.status ?? "unknown"}).`);
}

// Patches the generated deploy config with installation-specific values. The
// committed `wrangler.jsonc` is never touched.
function patchGeneratedConfig({ databaseId }) {
  let config;
  try {
    config = JSON.parse(readFileSync(GENERATED_CONFIG, "utf8"));
  } catch {
    fail(`Could not read the generated config at ${GENERATED_CONFIG}. Did the build succeed?`);
  }

  const binding = config.d1_databases?.[0];
  if (!binding) {
    fail(`No d1_databases[0] binding in ${GENERATED_CONFIG}.`);
  }
  binding.database_name = DB_NAME;
  binding.database_id = databaseId;

  config.queues ??= { producers: [], consumers: [] };
  if (config.queues.producers?.[0]) config.queues.producers[0].queue = QUEUE_NAME;
  if (config.queues.consumers?.[0]) {
    config.queues.consumers[0].queue = QUEUE_NAME;
    config.queues.consumers[0].dead_letter_queue = DLQ_NAME;
  }

  config.vars ??= {};
  config.vars.CREDENTIAL_KEY_VERSION = KEY_VERSION;

  writeFileSync(GENERATED_CONFIG, `${JSON.stringify(config, null, 2)}\n`);
  log(`[deploy] patched ${GENERATED_CONFIG} (db ${databaseId}, queue ${QUEUE_NAME})`);
}

function printChecklist(workerUrl) {
  const redirect = `${workerUrl ?? "https://<worker>.<subdomain>.workers.dev"}/auth/callback`;
  log("");
  log("Next steps to make this installation usable:");
  log("  - Set the secrets (each command prompts for the value):");
  for (const secret of [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "CREDENTIAL_KEY",
    "SESSION_SECRET",
  ]) {
    log(`      npx wrangler secret put ${secret}`);
  }
  log("  - Register this exact redirect URI on your Google OAuth client:");
  log(`      ${redirect}`);
  log("  - Re-run `npm run deploy` after setting the secrets.");
  log("    JEV_API_KEY is optional (Command Code classifier).");
  log(`    CREDENTIAL_KEY_VERSION=${KEY_VERSION} is already set as a var.`);
}

function printPlan({ databaseId }) {
  log("");
  log("Plan (dry run — no Cloudflare writes):");
  log("  1. build:    vite build && tsc -p tsconfig.server.json   (would run)");
  log(
    databaseId
      ? `  2. database: reuse "${DB_NAME}" (${databaseId})`
      : `  2. database: wrangler d1 create ${DB_NAME}   (would create)`,
  );
  log(`  3. queues:   ${QUEUE_NAME}, ${DLQ_NAME}   (create if missing)`);
  log(`  4. patch:    ${GENERATED_CONFIG} — set database_id/name, queue names, vars`);
  log(`  5. migrate:  wrangler d1 migrations apply ${DB_NAME} --remote   (would run)`);
  log("  6. deploy:   wrangler deploy   (would run)");
  log("");
}

function main() {
  if (CLEAN_DIST_ONLY) {
    const removed = removeGeneratedSecrets();
    if (removed > 0) {
      log(`[deploy] removed ${removed} generated .dev.vars from ${BUILD_OUTPUT_DIR}/`);
    }
    return;
  }

  log(
    `[deploy] ${DRY_RUN ? "dry run — no writes" : "deploying"} (db=${DB_NAME}, queue=${QUEUE_NAME})`,
  );

  requireLoggedIn();

  if (!DRY_RUN) {
    log("[deploy] 1/6 building (vite build && tsc -p tsconfig.server.json)");
    runStreaming("npm", ["run", "build"]);
    // `npm run build` already strips this, but strip again so the deploy path
    // never depends on that staying true.
    const removed = removeGeneratedSecrets();
    if (removed > 0) {
      log(`[deploy] removed ${removed} generated .dev.vars from ${BUILD_OUTPUT_DIR}/`);
    }
  }

  log("[deploy] 2/6 resolving D1 database");
  const databaseId = resolveDatabase();

  log("[deploy] 3/6 ensuring queues");
  const existingQueues = listQueues();
  ensureQueue(QUEUE_NAME, existingQueues);
  ensureQueue(DLQ_NAME, existingQueues);

  if (DRY_RUN) {
    printPlan({ databaseId });
    return;
  }

  log("[deploy] 4/6 patching generated config");
  patchGeneratedConfig({ databaseId });

  log(`[deploy] 5/6 applying migrations to "${DB_NAME}"`);
  runStreaming("npx", ["wrangler", "d1", "migrations", "apply", DB_NAME, "--remote"]);

  log("[deploy] 6/6 deploying");
  const deploy = spawnSync("npx", ["wrangler", "deploy"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (deploy.stdout) process.stdout.write(deploy.stdout);
  if (deploy.status !== 0) {
    fail(`\`wrangler deploy\` failed (exit ${deploy.status ?? "unknown"}).`);
  }

  const urlMatch = (deploy.stdout ?? "").match(
    /https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+\.workers\.dev/i,
  );
  const workerUrl = urlMatch ? urlMatch[0] : null;
  log("");
  log(workerUrl ? `[deploy] deployed: ${workerUrl}` : "[deploy] deployed (see the URL above)");
  printChecklist(workerUrl);
}

main();
