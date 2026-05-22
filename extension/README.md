# Auto EvoEvo Extension

Chrome MV3 extension that replaces the Playwright runner on `https://evoevo.ai`.

## Build

```powershell
cd extension
npm install
npm run build
```

`dist/` contains the loadable extension.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click "Load unpacked" and select `extension/dist`.

## First run

1. Click the extension icon → opens popup → click "Options".
2. Fill in:
   - 0G RPC URL (copy from your Rabby network entry for 0G)
   - Chain id (e.g. `16661` for 0G testnet — verify against your Rabby entry)
   - Max fee (OG): `0.001`
   - Allowed contracts: `0x61bb710000000000000000000000000000e937f9`
   - Allowed function selectors: capture the 4-byte selector from a real `ADD TO MEMORY` tx via 0G explorer (field "Input Data", first 10 chars including `0x`).
   - Idle-lock minutes: `30`
   - Private key + master password (one time).
3. Click Save.
4. On `evoevo.ai`, disable Rabby for this site (Rabby > Settings > Sites > Block) so this extension wins the `window.ethereum` injection race.

## Dry-run smoke

`dryRun: true` is the default in saved config. With dry-run on:

1. Open `https://evoevo.ai/feed`.
2. Open the extension popup → Unlock → Start (Pause toggle off).
3. The extension auto-clicks ADD TO MEMORY. Every tx is logged but NOT signed.
4. Verify log entries have `status: "dry_run"` and no tx appears on the 0G explorer.

## Production smoke

After dry-run looks correct:

1. Options → set `dryRun: false` (toggle if added, else edit the saved config via re-import).
2. Click one ADD TO MEMORY card.
3. Verify a tx appears on the 0G explorer with the expected `to` and fee ≤ `maxFeeNative`.
4. Lower `maxFeeNative` and try again — extension should pause with reason "Estimated fee exceeds cap".
