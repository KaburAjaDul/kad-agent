import { loadAppConfig } from "../app/config/env.js";
import { createOperationalLogger } from "../app/lib/operational-logger.js";
import { runMigrations } from "../app/repo/migrations.js";
import { createSqliteConnection } from "../app/repo/sqlite.js";

const appConfig = loadAppConfig({ requireDiscord: false });
const logger = createOperationalLogger({ level: appConfig.logLevel });
const db = createSqliteConnection(appConfig.databasePath);

try {
  const appliedMigrations = runMigrations(db);
  logger.info("database_migrations_complete", { appliedMigrations });
} finally {
  db.close();
}
