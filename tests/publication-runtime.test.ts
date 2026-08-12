import { afterEach, describe, expect, it } from "vitest";
import { createSqliteConnection } from "../src/app/repo/sqlite.js";
import { runMigrations } from "../src/app/repo/migrations.js";
import { acquireRuntimeLease } from "../src/app/repo/runtime-lease-repo.js";
import { loadAppConfig } from "../src/app/config/env.js";
import { createPublicationRuntime } from "../src/publication/publication-runtime.js";
import { BackgroundJobRunner } from "../src/app/runtime/job-runner.js";
import { generateKeyPairSync } from "node:crypto";
import type { AppConfig } from "../src/app/config/env.js";
import { approvePublicationApproval, readPublicationApproval } from "../src/publication/publication-approval-service.js";

const NOW = "2026-08-12T10:00:00.000Z";
const GUILD_ID = "123456789012345678";
const EVENT_ID = "234567890123456789";
const databases: ReturnType<typeof createSqliteConnection>[] = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

describe("publication runtime integration", () => {
  it("does not construct any publication worker when the mode is disabled", () => {
    const db = database();
    const config = loadAppConfig({
      env: {
        NODE_ENV: "test",
        BOT_DRY_RUN: "false",
        DISCORD_APP_ID: GUILD_ID,
        DISCORD_BOT_TOKEN: "token",
        DISCORD_ALLOWED_GUILD_IDS: GUILD_ID
      },
      loadEnvFile: false
    });
    const context = runtimeContext(db);
    expect(createPublicationRuntime({ db, appConfig: config, context, isLeaseValid: () => true })).toBeUndefined();
  });

  it("runs REST observation and shadow approval in observe mode without dispatching", async () => {
    const db = database();
    const config = observeConfig();
    const context = runtimeContext(db);
    const bodies = [
      workerHead(50),
      [{ id: GUILD_ID, name: "KaburAjaDulu" }],
      [{
        id: EVENT_ID,
        name: "Japanese for beginner N5",
        scheduled_start_time: "2026-08-20T10:00:00.000Z",
        scheduled_end_time: "2026-08-20T11:00:00.000Z",
        status: 1,
        entity_type: 3,
        privacy_level: 2,
        guild_id: GUILD_ID
      }]
    ];
    let calls = 0;
    const runtime = createPublicationRuntime({
      db,
      appConfig: config,
      context,
      isLeaseValid: () => true,
      now: () => new Date(NOW),
      fetchImpl: async () => new Response(JSON.stringify(bodies[calls++] ?? []), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    });
    expect(runtime).toBeDefined();
    expect(runtime?.job.dispatch).toBeUndefined();
    expect(runtime?.operator.enqueueApprovedProjection).toBeDefined();

    const result = await runtime?.job.reconcile({
      now: new Date(NOW),
      mode: "observe",
      canDispatch: false,
      ...context
    });
    expect(calls).toBe(3);
    expect(result).toMatchObject({ reconciliationOutcome: "success", revision: 50 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM private_agenda_entries").get()).toMatchObject({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM public_projection_outbox").get()).toMatchObject({ count: 0 });
    const pending = db.prepare("SELECT id FROM private_agenda_entries LIMIT 1").get() as { id: string };
    const snapshot = readPublicationApproval(db, pending.id);
    if (!snapshot?.source || !runtime?.operator.enqueueApprovedProjection) throw new Error("shadow approval unavailable");
    approvePublicationApproval(db, {
      agendaEntryId: pending.id,
      operatorId: "operator-shadow",
      expected: {
        sourceObservationId: snapshot.source.observationId,
        sourceVersion: snapshot.source.sourceVersion,
        observationState: "present",
        agendaState: "pending"
      },
      reason: "Shadow review before writer cutover.",
      context,
      leaseNow: () => new Date(NOW),
      now: NOW,
      enqueueApprovedProjection: runtime.operator.enqueueApprovedProjection
    });
    expect(db.prepare("SELECT projection_revision, state FROM public_projection_outbox").get()).toMatchObject({
      projection_revision: expect.any(Number),
      state: "pending"
    });
    expect(calls).toBe(3);
  });

  it("records valid unknown titles only in observe mode and reports an unknown reconciliation without public writes", async () => {
    const db = database();
    const config = observeConfig();
    const context = runtimeContext(db);
    const bodies = [
      workerHead(50),
      [{ id: GUILD_ID, name: "KaburAjaDulu" }],
      [{
        id: EVENT_ID,
        name: "unreviewed raw title must not persist",
        scheduled_start_time: "2026-08-20T10:00:00.000Z",
        scheduled_end_time: "2026-08-20T11:00:00.000Z",
        status: 1,
        entity_type: 3,
        privacy_level: 2,
        guild_id: GUILD_ID
      }]
    ];
    let calls = 0;
    const runtime = createPublicationRuntime({
      db,
      appConfig: config,
      context,
      isLeaseValid: () => true,
      now: () => new Date(NOW),
      fetchImpl: async () => new Response(JSON.stringify(bodies[calls++] ?? []), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    });
    const result = await runtime?.job.reconcile({ now: new Date(NOW), mode: "observe", canDispatch: false, ...context });
    expect(result).toMatchObject({ reconciliationOutcome: "unknown", unknownEvents: 1, revision: 50 });
    expect(db.prepare("SELECT normalized_title, classification_state FROM discord_scheduled_event_observations_current").get()).toEqual({ normalized_title: null, classification_state: "unknown" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM private_agenda_entries").get()).toMatchObject({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM publication_approvals").get()).toMatchObject({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM public_projection_outbox").get()).toMatchObject({ count: 0 });
    expect(calls).toBe(3);
  });

  it("keeps active unknown snapshots fail-closed without revision, private, outbox, or dispatch mutation", async () => {
    const db = database();
    const context = runtimeContext(db);
    const config = activeConfig();
    const bodies = [
      workerHead(50),
      [{ id: GUILD_ID, name: "KaburAjaDulu" }],
      [{
        id: EVENT_ID,
        name: "Japanese for beginner N5",
        scheduled_start_time: "2026-08-20T10:00:00.000Z",
        scheduled_end_time: "2026-08-20T11:00:00.000Z",
        status: 1,
        entity_type: 3,
        privacy_level: 2,
        guild_id: GUILD_ID
      }],
      workerHead(50),
      [{ id: GUILD_ID, name: "KaburAjaDulu" }],
      [{
        id: EVENT_ID,
        name: "unreviewed raw title",
        scheduled_start_time: "2026-08-20T10:00:00.000Z",
        scheduled_end_time: "2026-08-20T11:00:00.000Z",
        status: 1,
        entity_type: 3,
        privacy_level: 2,
        guild_id: GUILD_ID
      }]
    ];
    let calls = 0;
    const runtime = createPublicationRuntime({
      db,
      appConfig: config,
      context,
      isLeaseValid: () => true,
      now: () => new Date(NOW),
      fetchImpl: async () => new Response(JSON.stringify(bodies[calls++] ?? []), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    });
    if (!runtime?.operator.enqueueApprovedProjection) throw new Error("active enqueue unavailable");

    await runtime.job.reconcile({ now: new Date(NOW), mode: "active", canDispatch: true, ...context });
    const pending = db.prepare("SELECT id FROM private_agenda_entries LIMIT 1").get() as { id: string };
    const approval = readPublicationApproval(db, pending.id);
    if (!approval?.source) throw new Error("approval fixture unavailable");
    approvePublicationApproval(db, {
      agendaEntryId: pending.id,
      operatorId: "operator-lkg",
      expected: {
        sourceObservationId: approval.source.observationId,
        sourceVersion: approval.source.sourceVersion,
        observationState: "present",
        agendaState: "pending"
      },
      reason: "LKG fixture approval.",
      context,
      leaseNow: () => new Date(NOW),
      now: NOW,
      enqueueApprovedProjection: runtime.operator.enqueueApprovedProjection
    });

    const before = {
      history: db.prepare("SELECT * FROM discord_scheduled_event_observation_history ORDER BY id").all(),
      current: db.prepare("SELECT * FROM discord_scheduled_event_observations_current ORDER BY provider_event_id").all(),
      agenda: db.prepare("SELECT * FROM private_agenda_entries ORDER BY id").all(),
      approvals: db.prepare("SELECT * FROM publication_approvals ORDER BY id").all(),
      outbox: db.prepare("SELECT * FROM public_projection_outbox ORDER BY id").all(),
      revisions: db.prepare("SELECT * FROM public_projection_revisions ORDER BY projection_type").all()
    };
    let dispatched = false;
    const originalDispatch = runtime.job.dispatch;
    runtime.job.dispatch = async (...args) => {
      dispatched = true;
      return originalDispatch?.(...args);
    };

    const runner = new BackgroundJobRunner(db, {
      mode: "operate",
      publicationMode: "active",
      publication: runtime.job,
      isLeaseValid: () => true,
      runtimeLeaseName: context.runtimeLeaseName,
      runtimeOwnerId: context.runtimeOwnerId,
      runtimeFencingToken: context.runtimeFencingToken
    });
    const result = await runner.runPublicationSweep(new Date(NOW));
    expect(result).toMatchObject({ mode: "active", observed: false, dispatched: false, publicationOutcome: "failed" });
    expect(dispatched).toBe(false);
    expect(db.prepare("SELECT * FROM discord_scheduled_event_observation_history ORDER BY id").all()).toEqual(before.history);
    expect(db.prepare("SELECT * FROM discord_scheduled_event_observations_current ORDER BY provider_event_id").all()).toEqual(before.current);
    expect(db.prepare("SELECT * FROM private_agenda_entries ORDER BY id").all()).toEqual(before.agenda);
    expect(db.prepare("SELECT * FROM publication_approvals ORDER BY id").all()).toEqual(before.approvals);
    expect(db.prepare("SELECT * FROM public_projection_outbox ORDER BY id").all()).toEqual(before.outbox);
    expect(db.prepare("SELECT * FROM public_projection_revisions ORDER BY projection_type").all()).toEqual(before.revisions);
  });

  it("refuses a stale runtime context before any REST request", async () => {
    const db = database();
    const config = observeConfig();
    const context = runtimeContext(db);
    let calls = 0;
    const runtime = createPublicationRuntime({
      db,
      appConfig: config,
      context,
      isLeaseValid: () => false,
      fetchImpl: async () => {
        calls += 1;
        return new Response("[]");
      }
    });
    await expect(runtime?.job.reconcile({ now: new Date(NOW), mode: "observe", canDispatch: false, ...context }))
      .rejects.toThrow("lease context");
    expect(calls).toBe(0);
  });

  it("automatically enqueues a tombstone snapshot after an approved event is cancelled", async () => {
    const db = database();
    const context = runtimeContext(db);
    db.prepare("UPDATE runtime_leases SET expires_at = '2099-01-01T00:00:00.000Z'").run();
    const scheduled = {
      id: EVENT_ID,
      name: "Japanese for beginner N5",
      scheduled_start_time: "2026-08-20T10:00:00.000Z",
      scheduled_end_time: "2026-08-20T11:00:00.000Z",
      status: 1,
      entity_type: 3,
      privacy_level: 2,
      guild_id: GUILD_ID
    };
    const bodies = [
      workerHead(50),
      [{ id: GUILD_ID, name: "KaburAjaDulu" }],
      [scheduled],
      workerHead(50),
      [{ id: GUILD_ID, name: "KaburAjaDulu" }],
      [scheduled],
      workerHead(50),
      [{ id: GUILD_ID, name: "KaburAjaDulu" }],
      [{ ...scheduled, status: 4 }]
    ];
    let calls = 0;
    let clock = new Date(NOW);
    const runtime = createPublicationRuntime({
      db,
      appConfig: activeConfig(),
      context,
      isLeaseValid: () => true,
      now: () => clock,
      fetchImpl: async () => new Response(JSON.stringify(bodies[calls++] ?? []), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    });
    if (!runtime?.operator.enqueueApprovedProjection) throw new Error("active enqueue unavailable");

    await runtime.job.reconcile({ now: new Date(NOW), mode: "active", canDispatch: true, ...context });
    const pending = db.prepare("SELECT id FROM private_agenda_entries LIMIT 1").get() as { id: string };
    const snapshot = readPublicationApproval(db, pending.id);
    if (!snapshot?.source) throw new Error("approval fixture unavailable");
    clock = new Date("2026-08-12T10:00:01.000Z");
    approvePublicationApproval(db, {
      agendaEntryId: pending.id,
      operatorId: "operator-1",
      expected: {
        sourceObservationId: snapshot.source.observationId,
        sourceVersion: snapshot.source.sourceVersion,
        observationState: "present",
        agendaState: "pending"
      },
      reason: "Current public fields reviewed.",
      context,
      leaseNow: () => clock,
      now: clock,
      enqueueApprovedProjection: runtime.operator.enqueueApprovedProjection
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM public_projection_outbox WHERE state = 'pending'").get()).toMatchObject({ count: 1 });

    clock = new Date("2026-08-12T10:01:00.000Z");
    await runtime.job.reconcile({ now: clock, mode: "active", canDispatch: true, ...context });
    expect(db.prepare("SELECT agenda_state FROM private_agenda_entries").get()).toEqual({ agenda_state: "approved" });

    clock = new Date("2026-08-12T10:02:00.000Z");
    await runtime.job.reconcile({ now: clock, mode: "active", canDispatch: true, ...context });
    const current = db.prepare(
      "SELECT payload_json FROM public_projection_outbox WHERE state = 'pending' ORDER BY projection_revision DESC LIMIT 1"
    ).get() as { payload_json: string };
    const projection = JSON.parse(current.payload_json) as { entries: unknown[]; tombstones: string[] };
    expect(projection.entries).toEqual([]);
    expect(projection.tombstones).toHaveLength(1);
    expect(projection.tombstones[0]).not.toContain(EVENT_ID);
    expect(db.prepare("SELECT COUNT(*) AS count FROM public_projection_outbox WHERE state = 'dead_letter'").get()).toMatchObject({ count: 2 });
    expect(calls).toBe(9);
  });
});

function database() {
  const db = createSqliteConnection(":memory:");
  databases.push(db);
  runMigrations(db);
  return db;
}

function runtimeContext(db: ReturnType<typeof createSqliteConnection>) {
  const lease = acquireRuntimeLease(db, {
    ownerId: "publication-runtime-test",
    now: NOW,
    leaseDurationMs: 60 * 60_000
  });
  if (!lease) throw new Error("test lease unavailable");
  return {
    runtimeLeaseName: lease.leaseKey,
    runtimeOwnerId: lease.ownerId,
    runtimeFencingToken: lease.fencingToken
  };
}

function activeConfig(): AppConfig {
  const privateKey = generateKeyPairSync("ed25519").privateKey
    .export({ format: "der", type: "pkcs8" }).toString("base64");
  return {
    nodeEnv: "test",
    logLevel: "error",
    botDryRun: false,
    runtimeMode: "operate",
    publication: {
      mode: "active",
      cutoverConfirmed: true,
      targetGuildId: GUILD_ID,
      targetGuildName: "KaburAjaDulu",
      endpoint: "https://staging.example.test/internal/v1/projections/agenda",
      publicAgendaEndpoint: "https://staging.example.test/api/v1/agenda",
      keyId: "staging-key",
      signingPrivateKey: privateKey,
      publicIdKey: "test-public-agenda-key-2026",
      observationIntervalMs: 60_000,
      publishIntervalMs: 30_000,
      requestTimeoutMs: 9_000,
      leaseDurationMs: 30_000,
      leaseHeartbeatIntervalMs: 10_000
    },
    databasePath: ":memory:",
    jobPollIntervalMs: 30_000,
    health: { host: "127.0.0.1", port: 0 },
    discord: { appId: GUILD_ID, botToken: "token", allowedGuildIds: [GUILD_ID] }
  };
}

function observeConfig(): AppConfig {
  return {
    ...activeConfig(),
    runtimeMode: "observe",
    publication: {
      ...activeConfig().publication!,
      mode: "observe",
      cutoverConfirmed: false,
      keyId: undefined,
      signingPrivateKey: undefined
    }
  };
}

function workerHead(revision: number) {
  return {
    schemaVersion: "v1",
    generatedAt: NOW,
    observedAt: NOW,
    revision,
    sourceStatus: "fresh",
    staleAt: "2026-08-12T10:45:00.000Z",
    entries: []
  };
}
