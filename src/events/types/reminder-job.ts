export type ReminderType = "event_start" | "t_minus_24h" | "t_minus_1h" | "volunteer_nudge" | "wrap_up";

export type ReminderAudienceKind = "staff" | "volunteer" | "attendee";

export type ReminderState =
  | "pending"
  | "sending"
  | "sent"
  | "cancelled"
  | "send_failed"
  | "retryable"
  | "needs_reconciliation"
  | "dead_letter";

export type ReminderPayload = {
  targetChannelId?: string;
  languageClubDisplayName?: string;
  scheduledStartAt?: string;
  hostVoiceChannelId?: string;
  note?: string;
};

export type ReminderJobRecord = {
  id: string;
  eventId: string;
  reminderType: ReminderType;
  audienceKind: ReminderAudienceKind;
  scheduledFor: string;
  state: ReminderState;
  jobKey: string;
  payload: ReminderPayload;
  discordMessageId?: string;
  lastAttemptedAt?: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  fencingToken?: number;
  runtimeFencingToken?: number;
  heartbeatAt?: string;
  attempts?: number;
  nextAttemptAt?: string;
  needsReconciliationAt?: string;
  deadLetteredAt?: string;
  deliveredAt?: string;
  deliveryError?: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateReminderJobInput = {
  eventId: string;
  reminderType: ReminderType;
  audienceKind: ReminderAudienceKind;
  scheduledFor: string;
  payload?: ReminderPayload;
  now?: Date;
};
