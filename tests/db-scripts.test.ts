import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteConnection } from "../src/app/repo/sqlite.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const tempDirectories: string[] = [];

afterEach(() => {
  while (tempDirectories.length > 0) {
    const directory = tempDirectories.pop();

    if (directory) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

describe("DB-only scripts", () => {
  it("runs migrate without Discord credentials", () => {
    const databasePath = createTempDatabasePath("kad-agent-migrate-");
    const stdout = runDbScript("migrate", databasePath);
    const result = JSON.parse(stdout.trim()) as {
      event: string;
      level: string;
      appliedMigrations: string[];
    };

    expect(result).toMatchObject({
      event: "database_migrations_complete",
      level: "info",
      appliedMigrations: [
        "0001_foundation",
        "0002_event_slice_e1",
        "0003_event_slice_e1_setup_config",
        "0004_event_slice_e1_5_host_snapshot",
        "0005_event_slice_e2_assigned_language_clubs",
        "0006_event_slice_e2_reminder_delivery",
        "0007_runtime_durability",
        "0008_discord_observations_and_projection",
        "0009_public_projection_outbox_durability"
      ]
    });
    expect(stdout).not.toContain(databasePath);
    expect(selectCount(databasePath, "schema_migrations")).toBe(9);
  });

  it("runs seed without Discord credentials", () => {
    const databasePath = createTempDatabasePath("kad-agent-seed-");
    const stdout = runDbScript("seed", databasePath);
    const result = JSON.parse(stdout.trim()) as {
      event: string;
      level: string;
      insertedCount: number;
    };

    expect(result).toMatchObject({
      event: "foundation_seed_complete",
      level: "info",
      insertedCount: 1
    });
    expect(stdout).not.toContain(databasePath);
    expect(selectCount(databasePath, "event_templates")).toBe(1);
  });

  it("runs db:init without Discord credentials", () => {
    const databasePath = createTempDatabasePath("kad-agent-db-init-");

    runDbScript("db:init", databasePath);

    expect(selectCount(databasePath, "schema_migrations")).toBe(9);
    expect(selectCount(databasePath, "event_templates")).toBe(1);
  });
});

function createTempDatabasePath(prefix: string): string {
  const tempDirectory = mkdtempSync(join(tmpdir(), prefix));
  tempDirectories.push(tempDirectory);

  return join(tempDirectory, "test.sqlite");
}

function runDbScript(scriptName: string, databasePath: string): string {
  return execFileSync(npmCommand, ["run", "--silent", scriptName], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: "test",
      BOT_DRY_RUN: "false",
      DATABASE_PATH: databasePath,
      DISCORD_APP_ID: "",
      DISCORD_BOT_TOKEN: ""
    },
    encoding: "utf8"
  });
}

function selectCount(databasePath: string, tableName: string): number {
  const db = createSqliteConnection(databasePath);

  try {
    return Number(
      (db.prepare(`SELECT COUNT(*) as count FROM ${tableName}`).get() as { count: number } | undefined)?.count ?? 0
    );
  } finally {
    db.close();
  }
}
