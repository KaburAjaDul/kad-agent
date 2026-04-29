import { loadAppConfig } from "../app/config/env.js";
import { runMigrations } from "../app/repo/migrations.js";
import { createSqliteConnection } from "../app/repo/sqlite.js";

const appConfig = loadAppConfig({ requireDiscord: false });
const db = createSqliteConnection(appConfig.databasePath);

try {
  const appliedMigrations = runMigrations(db);
  console.info(JSON.stringify({ databasePath: appConfig.databasePath, appliedMigrations }));
} finally {
  db.close();
}
