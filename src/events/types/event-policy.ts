export type EventType = "language_club" | "regional_sharing" | "cerita_aja_dulu";

export type ApprovalClass = "routine_auto_publish" | "approval_required" | "hard_stop";

export type CompatibilityClassification =
  | "routine_language_club"
  | "routine_regional_sharing"
  | "approval_cerita_aja_dulu";

export type SupportedTemplateKey =
  | "language_club_default"
  | "regional_sharing_default"
  | "cerita_aja_dulu_featured";

export type EventTemplatePolicy = {
  id: string;
  templateKey: SupportedTemplateKey;
  templateVersion: number;
  name: string;
  eventType: EventType;
  approvalClass: Exclude<ApprovalClass, "hard_stop">;
  classification: CompatibilityClassification;
  titleTemplate: string;
  descriptionTemplate: string;
  defaultTimezone: string;
  defaultDurationMinutes: number;
  createdAt: string;
};

export type EventPolicyDecision = {
  templateKey: string;
  eventType?: EventType;
  approvalClass: ApprovalClass;
  classification?: CompatibilityClassification;
  reason?: string;
};
