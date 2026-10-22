# 1. Connection failure

## Symptom

```
NL2C_E_ENGINE_FAILED: postgres (postgres://analyst:***@db.internal:5432/warehouse): connect ECONNREFUSED
```

The message names the engine and the redacted URL, and ends with the driver's own
words. The password never appears — `describeConnector` is the only function in the
library that writes a connection string, and it redacts the authority and the
common query parameters (`password`, `pwd`, `token`, `key`, `secret`).

## What it means

The driver could not open a session. In order of likelihood:

1. the host or port is wrong, or the database is down;
2. the credentials are wrong (PostgreSQL answers `password authentication failed`,
   MySQL answers `Access denied`);
3. the network policy blocks the sandbox (common in hosted runners);
4. the database requires TLS and the URL does not say so.

## Do this

1. **Check the URL, not the code.** `describeConnector` prints what the library
   thinks it was given; if the redaction shows a truncated host, the URL is
   malformed.
2. **Reach the host from the same place the process runs.** A connection that works
   on a laptop and fails in CI is a network policy, not a driver.
3. **Do not paste the URL into a ticket.** It carries a password; the redacted form
   carries everything an operator needs.
4. If the failure is a *query* error rather than a connection error, the message
   still starts with the redacted URL and then quotes the server: fix the SQL, not
   the connection.

## Drill

`test/runbooks.test.ts` → *runbook: connection failure* opens a real PostgreSQL and
MySQL engine against a closed port and asserts three things: the code is
`NL2C_E_ENGINE_FAILED`, the message matches `analyst:***@`, and the password is
absent.
