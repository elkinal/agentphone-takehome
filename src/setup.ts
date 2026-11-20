import "./config.js";
import { getClient } from "./agentphone.js";
import { writeSetupConfig } from "./config.js";

const AGENT_NAME = "Call Assistant";

async function main() {
  const client = getClient();

  console.log("Checking for an existing phone number...");
  const numbers = await client.numbers.listNumbers({}, { queryParams: { limit: 10 } });
  let number = (numbers as any).data?.[0];
  if (!number) {
    console.log("No numbers found -- provisioning one (this charges your AgentPhone balance)...");
    number = await client.numbers.createNumber();
  }
  console.log(`Using number ${number.phoneNumber ?? number.id} (${number.id})`);
  if (number.outboundSms && number.outboundSms !== "enabled") {
    console.log(
      `  Note: outboundSms status is "${number.outboundSms}" -- the SMS report may not send until this becomes "enabled".`
    );
  }

  console.log("Checking for an existing agent...");
  const agents = await client.agents.listAgents({}, { queryParams: { limit: 50 } });
  let agent = (agents as any).data?.find((a: any) => a.name === AGENT_NAME);
  if (!agent) {
    console.log(`Creating agent "${AGENT_NAME}"...`);
    agent = await client.agents.createAgent({
      name: AGENT_NAME,
      description: "Places outbound task calls on behalf of the user and reports back.",
      voiceMode: "hosted",
      systemPrompt: "You are a helpful phone assistant. The specific task is provided per call.",
      beginMessage: "Hello!",
    });
  }
  console.log(`Using agent ${agent.name} (${agent.id})`);

  const attachedNumberIds: string[] = (agent.numbers || []).map((n: any) => n.id);
  if (!attachedNumberIds.includes(number.id)) {
    console.log("Attaching number to agent...");
    await client.agents.attachNumberToAgent({ agent_id: agent.id, numberId: number.id });
  }

  writeSetupConfig({ agentId: agent.id, numberId: number.id, phoneNumber: number.phoneNumber ?? "" });

  console.log("\nSetup complete. Saved to data/config.json:");
  console.log(`  agentId: ${agent.id}`);
  console.log(`  numberId: ${number.id}`);
  console.log(`  phoneNumber: ${number.phoneNumber ?? "(unknown)"}`);
  console.log(
    "\nNote: outbound SMS (used for the final report) requires 10DLC registration on your AgentPhone " +
      "account. If you haven't done this yet, visit https://agentphone.ai/register or call POST /v1/register. " +
      "Calls will still work without it; only the SMS report will fail until registration completes."
  );
  console.log("\nSet USER_PHONE_NUMBER in .env to where you want result SMS messages sent.");
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
