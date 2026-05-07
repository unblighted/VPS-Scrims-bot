const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionsBitField,
  ChannelType,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  REST,
  Routes,
} = require("discord.js");

require("dotenv").config({ path: "./env" });

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

// ─── Rank Config ──────────────────────────────────────────────────────────────

const RANK_ORDER = [
  "Iron", "Bronze", "Silver", "Gold", "Platinum",
  "Diamond", "Ascendant", "Immortal", "Radiant",
];

const DEFAULT_RANGE = { min: "Iron", max: "Radiant" };

// ─── Queue Size ───────────────────────────────────────────────────────────────
// Change to 2 or 3 for testing, set back to 10 for production
const QUEUE_SIZE = 10;
const TEAM_SIZE = Math.floor(QUEUE_SIZE / 2);

// ─── State ────────────────────────────────────────────────────────────────────

const state = { guilds: {} };

const pendingInvites = new Map();
const INVITE_TIMEOUT_MS = 60 * 1000;

function getGuildState(guildId) {
  if (!state.guilds[guildId]) {
    state.guilds[guildId] = {
      channelId: null,
      interval: null,
      activeQueue: null,
      rankRange: { ...DEFAULT_RANGE },
    };
  }
  return state.guilds[guildId];
}

// ─── Rank Helpers ─────────────────────────────────────────────────────────────

function getMemberRank(member) {
  for (let i = RANK_ORDER.length - 1; i >= 0; i--) {
    if (member.roles.cache.some((r) => r.name === RANK_ORDER[i])) {
      return RANK_ORDER[i];
    }
  }
  return null;
}

function getRankIndex(rank) {
  return RANK_ORDER.indexOf(rank);
}

function memberMeetsRankRequirement(member, rankRange) {
  const rank = getMemberRank(member);
  if (!rank) return false;
  const minIndex = getRankIndex(rankRange.min);
  const maxIndex = getRankIndex(rankRange.max);
  const rankIndex = getRankIndex(rank);
  return rankIndex >= minIndex && rankIndex <= maxIndex;
}

// ─── Party Helpers ────────────────────────────────────────────────────────────

function removeFromParty(userId, parties, partyOf) {
  const leader = partyOf.get(userId);
  if (leader) {
    const members = parties.get(leader) || [];
    parties.set(leader, members.filter((m) => m !== userId));
    partyOf.delete(userId);
    return;
  }
  if (parties.has(userId)) {
    const members = parties.get(userId) || [];
    members.forEach((m) => partyOf.delete(m));
    parties.delete(userId);
  }
}

const globalParties = new Map();

function getGuildParties(guildId) {
  if (!globalParties.has(guildId)) {
    globalParties.set(guildId, { parties: new Map(), partyOf: new Map() });
  }
  return globalParties.get(guildId);
}

// ─── Slash Commands ───────────────────────────────────────────────────────────

const RANK_CHOICES = RANK_ORDER.map((r) => ({ name: r, value: r }));

const commands = [
  new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Set this channel as the 10-man queue channel")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

  new SlashCommandBuilder()
    .setName("startqueue")
    .setDescription("Manually trigger a queue alert now")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

  new SlashCommandBuilder()
    .setName("stopqueue")
    .setDescription("Stop the automatic queue timer")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

  new SlashCommandBuilder()
    .setName("setrange")
    .setDescription("Set the rank range allowed to join the queue")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
    .addStringOption((opt) =>
      opt.setName("min").setDescription("Minimum rank allowed").setRequired(true).addChoices(...RANK_CHOICES)
    )
    .addStringOption((opt) =>
      opt.setName("max").setDescription("Maximum rank allowed").setRequired(true).addChoices(...RANK_CHOICES)
    ),

  new SlashCommandBuilder()
    .setName("party")
    .setDescription("Send a party invite to a friend via DM")
    .addUserOption((opt) =>
      opt.setName("teammate").setDescription("The friend to invite").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("leaveparty")
    .setDescription("Leave or disband your current party"),

  new SlashCommandBuilder()
    .setName("partystatus")
    .setDescription("Show who you're currently partied with"),

  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Show current queue status"),

  new SlashCommandBuilder()
    .setName("cancelqueue")
    .setDescription("Cancel the active queue")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

  new SlashCommandBuilder()
    .setName("setuproles")
    .setDescription("Post the rank selection embed in this channel")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

  new SlashCommandBuilder()
    .setName("lobby")
    .setDescription("Claim lobby leader or share the lobby code")
    .addStringOption((opt) =>
      opt
        .setName("code")
        .setDescription("The custom lobby code to share with your team (optional)")
        .setRequired(false)
    ),
].map((cmd) => cmd.toJSON());

// ─── Register Commands ────────────────────────────────────────────────────────

async function registerCommands(guildId) {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, guildId), {
      body: commands,
    });
    console.log(`[Commands] Registered for guild ${guildId}`);
  } catch (err) {
    console.error("[Commands] Registration failed:", err);
  }
}

// ─── Queue Logic ──────────────────────────────────────────────────────────────

async function postQueueAlert(guild, channelId) {
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel) return;

  const gs = getGuildState(guild.id);
  if (gs.activeQueue) await cleanupLobby(guild, gs.activeQueue);

  const { min, max } = gs.rankRange;
  const rangeText = min === max ? min : `${min} → ${max}`;

  const embed = new EmbedBuilder()
    .setColor(0xff4655)
    .setTitle("🎯  VPS SCRIMS — 10-MAN QUEUE")
    .setDescription(
      "A new 10-man custom lobby is starting!\n\n" +
      "Press **Join Queue** to enter.\n" +
      "Use `/party @user` to invite a friend — they must accept before you both join.\n\n" +
      `**Rank Range:** ${rangeText}\n\n` +
      "**Players (0/10):**\n*No one yet...*"
    )
    .setFooter({ text: "Queue closes when 10 players join • Teams are balanced by rank" })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("join_queue")
      .setLabel("Join Queue")
      .setStyle(ButtonStyle.Danger)
      .setEmoji("⚔️"),
    new ButtonBuilder()
      .setCustomId("leave_queue")
      .setLabel("Leave Queue")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("🚪")
  );

  const msg = await channel.send({ embeds: [embed], components: [row] });

  gs.activeQueue = {
    messageId: msg.id,
    channelId,
    players: new Set(),
    playerRanks: new Map(),
    parties: new Map(),
    partyOf: new Map(),
    readyPlayers: new Set(),
    phase: "queue",
    teams: null,
    voiceChannels: { team1Id: null, team2Id: null },
    lobbyChannelId: null,
    categoryId: null,
    lobbyLeaderId: null,
  };

  console.log(`[Queue] Posted alert in ${guild.name}`);
}

async function updateQueueEmbed(guild, queue) {
  const channel = await guild.channels.fetch(queue.channelId).catch(() => null);
  if (!channel) return;
  const msg = await channel.messages.fetch(queue.messageId).catch(() => null);
  if (!msg) return;

  const gs = getGuildState(guild.id);
  const gp = getGuildParties(guild.id);
  const { min, max } = gs.rankRange;
  const rangeText = min === max ? min : `${min} → ${max}`;
  const playerCount = queue.players.size;

  const playerLines = await Promise.all(
    [...queue.players].map(async (uid) => {
      const member = await guild.members.fetch(uid).catch(() => null);
      const name = member ? member.displayName : "Unknown";
      const rank = queue.playerRanks.get(uid) || "Unranked";
      const isLeader = gp.parties.has(uid) && gp.parties.get(uid).length > 0;
      const inParty = gp.partyOf.has(uid);
      const tag = isLeader || inParty ? " 🤝" : "";
      return `• **${name}**${tag} — ${rank}`;
    })
  );

  const embed = new EmbedBuilder()
    .setColor(playerCount >= 10 ? 0x00ff88 : 0xff4655)
    .setTitle("🎯  VPS SCRIMS — 10-MAN QUEUE")
    .setDescription(
      "A new 10-man custom lobby is starting!\n\n" +
      "Press **Join Queue** to enter.\n" +
      "Use `/party @user` to invite a friend — they must accept before you both join.\n\n" +
      `**Rank Range:** ${rangeText}\n\n` +
      `**Players (${playerCount}/10):**\n` +
      (playerLines.length > 0 ? playerLines.join("\n") : "*No one yet...*")
    )
    .setFooter({ text: "Queue closes when 10 players join • Teams are balanced by rank" })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("join_queue")
      .setLabel("Join Queue")
      .setStyle(ButtonStyle.Danger)
      .setEmoji("⚔️")
      .setDisabled(playerCount >= QUEUE_SIZE),
    new ButtonBuilder()
      .setCustomId("leave_queue")
      .setLabel("Leave Queue")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("🚪")
  );

  await msg.edit({ embeds: [embed], components: [row] }).catch(() => {});
}

// ─── Team Split ───────────────────────────────────────────────────────────────

function splitTeamsByRank(players, playerRanks, parties, partyOf) {
  const assigned = new Set();
  const groups = [];

  for (const [leader, members] of parties) {
    if (!players.has(leader)) continue;
    const group = [leader, ...members.filter((m) => players.has(m))];
    if (!group.length) continue;
    const avgRank =
      group.reduce((sum, uid) => sum + getRankIndex(playerRanks.get(uid) || "Iron"), 0) /
      group.length;
    groups.push({ members: group, avgRank });
    group.forEach((p) => assigned.add(p));
  }

  for (const uid of players) {
    if (assigned.has(uid)) continue;
    groups.push({ members: [uid], avgRank: getRankIndex(playerRanks.get(uid) || "Iron") });
    assigned.add(uid);
  }

  groups.sort((a, b) => b.avgRank - a.avgRank);

  const team1 = [], team2 = [];
  let team1Sum = 0, team2Sum = 0;

  for (const group of groups) {
    if (team1.length < 5 && (team1Sum <= team2Sum || team2.length >= 5)) {
      team1.push(...group.members);
      team1Sum += group.avgRank * group.members.length;
    } else if (team2.length < 5) {
      team2.push(...group.members);
      team2Sum += group.avgRank * group.members.length;
    } else {
      team1.push(...group.members);
    }
  }

  return { team1: team1.slice(0, TEAM_SIZE), team2: team2.slice(0, TEAM_SIZE) };
}

// ─── Post Teams ───────────────────────────────────────────────────────────────

async function postTeams(guild, queue) {
  const channel = await guild.channels.fetch(queue.channelId).catch(() => null);
  if (!channel) return;

  const { team1, team2 } = queue.teams;

  const getLines = async (ids) =>
    Promise.all(
      ids.map(async (id) => {
        const m = await guild.members.fetch(id).catch(() => null);
        const name = m ? m.displayName : "Unknown";
        const rank = queue.playerRanks.get(id) || "Unranked";
        return `<@${id}> — ${rank}`;
      })
    );

  const avgRankLabel = (ids) => {
    const avg =
      ids.reduce((sum, id) => sum + getRankIndex(queue.playerRanks.get(id) || "Iron"), 0) /
      ids.length;
    return RANK_ORDER[Math.round(avg)] || "Mixed";
  };

  const [t1Lines, t2Lines] = await Promise.all([getLines(team1), getLines(team2)]);

  // Build the allowed users list for the private lobby channel
  const allPlayers = [...team1, ...team2];
  const allowedPermissions = allPlayers.map((id) => ({
    id,
    allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages],
  }));

  // Create category
  const category = await guild.channels.create({
    name: "🔴 VPS Scrims",
    type: ChannelType.GuildCategory,
    permissionOverwrites: [
      {
        id: guild.roles.everyone,
        deny: [PermissionsBitField.Flags.ViewChannel],
      },
      ...allowedPermissions,
    ],
  });
  queue.categoryId = category.id;

  // Create voice channels with team-locked permissions
  const vc1 = await guild.channels.create({
    name: "🔴 Team 1",
    type: ChannelType.GuildVoice,
    parent: category.id,
    userLimit: TEAM_SIZE,
    permissionOverwrites: [
      { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
      // Team 1 players — allowed in VC1
      ...team1.map((id) => ({
        id,
        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect],
      })),
      // Team 2 players — can see but cannot connect to VC1
      ...team2.map((id) => ({
        id,
        allow: [PermissionsBitField.Flags.ViewChannel],
        deny: [PermissionsBitField.Flags.Connect],
      })),
    ],
  });

  const vc2 = await guild.channels.create({
    name: "🔵 Team 2",
    type: ChannelType.GuildVoice,
    parent: category.id,
    userLimit: TEAM_SIZE,
    permissionOverwrites: [
      { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
      // Team 2 players — allowed in VC2
      ...team2.map((id) => ({
        id,
        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect],
      })),
      // Team 1 players — can see but cannot connect to VC2
      ...team1.map((id) => ({
        id,
        allow: [PermissionsBitField.Flags.ViewChannel],
        deny: [PermissionsBitField.Flags.Connect],
      })),
    ],
  });

  // Create private lobby text channel
  const lobbyChannel = await guild.channels.create({
    name: "📋┃lobby-info",
    type: ChannelType.GuildText,
    parent: category.id,
  });

  queue.voiceChannels.team1Id = vc1.id;
  queue.voiceChannels.team2Id = vc2.id;
  queue.lobbyChannelId = lobbyChannel.id;

  // Post teams embed in main queue channel
  const teamsEmbed = new EmbedBuilder()
    .setColor(0xff4655)
    .setTitle("⚔️  TEAMS ARE SET")
    .addFields(
      {
        name: `🔴  Team 1 — avg. ${avgRankLabel(team1)}`,
        value: t1Lines.join("\n") + `\n\n[🔊 Join Team 1 VC](https://discord.com/channels/${guild.id}/${vc1.id})`,
        inline: true,
      },
      {
        name: `🔵  Team 2 — avg. ${avgRankLabel(team2)}`,
        value: t2Lines.join("\n") + `\n\n[🔊 Join Team 2 VC](https://discord.com/channels/${guild.id}/${vc2.id})`,
        inline: true,
      },
      {
        name: "\u200B",
        value:
          `Head to ${lobbyChannel} for lobby info.\n\n` +
          "Someone run `/lobby` to claim host, then `/lobby [code]` to share the code.\n" +
          "Type **`ready`** in this channel once you're in the lobby.",
        inline: false,
      }
    )
    .setFooter({ text: "Teams balanced by rank • Type 'ready' in this channel when you're in the lobby" })
    .setTimestamp();

  await channel.send({ embeds: [teamsEmbed] });

  // Post welcome message in private lobby channel
  const playerMentions = allPlayers.map((id) => `<@${id}>`).join(" ");
  const lobbyWelcomeEmbed = new EmbedBuilder()
    .setColor(0xff4655)
    .setTitle("📋  Lobby Info")
    .setDescription(
      `${playerMentions}\n\n` +
      "This is your private lobby channel.\n\n" +
      "**To claim host:** run `/lobby` in this channel\n" +
      "**To share the code:** run `/lobby [code]` in this channel\n\n" +
      "*Only players in this 10-man can see this channel.*"
    )
    .setTimestamp();

  await lobbyChannel.send({ embeds: [lobbyWelcomeEmbed] });

  queue.phase = "ready";
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

async function cleanupLobby(guild, queue) {
  if (!queue) return;
  try {
    if (queue.voiceChannels.team1Id) {
      const vc = await guild.channels.fetch(queue.voiceChannels.team1Id).catch(() => null);
      if (vc) await vc.delete().catch(() => {});
    }
    if (queue.voiceChannels.team2Id) {
      const vc = await guild.channels.fetch(queue.voiceChannels.team2Id).catch(() => null);
      if (vc) await vc.delete().catch(() => {});
    }
    if (queue.lobbyChannelId) {
      const lc = await guild.channels.fetch(queue.lobbyChannelId).catch(() => null);
      if (lc) await lc.delete().catch(() => {});
    }
    if (queue.categoryId) {
      const cat = await guild.channels.fetch(queue.categoryId).catch(() => null);
      if (cat) await cat.delete().catch(() => {});
    }
  } catch (e) {}
}

// ─── Ready Check ─────────────────────────────────────────────────────────────

async function handleReadyCheck(message, queue) {
  if (queue.phase !== "ready" || !queue.teams) return;

  const allPlayers = [...queue.teams.team1, ...queue.teams.team2];
  if (!allPlayers.includes(message.author.id)) return;

  queue.readyPlayers.add(message.author.id);
  await message.react("✅").catch(() => {});

  const total = allPlayers.length;
  const readyCount = queue.readyPlayers.size;

  if (readyCount >= total) {
    const channel = await client.channels.fetch(queue.channelId).catch(() => null);
    if (channel) {
      const embed = new EmbedBuilder()
        .setColor(0x00ff88)
        .setTitle("✅  ALL PLAYERS READY — GLHF!")
        .setDescription(
          "Everyone is in the lobby. **Start the game!**\n\n" +
          "This lobby channel will be removed in 5 minutes.\n" +
          "*Good luck, have fun.* 🎯"
        )
        .setTimestamp();
      await channel.send({ embeds: [embed] });
    }

    // Also post in lobby channel
    if (queue.lobbyChannelId) {
      const lobbyChannel = await client.channels.fetch(queue.lobbyChannelId).catch(() => null);
      if (lobbyChannel) {
        await lobbyChannel.send("✅ **All players ready — start the game! GLHF** 🎯").catch(() => {});
      }
    }

    setTimeout(async () => {
      const guild = client.guilds.cache.get(message.guild.id);
      if (guild) await cleanupLobby(guild, queue);
      const gs = getGuildState(message.guild.id);
      if (gs) gs.activeQueue = null;
    }, 5 * 60 * 1000);
  } else {
    const channel = await client.channels.fetch(queue.channelId).catch(() => null);
    if (channel) {
      await channel
        .send(`✅ **${readyCount}/${total}** players ready...`)
        .then((m) => setTimeout(() => m.delete().catch(() => {}), 8000));
    }
  }
}

// ─── Auto Timer ───────────────────────────────────────────────────────────────

function startAutoQueue(guild, channelId) {
  const gs = getGuildState(guild.id);
  if (gs.interval) clearInterval(gs.interval);
  postQueueAlert(guild, channelId);
  gs.interval = setInterval(() => postQueueAlert(guild, channelId), 40 * 60 * 1000);
}

// ─── Events ───────────────────────────────────────────────────────────────────

client.once("clientReady", async () => {
  console.log(`[Bot] Logged in as ${client.user.tag}`);
  for (const [guildId] of client.guilds.cache) {
    getGuildState(guildId);
    await registerCommands(guildId);
  }
});

client.on("guildCreate", async (guild) => {
  getGuildState(guild.id);
  await registerCommands(guild.id);
});

// ─── Interactions ─────────────────────────────────────────────────────────────

client.on("interactionCreate", async (interaction) => {
  const guildId = interaction.guildId;
  const gs = getGuildState(guildId);
  const gp = getGuildParties(guildId);

  // ── Slash Commands ──
  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;

    if (commandName === "setup") {
      gs.channelId = interaction.channelId;

      // Lock channel — members can view and use buttons but not type/react/thread
      await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone, {
        SendMessages: false,
        AddReactions: false,
        CreatePublicThreads: false,
        CreatePrivateThreads: false,
        SendMessagesInThreads: false,
      }).catch(() => {});

      // Ensure the bot can still post
      await interaction.channel.permissionOverwrites.edit(interaction.guild.members.me, {
        SendMessages: true,
        AddReactions: true,
      }).catch(() => {});

      startAutoQueue(interaction.guild, interaction.channelId);
      await interaction.reply({
        content: `✅ Queue channel set to ${interaction.channel}. Auto-queue every 40 minutes is now active.\nChannel locked — members can view and click buttons but cannot type.\nCurrent rank range: **${gs.rankRange.min} → ${gs.rankRange.max}**`,
        ephemeral: true,
      });
    }

    else if (commandName === "setrange") {
      const min = interaction.options.getString("min");
      const max = interaction.options.getString("max");
      if (getRankIndex(min) > getRankIndex(max)) {
        return interaction.reply({ content: "❌ Min rank can't be higher than max rank.", ephemeral: true });
      }
      gs.rankRange = { min, max };
      await interaction.reply({
        content: `✅ Rank range updated: **${min} → ${max}**`,
        ephemeral: true,
      });
    }

    else if (commandName === "startqueue") {
      if (!gs.channelId) return interaction.reply({ content: "❌ Run `/setup` first.", ephemeral: true });
      await postQueueAlert(interaction.guild, gs.channelId);
      await interaction.reply({ content: "✅ Queue alert posted.", ephemeral: true });
    }

    else if (commandName === "stopqueue") {
      if (gs.interval) { clearInterval(gs.interval); gs.interval = null; }
      await interaction.reply({ content: "✅ Auto-queue timer stopped.", ephemeral: true });
    }

    else if (commandName === "cancelqueue") {
      if (!gs.activeQueue) return interaction.reply({ content: "❌ No active queue.", ephemeral: true });
      await cleanupLobby(interaction.guild, gs.activeQueue);
      gs.activeQueue = null;
      await interaction.reply({ content: "✅ Queue cancelled.", ephemeral: true });
    }

    else if (commandName === "status") {
      if (!gs.activeQueue) return interaction.reply({ content: "No active queue right now.", ephemeral: true });
      const q = gs.activeQueue;
      await interaction.reply({
        content: `**Phase:** ${q.phase} | **Players:** ${q.players.size}/10 | **Range:** ${gs.rankRange.min} → ${gs.rankRange.max}`,
        ephemeral: true,
      });
    }

    else if (commandName === "setuproles") {
      const rankEmojis = {
        Iron: "⚫", Bronze: "🟤", Silver: "⚪", Gold: "🟡",
        Platinum: "🩵", Diamond: "💎", Ascendant: "🟢", Immortal: "🔴", Radiant: "✨",
      };

      const embed = new EmbedBuilder()
        .setColor(0xff4655)
        .setTitle("🏅  Select Your Rank")
        .setDescription(
          "Pick your **current Valorant rank** from the dropdown below.\n" +
          "This will assign you the matching role on this server.\n\n" +
          "Selecting a new rank will automatically remove your old one.\n\n" +
          "> ⚠️ **Please select your honest rank.** Misrepresenting your rank to enter a queue you don't belong in may result in a ban from this server."
        )
        .setFooter({ text: "VPS Scrims • One rank per player" })
        .setTimestamp();

      const options = RANK_ORDER.map((rank) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(rank)
          .setValue(rank)
          .setEmoji(rankEmojis[rank])
      );

      const menu = new StringSelectMenuBuilder()
        .setCustomId("select_rank")
        .setPlaceholder("Choose your rank...")
        .addOptions(options);

      const row = new ActionRowBuilder().addComponents(menu);

      // Lock channel — members can view and use dropdown but not type/react/thread
      await interaction.channel.permissionOverwrites.edit(interaction.guild.roles.everyone, {
        SendMessages: false,
        AddReactions: false,
        CreatePublicThreads: false,
        CreatePrivateThreads: false,
        SendMessagesInThreads: false,
      }).catch(() => {});

      // Ensure the bot can still post
      await interaction.channel.permissionOverwrites.edit(interaction.guild.members.me, {
        SendMessages: true,
        AddReactions: true,
      }).catch(() => {});

      await interaction.channel.send({ embeds: [embed], components: [row] });
      await interaction.reply({ content: "✅ Rank selection embed posted and channel locked.", ephemeral: true });
    }

    else if (commandName === "lobby") {
      const q = gs.activeQueue;

      // Must be used in the private lobby channel
      if (!q || !q.lobbyChannelId) {
        return interaction.reply({
          content: "❌ No active lobby. This command is only available after teams are set.",
          ephemeral: true,
        });
      }

      if (interaction.channelId !== q.lobbyChannelId) {
        const lobbyChannel = await interaction.guild.channels.fetch(q.lobbyChannelId).catch(() => null);
        return interaction.reply({
          content: `❌ Use this command in ${lobbyChannel || "the lobby-info channel"}.`,
          ephemeral: true,
        });
      }

      const allPlayers = [...(q.teams?.team1 || []), ...(q.teams?.team2 || [])];
      if (!allPlayers.includes(interaction.user.id)) {
        return interaction.reply({
          content: "❌ You're not in this lobby.",
          ephemeral: true,
        });
      }

      const code = interaction.options.getString("code");
      const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
      const displayName = member ? member.displayName : interaction.user.username;

      if (!code) {
        // Claim lobby leader
        if (q.lobbyLeaderId) {
          const currentLeader = await interaction.guild.members.fetch(q.lobbyLeaderId).catch(() => null);
          const leaderName = currentLeader ? currentLeader.displayName : "Someone";
          return interaction.reply({
            content: `❌ **${leaderName}** is already the lobby leader. Only one host per lobby.`,
            ephemeral: true,
          });
        }

        q.lobbyLeaderId = interaction.user.id;

        // Grant lobby leader access to both VCs
        const vc1 = q.voiceChannels.team1Id
          ? await interaction.guild.channels.fetch(q.voiceChannels.team1Id).catch(() => null)
          : null;
        const vc2 = q.voiceChannels.team2Id
          ? await interaction.guild.channels.fetch(q.voiceChannels.team2Id).catch(() => null)
          : null;

        if (vc1) {
          await vc1.permissionOverwrites.edit(interaction.user.id, {
            ViewChannel: true,
            Connect: true,
          }).catch(() => {});
        }
        if (vc2) {
          await vc2.permissionOverwrites.edit(interaction.user.id, {
            ViewChannel: true,
            Connect: true,
          }).catch(() => {});
        }

        const embed = new EmbedBuilder()
          .setColor(0xff4655)
          .setTitle("👑  Lobby Leader Assigned")
          .setDescription(
            `**${displayName}** is the lobby leader for this 10-man.\n\n` +
            "As lobby leader you can join **both** voice channels.\n\n" +
            "Set up the custom game in Valorant:\n" +
            "**Game Mode:** Standard • **Map:** Your choice\n\n" +
            "Once you have the lobby code run `/lobby [code]` to share it here."
          )
          .setTimestamp();

        await interaction.reply({ embeds: [embed] });
      } else {
        // Share lobby code
        if (!q.lobbyLeaderId) {
          return interaction.reply({
            content: "❌ No lobby leader has been assigned yet. Run `/lobby` first to claim host.",
            ephemeral: true,
          });
        }

        if (q.lobbyLeaderId !== interaction.user.id) {
          const leader = await interaction.guild.members.fetch(q.lobbyLeaderId).catch(() => null);
          const leaderName = leader ? leader.displayName : "the lobby leader";
          return interaction.reply({
            content: `❌ Only **${leaderName}** can share the lobby code.`,
            ephemeral: true,
          });
        }

        const playerMentions = allPlayers.map((id) => `<@${id}>`).join(" ");

        const embed = new EmbedBuilder()
          .setColor(0x00ff88)
          .setTitle("🎮  Lobby Code")
          .addFields(
            { name: "Code", value: `\`\`\`${code}\`\`\``, inline: false },
            { name: "Host", value: `<@${interaction.user.id}>`, inline: true },
          )
          .setDescription(`${playerMentions}\n\nJoin the lobby and type **\`ready\`** in <#${q.channelId}> when you're in.`)
          .setFooter({ text: "VPS Scrims • Custom Lobby" })
          .setTimestamp();

        await interaction.reply({ embeds: [embed] });
      }
    }

    else if (commandName === "partystatus") {
      const userId = interaction.user.id;
      const leader = gp.partyOf.get(userId);
      const members = gp.parties.get(userId) || [];

      if (leader) {
        const leaderMember = await interaction.guild.members.fetch(leader).catch(() => null);
        const leaderName = leaderMember ? leaderMember.displayName : "Unknown";
        await interaction.reply({ content: `🤝 You're in a party led by **${leaderName}**.`, ephemeral: true });
      } else if (members.length > 0) {
        const names = await Promise.all(
          members.map(async (id) => {
            const m = await interaction.guild.members.fetch(id).catch(() => null);
            return m ? m.displayName : "Unknown";
          })
        );
        await interaction.reply({ content: `🤝 You're leading a party with: **${names.join(", ")}**`, ephemeral: true });
      } else {
        await interaction.reply({ content: "You're not in a party.", ephemeral: true });
      }
    }

    else if (commandName === "party") {
      const target = interaction.options.getUser("teammate");
      const inviterId = interaction.user.id;
      const targetId = target.id;

      if (inviterId === targetId) {
        return interaction.reply({ content: "❌ You can't party with yourself.", ephemeral: true });
      }

      const inviteKey = `${inviterId}-${targetId}`;
      if (pendingInvites.has(inviteKey)) {
        return interaction.reply({ content: "❌ You already have a pending invite to that player.", ephemeral: true });
      }

      const targetUser = await client.users.fetch(targetId).catch(() => null);
      if (!targetUser) {
        return interaction.reply({ content: "❌ Couldn't find that user.", ephemeral: true });
      }

      const inviterMember = await interaction.guild.members.fetch(inviterId).catch(() => null);
      const inviterName = inviterMember ? inviterMember.displayName : interaction.user.username;
      const guildName = interaction.guild.name;

      const dmEmbed = new EmbedBuilder()
        .setColor(0xff4655)
        .setTitle("🤝  Party Invite")
        .setDescription(
          `**${inviterName}** has invited you to party up in **${guildName}**.\n\n` +
          "You'll be placed on the same team when you both join the queue.\n\n" +
          "This invite expires in **60 seconds**."
        )
        .setTimestamp();

      const dmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`party_accept-${inviteKey}`)
          .setLabel("Accept")
          .setStyle(ButtonStyle.Success)
          .setEmoji("✅"),
        new ButtonBuilder()
          .setCustomId(`party_decline-${inviteKey}`)
          .setLabel("Decline")
          .setStyle(ButtonStyle.Danger)
          .setEmoji("❌")
      );

      let dmSent = false;
      try {
        await targetUser.send({ embeds: [dmEmbed], components: [dmRow] });
        dmSent = true;
      } catch (e) {}

      if (!dmSent) {
        return interaction.reply({
          content: `❌ Couldn't DM <@${targetId}>. They may have DMs disabled.`,
          ephemeral: true,
        });
      }

      pendingInvites.set(inviteKey, {
        inviterId, targetId, guildId, inviterName,
        expiresAt: Date.now() + INVITE_TIMEOUT_MS,
      });

      setTimeout(() => pendingInvites.delete(inviteKey), INVITE_TIMEOUT_MS);

      await interaction.reply({
        content: `📨 Party invite sent to <@${targetId}>! They have 60 seconds to accept.`,
        ephemeral: true,
      });
    }

    else if (commandName === "leaveparty") {
      const userId = interaction.user.id;
      const wasLeader = gp.parties.has(userId) && (gp.parties.get(userId) || []).length > 0;
      const wasMember = gp.partyOf.has(userId);

      if (!wasLeader && !wasMember) {
        return interaction.reply({ content: "You're not in a party.", ephemeral: true });
      }

      removeFromParty(userId, gp.parties, gp.partyOf);

      const q = gs.activeQueue;
      if (q) removeFromParty(userId, q.parties || new Map(), q.partyOf || new Map());

      await interaction.reply({
        content: wasLeader ? "✅ Party disbanded." : "✅ Left your party.",
        ephemeral: true,
      });
    }
  }

  // ── Buttons ──
  if (interaction.isButton()) {

    // Party accept/decline (from DMs)
    if (interaction.customId.startsWith("party_accept-") || interaction.customId.startsWith("party_decline-")) {
      const isAccept = interaction.customId.startsWith("party_accept-");
      const inviteKey = interaction.customId.replace("party_accept-", "").replace("party_decline-", "");
      const invite = pendingInvites.get(inviteKey);

      if (!invite) {
        return interaction.update({
          embeds: [new EmbedBuilder().setColor(0x888888).setDescription("❌ This invite has expired or was already responded to.")],
          components: [],
        });
      }

      pendingInvites.delete(inviteKey);

      if (!isAccept) {
        await interaction.update({
          embeds: [new EmbedBuilder().setColor(0xff4655).setDescription(`❌ You declined the party invite from **${invite.inviterName}**.`)],
          components: [],
        });
        const inviterUser = await client.users.fetch(invite.inviterId).catch(() => null);
        if (inviterUser) await inviterUser.send("❌ Your party invite was declined.").catch(() => {});
        return;
      }

      const gp = getGuildParties(invite.guildId);
      removeFromParty(invite.inviterId, gp.parties, gp.partyOf);
      removeFromParty(invite.targetId, gp.parties, gp.partyOf);

      if (!gp.parties.has(invite.inviterId)) gp.parties.set(invite.inviterId, []);
      gp.parties.get(invite.inviterId).push(invite.targetId);
      gp.partyOf.set(invite.targetId, invite.inviterId);

      await interaction.update({
        embeds: [new EmbedBuilder().setColor(0x00ff88).setDescription(`✅ You accepted the party invite from **${invite.inviterName}**! You'll be placed on the same team.`)],
        components: [],
      });

      const inviterUser = await client.users.fetch(invite.inviterId).catch(() => null);
      if (inviterUser) {
        const targetUser = await client.users.fetch(invite.targetId).catch(() => null);
        const targetName = targetUser ? targetUser.username : "Your teammate";
        await inviterUser.send(`✅ **${targetName}** accepted your party invite! You're now partied up.`).catch(() => {});
      }
      return;
    }

    // Queue buttons (from guild)
    const q = gs.activeQueue;

    if (interaction.customId === "join_queue") {
      if (!q || q.phase !== "queue") {
        return interaction.reply({ content: "❌ No active queue.", ephemeral: true });
      }
      if (q.players.size >= QUEUE_SIZE) {
        return interaction.reply({ content: "❌ Queue is full.", ephemeral: true });
      }
      if (q.players.has(interaction.user.id)) {
        return interaction.reply({ content: "You're already in the queue.", ephemeral: true });
      }

      const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
      if (!member) {
        return interaction.reply({ content: "❌ Couldn't verify your roles.", ephemeral: true });
      }
      if (!memberMeetsRankRequirement(member, gs.rankRange)) {
        return interaction.reply({
          content:
            `❌ Your rank role doesn't meet the requirement for this queue.\n` +
            `Required: **${gs.rankRange.min} → ${gs.rankRange.max}**\n` +
            `Make sure you have the correct rank role assigned.`,
          ephemeral: true,
        });
      }

      const userId = interaction.user.id;
      q.players.add(userId);
      q.playerRanks.set(userId, getMemberRank(member));

      if (!q.parties) q.parties = new Map();
      if (!q.partyOf) q.partyOf = new Map();

      const partyMembers = gp.parties.get(userId) || [];
      if (partyMembers.length > 0) {
        if (!q.parties.has(userId)) q.parties.set(userId, []);
        for (const memberId of partyMembers) {
          if (q.players.size >= 10 || q.players.has(memberId)) continue;
          const partyMember = await interaction.guild.members.fetch(memberId).catch(() => null);
          if (!partyMember || !memberMeetsRankRequirement(partyMember, gs.rankRange)) continue;
          q.players.add(memberId);
          q.playerRanks.set(memberId, getMemberRank(partyMember));
          q.parties.get(userId).push(memberId);
          q.partyOf.set(memberId, userId);
        }
      }

      await interaction.deferUpdate();
      await updateQueueEmbed(interaction.guild, q);

      if (q.players.size >= QUEUE_SIZE) {
        q.phase = "teams";
        q.teams = splitTeamsByRank(q.players, q.playerRanks, q.parties || new Map(), q.partyOf || new Map());
        await postTeams(interaction.guild, q);
      }
    }

    else if (interaction.customId === "leave_queue") {
      if (!q || q.phase !== "queue") {
        return interaction.reply({ content: "❌ No active queue.", ephemeral: true });
      }
      if (!q.players.has(interaction.user.id)) {
        return interaction.reply({ content: "You're not in the queue.", ephemeral: true });
      }

      q.players.delete(interaction.user.id);
      q.playerRanks.delete(interaction.user.id);
      for (const m of (q.parties?.get(interaction.user.id) || [])) {
        q.players.delete(m);
        q.playerRanks.delete(m);
      }

      await interaction.deferUpdate();
      await updateQueueEmbed(interaction.guild, q);
    }
  }
});

// ─── Select Menu (rank assignment) ──────────────────────────────────────────

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;

  if (interaction.customId === "select_rank") {
    const selectedRank = interaction.values[0];
    const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    if (!member) {
      return interaction.reply({ content: "❌ Couldn't fetch your member data.", ephemeral: true });
    }

    // Remove all existing rank roles
    const rankRolesToRemove = member.roles.cache.filter((r) => RANK_ORDER.includes(r.name));
    if (rankRolesToRemove.size > 0) {
      await member.roles.remove(rankRolesToRemove).catch(() => {});
    }

    // Find or create the role
    let role = interaction.guild.roles.cache.find((r) => r.name === selectedRank);
    if (!role) {
      const rankColors = {
        Iron: 0x8b8b8b, Bronze: 0xa0522d, Silver: 0xc0c0c0, Gold: 0xffd700,
        Platinum: 0x00b4d8, Diamond: 0x00b4ff, Ascendant: 0x00ff88,
        Immortal: 0xff4655, Radiant: 0xfffacd,
      };
      role = await interaction.guild.roles.create({
        name: selectedRank,
        color: rankColors[selectedRank] || 0x99aab5,
        reason: "VPS Scrims rank role auto-created",
      }).catch(() => null);
    }

    if (!role) {
      return interaction.reply({ content: "❌ Failed to assign role. Please contact an admin.", ephemeral: true });
    }

    await member.roles.add(role).catch(() => {});

    const rankEmojis = {
      Iron: "⚫", Bronze: "🟤", Silver: "⚪", Gold: "🟡",
      Platinum: "🩵", Diamond: "💎", Ascendant: "🟢", Immortal: "🔴", Radiant: "✨",
    };

    await interaction.reply({
      content: `✅ You've been assigned the **${rankEmojis[selectedRank]} ${selectedRank}** role.`,
      ephemeral: true,
    });
  }
});

// ─── Messages (ready check) ───────────────────────────────────────────────────

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  const guildId = message.guild?.id;
  if (!guildId) return;
  const gs = getGuildState(guildId);
  if (!gs?.activeQueue) return;
  if (message.channelId !== gs.channelId) return;
  if (message.content.trim().toLowerCase() === "ready") {
    await handleReadyCheck(message, gs.activeQueue);
  }
});

// ─── Login ────────────────────────────────────────────────────────────────────

client.login(process.env.DISCORD_TOKEN);