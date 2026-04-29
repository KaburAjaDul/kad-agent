import type { SqliteDatabase } from "./sqlite.js";
import { SEEDED_EVENT_TEMPLATE_POLICIES } from "../../events/config/seeded-event-template-policies.js";

export function seedFoundationData(db: SqliteDatabase): number {
  const insertTemplate = db.prepare(`
    INSERT OR IGNORE INTO event_templates (
      id,
      template_key,
      template_version,
      name,
      event_type,
      default_approval_class,
      approval_class,
      classification,
      is_seeded,
      title_template,
      description_template,
      default_timezone,
      default_duration_minutes,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let insertedCount = 0;

  db.exec("BEGIN");

  try {
    for (const template of SEEDED_EVENT_TEMPLATE_POLICIES) {
      const result = insertTemplate.run(
        template.id,
        template.templateKey,
        template.templateVersion,
        template.name,
        template.eventType,
        template.approvalClass,
        template.approvalClass,
        template.classification,
        1,
        template.titleTemplate,
        template.descriptionTemplate,
        template.defaultTimezone,
        template.defaultDurationMinutes,
        template.createdAt
      );

      insertedCount += Number(result.changes);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return insertedCount;
}
