import { loadAppConfig } from "../app/config/env.js";
import { runMigrations } from "../app/repo/migrations.js";
import { seedFoundationData } from "../app/repo/seeds.js";
import { createSqliteConnection } from "../app/repo/sqlite.js";

const appConfig = loadAppConfig({ requireDiscord: false });
const db = createSqliteConnection(appConfig.databasePath);

try {
  runMigrations(db);
  const insertedCount = seedFoundationData(db);
  console.info(JSON.stringify({ databasePath: appConfig.databasePath, insertedCount }));
} finally {
  db.close();
}
