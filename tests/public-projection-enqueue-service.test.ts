import { afterEach, describe, expect, it } from "vitest";
import { createSqliteConnection } from "../src/app/repo/sqlite.js";
import { runMigrations } from "../src/app/repo/migrations.js";
import { acquireRuntimeLease } from "../src/app/repo/runtime-lease-repo.js";
import {
  allocatePublicProjectionRevision,
  getPublicProjectionRevision
} from "../src/publication/public-projection-revision-repo.js";
import {
  enqueueApprovedPublicProjection,
  enqueueCurrentPublicProjection,
  createApprovedPublicProjectionEnqueuer
} from "../src/publication/public-projection-enqueue-service.js";
import {
  claimPublicProjectionOutbox,
  createOrGetPublicProjectionOutbox,
  finalizePublicProjectionOutbox,
  markPublicProjectionNeedsReconciliation,
  supersedeOlderPublicProjectionOutbox
} from "../src/publication/public-projection-outbox-repo.js";
import type { ApprovedPublicationRecord } from "../src/publication/publication-approval-repo.js";

const NOW = "2026-08-12T10:00:00.000Z";
const GUILD = "123456789012345678";
const EVENT = "234567890123456789";
const CONTEXT = {
  runtimeLeaseName: "publication-runtime",
  runtimeOwnerId: "worker-a",
  runtimeFencingToken: 1
} as const;
const dbs: ReturnType<typeof createSqliteConnection>[] = [];

afterEach(() => {
  while (dbs.length > 0) dbs.pop()?.close();
});

describe("public projection revision and enqueue service", () => {
  it("allocates fenced monotonic revisions above the clock floor", () => {
    const db = fixture();
    const first = allocatePublicProjectionRevision(db, { ...CONTEXT, now: NOW, revisionFloor: 500 });
    const second = allocatePublicProjectionRevision(db, { ...CONTEXT, now: NOW, revisionFloor: 500 });
    expect(first.revision).toBe(500);
    expect(second.revision).toBe(501);
    expect(getPublicProjectionRevision(db)).toMatchObject({ revision: 501, allocatedAt: NOW });
  });

  it("fails closed for an expired lease", () => {
    const db = fixture();
    expect(() => allocatePublicProjectionRevision(db, {
      ...CONTEXT,
      now: "2026-08-12T10:01:01.000Z",
      revisionFloor: 1
    })).toThrow("active runtime lease");
  });

  it("assembles one canonical full snapshot and retires an older pending item", () => {
    const db = fixture();
    const record = approvedRecord();
    const first = enqueueApprovedPublicProjection({
      db,
      ...CONTEXT,
      publicIdKey: "test-public-agenda-key-2026",
      now: NOW,
      revisionFloor: 900
    }, record);
    expect(first.projection.revision).toBe(900);
    expect(first.outbox.state).toBe("pending");
    expect(first.outbox.payloadJson).toBe(first.payloadJson);
    expect(JSON.parse(first.payloadJson)).toEqual(first.projection);

    const second = enqueueApprovedPublicProjection({
      db,
      ...CONTEXT,
      publicIdKey: "test-public-agenda-key-2026",
      now: NOW,
      revisionFloor: 900
    }, record);
    expect(second.projection.revision).toBe(901);
    expect(db.prepare("SELECT state FROM public_projection_outbox WHERE id = ?").get(first.outbox.id)).toMatchObject({ state: "dead_letter" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM public_projection_outbox WHERE state = 'pending'").get()).toMatchObject({ count: 1 });
  });

  it("adapts to the approval callback without returning a Promise", () => {
    const db = fixture();
    const enqueuer = createApprovedPublicProjectionEnqueuer({
      db,
      ...CONTEXT,
      publicIdKey: "test-public-agenda-key-2026",
      now: NOW,
      revisionFloor: 950
    });
    expect(enqueuer.enqueue(approvedRecord())).toBeUndefined();
    expect(enqueuer.lastResult?.outbox.projectionRevision).toBe(950);
  });

  it("supersedes only pending and retryable rows, never ambiguous or succeeded rows", () => {
    const db = fixture();
    const pending = createOrGetPublicProjectionOutbox(db, {
      id: "pending-old",
      triggerAgendaEntryId: "agenda-1",
      projectionRevision: 10,
      payloadJson: '{"revision":10}',
      now: NOW
    });
    const leased = createOrGetPublicProjectionOutbox(db, {
      id: "leased-old",
      triggerAgendaEntryId: "agenda-1",
      projectionRevision: 11,
      payloadJson: '{"revision":11}',
      now: NOW
    });
    const ambiguous = createOrGetPublicProjectionOutbox(db, {
      id: "ambiguous-old",
      triggerAgendaEntryId: "agenda-1",
      projectionRevision: 12,
      payloadJson: '{"revision":12}',
      now: NOW
    });
    const succeeded = createOrGetPublicProjectionOutbox(db, {
      id: "succeeded-old",
      triggerAgendaEntryId: "agenda-1",
      projectionRevision: 13,
      payloadJson: '{"revision":13}',
      now: NOW
    });
    expect(claimPublicProjectionOutbox(db, { ...CONTEXT, id: leased.id, ownerId: "publisher", now: NOW })).not.toBeNull();
    expect(claimPublicProjectionOutbox(db, { ...CONTEXT, id: ambiguous.id, ownerId: "publisher", now: NOW })).not.toBeNull();
    expect(markPublicProjectionNeedsReconciliation(db, { ...CONTEXT, id: ambiguous.id, ownerId: "publisher", fencingToken: 1, now: NOW })).toBe(true);
    expect(claimPublicProjectionOutbox(db, { ...CONTEXT, id: succeeded.id, ownerId: "publisher", now: NOW })).not.toBeNull();
    expect(finalizePublicProjectionOutbox(db, { ...CONTEXT, id: succeeded.id, ownerId: "publisher", fencingToken: 1, now: NOW })).toBe(true);

    expect(supersedeOlderPublicProjectionOutbox(db, { ...CONTEXT, projectionRevision: 20, now: NOW })).toBe(1);
    expect(db.prepare("SELECT state FROM public_projection_outbox WHERE id = ?").get(pending.id)).toMatchObject({ state: "dead_letter" });
    expect(db.prepare("SELECT state FROM public_projection_outbox WHERE id = ?").get(leased.id)).toMatchObject({ state: "leased" });
    expect(db.prepare("SELECT state FROM public_projection_outbox WHERE id = ?").get(ambiguous.id)).toMatchObject({ state: "needs_reconciliation" });
    expect(db.prepare("SELECT state FROM public_projection_outbox WHERE id = ?").get(succeeded.id)).toMatchObject({ state: "succeeded" });
  });

  it("publishes a tombstone when an approved event is withdrawn", () => {
    const db = fixture();
    db.prepare("UPDATE private_agenda_entries SET agenda_state = 'withdrawn' WHERE id = 'agenda-1'").run();
    db.prepare("UPDATE publication_approvals SET state = 'withdrawn' WHERE agenda_entry_id = 'agenda-1'").run();

    const result = enqueueCurrentPublicProjection({
      db,
      ...CONTEXT,
      publicIdKey: "test-public-agenda-key-2026",
      guildId: GUILD,
      triggerAgendaEntryId: "agenda-1",
      observedAt: NOW,
      now: NOW,
      revisionFloor: 1_000
    });
    expect(result.projection.entries).toEqual([]);
    expect(result.projection.tombstones).toHaveLength(1);
    expect(result.projection.tombstones[0]).not.toContain(EVENT);
    expect(result.outbox.projectionRevision).toBe(1_000);
  });

  it("keeps a legitimate empty snapshot when all formerly public rows are pending", () => {
    const db = fixture();
    db.prepare("UPDATE private_agenda_entries SET agenda_state = 'pending' WHERE id = 'agenda-1'").run();
    db.prepare("UPDATE publication_approvals SET state = 'pending', decided_at = NULL, decided_by = NULL WHERE agenda_entry_id = 'agenda-1'").run();
    const explicitObservedAt = "2026-08-12T10:05:00.000Z";
    const result = enqueueCurrentPublicProjection({
      db,
      ...CONTEXT,
      publicIdKey: "test-public-agenda-key-2026",
      guildId: GUILD,
      triggerAgendaEntryId: "agenda-1",
      observedAt: explicitObservedAt,
      now: NOW,
      revisionFloor: 1_001
    });
    expect(result.projection).toMatchObject({
      observedAt: explicitObservedAt,
      entries: [],
      tombstones: [],
      revision: 1_001
    });
  });

  it("rejects a stale runtime fence without allocating or inserting an outbox row", () => {
    const db = fixture();
    expect(() => enqueueCurrentPublicProjection({
      db,
      ...CONTEXT,
      publicIdKey: "test-public-agenda-key-2026",
      guildId: GUILD,
      triggerAgendaEntryId: "agenda-1",
      observedAt: NOW,
      now: "2026-08-12T10:01:01.000Z",
      revisionFloor: 1_002
    })).toThrow("active runtime lease");
    expect(db.prepare("SELECT COUNT(*) AS count FROM public_projection_revisions").get()).toMatchObject({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM public_projection_outbox").get()).toMatchObject({ count: 0 });
  });
});

function fixture() {
  const db = createSqliteConnection(":memory:");
  runMigrations(db);
  dbs.push(db);
  db.prepare(`INSERT INTO discord_scheduled_event_observation_history
    (id, provider_event_id, guild_id, observed_at, source, source_version, observation_state,
     status_code, entity_type, privacy_level, normalized_title, classification_state,
     classification_category, program_key, series_key, scheduled_start_at, reason_code,
     observation_fingerprint, created_at)
    VALUES (?, ?, ?, ?, 'discord_rest_reconciliation', 1, 'present', 1, 3, 2, ?, 'allowlisted', ?, ?, NULL, ?, 'test', ?, ?)`
  ).run("observation-1", EVENT, GUILD, NOW, "English practice session", "english", "english-study-club", "2026-08-20T04:00:00.000Z", "fingerprint-1", NOW);
  db.prepare(`INSERT INTO discord_scheduled_event_observations_current
    (provider_event_id, guild_id, observation_id, first_observed_at, last_observed_at,
     source, source_version, observation_state, status_code, entity_type, privacy_level,
     normalized_title, classification_state, classification_category, program_key,
     series_key, scheduled_start_at, reason_code, updated_at)
    VALUES (?, ?, ?, ?, ?, 'discord_rest_reconciliation', 1, 'present', 1, 3, 2, ?, 'allowlisted', ?, ?, NULL, ?, 'test', ?)`
  ).run(EVENT, GUILD, "observation-1", NOW, NOW, "English practice session", "english", "english-study-club", "2026-08-20T04:00:00.000Z", NOW);
  db.prepare(`INSERT INTO private_agenda_entries
    (id, source_provider_event_id, source_observation_id, guild_id, projection_type, title,
     summary, program_key, series_key, scheduled_start_at, timezone, agenda_state,
     created_at, updated_at)
    VALUES (?, ?, ?, ?, 'language_club_agenda_entry.v1', ?, ?, ?, NULL, ?, 'Asia/Jakarta', 'approved', ?, ?)`
  ).run("agenda-1", EVENT, "observation-1", GUILD, "English Study Club", "A supportive English practice session for learners.", "english-study-club", "2026-08-20T04:00:00.000Z", NOW, NOW);
  db.prepare(`INSERT INTO publication_approvals
    (id, agenda_entry_id, projection_type, state, requested_at, requested_by,
     decided_at, decided_by, decision_reason)
    VALUES (?, ?, 'language_club_agenda_entry.v1', 'approved', ?, 'operator', ?, 'operator', 'approved')`
  ).run("approval-1", "agenda-1", NOW, "2026-08-12T10:01:00.000Z");
  acquireRuntimeLease(db, { leaseKey: CONTEXT.runtimeLeaseName, ownerId: CONTEXT.runtimeOwnerId, now: NOW, leaseDurationMs: 60_000 });
  return db;
}

function approvedRecord(): ApprovedPublicationRecord {
  return {
    approvalId: "approval-1",
    agendaEntryId: "agenda-1",
    projectionType: "language_club_agenda_entry.v1",
    decision: "approve",
    decidedAt: "2026-08-12T10:01:00.000Z",
    decidedBy: "operator",
    decisionReason: "approved",
    agenda: {
      id: "agenda-1",
      sourceProviderEventId: EVENT,
      sourceObservationId: "observation-1",
      guildId: GUILD,
      projectionType: "language_club_agenda_entry.v1",
      title: "English Study Club",
      summary: "A supportive English practice session for learners.",
      programKey: "english-study-club",
      seriesKey: null,
      scheduledStartAt: "2026-08-20T04:00:00.000Z",
      scheduledEndAt: null,
      timezone: "Asia/Jakarta",
      agendaState: "approved",
      updatedAt: NOW
    },
    source: {
      providerEventId: EVENT,
      guildId: GUILD,
      observationId: "observation-1",
      source: "discord_rest_reconciliation",
      sourceVersion: 1,
      observationState: "present",
      classificationState: "allowlisted",
      observedAt: NOW,
      updatedAt: NOW
    }
  };
}
