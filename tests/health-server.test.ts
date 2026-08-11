import { describe, expect, it } from "vitest";
import { startHealthServer } from "../src/app/runtime/health-server.js";

describe("health server", () => {
  it("binds loopback by default and exposes explicit health/readiness", async () => {
    const health = await startHealthServer({ port: 0 });
    try {
      expect(health.address.host).toBe("127.0.0.1");
      const notReady = await fetch(`http://${health.address.host}:${health.address.port}/readyz`);
      expect(notReady.status).toBe(503);
      expect(notReady.headers.get("cache-control")).toBe("no-store");
      expect(notReady.headers.get("x-content-type-options")).toBe("nosniff");
      health.setReady(true);
      const ready = await fetch(`http://${health.address.host}:${health.address.port}/readyz`);
      expect(ready.status).toBe(200);
      const healthy = await fetch(`http://${health.address.host}:${health.address.port}/healthz`);
      expect(healthy.status).toBe(200);
    } finally {
      await health.close();
    }
  });
});
