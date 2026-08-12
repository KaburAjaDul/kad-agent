import { describe, expect, it } from "vitest";
import { createGracefulShutdown, createLeaseLossFailStopHandler } from "../src/app/runtime/bootstrap.js";

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

  it("bounds hung cleanup and continues to release database and health resources", async () => {
    const calls: string[] = [];
    const shutdown = createGracefulShutdown({
      markNotReady: () => calls.push("not-ready"),
      clearInterval: () => calls.push("interval-cleared"),
      waitForInFlightSweep: async () => {
        await new Promise<void>(() => undefined);
      },
      destroyDiscord: async () => {
        calls.push("discord-hung");
        await new Promise<void>(() => undefined);
      },
      closeDatabase: () => calls.push("database-closed"),
      closeHealth: async () => {
        calls.push("health-closed");
      },
      timeoutMs: 5
    });

    await expect(shutdown()).rejects.toThrow("One or more Kaddy shutdown steps failed");
    expect(calls).toEqual(["not-ready", "interval-cleared", "discord-hung", "database-closed", "health-closed"]);
  });

  it("fail-stops once after bounded lease-loss shutdown", async () => {
    const calls: string[] = [];
    let releaseShutdown!: () => void;
    const shutdown = new Promise<void>((resolve) => {
      releaseShutdown = resolve;
    });
    const handler = createLeaseLossFailStopHandler({
      markLeaseLost: () => calls.push("lease-lost"),
      shutdown: () => shutdown,
      failStop: (code) => calls.push(`exit-${code}`)
    });

    handler();
    handler();
    await Promise.resolve();
    expect(calls).toEqual(["lease-lost"]);
    releaseShutdown();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(["lease-lost", "exit-1"]);
  });
});
