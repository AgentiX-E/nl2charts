#!/usr/bin/env node
/**
 * How far does a BIRD (SQLite) statement travel on DuckDB?
 *
 * The product's default engine is DuckDB; the benchmark dataset is SQLite. That
 * gap is a number a user needs before choosing an engine, and it is a number no
 * competitor publishes. Every gold statement is executed three ways:
 *
 *   plain       the statement exactly as the dataset wrote it
 *   rewritten   backtick identifiers become double quotes (both are valid SQLite)
 *   withMacro   rewritten plus an `iif` macro, which SQLite has and DuckDB lacks
 *
 * Tables are copied into an in-memory schema per database. That is not cosmetic:
 * a macro cannot be created in a read-only attached catalog, and DuckDB resolves
 * functions inside the current catalog, so statements have to run somewhere
 * writable for the macro stage to mean anything.
 *
 * Report-only: it writes an artifact and never fails a build.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const DATA = process.env.BIRD_DATA ?? join(ROOT, 'eval/.cache/bird/minidev/MINIDEV');
const DATABASES = process.env.BIRD_DATABASES ?? join(DATA, 'dev_databases');
const DBS = (process.env.BIRD_DBS ?? 'superhero,california_schools,student_club,thrombosis_prediction,toxicology,debit_card_specializing')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);

const quote = (name) => `"${name.replace(/"/g, '""')}"`;

/** Backticks are SQLite's MySQL-compat quoting; DuckDB only accepts double quotes. */
const rewrite = (sql) => sql.replace(/`([^`]*?)`/g, (_, name) => quote(name));

function classify(message) {
  return (message.split('\n')[0] ?? message).replace(/:.*$/, '').slice(0, 60);
}

const questions = JSON.parse(readFileSync(join(DATA, 'mini_dev_sqlite.json'), 'utf8')).filter((question) =>
  DBS.includes(question.db_id),
);

const instance = await DuckDBInstance.create(':memory:');
const connection = await instance.connect();
await connection.run('INSTALL sqlite; LOAD sqlite;');
const MACRO = 'CREATE OR REPLACE MACRO memory.main.iif(condition, when_true, when_false) AS CASE WHEN condition THEN when_true ELSE when_false END';

const stages = { plain: [], rewritten: [], withMacro: [] };
const failures = { plain: [], rewritten: [], withMacro: [] };

for (const db of DBS) {
  const source = `${db}_src`;
  const target = `${db}_mem`;
  await connection.run(`ATTACH '${join(DATABASES, db, `${db}.sqlite`)}' AS ${quote(source)} (TYPE sqlite, READ_ONLY)`);
  await connection.run(`CREATE SCHEMA IF NOT EXISTS ${quote(target)}`);
  const tables = await connection.runAndReadAll(`SELECT table_name FROM duckdb_tables() WHERE database_name = '${source}'`);
  for (const row of tables.getRowObjects()) {
    const name = String(row.table_name);
    await connection.run(
      `CREATE OR REPLACE TABLE ${quote(target)}.${quote(name)} AS SELECT * FROM ${quote(source)}.${quote(name)}`,
    );
  }
  await connection.run(`USE memory.${quote(target)}`);

  // The macro exists only for its own stage; otherwise "rewritten" and
  // "withMacro" would measure the same thing and the iif cost would vanish.
  for (const stage of ['plain', 'rewritten', 'withMacro']) {
    if (stage === 'withMacro') await connection.run(MACRO);
    for (const question of questions.filter((entry) => entry.db_id === db)) {
      const sql = stage === 'plain' ? question.SQL : rewrite(question.SQL);
      try {
        const reader = await connection.runAndReadAll(sql);
        reader.getRowObjects();
        stages[stage].push(question.question_id);
      } catch (error) {
        failures[stage].push({ id: question.question_id, db, kind: classify(error.message) });
      }
    }
    if (stage === 'withMacro') await connection.run('DROP MACRO memory.main.iif');
  }
}

const total = questions.length;
const taxonomy = (list) => {
  const counts = {};
  for (const entry of list) counts[entry.kind] = (counts[entry.kind] ?? 0) + 1;
  return Object.entries(counts)
    .sort((left, right) => right[1] - left[1])
    .map(([kind, count]) => ({ kind, count }));
};

const report = {
  dataset: 'bird-mini-dev',
  engine: 'duckdb',
  databases: DBS,
  statements: total,
  generatedAt: new Date().toISOString(),
  stages: Object.fromEntries(
    Object.entries(stages).map(([stage, passed]) => [
      stage,
      {
        runnable: passed.length,
        rate: total === 0 ? 0 : passed.length / total,
        failed: failures[stage].length,
        taxonomy: taxonomy(failures[stage]),
        examples: failures[stage].slice(0, 10),
      },
    ]),
  ),
};

mkdirSync(join(ROOT, 'eval/out'), { recursive: true });
writeFileSync(join(ROOT, 'eval/out/duckdb-portability.json'), `${JSON.stringify(report, null, 2)}\n`);
for (const [stage, value] of Object.entries(report.stages)) {
  console.log(`${stage.padEnd(12)} ${value.runnable}/${total}  ${(value.rate * 100).toFixed(1)}%  ${JSON.stringify(value.taxonomy.slice(0, 3))}`);
}
