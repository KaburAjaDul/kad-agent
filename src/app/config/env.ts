import { config as loadDotEnv } from "dotenv";
import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
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
  KADDY_RUNTIME_MODE: z.enum(["observe", "operate"]).default("observe"),
  KADDY_PUBLICATION_MODE: z.enum(["disabled", "observe", "active"]).default("disabled"),
  KADDY_PUBLICATION_CUTOVER_CONFIRMED: stringBooleanSchema.default("false"),
  DISCORD_TARGET_GUILD_ID: z.string().trim().optional(),
  DISCORD_TARGET_GUILD_NAME: z.string().trim().optional(),
  KAD_PROJECTION_ENDPOINT: z.string().trim().optional(),
  KAD_PUBLIC_AGENDA_ENDPOINT: z.string().trim().optional(),
  KAD_PROJECTION_KEY_ID: z.string().trim().optional(),
  KAD_PROJECTION_SIGNING_PRIVATE_KEY_FILE: z.string().trim().min(1).optional(),
  KAD_PUBLIC_ID_KEY_FILE: z.string().trim().min(1).optional(),
  DATABASE_PATH: z.string().trim().min(1).default("./data/kad-agent.sqlite"),
  JOB_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(30000),
  KADDY_PUBLICATION_OBSERVATION_INTERVAL_MS: z.coerce.number().int().positive().default(60000),
  KADDY_PUBLICATION_PUBLISH_INTERVAL_MS: z.coerce.number().int().positive().default(30000),
  KADDY_PUBLICATION_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(9000),
  KADDY_PUBLICATION_LEASE_DURATION_MS: z.coerce.number().int().positive().default(30000),
  KADDY_PUBLICATION_LEASE_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(10000),
  STARTUP_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  RUNTIME_LEASE_DURATION_MS: z.coerce.number().int().positive().default(30000),
  RUNTIME_LEASE_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(10000),
  HEALTH_HOST: z.string().trim().min(1).default("127.0.0.1"),
  HEALTH_PORT: z.coerce.number().int().nonnegative().max(65535).default(0),
  METRICS_EXPOSE_PRIVATE: stringBooleanSchema.default("false"),
  DISCORD_APP_ID: z.string().trim().optional(),
  DISCORD_BOT_TOKEN: z.string().trim().optional(),
  DISCORD_ALLOWED_GUILD_IDS: z.string().optional(),
  DISCORD_APP_ID_FILE: z.string().trim().min(1).optional(),
  DISCORD_BOT_TOKEN_FILE: z.string().trim().min(1).optional(),
  DISCORD_ALLOWED_GUILD_IDS_FILE: z.string().trim().min(1).optional()
});

export type AppConfig = {
  nodeEnv: "development" | "test" | "production";
  logLevel: "debug" | "info" | "warn" | "error";
  botDryRun: boolean;
  runtimeMode?: "observe" | "operate";
  publication?: PublicationRuntimeConfig;
  databasePath: string;
  jobPollIntervalMs: number;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  runtimeLease?: {
    durationMs: number;
    heartbeatIntervalMs: number;
  };
  health: {
    host: string;
    port: number;
  };
  metricsExposePrivate?: boolean;
  discord: {
    appId?: string;
    botToken?: string;
    allowedGuildIds: string[];
  };
};

export type PublicationRuntimeMode = "disabled" | "observe" | "active";

export type PublicationRuntimeConfig = {
  mode: PublicationRuntimeMode;
  cutoverConfirmed: boolean;
  targetGuildId?: string;
  targetGuildName?: string;
  endpoint?: string;
  publicAgendaEndpoint?: string;
  keyId?: string;
  signingPrivateKeyFile?: string;
  publicIdKeyFile?: string;
  signingPrivateKey?: string;
  publicIdKey?: string;
  observationIntervalMs: number;
  publishIntervalMs: number;
  requestTimeoutMs: number;
  leaseDurationMs: number;
  leaseHeartbeatIntervalMs: number;
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

  const rawEnv = {
    ...(options.env ?? process.env),
    ...(options.overrides ?? {})
  };
  if (emptyToUndefined(rawEnv.KAD_PROJECTION_SIGNING_PRIVATE_KEY) || emptyToUndefined(rawEnv.KAD_PUBLIC_ID_KEY)) {
    throw new Error("Publication signing keys must use *_FILE configuration; direct key values are not accepted.");
  }
  const parsed = envSchema.parse(rawEnv);
  const requireDiscord = options.requireDiscord ?? !parsed.BOT_DRY_RUN;

  const discord = {
    appId: resolveSecretSource("DISCORD_APP_ID", parsed.DISCORD_APP_ID, parsed.DISCORD_APP_ID_FILE),
    botToken: resolveSecretSource("DISCORD_BOT_TOKEN", parsed.DISCORD_BOT_TOKEN, parsed.DISCORD_BOT_TOKEN_FILE),
    allowedGuildIds: parseAllowedGuildIds(resolveSecretSource("DISCORD_ALLOWED_GUILD_IDS", parsed.DISCORD_ALLOWED_GUILD_IDS, parsed.DISCORD_ALLOWED_GUILD_IDS_FILE))
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

  const publication = loadPublicationRuntimeConfig(parsed, options.cwd ?? process.cwd());
  if (publication.mode === "active" && parsed.KADDY_RUNTIME_MODE !== "operate") {
    throw new Error("KADDY_RUNTIME_MODE=operate is required for active publication.");
  }
  if (publication.mode !== "disabled"
      && publication.targetGuildId
      && !discord.allowedGuildIds.includes(publication.targetGuildId)) {
    throw new Error("DISCORD_TARGET_GUILD_ID must be included in DISCORD_ALLOWED_GUILD_IDS.");
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    logLevel: parsed.LOG_LEVEL,
    botDryRun: parsed.BOT_DRY_RUN,
    runtimeMode: parsed.KADDY_RUNTIME_MODE,
    publication,
    databasePath: resolve(options.cwd ?? process.cwd(), parsed.DATABASE_PATH),
    jobPollIntervalMs: parsed.JOB_POLL_INTERVAL_MS,
    startupTimeoutMs: parsed.STARTUP_TIMEOUT_MS,
    shutdownTimeoutMs: parsed.SHUTDOWN_TIMEOUT_MS,
    runtimeLease: {
      durationMs: parsed.RUNTIME_LEASE_DURATION_MS,
      heartbeatIntervalMs: Math.min(parsed.RUNTIME_LEASE_HEARTBEAT_INTERVAL_MS, Math.max(1, parsed.RUNTIME_LEASE_DURATION_MS - 1))
    },
    health: {
      host: parsed.HEALTH_HOST,
      port: parsed.HEALTH_PORT
    },
    metricsExposePrivate: parsed.METRICS_EXPOSE_PRIVATE,
    discord
  };
}

function loadPublicationRuntimeConfig(
  parsed: z.infer<typeof envSchema>,
  cwd: string
): PublicationRuntimeConfig {
  const mode = parsed.KADDY_PUBLICATION_MODE;
  const targetGuildId = emptyToUndefined(parsed.DISCORD_TARGET_GUILD_ID);
  const targetGuildName = emptyToUndefined(parsed.DISCORD_TARGET_GUILD_NAME);
  const endpoint = emptyToUndefined(parsed.KAD_PROJECTION_ENDPOINT);
  const publicAgendaEndpoint = emptyToUndefined(parsed.KAD_PUBLIC_AGENDA_ENDPOINT);
  const keyId = emptyToUndefined(parsed.KAD_PROJECTION_KEY_ID);
  const signingPrivateKeyFile = resolvePathSource(parsed.KAD_PROJECTION_SIGNING_PRIVATE_KEY_FILE, cwd);
  const publicIdKeyFile = resolvePathSource(parsed.KAD_PUBLIC_ID_KEY_FILE, cwd);

  if (targetGuildId && !/^\d{17,20}$/.test(targetGuildId)) {
    throw new Error("DISCORD_TARGET_GUILD_ID must be a Discord snowflake ID.");
  }
  if (endpoint) {
    let parsedEndpoint: URL;
    try {
      parsedEndpoint = new URL(endpoint);
    } catch {
      throw new Error("KAD_PROJECTION_ENDPOINT must be a valid URL.");
    }
    if (parsedEndpoint.protocol !== "https:") {
      throw new Error("KAD_PROJECTION_ENDPOINT must use HTTPS.");
    }
    if (parsedEndpoint.pathname !== "/internal/v1/projections/agenda" || parsedEndpoint.search || parsedEndpoint.hash
        || parsedEndpoint.username || parsedEndpoint.password) {
      throw new Error("KAD_PROJECTION_ENDPOINT must use the exact /internal/v1/projections/agenda path without credentials, query, or fragment.");
    }
  }
  if (publicAgendaEndpoint) {
    let parsedPublicEndpoint: URL;
    try {
      parsedPublicEndpoint = new URL(publicAgendaEndpoint);
    } catch {
      throw new Error("KAD_PUBLIC_AGENDA_ENDPOINT must be a valid URL.");
    }
    if (parsedPublicEndpoint.protocol !== "https:") {
      throw new Error("KAD_PUBLIC_AGENDA_ENDPOINT must use HTTPS.");
    }
    if (parsedPublicEndpoint.pathname !== "/api/v1/agenda" || parsedPublicEndpoint.search || parsedPublicEndpoint.hash
        || parsedPublicEndpoint.username || parsedPublicEndpoint.password) {
      throw new Error("KAD_PUBLIC_AGENDA_ENDPOINT must use the exact /api/v1/agenda path without credentials, query, or fragment.");
    }
  }
  if (keyId && !/^[A-Za-z0-9._-]{1,100}$/.test(keyId)) {
    throw new Error("KAD_PROJECTION_KEY_ID is invalid.");
  }

  let signingPrivateKey: string | undefined;
  let publicIdKey: string | undefined;
  if (mode !== "disabled" && (!targetGuildId || !targetGuildName)) {
    throw new Error("DISCORD_TARGET_GUILD_ID and DISCORD_TARGET_GUILD_NAME are required when publication is enabled.");
  }

  if (mode !== "disabled") {
    if (!endpoint || !publicAgendaEndpoint) {
      throw new Error("KAD_PROJECTION_ENDPOINT and KAD_PUBLIC_AGENDA_ENDPOINT are required when publication is enabled.");
    }
    if (new URL(endpoint).origin !== new URL(publicAgendaEndpoint).origin) {
      throw new Error("KAD_PROJECTION_ENDPOINT and KAD_PUBLIC_AGENDA_ENDPOINT must share one HTTPS origin.");
    }
    if (!publicIdKeyFile) {
      throw new Error("KAD_PUBLIC_ID_KEY_FILE is required when publication is enabled.");
    }
    publicIdKey = readRequiredFile("KAD_PUBLIC_ID_KEY_FILE", publicIdKeyFile);
    if (publicIdKey.length < 16) {
      throw new Error("KAD_PUBLIC_ID_KEY_FILE must contain at least 16 characters.");
    }
  }

  if (mode === "active") {
    if (parsed.BOT_DRY_RUN) {
      throw new Error("Active publication cannot be enabled while BOT_DRY_RUN=true.");
    }
    if (!parsed.KADDY_PUBLICATION_CUTOVER_CONFIRMED) {
      throw new Error("KADDY_PUBLICATION_CUTOVER_CONFIRMED=true is required for active publication.");
    }
    if (!keyId) {
      throw new Error("KAD_PROJECTION_KEY_ID is required for active publication.");
    }
    if (!signingPrivateKeyFile) {
      throw new Error("KAD_PROJECTION_SIGNING_PRIVATE_KEY_FILE is required for active publication.");
    }
    signingPrivateKey = readRequiredFile("KAD_PROJECTION_SIGNING_PRIVATE_KEY_FILE", signingPrivateKeyFile);
    assertEd25519PrivateKey(signingPrivateKey);
  }

  return {
    mode,
    cutoverConfirmed: parsed.KADDY_PUBLICATION_CUTOVER_CONFIRMED,
    targetGuildId,
    targetGuildName,
    endpoint,
    publicAgendaEndpoint,
    keyId,
    signingPrivateKeyFile,
    publicIdKeyFile,
    signingPrivateKey,
    publicIdKey,
    observationIntervalMs: parsed.KADDY_PUBLICATION_OBSERVATION_INTERVAL_MS,
    publishIntervalMs: parsed.KADDY_PUBLICATION_PUBLISH_INTERVAL_MS,
    requestTimeoutMs: parsed.KADDY_PUBLICATION_REQUEST_TIMEOUT_MS,
    leaseDurationMs: parsed.KADDY_PUBLICATION_LEASE_DURATION_MS,
    leaseHeartbeatIntervalMs: Math.min(
      parsed.KADDY_PUBLICATION_LEASE_HEARTBEAT_INTERVAL_MS,
      Math.max(1, parsed.KADDY_PUBLICATION_LEASE_DURATION_MS - 1)
    )
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

function resolveSecretSource(name: string, value: string | undefined, filePath: string | undefined): string | undefined {
  const directValue = emptyToUndefined(value);
  const directFilePath = emptyToUndefined(filePath);
  if (directValue && directFilePath) {
    throw new Error(`${name} and ${name}_FILE cannot both be set.`);
  }
  if (!directFilePath) return directValue;
  try {
    const fileValue = readFileSync(directFilePath, "utf8").trim();
    return fileValue || undefined;
  } catch {
    throw new Error(`${name}_FILE could not be read.`);
  }
}

function resolvePathSource(filePath: string | undefined, cwd: string): string | undefined {
  const value = emptyToUndefined(filePath);
  return value ? resolve(cwd, value) : undefined;
}

function readRequiredFile(name: string, filePath: string): string {
  try {
    const value = readFileSync(filePath, "utf8").trim();
    if (!value) throw new Error("empty");
    return value;
  } catch {
    throw new Error(`${name} could not be read.`);
  }
}

function assertEd25519PrivateKey(value: string): void {
  try {
    const key = createPrivateKey(value);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("wrong key type");
  } catch {
    throw new Error("KAD_PROJECTION_SIGNING_PRIVATE_KEY_FILE must contain a valid Ed25519 private key.");
  }
}
