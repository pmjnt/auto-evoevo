# Post-Receipt Cooldown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the existing `cooldownSeconds` delay to after a successful transaction receipt.

**Architecture:** Keep the config surface unchanged. Adjust `submitIntake` so successful submissions log `signed`, then sleep before returning `{ kind: "approved" }`; all non-success outcomes keep their current behavior.

**Tech Stack:** TypeScript, Vitest, Chrome extension background worker.

---

### Task 1: Move Cooldown To Post-Receipt Success

**Files:**
- Modify: `extension/src/background/intake-submitter.ts`
- Test: `extension/tests/intake-submitter.test.ts`

- [ ] **Step 1: Write the failing test**

Add a test that calls `submitIntake` with `cooldownSeconds: 2` and a fake `sleep`, then asserts sleep is called after receipt success and before the function returns.

- [ ] **Step 2: Run focused test to verify it fails**

Run: `npm test -- intake-submitter`

Expected: FAIL because the sleep currently happens before signing/broadcast, not after receipt success.

- [ ] **Step 3: Write minimal implementation**

Remove the pre-sign cooldown block from `submitIntake`. Add the same sleep after the `signed` log append and before returning the approved outcome.

- [ ] **Step 4: Run focused test to verify it passes**

Run: `npm test -- intake-submitter`

Expected: PASS.

- [ ] **Step 5: Run full verification**

Run:

```bash
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: all commands pass.

- [ ] **Step 6: Commit**

```bash
git add extension/src/background/intake-submitter.ts extension/tests/intake-submitter.test.ts docs/superpowers/specs/2026-06-20-post-receipt-cooldown-design.md docs/superpowers/plans/2026-06-20-post-receipt-cooldown.md
git commit -m "fix(extension): cooldown after confirmed intake tx"
```
