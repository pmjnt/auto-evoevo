# Auto EvoEvo Runner Design

Date: 2026-05-21

## Goal

Build a local automation tool that processes EvoEvo feed items end to end:

- Click every available `ADD TO MEMORY` button one at a time.
- Wait for the Rabby Wallet signature popup.
- Sign only transactions that pass strict guardrails.
- Continue through the feed by clicking `SHOW MORE` when needed.
- Stop only when there are no remaining `ADD TO MEMORY` buttons and no more feed items to load.

The tool is intentionally not a blind clicker. It may run without a fixed item limit, but it must pause instead of signing when a wallet request does not match the expected EvoEvo memory-add transaction.

## Corrected Architecture

The automation should be a single local Playwright/CDP runner using the user's real Chrome profile.

This replaces the earlier, less precise "Chrome extension/userscript" framing. A Chrome extension or userscript can automate the EvoEvo page, but it cannot directly inspect or click the Rabby `Sign` button because Rabby runs inside another Chrome extension context. Playwright/CDP or desktop automation is required to control the Rabby popup.

Recommended architecture:

```text
Local Playwright/CDP runner
  -> attach to or launch Chrome with the user's existing profile
  -> control the EvoEvo feed page
  -> detect the Rabby Wallet popup
  -> validate chain, contract, fee, warnings, and action/payload where available
  -> click Sign only after validation passes
  -> return to EvoEvo and continue until the feed is exhausted
```

## Components

### EvoEvo Page Controller

Responsibilities:

- Open or attach to `https://evoevo.ai/feed`.
- Confirm the active page is on `evoevo.ai`.
- Find visible, enabled `ADD TO MEMORY` buttons.
- Click one memory button at a time.
- Wait for the submitting/on-chain state after each click.
- Wait for completion, failure, or wallet popup handling result.
- Mark each attempted card in memory so the runner does not loop on the same failed element.
- Click `SHOW MORE` when no visible memory buttons remain.
- Stop when no memory buttons are available and `SHOW MORE` is unavailable or does not load new cards.

### Rabby Wallet Signer

Responsibilities:

- Detect the Rabby Wallet Notification popup/window.
- Verify the requesting site is `https://evoevo.ai`.
- Read chain, contract, fee, warnings, and available transaction details from the popup.
- Open or inspect raw details when needed and available.
- Click `Sign` only when the guard engine returns `approve`.
- Pause and report the exact reason when the guard engine returns `reject` or `needs_manual_review`.

### Guard Engine

The guard engine is the only place that decides whether a wallet request can be signed.

Required checks:

- Domain must be EvoEvo: `https://evoevo.ai`.
- Chain must be `0G`.
- Interacted contract must be in an explicit whitelist.
- Action/payload must match the expected "Add to Memory" pattern when the runner can read or infer it.
- Fee/gas estimate must be at or below the configured cap.
- Rabby warnings must not indicate high-risk behavior.

Default behavior for uncertainty:

- Unknown chain: pause.
- Unknown contract: pause.
- Unknown action/payload: pause unless the user explicitly enabled a trusted learned pattern.
- Fee above cap: pause.
- Severe wallet warning: pause.
- Popup cannot be read reliably: pause.

### Logger

Responsibilities:

- Record each attempted feed item.
- Record each wallet request decision.
- Record transaction metadata visible to the runner.
- Record final status: `signed`, `skipped`, `failed`, or `manual_review`.
- Produce a session summary when the run stops.

Suggested log fields:

- Timestamp.
- EvoEvo URL.
- Card identifier, if discoverable.
- Button index or DOM fingerprint.
- Chain.
- Contract.
- Estimated fee.
- Guard decision.
- Failure or pause reason.

## Main Flow

1. User starts the local runner.
2. Runner opens or attaches to Chrome using the configured profile.
3. Runner navigates to or finds the EvoEvo feed page.
4. Runner scans for visible `ADD TO MEMORY` buttons.
5. Runner clicks the next eligible button.
6. Runner waits for Rabby popup.
7. Rabby signer reads the popup and asks the guard engine for a decision.
8. If approved, signer clicks `Sign`.
9. If rejected or uncertain, runner pauses and reports the reason.
10. Runner waits for EvoEvo to settle after signing.
11. Runner logs the result and moves to the next button.
12. If no buttons remain, runner clicks `SHOW MORE`.
13. Runner repeats until no more buttons and no more feed content are available.

## Configuration

Initial config should be a local JSON file or typed config module with:

- EvoEvo base URL.
- Chrome profile path.
- Rabby extension identification strategy.
- Allowed chain: `0G`.
- Allowed EvoEvo contract addresses.
- Max allowed fee/gas.
- Optional learned action/payload pattern.
- Timeouts for page load, popup detection, signing, and feed expansion.
- Kill-switch hotkey or terminal interrupt behavior.

## Safety Behavior

The runner may continue without a fixed quota, but it must still be conservative about signing.

Hard pause cases:

- Wallet request is not from EvoEvo.
- Chain is not `0G`.
- Contract is not whitelisted.
- Fee/gas exceeds the configured cap.
- Popup contains severe warnings.
- Rabby popup cannot be inspected.
- Transaction details differ from the expected memory-add pattern.

The pause screen or terminal output must explain what failed and leave the browser state untouched for manual review.

## Testing Strategy

Use layered tests where possible:

- Unit tests for guard decisions using captured sample wallet metadata.
- Selector tests for EvoEvo page button discovery against saved HTML snapshots.
- Dry-run mode that clicks no wallet buttons and reports what would be signed.
- Manual smoke test on a low-risk account before enabling guarded auto-sign.

## Out of Scope

- Bypassing wallet security prompts.
- Signing unknown contracts or unknown chains.
- Managing private keys directly.
- Running as a hosted service.
- Guaranteeing compatibility with arbitrary wallet extensions.

## Open Implementation Notes

- The first implementation should prefer Playwright with a persistent Chrome profile.
- If direct popup DOM access is unreliable, the fallback may use Chrome DevTools target discovery plus robust visible-text checks.
- Coordinate-based clicking should be the last resort and only after guard checks pass.
- The first valid transaction should be captured in dry-run mode to define or verify the action/payload pattern.
