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
import {
  createOperationalLogger,
  toSafeOperationalErrorMessage,
  type OperationalLogger
} from "../../app/lib/operational-logger.js";
import type { SqliteDatabase } from "../../app/repo/sqlite.js";
import { isAllowedGuildId } from "./register-commands.js";
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
  const logger = createOperationalLogger({ level: appConfig.logLevel });

  if (!appConfig.discord.botToken) {
    throw new Error("DISCORD_BOT_TOKEN is required to start the Discord runtime.");
  }

  if (appConfig.discord.allowedGuildIds.length === 0) {
    throw new Error("DISCORD_ALLOWED_GUILD_IDS is required to start the Discord runtime.");
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds]
  });

  client.once(Events.ClientReady, (readyClient) => {
    logger.info("discord_runtime_ready", { guildCount: readyClient.guilds.cache.size });
  });

  client.on(Events.Error, (error) => {
    logger.error("discord_client_error", { error });
  });

  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    if (!isAllowedGuildId(interaction.guildId, appConfig.discord.allowedGuildIds)) {
      try {
        await rejectInteraction(interaction);
      } catch (error) {
        logger.warn("discord_disallowed_interaction_rejected", { error });
      }
      return;
    }

    try {
      if (interaction.commandName === "ping") {
        await interaction.reply({
          content: "KAD-Agent foundation is online. Seeded Language Club publish is ready.",
          ephemeral: true,
          allowedMentions: { parse: [] }
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
          publishAnnouncement: async ({ channelId, content, allowedUserIds }) => {
            const channel = await client.channels.fetch(channelId);

            if (!channel || channel.type === ChannelType.DM || !("send" in channel)) {
              throw new Error("Configured announcement channel is not a sendable in-server Discord channel.");
            }

            const message = await channel.send({
              content,
              allowedMentions: buildAllowedMentions(content, allowedUserIds)
            });

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
    } catch (error) {
      logger.error("discord_interaction_failed", {
        commandName: interaction.commandName,
        guildId: interaction.guildId,
        error
      });
      await replyGenericInteractionError(interaction, logger);
    }
  });

  await client.login(appConfig.discord.botToken);

  return {
    publishReminder: async ({ channelId, content }) => {
      const channel = await client.channels.fetch(channelId);

      if (!channel || channel.type === ChannelType.DM || !("send" in channel)) {
        throw new Error("Configured reminder channel is not a sendable in-server Discord channel.");
      }

      const message = await channel.send({ content, allowedMentions: buildAllowedMentions(content) });

      return { messageId: message.id };
    },
    destroy: () => destroyDiscordClient(client)
  };
}

export async function destroyDiscordClient(client: { destroy: () => void | Promise<void> }): Promise<void> {
  await client.destroy();
}

export function buildAllowedMentions(content: string, trustedUserIds: readonly string[] = []): { parse: []; users?: string[] } {
  const mentionedUsers = new Set([...content.matchAll(/<@!?(\d{5,20})>/g)].map((match) => match[1]));
  const users = [...new Set(trustedUserIds)].filter((userId) => mentionedUsers.has(userId));
  return users.length > 0 ? { parse: [], users } : { parse: [] };
}

export function isInteractionGuildAllowed(guildId: string | null, allowedGuildIds: readonly string[]): boolean {
  return isAllowedGuildId(guildId, allowedGuildIds);
}

async function rejectInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
  await replyEphemeral(interaction, "Perintah ini tidak tersedia di server yang belum diizinkan.");
}

async function replyGenericInteractionError(
  interaction: ChatInputCommandInteraction,
  logger: OperationalLogger
): Promise<void> {
  try {
    await replyEphemeral(interaction, "Terjadi kesalahan saat memproses perintah. Coba lagi nanti.");
  } catch (replyError) {
    logger.warn("discord_interaction_error_reply_failed", { error: replyError });
  }
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
    publishAnnouncement: (input: {
      channelId: string;
      content: string;
      allowedUserIds: string[];
    }) => Promise<{ messageId: string }>;
  }
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  const hostVoiceChannel = interaction.options.getChannel("host_voice_channel", false, [
    ChannelType.GuildVoice,
    ChannelType.GuildStageVoice
  ]);

  if (hostVoiceChannel && hostVoiceChannel.guildId !== interaction.guildId) {
    await editReplyWithoutMentions(
      interaction,
      "Host voice channel override harus berupa voice/stage channel di guild ini."
    );
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
    await editReplyWithoutMentions(interaction, `Permintaan ditolak: ${result.reason}`);
    return;
  }

  if (result.status === "publish_failed") {
    await editReplyWithoutMentions(
      interaction,
      result.discordScheduledEventId === null
        ? `Event tersimpan dengan ID ${result.eventId}, tetapi publish gagal sebelum announcement terkirim: ${result.reason}`
        : `Event tersimpan dengan ID ${result.eventId} dan Discord Scheduled Event ${result.discordScheduledEventId}, tetapi announcement gagal: ${result.reason}`
    );
    return;
  }

  await editReplyWithoutMentions(
    interaction,
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
    if (!isExpectedOperatorInputError(error)) {
      throw error;
    }
    await replyEphemeral(interaction, `Setup Event Slice E1 ditolak: ${toSafeOperationalErrorMessage(error)}`);
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
    if (!isExpectedOperatorInputError(error)) {
      throw error;
    }
    await replyEphemeral(interaction, `Language Club registry ditolak: ${toSafeOperationalErrorMessage(error)}`);
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

async function replyEphemeral(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp({ content, ephemeral: true, allowedMentions: { parse: [] } });
    return;
  }

  await interaction.reply({ content, ephemeral: true, allowedMentions: { parse: [] } });
}

async function editReplyWithoutMentions(
  interaction: ChatInputCommandInteraction,
  content: string
): Promise<void> {
  await interaction.editReply({ content, allowedMentions: { parse: [] } });
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

function isExpectedOperatorInputError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    /^(At least one staff role|A default timezone|Timezone must be|club_key must be|display_name is required|\w+ is required)/.test(
      error.message
    )
  );
}
