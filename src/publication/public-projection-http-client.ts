import type { ProjectionSignature } from "./types.js";

export type ProjectionFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type PublicProjectionHttpClientOptions = {
  /** Internal authenticated projection ingest endpoint. */
  endpoint: string;
  /** Public read endpoint; intentionally separate because ingest GET is 405. */
  reconciliationEndpoint: string;
  fetchImpl?: ProjectionFetch;
  timeoutMs?: number;
  now?: () => Date;
};

export type ProjectionPostResponse = {
  kind: "response";
  response: Response;
};

export type ProjectionPostFailure = {
  kind: "ambiguous";
  error: Error;
};

export type ProjectionPostResult = ProjectionPostResponse | ProjectionPostFailure;

const DEFAULT_TIMEOUT_MS = 9_000;

/**
 * The client deliberately performs exactly one POST. A response which cannot
 * be observed is ambiguous: retrying here could duplicate a publication.
 */
export class PublicProjectionHttpClient {
  private readonly endpoint: string;
  private readonly reconciliationEndpoint: string;
  private readonly fetchImpl: ProjectionFetch;
  private readonly timeoutMs: number;

  constructor(options: PublicProjectionHttpClientOptions) {
    if (!options.endpoint || !options.reconciliationEndpoint) throw new Error("Projection POST and reconciliation endpoints are required.");
    const postUrl = parseHttpsUrl(options.endpoint, "Projection endpoint", "/internal/v1/projections/agenda");
    const getUrl = parseHttpsUrl(options.reconciliationEndpoint, "Projection reconciliation endpoint", "/api/v1/agenda");
    if (postUrl.origin !== getUrl.origin) throw new Error("Projection endpoints must share the same HTTPS origin.");
    this.endpoint = options.endpoint;
    this.reconciliationEndpoint = options.reconciliationEndpoint;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.timeoutMs = boundedTimeout(options.timeoutMs);
  }

  async post(signature: ProjectionSignature, idempotencyKey: string): Promise<ProjectionPostResult> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Projection request timed out."));
        }, this.timeoutMs);
      });
      const response = await Promise.race([
        this.fetchImpl(this.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-kad-schema-version": signature.schemaVersion,
            "x-kad-key-id": signature.keyId,
            "x-kad-issued-at": signature.issuedAt,
            "x-kad-expires-at": signature.expiresAt,
            "x-kad-nonce": signature.nonce,
            "x-kad-content-sha256": signature.contentSha256,
            "x-kad-signature": signature.signature,
            "x-kad-idempotency-key": idempotencyKey
          },
          body: signature.body,
          signal: controller.signal
        }),
        timeout
      ]);
      return { kind: "response", response };
    } catch (error) {
      return { kind: "ambiguous", error: error instanceof Error ? error : new Error("Projection request failed.") };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async get(): Promise<ProjectionPostResult> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Projection reconciliation request timed out."));
        }, this.timeoutMs);
      });
      const response = await Promise.race([
        this.fetchImpl(this.reconciliationEndpoint, {
          method: "GET",
          headers: { accept: "application/json" },
          signal: controller.signal
        }),
        timeout
      ]);
      return { kind: "response", response };
    } catch (error) {
      return { kind: "ambiguous", error: error instanceof Error ? error : new Error("Projection reconciliation failed.") };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function parseHttpsUrl(value: string, label: string, expectedPath: string): URL {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`${label} must be a valid URL.`); }
  if (parsed.protocol !== "https:") throw new Error(`${label} must use HTTPS.`);
  if (parsed.pathname !== expectedPath || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new Error(`${label} must use the exact ${expectedPath} path without credentials, query, or fragment.`);
  }
  return parsed;
}

function boundedTimeout(value?: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(120_000, Math.max(1, Math.floor(value)));
}
