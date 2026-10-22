# 2. Read-only rejection

## Symptom

```
NL2C_E_GUARD_REJECTED: statement rejected: write
```

Thrown before the statement reaches the engine. For SQLite and PostgreSQL there is
also a second layer: the session itself is opened read-only, so a statement the
lexical check cannot see (a sequence advance, for instance) is refused by the
server with *read-only transaction*.

## What it means

The statement was classified as a write. The classifier strips comments first, so a
leading `-- note` cannot hide an `insert`, and it treats `select … for update` as a
write because it takes row locks.

## Do this

1. **Read the statement, not the error.** The rejection carries the first 120
   characters in `details.statement`.
2. **If it really is a read**, look for a write keyword inside a string literal or a
   column name; the classifier is lexical and does not parse.
3. **If it is a write**, do not disable the guard on a shared connection: open a
   separate engine with `readOnly: false` for the migration path, and keep the
   analytical path read-only. The engines are cheap; a shared connection is not.
4. **Verify the data is unchanged** before retrying — the drill asserts the row
   count after a rejected delete precisely so this check is habitual.

## Drill

`test/runbooks.test.ts` → *runbook: read-only rejection* runs a `delete` through a
runner and asserts the rejection code plus an unchanged row count.
