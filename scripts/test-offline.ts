// Offline regression checks: input validation, idempotency, and error
// handling that don't require placing a real (billable) phone call.
// Live call-quality behavior (conversation flow, outcome accuracy) can only
// be verified with real calls -- see scripts/call-demo.ts for that.
import "../src/config.js";
import { randomUUID } from "node:crypto";
import { isE164, normalizePhone } from "../src/phone.js";
import { placeCall, refreshCall } from "../src/calls.js";
import { findMissingDetails } from "../src/llmPreflight.js";

let failures = 0;
function check(label: string, pass: boolean, detail?: unknown) {
  console.log(`${pass ? "PASS" : "FAIL"} - ${label}${detail !== undefined ? ` :: ${JSON.stringify(detail)}` : ""}`);
  if (!pass) failures++;
}

async function main() {
  // --- pure normalization/validation unit checks ---
  check("normalize 10-digit", normalizePhone("6072167113") === "+16072167113", normalizePhone("6072167113"));
  check("normalize 11-digit with leading 1", normalizePhone("16072167113") === "+16072167113", normalizePhone("16072167113"));
  check("already-E.164 passthrough", normalizePhone("+16072167113") === "+16072167113");
  check("isE164 accepts valid", isE164("+16072167113") === true);
  check("isE164 rejects garbage", isE164("not-a-number") === false);
  check("isE164 rejects missing +", isE164("6072167113") === false);

  // --- place_call with invalid phone number: should fail fast, no real call ---
  const badNumberResult = await placeCall({
    destination: "not-a-real-phone-number",
    destinationLabel: "Test Garbage Number",
    task: "This should never actually dial.",
    idempotencyKey: `free-test-bad-number-${randomUUID()}`,
  });
  check("invalid destination doesn't need clarification", !("needsClarification" in badNumberResult));
  if (!("needsClarification" in badNumberResult)) {
    check(
      "invalid destination fails without dialing",
      badNumberResult.placementError !== null && badNumberResult.status === "failed",
      badNumberResult.placementError
    );
    check("destinationLabel threaded through on failure", badNumberResult.destinationLabel === "Test Garbage Number");
  }

  // --- get_call on a call id that was never placed ---
  const missing = await refreshCall("totally-made-up-call-id-xyz");
  check("get_call on unknown id returns undefined (no crash)", missing === undefined);

  // --- idempotency: calling place_call twice with the same key and an
  // invalid number (so even the FIRST attempt costs nothing) should return
  // the identical failed record both times ---
  const key = `free-test-idempotency-${randomUUID()}`;
  const first = await placeCall({ destination: "also-not-real", task: "x", idempotencyKey: key });
  const second = await placeCall({ destination: "also-not-real", task: "x", idempotencyKey: key });
  if (!("needsClarification" in first) && !("needsClarification" in second)) {
    check("idempotency: same key returns identical callId", first.callId === second.callId, {
      first: first.callId,
      second: second.callId,
    });
  } else {
    check("idempotency check didn't need clarification", false, { first, second });
  }

  // --- pre-flight clarification check, tested directly (never goes through
  // placeCall / never dials) so a surprising LLM judgment call can't
  // accidentally place a real call during an "offline" test run ---
  if (process.env.ANTHROPIC_API_KEY) {
    const vague = await findMissingDetails({
      task: "Call them.",
      constraints: [],
      userDetails: {},
      destination: "+16072167113",
    });
    check("hopelessly vague task flags missing details", !!vague && vague.length > 0, vague);

    const wellSpecified = await findMissingDetails({
      task: "Book a table for four this Friday between 6:30 and 7:30pm under the name Manav. Ask about outdoor seating.",
      constraints: ["Don't accept a reservation that requires a deposit"],
      userDetails: { name: "Manav" },
      destination: "+16072167113",
    });
    check(
      "well-specified task doesn't flag anything missing",
      wellSpecified !== null && wellSpecified.length === 0,
      wellSpecified
    );
  } else {
    console.log("SKIP - pre-flight clarification checks (no ANTHROPIC_API_KEY configured)");
  }

  console.log(`\n${failures === 0 ? "All offline tests passed." : `${failures} offline test(s) FAILED.`}`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
