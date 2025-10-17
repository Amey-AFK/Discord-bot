// index.js

const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  AuditLogEvent,
  PermissionFlagsBits
} = require("discord.js");
const cron = require("node-cron");

const TOKEN = process.env.TOKEN;
const PREFIX = "!";

if (!TOKEN) {
  console.error("❌ BOT TOKEN not found in environment variables.");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

process.on("unhandledRejection", (err) =>
  console.error("Unhandled Rejection:", err)
);
client.on("error", (err) => console.error("Client Error:", err));

// ====== CONFIG STORAGE ======
const guildConfig = new Map(); // guildId -> { activityLogChannelId, messageLogChannelId, modRoleIds, stats }

// ====== HELPERS ======
function isMod(member, config) {
  if (!config?.modRoleIds?.length) return false;
  return config.modRoleIds.some((r) => member.roles.cache.has(r));
}

function getChannel(guild, id) {
  return guild.channels.cache.get(id) || null;
}

function formatDuration(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}h ${m}m ${s}s`;
}

// ====== ACTIVITY SYSTEM ======
const activeMods = new Map(); // guildId -> Map(userId -> { since })

async function markModIn(member, config) {
  if (!activeMods.has(member.guild.id)) activeMods.set(member.guild.id, new Map());
  const mods = activeMods.get(member.guild.id);
  if (!mods.has(member.id)) {
    mods.set(member.id, { since: Date.now() });
    const ch = getChannel(member.guild, config.activityLogChannelId);
    if (ch) ch.send(`🟢 <@${member.id}> is now **ON DUTY**.`);
  }
}

async function markModOut(member, config, auto = false) {
  const mods = activeMods.get(member.guild.id);
  if (!mods || !mods.has(member.id)) return;
  const data = mods.get(member.id);
  mods.delete(member.id);

  config.stats = config.stats || {};
  if (!config.stats[member.id]) config.stats[member.id] = { daily: 0, weekly: 0, monthly: 0 };
  const session = Date.now() - data.since;
  config.stats[member.id].daily += session;
  config.stats[member.id].weekly += session;
  config.stats[member.id].monthly += session;

  const ch = getChannel(member.guild, config.activityLogChannelId);
  if (ch)
    ch.send(`🔴 <@${member.id}> is now **OFF DUTY**${auto ? " (timed out)" : ""}.`);
}

// ====== REMINDER SYSTEM ======
let remindersEnabled = true;
let reminderInterval = 30 * 60 * 1000; // 30 min default

function startReminders() {
  setInterval(async () => {
    if (!remindersEnabled) return;

    for (const [guildId, mods] of activeMods.entries()) {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) continue;
      const config = guildConfig.get(guildId);
      const ch = getChannel(guild, config?.activityLogChannelId);
      if (!ch) continue;

      for (const [modId, info] of mods.entries()) {
        const mod = await guild.members.fetch(modId).catch(() => null);
        if (!mod) continue;

        const reminderMsg = await ch.send(
          `🔔 Hey <@${modId}>, are you still active? React with ✅ within 2 minutes to stay active.`
        );
        await reminderMsg.react("✅");

        const collector = reminderMsg.createReactionCollector({
          filter: (r, u) => r.emoji.name === "✅" && u.id === modId,
          time: 120000
        });

        collector.on("collect", () => {
          reminderMsg.reply(`✅ <@${modId}> confirmed active.`);
          collector.stop("confirmed");
        });

        collector.on("end", async (collected, reason) => {
          if (reason !== "confirmed") {
            await markModOut(mod, config, true);
          }
        });
      }
    }
  }, reminderInterval);
}

// ====== DAILY REPORT ======
function scheduleDailyReports() {
  cron.schedule("0 0 * * *", async () => {
    for (const [guildId, config] of guildConfig.entries()) {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) continue;
      const ch = getChannel(guild, config.activityLogChannelId);
      if (!ch || !config.stats) continue;

      let msg = `📊 **Daily Mod Stats for ${new Date().toLocaleDateString()}**\n`;
      for (const [uid, rec] of Object.entries(config.stats)) {
        msg += `• <@${uid}> — ${formatDuration(rec.daily)}\n`;
        rec.daily = 0;
      }
      await ch.send(msg);
    }
  });
}

// ====== MESSAGE DELETE LOGGER ======
client.on("messageDelete", async (message) => {
  if (!message.guild || !message.author) return;
  if (message.author.bot) return;

  const config = guildConfig.get(message.guild.id);
  if (!config?.messageLogChannelId) return;
  const logCh = getChannel(message.guild, config.messageLogChannelId);
  if (!logCh) return;

  try {
    const logs = await message.guild.fetchAuditLogs({
      type: AuditLogEvent.MessageDelete,
      limit: 1
    });
    const entry = logs.entries.first();
    if (!entry) return;

    const { executor, target } = entry;
    if (!executor || executor.bot) return;
    if (target.id !== message.author.id) return; // ensure correct target
    if (!isMod(await message.guild.members.fetch(executor.id), config)) return;

    const embed = new EmbedBuilder()
      .setTitle("🗑️ Message Deleted by Moderator")
      .addFields(
        { name: "Moderator", value: `${executor.tag} (<@${executor.id}>)`, inline: true },
        { name: "Original Author", value: `${message.author.tag} (<@${message.author.id}>)`, inline: true },
        { name: "Channel", value: `<#${message.channelId}>`, inline: true },
        { name: "Content", value: message.content || "_(No content)_" }
      )
      .setColor("Red")
      .setTimestamp();

    await logCh.send({ embeds: [embed] });
  } catch (err) {
    console.error("Error logging deleted message:", err);
  }
});

// ====== COMMANDS ======
client.on("messageCreate", async (msg) => {
  if (!msg.guild || msg.author.bot) return;
  if (!msg.content.startsWith(PREFIX)) return;

  const args = msg.content.slice(PREFIX.length).trim().split(/\s+/);
  const cmd = args.shift()?.toLowerCase();
  const config = guildConfig.get(msg.guild.id) || {};

  switch (cmd) {
    case "set-activity-log": {
      if (!msg.member.permissions.has(PermissionFlagsBits.ManageGuild))
        return msg.reply("You need **Manage Server** permission.");
      const ch = msg.mentions.channels.first();
      if (!ch) return msg.reply("Please mention a channel.");
      config.activityLogChannelId = ch.id;
      guildConfig.set(msg.guild.id, config);
      return msg.reply(`✅ Activity log channel set to ${ch}`);
    }

    case "set-message-log": {
      if (!msg.member.permissions.has(PermissionFlagsBits.ManageGuild))
        return msg.reply("You need **Manage Server** permission.");
      const ch = msg.mentions.channels.first();
      if (!ch) return msg.reply("Please mention a channel.");
      config.messageLogChannelId = ch.id;
      guildConfig.set(msg.guild.id, config);
      return msg.reply(`✅ Message log channel set to ${ch}`);
    }

    case "set-mod-roles": {
      if (!msg.member.permissions.has(PermissionFlagsBits.ManageGuild))
        return msg.reply("You need **Manage Server** permission.");
      const roles = msg.mentions.roles.map((r) => r.id);
      if (!roles.length) return msg.reply("Mention one or more mod roles.");
      config.modRoleIds = roles;
      guildConfig.set(msg.guild.id, config);
      return msg.reply(`✅ Moderator roles set.`);
    }

    case "in": {
      if (!isMod(msg.member, config)) return msg.reply("❌ You are not a moderator.");
      guildConfig.set(msg.guild.id, config);
      await markModIn(msg.member, config);
      return msg.reply("You are now **ON DUTY**.");
    }

    case "out": {
      if (!isMod(msg.member, config)) return msg.reply("❌ You are not a moderator.");
      await markModOut(msg.member, config);
      return msg.reply("You are now **OFF DUTY**.");
    }

    case "daily":
    case "weekly":
    case "monthly": {
      if (!config.stats) return msg.reply("No stats yet.");
      const type = cmd;
      let reply = `📆 **${type.charAt(0).toUpperCase() + type.slice(1)} Stats**\n`;
      for (const [uid, rec] of Object.entries(config.stats)) {
        const time = rec[type] || 0;
        reply += `• <@${uid}> — ${formatDuration(time)}\n`;
      }
      return msg.reply(reply);
    }

    case "help": {
      return msg.reply(
        `**🛠️ ModLogger Commands**\n\n` +
          `**Activity:** !in, !out, !daily, !weekly, !monthly\n` +
          `**Setup:** !set-activity-log #ch, !set-message-log #ch, !set-mod-roles @role\n` +
          `**Other:** !help`
      );
    }
  }
});

// ====== READY ======
client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  scheduleDailyReports();
  startReminders();
});
const http = require('http');
const PORT = process.env.PORT || 3000; // Render automatically provides PORT

// Create a tiny web server
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('✅ Bot is running!\n');
}).listen(PORT, () => {
  console.log(`HTTP server listening on port ${PORT}`);
});


client.login(TOKEN);

