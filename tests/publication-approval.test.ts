import { afterEach, describe, expect, it } from "vitest";
import { acquireRuntimeLease } from "../src/app/repo/runtime-lease-repo.js";
import { runMigrations } from "../src/app/repo/migrations.js";
import { createSqliteConnection } from "../src/app/repo/sqlite.js";
import { reconcileDiscordScheduledEventObservations } from "../src/events/service/discord-scheduled-event-observation-service.js";
import type { DiscordScheduledEvent } from "../src/publication/types.js";
import {
  approvePublicationApproval,
  rejectPublicationApproval,
  type PublicationApprovalEnqueuer,
  type PublicationApprovalExpectation
} from "../src/publication/publication-approval-service.js";
import { PublicationApprovalRepositoryError } from "../src/publication/publication-approval-repo.js";

const GUILD_ID = "123456789012345678";
const EVENT_ID = "234567890123456789";
const TEST_LEASE_NOW = () => new Date("2026-08-12T10:00:01.000Z");
const dbs: ReturnType<typeof createSqliteConnection>[] = [];

afterEach(() => {
  while (dbs.length > 0) dbs.pop()?.close();
});

describe("publication approval boundary", () => {
  it("approves once, records operator audit metadata, and invokes the injected enqueue callback once", () => {
    const db = testDb();
    const context = leaseContext(db, "runtime-a", "2026-08-12T10:00:00.000Z");
    reconcile(db, context);
    const expected = currentExpectation(db);
    const queued: unknown[] = [];

    const first = approvePublicationApproval(db, {
      agendaEntryId: expected.agendaEntryId,
      operatorId: "publication-operator-1",
      sourceActorId: "discord-requester-1",
      expected: expected.expectation,
      reason: "Public fields reviewed against the current Discord event.",
      context,
      leaseNow: TEST_LEASE_NOW,
      now: "2026-08-12T10:01:00.000Z",
      enqueueApprovedProjection: (record) => {
        queued.push(record);
        return undefined;
      }
    });

    expect(first).toMatchObject({ decision: "approve", idempotent: false, enqueued: true });
    expect(queued).toHaveLength(1);
    expect(db.prepare("SELECT agenda_state FROM private_agenda_entries").get()).toEqual({ agenda_state: "approved" });
    expect(db.prepare("SELECT state, decided_by, decision_reason, decided_at FROM publication_approvals").get()).toEqual({
      state: "approved",
      decided_by: "publication-operator-1",
      decision_reason: "Public fields reviewed against the current Discord event.",
      decided_at: "2026-08-12T10:01:00.000Z"
    });

    const second = approvePublicationApproval(db, {
      agendaEntryId: expected.agendaEntryId,
      operatorId: "publication-operator-1",
      sourceActorId: "discord-requester-1",
      expected: expected.expectation,
      reason: "Replay of the same operator decision.",
      context,
      leaseNow: TEST_LEASE_NOW,
      now: "2026-08-12T10:02:00.000Z"
    });
    expect(second).toMatchObject({ decision: "approve", idempotent: true, enqueued: false });
    expect(queued).toHaveLength(1);
    expect(db.prepare("SELECT decided_at, decided_by, decision_reason FROM publication_approvals").get()).toEqual({
      decided_at: "2026-08-12T10:01:00.000Z",
      decided_by: "publication-operator-1",
      decision_reason: "Public fields reviewed against the current Discord event."
    });
  });

  it("rejects without enqueue, is idempotent, and retains the private agenda for a later re-request", () => {
    const db = testDb();
    const context = leaseContext(db, "runtime-a", "2026-08-12T10:00:00.000Z");
    reconcile(db, context);
    const expected = currentExpectation(db);

    const first = rejectPublicationApproval(db, {
      agendaEntryId: expected.agendaEntryId,
      operatorId: "publication-operator-1",
      expected: expected.expectation,
      reason: "Description needs a staff edit before publication.",
      context,
      leaseNow: TEST_LEASE_NOW,
      now: "2026-08-12T10:01:00.000Z"
    });
    expect(first).toMatchObject({ decision: "reject", idempotent: false, enqueued: false });
    expect(db.prepare("SELECT agenda_state FROM private_agenda_entries").get()).toEqual({ agenda_state: "pending" });
    expect(db.prepare("SELECT state, decided_by, decision_reason FROM publication_approvals").get()).toEqual({
      state: "rejected",
      decided_by: "publication-operator-1",
      decision_reason: "Description needs a staff edit before publication."
    });

    const second = rejectPublicationApproval(db, {
      agendaEntryId: expected.agendaEntryId,
      operatorId: "publication-operator-2",
      expected: expected.expectation,
      reason: "Retry of the same rejection.",
      context,
      leaseNow: TEST_LEASE_NOW,
      now: "2026-08-12T10:02:00.000Z"
    });
    expect(second).toMatchObject({ decision: "reject", idempotent: true, enqueued: false });
    expect(db.prepare("SELECT decided_by, decision_reason FROM publication_approvals").get()).toEqual({
      decided_by: "publication-operator-1",
      decision_reason: "Description needs a staff edit before publication."
    });
  });

  it("fails closed for a changed source revision and for an unknown source", () => {
    const db = testDb();
    const context = leaseContext(db, "runtime-a", "2026-08-12T10:00:00.000Z");
    reconcile(db, context);
    const before = currentExpectation(db);
    reconcile(db, context, {
      scheduled_start_time: "2026-08-20T12:00:00.000Z",
      scheduled_end_time: "2026-08-20T13:00:00.000Z"
    });

    expectPublicationError(() => approvePublicationApproval(db, {
      agendaEntryId: before.agendaEntryId,
      operatorId: "publication-operator-1",
      expected: before.expectation,
      reason: "Stale review must not publish the changed event.",
      context,
      leaseNow: TEST_LEASE_NOW,
      now: "2026-08-12T10:02:00.000Z",
      enqueueApprovedProjection: () => undefined
    }), "stale_source");

    db.prepare("UPDATE discord_scheduled_event_observations_current SET classification_state = 'unknown' WHERE provider_event_id = ?").run(EVENT_ID);
    const current = currentExpectation(db);
    expectPublicationError(() => rejectPublicationApproval(db, {
      agendaEntryId: current.agendaEntryId,
      operatorId: "publication-operator-1",
      expected: current.expectation,
      reason: "Unknown sources cannot be approved or rejected as public data.",
      context,
      leaseNow: TEST_LEASE_NOW,
      now: "2026-08-12T10:03:00.000Z"
    }), "unknown_source");
  });

  it("fails withdrawn sources, operator/source identity conflicts, incomplete leases, and missing approval enqueue", () => {
    const db = testDb();
    const context = leaseContext(db, "runtime-a", "2026-08-12T10:00:00.000Z");
    reconcile(db, context);
    const expected = currentExpectation(db);
    db.prepare("UPDATE private_agenda_entries SET agenda_state = 'withdrawn'").run();
    db.prepare("UPDATE publication_approvals SET state = 'withdrawn'").run();

    expectPublicationError(() => rejectPublicationApproval(db, {
      agendaEntryId: expected.agendaEntryId,
      operatorId: "publication-operator-1",
      expected: expected.expectation,
      reason: "Withdrawn entries are never reviewable.",
      context,
      leaseNow: TEST_LEASE_NOW,
      now: "2026-08-12T10:01:00.000Z"
    }), "withdrawn_source");

    const freshDb = testDb();
    const freshContext = leaseContext(freshDb, "runtime-a", "2026-08-12T10:00:00.000Z");
    reconcile(freshDb, freshContext);
    const fresh = currentExpectation(freshDb);
    expectPublicationError(() => approvePublicationApproval(freshDb, {
      agendaEntryId: fresh.agendaEntryId,
      operatorId: "same-person",
      sourceActorId: "same-person",
      expected: fresh.expectation,
      reason: "Self approval is not allowed.",
      context: freshContext,
      leaseNow: TEST_LEASE_NOW,
      enqueueApprovedProjection: () => undefined
    }), "operator_conflict");
    expectPublicationError(() => approvePublicationApproval(freshDb, {
      agendaEntryId: fresh.agendaEntryId,
      operatorId: "publication-operator-1",
      expected: fresh.expectation,
      reason: "An enqueue boundary is mandatory.",
      context: freshContext,
      leaseNow: TEST_LEASE_NOW
    }), "enqueue_required");
    expectPublicationError(() => approvePublicationApproval(freshDb, {
      agendaEntryId: fresh.agendaEntryId,
      operatorId: "publication-operator-1",
      expected: fresh.expectation,
      reason: "An inactive lease cannot mutate private authority.",
      context: { runtimeLeaseName: "runtime", runtimeOwnerId: "wrong-owner", runtimeFencingToken: 99 },
      leaseNow: TEST_LEASE_NOW,
      enqueueApprovedProjection: () => undefined
    }), "lease_inactive");
  });

  it("rolls back the approval when the injected enqueue boundary fails", () => {
    const db = testDb();
    const context = leaseContext(db, "runtime-a", "2026-08-12T10:00:00.000Z");
    reconcile(db, context);
    const expected = currentExpectation(db);
    expect(() => approvePublicationApproval(db, {
      agendaEntryId: expected.agendaEntryId,
      operatorId: "publication-operator-1",
      expected: expected.expectation,
      reason: "The queue transaction is intentionally failing in this test.",
      context,
      leaseNow: TEST_LEASE_NOW,
      enqueueApprovedProjection: () => { throw new Error("queue unavailable"); }
    })).toThrow("queue unavailable");
    expect(db.prepare("SELECT agenda_state FROM private_agenda_entries").get()).toEqual({ agenda_state: "pending" });
    expect(db.prepare("SELECT state, decided_by, decided_at FROM publication_approvals").get()).toEqual({
      state: "pending",
      decided_by: null,
      decided_at: null
    });
  });

  it("fails closed when the lease is already expired before the transaction or is lost during enqueue", () => {
    const db = testDb();
    const shortLease = acquireRuntimeLease(db, {
      leaseKey: "publication-runtime",
      ownerId: "runtime-a",
      now: "2026-08-12T10:00:00.000Z",
      leaseDurationMs: 10_000
    });
    if (!shortLease) throw new Error("test lease unavailable");
    const context = {
      runtimeLeaseName: shortLease.leaseKey,
      runtimeOwnerId: shortLease.ownerId,
      runtimeFencingToken: shortLease.fencingToken
    };
    reconcile(db, context);
    const expected = currentExpectation(db);

    expectPublicationError(() => approvePublicationApproval(db, {
      agendaEntryId: expected.agendaEntryId,
      operatorId: "publication-operator-1",
      expected: expected.expectation,
      reason: "The runtime lease expired before this decision.",
      context,
      leaseNow: () => new Date("2026-08-12T10:00:11.000Z"),
      now: "2026-08-12T10:00:11.000Z",
      enqueueApprovedProjection: () => undefined
    }), "lease_inactive");
    expect(db.prepare("SELECT state FROM publication_approvals").get()).toEqual({ state: "pending" });

    const freshDb = testDb();
    const freshContext = leaseContext(freshDb, "runtime-a", "2026-08-12T10:00:00.000Z");
    reconcile(freshDb, freshContext);
    const fresh = currentExpectation(freshDb);
    let leaseTime = new Date("2026-08-12T10:00:01.000Z");
    let enqueueCalled = false;
    expectPublicationError(() => approvePublicationApproval(freshDb, {
      agendaEntryId: fresh.agendaEntryId,
      operatorId: "publication-operator-1",
      expected: fresh.expectation,
      reason: "The callback loses the runtime lease before commit.",
      context: freshContext,
      leaseNow: () => leaseTime,
      now: "2026-08-12T10:01:00.000Z",
      enqueueApprovedProjection: () => {
        // Advance only the injected wall clock; the SQLite lease row is not
        // mutated. The post-enqueue check must still observe expiry.
        enqueueCalled = true;
        leaseTime = new Date("2026-08-12T10:20:00.000Z");
        return undefined;
      }
    }), "lease_inactive");
    expect(enqueueCalled).toBe(true);
    expect(freshDb.prepare("SELECT agenda_state FROM private_agenda_entries").get()).toEqual({ agenda_state: "pending" });
    expect(freshDb.prepare("SELECT state, decided_by FROM publication_approvals").get()).toEqual({ state: "pending", decided_by: null });
  });

  it("rejects async and thenable enqueue callbacks at runtime and rolls back the approval", () => {
    const db = testDb();
    const context = leaseContext(db, "runtime-a", "2026-08-12T10:00:00.000Z");
    reconcile(db, context);
    const expected = currentExpectation(db);
    const asyncEnqueuer = (async () => undefined) as unknown as PublicationApprovalEnqueuer;

    expectPublicationError(() => approvePublicationApproval(db, {
      agendaEntryId: expected.agendaEntryId,
      operatorId: "publication-operator-1",
      expected: expected.expectation,
      reason: "An async enqueue is not transaction-safe.",
      context,
      leaseNow: TEST_LEASE_NOW,
      enqueueApprovedProjection: asyncEnqueuer
    }), "enqueue_async");
    expect(db.prepare("SELECT agenda_state FROM private_agenda_entries").get()).toEqual({ agenda_state: "pending" });
    expect(db.prepare("SELECT state FROM publication_approvals").get()).toEqual({ state: "pending" });

    const thenableEnqueuer = (() => ({ then: () => undefined })) as unknown as PublicationApprovalEnqueuer;
    expectPublicationError(() => approvePublicationApproval(db, {
      agendaEntryId: expected.agendaEntryId,
      operatorId: "publication-operator-1",
      expected: expected.expectation,
      reason: "A thenable enqueue is also asynchronous.",
      context,
      leaseNow: TEST_LEASE_NOW,
      enqueueApprovedProjection: thenableEnqueuer
    }), "enqueue_async");
    expect(db.prepare("SELECT agenda_state FROM private_agenda_entries").get()).toEqual({ agenda_state: "pending" });
    expect(db.prepare("SELECT state FROM publication_approvals").get()).toEqual({ state: "pending" });
  });
});

function testDb() {
  const db = createSqliteConnection(":memory:");
  dbs.push(db);
  runMigrations(db);
  return db;
}

function leaseContext(db: ReturnType<typeof createSqliteConnection>, ownerId: string, now: string) {
  const lease = acquireRuntimeLease(db, { leaseKey: "publication-runtime", ownerId, now, leaseDurationMs: 600_000 });
  if (!lease) throw new Error("test lease unavailable");
  return { runtimeLeaseName: lease.leaseKey, runtimeOwnerId: lease.ownerId, runtimeFencingToken: lease.fencingToken };
}

function reconcile(
  db: ReturnType<typeof createSqliteConnection>,
  context: ReturnType<typeof leaseContext>,
  overrides: Partial<DiscordScheduledEvent> = {}
) {
  return reconcileDiscordScheduledEventObservations({
    db,
    guildId: GUILD_ID,
    events: [{
      id: EVENT_ID,
      name: "Japanese for beginner N5",
      scheduled_start_time: "2026-08-20T10:00:00.000Z",
      scheduled_end_time: "2026-08-20T11:00:00.000Z",
      status: 1,
      entity_type: 3,
      privacy_level: 2,
      guild_id: GUILD_ID,
      ...overrides
    }],
    context,
    observedAt: overrides.scheduled_start_time === undefined ? "2026-08-12T10:00:00.000Z" : "2026-08-12T10:01:00.000Z",
    now: () => new Date(overrides.scheduled_start_time === undefined ? "2026-08-12T10:00:01.000Z" : "2026-08-12T10:01:01.000Z")
  });
}

function currentExpectation(db: ReturnType<typeof createSqliteConnection>): { agendaEntryId: string; expectation: PublicationApprovalExpectation } {
  const row = db.prepare(
    `SELECT pae.id AS agenda_entry_id, pae.source_observation_id, osc.source_version,
            osc.observation_state, pae.agenda_state
       FROM private_agenda_entries pae
       JOIN discord_scheduled_event_observations_current osc
         ON osc.provider_event_id = pae.source_provider_event_id
      LIMIT 1`
  ).get() as { agenda_entry_id: string; source_observation_id: string; source_version: number; observation_state: "present"; agenda_state: "pending" } | undefined;
  if (!row) throw new Error("test agenda row unavailable");
  return {
    agendaEntryId: row.agenda_entry_id,
    expectation: {
      sourceObservationId: row.source_observation_id,
      sourceVersion: Number(row.source_version),
      observationState: row.observation_state,
      agendaState: row.agenda_state
    }
  };
}

function expectPublicationError(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error(`Expected publication approval error ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(PublicationApprovalRepositoryError);
    expect((error as PublicationApprovalRepositoryError).code).toBe(code);
  }
}
