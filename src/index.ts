import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { env } from "./config.js";
import { placeCall, refreshCall, listRecentCalls } from "./calls.js";
import { startPoller } from "./poller.js";

const server = new McpServer({
  name: "agentphone-call-assistant",
  version: "0.1.0",
});

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }], isError: true };
}

server.registerTool(
  "place_call",
  {
    title: "Place a phone call",
    description:
      "Places a real outbound phone call via AgentPhone to accomplish a task (e.g. booking a restaurant reservation). " +
      "Returns a call ID promptly; the call runs in the background. Use get_call to check on it. " +
      "Calling this again with the same idempotencyKey will NOT place a second call -- it returns the original call's record. " +
      "May instead return needsClarification if the task is missing something essential to actually accomplish it (e.g. no date/time for a reservation) -- " +
      "in that case no call was placed and nothing was consumed, so ask the user for the missing details and call again with the same idempotencyKey.",
    inputSchema: {
      destination: z.string().describe("Phone number to call. E.164 preferred (e.g. +15551234567); plain 10-digit US numbers are also accepted."),
      destinationLabel: z
        .string()
        .optional()
        .describe("Human-readable name for the destination, e.g. \"Luigi's Trattoria\". Used in the SMS report and call history instead of the raw number."),
      task: z
        .string()
        .describe(
          "What the call should accomplish, in plain language, e.g. 'Book a table for 4 this Friday between 6:30 and 7:30pm under the name Manav. Ask about outdoor seating.'"
        ),
      userDetails: z
        .record(z.string())
        .optional()
        .describe("Relevant details the agent may need to share, e.g. { name: 'Manav', partySize: '4' }"),
      constraints: z
        .array(z.string())
        .optional()
        .describe("Hard constraints the agent must never violate, e.g. \"Don't accept a reservation that requires a deposit\""),
      notifyPhoneNumber: z
        .string()
        .optional()
        .describe("Phone number to SMS the final result to. Defaults to USER_PHONE_NUMBER from the server's .env."),
      idempotencyKey: z
        .string()
        .min(1)
        .describe("A unique key for this request. Reusing it returns the original call instead of placing a new one."),
    },
  },
  async (args) => {
    try {
      const result = await placeCall(args);
      if ("needsClarification" in result) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  needsClarification: true,
                  missingDetails: result.missingDetails,
                  message:
                    "No call was placed. Ask the user for: " +
                    result.missingDetails.join(", ") +
                    ". Then call place_call again with the same idempotencyKey.",
                },
                null,
                2
              ),
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { callId: result.callId, status: result.status, placementError: result.placementError },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      return errorResult(`place_call failed: ${(err as Error).message}`);
    }
  }
);

server.registerTool(
  "get_call",
  {
    title: "Get call status and result",
    description:
      "Returns a call's current status, transcript, and final outcome (what was confirmed, whether the task " +
      "succeeded, and anything unresolved). Safe to call repeatedly while a call is in progress.",
    inputSchema: {
      callId: z.string().describe("The call ID returned by place_call"),
    },
  },
  async ({ callId }) => {
    try {
      const record = await refreshCall(callId);
      if (!record) return errorResult(`No call found with id ${callId}`);
      return { content: [{ type: "text" as const, text: JSON.stringify(record, null, 2) }] };
    } catch (err) {
      return errorResult(`get_call failed: ${(err as Error).message}`);
    }
  }
);

server.registerTool(
  "list_calls",
  {
    title: "List recent calls",
    description: "Lists recent calls placed through this server, most recent first.",
    inputSchema: {
      limit: z.number().int().min(1).max(100).optional().describe("Max number of calls to return (default 20)"),
    },
  },
  async ({ limit }) => {
    try {
      const records = await listRecentCalls(limit ?? 20);
      const summaries = records.map((r) => ({
        callId: r.callId,
        destination: r.destinationLabel || r.destination,
        task: r.task,
        status: r.status,
        success: r.outcome?.success ?? null,
        createdAt: r.createdAt,
      }));
      return { content: [{ type: "text" as const, text: JSON.stringify(summaries, null, 2) }] };
    } catch (err) {
      return errorResult(`list_calls failed: ${(err as Error).message}`);
    }
  }
);

async function main() {
  if (!process.env.AGENTPHONE_API_KEY) {
    console.error(
      "[agentphone-call-assistant] WARNING: AGENTPHONE_API_KEY is not set. Copy .env.example to .env and fill it in."
    );
  } else if (!env.agentId) {
    console.error(
      "[agentphone-call-assistant] WARNING: no agent configured. Run `npm run setup` before calling place_call."
    );
  }

  startPoller();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[agentphone-call-assistant] MCP server running on stdio");
}

main().catch((err) => {
  console.error("[agentphone-call-assistant] fatal error:", err);
  process.exit(1);
});
