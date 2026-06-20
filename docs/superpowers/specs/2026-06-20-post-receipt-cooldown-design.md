# Post-Receipt Cooldown Design

## Goal

Move the existing `cooldownSeconds` delay so it happens after a successful transaction receipt, before the workflow starts the next memory intake.

## Current Behavior

The extension currently waits `cooldownSeconds` before signing and broadcasting each intake transaction. After `eth_getTransactionReceipt` returns success, the runner immediately proceeds to the next memory.

## Required Behavior

Keep the existing config name `cooldownSeconds`, but apply it after a successful receipt:

```text
from-opinion
-> sign + broadcast
-> wait receipt success
-> log signed
-> wait cooldownSeconds
-> next memory
```

Cooldown should not run for dry-run, rejected guard decisions, RPC failures, receipt timeouts, reverted transactions, or `already adopted` skips. Those outcomes already stop, retry, or skip through existing control flow.

## Scope

- Change only the direct intake submission pacing.
- Keep the UI field and config schema name `cooldownSeconds`.
- Do not add a separate post-transaction config.
- Do not wait for `/v1/me/points` or memory-root backend indexing in this change.

## Testing

Add a regression test proving the submitter sleeps only after a successful receipt. The existing test suite should continue to pass.
