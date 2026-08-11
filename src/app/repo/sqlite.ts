import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type SqliteDatabase = DatabaseSync;

export function createSqliteConnection(databasePath: string): SqliteDatabase {
  ensureDatabaseDirectory(databasePath);

  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");

  return db;
}

function ensureDatabaseDirectory(databasePath: string): void {
  if (databasePath === ":memory:") {
    return;
  }

  const directoryPath = dirname(databasePath);

  if (directoryPath === "." || existsSync(directoryPath)) {
    return;
  }

  mkdirSync(directoryPath, { recursive: true });
}
