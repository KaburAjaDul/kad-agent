import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  PermissionFlagsBits,
  type APIRole,
  type ChatInputCommandInteraction,
  type Role,
  type Interaction,
  type User
} from "discord.js";
import type { AppConfig } from "../../app/config/env.js";
import type { SqliteDatabase } from "../../app/repo/sqlite.js";
import { createLanguageClubEvent } from "../../events/service/create-language-club-event.js";
import {
  configureLanguageClubGuild,
  type ConfigureLanguageClubGuildInput
} from "../../events/service/language-club-guild-config-service.js";
import { getLanguageClubGuildConfigByGuildId } from "../../events/repo/language-club-guild-config-repo.js";
import {
  listLanguageClubsByGuildId,
  upsertLanguageClubCommand
} from "../../events/service/language-club-registry-service.js";

export type DiscordRuntime = {
  publishReminder: (input: { channelId: string; content: string }) => Promise<{ messageId: string }>;
  destroy: () => Promise<void>;
};

export async function startDiscordRuntime(
  appConfig: AppConfig,
  db: SqliteDatabase
): Promise<DiscordRuntime> {
  if (!appConfig.discord.botToken) {
    throw new Error("DISCORD_BOT_TOKEN is required to start the Discord runtime.");
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds]
  });

  client.once(Events.ClientReady, (readyClient) => {
    console.info(`Discord runtime ready as ${readyClient.user.tag}`);
  });

  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    if (interaction.commandName === "ping") {
      await interaction.reply({
        content: "KAD-Agent foundation is online. Seeded Language Club publish is ready.",
        ephemeral: true
      });
      return;
    }

    if (interaction.commandName === "event" && interaction.options.getSubcommand() === "create-language-club") {
      await handleCreateLanguageClub(interaction, db, {
        createScheduledEvent: async ({ guildId, channelId, title, description, scheduledStartAt, scheduledEndAt }) => {
          const guild = await client.guilds.fetch(guildId);
          const channel = await client.channels.fetch(channelId);

          if (!channel || (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice)) {
            throw new Error("Configured host channel must be a voice or stage channel for Discord Scheduled Event creation.");
          }

          if (channel.guildId !== guildId) {
            throw new Error("Configured host voice channel is not a valid in-server Discord channel.");
          }

          const scheduledEvent = await guild.scheduledEvents.create({
            name: title,
            description,
            scheduledStartTime: scheduledStartAt,
            scheduledEndTime: scheduledEndAt,
            privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
            entityType:
              channel.type === ChannelType.GuildStageVoice
                ? GuildScheduledEventEntityType.StageInstance
                : GuildScheduledEventEntityType.Voice,
            channel
          });

          return { scheduledEventId: scheduledEvent.id };
        },
        publishAnnouncement: async ({ channelId, content }) => {
          const channel = await client.channels.fetch(channelId);

          if (!channel || channel.type === ChannelType.DM || !("send" in channel)) {
            throw new Error("Configured announcement channel is not a sendable in-server Discord channel.");
          }

          const message = await channel.send({ content });

          return { messageId: message.id };
        }
      });
      return;
    }

    if (interaction.commandName === "setup" && interaction.options.getSubcommand() === "e1-configure") {
      await handleConfigureE1Setup(interaction, db);
      return;
    }

    if (interaction.commandName === "setup" && interaction.options.getSubcommand() === "e1-show") {
      await handleShowE1Setup(interaction, db);
      return;
    }

    if (interaction.commandName === "setup" && interaction.options.getSubcommand() === "language-club-upsert") {
      await handleLanguageClubUpsert(interaction, db);
      return;
    }

    if (interaction.commandName === "setup" && interaction.options.getSubcommand() === "language-club-list") {
      await handleLanguageClubList(interaction, db);
    }
  });

  await client.login(appConfig.discord.botToken);

  return {
    publishReminder: async ({ channelId, content }) => {
      const channel = await client.channels.fetch(channelId);

      if (!channel || channel.type === ChannelType.DM || !("send" in channel)) {
        throw new Error("Configured reminder channel is not a sendable in-server Discord channel.");
      }

      const message = await channel.send({ content });

      return { messageId: message.id };
    },
    destroy: async () => {
      client.destroy();
    }
  };
}

async function handleCreateLanguageClub(
  interaction: ChatInputCommandInteraction,
  db: SqliteDatabase,
  publisher: {
    createScheduledEvent: (input: {
      guildId: string;
      channelId: string;
      title: string;
      description: string;
      scheduledStartAt: string;
      scheduledEndAt: string;
    }) => Promise<{ scheduledEventId: string }>;
    publishAnnouncement: (input: { channelId: string; content: string }) => Promise<{ messageId: string }>;
  }
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const hostVoiceChannel = interaction.options.getChannel("host_voice_channel", false, [
    ChannelType.GuildVoice,
    ChannelType.GuildStageVoice
  ]);

  if (hostVoiceChannel && hostVoiceChannel.guildId !== interaction.guildId) {
    await interaction.editReply("Host voice channel override harus berupa voice/stage channel di guild ini.");
    return;
  }

  const hostUsers = [
    interaction.options.getUser("host_1", false),
    interaction.options.getUser("host_2", false),
    interaction.options.getUser("host_3", false)
  ].filter((user): user is User => user !== null);

  const result = await createLanguageClubEvent(
    {
      guildId: interaction.guildId,
      actorDiscordUserId: interaction.user.id,
      actorRoleIds: getInteractionRoleIds(interaction),
      sourceInteractionId: interaction.id,
      clubKey: interaction.options.getString("club_key", true),
      date: interaction.options.getString("date", true),
      time: interaction.options.getString("time", true),
      hostVoiceChannelId: hostVoiceChannel?.id ?? null,
      hostDiscordUserIds: hostUsers.map((user) => user.id)
    },
    {
      db,
      publisher
    }
  );

  if (result.status === "hard_rejected") {
    await interaction.editReply(`Permintaan ditolak: ${result.reason}`);
    return;
  }

  if (result.status === "publish_failed") {
    await interaction.editReply(
      result.discordScheduledEventId === null
        ? `Event tersimpan dengan ID ${result.eventId}, tetapi publish gagal sebelum announcement terkirim: ${result.reason}`
        : `Event tersimpan dengan ID ${result.eventId} dan Discord Scheduled Event ${result.discordScheduledEventId}, tetapi announcement gagal: ${result.reason}`
    );
    return;
  }

  await interaction.editReply(
    `Event berhasil dibuat dan dipublish. event_id=${result.eventId} mulai=${result.scheduledStartAt} discord_scheduled_event_id=${result.discordScheduledEventId} message_id=${result.messageId}`
  );
}

async function handleConfigureE1Setup(interaction: ChatInputCommandInteraction, db: SqliteDatabase): Promise<void> {
  const guildId = interaction.guildId;

  if (!guildId) {
    await replyEphemeral(interaction, "Perintah setup ini hanya bisa dipakai di dalam server Discord.");
    return;
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await replyEphemeral(interaction, "Kamu harus punya izin Administrator untuk mengubah setup Event Slice E1.");
    return;
  }

  const announcementChannel = interaction.options.getChannel("announcement_channel", true, [
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement
  ]);
  const hostVoiceChannel = interaction.options.getChannel("host_voice_channel", true, [
    ChannelType.GuildVoice,
    ChannelType.GuildStageVoice
  ]);
  const staffRoles = [
    interaction.options.getRole("staff_role_1", true),
    interaction.options.getRole("staff_role_2", false),
    interaction.options.getRole("staff_role_3", false),
    interaction.options.getRole("staff_role_4", false),
    interaction.options.getRole("staff_role_5", false)
  ].filter((role): role is Role | APIRole => role !== null);

  if (announcementChannel.guildId !== guildId || !("send" in announcementChannel)) {
    await replyEphemeral(
      interaction,
      "Announcement channel harus berupa text/announcement channel yang bisa dipakai mengirim pesan di guild ini."
    );
    return;
  }

  if (hostVoiceChannel.guildId !== guildId) {
    await replyEphemeral(interaction, "Host voice channel harus berupa voice/stage channel di guild ini.");
    return;
  }

  if (staffRoles.length === 0) {
    await replyEphemeral(interaction, "Minimal satu staff role wajib diisi untuk setup Event Slice E1.");
    return;
  }

  if (staffRoles.some((role) => roleBelongsToDifferentGuild(role, guildId))) {
    await replyEphemeral(interaction, "Semua staff role harus berasal dari guild yang sama.");
    return;
  }

  try {
    const storedConfig = configureLanguageClubGuild(db, {
      guildId,
      announcementChannelId: announcementChannel.id,
      hostVoiceChannelId: hostVoiceChannel.id,
      defaultTimezone: interaction.options.getString("timezone", true),
      actorDiscordUserId: interaction.user.id,
      staffRoleIds: staffRoles.map((role) => role.id)
    } satisfies ConfigureLanguageClubGuildInput);

    await replyEphemeral(interaction, formatE1ConfigSummary(storedConfig, "Konfigurasi Event Slice E1 tersimpan."));
  } catch (error) {
    await replyEphemeral(interaction, formatSetupErrorMessage(error));
  }
}

async function handleShowE1Setup(interaction: ChatInputCommandInteraction, db: SqliteDatabase): Promise<void> {
  const guildId = interaction.guildId;

  if (!guildId) {
    await replyEphemeral(interaction, "Perintah setup ini hanya bisa dipakai di dalam server Discord.");
    return;
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await replyEphemeral(interaction, "Kamu harus punya izin Administrator untuk melihat setup Event Slice E1.");
    return;
  }

  const storedConfig = getLanguageClubGuildConfigByGuildId(db, guildId);

  if (!storedConfig) {
    await replyEphemeral(interaction, "Guild ini belum punya konfigurasi Event Slice E1 di SQLite.");
    return;
  }

  await replyEphemeral(interaction, formatE1ConfigSummary(storedConfig, "Konfigurasi Event Slice E1 ditemukan."));
}

async function handleLanguageClubUpsert(interaction: ChatInputCommandInteraction, db: SqliteDatabase): Promise<void> {
  const guildId = interaction.guildId;

  if (!guildId) {
    await replyEphemeral(interaction, "Perintah setup ini hanya bisa dipakai di dalam server Discord.");
    return;
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await replyEphemeral(interaction, "Kamu harus punya izin Administrator untuk mengubah registry Language Club.");
    return;
  }

  const defaultHostVoiceChannel = interaction.options.getChannel("default_host_voice_channel", false, [
    ChannelType.GuildVoice,
    ChannelType.GuildStageVoice
  ]);

  if (defaultHostVoiceChannel && defaultHostVoiceChannel.guildId !== guildId) {
    await replyEphemeral(interaction, "Default host voice channel harus berupa voice/stage channel di guild ini.");
    return;
  }

  try {
    const club = upsertLanguageClubCommand(db, {
      guildId,
      clubKey: interaction.options.getString("club_key", true),
      displayName: interaction.options.getString("display_name", true),
      defaultHostVoiceChannelId: defaultHostVoiceChannel?.id ?? null,
      active: interaction.options.getBoolean("active", false) ?? true,
      actorDiscordUserId: interaction.user.id
    });

    await replyEphemeral(
      interaction,
      [
        "Language Club registry tersimpan.",
        `club_key: ${club.clubKey}`,
        `display_name: ${club.displayName}`,
        `default_host_voice_channel: ${club.defaultHostVoiceChannelId ? `<#${club.defaultHostVoiceChannelId}>` : "-"}`,
        `active: ${club.isActive ? "yes" : "no"}`
      ].join("\n")
    );
  } catch (error) {
    await replyEphemeral(interaction, `Language Club registry ditolak: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

async function handleLanguageClubList(interaction: ChatInputCommandInteraction, db: SqliteDatabase): Promise<void> {
  const guildId = interaction.guildId;

  if (!guildId) {
    await replyEphemeral(interaction, "Perintah setup ini hanya bisa dipakai di dalam server Discord.");
    return;
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await replyEphemeral(interaction, "Kamu harus punya izin Administrator untuk melihat registry Language Club.");
    return;
  }

  const clubs = listLanguageClubsByGuildId(db, guildId);

  if (clubs.length === 0) {
    await replyEphemeral(interaction, "Belum ada assigned Language Club yang dikonfigurasi.");
    return;
  }

  await replyEphemeral(
    interaction,
    clubs
      .map((club) =>
        [
          `${club.clubKey} — ${club.displayName}`,
          `active=${club.isActive ? "yes" : "no"}`,
          `default_host_voice_channel=${club.defaultHostVoiceChannelId ? `<#${club.defaultHostVoiceChannelId}>` : "-"}`,
          `updated=${club.updatedAt}`
        ].join(" | ")
      )
      .join("\n")
  );
}

function formatE1ConfigSummary(
  config: {
    announcementChannelId: string;
    hostVoiceChannelId: string;
    defaultTimezone: string;
    staffRoleIds: string[];
    updatedAt: string;
    updatedByDiscordUserId: string;
  },
  prefix: string
): string {
  const staffRoleMentions = config.staffRoleIds.map((roleId) => `<@&${roleId}>`).join(", ");

  return [
    prefix,
    `Announcement channel: <#${config.announcementChannelId}>`,
    `Host voice channel: <#${config.hostVoiceChannelId}>`,
    `Timezone: ${config.defaultTimezone}`,
    `Staff roles: ${staffRoleMentions}`,
    `Updated: ${config.updatedAt} by <@${config.updatedByDiscordUserId}>`
  ].join("\n");
}

function formatSetupErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return `Setup Event Slice E1 ditolak: ${error.message}`;
  }

  return "Setup Event Slice E1 ditolak karena terjadi error yang tidak dikenal.";
}

async function replyEphemeral(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp({ content, ephemeral: true });
    return;
  }

  await interaction.reply({ content, ephemeral: true });
}

function getInteractionRoleIds(interaction: ChatInputCommandInteraction): string[] {
  const member = interaction.member;

  if (!member) {
    return [];
  }

  if ("roles" in member) {
    if (Array.isArray(member.roles)) {
      return member.roles;
    }

    if ("cache" in member.roles) {
      return [...member.roles.cache.keys()];
    }
  }

  return [];
}

function roleBelongsToDifferentGuild(role: Role | APIRole, guildId: string): boolean {
  return "guild" in role && role.guild.id !== guildId;
}
