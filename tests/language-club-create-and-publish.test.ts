import { describe, expect, it, vi } from "vitest";
import { createSqliteConnection } from "../src/app/repo/sqlite.js";
import { runMigrations } from "../src/app/repo/migrations.js";
import { seedFoundationData } from "../src/app/repo/seeds.js";
import {
  getLanguageClubEventById,
  listEventHostSnapshotsByEventId,
  listEventStateTransitions
} from "../src/events/repo/language-club-event-repo.js";
import { createLanguageClubEvent } from "../src/events/service/create-language-club-event.js";
import { configureLanguageClubGuild } from "../src/events/service/language-club-guild-config-service.js";
import { upsertLanguageClubCommand } from "../src/events/service/language-club-registry-service.js";

describe("createLanguageClubEvent", () => {
  it("creates one scheduled event, persists its ID, then publishes the announcement", async () => {
    const db = createTestDatabase();
    const publishedPayloads: Array<{ channelId: string; content: string }> = [];
    const scheduledEventPayloads: Array<{
      guildId: string;
      channelId: string;
      title: string;
      description: string;
      scheduledStartAt: string;
      scheduledEndAt: string;
    }> = [];
    const publishOrder: string[] = [];

    try {
      configureTestGuild(db);

      const result = await createLanguageClubEvent(
        {
          guildId: "guild-1",
          actorDiscordUserId: "user-1",
          actorRoleIds: ["staff-role"],
          sourceInteractionId: "interaction-1",
          clubKey: "english",
          date: "2026-04-24",
          time: "19:30"
        },
        {
          db,
          publisher: createTestPublisher({
            createScheduledEvent: async (payload) => {
              publishOrder.push("scheduled_event");
              scheduledEventPayloads.push(payload);
              return { scheduledEventId: "scheduled-event-123" };
            },
            publishAnnouncement: async (payload) => {
              publishOrder.push("announcement");
              publishedPayloads.push(payload);
              return { messageId: "message-123" };
            }
          }),
          now: new Date("2026-04-23T10:00:00.000Z")
        }
      );

      expect(result).toMatchObject({
        status: "published",
        scheduledStartAt: "2026-04-24T12:30:00.000Z",
        discordScheduledEventId: "scheduled-event-123",
        messageId: "message-123"
      });
      expect(result.status).toBe("published");

      if (result.status !== "published") {
        throw new Error("Expected a published result.");
      }

      expect(publishedPayloads).toEqual([
        {
          channelId: "announcement-1",
          content: expect.stringContaining("English Club kita buka lagi")
        }
      ]);
      expect(scheduledEventPayloads).toEqual([
        {
          guildId: "guild-1",
          channelId: "voice-1",
          title: expect.stringContaining("Language Club KAD"),
          description: expect.stringContaining("komunitas KAD"),
          scheduledStartAt: "2026-04-24T12:30:00.000Z",
          scheduledEndAt: "2026-04-24T14:00:00.000Z"
        }
      ]);
      expect(publishOrder).toEqual(["scheduled_event", "announcement"]);

      const event = getLanguageClubEventById(db, result.eventId);

      expect(event).toMatchObject({
        id: result.eventId,
        guildId: "guild-1",
        announcementChannelId: "announcement-1",
        hostVoiceChannelId: "voice-1",
        languageClubKey: "english",
        languageClubDisplayName: "English Club",
        templateKey: "language_club_default",
        templateVersion: 1,
        eventType: "language_club",
        approvalClass: "routine_auto_publish",
        classification: "routine_language_club",
        schedulingScopeKey: "language_club_channel:voice-1",
        state: "published",
        timezone: "Asia/Jakarta",
        scheduledStartAt: "2026-04-24T12:30:00.000Z",
        scheduledEndAt: "2026-04-24T14:00:00.000Z",
        createdByDiscordUserId: "user-1",
        sourceInteractionId: "interaction-1",
        discordScheduledEventId: "scheduled-event-123",
        discordAnnouncementMessageId: "message-123"
      });
      expect(event?.title).toContain("Language Club KAD");
      expect(event?.description).toContain("komunitas KAD");
      expect(publishedPayloads[0]?.content).toContain("<#voice-1>");
      expect(publishedPayloads[0]?.content).toContain("Native Discord event-nya juga sudah aktif di server ini");
      expect(publishedPayloads[0]?.content).not.toContain("Host sesi ini:");
      expect(listEventHostSnapshotsByEventId(db, result.eventId)).toEqual([]);

      const reminders = db
        .prepare("SELECT reminder_type, audience_kind, scheduled_for, state, payload_json FROM event_reminders WHERE event_id = ? ORDER BY scheduled_for ASC")
        .all(result.eventId) as Array<{
        reminder_type: string;
        audience_kind: string;
        scheduled_for: string;
        state: string;
        payload_json: string;
      }>;

      expect(reminders.map((reminder) => ({
        reminderType: reminder.reminder_type,
        audienceKind: reminder.audience_kind,
        scheduledFor: reminder.scheduled_for,
        state: reminder.state,
        payload: JSON.parse(reminder.payload_json) as Record<string, string>
      }))).toEqual([
        {
          reminderType: "t_minus_24h",
          audienceKind: "attendee",
          scheduledFor: "2026-04-23T12:30:00.000Z",
          state: "pending",
          payload: expect.objectContaining({
            targetChannelId: "announcement-1",
            languageClubDisplayName: "English Club",
            scheduledStartAt: "2026-04-24T12:30:00.000Z",
            hostVoiceChannelId: "voice-1"
          })
        },
        {
          reminderType: "t_minus_1h",
          audienceKind: "attendee",
          scheduledFor: "2026-04-24T11:30:00.000Z",
          state: "pending",
          payload: expect.objectContaining({
            targetChannelId: "announcement-1",
            languageClubDisplayName: "English Club",
            scheduledStartAt: "2026-04-24T12:30:00.000Z",
            hostVoiceChannelId: "voice-1"
          })
        }
      ]);

      const transitions = listEventStateTransitions(db, result.eventId);

      expect(transitions).toHaveLength(2);
      expect(transitions.map((transition) => ({ fromState: transition.fromState, toState: transition.toState }))).toEqual([
        { fromState: null, toState: "drafted" },
        { fromState: "drafted", toState: "published" }
      ]);
      expect(transitions.every((transition) => transition.actorDiscordUserId === "user-1")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("persists an explicit per-event host channel override and host snapshots", async () => {
    const db = createTestDatabase();
    const publishedPayloads: Array<{ channelId: string; content: string }> = [];
    const scheduledEventChannelIds: string[] = [];

    try {
      configureTestGuild(db);

      const result = await createLanguageClubEvent(
        {
          guildId: "guild-1",
          actorDiscordUserId: "user-1",
          actorRoleIds: ["staff-role"],
          sourceInteractionId: "interaction-override",
          clubKey: "english",
          date: "2026-04-24",
          time: "19:30",
          hostVoiceChannelId: "voice-2",
          hostDiscordUserIds: ["host-1", "host-2"]
        },
        {
          db,
          publisher: createTestPublisher({
            createScheduledEvent: async (payload) => {
              scheduledEventChannelIds.push(payload.channelId);
              return { scheduledEventId: "scheduled-event-override" };
            },
            publishAnnouncement: async (payload) => {
              publishedPayloads.push(payload);
              return { messageId: "message-override" };
            }
          }),
          now: new Date("2026-04-23T10:00:00.000Z")
        }
      );

      expect(result).toMatchObject({
        status: "published",
        messageId: "message-override"
      });
      expect(result.status).toBe("published");

      if (result.status !== "published") {
        throw new Error("Expected a published result.");
      }

      const event = getLanguageClubEventById(db, result.eventId);
      const eventHosts = listEventHostSnapshotsByEventId(db, result.eventId);

      expect(event).toMatchObject({
        hostVoiceChannelId: "voice-2",
        schedulingScopeKey: "language_club_channel:voice-2",
        discordScheduledEventId: "scheduled-event-override",
        discordAnnouncementMessageId: "message-override"
      });
      expect(eventHosts).toEqual([
        expect.objectContaining({
          eventId: result.eventId,
          discordUserId: "host-1",
          displayOrder: 1,
          assignedByDiscordUserId: "user-1",
          assignedAt: "2026-04-23T10:00:00.000Z"
        }),
        expect.objectContaining({
          eventId: result.eventId,
          discordUserId: "host-2",
          displayOrder: 2,
          assignedByDiscordUserId: "user-1",
          assignedAt: "2026-04-23T10:00:00.000Z"
        })
      ]);
      expect(publishedPayloads).toEqual([
        {
          channelId: "announcement-1",
          content: expect.stringContaining("<#voice-2>")
        }
      ]);
      expect(scheduledEventChannelIds).toEqual(["voice-2"]);
      expect(publishedPayloads[0]?.content).toContain("Host sesi ini: <@host-1>, <@host-2>.");
    } finally {
      db.close();
    }
  });

  it("rejects unauthorized actors before persistence", async () => {
    const db = createTestDatabase();

    try {
      configureTestGuild(db);

      const result = await createLanguageClubEvent(
        {
          guildId: "guild-1",
          actorDiscordUserId: "user-1",
          actorRoleIds: ["member-role"],
          sourceInteractionId: "interaction-1",
          clubKey: "english",
          date: "2026-04-24",
          time: "19:30"
        },
        {
          db,
          publisher: createTestPublisher({
            publishAnnouncement: async () => {
              throw new Error("should not publish");
            }
          })
        }
      );

      expect(result).toEqual({
        status: "hard_rejected",
        reason: "Kamu tidak punya izin untuk membuat event Language Club."
      });
      expect(selectEventCount(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  it("rejects unknown or inactive club keys before persistence", async () => {
    const db = createTestDatabase();

    try {
      configureTestGuild(db);
      upsertLanguageClubCommand(db, {
        guildId: "guild-1",
        clubKey: "inactive",
        displayName: "Inactive Club",
        active: false,
        actorDiscordUserId: "admin-1"
      });

      const unknownResult = await createLanguageClubEvent(
        {
          guildId: "guild-1",
          actorDiscordUserId: "user-1",
          actorRoleIds: ["staff-role"],
          sourceInteractionId: "interaction-unknown",
          clubKey: "unknown",
          date: "2026-04-24",
          time: "19:30"
        },
        { db, publisher: createTestPublisher() }
      );
      const inactiveResult = await createLanguageClubEvent(
        {
          guildId: "guild-1",
          actorDiscordUserId: "user-1",
          actorRoleIds: ["staff-role"],
          sourceInteractionId: "interaction-inactive",
          clubKey: "inactive",
          date: "2026-04-24",
          time: "19:30"
        },
        { db, publisher: createTestPublisher() }
      );

      expect(unknownResult).toEqual({
        status: "hard_rejected",
        reason: "club_key belum dikonfigurasi aktif. Jalankan /setup language-club-upsert terlebih dahulu."
      });
      expect(inactiveResult).toEqual(unknownResult);
      expect(selectEventCount(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  it("allows same-time events only when club and host channel are both different", async () => {
    const db = createTestDatabase();

    try {
      configureTestGuild(db);
      upsertLanguageClubCommand(db, {
        guildId: "guild-1",
        clubKey: "indonesian",
        displayName: "Indonesian Club",
        defaultHostVoiceChannelId: "voice-2",
        actorDiscordUserId: "admin-1"
      });

      await createLanguageClubEvent(
        {
          guildId: "guild-1",
          actorDiscordUserId: "user-1",
          actorRoleIds: ["staff-role"],
          sourceInteractionId: "interaction-1",
          clubKey: "english",
          date: "2026-04-24",
          time: "19:30"
        },
        {
          db,
          publisher: createTestPublisher({
            publishAnnouncement: async () => ({ messageId: "message-123" })
          })
        }
      );

      const secondResult = await createLanguageClubEvent(
        {
          guildId: "guild-1",
          actorDiscordUserId: "user-2",
          actorRoleIds: ["staff-role"],
          sourceInteractionId: "interaction-2",
          clubKey: "indonesian",
          date: "2026-04-24",
          time: "19:30",
          hostVoiceChannelId: "voice-2"
        },
        {
          db,
          publisher: createTestPublisher({
            publishAnnouncement: async () => ({ messageId: "message-456" })
          })
        }
      );

      expect(secondResult).toMatchObject({
        status: "published"
      });

      const duplicateClubResult = await createLanguageClubEvent(
        {
          guildId: "guild-1",
          actorDiscordUserId: "user-3",
          actorRoleIds: ["staff-role"],
          sourceInteractionId: "interaction-duplicate-club",
          clubKey: "english",
          date: "2026-04-24",
          time: "19:30",
          hostVoiceChannelId: "voice-3"
        },
        {
          db,
          publisher: createTestPublisher({
            publishAnnouncement: async () => ({ messageId: "message-duplicate-club" })
          })
        }
      );

      expect(duplicateClubResult).toEqual({
        status: "hard_rejected",
        reason: "Sudah ada event Language Club untuk club_key dan jadwal mulai yang sama."
      });

      const duplicateResult = await createLanguageClubEvent(
        {
          guildId: "guild-1",
          actorDiscordUserId: "user-3",
          actorRoleIds: ["staff-role"],
          sourceInteractionId: "interaction-3",
          clubKey: "indonesian",
          date: "2026-04-24",
          time: "19:30",
          hostVoiceChannelId: "voice-2"
        },
        {
          db,
          publisher: createTestPublisher({
            publishAnnouncement: async () => ({ messageId: "message-789" })
          })
        }
      );

      expect(duplicateResult).toEqual({
        status: "hard_rejected",
        reason: "Sudah ada event Language Club untuk host channel dan jadwal mulai yang sama."
      });
      expect(selectEventCount(db)).toBe(2);
    } finally {
      db.close();
    }
  });

  it("deduplicates duplicate host inputs before persistence", async () => {
    const db = createTestDatabase();
    const publishedPayloads: Array<{ channelId: string; content: string }> = [];

    try {
      configureTestGuild(db);

      const result = await createLanguageClubEvent(
        {
          guildId: "guild-1",
          actorDiscordUserId: "user-1",
          actorRoleIds: ["staff-role"],
          sourceInteractionId: "interaction-dedupe",
          clubKey: "english",
          date: "2026-04-25",
          time: "19:30",
          hostDiscordUserIds: ["host-1", "host-1", "host-2", "  ", "host-2"]
        },
        {
          db,
          publisher: createTestPublisher({
            publishAnnouncement: async (payload) => {
              publishedPayloads.push(payload);
              return { messageId: "message-dedupe" };
            }
          }),
          now: new Date("2026-04-23T10:00:00.000Z")
        }
      );

      expect(result.status).toBe("published");

      if (result.status !== "published") {
        throw new Error("Expected a published result.");
      }

      const eventHosts = listEventHostSnapshotsByEventId(db, result.eventId);

      expect(eventHosts.map((eventHost) => ({ discordUserId: eventHost.discordUserId, displayOrder: eventHost.displayOrder }))).toEqual([
        { discordUserId: "host-1", displayOrder: 1 },
        { discordUserId: "host-2", displayOrder: 2 }
      ]);
      expect(publishedPayloads[0]?.content.match(/<@host-1>/g)?.length ?? 0).toBe(1);
      expect(publishedPayloads[0]?.content.match(/<@host-2>/g)?.length ?? 0).toBe(1);
    } finally {
      db.close();
    }
  });

  it("rejects missing setup config before persistence", async () => {
    const db = createTestDatabase();

    try {
      const missingConfigResult = await createLanguageClubEvent(
        {
          guildId: "guild-1",
          actorDiscordUserId: "user-1",
          actorRoleIds: ["staff-role"],
          sourceInteractionId: "interaction-1",
          clubKey: "english",
          date: "2026-04-24",
          time: "19:30"
        },
        {
          db,
          publisher: createTestPublisher({
            publishAnnouncement: async () => ({ messageId: "message-123" })
          })
        }
      );

      expect(missingConfigResult).toEqual({
        status: "hard_rejected",
        reason: "Guild ini belum dikonfigurasi untuk Event Slice E1. Jalankan /setup e1-configure terlebih dahulu."
      });
      expect(selectEventCount(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  it("rejects malformed schedule input before persistence", async () => {
    const db = createTestDatabase();

    try {
      configureTestGuild(db);

      const invalidInputResult = await createLanguageClubEvent(
        {
          guildId: "guild-1",
          actorDiscordUserId: "user-1",
          actorRoleIds: ["staff-role"],
          sourceInteractionId: "interaction-2",
          clubKey: "english",
          date: "2026-04-24",
          time: "25:61"
        },
        {
          db,
          publisher: createTestPublisher({
            publishAnnouncement: async () => ({ messageId: "message-123" })
          })
        }
      );

      expect(invalidInputResult).toEqual({
        status: "hard_rejected",
        reason: "Format jadwal tidak valid. Gunakan date YYYY-MM-DD dan time HH:mm."
      });
      expect(selectEventCount(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  it("marks publish_failed and skips announcement when scheduled event creation fails", async () => {
    const db = createTestDatabase();
    let announcementAttemptCount = 0;

    try {
      configureTestGuild(db);

      const result = await createLanguageClubEvent(
        {
          guildId: "guild-1",
          actorDiscordUserId: "user-1",
          actorRoleIds: ["staff-role"],
          sourceInteractionId: "interaction-scheduled-fail",
          clubKey: "english",
          date: "2026-04-24",
          time: "19:30"
        },
        {
          db,
          publisher: createTestPublisher({
            createScheduledEvent: async () => {
              throw new Error("Discord scheduled event failed");
            },
            publishAnnouncement: async () => {
              announcementAttemptCount += 1;
              return { messageId: "should-not-send" };
            }
          }),
          now: new Date("2026-04-23T10:00:00.000Z")
        }
      );

      expect(result).toMatchObject({
        status: "publish_failed",
        scheduledStartAt: "2026-04-24T12:30:00.000Z",
        reason: "Discord scheduled event failed",
        discordScheduledEventId: null
      });
      expect(result.status).toBe("publish_failed");

      if (result.status !== "publish_failed") {
        throw new Error("Expected a publish_failed result.");
      }

      const event = getLanguageClubEventById(db, result.eventId);

      expect(announcementAttemptCount).toBe(0);
      expect(event).toMatchObject({
        state: "publish_failed",
        publishError: "Discord scheduled event failed",
        publishFailedAt: expect.any(String),
        discordScheduledEventId: null,
        discordAnnouncementMessageId: null
      });

      const transitions = listEventStateTransitions(db, result.eventId);

      expect(transitions.map((transition) => ({ fromState: transition.fromState, toState: transition.toState }))).toEqual([
        { fromState: null, toState: "drafted" },
        { fromState: "drafted", toState: "publish_failed" }
      ]);
    } finally {
      db.close();
    }
  });

  it("keeps the scheduled event ID when announcement publish fails after scheduled event success", async () => {
    const db = createTestDatabase();
    let createScheduledEventCallCount = 0;

    try {
      configureTestGuild(db);

      const result = await createLanguageClubEvent(
        {
          guildId: "guild-1",
          actorDiscordUserId: "user-1",
          actorRoleIds: ["staff-role"],
          sourceInteractionId: "interaction-1",
          clubKey: "english",
          date: "2026-04-24",
          time: "19:30"
        },
        {
          db,
          publisher: createTestPublisher({
            createScheduledEvent: async () => {
              createScheduledEventCallCount += 1;
              return { scheduledEventId: "scheduled-event-partial" };
            },
            publishAnnouncement: async () => {
              throw new Error("Discord send failed");
            }
          }),
          now: new Date("2026-04-23T10:00:00.000Z")
        }
      );

      expect(result).toMatchObject({
        status: "publish_failed",
        scheduledStartAt: "2026-04-24T12:30:00.000Z",
        reason: "Discord send failed",
        discordScheduledEventId: "scheduled-event-partial"
      });
      expect(result.status).toBe("publish_failed");

      if (result.status !== "publish_failed") {
        throw new Error("Expected a publish_failed result.");
      }

      const event = getLanguageClubEventById(db, result.eventId);

      expect(createScheduledEventCallCount).toBe(1);
      expect(event).toMatchObject({
        state: "publish_failed",
        publishError: "Discord send failed",
        publishFailedAt: expect.any(String),
        discordScheduledEventId: "scheduled-event-partial",
        discordAnnouncementMessageId: null
      });

      const transitions = listEventStateTransitions(db, result.eventId);

      expect(transitions.map((transition) => ({ fromState: transition.fromState, toState: transition.toState }))).toEqual([
        { fromState: null, toState: "drafted" },
        { fromState: "drafted", toState: "publish_failed" }
      ]);
    } finally {
      db.close();
    }
  });

  it("does not create a second scheduled event inside one create flow execution", async () => {
    const db = createTestDatabase();
    let createScheduledEventCallCount = 0;

    try {
      configureTestGuild(db);

      const result = await createLanguageClubEvent(
        {
          guildId: "guild-1",
          actorDiscordUserId: "user-1",
          actorRoleIds: ["staff-role"],
          sourceInteractionId: "interaction-single-scheduled-event",
          clubKey: "english",
          date: "2026-04-26",
          time: "19:30"
        },
        {
          db,
          publisher: createTestPublisher({
            createScheduledEvent: async () => {
              createScheduledEventCallCount += 1;
              return { scheduledEventId: "scheduled-event-single" };
            },
            publishAnnouncement: async () => ({ messageId: "message-single" })
          }),
          now: new Date("2026-04-23T10:00:00.000Z")
        }
      );

      expect(result).toMatchObject({
        status: "published",
        discordScheduledEventId: "scheduled-event-single",
        messageId: "message-single"
      });
      expect(createScheduledEventCallCount).toBe(1);
    } finally {
      db.close();
    }
  });

  it("keeps a successfully published event published when reminder scheduling fails afterward", async () => {
    const db = createTestDatabase();
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      configureTestGuild(db);
      db.exec("DROP TABLE event_reminders");

      const result = await createLanguageClubEvent(
        {
          guildId: "guild-1",
          actorDiscordUserId: "user-1",
          actorRoleIds: ["staff-role"],
          sourceInteractionId: "interaction-reminder-schedule-failure",
          clubKey: "english",
          date: "2026-04-27",
          time: "19:30"
        },
        {
          db,
          publisher: createTestPublisher({
            createScheduledEvent: async () => ({ scheduledEventId: "scheduled-event-reminder-failure" }),
            publishAnnouncement: async () => ({ messageId: "message-reminder-failure" })
          }),
          now: new Date("2026-04-23T10:00:00.000Z")
        }
      );

      expect(result).toMatchObject({
        status: "published",
        discordScheduledEventId: "scheduled-event-reminder-failure",
        messageId: "message-reminder-failure"
      });
      expect(result.status).toBe("published");

      if (result.status !== "published") {
        throw new Error("Expected a published result.");
      }

      expect(getLanguageClubEventById(db, result.eventId)).toMatchObject({
        state: "published",
        publishError: null,
        discordScheduledEventId: "scheduled-event-reminder-failure",
        discordAnnouncementMessageId: "message-reminder-failure"
      });
      expect(listEventStateTransitions(db, result.eventId).map((transition) => transition.toState)).toEqual([
        "drafted",
        "published"
      ]);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "Language Club event published but reminder scheduling failed",
        expect.any(Error)
      );
    } finally {
      consoleErrorSpy.mockRestore();
      db.close();
    }
  });
});

function createTestDatabase() {
  const db = createSqliteConnection(":memory:");
  runMigrations(db);
  seedFoundationData(db);
  return db;
}

function configureTestGuild(db: ReturnType<typeof createSqliteConnection>) {
  const config = configureLanguageClubGuild(db, {
    guildId: "guild-1",
    announcementChannelId: "announcement-1",
    hostVoiceChannelId: "voice-1",
    defaultTimezone: "Asia/Jakarta",
    actorDiscordUserId: "admin-1",
    staffRoleIds: ["staff-role"]
  });

  upsertLanguageClubCommand(db, {
    guildId: "guild-1",
    clubKey: "english",
    displayName: "English Club",
    defaultHostVoiceChannelId: null,
    actorDiscordUserId: "admin-1"
  });

  return config;
}

function createTestPublisher(overrides?: {
  createScheduledEvent?: (input: {
    guildId: string;
    channelId: string;
    title: string;
    description: string;
    scheduledStartAt: string;
    scheduledEndAt: string;
  }) => Promise<{ scheduledEventId: string }>;
  publishAnnouncement?: (input: { channelId: string; content: string }) => Promise<{ messageId: string }>;
}) {
  return {
    createScheduledEvent: overrides?.createScheduledEvent ?? (async () => ({ scheduledEventId: "scheduled-event-default" })),
    publishAnnouncement: overrides?.publishAnnouncement ?? (async () => ({ messageId: "message-default" }))
  };
}

function selectEventCount(db: ReturnType<typeof createSqliteConnection>): number {
  return Number((db.prepare("SELECT COUNT(*) as count FROM events").get() as { count: number } | undefined)?.count ?? 0);
}
