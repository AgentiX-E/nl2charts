/**
 * A BIRD-shaped dataset small enough to write during a test.
 *
 * The harnesses under `eval/bird/` read four things: a questions file, a table manifest,
 * description CSVs, and SQLite databases under `dev_databases/<db>/<db>.sqlite`. A test that
 * wants to drive one of them end to end has to produce all four, and three separate tests
 * producing them separately is three places for the shapes to drift — the first version of
 * the runner's end-to-end test carried its own copy of this, and a second copy in the
 * stability test would have been a second definition of "a dataset".
 *
 * Small on purpose: every dataset-level guard in the runner is gated on a sample size, so
 * seven questions licence the shape of a run without licensing a claim about a rate.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface MiniQuestion {
  readonly id: number;
  readonly question: string;
  readonly sql: string;
  readonly difficulty: 'simple' | 'moderate' | 'challenging';
}

/**
 * Seven questions whose gold statements all return rows.
 *
 * Not decoration: the runner's negative control executes each gold against `[]` and fails
 * the run if the judge calls that a match, so a gold returning nothing would make the
 * control vacuous and the run unpublishable for the wrong reason. The last one names a
 * stored literal, which is what an arm that grounds values in the data needs in order to
 * have a block to build.
 */
export const MINI_QUESTIONS: readonly MiniQuestion[] = [
  { id: 1, question: 'How many items are there?', sql: 'select count(*) from items', difficulty: 'simple' },
  { id: 2, question: 'What is the total price of every item?', sql: 'select sum(price) from items', difficulty: 'simple' },
  { id: 3, question: 'How many orders are there?', sql: 'select count(*) from orders', difficulty: 'moderate' },
  { id: 4, question: 'What is the largest quantity on an order?', sql: 'select max(qty) from orders', difficulty: 'moderate' },
  { id: 5, question: 'How many distinct item names are there?', sql: 'select count(distinct name) from items', difficulty: 'challenging' },
  { id: 6, question: 'What is the average item price?', sql: 'select avg(price) from items', difficulty: 'challenging' },
  { id: 7, question: 'How many orders are there for the pen?', sql: 'select count(*) from orders where item_id = 1', difficulty: 'moderate' },
];

/** The statement a well-behaved model writes for each question, keyed by question text. */
export const MINI_GOLD: Readonly<Record<string, string>> = Object.fromEntries(
  MINI_QUESTIONS.map((entry) => [entry.question, entry.sql]),
);

/** The database id every question in the fixture points at. */
export const MINI_DB = 'shop';

/**
 * The same shape as `MINI_QUESTIONS`, on a schema where a table can be out of reach.
 *
 * `items` and `orders` are one join apart in both fixtures, so neither can show what a rule that
 * removes tables takes away: every table it could drop is one join from every table it could keep.
 * Here the tables form a line — `items — orders — warehouses — cities` — so a card cut to one join
 * of the tables a question names can hold the middle of the line and miss its end. The third
 * question is that case: it names `orders` through the column `qty` and reads `cities`, which is
 * two joins away.
 */
export const CHAIN_QUESTIONS: readonly MiniQuestion[] = [
  { id: 1, question: 'How many items are there?', sql: 'select count(*) from items', difficulty: 'simple' },
  { id: 2, question: 'How many orders are there?', sql: 'select count(*) from orders', difficulty: 'moderate' },
  {
    id: 3,
    question: 'What is the largest qty on an order placed in Hangzhou?',
    sql: "select max(o.qty) from orders o join warehouses w on w.id = o.warehouse_id join cities c on c.id = w.city_id where c.name = 'Hangzhou'",
    difficulty: 'challenging',
  },
];

/**
 * Write the line `items — orders — warehouses — cities` under `dir` and return the directory.
 *
 * Same four files the mini fixture writes, because the harnesses read the same four; the only
 * difference is the schema, which exists to make a dropped table observable.
 */
export function writeChainBirdDataset(dir: string): string {
  const db = join(dir, 'dev_databases', MINI_DB);
  const descriptions = join(db, 'database_description');
  mkdirSync(descriptions, { recursive: true });
  const writer = new DatabaseSync(join(db, `${MINI_DB}.sqlite`));
  writer.exec(`
    create table items (id integer primary key, name text, price real);
    insert into items values (1, 'pen', 1.5), (2, 'cup', 3.25);
    create table cities (id integer primary key, name text);
    insert into cities values (1, 'Hangzhou'), (2, 'Chengdu');
    create table warehouses (id integer primary key, city_id integer);
    insert into warehouses values (1, 1), (2, 2);
    create table orders (id integer primary key, item_id integer, warehouse_id integer, qty integer);
    insert into orders values (1, 1, 1, 2), (2, 2, 2, 1), (3, 1, 1, 5);
  `);
  writer.close();
  writeFileSync(
    join(dir, 'mini_dev_sqlite.json'),
    JSON.stringify(
      CHAIN_QUESTIONS.map((entry) => ({
        question_id: entry.id,
        db_id: MINI_DB,
        question: entry.question,
        evidence: '',
        SQL: entry.sql,
        difficulty: entry.difficulty,
      })),
    ),
  );
  writeFileSync(
    join(dir, 'dev_tables.json'),
    JSON.stringify([
      {
        db_id: MINI_DB,
        table_names: ['Items', 'Orders', 'Warehouses', 'Cities'],
        table_names_original: ['items', 'orders', 'warehouses', 'cities'],
        // Column zero is the `*` every manifest carries; the foreign keys below index into it.
        column_names: [
          [-1, '*'],
          [0, 'id'],
          [0, 'name'],
          [0, 'price'],
          [1, 'id'],
          [1, 'item_id'],
          [1, 'warehouse_id'],
          [1, 'qty'],
          [2, 'id'],
          [2, 'city_id'],
          [3, 'id'],
          [3, 'name'],
        ],
        column_names_original: [
          [-1, '*'],
          [0, 'id'],
          [0, 'name'],
          [0, 'price'],
          [1, 'id'],
          [1, 'item_id'],
          [1, 'warehouse_id'],
          [1, 'qty'],
          [2, 'id'],
          [2, 'city_id'],
          [3, 'id'],
          [3, 'name'],
        ],
        column_types: [
          'text',
          'integer',
          'text',
          'real',
          'integer',
          'integer',
          'integer',
          'integer',
          'integer',
          'integer',
          'integer',
          'text',
        ],
        // orders.item_id -> items.id, orders.warehouse_id -> warehouses.id, warehouses.city_id -> cities.id
        foreign_keys: [
          [5, 1],
          [6, 8],
          [9, 10],
        ],
      },
    ]),
  );
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ databases: [{ db: MINI_DB }] }));
  writeFileSync(
    join(descriptions, 'items.csv'),
    [
      'original_column_name,column_name,column_description,data_format,value_description',
      'id,id,primary key,integer,',
      'name,name,the label the store sells under,text,',
      'price,price,list price of one unit,real,in yuan',
    ].join('\n'),
  );
  return dir;
}

/**
 * Write the dataset under `dir` and return the directory to point `BIRD_DATA` at.
 *
 * `dir` is the split directory (`…/MINIDEV` in BIRD's own layout), not a parent of it.
 */
export function writeMiniBirdDataset(dir: string): string {
  const db = join(dir, 'dev_databases', MINI_DB);
  const descriptions = join(db, 'database_description');
  mkdirSync(descriptions, { recursive: true });
  const writer = new DatabaseSync(join(db, `${MINI_DB}.sqlite`));
  writer.exec(`
    create table items (id integer primary key, name text, price real);
    insert into items values (1, 'pen', 1.5), (2, 'cup', 3.25), (3, 'pen', 1.5);
    create table orders (id integer primary key, item_id integer, qty integer);
    insert into orders values (1, 1, 2), (2, 2, 1), (3, 1, 5);
  `);
  writer.close();
  writeFileSync(
    join(dir, 'mini_dev_sqlite.json'),
    JSON.stringify(
      MINI_QUESTIONS.map((entry) => ({
        question_id: entry.id,
        db_id: MINI_DB,
        question: entry.question,
        evidence: '',
        SQL: entry.sql,
        difficulty: entry.difficulty,
      })),
    ),
  );
  writeFileSync(
    join(dir, 'dev_tables.json'),
    JSON.stringify([
      {
        db_id: MINI_DB,
        table_names: ['Items', 'Orders'],
        table_names_original: ['items', 'orders'],
        column_names: [
          [-1, '*'],
          [0, 'id'],
          [0, 'name'],
          [0, 'price'],
          [1, 'id'],
          [1, 'item_id'],
          [1, 'qty'],
        ],
        column_names_original: [
          [-1, '*'],
          [0, 'id'],
          [0, 'name'],
          [0, 'price'],
          [1, 'id'],
          [1, 'item_id'],
          [1, 'qty'],
        ],
        column_types: ['text', 'integer', 'text', 'real', 'integer', 'integer', 'integer'],
        foreign_keys: [[5, 1]],
      },
    ]),
  );
  // The manifest is what a derived split ships; `databasesFromManifest` reads it first.
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ databases: [{ db: MINI_DB }] }));
  writeFileSync(
    join(descriptions, 'items.csv'),
    [
      'original_column_name,column_name,column_description,data_format,value_description',
      'id,id,primary key,integer,',
      'name,name,the label the store sells under,text,',
      'price,price,list price of one unit,real,in yuan',
    ].join('\n'),
  );
  return dir;
}
