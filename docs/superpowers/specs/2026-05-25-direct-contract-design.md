# Direct-Contract Mode Design

Date: 2026-05-25
Branch: `experiment/direct-contract`

## Goal

Replace the current DOM-click + window.ethereum interception loop with a direct API → contract call loop. Skip EvoEvo's frontend entirely. Extension talks to EvoEvo's backend REST API for opinions and the on-chain payload, then signs + broadcasts itself.

This eliminates:
- Reliance on a connected EvoEvo tab (no more "must keep tab open")
- Race conditions with EvoEvo's UI ("Submitting on-chain..." modal)
- Need to coexist with Rabby / Reown wallet picker
- DOM scraping fragility (ADD TO MEMORY button selector, SHOW MORE expansion, etc.)

The trade-off is documented in [Risks](#risks).

## Inputs (reverse-engineered from a real session HAR + sample tx decode)

### EvoEvo REST API

Base: `https://api.evoevo.ai`

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `POST /v1/auth/nonce` | none | `{address}` → `{message, nonce, expires_at}`. The `message` is an EIP-4361 (SIWE) statement we'll sign. |
| `POST /v1/auth/login` | none | `{address, nonce, signature}` → `{token, expires_at}`. `token` is a JWT, 24h expiry. |
| `GET /v1/agents?wallet_address={addr}&chain_id={chainId}` | Bearer | Returns array of the user's agents. We pick the first (or configurable) agent. Need `id` and `onchain_identity.identity_agent_id` (used as on-chain `tokenId`). |
| `GET /v1/platform/feeding?tab=recommended&limit=20&chain_id={chainId}&agent_id={agentId}&include_intaken=false` | Bearer | Returns array of opinions available for the agent to consume. Each opinion has an `id` (== `opinion_id`). |
| `POST /v1/agents/{agentId}/memories/from-opinion` | Bearer | `{opinion_id}` → `{reasoning_intake_with_sig: {token_id, source_opinion_id, reasoning_hash, opinion_hash, new_memory_root, nonce, deadline, signature, ...}}`. Backend constructs and signs the on-chain payload that the user then submits. |

> Note: HAR capture did not surface the `Authorization` header in any inspected request, but the login endpoint clearly returns a JWT. This is the standard `Authorization: Bearer <token>` pattern after SIWE. We will assume that and validate at runtime — if 401, fall back gracefully and log an actionable error.

### On-chain call

- Contract: `0x61bb71442749d13a4BB7257DfBFFf0452ae937f9` on chain `16661`
- Function: `intakeReasoning(uint256 tokenId, uint256 sourceOpinionId, bytes32 reasoningHash, bytes32 opinionHash, bytes32 newMemoryRoot, uint256 nonce, uint256 deadline, bytes signature)`
- Selector: `0x4ed1f275` (verified `keccak256(sig).slice(0, 10)`)
- Verified by decoding the user-supplied sample tx `0x7649177a...`: all args matched the API response field-for-field.

The contract verifies the backend's `signature` against `msg.sender` (which is `updater` in the API response). So:
- Backend signs a payload tied to `updater = burner address`
- User must broadcast from the burner address (matches `msg.sender`)
- Contract accepts

## Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│ One-time auth (per session)                                         │
│                                                                     │
│ POST /v1/auth/nonce {address}                                       │
│      ↓ {message, nonce}                                             │
│ wallet.signMessage(message)                                         │
│      ↓ signature                                                    │
│ POST /v1/auth/login {address, nonce, signature}                     │
│      ↓ {token, expires_at}                                          │
│ Store token in background's memory (NOT chrome.storage)             │
│ Schedule re-auth before expires_at                                  │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Identify agent (once per session)                                   │
│                                                                     │
│ GET /v1/agents?wallet_address={addr}&chain_id={chainId}             │
│      ↓ first agent's `id` (e.g. 8359) and                           │
│        `onchain_identity.identity_agent_id` (e.g. "4644")           │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Main loop                                                           │
│                                                                     │
│ while not stopped:                                                  │
│   GET /v1/platform/feeding?tab=recommended&limit=20&chain_id=...    │
│                            &agent_id={agentId}&include_intaken=false│
│        ↓ array of opinions                                          │
│   if empty → emit "done", break                                     │
│   if remaining <= stopAtRemaining → emit "done", break              │
│                                                                     │
│   for each opinion in array:                                        │
│     POST /v1/agents/{agentId}/memories/from-opinion {opinion_id}    │
│          ↓ {reasoning_intake_with_sig}                              │
│     data = selector + abi.encode(tokenId, sourceOpinionId,          │
│              reasoningHash, opinionHash, newMemoryRoot,             │
│              nonce, deadline, signature)                            │
│     nonce  = await rpc.getTransactionCount(addr, "pending")         │
│     gas    = await rpc.estimateGas({to, data, from})                │
│     price  = await rpc.gasPrice()                                   │
│     guard  = evaluateWalletRequest({origin, chain, contract, ...},  │
│                                    config)                          │
│     if guard != approve → log + pause                               │
│     signed = wallet.sign(tx)                                        │
│     hash   = await rpc.sendRawTransactionWithNonceRetry(signed)     │
│     receipt = await rpc.waitForReceipt(hash)                        │
│     if receipt.status != success → log "reverted" + pause           │
│     log "signed" + counters++                                       │
│     await sleep(cooldownMs)                                         │
└─────────────────────────────────────────────────────────────────────┘
```

## Architecture changes

| | Current (DOM-click mode) | Direct mode |
| --- | --- | --- |
| Loop location | `extension/src/content/automation.ts` (runs in evoevo.ai tab) | `extension/src/background/direct-runner.ts` (runs in service worker) |
| Wallet provider injection | `extension/src/inpage/provider.ts` proxies window.ethereum | Not used in direct mode |
| Tab required? | Yes — evoevo.ai tab must be open and visible (or use silent-audio trick) | No tab needed at all |
| Guard checks per tx | Yes (origin / chain / contract / value / selector / fee cap) | Same guard, same fields. Origin = "https://api.evoevo.ai" |
| Sign + broadcast | Existing `pipeline.ts` | Reuse `pipeline.ts` (refactored to accept pre-built tx params instead of parsing from window.ethereum params) |
| Session log | Existing `session-log.ts` | Same — every attempt produces an AttemptLog |
| UI | popup shows Signed/Dry-run/Manual/Rejected counters + Start/Pause | Same UI, same counters. Adds "Mode" toggle in Options. |

## New files

```
extension/src/background/
├── direct-runner.ts          # The new loop. Reads config + token, calls API, builds tx, calls pipeline.
├── evoevo-api.ts             # Thin REST client. nonce/login/agents/feeding/from-opinion. Manages JWT.
├── intake-encoder.ts         # Encodes intakeReasoning(...) call into tx.data using ethers.AbiCoder.
└── siwe.ts                   # Tiny helper that owns nonce → sign → login → token refresh.

extension/src/shared/
└── direct-types.ts           # API response types (Opinion, ReasoningIntake, AuthToken, etc.)

extension/tests/
├── evoevo-api.test.ts        # fetch mock; verifies request shape + auth header
├── intake-encoder.test.ts    # encodes known sample → matches the decoded tx data from sample tx
├── siwe.test.ts              # nonce → sign → login round-trip with fake wallet
└── direct-runner.test.ts     # integration: fake api + fake wallet + fake rpc → end-to-end one iteration
```

## Modified files

- `extension/src/shared/types.ts` — add `runMode: "dom" | "direct"` to `ExtensionConfig`. Default `"dom"` so existing setups don't change behavior unannounced.
- `extension/src/shared/messages.ts` + `extension/src/background/storage.ts` — add `runMode` to set-config schemas.
- `extension/src/background/index.ts` — on `start`/`resume`: branch on `runMode`. dom mode → existing tab broadcast. direct mode → call `runDirect()` in SW directly, no tab needed.
- `extension/src/ui/options.html` + `extension/src/ui/options.ts` — add Mode select (dom | direct).
- `extension/src/ui/popup.html` + `extension/src/ui/popup.ts` — show the active mode in status panel; Start/Pause still work, no UI flow change.
- `extension/README.md` — document direct mode setup and trade-offs.

## Reuse boundaries

- Guard: `background/guard.ts` is unchanged. `WalletRequest` shape stays the same; direct mode populates the same fields.
- Pipeline: `background/pipeline.ts` is mostly unchanged. We add a thin entry point that accepts already-decoded `{to, data, value}` instead of parsing from `params`. Could refactor `runPipeline` to extract that decode step into a separate helper that both modes call.
- RPC: `background/rpc.ts` unchanged. Direct mode just calls `RpcClient` methods directly.
- Session log: unchanged.
- Wallet: unchanged. Direct mode also needs `wallet.signMessage(message)` for SIWE — add that method.

## Error handling

| Failure | Behavior |
| --- | --- |
| Auth nonce call 4xx/5xx | Log `rpc_failed`, pause, surface "EvoEvo auth nonce failed" in popup |
| `wallet.signMessage` rejected (wallet locked) | Pause with "Wallet locked" |
| Auth login 401 | Token rejected. Re-run SIWE once; if still 401, pause with "Auth failed" |
| Agents list returns `[]` | Pause with "No agent for this wallet on this chain" |
| Feeding returns `[]` | Emit `done` (no more to process) |
| `from-opinion` 4xx (e.g. opinion no longer available) | Log `skipped` for this opinion, continue loop |
| Guard reject on built request | Same as today — log + pause |
| RPC broadcast fail | Same as today |
| Receipt timeout / reverted | Same as today — pause, log details |

## Stop conditions

- User clicks Pause
- `feeding` returns empty
- `feeding` returns ≤ `stopAtRemaining` items
- Auth token cannot be refreshed
- Any non-recoverable error

## Risks (please re-read before merging)

1. **EvoEvo ToS violation.** Most dApps' ToS forbid automated mass interactions. By going around the frontend entirely we make detection harder for them, but the legal risk to you is real. Use a burner wallet you can afford to lose. Not legal advice.
2. **API drift.** If EvoEvo changes any of these endpoints (rename, add required field, restructure response), the loop breaks. Maintenance burden is high — every EvoEvo deploy could potentially require a patch here.
3. **Contract drift.** If EvoEvo upgrades the contract (new ABI, new args, new signature scheme), `intakeReasoning(...)` may stop being the right function. We pin the selector + ABI in code; an upgrade would require a code change.
4. **Backend rate limiting.** EvoEvo can rate-limit by IP, wallet address, or pattern (sequential opinions in <1s, etc.). We mitigate with the existing `cooldownSeconds`.
5. **Detection by header fingerprint.** EvoEvo can see we don't have `sec-ch-ua` matching real Chrome, no `Origin: https://evoevo.ai`, etc. Mitigation: send headers that match a real browser session. Implemented in `evoevo-api.ts`.
6. **Receipt wait still required.** We keep the receipt poll because mempool backpressure is independent of which client submits. cooldown can usually be 0 in direct mode since there's no UI to race against.

## Implementation plan (subsequent tasks)

This spec is the design only. Implementation follows in order:

1. **Task D1** — siwe.ts + tests (auth flow, no network)
2. **Task D2** — evoevo-api.ts + tests (REST client, fetch mocked)
3. **Task D3** — intake-encoder.ts + tests (verify encoded data matches the user-supplied sample tx byte-for-byte)
4. **Task D4** — direct-runner.ts + tests (loop, with fake API + fake wallet + fake rpc)
5. **Task D5** — wire into background/index.ts behind `runMode === "direct"` config flag
6. **Task D6** — Options UI: Mode select
7. **Task D7** — README updates + manual smoke

Each task is its own commit. Branch stays as `experiment/direct-contract` until manual smoke passes.

## Acceptance criteria

- With `runMode: "direct"`, the user does NOT need to keep an evoevo.ai tab open. They click Start in the popup; the loop runs in the service worker.
- Auto-signed txs appear on 0G explorer from the burner address with the expected `to` and `data` shape.
- Counters in popup tick the same as DOM mode (`signed`, `manual`, `rejected`, etc.).
- Pause stops the loop within ~1 cycle.
- Toggling Mode back to `"dom"` restores the existing tab-based behavior with no other config changes.
- Existing 61 unit tests still pass; new tests for D1–D4 pass.

## Open questions to validate during implementation

- The HAR did not include an `Authorization` header. First implementation should try `Authorization: Bearer <token>`; if 401, try `X-EvoEvo-Token` or similar. Capture another HAR with auth visible if needed.
- Pagination of `/v1/platform/feeding` — the response array has 20 items; need to verify whether there is a cursor / page param to fetch more, or whether a new GET refreshes the list as items get marked intaken.
- Whether `selected_agent_has_intaken: false` is enforced server-side (request reuses already-intaken opinion → does backend reject, or does it silently re-sign?).
- Whether the `agent_id` in the URL path of `/v1/agents/{agentId}/memories/from-opinion` is verified against the JWT's owner. If yes, attacker can't intake into someone else's agent. (Implementation assumes yes.)
