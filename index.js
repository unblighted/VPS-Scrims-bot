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
  "Iron",
  "Bronze",
  "Silver",
  "Gold",
  "Platinum",
  "Diamond",
  "Ascendant",
  "Immortal",
  "Radiant",
];

const DEFAULT_RANGE = { min: "Iron", max: "Radiant" };

// ─── State ────────────────────────────────────────────────────────────────────

const state = { guilds: {} };

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
      opt
        .setName("min")
        .setDescription("Minimum rank allowed")
        .setRequired(true)
        .addChoices(...RANK_CHOICES)
    )
    .addStringOption((opt) =>
      opt
        .setName("max")
        .setDescription("Maximum rank allowed")
        .setRequired(true)
        .addChoices(...RANK_CHOICES)
    ),

  new SlashCommandBuilder()
    .setName("party")
    .setDescription("Link with a friend to be placed on the same team")
    .addUserOption((opt) =>
      opt.setName("teammate").setDescription("The friend to party with").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("leaveparty")
    .setDescription("Leave your current party"),

  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Show current queue status"),

  new SlashCommandBuilder()
    .setName("cancelqueue")
    .setDescription("Cancel the active queue")
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
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
  if (gs.activeQueue) await cleanupVoiceChannels(guild, gs.activeQueue);

  const { min, max } = gs.rankRange;
  const rangeText = min === max ? min : `${min} → ${max}`;

  const embed = new EmbedBuilder()
    .setColor(0xff4655)
    .setTitle("🎯  VPS SCRIMS — 10-MAN QUEUE")
    .setDescription(
      "A new 10-man custom lobby is starting!\n\n" +
      "Press **Join Queue** to enter.\n" +
      "Use `/party @user` to link with a friend and guarantee same-team placement.\n\n" +
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
    categoryId: null,
  };

  console.log(`[Queue] Posted alert in ${guild.name}`);
}

async function updateQueueEmbed(guild, queue) {
  const channel = await guild.channels.fetch(queue.channelId).catch(() => null);
  if (!channel) return;
  const msg = await channel.messages.fetch(queue.messageId).catch(() => null);
  if (!msg) return;

  const gs = getGuildState(guild.id);
  const { min, max } = gs.rankRange;
  const rangeText = min === max ? min : `${min} → ${max}`;
  const playerCount = queue.players.size;

  const playerLines = await Promise.all(
    [...queue.players].map(async (uid) => {
      const member = await guild.members.fetch(uid).catch(() => null);
      const name = member ? member.displayName : "Unknown";
      const rank = queue.playerRanks.get(uid) || "Unranked";
      const isLeader = queue.parties.has(uid) && queue.parties.get(uid).length > 0;
      const inParty = queue.partyOf.has(uid);
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
      "Use `/party @user` to link with a friend and guarantee same-team placement.\n\n" +
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
      .setDisabled(playerCount >= 10),
    new ButtonBuilder()
      .setCustomId("leave_queue")
      .setLabel("Leave Queue")
      .setStyle(ButtonStyle.Secondary)
      .setEmoji("🚪")
  );

  await msg.edit({ embeds: [embed], components: [row] }).catch(() => {});
}

// ─── Rank-Balanced Team Split ─────────────────────────────────────────────────
//
// 1. Build party groups, average their rank indices
// 2. Sort groups highest rank first
// 3. Snake draft — assign each group to whichever team has the lower rank sum
// 4. Parties stay together, teams end up as balanced as possible

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

  const team1 = [];
  const team2 = [];
  let team1Sum = 0;
  let team2Sum = 0;

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

  return { team1: team1.slice(0, 5), team2: team2.slice(0, 5) };
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

  const category = await guild.channels.create({
    name: "🔴 VPS Scrims",
    type: ChannelType.GuildCategory,
  });
  queue.categoryId = category.id;

  const vc1 = await guild.channels.create({
    name: "🔴 Team 1",
    type: ChannelType.GuildVoice,
    parent: category.id,
    userLimit: 5,
  });

  const vc2 = await guild.channels.create({
    name: "🔵 Team 2",
    type: ChannelType.GuildVoice,
    parent: category.id,
    userLimit: 5,
  });

  queue.voiceChannels.team1Id = vc1.id;
  queue.voiceChannels.team2Id = vc2.id;

  const embed = new EmbedBuilder()
    .setColor(0xff4655)
    .setTitle("⚔️  TEAMS ARE SET")
    .addFields(
      {
        name: `🔴  Team 1 — avg. ${avgRankLabel(team1)}`,
        value: t1Lines.join("\n"),
        inline: true,
      },
      {
        name: `🔵  Team 2 — avg. ${avgRankLabel(team2)}`,
        value: t2Lines.join("\n"),
        inline: true,
      },
      {
        name: "\u200B",
        value:
          `Voice channels: ${vc1} and ${vc2}\n\n` +
          "**Host:** Set up the custom lobby in Valorant and share the **lobby code + password** here.\n" +
          "Once you're in the lobby, type **`ready`** in this channel.\n\n" +
          "*Game starts when all 10 players are ready.*",
        inline: false,
      }
    )
    .setFooter({ text: "Teams balanced by rank • Type 'ready' when you're in the lobby" })
    .setTimestamp();

  await channel.send({ embeds: [embed] });
  queue.phase = "ready";
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

async function cleanupVoiceChannels(guild, queue) {
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
    if (!channel) return;

    const embed = new EmbedBuilder()
      .setColor(0x00ff88)
      .setTitle("✅  ALL PLAYERS READY — GLHF!")
      .setDescription(
        "Everyone is in the lobby. **Start the game!**\n\n" +
        "Voice channels will be removed in 5 minutes.\n" +
        "*Good luck, have fun.* 🎯"
      )
      .setTimestamp();

    await channel.send({ embeds: [embed] });

    setTimeout(async () => {
      const guild = client.guilds.cache.get(message.guild.id);
      if (guild) await cleanupVoiceChannels(guild, queue);
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

  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;

    if (commandName === "setup") {
      gs.channelId = interaction.channelId;
      startAutoQueue(interaction.guild, interaction.channelId);
      await interaction.reply({
        content: `✅ Queue channel set to ${interaction.channel}. Auto-queue every 40 minutes is now active.\nCurrent rank range: **${gs.rankRange.min} → ${gs.rankRange.max}**`,
        ephemeral: true,
      });
    }

    else if (commandName === "setrange") {
      const min = interaction.options.getString("min");
      const max = interaction.options.getString("max");
      if (getRankIndex(min) > getRankIndex(max)) {
        return interaction.reply({
          content: "❌ Min rank can't be higher than max rank.",
          ephemeral: true,
        });
      }
      gs.rankRange = { min, max };
      await interaction.reply({
        content: `✅ Rank range updated: **${min} → ${max}**\nOnly players with roles in this range can join the next queue.`,
        ephemeral: true,
      });
    }

    else if (commandName === "startqueue") {
      if (!gs.channelId) {
        return interaction.reply({ content: "❌ Run `/setup` first.", ephemeral: true });
      }
      await postQueueAlert(interaction.guild, gs.channelId);
      await interaction.reply({ content: "✅ Queue alert posted.", ephemeral: true });
    }

    else if (commandName === "stopqueue") {
      if (gs.interval) { clearInterval(gs.interval); gs.interval = null; }
      await interaction.reply({ content: "✅ Auto-queue timer stopped.", ephemeral: true });
    }

    else if (commandName === "cancelqueue") {
      if (!gs.activeQueue) {
        return interaction.reply({ content: "❌ No active queue.", ephemeral: true });
      }
      await cleanupVoiceChannels(interaction.guild, gs.activeQueue);
      gs.activeQueue = null;
      await interaction.reply({ content: "✅ Queue cancelled.", ephemeral: true });
    }

    else if (commandName === "status") {
      if (!gs.activeQueue) {
        return interaction.reply({ content: "No active queue right now.", ephemeral: true });
      }
      const q = gs.activeQueue;
      await interaction.reply({
        content: `**Phase:** ${q.phase} | **Players:** ${q.players.size}/10 | **Range:** ${gs.rankRange.min} → ${gs.rankRange.max}`,
        ephemeral: true,
      });
    }

    else if (commandName === "party") {
      const target = interaction.options.getUser("teammate");
      const userId = interaction.user.id;
      const targetId = target.id;

      if (userId === targetId) {
        return interaction.reply({ content: "❌ You can't party with yourself.", ephemeral: true });
      }

      const q = gs.activeQueue;
      if (!q) {
        return interaction.reply({
          content: `🤝 Party with <@${targetId}> noted! Join the queue when it opens.`,
          ephemeral: true,
        });
      }

      const oldLeader = q.partyOf.get(userId);
      if (oldLeader) {
        q.parties.set(oldLeader, (q.parties.get(oldLeader) || []).filter((m) => m !== userId));
        q.partyOf.delete(userId);
      }
      if (q.parties.has(userId)) {
        (q.parties.get(userId) || []).forEach((m) => q.partyOf.delete(m));
        q.parties.delete(userId);
      }

      if (!q.parties.has(userId)) q.parties.set(userId, []);
      const members = q.parties.get(userId);
      if (!members.includes(targetId)) members.push(targetId);
      q.partyOf.set(targetId, userId);

      await interaction.reply({
        content: `🤝 Partied with <@${targetId}>! You'll be placed on the same team.`,
        ephemeral: true,
      });
    }

    else if (commandName === "leaveparty") {
      const userId = interaction.user.id;
      const q = gs.activeQueue;
      if (!q) return interaction.reply({ content: "No active queue.", ephemeral: true });

      const leader = q.partyOf.get(userId);
      if (leader) {
        q.parties.set(leader, (q.parties.get(leader) || []).filter((m) => m !== userId));
        q.partyOf.delete(userId);
        await interaction.reply({ content: "✅ Left your party.", ephemeral: true });
      } else if (q.parties.has(userId)) {
        (q.parties.get(userId) || []).forEach((m) => q.partyOf.delete(m));
        q.parties.delete(userId);
        await interaction.reply({ content: "✅ Party disbanded.", ephemeral: true });
      } else {
        await interaction.reply({ content: "You're not in a party.", ephemeral: true });
      }
    }
  }

  if (interaction.isButton()) {
    const q = gs.activeQueue;

    if (interaction.customId === "join_queue") {
      if (!q || q.phase !== "queue") {
        return interaction.reply({ content: "❌ No active queue.", ephemeral: true });
      }
      if (q.players.size >= 10) {
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

      // Pull in party members if they also meet rank req
      for (const memberId of q.parties.get(userId) || []) {
        if (q.players.size >= 10 || q.players.has(memberId)) continue;
        const partyMember = await interaction.guild.members.fetch(memberId).catch(() => null);
        if (!partyMember || !memberMeetsRankRequirement(partyMember, gs.rankRange)) continue;
        q.players.add(memberId);
        q.playerRanks.set(memberId, getMemberRank(partyMember));
      }

      await interaction.deferUpdate();
      await updateQueueEmbed(interaction.guild, q);

      if (q.players.size >= 10) {
        q.phase = "teams";
        q.teams = splitTeamsByRank(q.players, q.playerRanks, q.parties, q.partyOf);
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
      for (const m of q.parties.get(interaction.user.id) || []) {
        q.players.delete(m);
        q.playerRanks.delete(m);
      }

      await interaction.deferUpdate();
      await updateQueueEmbed(interaction.guild, q);
    }
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