import { describe, expect, it } from "vitest";
import {
  createOperationalLogger,
  redactOperationalValue,
  serializeOperationalLog,
  toSafeOperationalErrorMessage
} from "../src/app/lib/operational-logger.js";

describe("operational logger", () => {
  it("serializes structured records without raw errors or secrets", () => {
    const line = serializeOperationalLog("error", "provider_failed", {
      error: new Error("Authorization: Bearer abc.secret.value?token=private"),
      authorization: "Bearer private",
      guildId: "123456789012345678"
    });

    expect(line).toContain('"level":"error"');
    expect(line).toContain("[REDACTED]");
    expect(line).not.toContain("abc.secret.value");
    expect(line).not.toContain("123456789012345678");
    expect(JSON.parse(line).error).toEqual(expect.objectContaining({ name: "Error" }));
  });

  it("honors level thresholds and returns safe values", () => {
    const lines: string[] = [];
    const logger = createOperationalLogger({ level: "warn", write: (line) => lines.push(line) });
    logger.info("ignored");
    logger.warn("kept", { query: "token=private" });
    expect(lines).toHaveLength(1);
    expect(redactOperationalValue({ privateId: "123456789012345678" })).toEqual({ privateId: "[DISCORD_ID]" });
  });

  it("keeps canonical log metadata and bounds safe provider messages", () => {
    const record = JSON.parse(
      serializeOperationalLog("warn", "real_event", {
        level: "debug",
        event: "spoofed_event",
        ts: "spoofed_timestamp"
      })
    );

    expect(record.level).toBe("warn");
    expect(record.event).toBe("real_event");
    expect(record.ts).not.toBe("spoofed_timestamp");
    expect(toSafeOperationalErrorMessage("token=private " + "x".repeat(700))).toHaveLength(512);
    expect(toSafeOperationalErrorMessage("token=private")).not.toContain("private");
  });
});
