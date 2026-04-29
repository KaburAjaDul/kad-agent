export type ReminderType = "event_start" | "volunteer_nudge" | "wrap_up";

export type ReminderAudienceKind = "staff" | "volunteer" | "attendee";

export type ReminderState = "scheduled" | "leased" | "delivered" | "cancelled" | "failed";

export type ReminderPayload = {
  targetChannelId?: string;
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
  lastAttemptedAt?: string;
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
