import { env } from "./config.js";
import { listRecentCalls, refreshCall } from "./calls.js";
import { ACTIVE_STATUSES } from "./types.js";

/** Periodically refreshes any call still in flight, so the SMS report goes
 * out as soon as a call ends even if nobody calls get_call again. */
export function startPoller(): NodeJS.Timeout {
  return setInterval(async () => {
    const recent = await listRecentCalls(50);
    const active = recent.filter((c) => ACTIVE_STATUSES.includes(c.status as any) && !c.placementError);
    await Promise.all(active.map((c) => refreshCall(c.callId)));
  }, env.pollIntervalMs);
}
