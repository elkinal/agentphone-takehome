import { env } from "./config.js";
import { listRecentCalls, refreshCall } from "./calls.js";
import { ACTIVE_STATUSES } from "./types.js";

/** Periodically refreshes any call still in flight, so the SMS report goes
 * out as soon as a call ends even if nobody calls get_call again. */
export function startPoller(): NodeJS.Timeout[] {
  const statusPoll = setInterval(async () => {
    const recent = await listRecentCalls(50);
    const active = recent.filter((c) => ACTIVE_STATUSES.includes(c.status as any) && !c.placementError);
    await Promise.all(active.map((c) => refreshCall(c.callId)));
  }, env.pollIntervalMs);

  // Separate, much slower loop: retries the report SMS for calls that ended
  // but never got their text sent (e.g. AgentPhone's A2P registration was
  // still pending). Decoupled from the fast status loop above so a
  // days-long external delay doesn't mean hammering the API every few
  // seconds -- it just quietly catches up once sending unblocks.
  const smsRetryPoll = setInterval(async () => {
    const recent = await listRecentCalls(100);
    const pendingSms = recent.filter(
      (c) => !c.placementError && !c.smsSent && c.notifyPhoneNumber && !ACTIVE_STATUSES.includes(c.status as any)
    );
    await Promise.all(pendingSms.map((c) => refreshCall(c.callId)));
  }, env.smsRetryIntervalMs);

  return [statusPoll, smsRetryPoll];
}
