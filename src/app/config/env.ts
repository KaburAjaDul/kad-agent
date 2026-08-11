import { config as loadDotEnv } from "dotenv";
import { resolve } from "node:path";
import { z } from "zod";

const stringBooleanSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine((value) => ["true", "false", "1", "0", "yes", "no"].includes(value), {
    message: "must be a boolean-like string"
  })
  .transform((value) => ["true", "1", "yes"].includes(value));

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  BOT_DRY_RUN: stringBooleanSchema.default("false"),
  DATABASE_PATH: z.string().trim().min(1).default("./data/kad-agent.sqlite"),
  JOB_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(30000),
  HEALTH_HOST: z.string().trim().min(1).default("127.0.0.1"),
  HEALTH_PORT: z.coerce.number().int().nonnegative().max(65535).default(0),
  DISCORD_APP_ID: z.string().trim().optional(),
  DISCORD_BOT_TOKEN: z.string().trim().optional(),
  DISCORD_ALLOWED_GUILD_IDS: z.string().optional()
});

export type AppConfig = {
  nodeEnv: "development" | "test" | "production";
  logLevel: "debug" | "info" | "warn" | "error";
  botDryRun: boolean;
  databasePath: string;
  jobPollIntervalMs: number;
  health: {
    host: string;
    port: number;
  };
  discord: {
    appId?: string;
    botToken?: string;
    allowedGuildIds: string[];
  };
};

type LoadAppConfigOptions = {
  env?: NodeJS.ProcessEnv;
  overrides?: Partial<NodeJS.ProcessEnv>;
  cwd?: string;
  loadEnvFile?: boolean;
  requireDiscord?: boolean;
};

export function loadAppConfig(options: LoadAppConfigOptions = {}): AppConfig {
  if (options.loadEnvFile ?? !options.env) {
    loadDotEnv();
  }

  const parsed = envSchema.parse({
    ...(options.env ?? process.env),
    ...(options.overrides ?? {})
  });
  const requireDiscord = options.requireDiscord ?? !parsed.BOT_DRY_RUN;

  const discord = {
    appId: emptyToUndefined(parsed.DISCORD_APP_ID),
    botToken: emptyToUndefined(parsed.DISCORD_BOT_TOKEN),
    allowedGuildIds: parseAllowedGuildIds(parsed.DISCORD_ALLOWED_GUILD_IDS)
  };

  if (requireDiscord) {
    if (!discord.appId) {
      throw new Error("DISCORD_APP_ID is required when BOT_DRY_RUN is false.");
    }

    if (!discord.botToken) {
      throw new Error("DISCORD_BOT_TOKEN is required when BOT_DRY_RUN is false.");
    }

    if (discord.allowedGuildIds.length === 0) {
      throw new Error("DISCORD_ALLOWED_GUILD_IDS is required and must contain at least one guild ID when BOT_DRY_RUN is false.");
    }
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    logLevel: parsed.LOG_LEVEL,
    botDryRun: parsed.BOT_DRY_RUN,
    databasePath: resolve(options.cwd ?? process.cwd(), parsed.DATABASE_PATH),
    jobPollIntervalMs: parsed.JOB_POLL_INTERVAL_MS,
    health: {
      host: parsed.HEALTH_HOST,
      port: parsed.HEALTH_PORT
    },
    discord
  };
}

export function parseAllowedGuildIds(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  const ids = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  for (const id of ids) {
    if (!/^\d{17,20}$/.test(id)) {
      throw new Error("DISCORD_ALLOWED_GUILD_IDS must contain comma-separated Discord snowflake IDs.");
    }
  }

  return [...new Set(ids)];
}

function emptyToUndefined(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  return value.trim() === "" ? undefined : value;
}
