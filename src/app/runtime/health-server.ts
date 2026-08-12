import { createServer, type Server } from "node:http";
import type { OperationalMetrics } from "./operational-metrics.js";

export type HealthState = { ready: boolean };
export type HealthServer = {
  server: Server;
  address: { host: string; port: number };
  setReady: (ready: boolean) => void;
  isReady: () => boolean;
  close: () => Promise<void>;
};

export function createHealthServer(options: { host?: string; port?: number; state?: HealthState; metrics?: OperationalMetrics; exposePrivateMetrics?: boolean } = {}): HealthServer {
  const host = options.host ?? "127.0.0.1";
  const state = options.state ?? { ready: false };
  const healthAddress = { host, port: options.port ?? 0 };

  const server = createServer((request, response) => {
    if (request.url === "/healthz") {
      writeJson(response, 200, { status: "ok" });
      return;
    }

    if (request.url === "/readyz") {
      writeJson(response, state.ready ? 200 : 503, { status: state.ready ? "ready" : "not_ready" });
      return;
    }

    if (request.url === "/metrics") {
      if (!isLoopbackHost(host) && !options.exposePrivateMetrics) {
        writeJson(response, 404, { status: "not_found" });
        return;
      }
      const body = options.metrics?.renderPrometheus() ?? "";
      response.writeHead(200, {
        "cache-control": "no-store",
        connection: "close",
        "content-type": "text/plain; version=0.0.4; charset=utf-8",
        "x-content-type-options": "nosniff"
      });
      response.end(body);
      return;
    }

    writeJson(response, 404, { status: "not_found" });
  });

  server.listen(healthAddress.port, host, () => {
    const address = server.address();
    healthAddress.port = typeof address === "object" && address ? address.port : healthAddress.port;
  });

  return {
    server,
    address: healthAddress,
    setReady: (ready) => {
      state.ready = ready;
    },
    isReady: () => state.ready,
    close: async () => {
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  };
}

export async function startHealthServer(options: { host?: string; port?: number; state?: HealthState; metrics?: OperationalMetrics; exposePrivateMetrics?: boolean } = {}): Promise<HealthServer> {
  const health = createHealthServer(options);
  await waitForHealthServer(health.server);
  health.address.port = (health.server.address() as { port: number }).port;
  return health;
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

async function waitForHealthServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (server.listening) {
      resolve();
      return;
    }
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
  });
}

function writeJson(response: import("node:http").ServerResponse, status: number, body: Record<string, string>): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    connection: "close",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff"
  });
  response.end(JSON.stringify(body));
}
