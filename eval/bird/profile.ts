/**
 * Build a data profile per database, using the same SQLite oracle as the runs.
 *
 * One query per column for cardinality and range, plus one grouped query for the
 * columns that turn out to be categorical. The result is cached under
 * `eval/.cache/bird/profiles/` because it depends only on the database file, and
 * recomputing it on every run would add minutes to a job that is about accuracy.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ColumnProfile, DatabaseProfile, ProfileKind } from '@agentix-e/nl2charts-ai';
import type { Oracle } from './oracle.js';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const CACHE = join(ROOT, 'eval/.cache/bird/profiles');

/** A column with more distinct values than this is not a dictionary entry. */
const MAX_CATEGORIES = 30;
const MAX_VALUES = 8;

function kindOf(type: string, sample: unknown): ProfileKind {
  const declared = type.toLowerCase();
  if (declared.includes('date') || declared.includes('time')) return 'date';
  if (declared.includes('int') || declared.includes('real') || declared.includes('num') || declared.includes('dec') || declared.includes('double')) {
    return 'numeric';
  }
  if (typeof sample === 'string' && /^\d{4}-\d{2}-\d{2}/.test(sample)) return 'date';
  if (typeof sample === 'number') return 'numeric';
  return 'categorical';
}

const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;

export async function profileDatabase(
  oracle: Oracle,
  db: string,
  options: { readonly force?: boolean; readonly cacheDir?: string } = {},
): Promise<DatabaseProfile> {
  // The cache directory is an option so a test can profile a database without leaving a
  // file in the repository, and so two runs cannot share a profile by accident.
  const cacheDir = options.cacheDir ?? CACHE;
  mkdirSync(cacheDir, { recursive: true });
  const cacheFile = join(cacheDir, `${db}.json`);
  if (!options.force && existsSync(cacheFile)) {
    return JSON.parse(readFileSync(cacheFile, 'utf8')) as DatabaseProfile;
  }

  const tables = await oracle.run(db, "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name");
  const columns: ColumnProfile[] = [];
  for (const row of tables.rows) {
    const table = String(row[0]);
    const info = await oracle.run(db, `select name, type from pragma_table_info('${table.replace(/'/g, "''")}') order by cid`);
    for (const entry of info.rows) {
      const column = String(entry[0]);
      const declared = String(entry[1] ?? '');
      const stats = await oracle.run(
        db,
        `select count(${quote(column)}), count(distinct ${quote(column)}), min(${quote(column)}), max(${quote(column)}), (select ${quote(column)} from ${quote(table)} where ${quote(column)} is not null limit 1) from ${quote(table)}`,
      );
      if (!stats.ok) continue;
      const [nonNull, distinct, min, max, sample] = stats.rows[0] as unknown[];
      const total = Number(nonNull ?? 0);
      const unique = Number(distinct ?? 0);
      // Identifier columns carry a range, not a meaning: "publisher_id: numbers
      // from 1 to 25" tells a model nothing it cannot read from the schema card,
      // and it pushed every categorical column out of the character budget on the
      // first profile. Dropped by name, before any statistics are used.
      if (/(^|_)id$/i.test(column) || /[a-z]Id$/.test(column) || column.toLowerCase() === 'id') {
        columns.push({ table, column, kind: 'other' });
        continue;
      }
      // A high-cardinality text column is free text; a small table's text column
      // is a dictionary even when every row is distinct (`alignment` has four).
      if (total === 0 || unique === 0 || (unique === total && total > 50)) {
        columns.push({ table, column, kind: 'other' });
        continue;
      }
      const kind = kindOf(declared, sample);
      if (kind === 'categorical') {
        if (unique > MAX_CATEGORIES) {
          columns.push({ table, column, kind: 'other' });
          continue;
        }
        const grouped = await oracle.run(
          db,
          `select ${quote(column)}, count(*) as n from ${quote(table)} where ${quote(column)} is not null group by 1 order by n desc, 1 limit ${MAX_VALUES}`,
        );
        const values = grouped.rows.map((entry) => String(entry[0]));
        // Opaque keys look categorical (few distinct values) but say nothing:
        // 'recLKj8BbTNqxFbTb' is a join key, not a business value.
        if (values.length > 0 && values.every((value) => /^[A-Za-z0-9_-]{16,}$/.test(value))) {
          columns.push({ table, column, kind: 'other' });
          continue;
        }
        columns.push({ table, column, kind, distinct: unique, values });
        continue;
      }
      columns.push({
        table,
        column,
        kind,
        distinct: unique,
        ...(min === null || min === undefined ? {} : { min: String(min) }),
        ...(max === null || max === undefined ? {} : { max: String(max) }),
      });
    }
  }

  const profile: DatabaseProfile = { db, columns };
  writeFileSync(cacheFile, `${JSON.stringify(profile, null, 2)}\n`);
  return profile;
}
