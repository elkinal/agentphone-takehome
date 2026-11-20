import Anthropic from "@anthropic-ai/sdk";
import type { RawCall } from "./agentphone.js";
import type { CallOutcome, TranscriptTurn } from "./types.js";

let client: Anthropic | undefined;

function getClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

function isValidOutcome(value: unknown): value is CallOutcome {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    (v.success === true || v.success === false || v.success === null) &&
    typeof v.summary === "string" &&
    Array.isArray(v.confirmed) &&
    Array.isArray(v.unresolved)
  );
}

/** Replaces the keyword heuristic with a real classification pass over the
 * full transcript when ANTHROPIC_API_KEY is configured. Returns null (never
 * throws) on any failure -- missing key, API error, or unparseable response
 * -- so callers can fall back to the deterministic keyword-based outcome. */
export async function classifyOutcomeWithLlm(params: {
  task: string;
  constraints: string[];
  rawCall: RawCall;
  transcript: TranscriptTurn[];
}): Promise<CallOutcome | null> {
  const anthropic = getClient();
  if (!anthropic) return null;

  const transcriptText = params.transcript.length
    ? params.transcript.map((t) => `${t.role === "agent" ? "AGENT" : "OTHER PARTY"}: ${t.content}`).join("\n")
    : "(no transcript -- the call never connected or produced no speech)";

  const prompt = `You are grading the outcome of a real phone call placed by an AI calling assistant on someone's behalf. Read the task, the hard constraints, the call status, and the full transcript, then decide what actually happened.

TASK GIVEN TO THE CALLING AGENT:
${params.task}

HARD CONSTRAINTS (the agent must not have agreed to anything violating these):
${params.constraints.length ? params.constraints.map((c) => `- ${c}`).join("\n") : "(none specified)"}

CALL STATUS: ${params.rawCall.status}
${params.rawCall.disconnectionReason ? `DISCONNECTION REASON: ${params.rawCall.disconnectionReason}` : ""}

TRANSCRIPT:
${transcriptText}

Respond with ONLY a JSON object, no other text, matching exactly this shape:
{
  "success": true | false | null,
  "summary": "one or two plain-language sentences describing the full outcome, for a human reading a text message",
  "confirmed": ["one short bullet per distinct fact that was definitively confirmed/agreed, empty array if none"],
  "unresolved": ["one short bullet per distinct thing that wasn't achieved, was declined, or is still open, empty array if none"]
}

Rules for your judgment:
- First, identify every distinct thing the task asked for -- the main request (e.g. the reservation itself) AND any secondary asks (seating preference, a special request, an amenity, timing flexibility, etc). Scan the ENTIRE transcript for each one, not just the agent's final sentence -- the agent's own closing line sometimes forgets to mention a secondary detail it already learned earlier in the call, and you should catch that and still report it correctly.
- "confirmed" and "unresolved" should each have one bullet per distinct item, not one blob of everything. E.g. "Table for 4 booked for 6:30pm Friday" and separately "No outdoor seating available" (as unresolved, since that part of the ask wasn't satisfied), rather than merging them into one sentence.
- "success" is true only if the MAIN request was accomplished AND no hard constraint was violated. If a constraint was violated (e.g. a deposit was actually accepted when the constraint forbids it), success is false even if something got "booked". A secondary ask going unfulfilled (e.g. no outdoor seating) does not by itself make success false if the main request succeeded -- just report it honestly in "unresolved".
- "success" is false if the main request clearly was not accomplished (no availability, wrong number, voicemail/no answer, declined, etc).
- "success" is null only if the transcript is genuinely ambiguous or cuts off before a clear resolution -- don't use null just because the wording is unusual; read it like a human would.
- Do not simply copy the agent's final sentence verbatim as your summary -- synthesize it yourself from the whole conversation so nothing discussed earlier gets lost.
- Base this entirely on the transcript content and call status, not on wording tricks or keywords.`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-5-5",
      max_tokens: 600,
      messages: [{ role: "user", content: prompt }],
    });
    const text = response.content.find((b) => b.type === "text")?.text;
    if (!text) return null;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    if (!isValidOutcome(parsed)) {
      console.error("[agentphone-call-assistant] LLM outcome response didn't match expected shape, falling back");
      return null;
    }
    console.error("[agentphone-call-assistant] outcome classified by LLM");
    return parsed;
  } catch (err) {
    console.error("[agentphone-call-assistant] LLM outcome classification failed, falling back:", (err as Error).message);
    return null;
  }
}
