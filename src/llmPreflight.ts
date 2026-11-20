import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | undefined;

function getClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

/** Checks whether the task as given is actually dialable, or whether
 * something essential is missing (not a nitpick, something that would make
 * the call pointless or doomed without it). Returns an empty array when the
 * task is reasonably well-specified, and null (never throws) when the check
 * itself is unavailable -- missing key or API failure -- so callers should
 * treat null the same as "nothing missing" and proceed with the call. */
export async function findMissingDetails(params: {
  task: string;
  constraints: string[];
  userDetails: Record<string, string>;
  destination: string;
}): Promise<string[] | null> {
  const anthropic = getClient();
  if (!anthropic) return null;

  const prompt = `You're a pre-flight check for an AI phone-calling assistant, run right before it dials. Look at the task it's about to carry out and decide whether it's actually ready to dial, or whether something essential is missing that would make the call pointless or doomed to fail without it.

A destination phone number has ALREADY been provided and validated separately (${params.destination}) -- never flag "which business/person to call" or "a phone number" as missing, that part is already handled. Only evaluate whether the TASK ITSELF (what to say/accomplish once connected) is specified well enough.

TASK:
${params.task}

CONSTRAINTS:
${params.constraints.length ? params.constraints.map((c) => `- ${c}`).join("\n") : "(none specified)"}

DETAILS PROVIDED:
${Object.entries(params.userDetails).filter(([, v]) => v).map(([k, v]) => `- ${k}: ${v}`).join("\n") || "(none)"}

Only flag something as missing if a reasonable human caller genuinely could not proceed without it for THIS SPECIFIC task -- e.g. a reservation request with no date/time at all, or no party size when booking a table, or no name to book under. Do NOT flag things that are optional, already implied, or just "could be nice to confirm" -- e.g. not flagging a seating preference, not flagging an exact budget, not being pedantic about minor ambiguity a human caller would just ask about naturally on the call itself.

Respond with ONLY a JSON object, no other text:
{ "missingDetails": ["short phrase for each essential missing thing", "..."] }

Return an empty array if the task is reasonably ready to dial as-is.`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-5-5",
      max_tokens: 800,
      messages: [{ role: "user", content: prompt }],
    });
    const text = response.content.find((b) => b.type === "text")?.text;
    if (!text) {
      console.error(
        "[agentphone-call-assistant] pre-flight check: no text content in response, proceeding without it. stop_reason:",
        response.stop_reason,
        "content:",
        JSON.stringify(response.content)
      );
      return null;
    }
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error("[agentphone-call-assistant] pre-flight check: no JSON found in response, proceeding without it:", text);
      return null;
    }
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed || !Array.isArray(parsed.missingDetails)) {
      console.error("[agentphone-call-assistant] pre-flight check: unexpected response shape, proceeding without it:", jsonMatch[0]);
      return null;
    }
    return parsed.missingDetails;
  } catch (err) {
    console.error("[agentphone-call-assistant] pre-flight check failed, proceeding without it:", (err as Error).message);
    return null;
  }
}
