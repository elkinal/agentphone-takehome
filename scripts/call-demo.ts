// Standalone CLI demo of the full flow (place_call -> poll -> get_call -> SMS)
// without needing an MCP client. Usage:
//   npx tsx scripts/call-demo.ts <destinationE164> "<task>" ["<constraint1>", "<constraint2>", ...]
import { placeCall, refreshCall } from "../src/calls.js";
import { randomUUID } from "node:crypto";

async function main() {
  const [destination, task, ...constraints] = process.argv.slice(2);
  if (!destination || !task) {
    console.error('Usage: npx tsx scripts/call-demo.ts <destinationE164> "<task>" ["constraint" ...]');
    process.exit(1);
  }

  console.log(`Placing call to ${destination}...`);
  const record = await placeCall({
    destination,
    task,
    userDetails: { name: "Manav" },
    constraints,
    idempotencyKey: randomUUID(),
  });
  console.log(`Call ID: ${record.callId}, initial status: ${record.status}`);
  if (record.placementError) {
    console.error("Placement failed:", record.placementError);
    process.exit(1);
  }

  const ACTIVE = new Set(["queued", "ringing", "in-progress"]);
  let current = record;
  while (ACTIVE.has(current.status)) {
    await new Promise((r) => setTimeout(r, 4000));
    current = (await refreshCall(current.callId))!;
    console.log(`status: ${current.status}`);
  }

  console.log("\nFinal result:");
  console.log(JSON.stringify(current, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
