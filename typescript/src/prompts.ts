/**
 * Loading the shared system prompts for senior and junior.
 * Mirrors the original prototype's prompts module (removed 2026-11-04; see
 * git history).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_PATH = path.resolve(here, "..", "..", "shared", "prompts.json");

export interface Prompts {
  senior: string;
  junior: string;
}

export function loadPrompts(): Prompts {
  const raw = readFileSync(PROMPTS_PATH, "utf8");
  const data = JSON.parse(raw) as Partial<Prompts>;
  if (!data.senior || !data.junior) {
    throw new Error(`shared prompts missing keys (${PROMPTS_PATH})`);
  }
  return { senior: data.senior, junior: data.junior };
}

export function systemPrompt(role: string): string {
  const data = loadPrompts();
  if (role === "senior") return data.senior;
  if (role === "junior") return data.junior;
  throw new Error(`unknown role: ${role}`);
}
