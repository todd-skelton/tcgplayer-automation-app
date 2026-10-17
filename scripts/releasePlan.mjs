/**
 * Whether a release can keep the running app serving while the new one starts.
 *
 * The new app applies pending migrations at startup, so during an overlap the
 * running release works against the migrated schema. That is only safe when
 * every pending migration says so with an `-- online: <why>` line, and none of
 * them contains a statement that commonly breaks the previous release.
 */

const ONLINE_MARKER = /^--\s*online:\s*\S/m;

const BREAKING_STATEMENTS = [
  [/\bdrop\s+table\b(?!\s+if\s+exists\s+pg_temp\.)/i, "drops a table"],
  [/\bdrop\s+column\b/i, "drops a column"],
  [/\brename\s+(column\s+)?\S+\s+to\b|\brename\s+to\b/i, "renames a table or column"],
  [/\bset\s+not\s+null\b/i, "makes a column NOT NULL"],
  [/\balter\s+column\s+\S+\s+(set\s+data\s+)?type\b/i, "changes a column type"],
];

const withoutComments = (sql) => sql.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

const addsRequiredColumnWithoutDefault = (statement) =>
  /\badd\s+column\b/i.test(statement) && /\bnot\s+null\b/i.test(statement) && !/\bdefault\b/i.test(statement);

/** Why the previous release might break against this migration, if anything. */
export function migrationRisks({ sql }) {
  const code = withoutComments(sql);
  const risks = BREAKING_STATEMENTS.filter(([pattern]) => pattern.test(code)).map(([, risk]) => risk);
  if (code.split(";").some(addsRequiredColumnWithoutDefault)) risks.push("adds a NOT NULL column without a default");
  if (!ONLINE_MARKER.test(sql)) risks.unshift("is not marked `-- online:`");
  return risks;
}

/**
 * "overlap" keeps the running app serving until the new one is healthy;
 * "stop_first" stops it before the new one migrates.
 */
export function planRelease(pendingMigrations) {
  const reasons = pendingMigrations.flatMap((migration) =>
    migrationRisks(migration).map((risk) => `${migration.name} ${risk}`),
  );
  return reasons.length ? { mode: "stop_first", reasons } : { mode: "overlap", reasons: [] };
}

/** Migration files not yet recorded as applied, in the order they will run. */
export function pendingMigrationNames(files, appliedNames) {
  const applied = new Set(appliedNames);
  return files.filter((file) => file.endsWith(".sql") && !applied.has(file)).sort();
}
