import fs from "node:fs";
import { CALLS_PATH, DATA_DIR } from "./config.js";
import type { CallRecord } from "./types.js";

interface Db {
  idempotencyKeys: Record<string, string>;
  calls: Record<string, CallRecord>;
}

function emptyDb(): Db {
  return { idempotencyKeys: {}, calls: {} };
}

function load(): Db {
  try {
    const raw = fs.readFileSync(CALLS_PATH, "utf8");
    return { ...emptyDb(), ...JSON.parse(raw) };
  } catch {
    return emptyDb();
  }
}

function save(db: Db): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CALLS_PATH, JSON.stringify(db, null, 2));
}

// Serializes read-modify-write cycles so the poller and tool handlers never
// clobber each other's writes to the same JSON file.
let queue: Promise<unknown> = Promise.resolve();
function locked<T>(fn: () => T): Promise<T> {
  const result = queue.then(fn);
  queue = result.catch(() => undefined);
  return result;
}

export function findCallIdByIdempotencyKey(key: string): Promise<string | undefined> {
  return locked(() => load().idempotencyKeys[key]);
}

export function createCallRecord(record: CallRecord): Promise<void> {
  return locked(() => {
    const db = load();
    db.idempotencyKeys[record.idempotencyKey] = record.callId;
    db.calls[record.callId] = record;
    save(db);
  });
}

export function getCallRecord(callId: string): Promise<CallRecord | undefined> {
  return locked(() => load().calls[callId]);
}

export function updateCallRecord(
  callId: string,
  patch: Partial<CallRecord>
): Promise<CallRecord | undefined> {
  return locked(() => {
    const db = load();
    const existing = db.calls[callId];
    if (!existing) return undefined;
    const updated: CallRecord = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    db.calls[callId] = updated;
    save(db);
    return updated;
  });
}

export function listCallRecords(limit = 20): Promise<CallRecord[]> {
  return locked(() => {
    const db = load();
    return Object.values(db.calls)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  });
}
