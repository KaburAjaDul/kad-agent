import { createHmac } from "node:crypto";

export function publicAgendaId(secret: string, discordEventId: string): string {
  if (!secret || !discordEventId) throw new Error("Cannot derive a public agenda ID without required input.");
  const digest = createHmac("sha256", secret).update(discordEventId, "utf8").digest("base64url");
  return `agenda_${digest}`;
}
