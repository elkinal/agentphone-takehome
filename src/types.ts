export type CallLifecycle =
  | "queued"
  | "ringing"
  | "in-progress"
  | "completed"
  | "failed"
  | "no-answer"
  | "busy"
  | "canceled";

export const ACTIVE_STATUSES: CallLifecycle[] = ["queued", "ringing", "in-progress"];

export interface TranscriptTurn {
  role: "agent" | "user";
  content: string;
  at?: string;
}

export interface CallOutcome {
  /** true = task succeeded, false = did not succeed, null = unknown/ambiguous */
  success: boolean | null;
  summary: string;
  confirmed: string[];
  unresolved: string[];
  disconnectionReason?: string;
}

export interface CallRecord {
  callId: string;
  idempotencyKey: string;
  destination: string;
  task: string;
  userDetails: Record<string, string>;
  constraints: string[];
  notifyPhoneNumber: string | null;
  status: CallLifecycle | string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  endedAt?: string;
  durationSeconds?: number;
  transcript: TranscriptTurn[];
  outcome: CallOutcome | null;
  smsSent: boolean;
  smsError: string | null;
  placementError: string | null;
}

export interface PlaceCallArgs {
  destination: string;
  task: string;
  userDetails?: Record<string, string>;
  constraints?: string[];
  notifyPhoneNumber?: string;
  idempotencyKey: string;
}

export interface GetCallArgs {
  callId: string;
}
