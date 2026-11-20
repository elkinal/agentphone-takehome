import { env } from "./config.js";
import { fetchCall, placeOutboundCall, sendSms, type RawCall } from "./agentphone.js";
import { classifyOutcomeWithLlm } from "./llmOutcome.js";
import { buildOutcome } from "./outcome.js";
import { buildCallScript } from "./prompt.js";
import { isE164, normalizePhone } from "./phone.js";
import * as store from "./store.js";
import { ACTIVE_STATUSES, type CallRecord, type PlaceCallArgs, type TranscriptTurn } from "./types.js";

function log(...args: unknown[]) {
  // MCP servers talk JSON-RPC over stdout; all diagnostics go to stderr.
  console.error("[agentphone-call-assistant]", ...args);
}

// Serializes refreshCall per callId so a poller tick and a concurrent
// get_call can never both pass the "not sent yet" check and double-text.
const refreshLocks = new Map<string, Promise<unknown>>();
function withCallLock<T>(callId: string, fn: () => Promise<T>): Promise<T> {
  const prior = refreshLocks.get(callId) || Promise.resolve();
  const next = prior.then(fn, fn);
  refreshLocks.set(
    callId,
    next.catch(() => undefined)
  );
  return next;
}

function toTranscript(rawCall: RawCall): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const entry of rawCall.transcripts || []) {
    if (entry.transcript) turns.push({ role: "user", content: entry.transcript, at: entry.createdAt });
    if (entry.response) turns.push({ role: "agent", content: entry.response, at: entry.createdAt });
  }
  return turns;
}

function buildFailedRecord(params: {
  idempotencyKey: string;
  destination: string;
  destinationLabel: string | null;
  task: string;
  userDetails: Record<string, string>;
  constraints: string[];
  notifyPhoneNumber: string | null;
  message: string;
}): CallRecord {
  const now = new Date().toISOString();
  return {
    callId: `failed_${params.idempotencyKey}`,
    idempotencyKey: params.idempotencyKey,
    destination: params.destination,
    destinationLabel: params.destinationLabel,
    task: params.task,
    userDetails: params.userDetails,
    constraints: params.constraints,
    notifyPhoneNumber: params.notifyPhoneNumber,
    status: "failed",
    createdAt: now,
    updatedAt: now,
    transcript: [],
    outcome: {
      success: false,
      summary: `Failed to place the call: ${params.message}`,
      confirmed: [],
      unresolved: [`Failed to place the call: ${params.message}`],
    },
    smsSent: false,
    smsError: null,
    placementError: params.message,
  };
}

export async function placeCall(args: PlaceCallArgs): Promise<CallRecord> {
  const existingCallId = await store.findCallIdByIdempotencyKey(args.idempotencyKey);
  if (existingCallId) {
    const existing = await store.getCallRecord(existingCallId);
    if (existing) {
      log(`idempotency hit for key "${args.idempotencyKey}" -> ${existingCallId}, not placing a new call`);
      return existing;
    }
  }

  const userDetails = args.userDetails || {};
  const constraints = args.constraints || [];
  const destinationLabel = args.destinationLabel || null;
  const destination = normalizePhone(args.destination);
  const notifyPhoneNumber = args.notifyPhoneNumber
    ? normalizePhone(args.notifyPhoneNumber)
    : env.userPhoneNumber
      ? normalizePhone(env.userPhoneNumber)
      : null;

  const commonFields = { idempotencyKey: args.idempotencyKey, destination, destinationLabel, task: args.task, userDetails, constraints, notifyPhoneNumber };

  if (!isE164(destination)) {
    const failedRecord = buildFailedRecord({
      ...commonFields,
      message: `"${args.destination}" is not a valid phone number (expected E.164, e.g. +15551234567).`,
    });
    await store.createCallRecord(failedRecord);
    return failedRecord;
  }

  const agentId = env.agentId;
  if (!agentId) {
    const failedRecord = buildFailedRecord({
      ...commonFields,
      message: "No AgentPhone agent configured. Run `npm run setup` first to create/attach an agent and number.",
    });
    await store.createCallRecord(failedRecord);
    return failedRecord;
  }

  const { systemPrompt, initialGreeting } = buildCallScript({
    task: args.task,
    userDetails,
    constraints,
  });

  const now = new Date().toISOString();
  let rawCall: RawCall;
  try {
    rawCall = await placeOutboundCall({
      agentId,
      toNumber: destination,
      systemPrompt,
      initialGreeting,
    });
  } catch (err) {
    // Record the attempt so repeating the same idempotency key doesn't retry
    // a request that AgentPhone may have already acted on ambiguously.
    const failedRecord = buildFailedRecord({ ...commonFields, message: (err as Error).message });
    await store.createCallRecord(failedRecord);
    return failedRecord;
  }

  const record: CallRecord = {
    callId: rawCall.id,
    idempotencyKey: args.idempotencyKey,
    destination,
    destinationLabel,
    task: args.task,
    userDetails,
    constraints,
    notifyPhoneNumber,
    status: rawCall.status,
    createdAt: now,
    updatedAt: now,
    startedAt: rawCall.startedAt,
    transcript: toTranscript(rawCall),
    outcome: null,
    smsSent: false,
    smsError: null,
    placementError: null,
  };
  await store.createCallRecord(record);
  log(`placed call ${record.callId} to ${destination}`);
  return record;
}

/** Re-fetches a call from AgentPhone, updates the store, and sends the report
 * SMS exactly once if the call has just reached a terminal state. Locked per
 * callId so a poller tick and a concurrent get_call can't both send the SMS. */
export function refreshCall(callId: string): Promise<CallRecord | undefined> {
  return withCallLock(callId, () => doRefreshCall(callId));
}

async function doRefreshCall(callId: string): Promise<CallRecord | undefined> {
  const existing = await store.getCallRecord(callId);
  if (!existing) return undefined;
  if (existing.placementError) return existing; // never placed, nothing to poll

  let rawCall: RawCall;
  try {
    rawCall = await fetchCall(callId);
  } catch (err) {
    log(`failed to refresh call ${callId}:`, (err as Error).message);
    return existing;
  }

  const transcript = toTranscript(rawCall);
  const isTerminal = !ACTIVE_STATUSES.includes(rawCall.status as any);
  let outcome = existing.outcome;
  if (isTerminal) {
    outcome =
      (await classifyOutcomeWithLlm({ task: existing.task, constraints: existing.constraints, rawCall, transcript })) ??
      buildOutcome(rawCall, transcript);
  }

  let updated = await store.updateCallRecord(callId, {
    status: rawCall.status,
    startedAt: rawCall.startedAt ?? existing.startedAt,
    endedAt: rawCall.endedAt ?? existing.endedAt,
    durationSeconds: rawCall.durationSeconds ?? existing.durationSeconds,
    transcript,
    outcome,
  });
  if (!updated) return existing;

  if (isTerminal && !updated.smsSent && updated.notifyPhoneNumber) {
    updated = await sendReportSms(updated);
  }

  return updated;
}

function formatSmsBody(record: CallRecord): string {
  const outcome = record.outcome;
  const statusWord =
    outcome?.success === true ? "Succeeded" : outcome?.success === false ? "Did not succeed" : "Unclear";
  const who = record.destinationLabel || record.destination;
  const lines = [`Call to ${who}: ${statusWord}.`];
  if (outcome?.summary) lines.push(outcome.summary);
  if (outcome?.unresolved?.length) lines.push(`Unresolved: ${outcome.unresolved.join("; ")}`);
  const body = lines.join(" ");
  return body.length > 1500 ? body.slice(0, 1497) + "..." : body;
}

async function sendReportSms(record: CallRecord): Promise<CallRecord> {
  if (!record.notifyPhoneNumber) return record;
  try {
    await sendSms({
      agentId: env.agentId,
      toNumber: record.notifyPhoneNumber,
      body: formatSmsBody(record),
    });
    log(`sent report SMS for call ${record.callId} to ${record.notifyPhoneNumber}`);
    return (await store.updateCallRecord(record.callId, { smsSent: true, smsError: null })) || record;
  } catch (err) {
    const message = (err as Error).message;
    log(`failed to send report SMS for call ${record.callId}:`, message);
    return (await store.updateCallRecord(record.callId, { smsError: message })) || record;
  }
}

export async function listRecentCalls(limit: number): Promise<CallRecord[]> {
  return store.listCallRecords(limit);
}
