import { loadPublicationConfig } from "../publication/config.js";
import { buildAgendaPublication, postAgendaPublication, publicationSummary, UnsupportedEventsError } from "../publication/publish.js";

const dryRun = process.argv.slice(2).includes("--dry-run");

async function main(): Promise<void> {
  const config = loadPublicationConfig();
  const result = await buildAgendaPublication({
    token: config.DISCORD_BOT_TOKEN,
    guildId: config.DISCORD_TARGET_GUILD_ID,
    guildName: config.DISCORD_TARGET_GUILD_NAME,
    keyId: config.KAD_PROJECTION_KEY_ID,
    signingPrivateKey: config.KAD_PROJECTION_SIGNING_PRIVATE_KEY,
    publicIdKey: config.KAD_PUBLIC_ID_KEY
  });

  if (!dryRun) await postAgendaPublication(config.KAD_PROJECTION_ENDPOINT, result);

  const summary = publicationSummary(result);
  console.log(JSON.stringify({
    status: dryRun ? "validated" : "published",
    mode: dryRun ? "dry-run" : "publish",
    entries: summary.entries,
    categories: summary.categories,
    ...(dryRun ? {} : { revision: summary.revision })
  }));
}

main().catch((error: unknown) => {
  if (error instanceof UnsupportedEventsError) {
    console.error(JSON.stringify({ status: "rejected", code: "unsupported_events", count: error.count }));
  } else {
    const message = error instanceof Error ? error.message : "Publication failed.";
    console.error(JSON.stringify({ status: "failed", code: "publication_failed", message }));
  }
  process.exitCode = 1;
});
