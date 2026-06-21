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

When a Predictions run starts:

- If the coordinator is starting a new full reconciliation scan, clear `completedPredictionSourceIds` before scanning.
- If the run is resuming after a soft stop or `429`, keep `completedPredictionSourceIds` and skip those source agents.
- Incremental scans may reuse the same mechanism for the current incremental cycle, but must not treat completed source IDs as permanent.

When reading sources:

1. Build the source-agent list from `/square/feed` or stored source IDs.
2. Filter out source IDs already present in `completedPredictionSourceIds`.
3. For each remaining source, read pages normally.
4. After a source is fully read, append its ID to `completedPredictionSourceIds` and persist state.
5. If `GET /predictions` returns `429`, stop with a rate-limited runner result without marking the current source complete.

## Rate Limit Behavior

`GET /agents/{sourceAgentId}/predictions` should be treated like a recoverable Predictions rate limit:

- Emit a log/event that includes the source agent ID.
- Return `{ kind: "rate_limited", retryAfterMs }`.
- Let the coordinator schedule `nextRunAt = now + retryAfterMs`.
- Keep workflow status as `running` unless the user pressed Pause.
- Do not update `lastIncrementalAt` or `lastReconciliationAt` for an incomplete scan.

This keeps the existing manual Pause semantics: user Pause still stops the workflow and clears scheduled alarms.

## Checkpoint Reset Rules

The completed source list is scoped to one active scan cycle:

- Clear it when starting a new full reconciliation from the beginning.
- Clear it when the previous Predictions cycle completed successfully and the coordinator schedules a future repeat.
- Keep it when recovering from rate limit, service worker restart, or manual Start while the previous scan did not complete.

This avoids re-reading finished sources after a `429`, while avoiding stale permanent skips.

## Data Flow

```text
Run Predictions
  -> load WorkflowState
  -> collect sourceAgentIds
  -> skip completedPredictionSourceIds
  -> read source pages
      -> success to end: mark source complete
      -> 429: return rate_limited, keep source incomplete
  -> all sources complete: clear completedPredictionSourceIds, update scan timestamps
```

## Error Handling

- A `429` from `GET /predictions` is not a hard error. It becomes a soft rate-limit result.
- Repeated page detection still throws as a hard correctness error.
- Pause checks still win before starting each source and before each prediction item.
- The current source is marked complete only when all its pages have been read successfully.

## Testing

Add tests covering:

- A source ID is added to `completedPredictionSourceIds` after all pages are read.
- A resumed run skips sources already in `completedPredictionSourceIds`.
- A `429` during `listAgentPredictions` returns `rate_limited` and does not mark that source complete.
- A successful full scan clears the per-scan completed source checkpoint.
- Existing behavior remains unchanged for `viewer_has_intaken`, already-adopted, retries, and manual Pause.

## Field Names

Use these exact state fields unless implementation discovers a concrete conflict:

- `completedPredictionSourceIds: number[]`
- `predictionScanStartedAt: number | null`
