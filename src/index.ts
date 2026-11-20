import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { placeCall, refreshCall, listRecentCalls } from "./calls.js";
import { startPoller } from "./poller.js";

const server = new McpServer({
  name: "agentphone-call-assistant",
  version: "0.1.0",
});

server.registerTool(
  "place_call",
  {
    title: "Place a phone call",
    description:
      "Places a real outbound phone call via AgentPhone to accomplish a task (e.g. booking a restaurant reservation). " +
      "Returns a call ID promptly; the call runs in the background. Use get_call to check on it. " +
      "Calling this again with the same idempotencyKey will NOT place a second call -- it returns the original call's record.",
    inputSchema: {
      destination: z.string().describe("Phone number to call, in E.164 format, e.g. +15551234567"),
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
        .describe("A unique key for this request. Reusing it returns the original call instead of placing a new one."),
    },
  },
  async (args) => {
    const record = await placeCall(args);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              callId: record.callId,
              status: record.status,
              placementError: record.placementError,
            },
            null,
            2
          ),
        },
      ],
    };
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
    const record = await refreshCall(callId);
    if (!record) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: `No call found with id ${callId}` }) }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(record, null, 2) }],
    };
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
    const records = await listRecentCalls(limit ?? 20);
    const summaries = records.map((r) => ({
      callId: r.callId,
      destination: r.destination,
      task: r.task,
      status: r.status,
      success: r.outcome?.success ?? null,
      createdAt: r.createdAt,
    }));
    return {
      content: [{ type: "text", text: JSON.stringify(summaries, null, 2) }],
    };
  }
);

async function main() {
  startPoller();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[agentphone-call-assistant] MCP server running on stdio");
}

main().catch((err) => {
  console.error("[agentphone-call-assistant] fatal error:", err);
  process.exit(1);
});
