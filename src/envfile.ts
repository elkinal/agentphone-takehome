import fs from "node:fs";
import path from "node:path";
import { ROOT_DIR } from "./config.js";

const ENV_PATH = path.join(ROOT_DIR, ".env");

/** Updates (or appends) a single KEY=value line in .env, preserving everything else. */
export function upsertEnvVar(key: string, value: string): void {
  let lines: string[] = [];
  try {
    lines = fs.readFileSync(ENV_PATH, "utf8").split("\n");
  } catch {
    lines = [];
  }
  const prefix = `${key}=`;
  let found = false;
  lines = lines.map((line) => {
    if (line.startsWith(prefix)) {
      found = true;
      return `${prefix}${value}`;
    }
    return line;
  });
  if (!found) lines.push(`${prefix}${value}`);
  fs.writeFileSync(ENV_PATH, lines.join("\n"));
}
