import { ChannelType, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";

export const foundationCommands = [
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Check whether the Milestone 0 bot foundation is online.")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("event")
    .setDescription("Event operations commands for staff.")
    .setDMPermission(false)
    .addSubcommand((subcommand) =>
      subcommand
        .setName("create-language-club")
        .setDescription("Buat Language Club seeded, native Discord event, dan announcement dengan pilihan channel dan host.")
        .addStringOption((option) =>
          option.setName("date").setDescription("Tanggal event dengan format YYYY-MM-DD.").setRequired(true)
        )
        .addStringOption((option) =>
          option.setName("time").setDescription("Jam event dengan format HH:mm.").setRequired(true)
        )
        .addChannelOption((option) =>
          option
            .setName("host_voice_channel")
            .setDescription("Override voice/stage channel host untuk event ini.")
            .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
            .setRequired(false)
        )
        .addUserOption((option) =>
          option.setName("host_1").setDescription("Host pertama untuk snapshot event ini.").setRequired(false)
        )
        .addUserOption((option) =>
          option.setName("host_2").setDescription("Host kedua untuk snapshot event ini.").setRequired(false)
        )
        .addUserOption((option) =>
          option.setName("host_3").setDescription("Host ketiga untuk snapshot event ini.").setRequired(false)
        )
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Guild setup commands for Event Slice E1.")
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((subcommand) =>
      subcommand
        .setName("e1-configure")
        .setDescription("Simpan konfigurasi guild untuk Event Slice E1 di SQLite.")
        .addChannelOption((option) =>
          option
            .setName("announcement_channel")
            .setDescription("Text/announcement channel untuk publish event Language Club.")
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true)
        )
        .addChannelOption((option) =>
          option
            .setName("host_voice_channel")
            .setDescription("Voice/stage channel host untuk event Language Club.")
            .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
            .setRequired(true)
        )
        .addStringOption((option) =>
          option
            .setName("timezone")
            .setDescription("Timezone IANA default, misalnya Asia/Jakarta.")
            .setRequired(true)
        )
        .addRoleOption((option) =>
          option.setName("staff_role_1").setDescription("Role staff yang diizinkan membuat Language Club.").setRequired(true)
        )
        .addRoleOption((option) => option.setName("staff_role_2").setDescription("Role staff tambahan.").setRequired(false))
        .addRoleOption((option) => option.setName("staff_role_3").setDescription("Role staff tambahan.").setRequired(false))
        .addRoleOption((option) => option.setName("staff_role_4").setDescription("Role staff tambahan.").setRequired(false))
        .addRoleOption((option) => option.setName("staff_role_5").setDescription("Role staff tambahan.").setRequired(false))
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("e1-show").setDescription("Tampilkan konfigurasi guild Event Slice E1 dari SQLite.")
    )
    .toJSON()
];
