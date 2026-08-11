import type { SqliteDatabase } from "../../app/repo/sqlite.js";

export type StoredLanguageClubTemplate = {
  id: string;
  templateKey: string;
  templateVersion: number;
  eventType: string;
  approvalClass: string;
  classification: string;
  titleTemplate: string;
  descriptionTemplate: string;
  defaultTimezone: string;
  defaultDurationMinutes: number;
};

export type StoredLanguageClubEvent = {
  id: string;
  guildId: string;
  announcementChannelId: string;
  hostVoiceChannelId: string | null;
  languageClubId: string | null;
  languageClubKey: string | null;
  languageClubDisplayName: string | null;
  templateId: string;
  templateKey: string;
  templateVersion: number;
  eventType: string;
  approvalClass: string;
  classification: string;
  schedulingScopeKey: string;
  state: string;
  title: string;
  description: string;
  timezone: string;
  scheduledStartAt: string;
  scheduledEndAt: string;
  createdByDiscordUserId: string;
  sourceInteractionId: string;
  draftedAt: string;
  publishedAt: string | null;
  publishFailedAt: string | null;
  publishError: string | null;
  discordAnnouncementMessageId: string | null;
  discordScheduledEventId: string | null;
  googleCalendarEventId: string | null;
};

export type EventStateTransitionRecord = {
  id: string;
  eventId: string;
  fromState: string | null;
  toState: string;
  actorDiscordUserId: string;
  occurredAt: string;
  reason: string | null;
};

export type StoredEventHostSnapshot = {
  id: string;
  eventId: string;
  discordUserId: string;
  displayOrder: number;
  assignedByDiscordUserId: string;
  assignedAt: string;
};

type DraftEventInsertInput = StoredLanguageClubEvent;
type DraftEventHostInsertInput = StoredEventHostSnapshot;

export function findSupportedLanguageClubTemplate(db: SqliteDatabase): StoredLanguageClubTemplate | null {
  const row = db
    .prepare(
      `
        SELECT
          id,
          template_key,
          template_version,
          event_type,
          approval_class,
          classification,
          title_template,
          description_template,
          default_timezone,
          default_duration_minutes
        FROM event_templates
        WHERE template_key = ?
          AND template_version = ?
      `
    )
    .get("language_club_default", 1) as
    | {
        id: string;
        template_key: string;
        template_version: number;
        event_type: string;
        approval_class: string;
        classification: string;
        title_template: string;
        description_template: string;
        default_timezone: string;
        default_duration_minutes: number;
      }
    | undefined;

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    templateKey: row.template_key,
    templateVersion: Number(row.template_version),
    eventType: row.event_type,
    approvalClass: row.approval_class,
    classification: row.classification,
    titleTemplate: row.title_template,
    descriptionTemplate: row.description_template,
    defaultTimezone: row.default_timezone,
    defaultDurationMinutes: Number(row.default_duration_minutes)
  };
}

export function findLanguageClubEventBySchedule(
  db: SqliteDatabase,
  guildId: string,
  scheduledStartAt: string,
  schedulingScopeKey: string
): StoredLanguageClubEvent | null {
  const row = db
    .prepare(
      `
        SELECT
          id,
          guild_id,
          announcement_channel_id,
          host_voice_channel_id,
          language_club_id,
          language_club_key,
          language_club_display_name,
          template_id,
          template_key,
          template_version,
          event_type,
          approval_class,
          classification,
          scheduling_scope_key,
          state,
          title,
          description,
          timezone,
          scheduled_start_at,
          scheduled_end_at,
          created_by_discord_user_id,
          source_interaction_id,
          drafted_at,
          published_at,
          publish_failed_at,
          publish_error,
          discord_announcement_message_id,
          discord_scheduled_event_id,
          google_calendar_event_id
        FROM events
        WHERE guild_id = ?
          AND event_type = ?
          AND scheduling_scope_key = ?
          AND scheduled_start_at = ?
      `
    )
    .get(guildId, "language_club", schedulingScopeKey, scheduledStartAt) as EventRow | undefined;

  return row ? mapEventRow(row) : null;
}

export function findLanguageClubEventByClubSchedule(
  db: SqliteDatabase,
  guildId: string,
  languageClubId: string,
  scheduledStartAt: string
): StoredLanguageClubEvent | null {
  const row = db
    .prepare(
      `
        SELECT
          id,
          guild_id,
          announcement_channel_id,
          host_voice_channel_id,
          language_club_id,
          language_club_key,
          language_club_display_name,
          template_id,
          template_key,
          template_version,
          event_type,
          approval_class,
          classification,
          scheduling_scope_key,
          state,
          title,
          description,
          timezone,
          scheduled_start_at,
          scheduled_end_at,
          created_by_discord_user_id,
          source_interaction_id,
          drafted_at,
          published_at,
          publish_failed_at,
          publish_error,
          discord_announcement_message_id,
          discord_scheduled_event_id,
          google_calendar_event_id
        FROM events
        WHERE guild_id = ?
          AND event_type = ?
          AND language_club_id = ?
          AND scheduled_start_at = ?
      `
    )
    .get(guildId, "language_club", languageClubId, scheduledStartAt) as EventRow | undefined;

  return row ? mapEventRow(row) : null;
}

export function getLanguageClubEventById(db: SqliteDatabase, eventId: string): StoredLanguageClubEvent | null {
  const row = db
    .prepare(
      `
        SELECT
          id,
          guild_id,
          announcement_channel_id,
          host_voice_channel_id,
          language_club_id,
          language_club_key,
          language_club_display_name,
          template_id,
          template_key,
          template_version,
          event_type,
          approval_class,
          classification,
          scheduling_scope_key,
          state,
          title,
          description,
          timezone,
          scheduled_start_at,
          scheduled_end_at,
          created_by_discord_user_id,
          source_interaction_id,
          drafted_at,
          published_at,
          publish_failed_at,
          publish_error,
          discord_announcement_message_id,
          discord_scheduled_event_id,
          google_calendar_event_id
        FROM events
        WHERE id = ?
      `
    )
    .get(eventId) as EventRow | undefined;

  return row ? mapEventRow(row) : null;
}

export function createDraftedLanguageClubEvent(
  db: SqliteDatabase,
  event: DraftEventInsertInput,
  transition: EventStateTransitionRecord,
  eventHosts: DraftEventHostInsertInput[] = []
): void {
  db.exec("BEGIN");

  try {
    db.prepare(
      `
        INSERT INTO events (
          id,
          guild_id,
          template_id,
          template_key,
          title,
          description,
          state,
          event_type,
          approval_class,
          classification,
          scheduled_start_at,
          scheduled_end_at,
          target_channel_id,
          announcement_message_id,
          published_at,
          created_by_discord_user_id,
          created_at,
          updated_at,
          announcement_channel_id,
          host_voice_channel_id,
          language_club_id,
          language_club_key,
          language_club_display_name,
          template_version,
          scheduling_scope_key,
          timezone,
          source_interaction_id,
          drafted_at,
          publish_failed_at,
          publish_error,
          discord_announcement_message_id,
          discord_scheduled_event_id,
          google_calendar_event_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      event.id,
      event.guildId,
      event.templateId,
      event.templateKey,
      event.title,
      event.description,
      event.state,
      event.eventType,
      event.approvalClass,
      event.classification,
      event.scheduledStartAt,
      event.scheduledEndAt,
      event.announcementChannelId,
      null,
      null,
      event.createdByDiscordUserId,
      event.draftedAt,
      event.draftedAt,
      event.announcementChannelId,
      event.hostVoiceChannelId,
      event.languageClubId,
      event.languageClubKey,
      event.languageClubDisplayName,
      event.templateVersion,
      event.schedulingScopeKey,
      event.timezone,
      event.sourceInteractionId,
      event.draftedAt,
      null,
      null,
      null,
      event.discordScheduledEventId,
      event.googleCalendarEventId
    );

    insertEventHosts(db, eventHosts);
    insertEventStateTransition(db, transition);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function markLanguageClubEventPublished(
  db: SqliteDatabase,
  eventId: string,
  publishedAt: string,
  discordAnnouncementMessageId: string,
  transition: EventStateTransitionRecord
): void {
  db.exec("BEGIN");

  try {
    db.prepare(
      `
        UPDATE events
        SET state = ?,
            published_at = ?,
            announcement_message_id = ?,
            discord_announcement_message_id = ?,
            updated_at = ?
        WHERE id = ?
      `
    ).run("published", publishedAt, discordAnnouncementMessageId, discordAnnouncementMessageId, publishedAt, eventId);

    insertEventStateTransition(db, transition);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function storeLanguageClubEventDiscordScheduledEventId(
  db: SqliteDatabase,
  eventId: string,
  discordScheduledEventId: string,
  updatedAt: string
): void {
  const result = db
    .prepare(
      `
        UPDATE events
        SET discord_scheduled_event_id = ?,
            updated_at = ?
        WHERE id = ?
          AND discord_scheduled_event_id IS NULL
      `
    )
    .run(discordScheduledEventId, updatedAt, eventId) as { changes?: number };

  if (Number(result.changes ?? 0) !== 1) {
    throw new Error("Discord Scheduled Event ID untuk event ini sudah tersimpan atau event tidak ditemukan.");
  }
}

export function markLanguageClubEventPublishFailed(
  db: SqliteDatabase,
  eventId: string,
  failedAt: string,
  publishError: string,
  transition: EventStateTransitionRecord
): void {
  db.exec("BEGIN");

  try {
    db.prepare(
      `
        UPDATE events
        SET state = ?,
            publish_failed_at = ?,
            publish_error = ?,
            updated_at = ?
        WHERE id = ?
      `
    ).run("publish_failed", failedAt, publishError, failedAt, eventId);

    insertEventStateTransition(db, transition);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function listEventStateTransitions(db: SqliteDatabase, eventId: string): EventStateTransitionRecord[] {
  const rows = db
    .prepare(
      `
        SELECT
          id,
          event_id,
          from_state,
          to_state,
          actor_discord_user_id,
          occurred_at,
          reason
        FROM event_state_transitions
        WHERE event_id = ?
        ORDER BY occurred_at ASC, id ASC
      `
    )
    .all(eventId) as TransitionRow[];

  return rows.map((row) => ({
    id: row.id,
    eventId: row.event_id,
    fromState: row.from_state,
    toState: row.to_state,
    actorDiscordUserId: row.actor_discord_user_id,
    occurredAt: row.occurred_at,
    reason: row.reason
  }));
}

export function listEventHostSnapshotsByEventId(db: SqliteDatabase, eventId: string): StoredEventHostSnapshot[] {
  const rows = db
    .prepare(
      `
        SELECT
          id,
          event_id,
          discord_user_id,
          display_order,
          assigned_by_discord_user_id,
          assigned_at
        FROM event_hosts
        WHERE event_id = ?
        ORDER BY display_order ASC, id ASC
      `
    )
    .all(eventId) as EventHostRow[];

  return rows.map((row) => ({
    id: row.id,
    eventId: row.event_id,
    discordUserId: row.discord_user_id,
    displayOrder: Number(row.display_order),
    assignedByDiscordUserId: row.assigned_by_discord_user_id,
    assignedAt: row.assigned_at
  }));
}

function insertEventHosts(db: SqliteDatabase, eventHosts: DraftEventHostInsertInput[]): void {
  if (eventHosts.length === 0) {
    return;
  }

  const insertHost = db.prepare(
    `
      INSERT INTO event_hosts (
        id,
        event_id,
        discord_user_id,
        display_order,
        assigned_by_discord_user_id,
        assigned_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `
  );

  for (const eventHost of eventHosts) {
    insertHost.run(
      eventHost.id,
      eventHost.eventId,
      eventHost.discordUserId,
      eventHost.displayOrder,
      eventHost.assignedByDiscordUserId,
      eventHost.assignedAt
    );
  }
}

function insertEventStateTransition(db: SqliteDatabase, transition: EventStateTransitionRecord): void {
  db.prepare(
    `
      INSERT INTO event_state_transitions (
        id,
        event_id,
        from_state,
        to_state,
        actor_discord_user_id,
        reason,
        occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `
  ).run(
    transition.id,
    transition.eventId,
    transition.fromState,
    transition.toState,
    transition.actorDiscordUserId,
    transition.reason,
    transition.occurredAt
  );
}

type EventRow = {
  id: string;
  guild_id: string;
  announcement_channel_id: string;
  host_voice_channel_id: string | null;
  language_club_id: string | null;
  language_club_key: string | null;
  language_club_display_name: string | null;
  template_id: string;
  template_key: string;
  template_version: number;
  event_type: string;
  approval_class: string;
  classification: string;
  scheduling_scope_key: string;
  state: string;
  title: string;
  description: string;
  timezone: string;
  scheduled_start_at: string;
  scheduled_end_at: string;
  created_by_discord_user_id: string;
  source_interaction_id: string;
  drafted_at: string;
  published_at: string | null;
  publish_failed_at: string | null;
  publish_error: string | null;
  discord_announcement_message_id: string | null;
  discord_scheduled_event_id: string | null;
  google_calendar_event_id: string | null;
};

type TransitionRow = {
  id: string;
  event_id: string;
  from_state: string | null;
  to_state: string;
  actor_discord_user_id: string;
  occurred_at: string;
  reason: string | null;
};

type EventHostRow = {
  id: string;
  event_id: string;
  discord_user_id: string;
  display_order: number;
  assigned_by_discord_user_id: string;
  assigned_at: string;
};

function mapEventRow(row: EventRow): StoredLanguageClubEvent {
  return {
    id: row.id,
    guildId: row.guild_id,
    announcementChannelId: row.announcement_channel_id,
    hostVoiceChannelId: row.host_voice_channel_id,
    languageClubId: row.language_club_id,
    languageClubKey: row.language_club_key,
    languageClubDisplayName: row.language_club_display_name,
    templateId: row.template_id,
    templateKey: row.template_key,
    templateVersion: Number(row.template_version),
    eventType: row.event_type,
    approvalClass: row.approval_class,
    classification: row.classification,
    schedulingScopeKey: row.scheduling_scope_key,
    state: row.state,
    title: row.title,
    description: row.description,
    timezone: row.timezone,
    scheduledStartAt: row.scheduled_start_at,
    scheduledEndAt: row.scheduled_end_at,
    createdByDiscordUserId: row.created_by_discord_user_id,
    sourceInteractionId: row.source_interaction_id,
    draftedAt: row.drafted_at,
    publishedAt: row.published_at,
    publishFailedAt: row.publish_failed_at,
    publishError: row.publish_error,
    discordAnnouncementMessageId: row.discord_announcement_message_id,
    discordScheduledEventId: row.discord_scheduled_event_id,
    googleCalendarEventId: row.google_calendar_event_id
  };
}
