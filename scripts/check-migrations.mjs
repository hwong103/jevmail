// Guards against migrations/0000.sql drifting from the numbered migrations that
// wrangler actually applies. Fails the build if they diverge.

import { readFileSync } from "node:fs";

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

const combined = statements(
  readFileSync("migrations/0001_initial.sql", "utf8") +
    readFileSync("migrations/0002_partial_unique.sql", "utf8"),
);
const bundled = statements(readFileSync("migrations/0000.sql", "utf8"));

const missing = combined.filter((s) => !bundled.includes(s));
const extra = bundled.filter((s) => !combined.includes(s));

if (missing.length > 0 || extra.length > 0) {
  console.error("migrations/0000.sql is out of sync with the numbered migrations.");
  for (const s of missing) console.error(`  missing: ${s.slice(0, 80)}`);
  for (const s of extra) console.error(`  extra:   ${s.slice(0, 80)}`);
  process.exit(1);
}

console.log(`migrations in sync (${combined.length} statements)`);
