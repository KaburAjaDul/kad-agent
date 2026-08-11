import { loadAppConfig } from "../app/config/env.js";
import { createOperationalLogger } from "../app/lib/operational-logger.js";
import { runMigrations } from "../app/repo/migrations.js";
import { seedFoundationData } from "../app/repo/seeds.js";
import { createSqliteConnection } from "../app/repo/sqlite.js";

const appConfig = loadAppConfig({ requireDiscord: false });
const logger = createOperationalLogger({ level: appConfig.logLevel });
const db = createSqliteConnection(appConfig.databasePath);

try {
  runMigrations(db);
  const insertedCount = seedFoundationData(db);
  logger.info("foundation_seed_complete", { insertedCount });
} finally {
  db.close();
}
