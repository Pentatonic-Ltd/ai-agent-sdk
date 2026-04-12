/**
 * Database migration runner.
 *
 * Applies SQL migrations idempotently. Tracks applied migrations
 * in a schema_migrations table.
 */

import { readFileSync, readdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../migrations");

/**
 * Apply all pending database migrations.
 *
 * @param {Function} db - Database query function: (sql, params) => {rows}
 * @param {object} [opts]
 * @param {Function} [opts.logger] - Optional logger
 * @returns {Promise<{applied: string[], total: number}>}
 */
export async function migrate(db, opts = {}) {
  const log = opts.logger || (() => {});

  // Ensure migrations tracking table exists
  await db(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ DEFAULT NOW()
     )`,
    []
  );

  // Get already-applied migrations
  const applied = await db(
    `SELECT name FROM schema_migrations ORDER BY name`,
    []
  );
  const appliedSet = new Set((applied.rows || []).map((r) => r.name));

  // Read migration files
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const newlyApplied = [];

  for (const file of files) {
    if (appliedSet.has(file)) continue;

    const sql = readFileSync(resolve(MIGRATIONS_DIR, file), "utf-8");
    log(`Applying migration: ${file}`);

    await db(sql, []);
    await db(`INSERT INTO schema_migrations (name) VALUES ($1)`, [file]);

    newlyApplied.push(file);
  }

  if (newlyApplied.length) {
    log(
      `Applied ${newlyApplied.length} migration(s): ${newlyApplied.join(", ")}`
    );
  } else {
    log("No pending migrations");
  }

  return { applied: newlyApplied, total: files.length };
}
