const { Client, GatewayIntentBits, Partials } = require('discord.js');
const TOKEN = process.env.TOKEN; // stored in Render environment variable
const PREFIX = '!';
const cron = require('node-cron'); // for daily midnight task

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

let settings = {
  activityLogChannel: null,
  vcLogChannel: null,
  messageLogChannel: null,
  modRoles: [],
  reminderEnabled: true,
  reminderInterval: 30,
  timeoutDuration: 10
};

// In-memory cache for current session (won’t persist after restart)
let modStats = {}; // { guildId: { userId: { daily: n, weekly: n, monthly: n } } }

function isModerator(member) {
  return settings.modRoles.some(r => member.roles.cache.has(r));
}

function updateStats(guildId, userId) {
  if (!modStats[guildId]) modStats[guildId] = {};
  if (!modStats[guildId][userId]) modStats[guildId][userId] = { daily: 0, weekly: 0, monthly: 0 };
  modStats[guildId][userId].daily++;
  modStats[guildId][userId].weekly++;
  modStats[guildId][userId].monthly++;
}

function resetDailyStats() {
  for (const g in modStats) {
    for (const u in modStats[g]) modStats[g][u].daily = 0;
  }
}

function resetWeeklyStats() {
  for (const g in modStats) {
    for (const u in modStats[g]) modStats[g][u].weekly = 0;
  }
}

function resetMonthlyStats() {
  for (const g in modStats) {
    for (const u in modStats[g]) modStats[g][u].monthly = 0;
  }
}

client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  // 🕛 Schedule a job to post daily stats at midnight (server time)
  cron.schedule('0 0 * * *', async () => {
    for (const [guildId, data] of Object.entries(modStats)) {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) continue;
      const logChannel = guild.channels.cache.get(settings.activityLogChannel);
      if (!logChannel) continue;

      let dailyReport = `📊 **Daily Moderator Activity Report** (as of ${new Date().toLocaleDateString()})\n`;
      const guildData = modStats[guildId];
      const members = await guild.members.fetch();

      for (const [userId, stats] of Object.entries(guildData)) {
        const user = members.get(userId);
        if (user) dailyReport += `👤 ${user.user.tag} — ${stats.daily} activity points\n`;
      }

      await logChannel.send(dailyReport || "No activity recorded today.");
    }

    resetDailyStats();
  });
});

// 🧾 Commands
client.on('messageCreate', async message => {
  if (!message.content.startsWith(PREFIX) || message.author.bot) return;
  const [cmd, ...args] = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const member = message.member;
  const guildId = message.guild.id;

  // ===== SETUP COMMANDS =====
  if (cmd === 'set-activity-log') {
    const ch = message.mentions.channels.first();
    if (!ch) return message.reply('Mention a valid channel.');
    settings.activityLogChannel = ch.id;
    return message.reply(`✅ Activity log set to ${ch}`);
  }

  if (cmd === 'set-vc-log') {
    const ch = message.mentions.channels.first();
    if (!ch) return message.reply('Mention a valid channel.');
    settings.vcLogChannel = ch.id;
    return message.reply(`✅ VC log set to ${ch}`);
  }

  if (cmd === 'set-message-log') {
    const ch = message.mentions.channels.first();
    if (!ch) return message.reply('Mention a valid channel.');
    settings.messageLogChannel = ch.id;
    return message.reply(`✅ Message log set to ${ch}`);
  }

  if (cmd === 'set-mod-roles') {
    const roles = message.mentions.roles.map(r => r.id);
    if (!roles.length) return message.reply('Mention at least one mod role.');
    settings.modRoles = roles;
    return message.reply('✅ Mod roles set.');
  }

  // ===== MOD ACTIVITY =====
  if (cmd === 'in') {
    if (!isModerator(member)) return message.reply('You are not a moderator.');
    const ch = message.guild.channels.cache.get(settings.activityLogChannel);
    if (!ch) return message.reply('Activity log not set.');
    updateStats(guildId, member.id);
    await ch.send(`🟢 ${member.user.tag} is now **active**.`);
  }

  if (cmd === 'out') {
    if (!isModerator(member)) return message.reply('You are not a moderator.');
    const ch = message.guild.channels.cache.get(settings.activityLogChannel);
    if (!ch) return message.reply('Activity log not set.');
    await ch.send(`🔴 ${member.user.tag} is now **inactive**.`);
  }

  if (cmd === 'daily') {
    const guildData = modStats[guildId] || {};
    if (!Object.keys(guildData).length) return message.reply('No data for today.');
    let msg = `📅 **Daily Stats (${new Date().toLocaleDateString()})**\n`;
    for (const [id, st] of Object.entries(guildData)) {
      const user = await message.guild.members.fetch(id).catch(() => null);
      if (user) msg += `👤 ${user.user.tag} — ${st.daily} activity\n`;
    }
    message.channel.send(msg);
  }

  if (cmd === 'weekly') {
    const guildData = modStats[guildId] || {};
    if (!Object.keys(guildData).length) return message.reply('No weekly data.');
    let msg = `📊 **Weekly Stats (Last 7 Days)**\n`;
    for (const [id, st] of Object.entries(guildData)) {
      const user = await message.guild.members.fetch(id).catch(() => null);
      if (user) msg += `👤 ${user.user.tag} — ${st.weekly} activity\n`;
    }
    message.channel.send(msg);
  }

  if (cmd === 'monthly') {
    const guildData = modStats[guildId] || {};
    if (!Object.keys(guildData).length) return message.reply('No monthly data.');
    let msg = `📆 **Monthly Stats (Last 30 Days)**\n`;
    for (const [id, st] of Object.entries(guildData)) {
      const user = await message.guild.members.fetch(id).catch(() => null);
      if (user) msg += `👤 ${user.user.tag} — ${st.monthly} activity\n`;
    }
    message.channel.send(msg);
  }

  if (cmd === 'help') {
    return message.reply(`**📘 ModLogger Help**
__Mod Tracking__
!in — Mark yourself active
!out — Mark yourself inactive
!daily / !weekly / !monthly — View mod stats
!set-activity-log #channel — Set log channel

__VC Logs__
!set-vc-log #channel — Set VC log channel
!set-mod-roles @role — Define mod roles

__Message Logs__
!set-message-log #channel — Set message log channel`);
  }
});

// Deleted Message Logger
client.on('messageDelete', async msg => {
  if (!msg.guild || msg.author?.bot) return;
  const ch = msg.guild.channels.cache.get(settings.messageLogChannel);
  if (!ch) return;
  const logs = await msg.guild.fetchAuditLogs({ type: 72, limit: 1 });
  const entry = logs.entries.first();
  if (!entry) return;
  const { executor } = entry;
  const mod = await msg.guild.members.fetch(executor.id).catch(() => null);
  if (mod && isModerator(mod)) {
    ch.send(`🗑️ **Message Deleted**
**By:** ${executor.tag}
**Author:** ${msg.author?.tag || 'Unknown'}
**Channel:** ${msg.channel}
**Content:** ${msg.content || 'No text'}`);
  }
});

// VC Move Logger
client.on('voiceStateUpdate', async (oldS, newS) => {
  if (!oldS.channelId || !newS.channelId || oldS.channelId === newS.channelId) return;
  const ch = newS.guild.channels.cache.get(settings.vcLogChannel);
  if (!ch) return;
  const logs = await newS.guild.fetchAuditLogs({ type: 26, limit: 1 });
  const entry = logs.entries.first();
  if (!entry) return;
  const { executor, target } = entry;
  const mod = await newS.guild.members.fetch(executor.id).catch(() => null);
  if (mod && isModerator(mod)) {
    ch.send(`🎧 **VC Move**
**Moderator:** ${mod.user.tag}
**User:** ${target.tag}
**From:** ${oldS.channel?.name}
**To:** ${newS.channel?.name}`);
  }
});

client.login(TOKEN);



