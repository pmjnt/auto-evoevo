import type { PredictionActivityEvent } from "../shared/types.js";

export function formatWorkflowEvent(event: Record<string, unknown>): string | null {
  if (event.type === "predictions-loading") return "[Predictions] Loading Square feed...";
  if (event.type === "predictions-sources") {
    return `[Predictions] Found ${String(event.count)} source agents`;
  }
  if (event.type === "predictions-rate-limited") {
    const typed = event as PredictionActivityEvent & { type: "predictions-rate-limited" };
    const minutes = Math.max(1, Math.ceil(typed.retryAfterMs / 60_000));
    if (typed.sourceAgentId !== undefined) {
      return `[Predictions] Source ${typed.sourceAgentId} rate limited. Retrying in ${minutes} minutes.`;
    }
    return `[Predictions] Rate limited. Retrying in ${minutes} minutes.`;
  }
  if (event.type === "prediction") {
    const typed = event as PredictionActivityEvent & { type: "prediction" };
    const prefix = `[Predictions] Source ${typed.sourceAgentId} - Prediction ${typed.predictionId}`;
    switch (typed.phase) {
      case "submitting":
        return `${prefix} - Submitting...`;
      case "confirmed":
        return `${prefix} - Confirmed - ${shortHash(typed.txHash)}`;
      case "already_adopted":
        return `${prefix} - Already added, skipped`;
      case "skipped":
        return `${prefix} - Skipped${typed.reason ? ` - ${typed.reason}` : ""}`;
      case "failed":
        return `${prefix} - Failed${typed.reason ? ` - ${typed.reason}` : ""}`;
    }
  }
  return null;
}

function shortHash(hash: string | undefined): string {
  if (!hash) return "unknown tx";
  return hash.length > 12 ? `${hash.slice(0, 12)}...` : hash;
}
