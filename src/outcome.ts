import type { RawCall } from "./agentphone.js";
import type { CallOutcome, TranscriptTurn } from "./types.js";

const FAILURE_WORDS = [
  "could not",
  "couldn't",
  "unable",
  "not able",
  "won't be able",
  "will not be able",
  "wasn't able",
  "did not book",
  "didn't book",
  "no reservation",
  "no table",
  "fully booked",
  "requires a deposit",
  "requires deposit",
  "not available",
  "no availability",
  "unavailable",
  "can't accommodate",
  "cannot accommodate",
  "no longer available",
  "nothing available",
  "did not make",
  "didn't make",
  "won't be able to book",
  "can't book",
  "cannot book",
];

// Success is only claimed when the closing statement contains an explicit
// positive confirmation -- defaulting to "success" whenever no failure
// keyword matched produced false positives (e.g. "I won't be able to book
// for five" didn't match any failure phrase and was wrongly read as a win).
const SUCCESS_WORDS = [
  "confirmed",
  "booked",
  "you're all set",
  "all set",
  "you're good",
  "reservation is set",
  "table is set",
  "we'll see you",
  "see you then",
  "got you down for",
  "reserved",
];

/** The system prompt instructs the agent to state the concrete result as part
 * of its natural final goodbye and then hang up immediately, so the last
 * agent turn in the transcript should already contain the resolution --
 * no special spoken marker needed, which keeps the call itself natural. */
function extractClosingStatement(transcript: TranscriptTurn[]): string | undefined {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const turn = transcript[i];
    if (turn.role === "agent") return turn.content.trim() || undefined;
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
  const closingStatement = extractClosingStatement(transcript);
  const summary = rawCall.summary || closingStatement || fallbackSummaryForStatus(rawCall.status);

  let success: boolean | null;
  if (typeof rawCall.callSuccessful === "boolean") {
    success = rawCall.callSuccessful;
  } else if (["no-answer", "busy", "failed", "canceled"].includes(rawCall.status)) {
    success = false;
  } else if (closingStatement) {
    const lower = closingStatement.toLowerCase();
    if (FAILURE_WORDS.some((w) => lower.includes(w))) success = false;
    else if (SUCCESS_WORDS.some((w) => lower.includes(w))) success = true;
    else success = null; // neither signal found -- don't guess, surface as unclear
  } else {
    success = null;
  }

  const confirmed: string[] = [];
  const unresolved: string[] = [];
  if (closingStatement) {
    if (success === true) confirmed.push(closingStatement);
    else unresolved.push(closingStatement);
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
