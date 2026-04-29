import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

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

describe("live Discord script guards", () => {
  it("fails npm run start with a clear BOT_DRY_RUN message", () => {
    const result = runScript("start", createBaseEnv());

    expect(result.status).not.toBe(0);
    expect(combinedOutput(result)).toContain(
      "npm run start refused to run because BOT_DRY_RUN=true. Set BOT_DRY_RUN=false for live Discord validation"
    );
  }, 10000);

  it("fails npm run register-commands with a clear BOT_DRY_RUN message", () => {
    const result = runScript("register-commands", createBaseEnv());

    expect(result.status).not.toBe(0);
    expect(combinedOutput(result)).toContain(
      "npm run register-commands refused to run because BOT_DRY_RUN=true. Set BOT_DRY_RUN=false for live Discord validation"
    );
  });

  it("fails live register-commands without an explicit guild ID flag", () => {
    const result = runScript("register-commands", {
      ...createBaseEnv(),
      BOT_DRY_RUN: "false",
      DISCORD_APP_ID: "123456789012345678",
      DISCORD_BOT_TOKEN: "fake-token"
    });

    expect(result.status).not.toBe(0);
    expect(combinedOutput(result)).toContain(
      "Live command registration requires --guild-id <snowflake>. Global registration is disabled for this slice."
    );
  });

  it("keeps npm run start:dry-run available for local smoke checks", () => {
    const result = runScript("start:dry-run", createBaseEnv());

    expect(result.status).toBe(0);

    expect(JSON.parse(result.stdout.trim()) as { status: string; mode: string }).toMatchObject({
      status: "foundation_ready",
      mode: "dry-run"
    });
  });
});

function createBaseEnv(): NodeJS.ProcessEnv {
  const tempDirectory = mkdtempSync(join(tmpdir(), "kad-agent-live-guard-"));
  tempDirectories.push(tempDirectory);

  return {
    ...process.env,
    NODE_ENV: "test",
    BOT_DRY_RUN: "true",
    DATABASE_PATH: join(tempDirectory, "test.sqlite"),
    DISCORD_APP_ID: "",
    DISCORD_BOT_TOKEN: ""
  };
}

function runScript(scriptName: string, env: NodeJS.ProcessEnv) {
  return spawnSync(npmCommand, ["run", "--silent", scriptName], {
    cwd: repoRoot,
    env,
    encoding: "utf8"
  });
}

function combinedOutput(result: { stdout: string; stderr: string }): string {
  return `${result.stdout}\n${result.stderr}`;
}
