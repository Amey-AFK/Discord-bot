const { Client, GatewayIntentBits, Partials, AuditLogEvent, EmbedBuilder } = require('discord.js');
const fs = require('fs-extra');
const path = require('path');

// Load token from environment variable (Render)
const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error('Error: DISCORD_TOKEN not set as environment variable');
  process.exit(1);
}

const CONFIG_PATH = path.join(__dirname, 'guildConfigs.json');

// Load or init config
let guildConfigs = {};
if (fs.existsSync(CONFIG_PATH)) {
  try {
    guildConfigs = fs.readJSONSync(CONFIG_PATH);
  } catch (e) {
    console.error('Failed to read guildConfigs.json:', e);
    guildConfigs = {};
  }
} else {
  fs.writeJSONSync(CONFIG_PATH, {});
}

function saveConfigs() {
  fs.writeJSONSync(CONFIG_PATH, guildConfigs, { spaces: 2 });
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember]
});

// Helper functions
function ensureGuildConfig(guildId) {
  if (!guildConfigs[guildId]) {
    guildConfigs[guildId] = {
      modRoleIds: [],
      messageLogChannelId: null,
      vcLogChannelId: null
    };
  }
  return guildConfigs[guildId];
}

function isMemberMod(member, guildId) {
  if (!member || !member.roles) return false;
  const cfg = ensureGuildConfig(guildId);
  if (!cfg.modRoleIds || cfg.modRoleIds.length === 0) return false;
  return member.roles.cache.some(r => cfg.modRoleIds.includes(r.id));
}

// Command handling
const PREFIX = '!';
client.on('messageCreate', async (message) => {
  if (!message.guild || message.author.bot) return;
  if (!message.content.startsWith(PREFIX)) return;

  const [cmd, ...args] = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const guildId = message.guild.id;
  const cfg = ensureGuildConfig(guildId);

  if (!message.member.permissions.has('ManageGuild') && !message.member.permissions.has('Administrator') && message.guild.ownerId !== message.author.id) {
    return message.reply('You must be a server administrator to use configuration commands.');
  }

  if (cmd === 'set-message-log') {
    const ch = message.mentions.channels.first();
    if (!ch) return message.reply('Please mention a channel. Example: `!set-message-log #mod-logs`');
    cfg.messageLogChannelId = ch.id;
    saveConfigs();
    return message.reply(`Message-delete log channel set to ${ch}.`);
  }

  if (cmd === 'set-vc-log') {
    const ch = message.mentions.channels.first();
    if (!ch) return message.reply('Please mention a channel. Example: `!set-vc-log #vc-logs`');
    cfg.vcLogChannelId = ch.id;
    saveConfigs();
    return message.reply(`VC-drag log channel set to ${ch}.`);
  }

  if (cmd === 'set-mod-roles') {
    const roles = message.mentions.roles.map(r => r.id);
    if (roles.length === 0) return message.reply('Please mention at least one role: `!set-mod-roles @ModRole`');
    cfg.modRoleIds = roles;
    saveConfigs();
    const names = message.mentions.roles.map(r => r.toString()).join(', ');
    return message.reply(`Mod roles set to: ${names}`);
  }

  if (cmd === 'show-config') {
    const modRoles = cfg.modRoleIds.map(id => {
      const role = message.guild.roles.cache.get(id);
      return role ? role.name : id;
    }).join(', ') || 'None';
    const msgCh = cfg.messageLogChannelId ? `<#${cfg.messageLogChannelId}>` : 'Not set';
    const vcCh = cfg.vcLogChannelId ? `<#${cfg.vcLogChannelId}>` : 'Not set';
    return message.reply(`Config:\nMod roles: ${modRoles}\nMessage log: ${msgCh}\nVC log: ${vcCh}`);
  }
});

// Audit log helper
async function findAuditEntry(guild, type, targetId, channelId) {
  try {
    const fetched = await guild.fetchAuditLogs({ limit: 6, type });
    const entries = fetched.entries;
    const now = Date.now();
    for (const [id, entry] of entries) {
      if (!entry) continue;
      const entryTarget = entry.target?.id ?? (entry.target ?? null);
      const matchesTarget = targetId ? entryTarget === targetId : true;
      const entryChannelId = entry.extra?.channel?.id ?? null;
      const matchesChannel = !channelId || (entryChannelId === channelId);
      const age = Math.abs(now - entry.createdTimestamp);
      if ((matchesTarget && matchesChannel) && age < 10_000) {
        return { executor: entry.executor, entry };
      }
    }
    return null;
  } catch (err) {
    console.error('Failed to fetch audit logs:', err);
    return null;
  }
}

async function logToChannel(client, guildId, channelId, embed) {
  if (!channelId) return;
  try {
    const guild = await client.guilds.fetch(guildId);
    const ch = await guild.channels.fetch(channelId);
    if (!ch || !ch.isTextBased()) return;
    await ch.send({ embeds: [embed] });
  } catch (e) {
    console.error('logToChannel error:', e);
  }
}

// Message delete events
client.on('messageDelete', async (message) => {
  if (!message.guild) return;
  const guildId = message.guild.id;
  const cfg = ensureGuildConfig(guildId);
  if (!cfg.messageLogChannelId || cfg.modRoleIds.length === 0) return;

  const authorId = message.author?.id ?? null;
  if (!authorId) return;

  const audit = await findAuditEntry(message.guild, AuditLogEvent.MessageDelete, authorId, message.channelId);
  if (!audit) return;
  const moderator = audit.executor;
  if (!moderator) return;

  const modMember = await message.guild.members.fetch(moderator.id).catch(()=>null);
  if (!modMember) return;
  if (!isMemberMod(modMember, guildId)) return;

  const embed = new EmbedBuilder()
    .setTitle('Message deleted by moderator')
    .addFields(
      { name: 'Moderator', value: `${moderator.tag} (${moderator.id})`, inline: true },
      { name: 'Author', value: `${message.author?.tag ?? 'Unknown'} (${authorId})`, inline: true },
      { name: 'Channel', value: `<#${message.channelId}>`, inline: true },
      { name: 'Message cached?', value: message.partial ? 'No' : 'Yes', inline: true }
    )
    .setTimestamp(new Date())
    .setFooter({ text: `Guild: ${message.guild.name}` });

  if (message.content) {
    let content = message.content;
    if (content.length > 1024) content = content.slice(0, 1000) + '...';
    embed.addFields({ name: 'Content', value: content });
  } else if (message.embeds && message.embeds.length > 0) {
    embed.addFields({ name: 'Content', value: `Embed(s) present (can't show embed content)` });
  } else {
    embed.addFields({ name: 'Content', value: 'Not cached' });
  }

  await logToChannel(client, guildId, cfg.messageLogChannelId, embed);
});

// Bulk delete
client.on('messageDeleteBulk', async (messages) => {
  const any = messages.first();
  if (!any || !any.guild) return;
  const guild = any.guild;
  const guildId = guild.id;
  const cfg = ensureGuildConfig(guildId);
  if (!cfg.messageLogChannelId || cfg.modRoleIds.length === 0) return;

  const channelId = any.channelId;
  const audit = await findAuditEntry(guild, AuditLogEvent.MessageBulkDelete, null, channelId);
  if (!audit) return;
  const moderator = audit.executor;
  if (!moderator) return;

  const modMember = await guild.members.fetch(moderator.id).catch(()=>null);
  if (!modMember) return;
  if (!isMemberMod(modMember, guildId)) return;

  const embed = new EmbedBuilder()
    .setTitle('Bulk message delete by moderator')
    .addFields(
      { name: 'Moderator', value: `${moderator.tag} (${moderator.id})`, inline: true },
      { name: 'Channel', value: `<#${channelId}>`, inline: true },
      { name: 'Messages deleted (count)', value: `${messages.size}`, inline: true }
    )
    .setTimestamp(new Date())
    .setFooter({ text: `Guild: ${guild.name}` });

  const sample = [];
  let i = 0;
  for (const msg of messages.values()) {
    if (i >= 5) break;
    const author = msg.author ? `${msg.author.tag}` : 'Unknown';
    const content = msg.content ? (msg.content.length > 180 ? msg.content.slice(0, 177) + '...' : msg.content) : '[no content cached]';
    sample.push(`- ${author}: ${content}`);
    i++;
  }
  if (sample.length > 0) embed.addFields({ name: 'Sample (up to 5 cached)', value: sample.join('\n') });

  await logToChannel(client, guildId, cfg.messageLogChannelId, embed);
});

// VC drag
client.on('voiceStateUpdate', async (oldState, newState) => {
  const guild = oldState.guild ?? newState.guild;
  if (!guild) return;
  const guildId = guild.id;
  const cfg = ensureGuildConfig(guildId);
  if (!cfg.vcLogChannelId || cfg.modRoleIds.length === 0) return;

  const oldChan = oldState.channel;
  const newChan = newState.channel;
  const member = newState.member ?? oldState.member;
  if (!member || oldChan?.id === newChan?.id) return;

  try {
    const audit = await findAuditEntry(guild, AuditLogEvent.MemberMove, member.id, null);
    if (!audit) return;
    const moderator = audit.executor;
    if (!moderator) return;

    const modMember = await guild.members.fetch(moderator.id).catch(()=>null);
    if (!modMember) return;
    if (!isMemberMod(modMember, guildId)) return;

    const embed = new EmbedBuilder()
      .setTitle('Member moved by moderator (VC drag)')
      .addFields(
        { name: 'Moderator', value: `${moderator.tag} (${moderator.id})`, inline: true },
        { name: 'Member', value: `${member.user.tag} (${member.id})`, inline: true },
        { name: 'From', value: oldChan ? `${oldChan.name} (${oldChan.id})` : '—', inline: true },
        { name: 'To', value: newChan ? `${newChan.name} (${newChan.id})` : '—', inline: true },
        { name: 'Time', value: new Date().toISOString() }
      )
      .setTimestamp(new Date())
      .setFooter({ text: `Guild: ${guild.name}` });

    await logToChannel(client, guildId, cfg.vcLogChannelId, embed);
  } catch (e) {
    console.error('voiceStateUpdate error:', e);
  }
});

client.once('ready', () => console.log(`Logged in as ${client.user.tag}`));
client.login(TOKEN);
