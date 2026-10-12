// Guards against tests/fixtures/schema.sql (the test-only aggregate) drifting
// from the numbered migrations that wrangler actually applies. Fails the build
// if they diverge. The aggregate lives outside migrations/ so wrangler never
// applies it to a real database.

import { readFileSync, readdirSync } from "node:fs";

function normalize(sql) {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
}

function statements(sql) {
  return normalize(sql)
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .sort();
}

// Every numbered migration, so adding a file cannot silently skip the check.
const combined = statements(
  readdirSync("migrations")
    .filter((name) => /^\d{4}_.*\.sql$/.test(name))
    .sort()
    .map((name) => readFileSync(`migrations/${name}`, "utf8"))
    .join("\n"),
);
const bundled = statements(readFileSync("tests/fixtures/schema.sql", "utf8"));

const missing = combined.filter((s) => !bundled.includes(s));
const extra = bundled.filter((s) => !combined.includes(s));

if (missing.length > 0 || extra.length > 0) {
  console.error(
    "tests/fixtures/schema.sql is out of sync with the numbered migrations.",
  );
  for (const s of missing) console.error(`  missing: ${s.slice(0, 80)}`);
  for (const s of extra) console.error(`  extra:   ${s.slice(0, 80)}`);
  process.exit(1);
}

console.log(`migrations in sync (${combined.length} statements)`);
