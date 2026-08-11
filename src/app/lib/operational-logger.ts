export type OperationalLogLevel = "debug" | "info" | "warn" | "error";

export type OperationalLogger = {
  debug: (event: string, fields?: Record<string, unknown>) => void;
  info: (event: string, fields?: Record<string, unknown>) => void;
  warn: (event: string, fields?: Record<string, unknown>) => void;
  error: (event: string, fields?: Record<string, unknown>) => void;
};

const levels: Record<OperationalLogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const secretKey = /(token|authorization|password|secret|query|api[_-]?key|cookie)/i;

export function redactOperationalValue(value: unknown, key = ""): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: redactText(value.message), code: getErrorCode(value) };
  }

  if (secretKey.test(key)) {
    return "[REDACTED]";
  }

  if (typeof value === "string") {
    return redactText(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactOperationalValue(item, key));
  }

  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      result[childKey] = redactOperationalValue(childValue, childKey);
    }
    return result;
  }

  return value;
}

export function redactText(value: string): string {
  return value
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(/\b[A-Za-z\d_-]{20,}\.[A-Za-z\d_-]{4,}\.[A-Za-z\d_-]{20,}\b/g, "[REDACTED_TOKEN]")
    .replace(/((?:token|password|secret|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/([?&](?:token|password|secret|api[_-]?key|authorization)=)[^&#\s]*/gi, "$1[REDACTED]")
    .replace(/<@!?(\d{5,20})>/g, "<@REDACTED>")
    .replace(/\b\d{17,20}\b/g, "[DISCORD_ID]");
}

export function toSafeOperationalErrorMessage(error: unknown, fallback = "Operational request failed."): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : error && typeof error === "object" && "message" in error && typeof error.message === "string"
          ? error.message
          : fallback;
  return redactText(message).slice(0, 512);
}

export function serializeOperationalLog(level: OperationalLogLevel, event: string, fields: Record<string, unknown> = {}): string {
  const safeFields = redactOperationalValue(fields) as Record<string, unknown>;
  return JSON.stringify({
    ...safeFields,
    ts: new Date().toISOString(),
    level,
    event: redactText(event)
  });
}

export function createOperationalLogger(options: {
  level?: OperationalLogLevel;
  write?: (line: string, level: OperationalLogLevel) => void;
} = {}): OperationalLogger {
  const threshold = levels[options.level ?? "info"];
  const write =
    options.write ??
    ((line, level) =>
      level === "error" ? console.error(line) : level === "warn" ? console.warn(line) : console.info(line));

  return Object.fromEntries((Object.keys(levels) as OperationalLogLevel[]).map((level) => [
    level,
    (event: string, fields?: Record<string, unknown>) => {
      if (levels[level] < threshold) {
        return;
      }
      write(serializeOperationalLog(level, event, fields), level);
    }
  ])) as OperationalLogger;
}

function getErrorCode(error: Error): unknown {
  return "code" in error && (typeof error.code === "string" || typeof error.code === "number") ? error.code : undefined;
}

export const operationalLogger = createOperationalLogger();
