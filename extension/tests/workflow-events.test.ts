import { describe, expect, it } from "vitest";
import { formatWorkflowEvent } from "../src/ui/workflow-events.js";

describe("formatWorkflowEvent", () => {
  it("formats prediction lifecycle events", () => {
    expect(formatWorkflowEvent({ type: "predictions-loading" })).toBe(
      "[Predictions] Loading Square feed...",
    );
    expect(formatWorkflowEvent({ type: "predictions-sources", count: 20 })).toBe(
      "[Predictions] Found 20 source agents",
    );
    expect(formatWorkflowEvent({
      type: "prediction",
      phase: "already_adopted",
      sourceAgentId: 3314,
      targetAgentId: 8359,
      predictionId: "859",
    })).toBe(
      "[Predictions] Source 3314 - Prediction 859 - Already added, skipped",
    );
    expect(formatWorkflowEvent({
      type: "prediction",
      phase: "confirmed",
      sourceAgentId: 60062,
      targetAgentId: 8359,
      predictionId: "852",
      txHash: "0x1234567890abcdef",
    })).toBe(
      "[Predictions] Source 60062 - Prediction 852 - Confirmed - 0x1234567890...",
    );
    expect(formatWorkflowEvent({
      type: "predictions-rate-limited",
      retryAfterMs: 900_000,
    })).toBe("[Predictions] Rate limited. Retrying in 15 minutes.");
    expect(formatWorkflowEvent({
      type: "predictions-rate-limited",
      retryAfterMs: 900_000,
      sourceAgentId: 6714,
    })).toBe("[Predictions] Source 6714 rate limited. Retrying in 15 minutes.");
  });
});
