# Runbooks

Six failures an operator will meet, what each one looks like, and what to do. Every
runbook has a drill: a test that reproduces the failure and asserts the signal the
page promises. If the drill fails, the runbook is wrong.

| Runbook | Drill |
| --- | --- |
| [Connection failure](01-connection-failure.md) | `test/runbooks.test.ts` → *runbook: connection failure* |
| [Read-only rejection](02-read-only-rejection.md) | *runbook: read-only rejection* |
| [Semantic error](03-semantic-error.md) | *runbook: semantic error* |
| [Timeout](04-timeout.md) | *runbook: timeout* |
| [Trace verification failure](05-trace-verification-failure.md) | *runbook: trace verification failure* |
| [Version rollback](06-version-rollback.md) | *runbook: version rollback* |

The leak paths behind these messages are enumerated in `test/leak-audit.test.ts`:
a canary password is pushed through every connector, runner and MCP error, and the
suite fails if it ever appears in a message or in the JSON a client receives.
