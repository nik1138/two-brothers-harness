/**
 * Configuration: CLI flags > environment variables > defaults.
 * Mirrors the original prototype's config module (removed 2026-11-04; see
 * git history) and PROTOCOL.md section 7.
 *
 * base_url and the models default to empty: an `openai` run fails fast with
 * a clear error until they are configured (flags/env), so no endpoint is
 * ever contacted by surprise. `mock` runs need nothing.
 */

export interface Config {
  provider: string;
  baseUrl: string;
  apiKey: string;
  seniorModel: string;
  juniorModel: string;
  seniorSystem: string;
  juniorSystem: string;
  maxRounds: number;
  temperature: number;
  timeout: number;
  retries: number;
  mode: "consult" | "work" | "auto";
  verbose: boolean;
  jsonOut: boolean;
  sessionFile: string;
  resume: boolean;
}

export const DEFAULTS: Omit<Config, "seniorSystem" | "juniorSystem"> = {
  provider: "openai",
  baseUrl: "",
  apiKey: "",
  seniorModel: "",
  juniorModel: "",
  maxRounds: 3,
  temperature: 0.4,
  timeout: 120,
  retries: 6,
  mode: "consult",
  verbose: false,
  jsonOut: false,
  sessionFile: "",
  resume: false,
};

const ENV_KEYS: Record<string, string> = {
  provider: "TWO_BROTHERS_PROVIDER",
  baseUrl: "TWO_BROTHERS_BASE_URL",
  apiKey: "TWO_BROTHERS_API_KEY",
  seniorModel: "TWO_BROTHERS_SENIOR_MODEL",
  juniorModel: "TWO_BROTHERS_JUNIOR_MODEL",
  seniorSystem: "TWO_BROTHERS_SENIOR_SYSTEM",
  juniorSystem: "TWO_BROTHERS_JUNIOR_SYSTEM",
  maxRounds: "TWO_BROTHERS_MAX_ROUNDS",
  temperature: "TWO_BROTHERS_TEMPERATURE",
  timeout: "TWO_BROTHERS_TIMEOUT",
  retries: "TWO_BROTHERS_RETRIES",
  mode: "TWO_BROTHERS_MODE",
  verbose: "TWO_BROTHERS_VERBOSE",
  jsonOut: "TWO_BROTHERS_JSON",
  sessionFile: "TWO_BROTHERS_SESSION_FILE",
  resume: "TWO_BROTHERS_RESUME",
};

const BOOL_FIELDS = ["verbose", "jsonOut", "resume"] as const;
const INT_FIELDS = ["maxRounds", "timeout", "retries"] as const;
const FLOAT_FIELDS = ["temperature"] as const;

function coerce(field: string, value: unknown): unknown {
  if ((BOOL_FIELDS as readonly string[]).includes(field)) {
    if (typeof value === "boolean") return value;
    return String(value).trim().toLowerCase() === "true" ||
      String(value).trim().toLowerCase() === "1" ||
      String(value).trim().toLowerCase() === "yes" ||
      String(value).trim().toLowerCase() === "on";
  }
  if ((INT_FIELDS as readonly string[]).includes(field)) return Number.parseInt(String(value), 10);
  if ((FLOAT_FIELDS as readonly string[]).includes(field)) return Number.parseFloat(String(value));
  return value;
}

export interface Args {
  [key: string]: unknown;
}

export function resolveConfig(args: Args = {}): Config {
  const values: Record<string, unknown> = { ...DEFAULTS };

  for (const [field, envName] of Object.entries(ENV_KEYS)) {
    const raw = process.env[envName];
    if (raw === undefined || raw === "") continue;
    values[field] = coerce(field, raw);
  }

  for (const field of Object.keys(DEFAULTS)) {
    if (field in args && args[field] !== undefined && args[field] !== null) {
      values[field] = coerce(field, args[field]);
    }
  }
  if ("seniorSystem" in args && args.seniorSystem) values.seniorSystem = args.seniorSystem;
  if ("juniorSystem" in args && args.juniorSystem) values.juniorSystem = args.juniorSystem;

  const cfg = values as unknown as Config;
  if (!["consult", "work", "auto"].includes(cfg.mode)) {
    throw new Error(`invalid mode: ${cfg.mode} (use consult|work|auto)`);
  }
  if (!["openai", "mock"].includes(cfg.provider)) {
    throw new Error(`invalid provider: ${cfg.provider} (use openai|mock)`);
  }
  return cfg;
}
