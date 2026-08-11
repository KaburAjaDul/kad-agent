export type DiscordGuild = {
  id: string;
  name: string;
  banner?: string | null;
};

export type DiscordScheduledEvent = {
  id: string;
  name: string;
  scheduled_start_time: string;
  scheduled_end_time?: string | null;
  status: number;
  entity_type: number;
  privacy_level: number;
  guild_id: string;
  entity_id?: string | null;
  recurrence_rule?: unknown | null;
  guild_scheduled_event_exceptions?: unknown[];
  sku_ids?: string[];
};

export type AgendaStatus = "scheduled" | "active";

export type PublicAgendaEntry = {
  id: string;
  title: string;
  summary: string;
  startAt: string;
  endAt: string | null;
  timezone: "Asia/Jakarta";
  status: AgendaStatus;
  program: string;
  series: string | null;
  joinUrl: "https://discord.gg/RUFFbEaeDx";
  source: "discord_scheduled_event";
};

export type AgendaProjection = {
  schemaVersion: "v1";
  observedAt: string;
  revision: number;
  entries: PublicAgendaEntry[];
  tombstones: string[];
};

export type ProjectionSignature = {
  schemaVersion: "v1";
  keyId: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  contentSha256: string;
  signature: string;
  body: string;
};

export type PublicationResult = {
  projection: AgendaProjection;
  signature: ProjectionSignature;
  categories: Record<string, number>;
};
