import type { EventTemplatePolicy } from "../types/event-policy.js";

export const SEEDED_EVENT_TEMPLATE_POLICIES: EventTemplatePolicy[] = [
  {
    id: "0195c2c0-0000-7000-8000-000000000001",
    templateKey: "language_club_default",
    templateVersion: 1,
    name: "Language Club Default",
    eventType: "language_club",
    approvalClass: "routine_auto_publish",
    classification: "routine_language_club",
    titleTemplate: "Language Club KAD — {day_name}, {date_label}",
    descriptionTemplate:
      "Yuk latihan ngobrol santai bareng komunitas KAD pada {day_name}, {date_label} pukul {time_label} ({timezone_label}).",
    defaultTimezone: "Asia/Jakarta",
    defaultDurationMinutes: 90,
    createdAt: "2026-01-01T00:00:00.000Z"
  }
];
