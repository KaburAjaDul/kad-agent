import { z } from "zod";

const publicationEnvSchema = z.object({
  DISCORD_BOT_TOKEN: z.string().trim().min(1),
  DISCORD_TARGET_GUILD_ID: z.string().trim().regex(/^\d{17,20}$/),
  DISCORD_TARGET_GUILD_NAME: z.string().trim().min(1),
  KAD_PROJECTION_ENDPOINT: z.string().trim().url(),
  KAD_PROJECTION_KEY_ID: z.string().trim().regex(/^[A-Za-z0-9._-]{1,100}$/),
  KAD_PROJECTION_SIGNING_PRIVATE_KEY: z.string().trim().min(1),
  KAD_PUBLIC_ID_KEY: z.string().trim().min(16),
  PUBLICATION_APPROVED: z.literal("true"),
  // Staging may deliberately omit an unclassified event from the public
  // snapshot while the event is reviewed. The default remains fail-closed.
  PUBLICATION_UNKNOWN_EVENT_POLICY: z.enum(["reject", "skip"]).default("reject")
});

export type PublicationConfig = z.infer<typeof publicationEnvSchema>;

export function loadPublicationConfig(env: NodeJS.ProcessEnv = process.env): PublicationConfig {
  const parsed = publicationEnvSchema.safeParse(env);

  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join(".") || "environment");
    throw new Error(`Publication configuration is invalid or incomplete: ${[...new Set(fields)].join(", ")}`);
  }

  const endpoint = new URL(parsed.data.KAD_PROJECTION_ENDPOINT);
  if (endpoint.protocol !== "https:") {
    throw new Error("KAD_PROJECTION_ENDPOINT must use HTTPS.");
  }

  return parsed.data;
}
