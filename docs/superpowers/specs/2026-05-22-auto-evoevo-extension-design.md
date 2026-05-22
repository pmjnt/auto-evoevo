# Auto EvoEvo Extension Design

Date: 2026-05-22

## Goal

Replace the Playwright/CDP runner with a Chrome MV3 extension that the user installs into their normal Chrome profile. The extension:

- Auto-clicks `ADD TO MEMORY` (and `SHOW MORE`) on `https://evoevo.ai/feed`.
- Acts as the wallet itself (replaces Rabby on this site) by exposing `window.ethereum` (EIP-1193), so it sees the exact transaction object EvoEvo builds.
- Validates every `eth_sendTransaction` against the existing guard rules, signs locally with a key stored encrypted-at-rest, and broadcasts to a 0G RPC endpoint.
- Pauses (does not sign) whenever guards fail; surfaces reason via popup UI and session log.

Motivation: avoid the Playwright dependency, the dedicated Chrome automation profile, and the text-parsing fragility of reading the Rabby popup. The extension can read transaction params directly from the EIP-1193 call, which makes guard checks stricter and simpler.

## Non-goals

- Distributing the extension to other users (no Chrome Web Store listing in scope).
- Supporting wallets other than the built-in encrypted vault (no WalletConnect, no hardware wallet, no MetaMask Snap).
- Supporting chains other than 0G.
- Reverse-engineering the EvoEvo contract function ABI. The extension treats `data` as opaque bytes, gated by function-selector whitelist.

## Architecture

Four execution contexts, each with one responsibility, communicating only through typed messages:

```
+-------------------------------------------------------------------+
| Tab evoevo.ai/feed                                                |
|                                                                   |
|  +-----------------+   postMessage    +----------------------+    |
|  | inpage/provider |<---------------->| content/index        |    |
|  | (main world)    |                  | (isolated world)     |    |
|  |                 |                  |  - bridge            |    |
|  | window.ethereum |                  | content/automation   |    |
|  | (EIP-1193)      |                  |  - auto-click loop   |    |
|  +-----------------+                  +----------+-----------+    |
+-------------------------------------------------+-----------------+
                                  chrome.runtime.sendMessage
                                                  |
                          +-----------------------v---------------+
                          | background (MV3 service worker)       |
                          |   - message router                    |
                          |   - wallet (in-memory key after unlock)|
                          |   - pipeline (guard + sign + broadcast)|
                          |   - rpc client (0G)                   |
                          |   - session log                       |
                          +-------------------^-------------------+
                                              |
                          +-------------------+-------------------+
                          | popup.html / options.html             |
                          |   - unlock password                   |
                          |   - status + log viewer + pause/resume|
                          |   - config (whitelist, RPC, cap)      |
                          +---------------------------------------+
```

**Why the split:**

- `inpage` must live in main world to be visible as `window.ethereum`. Main world has no `chrome.*` access.
- `content` runs in isolated world: holds DOM automation logic and bridges messages to background.
- `background` is the only place the private key ever lives (in service-worker memory after unlock).
- `popup`/`options` are pure UIs; they call background through the same message API.

**Reused from current codebase:**

- `src/guard.ts` ports unchanged. Input shape (`WalletRequest`) is the same; only the field-population site moves from text parsing to tx-params extraction.
- `src/types.ts` (`WalletRequest`, `GuardDecision`, `AttemptLog`) ports unchanged.
- DOM automation logic in `src/evoevo/controller.ts` (visible-button discovery, `data-auto-evoevo-attempted-id` marker, SHOW MORE expansion with 2-strike idle stop) ports into `content/automation.ts`.

## Data flow (single ADD TO MEMORY click)

```
[1] content/automation : find first visible+enabled ADD TO MEMORY button
                         not yet marked; set data-auto-evoevo-attempted-id;
                         button.click()

[2] EvoEvo page JS     : builds tx; calls
                         window.ethereum.request({
                           method: 'eth_sendTransaction',
                           params: [{from, to, data, value?, gas?}]
                         })

[3] inpage/provider    : intercept; assign requestId;
                         window.postMessage({source:'ext-inpage',
                           type:'rpc', id, method, params}); return pending Promise

[4] content/index      : receive postMessage; chrome.runtime.sendMessage(
                           {type:'rpc-request', id, method, params})
                         (origin verified via sender.tab.url in background)

[5] background/index   : route by method
   - eth_requestAccounts -> wallet.address (or [] if locked)
   - eth_chainId         -> 0G chain id
   - eth_sendTransaction -> pipeline (below)
   - eth_call/eth_estimateGas/eth_blockNumber/etc (read) -> forward to rpc client
   - any other write method (personal_sign, eth_sign, eth_signTypedData_v4,
     wallet_*, etc.) -> reject with code 4200 (unsupported method). v1 only
     supports eth_sendTransaction signing. If EvoEvo turns out to need
     personal_sign for a memory flow, that requires a separate spec.

   pipeline (eth_sendTransaction):
     a. populate nonce via rpc.getTransactionCount(from, 'pending'),
        gas via rpc.gasPrice (or feeData) - do not trust EvoEvo-provided values
     b. build WalletRequest from tx params:
          origin              = sender.tab.url origin (verified)
          chain               = '0G'
          contract            = params.to (lower-case)
          estimatedFeeNative  = gasLimit * gasPrice / 1e18
          hasSevereWarning    = false
          actionFingerprint   = data.slice(0, 10)   // function selector
          rawText             = null
     c. guard.evaluateWalletRequest(request, config)
     d. if decision.status !== 'approve' OR config.dryRun:
          - log AttemptLog with status dry_run | manual_review | rejected
          - reject Promise with EIP-1193 code 4001 (user rejected request)
          - signal automation.pause()
          - do NOT sign
     e. otherwise:
          - wallet.signTransaction(populated tx)
          - rpc.sendRawTransaction(signed) -> txHash
          - log AttemptLog with status signed and txHash
          - resolve Promise with txHash

[6] inpage/provider    : Promise resolves; EvoEvo continues its UI flow

[7] content/automation : on resolve (or reject), continue loop:
                         next button -> or SHOW MORE -> or done
```

### Design choices in the pipeline

- **`actionFingerprint` = function selector** (first 4 bytes of `data`). Strictly stronger than the current `"unknown-signature-from-evoevo"` string. Config adds `allowedFunctionSelectors: string[]` (lower-case `0x` + 8 hex). Guard rejects on mismatch.
- **`data` and `value` checks added to guard**: `data` length >= 4 (must have a selector); `value` must equal `0n`. EvoEvo memory calls never transfer native value.
- **Nonce + gas fetched by background**, not taken from EvoEvo. Replay or front-run attempts via a poisoned `from`/`nonce` field cannot succeed.
- **Origin verification uses `sender.tab.url`**, not a content-script-supplied field. Background reads `chrome.runtime.onMessage` sender object and computes origin server-side (extension-side).
- **Rejection code is always 4001** to EvoEvo (standard "user rejected"). Detailed reason stays in the extension log + popup; it is not leaked to the page.
- **EIP-6963 announcement**: inpage also dispatches `eip6963:announceProvider` so EvoEvo can pick the right provider if it supports the standard. Otherwise the user disables Rabby on `evoevo.ai` (documented in README).

## Components

### Repository layout

```
auto-evoevo-extension/
+-- manifest.json
+-- src/
|   +-- inpage/
|   |   +-- provider.ts
|   +-- content/
|   |   +-- index.ts
|   |   +-- automation.ts
|   +-- background/
|   |   +-- index.ts
|   |   +-- wallet.ts
|   |   +-- rpc.ts
|   |   +-- pipeline.ts
|   |   +-- guard.ts
|   |   +-- storage.ts
|   |   +-- session-log.ts
|   +-- ui/
|   |   +-- popup.html
|   |   +-- popup.ts
|   |   +-- options.html
|   |   +-- options.ts
|   +-- shared/
|   |   +-- messages.ts
|   |   +-- types.ts
|   |   +-- crypto.ts
|   +-- config/
|       +-- defaults.ts
+-- tests/
|   +-- fixtures/
|   |   +-- chrome-api.ts
|   |   +-- dom/feed.html
|   |   +-- tx-samples.json
|   +-- guard.test.ts
|   +-- crypto.test.ts
|   +-- wallet.test.ts
|   +-- rpc.test.ts
|   +-- messages.test.ts
|   +-- pipeline.test.ts
|   +-- automation.test.ts
+-- vitest.config.ts
+-- tsconfig.json
+-- package.json
```

The existing repository keeps the Playwright runner intact under `src/`. The extension is a sibling package directory at the repo root so both implementations can coexist while the extension is validated.

### Module responsibilities

| Module | Job | Depends on |
| --- | --- | --- |
| `inpage/provider.ts` | EIP-1193: `request`, `on`/`removeListener`, events `connect`/`accountsChanged`/`chainChanged`. Forwards every RPC via `window.postMessage`. Dispatches EIP-6963 announce. | — (main world) |
| `content/index.ts` | Inject `inpage/provider.ts` at `document_start`; relay `window.postMessage` <-> `chrome.runtime.sendMessage`. | `chrome.runtime` |
| `content/automation.ts` | State machine that finds, marks, and clicks ADD TO MEMORY buttons; clicks SHOW MORE; idle-strike stop after 2 unproductive expansions. Pauses on rejected RPC. | DOM only |
| `background/index.ts` | Service-worker entry. Message router. Restores in-flight state from `chrome.storage.session` on wake. | `messages`, `pipeline`, `wallet` |
| `background/wallet.ts` | Holds `Wallet | null` in memory. `unlock(password)` decrypts vault. `lock()` clears. `signTransaction(tx)` rejects when locked. Idle-lock timer (configurable, default 30 min). | `crypto`, `storage` |
| `background/pipeline.ts` | Receives `eth_sendTransaction`; populates nonce/gas; builds `WalletRequest`; calls guard; signs; broadcasts; appends log. Pure function shape with injected deps so tests use fakes. | `wallet`, `rpc`, `guard`, `session-log` |
| `background/guard.ts` | Port of `src/guard.ts` plus new checks: `value == 0n`, `data.length >= 4`, function selector whitelist. | `shared/types` |
| `background/rpc.ts` | Methods used: `eth_call`, `eth_chainId`, `eth_gasPrice` (or `eth_feeHistory`), `eth_getTransactionCount`, `eth_sendRawTransaction`, `eth_getTransactionReceipt`. Retry with backoff for 5xx/timeout. Nonce-too-low triggers one refetch+retry. | `fetch` |
| `background/storage.ts` | `getVault`/`setVault`, `getConfig`/`setConfig`, `appendLog`. Schema-validated via zod. | `chrome.storage.local` + `.session` |
| `background/session-log.ts` | Append `AttemptLog` entries; cap and rotate (1000 entries max). Maintain badge text/color. Export JSONL. | `storage` |
| `shared/crypto.ts` | AES-GCM 256; PBKDF2 from password (>= 250k iterations, SHA-256). Vault `{salt, iv, ciphertext, version}`. | Web Crypto API |
| `shared/messages.ts` | Discriminated union with zod schemas for every message: `rpc-request`, `rpc-response`, `unlock`, `lock`, `get-status`, `pause`, `resume`, `start`, `stop`, `import-key`, `set-config`, `export-log`. Background parses on receive; invalid -> ignore + log warning. | `zod` |
| `shared/types.ts` | Port of `src/types.ts`. Two additions to `AttemptLog`: `txHash: string | null`, and the `AttemptStatus` union expands with `"rejected" \| "rejected_origin" \| "rpc_failed" \| "reverted"` so log queries stay granular instead of collapsing everything into `"failed"`. | — |
| `ui/popup.ts` | Locked: unlock form. Unlocked: start/stop, badge counts, current pause reason, recent log entries, export. | — |
| `ui/options.ts` | Edit config (whitelist contracts, function selectors, fee cap, RPC URL, chain id, idle-lock minutes). Import private key (one-time wizard). | — |

### Module boundaries

- The private key never leaves `background/wallet.ts`. Popup calls `unlock(password)` and receives only `{ok, address}`.
- `shared/types.ts` is the only contract shared across guard, pipeline, and UI. UI never imports `background/*`.
- `shared/messages.ts` is the only contract between execution contexts. Shape changes happen in one place; zod parse failure crashes early instead of silently.

## Error handling, pause/resume, edge cases

### Automation state machine (content/automation.ts)

```
       +--------+
   +-->|  idle  |
   |   +---+----+
   |       | found button
   |       v
   |   +----------+
   |   | clicking |--- DOM detached / click failure ---+
   |   +---+------+                                    |
   |       v                                           |
   |   +-------------+                                 |
   |   | waiting-tx  |--- timeout / RPC error ---------+
   |   +---+---------+                                 |
   |       | resolved (txHash) | rejected (4001)       |
   |       v                                           |
   |   +---------+                                     |
   +---| post-tx |                                     |
       +---+-----+                                     |
           | no buttons + SHOW MORE failed 2x          |
           | OR guard rejection / error                v
           v                                     +----------+
       +------+                                  |  paused  |
       | done |                                  +-----+----+
       +------+                                        |
           ^                                resume from popup
           +-----------------------------------------+ 
```

Pause (not stop) is the default for any non-approve guard result, mirroring the current `runner.ts:79-82` behavior. Difference: user can resume from the popup without restarting the session.

### Error -> behavior table

| Situation | Detected in | Behavior |
| --- | --- | --- |
| Vault locked when `eth_sendTransaction` arrives | `wallet.ts` | Reject 4100 (unauthorized). Background calls `chrome.action.openPopup()` to prompt unlock. Automation pauses. |
| Origin not `https://evoevo.ai` | `pipeline.ts` (verifies `sender.tab.url`) | Reject 4001; log `status:'rejected_origin'`. Manifest already scopes content scripts to `https://evoevo.ai/*`, so this is defense-in-depth. |
| Guard `reject` | `pipeline.ts` | Reject 4001; log with full reason; automation pause. |
| Guard `needs_manual_review` | `pipeline.ts` | Same as reject but status `manual_review`. |
| `data` length < 4 or `value > 0n` | guard | Reject. |
| Function selector not whitelisted | guard | Reject. |
| `gasLimit * gasPrice / 1e18 > maxFeeNative` | guard | Reject. |
| RPC 5xx / network timeout | `rpc.ts` | Retry 3x, backoff 500/1500/4500 ms. Then throw -> pipeline logs `rpc_failed`, automation pause. |
| Nonce too low | `rpc.ts` on broadcast | Refetch pending nonce, retry once. Still fails -> pause. |
| Tab closed mid-flow | content/automation | Background sees disconnect; if not yet broadcast, abandon. Already-broadcast tx remains on chain. |
| Service worker killed mid-pipeline before broadcast | MV3 nature | Pending Promise to the page times out. Background restart finds no `inflight` entry to replay (entry is written only after broadcast). |
| Service worker killed after broadcast | MV3 nature | `inflight` entry exists in `chrome.storage.session` keyed by `{nonce, dataHash}`. On wake, background polls `getTransactionReceipt` to reconcile and log result. |
| User restarts Chrome | — | Vault locked; automation off. Expected. |
| Wrong password | `wallet.ts` | AES-GCM decrypt throws -> `{ok:false}`. No backoff (local trust). |
| Tx reverts on-chain | `rpc.ts` (optional receipt poll) | Log `status:'reverted'` with revert reason; automation pause. |

### Idempotency

- `data-auto-evoevo-attempted-id` marker prevents re-clicking the same button (already in `controller.ts:5`).
- `inflight` entry in `chrome.storage.session` is keyed by `(nonce, keccak(data))`. If background wakes and sees a matching entry without a logged receipt, it polls receipt instead of re-signing.

### Logging

- Entry shape: `AttemptLog` from `src/types.ts:44-53` with the type changes noted in the Components table (added `txHash` field, expanded status union).
- Storage: `chrome.storage.local` under `logs:<sessionId>`. Array capped at 1000 with FIFO rotation.
- Export: popup "Export JSONL" downloads `session-<id>.jsonl`, same format as `SessionLogger.filePath` content today, so any downstream tooling stays compatible.
- Badge: `chrome.action.setBadgeText` shows current-session `signed` count. Color red when paused.

## Testing strategy

### Principles

- Tests target module boundaries; internals can change without breaking tests.
- No real-browser tests in CI. Only manual smoke tests on Chrome.
- Vitest config mirrors the existing repo (`vitest.config.ts`).

### Pyramid

- **Unit** (most): `guard`, `crypto`, `wallet`, `rpc`, `messages`.
- **Integration**: `pipeline` (with fake wallet/rpc/guard), `automation` (with DOM fixture).
- **Manual smoke**: dry-run, then a single real signed tx on 0G testnet.

### Test inventory

**`guard.test.ts`** — port `tests/guard.test.ts` unchanged. Add:

- `data.length < 4` -> reject.
- `value > 0n` -> reject.
- Function selector not whitelisted -> reject.
- All checks pass -> approve.

**`crypto.test.ts`**

- Encrypt-then-decrypt round-trip with correct password returns plaintext.
- Wrong password throws.
- Same `(plaintext, password)` produces different ciphertexts across runs (random IV).

**`wallet.test.ts`**

- `signTransaction` before unlock throws "locked".
- Unlock with correct password yields the expected address.
- Unlock with wrong password returns `{ok:false}` and leaves state locked.
- Idle-lock fires after configured timeout (fake timers).

**`rpc.test.ts`**

- Happy path: `sendRawTransaction` returns txHash.
- Two 5xx then 200 -> retry succeeds.
- Three 5xx -> throws.
- `nonce too low` -> refetch nonce, retry once.

**`messages.test.ts`**

- Each message type parses a valid payload.
- Missing or mistyped field throws zod error.

**`pipeline.test.ts`** (focus area)

- Fake wallet + fake rpc + fake guard.
- Guard approve, dryRun false -> `wallet.sign` called, `rpc.sendRawTransaction` called, log `signed`.
- Guard reject -> sign NOT called, log `rejected`, Promise rejects with 4001.
- Guard `manual_review` -> same; log `manual_review`.
- Guard approve, dryRun true -> sign NOT called, log `dry_run`.
- Origin mismatch in sender -> reject before guard runs.
- Nonce conflict -> refetch + retry path.

**`automation.test.ts`**

- DOM fixture with 3 ADD TO MEMORY buttons.
- Loop clicks each, waits, advances.
- 2nd button receives 4001 -> automation pauses; 3rd button not clicked.
- After all attempted, SHOW MORE 2 unproductive expansions -> done.
- Buttons marked with `data-auto-evoevo-attempted-id` are skipped.

### Manual smoke checklist

1. Load unpacked at `chrome://extensions`. No load errors.
2. Open popup; import burner 0G key; unlock.
3. Disable Rabby on `evoevo.ai` (or rely on EIP-6963 picker if EvoEvo supports it).
4. Dry-run ON: Start; observe log entries `dry_run`, no on-chain tx, SHOW MORE eventually fires.
5. Dry-run OFF, one card: tx visible on 0G explorer with expected `to`, fee under cap.
6. Force `maxFeeNative` too low: click -> guard reject -> popup shows reason -> automation paused.

## Open questions to confirm during implementation

- 0G chain id (mainnet vs testnet) and RPC URL. To copy from the user's existing Rabby network config rather than guess.
- Whether 0G supports EIP-1559. If yes, use `maxFeePerGas`/`maxPriorityFeePerGas`; if no, legacy `gasPrice`.
- Whether EvoEvo dispatches EIP-6963 wallet discovery. Verify by inspecting the page; if not, README instructs disabling Rabby on this site.
- The exact function selector(s) EvoEvo calls. Capture from a real successful transaction (block explorer "Input Data" field) and seed `allowedFunctionSelectors`.

## Acceptance criteria

- Extension loads in Chrome MV3 without errors.
- With dry-run ON, automation walks the feed end-to-end (clicks ADD TO MEMORY on every card, fires SHOW MORE, stops on 2 idle expansions) and produces JSONL log entries compatible with the current `SessionLogger` shape, extended with `txHash` and the additional status values listed in the Components table.
- With dry-run OFF and one whitelisted function selector configured, every approved tx is signed and broadcast to 0G; non-approve outcomes pause automation and never sign.
- Guard reuses `src/guard.ts` logic; behaviorally equivalent on the same `WalletRequest` inputs.
- No private-key material is ever sent to any context other than `background/wallet.ts`; vault at rest is AES-GCM-encrypted.
- All unit and integration tests pass under `vitest run`.
