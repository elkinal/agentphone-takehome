import { SUMMARY_MARKER } from "./prompt.js";
import type { RawCall } from "./agentphone.js";
import type { CallOutcome, TranscriptTurn } from "./types.js";

const FAILURE_WORDS = [
  "could not",
  "couldn't",
  "unable",
  "not able",
  "did not book",
  "didn't book",
  "no reservation",
  "no table",
  "fully booked",
  "requires a deposit",
  "requires deposit",
];

function extractMarkedSummary(transcript: TranscriptTurn[]): string | undefined {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const turn = transcript[i];
    if (turn.role !== "agent") continue;
    const idx = turn.content.indexOf(SUMMARY_MARKER);
    if (idx !== -1) {
      return turn.content.slice(idx + SUMMARY_MARKER.length).trim();
    }
  }
  return undefined;
}

function fallbackSummaryForStatus(status: string): string {
  switch (status) {
    case "no-answer":
      return "The call was not answered.";
    case "busy":
      return "The line was busy.";
    case "failed":
      return "The call failed to connect.";
    case "canceled":
      return "The call was canceled before it completed.";
    default:
      return "The call ended without a clear summary; check the transcript.";
  }
}

export function buildOutcome(rawCall: RawCall, transcript: TranscriptTurn[]): CallOutcome {
  const markedSummary = extractMarkedSummary(transcript);
  const summary = rawCall.summary || markedSummary || fallbackSummaryForStatus(rawCall.status);

  let success: boolean | null;
  if (typeof rawCall.callSuccessful === "boolean") {
    success = rawCall.callSuccessful;
  } else if (["no-answer", "busy", "failed", "canceled"].includes(rawCall.status)) {
    success = false;
  } else if (markedSummary) {
    const lower = markedSummary.toLowerCase();
    success = !FAILURE_WORDS.some((w) => lower.includes(w));
  } else {
    success = null;
  }

  const confirmed: string[] = [];
  const unresolved: string[] = [];
  if (markedSummary) {
    const lower = markedSummary.toLowerCase();
    if (FAILURE_WORDS.some((w) => lower.includes(w))) {
      unresolved.push(markedSummary);
    } else {
      confirmed.push(markedSummary);
    }
  } else if (rawCall.status !== "completed") {
    unresolved.push(fallbackSummaryForStatus(rawCall.status));
  }

  return {
    success,
    summary,
    confirmed,
    unresolved,
    disconnectionReason: rawCall.disconnectionReason,
  };
}
