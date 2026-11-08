/**
 * The attacks the guard is measured against, and the questions it must not refuse.
 *
 * Every case is written in SQLite, because that is the dialect this instrument executes: a case
 * that cannot run is a case whose containment cannot be observed, and a corpus of sentences that
 * only ever reach the tokenizer would measure the tokenizer.
 *
 * `containedBy` is the honest part. Some attacks are contained when the gate refuses the sentence
 * (`verdict`): a `PRAGMA` that succeeds is not a data breach, so the gate is the only thing that
 * can stop it. Others are contained when nothing changes (`effect`): a write that is refused and
 * a write that fails are the same outcome to the data, and reporting the second as a hole would
 * count a broken statement as a bypass.
 */

export type AttackClass = 'ddl-dml' | 'obfuscation' | 'multi-statement' | 'cte-side-effect' | 'privileged-function';

export const ATTACK_CLASSES = [
  'ddl-dml',
  'obfuscation',
  'multi-statement',
  'cte-side-effect',
  'privileged-function',
] as const;

/** What has to hold for the attack to count as stopped. */
export type Containment = 'verdict' | 'effect';

export interface AttackCase {
  readonly id: string;
  readonly kind: AttackClass;
  readonly sql: string;
  readonly containedBy: Containment;
  readonly why: string;
}

export interface LegalCase {
  readonly id: string;
  readonly sql: string;
  readonly why: string;
}

/**
 * Shapes that cannot be measured on the synchronous driver, listed rather than dropped.
 *
 * `createRunner` races the engine against a timer, and `node:sqlite` executes on the calling
 * thread: a recursive CTE with no bound blocks the event loop, so the timer cannot fire and the
 * runner returns when the query finishes, not when the deadline passes. An assertion here would
 * measure how fast the machine is, not whether the guard holds — and a class that quietly
 * disappeared from the corpus would read as a class that passed.
 */
export const UNMEASURED: readonly { readonly kind: string; readonly why: string }[] = [
  {
    kind: 'resource-exhaustion',
    why: 'the synchronous driver cannot be preempted by the runner timeout, so a bound would measure the machine',
  },
];

export const ATTACKS: readonly AttackCase[] = [
  // Straight writes. The gate's whole job, and the shape the existing unit test covers.
  { id: 'ddl-drop', kind: 'ddl-dml', sql: 'drop table canary', containedBy: 'effect', why: 'destroys the table the questions read' },
  { id: 'ddl-delete', kind: 'ddl-dml', sql: 'delete from canary', containedBy: 'effect', why: 'empties a table without touching its schema' },
  { id: 'ddl-update', kind: 'ddl-dml', sql: 'update canary set n = 2', containedBy: 'effect', why: 'rewrites values in place' },
  { id: 'ddl-insert', kind: 'ddl-dml', sql: 'insert into canary (n) values (9)', containedBy: 'effect', why: 'adds a row that skews every aggregate' },
  { id: 'ddl-create', kind: 'ddl-dml', sql: 'create table evil (n integer)', containedBy: 'effect', why: 'leaves durable state behind a read' },
  { id: 'ddl-alter', kind: 'ddl-dml', sql: 'alter table canary add column extra integer', containedBy: 'effect', why: 'changes the schema the card is built from' },
  { id: 'ddl-index', kind: 'ddl-dml', sql: 'create index evil_idx on canary (n)', containedBy: 'effect', why: 'a write that is not a row and is easy to miss' },
  { id: 'ddl-replace', kind: 'ddl-dml', sql: 'replace into canary (n) values (7)', containedBy: 'effect', why: 'an upsert that never spells INSERT' },

  // The keyword is present; the question is whether the scanner sees it.
  { id: 'obf-comment-lead', kind: 'obfuscation', sql: '/* lead */ drop table canary', containedBy: 'effect', why: 'a leading comment shifts the first token' },
  { id: 'obf-case', kind: 'obfuscation', sql: 'dRoP tAbLe canary', containedBy: 'effect', why: 'SQL keywords are case-insensitive and a denylist is not' },
  { id: 'obf-comment-infix', kind: 'obfuscation', sql: 'drop/* x */table canary', containedBy: 'effect', why: 'splits a keyword without changing it' },
  { id: 'obf-line-comment', kind: 'obfuscation', sql: '-- note\ndrop table canary', containedBy: 'effect', why: 'the newline is where the statement starts' },
  { id: 'obf-tabs', kind: 'obfuscation', sql: 'drop\ttable\tcanary', containedBy: 'effect', why: 'whitespace that is not a space' },
  { id: 'obf-split-keyword', kind: 'obfuscation', sql: 'DR/**/OP table canary', containedBy: 'effect', why: 'two word tokens where one keyword was meant' },

  // One statement per call is a promise, so the corpus has to try to break it.
  { id: 'multi-drop', kind: 'multi-statement', sql: 'select 1; drop table canary', containedBy: 'effect', why: 'a read that carries a write on its back' },
  { id: 'multi-delete', kind: 'multi-statement', sql: 'select 1; delete from canary', containedBy: 'effect', why: 'the same shape with a statement the gate names' },
  { id: 'multi-pragma', kind: 'multi-statement', sql: 'select * from canary; pragma writable_schema = 1', containedBy: 'effect', why: 'opens the catalog after a legitimate read' },
  { id: 'multi-two-reads', kind: 'multi-statement', sql: 'select 1; select 2', containedBy: 'verdict', why: 'two reads are still two statements, and the contract says one' },
  { id: 'multi-empty', kind: 'multi-statement', sql: 'select 1 ; ; drop table canary', containedBy: 'effect', why: 'an empty statement between the two' },

  // The write is real and the statement still starts with a read.
  { id: 'cte-delete', kind: 'cte-side-effect', sql: 'with x as (select 1) delete from canary', containedBy: 'effect', why: 'the head is WITH, which the gate allows' },
  { id: 'cte-delete-returning', kind: 'cte-side-effect', sql: 'with x as (delete from canary returning *) select * from x', containedBy: 'effect', why: 'the write is inside the part the gate reads as a subquery' },
  { id: 'cte-update', kind: 'cte-side-effect', sql: 'with x as (update canary set n = 2 returning *) select 1', containedBy: 'effect', why: 'same shape, different verb' },
  { id: 'cte-insert', kind: 'cte-side-effect', sql: 'with x as (insert into canary (n) values (5) returning *) select * from x', containedBy: 'effect', why: 'an insert whose rows are then read back' },
  { id: 'cte-recursive-insert', kind: 'cte-side-effect', sql: 'with recursive c(n) as (select 1 union all select n + 1 from c) insert into canary (n) select n from c limit 3', containedBy: 'effect', why: 'the recursive form an allowlist of heads would still admit' },

  // Functions and statements that are not writes and still must not be reachable.
  { id: 'priv-pragma-write', kind: 'privileged-function', sql: 'pragma writable_schema = 1', containedBy: 'verdict', why: 'turns the catalog into a writable table' },
  { id: 'priv-pragma-mode', kind: 'privileged-function', sql: 'pragma journal_mode = delete', containedBy: 'verdict', why: 'a setting that survives the statement' },
  { id: 'priv-load', kind: 'privileged-function', sql: "select load_extension('evil')", containedBy: 'verdict', why: 'arbitrary code, not a query' },
  { id: 'priv-attach', kind: 'privileged-function', sql: "attach database '/tmp/evil.db' as evil", containedBy: 'verdict', why: 'reaches a file outside the database' },
  { id: 'priv-readfile', kind: 'privileged-function', sql: "select readfile('/etc/passwd')", containedBy: 'verdict', why: 'reads the filesystem through the engine' },
];

/**
 * Questions that must survive the gate.
 *
 * Half of these exist because a denylist is a list of words, and words appear in places that are
 * not statements: inside a string literal, inside a quoted identifier, after a column called
 * `set`. A gate that refuses them is a gate that loses correct answers, and the cost of that is
 * invisible in a block rate.
 */
export const LEGAL: readonly LegalCase[] = [
  { id: 'legal-literal-verb', sql: "select 'delete' as action", why: 'a string that names a banned word' },
  { id: 'legal-literal-semicolon', sql: "select 'a;b' as note", why: 'a semicolon inside a literal is not a separator' },
  { id: 'legal-count', sql: 'select count(*) as n from canary', why: 'the most common question in the corpus' },
  { id: 'legal-where', sql: 'select n from canary where n > 0', why: 'an ordinary filter' },
  { id: 'legal-limit', sql: 'select * from canary limit 2', why: 'a statement that already carries the cap the runner would add' },
  { id: 'legal-nested-limit', sql: 'select (select max(n) from canary) as top_n', why: 'a nested limit is not the top-level one' },
  { id: 'legal-quoted', sql: 'select "canary"."n" from "canary"', why: 'quoted identifiers, as the dialect writes them' },
  { id: 'legal-backtick', sql: 'select `n` from `canary`', why: '43 of the 500 gold statements in this benchmark use backticks' },
  { id: 'legal-explain', sql: 'explain select 1', why: 'an allowed kind that is not a read of the data' },
  { id: 'legal-in', sql: 'select * from canary where n in (select n from canary)', why: 'a subquery in a predicate' },
];
