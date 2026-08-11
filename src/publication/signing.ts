import { createHash, createPrivateKey, randomBytes, sign } from "node:crypto";
import type { AgendaProjection, ProjectionSignature } from "./types.js";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

export function canonicalProjectionBytes(issuedAt: string, expiresAt: string, nonce: string, contentSha256: string, body: string): Buffer {
  return Buffer.from(`v1\n${issuedAt}\n${expiresAt}\n${nonce}\n${contentSha256}\n${body}`, "utf8");
}

export function signProjection(projection: AgendaProjection, keyId: string, privateKeyValue: string, now = Date.now()): ProjectionSignature {
  const issuedAt = String(now);
  const expiresAt = String(now + 5 * 60 * 1000);
  const nonce = randomBytes(18).toString("base64url");
  const body = canonicalJson(projection);
  const contentSha256 = createHash("sha256").update(body, "utf8").digest("base64url");
  const key = privateKeyValue.includes("BEGIN")
    ? createPrivateKey(privateKeyValue)
    : createPrivateKey({ key: Buffer.from(privateKeyValue, "base64"), format: "der", type: "pkcs8" });
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Projection signing key must be Ed25519.");
  const signature = sign(null, canonicalProjectionBytes(issuedAt, expiresAt, nonce, contentSha256, body), key).toString("base64url");

  return { schemaVersion: "v1", keyId, issuedAt, expiresAt, nonce, contentSha256, signature, body };
}
