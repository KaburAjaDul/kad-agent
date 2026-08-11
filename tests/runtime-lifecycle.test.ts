import { describe, expect, it } from "vitest";
import { createGracefulShutdown } from "../src/app/runtime/bootstrap.js";

describe("runtime lifecycle", () => {
  it("marks not ready, drains once, and closes every resource in order", async () => {
    const calls: string[] = [];
    const shutdown = createGracefulShutdown({
      markNotReady: () => calls.push("not-ready"),
      clearInterval: () => calls.push("interval-cleared"),
      waitForInFlightSweep: async () => {
        calls.push("sweep-drained");
      },
      destroyDiscord: async () => {
        calls.push("discord-closed");
      },
      closeDatabase: () => calls.push("database-closed"),
      closeHealth: async () => {
        calls.push("health-closed");
      }
    });

    const first = shutdown();
    const second = shutdown();
    expect(second).toBe(first);
    await Promise.all([first, second]);

    expect(calls).toEqual([
      "not-ready",
      "interval-cleared",
      "sweep-drained",
      "discord-closed",
      "database-closed",
      "health-closed"
    ]);
  });

  it("continues cleanup and reports aggregated failures", async () => {
    const calls: string[] = [];
    const shutdown = createGracefulShutdown({
      markNotReady: () => calls.push("not-ready"),
      clearInterval: () => calls.push("interval-cleared"),
      waitForInFlightSweep: async () => {
        calls.push("sweep-failed");
        throw new Error("sweep failure");
      },
      destroyDiscord: async () => {
        calls.push("discord-closed");
      },
      closeDatabase: () => calls.push("database-closed"),
      closeHealth: async () => {
        calls.push("health-closed");
      }
    });

    await expect(shutdown()).rejects.toThrow("One or more Kaddy shutdown steps failed");
    expect(calls).toEqual([
      "not-ready",
      "interval-cleared",
      "sweep-failed",
      "discord-closed",
      "database-closed",
      "health-closed"
    ]);
  });
});
