# Prediction Source Scan Checkpoints Design

## Problem

Predictions runs can hit EvoEvo API rate limits while reading source-agent prediction pages:

`GET /v1/agents/{sourceAgentId}/predictions?limit=20&chain_id=16661`

The current workflow throttles `POST /memories/from-opinion`, but it does not throttle or checkpoint completed source-agent reads. If a run is stopped by a `429`, restarting can re-read source agents that were already fully scanned in the same run, wasting API quota and making another `429` more likely.

## Goal

Add per-scan source-agent checkpointing so a resumed Predictions run skips source agents that were already fully read in the current scan, while still allowing future full scans to read those agents again for new predictions.

## Non-Goals

- Do not permanently skip a source agent.
- Do not infer that a source agent has no future predictions.
- Do not change the existing `viewer_has_intaken` skip behavior.
- Do not replace the existing prediction registry; this design only adds source-level scan progress.

## Design

Add per-scan checkpoint fields to `WorkflowState`:

```ts
completedPredictionSourceIds: number[];
predictionScanStartedAt: number | null;
```

`completedPredictionSourceIds` records source agents whose prediction pages were fully read during the current Predictions scan. The runner marks a source complete only after `processSource` reaches the end of that source without pause, failure, or rate limit.

Add a read throttle config field to `ExtensionConfig`:

```ts
predictionReadCooldownSeconds: number;
```

The default should be `2`. It applies before every `GET /v1/agents/{sourceAgentId}/predictions` request. This cooldown is separate from `memoryApiCooldownSeconds`, which still applies only before `POST /memories/from-opinion`.

When a Predictions run starts:

- If `predictionScanStartedAt` is `null`, set it to `now` and start a new scan window.
- If `now - predictionScanStartedAt >= 24 hours`, start a new full scan window: clear `completedPredictionSourceIds`, set `predictionScanStartedAt = now`, and read source agents from the beginning.
- If the run is resuming after a soft stop or `429`, keep `completedPredictionSourceIds` and skip those source agents.
- Incremental scans may reuse the same mechanism for the current incremental cycle, but must not treat completed source IDs as permanent.

When reading sources:

1. Build the source-agent list from `/square/feed` or stored source IDs.
2. Filter out source IDs already present in `completedPredictionSourceIds`.
3. Before each `GET /predictions` page request, wait `predictionReadCooldownSeconds`.
4. For each remaining source, read pages normally.
5. After a source is fully read, append its ID to `completedPredictionSourceIds` and persist state.
6. If `GET /predictions` returns `429`, stop with a rate-limited runner result without marking the current source complete.

## Rate Limit Behavior

`GET /agents/{sourceAgentId}/predictions` should be treated like a recoverable Predictions rate limit:

- Emit a log/event that includes the source agent ID.
- Return `{ kind: "rate_limited", retryAfterMs }`.
- Let the coordinator schedule `nextRunAt = now + retryAfterMs`.
- Keep workflow status as `running` unless the user pressed Pause.
- Do not update `lastIncrementalAt` or `lastReconciliationAt` for an incomplete scan.

This keeps the existing manual Pause semantics: user Pause still stops the workflow and clears scheduled alarms.

## Scan Window And Checkpoint Reset Rules

The completed source list is scoped to a scan window anchored by `predictionScanStartedAt`:

- Start the first window by setting `predictionScanStartedAt = now`.
- Keep `completedPredictionSourceIds` for all restarts, manual Starts, and auto-resumes inside the next 24 hours.
- Start a new full scan window only when `now - predictionScanStartedAt >= 24 hours`.
- When a new scan window starts, clear `completedPredictionSourceIds` and set `predictionScanStartedAt = now`.

This avoids re-reading finished sources after a `429`, while guaranteeing that source agents are read again after the 24-hour scan window expires.

## Data Flow

```text
Run Predictions
  -> load WorkflowState
  -> initialize or rotate predictionScanStartedAt when 24h elapsed
  -> collect sourceAgentIds
  -> skip completedPredictionSourceIds
  -> read source pages
      -> wait predictionReadCooldownSeconds before each GET predictions page
      -> success to end: mark source complete
      -> 429: return rate_limited, keep source incomplete
  -> all sources complete: update scan timestamps, keep predictionScanStartedAt until 24h window expires
```

## Error Handling

- A `429` from `GET /predictions` is not a hard error. It becomes a soft rate-limit result.
- Repeated page detection still throws as a hard correctness error.
- Pause checks still win before starting each source and before each prediction item.
- The current source is marked complete only when all its pages have been read successfully.
- `predictionReadCooldownSeconds` is clamped to `0..60` and defaults to `2`.

## Testing

Add tests covering:

- A source ID is added to `completedPredictionSourceIds` after all pages are read.
- A resumed run skips sources already in `completedPredictionSourceIds`.
- A `429` during `listAgentPredictions` returns `rate_limited` and does not mark that source complete.
- A run inside the same 24-hour `predictionScanStartedAt` window keeps completed source checkpoints.
- A run after the 24-hour window clears completed source checkpoints and sets a new `predictionScanStartedAt`.
- `predictionReadCooldownSeconds` is applied before each predictions page request.
- Existing behavior remains unchanged for `viewer_has_intaken`, already-adopted, retries, and manual Pause.

## Field Names

Use these exact state fields unless implementation discovers a concrete conflict:

- `completedPredictionSourceIds: number[]`
- `predictionScanStartedAt: number | null`
- `predictionReadCooldownSeconds: number`
