import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, "..");

// Load .env from the project root explicitly, not process.cwd() -- an MCP
// client (Claude Desktop/Code) typically launches this server with its own
// working directory, not this project's, so the default cwd-relative
// dotenv lookup would silently find nothing and every env var would be
// missing with no clear error.
dotenv.config({ path: path.join(ROOT_DIR, ".env") });

export const DATA_DIR = path.join(ROOT_DIR, "data");
export const CONFIG_PATH = path.join(DATA_DIR, "config.json");
export const CALLS_PATH = path.join(DATA_DIR, "calls.json");

export interface SetupConfig {
  agentId: string;
  numberId: string;
  phoneNumber: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`
    );
  }
  return value;
}

function readSetupConfig(): Partial<SetupConfig> {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

export function writeSetupConfig(config: SetupConfig): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

export const env = {
  get apiKey() {
    return required("AGENTPHONE_API_KEY");
  },
  get userPhoneNumber() {
    return process.env.USER_PHONE_NUMBER || "";
  },
  get agentId() {
    return process.env.AGENTPHONE_AGENT_ID || readSetupConfig().agentId || "";
  },
  get numberId() {
    return process.env.AGENTPHONE_NUMBER_ID || readSetupConfig().numberId || "";
  },
  get pollIntervalMs() {
    return Number(process.env.POLL_INTERVAL_MS || 5000);
  },
  get smsRetryIntervalMs() {
    return Number(process.env.SMS_RETRY_INTERVAL_MS || 10 * 60 * 1000);
  },
};
