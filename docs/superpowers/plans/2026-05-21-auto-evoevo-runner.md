# Auto EvoEvo Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local Playwright/CDP runner that clicks EvoEvo `ADD TO MEMORY`, validates Rabby wallet requests, signs only approved requests, clicks `SHOW MORE`, and stops when the feed is exhausted.

**Architecture:** Create a TypeScript Node CLI with focused modules: config loading, guard decisions, Rabby popup parsing/signing, EvoEvo page control, structured logging, and orchestration. The runner uses a persistent Chrome profile and starts in `dryRun` mode so wallet signing cannot happen until explicitly enabled in config.

**Tech Stack:** Node.js, TypeScript, Playwright, Vitest, tsx, zod.

---

## File Structure

- `package.json`: npm scripts and dependencies.
- `tsconfig.json`: strict TypeScript config.
- `vitest.config.ts`: unit test config.
- `.gitignore`: ignores dependencies, build output, logs, and local config.
- `config.example.json`: safe template config.
- `src/config.ts`: loads and validates config.
- `src/types.ts`: shared domain types.
- `src/guard.ts`: pure guard engine.
- `src/rabby/parse.ts`: pure parser for Rabby visible text.
- `src/rabby/signer.ts`: Playwright popup reader and `Sign` clicker.
- `src/evoevo/controller.ts`: Playwright page controller for feed buttons and `SHOW MORE`.
- `src/logger.ts`: JSONL session logger and summary counters.
- `src/runner.ts`: orchestration loop.
- `src/index.ts`: CLI entrypoint.
- `tests/guard.test.ts`: guard unit tests.
- `tests/rabby-parse.test.ts`: Rabby parser unit tests.
- `tests/logger.test.ts`: logger unit tests.

---

### Task 1: Scaffold TypeScript Project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `config.example.json`

- [ ] **Step 1: Create npm package metadata**

Create `package.json`:

```json
{
  "name": "auto-evoevo-runner",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "start": "tsx src/index.ts",
    "dry-run": "tsx src/index.ts --dry-run"
  },
  "dependencies": {
    "playwright": "^1.44.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^20.14.2",
    "tsx": "^4.15.7",
    "typescript": "^5.4.5",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 2: Add TypeScript config**

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "types": ["node", "vitest/globals"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts", "vitest.config.ts"]
}
```

- [ ] **Step 3: Add Vitest config**

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"]
  }
});
```

- [ ] **Step 4: Add ignore rules**

Create `.gitignore`:

```gitignore
node_modules/
dist/
logs/
config.local.json
playwright-report/
test-results/
```

- [ ] **Step 5: Add safe config template**

Create `config.example.json`:

```json
{
  "evoevoUrl": "https://evoevo.ai/feed",
  "chromeProfilePath": "C:/Users/pMjn/AppData/Local/Google/Chrome/User Data/Default",
  "allowedOrigin": "https://evoevo.ai",
  "allowedChain": "0G",
  "allowedContracts": ["0x61bb710000000000000000000000000000e937f9"],
  "maxFeeNative": 0.001,
  "allowLearnedActionPattern": false,
  "dryRun": true,
  "timeoutsMs": {
    "pageLoad": 30000,
    "popup": 20000,
    "signing": 30000,
    "feedExpansion": 15000
  },
  "logDir": "logs"
}
```

- [ ] **Step 6: Install dependencies**

Run:

```bash
npm install
```

Expected: `package-lock.json` is created and all dependencies install successfully.

- [ ] **Step 7: Run baseline checks**

Run:

```bash
npm test
npm run typecheck
```

Expected: `npm test` reports no test files or exits successfully depending on Vitest behavior; `npm run typecheck` succeeds once source files exist in later tasks.

- [ ] **Step 8: Commit scaffold**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore config.example.json
git commit -m "chore: scaffold TypeScript runner"
```

---

### Task 2: Config and Shared Types

**Files:**
- Create: `src/types.ts`
- Create: `src/config.ts`

- [ ] **Step 1: Write shared domain types**

Create `src/types.ts`:

```ts
export type GuardStatus = "approve" | "reject" | "needs_manual_review";

export type WalletRequest = {
  origin: string | null;
  chain: string | null;
  contract: string | null;
  estimatedFeeNative: number | null;
  hasSevereWarning: boolean;
  actionFingerprint: string | null;
  rawText: string;
};

export type GuardDecision = {
  status: GuardStatus;
  reason: string;
};

export type RunnerConfig = {
  evoevoUrl: string;
  chromeProfilePath: string;
  allowedOrigin: string;
  allowedChain: string;
  allowedContracts: string[];
  maxFeeNative: number;
  allowLearnedActionPattern: boolean;
  dryRun: boolean;
  timeoutsMs: {
    pageLoad: number;
    popup: number;
    signing: number;
    feedExpansion: number;
  };
  logDir: string;
};

export type AttemptStatus = "signed" | "skipped" | "failed" | "manual_review" | "dry_run";

export type AttemptLog = {
  timestamp: string;
  evoevoUrl: string;
  cardLabel: string | null;
  buttonIndex: number;
  walletRequest: WalletRequest | null;
  decision: GuardDecision | null;
  status: AttemptStatus;
  reason: string;
};
```

- [ ] **Step 2: Write config loader**

Create `src/config.ts`:

```ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { RunnerConfig } from "./types.js";

const ConfigSchema = z.object({
  evoevoUrl: z.string().url(),
  chromeProfilePath: z.string().min(1),
  allowedOrigin: z.string().url(),
  allowedChain: z.string().min(1),
  allowedContracts: z.array(z.string().regex(/^0x[a-fA-F0-9]{40}$/)).min(1),
  maxFeeNative: z.number().positive(),
  allowLearnedActionPattern: z.boolean(),
  dryRun: z.boolean(),
  timeoutsMs: z.object({
    pageLoad: z.number().int().positive(),
    popup: z.number().int().positive(),
    signing: z.number().int().positive(),
    feedExpansion: z.number().int().positive()
  }),
  logDir: z.string().min(1)
});

export function loadConfig(configPath = "config.local.json"): RunnerConfig {
  const absolutePath = resolve(configPath);
  const raw = readFileSync(absolutePath, "utf8");
  const parsed = ConfigSchema.parse(JSON.parse(raw));

  return {
    ...parsed,
    allowedContracts: parsed.allowedContracts.map((contract) => contract.toLowerCase())
  };
}
```

- [ ] **Step 3: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit config and types**

```bash
git add src/types.ts src/config.ts
git commit -m "feat: add config and shared runner types"
```

---

### Task 3: Guard Engine

**Files:**
- Create: `src/guard.ts`
- Create: `tests/guard.test.ts`

- [ ] **Step 1: Write failing guard tests**

Create `tests/guard.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { evaluateWalletRequest } from "../src/guard.js";
import type { RunnerConfig, WalletRequest } from "../src/types.js";

const config: RunnerConfig = {
  evoevoUrl: "https://evoevo.ai/feed",
  chromeProfilePath: "C:/Chrome/Profile",
  allowedOrigin: "https://evoevo.ai",
  allowedChain: "0G",
  allowedContracts: ["0x61bb710000000000000000000000000000e937f9"],
  maxFeeNative: 0.001,
  allowLearnedActionPattern: false,
  dryRun: true,
  timeoutsMs: {
    pageLoad: 30000,
    popup: 20000,
    signing: 30000,
    feedExpansion: 15000
  },
  logDir: "logs"
};

function request(overrides: Partial<WalletRequest> = {}): WalletRequest {
  return {
    origin: "https://evoevo.ai",
    chain: "0G",
    contract: "0x61bb710000000000000000000000000000e937f9",
    estimatedFeeNative: 0.0002,
    hasSevereWarning: false,
    actionFingerprint: "add-to-memory",
    rawText: "Simulation Results\nhttps://evoevo.ai\nChain 0G\nSign",
    ...overrides
  };
}

describe("evaluateWalletRequest", () => {
  it("approves a matching EvoEvo memory transaction", () => {
    expect(evaluateWalletRequest(request(), config)).toEqual({
      status: "approve",
      reason: "Wallet request matches EvoEvo memory guardrails"
    });
  });

  it("rejects an unexpected origin", () => {
    expect(evaluateWalletRequest(request({ origin: "https://example.com" }), config)).toEqual({
      status: "reject",
      reason: "Unexpected origin: https://example.com"
    });
  });

  it("requires the 0G chain", () => {
    expect(evaluateWalletRequest(request({ chain: "Ethereum" }), config)).toEqual({
      status: "reject",
      reason: "Unexpected chain: Ethereum"
    });
  });

  it("requires a whitelisted contract", () => {
    expect(evaluateWalletRequest(request({ contract: "0x0000000000000000000000000000000000000001" }), config)).toEqual({
      status: "reject",
      reason: "Contract is not whitelisted: 0x0000000000000000000000000000000000000001"
    });
  });

  it("pauses when the contract is unreadable", () => {
    expect(evaluateWalletRequest(request({ contract: null }), config)).toEqual({
      status: "needs_manual_review",
      reason: "Contract could not be read from wallet popup"
    });
  });

  it("rejects fees above the cap", () => {
    expect(evaluateWalletRequest(request({ estimatedFeeNative: 0.01 }), config)).toEqual({
      status: "reject",
      reason: "Estimated fee 0.01 exceeds cap 0.001"
    });
  });

  it("pauses on severe wallet warnings", () => {
    expect(evaluateWalletRequest(request({ hasSevereWarning: true }), config)).toEqual({
      status: "needs_manual_review",
      reason: "Rabby reported a severe warning"
    });
  });

  it("pauses when action fingerprint is missing", () => {
    expect(evaluateWalletRequest(request({ actionFingerprint: null }), config)).toEqual({
      status: "needs_manual_review",
      reason: "Action fingerprint is unavailable"
    });
  });
});
```

- [ ] **Step 2: Run guard tests to verify failure**

Run:

```bash
npm test -- tests/guard.test.ts
```

Expected: FAIL because `src/guard.ts` does not exist.

- [ ] **Step 3: Implement guard engine**

Create `src/guard.ts`:

```ts
import type { GuardDecision, RunnerConfig, WalletRequest } from "./types.js";

export function evaluateWalletRequest(request: WalletRequest, config: RunnerConfig): GuardDecision {
  if (request.origin !== config.allowedOrigin) {
    return {
      status: request.origin ? "reject" : "needs_manual_review",
      reason: request.origin ? `Unexpected origin: ${request.origin}` : "Origin could not be read from wallet popup"
    };
  }

  if (request.chain !== config.allowedChain) {
    return {
      status: request.chain ? "reject" : "needs_manual_review",
      reason: request.chain ? `Unexpected chain: ${request.chain}` : "Chain could not be read from wallet popup"
    };
  }

  if (!request.contract) {
    return {
      status: "needs_manual_review",
      reason: "Contract could not be read from wallet popup"
    };
  }

  const normalizedContract = request.contract.toLowerCase();
  if (!config.allowedContracts.includes(normalizedContract)) {
    return {
      status: "reject",
      reason: `Contract is not whitelisted: ${normalizedContract}`
    };
  }

  if (request.estimatedFeeNative === null) {
    return {
      status: "needs_manual_review",
      reason: "Estimated fee could not be read from wallet popup"
    };
  }

  if (request.estimatedFeeNative > config.maxFeeNative) {
    return {
      status: "reject",
      reason: `Estimated fee ${request.estimatedFeeNative} exceeds cap ${config.maxFeeNative}`
    };
  }

  if (request.hasSevereWarning) {
    return {
      status: "needs_manual_review",
      reason: "Rabby reported a severe warning"
    };
  }

  if (!request.actionFingerprint && !config.allowLearnedActionPattern) {
    return {
      status: "needs_manual_review",
      reason: "Action fingerprint is unavailable"
    };
  }

  return {
    status: "approve",
    reason: "Wallet request matches EvoEvo memory guardrails"
  };
}
```

- [ ] **Step 4: Run guard tests**

Run:

```bash
npm test -- tests/guard.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit guard engine**

```bash
git add src/guard.ts tests/guard.test.ts
git commit -m "feat: add wallet guard engine"
```

---

### Task 4: Rabby Popup Parser and Signer

**Files:**
- Create: `src/rabby/parse.ts`
- Create: `src/rabby/signer.ts`
- Create: `tests/rabby-parse.test.ts`

- [ ] **Step 1: Write parser tests**

Create `tests/rabby-parse.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseRabbyText } from "../src/rabby/parse.js";

describe("parseRabbyText", () => {
  it("extracts visible Rabby metadata from a full address popup", () => {
    const text = [
      "https://evoevo.ai",
      "Unknown Signature Type",
      "Chain",
      "0G",
      "Interact contract",
      "0x61bb710000000000000000000000000000e937f9",
      "$0.0002",
      "0.000416 OG",
      "Sign"
    ].join("\n");

    expect(parseRabbyText(text)).toMatchObject({
      origin: "https://evoevo.ai",
      chain: "0G",
      contract: "0x61bb710000000000000000000000000000e937f9",
      estimatedFeeNative: 0.000416,
      hasSevereWarning: false,
      actionFingerprint: "unknown-signature-from-evoevo"
    });
  });

  it("does not treat truncated contract text as a whitelisted address", () => {
    const text = [
      "https://evoevo.ai",
      "Chain",
      "0G",
      "Interact contract",
      "0x61bb71...e937f9",
      "0.000416 OG"
    ].join("\n");

    expect(parseRabbyText(text).contract).toBeNull();
  });

  it("flags severe warnings", () => {
    const text = "https://evoevo.ai\nChain\n0G\nHigh Risk\nMalicious address warning";
    expect(parseRabbyText(text).hasSevereWarning).toBe(true);
  });
});
```

- [ ] **Step 2: Run parser tests to verify failure**

Run:

```bash
npm test -- tests/rabby-parse.test.ts
```

Expected: FAIL because `src/rabby/parse.ts` does not exist.

- [ ] **Step 3: Implement parser**

Create `src/rabby/parse.ts`:

```ts
import type { WalletRequest } from "../types.js";

const FULL_ADDRESS_PATTERN = /0x[a-fA-F0-9]{40}/;
const FEE_PATTERN = /([0-9]+(?:\.[0-9]+)?)\s*OG\b/i;
const SEVERE_WARNING_PATTERN = /(high risk|malicious|phishing|scam|dangerous|drain)/i;

export function parseRabbyText(rawText: string): WalletRequest {
  const origin = rawText.includes("https://evoevo.ai") ? "https://evoevo.ai" : null;
  const chain = /\b0G\b/.test(rawText) ? "0G" : null;
  const contract = rawText.match(FULL_ADDRESS_PATTERN)?.[0].toLowerCase() ?? null;
  const feeMatch = rawText.match(FEE_PATTERN);
  const estimatedFeeNative = feeMatch ? Number(feeMatch[1]) : null;
  const hasSevereWarning = SEVERE_WARNING_PATTERN.test(rawText);
  const actionFingerprint =
    origin === "https://evoevo.ai" && /Unknown Signature Type/i.test(rawText)
      ? "unknown-signature-from-evoevo"
      : null;

  return {
    origin,
    chain,
    contract,
    estimatedFeeNative,
    hasSevereWarning,
    actionFingerprint,
    rawText
  };
}
```

- [ ] **Step 4: Implement signer shell**

Create `src/rabby/signer.ts`:

```ts
import type { BrowserContext, Page } from "playwright";
import { evaluateWalletRequest } from "../guard.js";
import type { GuardDecision, RunnerConfig, WalletRequest } from "../types.js";
import { parseRabbyText } from "./parse.js";

export type SignResult = {
  request: WalletRequest;
  decision: GuardDecision;
  signed: boolean;
};

export async function waitForRabbyPopup(context: BrowserContext, timeoutMs: number): Promise<Page> {
  const existing = context.pages().find((page) => page.url().startsWith("chrome-extension://"));
  if (existing) {
    return existing;
  }

  return await context.waitForEvent("page", {
    timeout: timeoutMs,
    predicate: (page) => page.url().startsWith("chrome-extension://")
  });
}

export async function signRabbyPopup(context: BrowserContext, config: RunnerConfig): Promise<SignResult> {
  const popup = await waitForRabbyPopup(context, config.timeoutsMs.popup);
  await popup.waitForLoadState("domcontentloaded", { timeout: config.timeoutsMs.popup });

  const rawText = await popup.locator("body").innerText({ timeout: config.timeoutsMs.popup });
  const request = parseRabbyText(rawText);
  const decision = evaluateWalletRequest(request, config);

  if (decision.status !== "approve" || config.dryRun) {
    return {
      request,
      decision,
      signed: false
    };
  }

  await popup.getByRole("button", { name: /^Sign$/i }).click({ timeout: config.timeoutsMs.signing });

  return {
    request,
    decision,
    signed: true
  };
}
```

- [ ] **Step 5: Run parser tests and typecheck**

Run:

```bash
npm test -- tests/rabby-parse.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit Rabby parser and signer**

```bash
git add src/rabby/parse.ts src/rabby/signer.ts tests/rabby-parse.test.ts
git commit -m "feat: add Rabby popup parsing and signing shell"
```

---

### Task 5: Logger

**Files:**
- Create: `src/logger.ts`
- Create: `tests/logger.test.ts`

- [ ] **Step 1: Write logger tests**

Create `tests/logger.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionLogger } from "../src/logger.js";

let tempDir: string | null = null;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("SessionLogger", () => {
  it("writes JSONL attempts and summary counters", () => {
    tempDir = mkdtempSync(join(tmpdir(), "auto-evoevo-"));
    const logger = new SessionLogger(tempDir);

    logger.record({
      timestamp: "2026-05-21T00:00:00.000Z",
      evoevoUrl: "https://evoevo.ai/feed",
      cardLabel: "Will Bitcoin reach 87000?",
      buttonIndex: 0,
      walletRequest: null,
      decision: null,
      status: "dry_run",
      reason: "Dry run"
    });

    expect(logger.summary()).toEqual({
      signed: 0,
      skipped: 0,
      failed: 0,
      manual_review: 0,
      dry_run: 1
    });

    const logText = readFileSync(logger.filePath, "utf8");
    expect(logText).toContain("\"status\":\"dry_run\"");
  });
});
```

- [ ] **Step 2: Run logger test to verify failure**

Run:

```bash
npm test -- tests/logger.test.ts
```

Expected: FAIL because `src/logger.ts` does not exist.

- [ ] **Step 3: Implement logger**

Create `src/logger.ts`:

```ts
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AttemptLog, AttemptStatus } from "./types.js";

type Summary = Record<AttemptStatus, number>;

export class SessionLogger {
  public readonly filePath: string;
  private readonly counts: Summary = {
    signed: 0,
    skipped: 0,
    failed: 0,
    manual_review: 0,
    dry_run: 0
  };

  constructor(logDir: string) {
    mkdirSync(logDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.filePath = join(logDir, `session-${stamp}.jsonl`);
  }

  record(entry: AttemptLog): void {
    this.counts[entry.status] += 1;
    appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, "utf8");
  }

  summary(): Summary {
    return { ...this.counts };
  }
}
```

- [ ] **Step 4: Run logger test**

Run:

```bash
npm test -- tests/logger.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit logger**

```bash
git add src/logger.ts tests/logger.test.ts
git commit -m "feat: add session logger"
```

---

### Task 6: EvoEvo Page Controller

**Files:**
- Create: `src/evoevo/controller.ts`

- [ ] **Step 1: Implement page controller**

Create `src/evoevo/controller.ts`:

```ts
import type { Locator, Page } from "playwright";
import type { RunnerConfig } from "../types.js";

export type MemoryButton = {
  locator: Locator;
  index: number;
  label: string | null;
};

export class EvoEvoController {
  constructor(
    private readonly page: Page,
    private readonly config: RunnerConfig
  ) {}

  async openFeed(): Promise<void> {
    await this.page.goto(this.config.evoevoUrl, {
      waitUntil: "domcontentloaded",
      timeout: this.config.timeoutsMs.pageLoad
    });

    const url = new URL(this.page.url());
    if (url.origin !== this.config.allowedOrigin) {
      throw new Error(`Unexpected EvoEvo page origin: ${url.origin}`);
    }
  }

  async nextMemoryButton(): Promise<MemoryButton | null> {
    const buttons = this.page.getByRole("button", { name: /add to memory/i });
    const count = await buttons.count();

    for (let index = 0; index < count; index += 1) {
      const locator = buttons.nth(index);
      if (await locator.isVisible() && await locator.isEnabled()) {
        const label = await this.cardLabelFor(locator);
        return { locator, index, label };
      }
    }

    return null;
  }

  async clickMemoryButton(button: MemoryButton): Promise<void> {
    await button.locator.scrollIntoViewIfNeeded();
    await button.locator.click({ timeout: this.config.timeoutsMs.pageLoad });
  }

  async clickShowMore(): Promise<boolean> {
    const showMore = this.page.getByRole("button", { name: /show more/i }).first();
    if (!(await showMore.isVisible().catch(() => false))) {
      return false;
    }

    await showMore.scrollIntoViewIfNeeded();
    const before = await this.page.getByRole("button", { name: /add to memory/i }).count();
    await showMore.click({ timeout: this.config.timeoutsMs.feedExpansion });

    await this.page.waitForFunction(
      (previousCount) => {
        const buttons = [...document.querySelectorAll("button")].filter((button) =>
          /add to memory/i.test(button.textContent ?? "")
        );
        return buttons.length > Number(previousCount);
      },
      before,
      { timeout: this.config.timeoutsMs.feedExpansion }
    ).catch(() => undefined);

    const after = await this.page.getByRole("button", { name: /add to memory/i }).count();
    return after > before;
  }

  private async cardLabelFor(button: Locator): Promise<string | null> {
    const cardText = await button.locator("xpath=ancestor::*[self::article or self::div][1]").innerText({
      timeout: 1000
    }).catch(() => null);

    if (!cardText) {
      return null;
    }

    return cardText.split("\n").map((line) => line.trim()).find(Boolean) ?? null;
  }
}
```

- [ ] **Step 2: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit page controller**

```bash
git add src/evoevo/controller.ts
git commit -m "feat: add EvoEvo page controller"
```

---

### Task 7: Runner CLI Orchestration

**Files:**
- Create: `src/runner.ts`
- Create: `src/index.ts`

- [ ] **Step 1: Implement runner loop**

Create `src/runner.ts`:

```ts
import { chromium } from "playwright";
import { EvoEvoController } from "./evoevo/controller.js";
import { SessionLogger } from "./logger.js";
import { signRabbyPopup } from "./rabby/signer.js";
import type { AttemptLog, RunnerConfig } from "./types.js";

export async function run(config: RunnerConfig): Promise<void> {
  const logger = new SessionLogger(config.logDir);
  const context = await chromium.launchPersistentContext(config.chromeProfilePath, {
    headless: false,
    channel: "chrome"
  });

  try {
    const page = context.pages()[0] ?? await context.newPage();
    const controller = new EvoEvoController(page, config);
    await controller.openFeed();

    let idleExpansions = 0;

    while (idleExpansions < 2) {
      const button = await controller.nextMemoryButton();

      if (!button) {
        const expanded = await controller.clickShowMore();
        idleExpansions = expanded ? 0 : idleExpansions + 1;
        continue;
      }

      await controller.clickMemoryButton(button);

      try {
        const signResult = await signRabbyPopup(context, config);
        const status = config.dryRun ? "dry_run" : signResult.signed ? "signed" : "manual_review";
        const entry: AttemptLog = {
          timestamp: new Date().toISOString(),
          evoevoUrl: page.url(),
          cardLabel: button.label,
          buttonIndex: button.index,
          walletRequest: signResult.request,
          decision: signResult.decision,
          status,
          reason: config.dryRun ? "Dry run prevented signing" : signResult.decision.reason
        };
        logger.record(entry);

        if (signResult.decision.status !== "approve") {
          console.error(`Paused: ${signResult.decision.reason}`);
          break;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.record({
          timestamp: new Date().toISOString(),
          evoevoUrl: page.url(),
          cardLabel: button.label,
          buttonIndex: button.index,
          walletRequest: null,
          decision: null,
          status: "failed",
          reason: message
        });
        console.error(`Failed while processing button ${button.index}: ${message}`);
        break;
      }
    }

    console.log("Session summary:", logger.summary());
    console.log("Session log:", logger.filePath);
  } finally {
    await context.close();
  }
}
```

- [ ] **Step 2: Implement CLI entrypoint**

Create `src/index.ts`:

```ts
import { loadConfig } from "./config.js";
import { run } from "./runner.js";

function parseArgs(argv: string[]): { configPath: string; forceDryRun: boolean } {
  const configIndex = argv.indexOf("--config");
  const configPath = configIndex >= 0 ? argv[configIndex + 1] : "config.local.json";
  return {
    configPath,
    forceDryRun: argv.includes("--dry-run")
  };
}

const args = parseArgs(process.argv.slice(2));
const loaded = loadConfig(args.configPath);
const config = args.forceDryRun ? { ...loaded, dryRun: true } : loaded;

await run(config);
```

- [ ] **Step 3: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit runner CLI**

```bash
git add src/runner.ts src/index.ts
git commit -m "feat: add runner CLI orchestration"
```

---

### Task 8: Final Verification and Operator Notes

**Files:**
- Create: `README.md`

- [ ] **Step 1: Create README**

Create `README.md`:

```md
# Auto EvoEvo Runner

Local Playwright/CDP automation for EvoEvo `ADD TO MEMORY` actions with guarded Rabby signing.

## Setup

1. Run `npm install`.
2. Copy `config.example.json` to `config.local.json`.
3. Set `chromeProfilePath` to the Chrome profile that is logged into EvoEvo and Rabby.
4. Replace `allowedContracts` with the full EvoEvo contract address from a manually verified transaction.
5. Keep `dryRun` set to `true` for the first run.

## Dry Run

```bash
npm run dry-run -- --config config.local.json
```

Dry run clicks EvoEvo buttons and inspects Rabby, but it does not click `Sign`.

## Guarded Signing

Set `dryRun` to `false` only after dry run logs show the expected origin, chain, contract, action fingerprint, and fee.

```bash
npm start -- --config config.local.json
```

The runner pauses when a wallet request does not match the guardrails.

## Stop

Press `Ctrl+C` in the terminal to stop the runner. If a Rabby popup is open, review it manually before signing or rejecting.
```

- [ ] **Step 2: Run full verification**

Run:

```bash
npm test
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit README**

```bash
git add README.md
git commit -m "docs: add runner usage notes"
```

- [ ] **Step 4: Manual dry-run smoke test**

Run:

```bash
npm run dry-run -- --config config.local.json
```

Expected:

- Chrome opens with the configured profile.
- EvoEvo feed opens.
- The runner clicks one `ADD TO MEMORY`.
- Rabby popup is detected.
- The runner logs metadata.
- The runner does not click `Sign`.

- [ ] **Step 5: Manual guarded-sign smoke test**

Only after the dry-run smoke test shows a full whitelisted contract and expected low fee, set `"dryRun": false` in `config.local.json`, then run:

```bash
npm start -- --config config.local.json
```

Expected:

- The runner signs only when the guard engine approves.
- The runner pauses on unreadable contract text, chain mismatch, high fee, severe warning, or unknown origin.
- The session log records each attempted item.

---

## Self-Review

Spec coverage:

- Clicks `ADD TO MEMORY`: Task 6 and Task 7.
- Waits for Rabby popup: Task 4 and Task 7.
- Guarded signing: Task 3 and Task 4.
- `SHOW MORE` loop until exhaustion: Task 6 and Task 7.
- Logging: Task 5 and Task 7.
- Dry-run safety: Task 7 and Task 8.

Placeholder scan:

- No placeholder tokens are used.
- Every code step includes concrete file content.
- Every command step includes expected result.

Type consistency:

- `RunnerConfig`, `WalletRequest`, `GuardDecision`, and `AttemptLog` are defined in Task 2 and reused consistently.
- Guard status values match logger and runner usage.
- Parser output matches guard input.
