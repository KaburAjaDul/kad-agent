import type { DiscordScheduledEvent, PublicAgendaEntry } from "./types.js";

export type AgendaCategory =
  | "japanese_n5"
  | "japanese_n4"
  | "japanese_n3"
  | "japanese_advanced"
  | "japanese_immersive"
  | "arabic"
  | "french"
  | "english"
  | "ielts"
  | "mandarin";

type Classification = {
  category: AgendaCategory;
  program: string;
  series: string | null;
  title: string;
  summary: string;
};

const japaneseLabel: Record<Extract<AgendaCategory, `japanese_${string}`>, { series: string; title: string; summary: string }> = {
  japanese_n5: {
    series: "N5",
    title: "Japanese Study Club — N5",
    summary: "A welcoming Japanese practice session for N5 learners."
  },
  japanese_n4: {
    series: "N4",
    title: "Japanese Study Club — N4",
    summary: "Guided Japanese practice for N4 learners."
  },
  japanese_n3: {
    series: "N3",
    title: "Japanese Study Club — N3",
    summary: "Guided Japanese practice for N3 learners."
  },
  japanese_advanced: {
    series: "Advanced",
    title: "Japanese Study Club — advanced",
    summary: "Japanese conversation and study for advanced learners."
  },
  japanese_immersive: {
    series: "Immersive",
    title: "Japanese Study Club — immersive",
    summary: "An immersive Japanese practice session for active learners."
  }
};

export function classifyLanguageEvent(event: DiscordScheduledEvent): Classification | null {
  const name = normalizeTitle(event.name);

  const exact: Record<string, Classification> = {
    "japanese for beginner n5": { category: "japanese_n5", program: "Japanese Study Club", ...japaneseLabel.japanese_n5 },
    "japanese for beginner n4": { category: "japanese_n4", program: "Japanese Study Club", ...japaneseLabel.japanese_n4 },
    "japanese intermediate - n3": { category: "japanese_n3", program: "Japanese Study Club", ...japaneseLabel.japanese_n3 },
    "japanese advanced": { category: "japanese_advanced", program: "Japanese Study Club", ...japaneseLabel.japanese_advanced },
    "日本語 immersive learning": { category: "japanese_immersive", program: "Japanese Study Club", ...japaneseLabel.japanese_immersive },
    "日本語 immersive learning with soubi": { category: "japanese_immersive", program: "Japanese Study Club", ...japaneseLabel.japanese_immersive },
    "arabic club session": { category: "arabic", program: "Arabic Study Club", series: null, title: "Arabic Study Club", summary: "A practical Arabic practice session for learners." },
    "french club study session": { category: "french", program: "French Study Club", series: null, title: "French Study Club", summary: "A practical French practice session for learners." },
    "english practice session": { category: "english", program: "English Study Club", series: null, title: "English Study Club", summary: "A supportive English practice session for learners." },
    "english practice session 🇬🇧": { category: "english", program: "English Study Club", series: null, title: "English Study Club", summary: "A supportive English practice session for learners." },
    "surprise data reading for ielts writing": { category: "ielts", program: "English Study Club", series: "IELTS Writing", title: "IELTS Writing study session", summary: "A practical study session for IELTS learners." },
    "mandarin study club": { category: "mandarin", program: "Mandarin Study Club", series: null, title: "Mandarin Study Club", summary: "A practical Mandarin practice session for learners." }
  };

  return exact[name] ?? null;
}

export function normalizeTitle(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[\u2013\u2014]/g, "-").replace(/\s+/g, " ").trim();
}

export function publicEntryFor(event: DiscordScheduledEvent, id: string, classification: Classification): PublicAgendaEntry {
  const startAt = validIso(event.scheduled_start_time, "start time");
  const endAt = event.scheduled_end_time == null ? null : validIso(event.scheduled_end_time, "end time");

  if (event.status !== 1 && event.status !== 2) {
    throw new Error("Unsupported Discord event status.");
  }

  if (event.entity_type !== 2 && event.entity_type !== 3) {
    throw new Error("Unsupported Discord event entity type.");
  }

  if (endAt != null && new Date(endAt).getTime() <= new Date(startAt).getTime()) {
    throw new Error("Discord event end time must follow its start time.");
  }

  if (event.privacy_level !== 2) {
    throw new Error("Discord event is not guild-public.");
  }

  return {
    id,
    title: classification.title,
    summary: classification.summary,
    startAt,
    endAt,
    timezone: "Asia/Jakarta",
    status: event.status === 2 ? "active" : "scheduled",
    program: classification.program,
    series: classification.series,
    joinUrl: "https://discord.gg/RUFFbEaeDx",
    source: "discord_scheduled_event"
  };
}

function validIso(value: string, label: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid Discord ${label}.`);
  return date.toISOString();
}
