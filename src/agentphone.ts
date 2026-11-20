import { AgentPhoneClient } from "agentphone";
import { env } from "./config.js";

let client: AgentPhoneClient | undefined;

export function getClient(): AgentPhoneClient {
  if (!client) {
    client = new AgentPhoneClient({ token: env.apiKey, maxRetries: 0 });
  }
  return client;
}

export interface RawTranscriptEntry {
  transcript?: string;
  response?: string;
  createdAt?: string;
}

export interface RawCall {
  id: string;
  status: string;
  startedAt?: string;
  endedAt?: string;
  durationSeconds?: number | null;
  transcripts?: RawTranscriptEntry[];
  summary?: string;
  callSuccessful?: boolean;
  userSentiment?: string;
  disconnectionReason?: string;
  [key: string]: unknown;
}

export async function placeOutboundCall(params: {
  agentId: string;
  toNumber: string;
  systemPrompt: string;
  initialGreeting: string;
}): Promise<RawCall> {
  const result = await getClient().calls.createOutboundCall({
    agentId: params.agentId,
    toNumber: params.toNumber,
    systemPrompt: params.systemPrompt,
    initialGreeting: params.initialGreeting,
  });
  return result as unknown as RawCall;
}

export async function fetchCall(callId: string): Promise<RawCall> {
  const result = await getClient().calls.getCall({ call_id: callId });
  return result as unknown as RawCall;
}

export async function sendSms(params: {
  agentId: string;
  toNumber: string;
  body: string;
}): Promise<void> {
  await getClient().messages.sendMessage({
    agent_id: params.agentId,
    to_number: params.toNumber,
    body: params.body,
  });
}
