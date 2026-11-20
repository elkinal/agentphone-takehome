// Real, screenshot-able opt-in flow: the account holder types their own
// number and is shown explicit consent language before it's saved as the
// SMS notification recipient. This is the evidence referenced by
// `opt_in_image_url` in AgentPhone's A2P 10DLC registration.
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { upsertEnvVar } from "./envfile.js";
import { isE164 } from "./phone.js";

const BRAND = "Call Assistant";

async function main() {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  console.log(`\n${BRAND} -- SMS opt-in\n`);
  console.log(
    `${BRAND} places phone calls on your behalf and sends you exactly one SMS per call, reporting ` +
      `whether the task succeeded and what was confirmed. No other messages are sent, and your number is not ` +
      `shared with anyone else.\n`
  );
  console.log("Message and data rates may apply. Reply STOP at any time to unsubscribe.\n");

  let phone = "";
  while (!isE164(phone)) {
    phone = (await rl.question("Enter your phone number in E.164 format (e.g. +15551234567): ")).trim();
    if (!isE164(phone)) console.log("That doesn't look like E.164 (e.g. +15551234567). Try again.");
  }

  console.log(
    `\nBy continuing, you agree to receive SMS messages from ${BRAND} at ${phone} with the results of ` +
      `calls placed on your behalf. Reply STOP to unsubscribe.\n`
  );
  const confirm = (await rl.question('Type "yes" to confirm and opt in: ')).trim().toLowerCase();
  rl.close();

  if (confirm !== "yes") {
    console.log("\nNot confirmed -- no number was saved.");
    process.exit(1);
  }

  upsertEnvVar("USER_PHONE_NUMBER", phone);
  console.log(`\nConfirmed. SMS call-result reports will be sent to ${phone}. Saved to .env.`);
}

main();
