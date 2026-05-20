# Auto EvoEvo Runner

Local Playwright/CDP automation for EvoEvo `ADD TO MEMORY` actions with guarded Rabby signing.

## Setup

1. Run `npm install`.
2. Copy `config.example.json` to `config.local.json`.
3. Set `chromeProfilePath` to a Chrome profile logged into EvoEvo and Rabby.
4. Set `rabbyExtensionId` to the installed Rabby Chrome extension ID. `config.example.json` defaults to Rabby's Chrome extension ID.
5. Replace `allowedContracts` with the full EvoEvo contract address from a manually verified transaction.
6. Keep `dryRun` set to `true` for the first run.

If PowerShell blocks `npm.ps1` because of execution policy, use `npm.cmd` instead of `npm`.

## Dry Run

```powershell
npm run dry-run -- --config config.local.json
```

Dry run clicks EvoEvo buttons and inspects Rabby, but it does not click `Sign`. It may still open the Rabby popup and pause on guard failures; this is intentional so you can review unexpected requests manually.

Logs are written as JSONL files in `logs/`.

## Guarded Signing

Set `dryRun` to `false` only after dry-run logs show the expected origin, chain, contract, action fingerprint, and fee.

```powershell
npm start -- --config config.local.json
```

The runner pauses when a request does not match the configured guardrails. Review any open Rabby popup manually before signing or rejecting.

## Stop

Press `Ctrl+C` in the terminal to stop the runner. If a Rabby popup is open, review it manually before signing or rejecting.
