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
  AttachmentBuilder,
} = require("discord.js");
const fs = require("fs");
const path = require("path");

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

// ─── Constants ────────────────────────────────────────────────────────────────

const RANK_ORDER = ["Iron","Bronze","Silver","Gold","Platinum","Diamond","Ascendant","Immortal","Radiant"];
const RANK_EMOJIS = { Iron:"⚫",Bronze:"🟤",Silver:"⚪",Gold:"🟡",Platinum:"🩵",Diamond:"💎",Ascendant:"🟢",Immortal:"🔴",Radiant:"✨" };
const RANK_COLORS = { Iron:0x8b8b8b,Bronze:0xa0522d,Silver:0xc0c0c0,Gold:0xffd700,Platinum:0x00b4d8,Diamond:0x00b4ff,Ascendant:0x00ff88,Immortal:0xff4655,Radiant:0xfffacd };
const DEFAULT_RANGE = { min:"Iron", max:"Radiant" };
const QUEUE_SIZE = 2;
const TEAM_SIZE = Math.floor(QUEUE_SIZE / 2);
const INVITE_TIMEOUT_MS = 60 * 1000;
const LOBBY_CODE_REGEX = /^[A-Za-z0-9]{6}$/;
const TRACKER_REGEX = /tracker\.gg\/valorant\/match\/([a-f0-9\-]{36})/i;
const HENRIK_BASE = "https://api.henrikdev.xyz/valorant";
const VOTES_NEEDED = Math.ceil(QUEUE_SIZE * 0.6); // 6 out of 10
const STATS_FILE = path.join(__dirname, "stats.json");

// ─── Stats Persistence ────────────────────────────────────────────────────────

// stats shape: { [guildId]: { [userId]: { wins, losses, ties, games, kills, deaths, assists, kdaGames } } }
let allStats = {};

// riotIds shape: { [guildId]: { [userId]: 'RiotName#TAG' } }
let riotIds = {};

function loadStats() {
  try {
    if (fs.existsSync(STATS_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATS_FILE, "utf8"));
      allStats = data.stats || data; // backward compat
      riotIds = data.riotIds || {};
      console.log("[Stats] Loaded from disk");
    }
  } catch (e) {
    console.error("[Stats] Failed to load:", e);
    allStats = {};
    riotIds = {};
  }
}

function saveStats() {
  try {
    fs.writeFileSync(STATS_FILE, JSON.stringify({ stats: allStats, riotIds }, null, 2));
  } catch (e) {
    console.error("[Stats] Failed to save:", e);
  }
}

function getRiotId(guildId, userId) {
  return riotIds[guildId]?.[userId] || null;
}

function setRiotId(guildId, userId, riotId) {
  if (!riotIds[guildId]) riotIds[guildId] = {};
  riotIds[guildId][userId] = riotId;
  saveStats();
}

function getPlayerStats(guildId, userId) {
  if (!allStats[guildId]) allStats[guildId] = {};
  if (!allStats[guildId][userId]) {
    allStats[guildId][userId] = { wins:0, losses:0, ties:0, games:0, kills:0, deaths:0, assists:0, kdaGames:0 };
  }
  return allStats[guildId][userId];
}

function recordResult(guildId, playerIds, winnerTeam, team1Ids, team2Ids, kdaMap) {
  // winnerTeam: "team1" | "team2" | "tie"
  for (const uid of playerIds) {
    const s = getPlayerStats(guildId, uid);
    s.games++;
    const inTeam1 = team1Ids.includes(uid);
    if (winnerTeam === "tie") s.ties++;
    else if ((winnerTeam === "team1" && inTeam1) || (winnerTeam === "team2" && !inTeam1)) s.wins++;
    else s.losses++;

    // Apply KDA if available
    if (kdaMap && kdaMap[uid]) {
      const { k, d, a } = kdaMap[uid];
      s.kills += k;
      s.deaths += d;
      s.assists += a;
      s.kdaGames++;
    }
  }
  saveStats();
}

// ─── State ────────────────────────────────────────────────────────────────────

const guildState = {};
const activeQueues = new Map();         // queueId -> queue
const lobbyChannelToQueue = new Map();  // lobbyChannelId -> queueId
const pendingInvites = new Map();
const globalParties = new Map();

function getGuildState(guildId) {
  if (!guildState[guildId]) {
    guildState[guildId] = { channelId:null, interval:null, rankRange:{...DEFAULT_RANGE}, resultsChannelId:null };
  }
  return guildState[guildId];
}

function getGuildParties(guildId) {
  if (!globalParties.has(guildId)) globalParties.set(guildId, { parties:new Map(), partyOf:new Map() });
  return globalParties.get(guildId);
}

// ─── Rank Helpers ─────────────────────────────────────────────────────────────

function getMemberRank(member) {
  for (let i = RANK_ORDER.length - 1; i >= 0; i--) {
    if (member.roles.cache.some((r) => r.name === RANK_ORDER[i])) return RANK_ORDER[i];
  }
  return null;
}
function getRankIndex(rank) { return RANK_ORDER.indexOf(rank); }
function memberMeetsRankRequirement(member, rankRange) {
  const rank = getMemberRank(member);
  if (!rank) return false;
  const i = getRankIndex(rank);
  return i >= getRankIndex(rankRange.min) && i <= getRankIndex(rankRange.max);
}

// ─── Party Helpers ────────────────────────────────────────────────────────────

function removeFromParty(userId, parties, partyOf) {
  const leader = partyOf.get(userId);
  if (leader) { parties.set(leader, (parties.get(leader)||[]).filter(m=>m!==userId)); partyOf.delete(userId); return; }
  if (parties.has(userId)) { (parties.get(userId)||[]).forEach(m=>partyOf.delete(m)); parties.delete(userId); }
}

// ─── Slash Commands ───────────────────────────────────────────────────────────

const RANK_CHOICES = RANK_ORDER.map((r) => ({ name:r, value:r }));

const commands = [
  new SlashCommandBuilder().setName("setup").setDescription("Set this channel as the queue channel").setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
  new SlashCommandBuilder().setName("setupresults").setDescription("Set this channel as the results channel").setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
  new SlashCommandBuilder().setName("setuproles").setDescription("Post the rank selection embed in this channel").setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
  new SlashCommandBuilder().setName("startqueue").setDescription("Manually trigger a queue alert now").setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
  new SlashCommandBuilder().setName("stopqueue").setDescription("Stop the automatic queue timer").setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
  new SlashCommandBuilder()
    .setName("setrange").setDescription("Set the rank range allowed to join").setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
    .addStringOption(o=>o.setName("min").setDescription("Minimum rank").setRequired(true).addChoices(...RANK_CHOICES))
    .addStringOption(o=>o.setName("max").setDescription("Maximum rank").setRequired(true).addChoices(...RANK_CHOICES)),
  new SlashCommandBuilder()
    .setName("cancelqueue").setDescription("Cancel a queue").setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
    .addStringOption(o=>o.setName("id").setDescription("Queue message ID (blank = latest)").setRequired(false)),
  new SlashCommandBuilder()
    .setName("setresult").setDescription("Manually set a lobby result (admin override)").setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
    .addStringOption(o=>o.setName("result").setDescription("Result").setRequired(true).addChoices({name:"Team 1 Won",value:"team1"},{name:"Team 2 Won",value:"team2"},{name:"Tie",value:"tie"}))
    .addStringOption(o=>o.setName("lobbyid").setDescription("Lobby channel ID (blank = latest)").setRequired(false)),
  new SlashCommandBuilder().setName("closelobby").setDescription("Close the lobby and start the result vote"),
  new SlashCommandBuilder()
    .setName("lobby").setDescription("Claim lobby leader or share/update the lobby code")
    .addStringOption(o=>o.setName("code").setDescription("6-character Valorant lobby code").setRequired(false)),
  new SlashCommandBuilder()
    .setName("stats").setDescription("Show W/L/KDA stats for a player")
    .addUserOption(o=>o.setName("player").setDescription("Player to look up (blank = yourself)").setRequired(false)),
  new SlashCommandBuilder().setName("leaderboard").setDescription("Show the top players by wins"),
  new SlashCommandBuilder().setName("purge").setDescription("Clear all messages in this channel").setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
  new SlashCommandBuilder().setName("exportstats").setDescription("DM you the raw stats file (admin only)").setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
  new SlashCommandBuilder().setName("forceclose").setDescription("Force close and delete this lobby (admin only)").setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
  new SlashCommandBuilder()
    .setName("link").setDescription("Link your Riot ID to your Discord account")
    .addStringOption(o=>o.setName("riotid").setDescription("Your Riot ID (e.g. Name#TAG)").setRequired(true)),
  new SlashCommandBuilder().setName("unlink").setDescription("Remove your linked Riot ID"),
  new SlashCommandBuilder().setName("party").setDescription("Send a party invite via DM").addUserOption(o=>o.setName("teammate").setDescription("Friend to invite").setRequired(true)),
  new SlashCommandBuilder().setName("leaveparty").setDescription("Leave or disband your current party"),
  new SlashCommandBuilder().setName("partystatus").setDescription("Show who you're partied with"),
  new SlashCommandBuilder().setName("status").setDescription("Show active queues"),
].map(c=>c.toJSON());

// ─── Register Commands ────────────────────────────────────────────────────────

async function registerCommands(guildId) {
  const rest = new REST({ version:"10" }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, guildId), { body:commands });
    console.log(`[Commands] Registered for guild ${guildId}`);
  } catch(e) { console.error("[Commands] Failed:", e); }
}

// ─── Lock Channel ─────────────────────────────────────────────────────────────

async function lockChannel(channel, guild) {
  await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages:false, AddReactions:false, CreatePublicThreads:false, CreatePrivateThreads:false, SendMessagesInThreads:false }).catch(()=>{});
  await channel.permissionOverwrites.edit(guild.members.me, { SendMessages:true, AddReactions:true }).catch(()=>{});
}

// ─── Purge Channel ───────────────────────────────────────────────────────────

async function purgeChannel(channel) {
  try {
    let deleted = 1;
    while (deleted > 0) {
      const fetched = await channel.messages.fetch({ limit: 100 });
      if (fetched.size === 0) break;
      // bulkDelete only works for messages under 14 days old
      const recent = fetched.filter(m => Date.now() - m.createdTimestamp < 14 * 24 * 60 * 60 * 1000);
      if (recent.size > 1) {
        const result = await channel.bulkDelete(recent, true).catch(()=>null);
        deleted = result ? result.size : 0;
      } else if (recent.size === 1) {
        await recent.first().delete().catch(()=>{});
        deleted = 1;
      } else {
        // All messages are older than 14 days, delete one by one
        for (const msg of fetched.values()) {
          await msg.delete().catch(()=>{});
        }
        break;
      }
      await new Promise(r => setTimeout(r, 500)); // small delay to avoid rate limits
    }
  } catch(e) {
    console.error('[Purge] Failed:', e);
  }
}

// ─── Post Queue Alert ─────────────────────────────────────────────────────────

async function postQueueAlert(guild, channelId) {
  const channel = await guild.channels.fetch(channelId).catch(()=>null);
  if (!channel) return;
  const gs = getGuildState(guild.id);
  const rangeText = gs.rankRange.min === gs.rankRange.max ? gs.rankRange.min : `${gs.rankRange.min} → ${gs.rankRange.max}`;

  const embed = new EmbedBuilder()
    .setColor(0xff4655).setTitle("🎯  VPS SCRIMS — 10-MAN QUEUE")
    .setDescription(`A new 10-man custom lobby is starting!\n\nPress **Join Queue** to enter.\nUse \`/party @user\` to invite a friend — they must accept before you both join.\n\n**Rank Range:** ${rangeText}\n\n**Players (0/${QUEUE_SIZE}):**\n*No one yet...*`)
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("join_queue").setLabel("Join Queue").setStyle(ButtonStyle.Danger).setEmoji("⚔️"),
    new ButtonBuilder().setCustomId("leave_queue").setLabel("Leave Queue").setStyle(ButtonStyle.Secondary).setEmoji("🚪")
  );

  const msg = await channel.send({ embeds:[embed], components:[row] });

  // Edit the embed to add the queue ID in the footer now that we have the message ID
  const embedWithId = new EmbedBuilder(embed.toJSON())
    .setFooter({ text:`Queue ID: ${msg.id} • Queue closes when 10 players join • Teams balanced by rank` });
  await msg.edit({ embeds:[embedWithId], components:[row] }).catch(()=>{});

  const queue = {
    id:msg.id, guildId:guild.id, messageId:msg.id, channelId,
    players:new Set(), playerRanks:new Map(), parties:new Map(), partyOf:new Map(),
    readyPlayers:new Set(), phase:"queue", teams:null,
    voiceChannels:{ team1Id:null, team2Id:null },
    lobbyChannelId:null, categoryId:null, lobbyLeaderId:null, lobbyCode:null,
    votes:new Map(),       // userId -> "team1"|"team2"|"tie"
    voteClosed:false,
    kdaMap:null,           // userId -> { k, d, a } from screenshot
    screenshotProcessed:false,
  };
  activeQueues.set(msg.id, queue);
  console.log(`[Queue] Posted in ${guild.name} — ID: ${msg.id}`);
  return queue;
}

// ─── Update Queue Embed ───────────────────────────────────────────────────────

async function updateQueueEmbed(guild, queue) {
  const channel = await guild.channels.fetch(queue.channelId).catch(()=>null);
  if (!channel) return;
  const msg = await channel.messages.fetch(queue.messageId).catch(()=>null);
  if (!msg) return;

  const gs = getGuildState(guild.id);
  const gp = getGuildParties(guild.id);
  const rangeText = gs.rankRange.min === gs.rankRange.max ? gs.rankRange.min : `${gs.rankRange.min} → ${gs.rankRange.max}`;
  const playerCount = queue.players.size;

  const playerLines = await Promise.all([...queue.players].map(async (uid) => {
    const member = await guild.members.fetch(uid).catch(()=>null);
    const name = member ? member.displayName : "Unknown";
    const rank = queue.playerRanks.get(uid) || "Unranked";
    const tag = (gp.parties.has(uid) && gp.parties.get(uid).length > 0) || gp.partyOf.has(uid) ? " 🤝" : "";
    return `• **${name}**${tag} — ${rank}`;
  }));

  const embed = new EmbedBuilder()
    .setColor(playerCount >= QUEUE_SIZE ? 0x00ff88 : 0xff4655).setTitle("🎯  VPS SCRIMS — 10-MAN QUEUE")
    .setDescription(`A new 10-man custom lobby is starting!\n\nPress **Join Queue** to enter.\nUse \`/party @user\` to invite a friend.\n\n**Rank Range:** ${rangeText}\n\n**Players (${playerCount}/${QUEUE_SIZE}):**\n${playerLines.length > 0 ? playerLines.join("\n") : "*No one yet...*"}`)
    .setFooter({ text:"Queue closes when 10 players join • Teams are balanced by rank" }).setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("join_queue").setLabel("Join Queue").setStyle(ButtonStyle.Danger).setEmoji("⚔️").setDisabled(playerCount >= QUEUE_SIZE),
    new ButtonBuilder().setCustomId("leave_queue").setLabel("Leave Queue").setStyle(ButtonStyle.Secondary).setEmoji("🚪")
  );

  await msg.edit({ embeds:[embed], components:[row] }).catch(()=>{});
}

// ─── Team Split ───────────────────────────────────────────────────────────────

function splitTeamsByRank(players, playerRanks, parties, partyOf) {
  const assigned = new Set();
  const groups = [];
  for (const [leader, members] of parties) {
    if (!players.has(leader)) continue;
    const group = [leader, ...members.filter(m=>players.has(m))];
    if (!group.length) continue;
    const avgRank = group.reduce((s,uid)=>s+getRankIndex(playerRanks.get(uid)||"Iron"),0)/group.length;
    groups.push({ members:group, avgRank });
    group.forEach(p=>assigned.add(p));
  }
  for (const uid of players) {
    if (assigned.has(uid)) continue;
    groups.push({ members:[uid], avgRank:getRankIndex(playerRanks.get(uid)||"Iron") });
    assigned.add(uid);
  }
  groups.sort((a,b)=>b.avgRank-a.avgRank);
  const team1=[],team2=[];
  let s1=0,s2=0;
  for (const g of groups) {
    if (team1.length<TEAM_SIZE && (s1<=s2||team2.length>=TEAM_SIZE)) { team1.push(...g.members); s1+=g.avgRank*g.members.length; }
    else if (team2.length<TEAM_SIZE) { team2.push(...g.members); s2+=g.avgRank*g.members.length; }
    else team1.push(...g.members);
  }
  return { team1:team1.slice(0,TEAM_SIZE), team2:team2.slice(0,TEAM_SIZE) };
}

// ─── Post Teams ───────────────────────────────────────────────────────────────

async function postTeams(guild, queue) {
  const channel = await guild.channels.fetch(queue.channelId).catch(()=>null);
  if (!channel) return;
  const { team1, team2 } = queue.teams;
  const allPlayers = [...team1, ...team2];

  const getLines = async (ids) => Promise.all(ids.map(async id => {
    await guild.members.fetch(id).catch(()=>null);
    const riotId = getRiotId(guild.id, id);
    const riotTag = riotId ? ` (${riotId})` : "";
    return `<@${id}>${riotTag} — ${queue.playerRanks.get(id)||"Unranked"}`;
  }));
  const avgLabel = (ids) => { const avg=ids.reduce((s,id)=>s+getRankIndex(queue.playerRanks.get(id)||"Iron"),0)/ids.length; return RANK_ORDER[Math.round(avg)]||"Mixed"; };
  const [t1Lines, t2Lines] = await Promise.all([getLines(team1), getLines(team2)]);

  const allowedPerms = allPlayers.map(id=>({ id, allow:[PermissionsBitField.Flags.ViewChannel,PermissionsBitField.Flags.SendMessages] }));
  const category = await guild.channels.create({
    name:"🔴 VPS Scrims", type:ChannelType.GuildCategory,
    permissionOverwrites:[
      { id:guild.roles.everyone, deny:[PermissionsBitField.Flags.ViewChannel] },
      ...allowedPerms,
      { id:guild.members.me, allow:[PermissionsBitField.Flags.ViewChannel,PermissionsBitField.Flags.SendMessages,PermissionsBitField.Flags.ManageChannels] },
    ],
  });
  queue.categoryId = category.id;

  const vc1 = await guild.channels.create({
    name:"🔴 Team 1", type:ChannelType.GuildVoice, parent:category.id, userLimit:TEAM_SIZE,
    permissionOverwrites:[
      { id:guild.roles.everyone, deny:[PermissionsBitField.Flags.ViewChannel] },
      ...team1.map(id=>({ id, allow:[PermissionsBitField.Flags.ViewChannel,PermissionsBitField.Flags.Connect] })),
      ...team2.map(id=>({ id, allow:[PermissionsBitField.Flags.ViewChannel], deny:[PermissionsBitField.Flags.Connect] })),
      { id:guild.members.me, allow:[PermissionsBitField.Flags.ViewChannel,PermissionsBitField.Flags.Connect] },
    ],
  });
  const vc2 = await guild.channels.create({
    name:"🔵 Team 2", type:ChannelType.GuildVoice, parent:category.id, userLimit:TEAM_SIZE,
    permissionOverwrites:[
      { id:guild.roles.everyone, deny:[PermissionsBitField.Flags.ViewChannel] },
      ...team2.map(id=>({ id, allow:[PermissionsBitField.Flags.ViewChannel,PermissionsBitField.Flags.Connect] })),
      ...team1.map(id=>({ id, allow:[PermissionsBitField.Flags.ViewChannel], deny:[PermissionsBitField.Flags.Connect] })),
      { id:guild.members.me, allow:[PermissionsBitField.Flags.ViewChannel,PermissionsBitField.Flags.Connect] },
    ],
  });
  const lobbyChannel = await guild.channels.create({ name:"📋┃lobby-info", type:ChannelType.GuildText, parent:category.id });

  queue.voiceChannels.team1Id = vc1.id;
  queue.voiceChannels.team2Id = vc2.id;
  queue.lobbyChannelId = lobbyChannel.id;
  lobbyChannelToQueue.set(lobbyChannel.id, queue.id);

  const teamsEmbed = new EmbedBuilder()
    .setColor(0xff4655).setTitle("⚔️  TEAMS ARE SET")
    .addFields(
      { name:`🔴  Team 1 — avg. ${avgLabel(team1)}`, value:t1Lines.join("\n")+`\n\n[🔊 Join Team 1 VC](https://discord.com/channels/${guild.id}/${vc1.id})`, inline:true },
      { name:`🔵  Team 2 — avg. ${avgLabel(team2)}`, value:t2Lines.join("\n")+`\n\n[🔊 Join Team 2 VC](https://discord.com/channels/${guild.id}/${vc2.id})`, inline:true },
      { name:"\u200B", value:`Head to ${lobbyChannel} for lobby info.\n\nRun \`/lobby\` to claim host, then \`/lobby [code]\` to share the code.\nType **\`ready\`** in the lobby channel when you're in the lobby.`, inline:false }
    )
    .setFooter({ text:"Teams balanced by rank • Type 'ready' in #lobby-info" }).setTimestamp();

  await channel.send({ embeds:[teamsEmbed] });

  const playerMentions = allPlayers.map(id=>`<@${id}>`).join(" ");
  const lobbyWelcomeEmbed = new EmbedBuilder()
    .setColor(0xff4655).setTitle("📋  Lobby Info")
    .setDescription(`${playerMentions}\n\nThis is your private lobby channel.\n\n**Claim host:** \`/lobby\`\n**Share code:** \`/lobby [6-char code]\`\n**Update code:** run \`/lobby [new code]\` again\n**Ready up:** type \`ready\` here\n**Close lobby:** \`/closelobby\` after the game ends\n**Upload scoreboard:** attach your screenshot here — the bot will parse it automatically\n\n*Only players in this 10-man can see this channel.*`)
    .setTimestamp();

  await lobbyChannel.send({ embeds:[lobbyWelcomeEmbed] });
  queue.phase = "ready";
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

async function cleanupLobby(guild, queue) {
  if (!queue) return;
  if (queue.lobbyChannelId) lobbyChannelToQueue.delete(queue.lobbyChannelId);
  try {
    for (const id of [queue.voiceChannels.team1Id, queue.voiceChannels.team2Id, queue.lobbyChannelId]) {
      if (!id) continue;
      const ch = await guild.channels.fetch(id).catch(()=>null);
      if (ch) await ch.delete().catch(()=>{});
    }
    if (queue.categoryId) {
      const cat = await guild.channels.fetch(queue.categoryId).catch(()=>null);
      if (cat) await cat.delete().catch(()=>{});
    }
  } catch(e) {}
  activeQueues.delete(queue.id);
}

// ─── Ready Check ─────────────────────────────────────────────────────────────

async function handleReadyCheck(message, queue) {
  if (queue.phase !== "ready" || !queue.teams) return;
  if (message.channelId !== queue.lobbyChannelId) return;
  const allPlayers = [...queue.teams.team1, ...queue.teams.team2];
  if (!allPlayers.includes(message.author.id)) return;

  queue.readyPlayers.add(message.author.id);
  await message.react("✅").catch(()=>{});

  const readyCount = queue.readyPlayers.size;
  if (readyCount >= allPlayers.length) {
    const ch = await client.channels.fetch(queue.lobbyChannelId).catch(()=>null);
    if (ch) {
      await ch.send({ embeds:[new EmbedBuilder().setColor(0x00ff88).setTitle("✅  ALL PLAYERS READY — GLHF!").setDescription("Everyone is in the lobby. **Start the game!**\n\nOnce the game finishes, run `/closelobby` to submit the result.\n*Good luck, have fun.* 🎯").setTimestamp()] });
    }
  } else {
    await message.channel.send(`✅ **${readyCount}/${allPlayers.length}** players ready...`).then(m=>setTimeout(()=>m.delete().catch(()=>{}),8000));
  }
}

// ─── Post Vote ────────────────────────────────────────────────────────────────

async function postVote(guild, queue) {
  const lobbyChannel = await guild.channels.fetch(queue.lobbyChannelId).catch(()=>null);
  if (!lobbyChannel) return;

  queue.phase = "voting";
  queue.votes = new Map();

  const embed = new EmbedBuilder()
    .setColor(0xff4655).setTitle("🗳️  Who Won?")
    .setDescription(`Vote for the result. First option to reach **${VOTES_NEEDED} votes** wins.\nOnly players in this lobby can vote — one vote each.\n\n**Team 1:** ${queue.teams.team1.map(id=>`<@${id}>`).join(", ")}\n**Team 2:** ${queue.teams.team2.map(id=>`<@${id}>`).join(", ")}`)
    .setFooter({ text:`${VOTES_NEEDED}/${QUEUE_SIZE} votes needed to confirm` }).setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`vote_team1_${queue.id}`).setLabel("🔴 Team 1 Won").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`vote_team2_${queue.id}`).setLabel("🔵 Team 2 Won").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`vote_tie_${queue.id}`).setLabel("🤝 Tie").setStyle(ButtonStyle.Secondary)
  );

  await lobbyChannel.send({ embeds:[embed], components:[row] });
}

// ─── Post Result ──────────────────────────────────────────────────────────────

async function postResult(guild, queue, winnerTeam) {
  if (queue.voteClosed) return;
  queue.voteClosed = true;

  const gs = getGuildState(guild.id);
  const allPlayers = [...queue.teams.team1, ...queue.teams.team2];

  // Record stats
  recordResult(guild.id, allPlayers, winnerTeam, queue.teams.team1, queue.teams.team2, queue.kdaMap);

  // Build result embed
  const resultLabels = { team1:"🔴 Team 1 Won", team2:"🔵 Team 2 Won", tie:"🤝 Tie" };
  const resultColors = { team1:0xff4655, team2:0x5865f2, tie:0x99aab5 };

  const getLines = async (ids) => Promise.all(ids.map(async id => {
    const m = await guild.members.fetch(id).catch(()=>null);
    const name = m ? m.displayName : "Unknown";
    const rank = queue.playerRanks.get(id) || "Unranked";
    const riotId = getRiotId(guild.id, id);
    const riotTag = riotId ? ` (${riotId})` : "";
    const kda = queue.kdaMap && queue.kdaMap[id] ? ` • KDA: **${queue.kdaMap[id].k}/${queue.kdaMap[id].d}/${queue.kdaMap[id].a}**` : "";
    const isWinner = (winnerTeam === "team1" && queue.teams.team1.includes(id)) || (winnerTeam === "team2" && queue.teams.team2.includes(id));
    const prefix = winnerTeam !== "tie" && isWinner ? "🏆 " : "";
    return `${prefix}<@${id}>${riotTag} — ${rank}${kda}`;
  }));

  const [t1Lines, t2Lines] = await Promise.all([getLines(queue.teams.team1), getLines(queue.teams.team2)]);

  const resultEmbed = new EmbedBuilder()
    .setColor(resultColors[winnerTeam])
    .setTitle(`⚔️  Lobby Result — ${resultLabels[winnerTeam]}`)
    .addFields(
      { name:"🔴  Team 1", value:t1Lines.join("\n"), inline:true },
      { name:"🔵  Team 2", value:t2Lines.join("\n"), inline:true }
    )
    .setFooter({ text:"VPS Scrims" }).setTimestamp();

  // Post to results channel if set
  if (gs.resultsChannelId) {
    const resultsChannel = await guild.channels.fetch(gs.resultsChannelId).catch(()=>null);
    if (resultsChannel) {
      await resultsChannel.send({ embeds:[resultEmbed] });
      if (queue.screenshotUrl) {
        await resultsChannel.send({ content:"📸 **Scoreboard screenshot:**", files:[queue.screenshotUrl] }).catch(()=>{});
      }
    }
  }

  // Confirm in lobby channel
  const lobbyChannel = await guild.channels.fetch(queue.lobbyChannelId).catch(()=>null);
  if (lobbyChannel) {
    const gs2 = getGuildState(guild.id);
    const resultsRef = gs2.resultsChannelId ? ` Check <#${gs2.resultsChannelId}> for the full result.` : "";
    await lobbyChannel.send({ embeds:[new EmbedBuilder().setColor(resultColors[winnerTeam]).setTitle(`✅ Result confirmed: ${resultLabels[winnerTeam]}`).setDescription(`Stats updated.${resultsRef}\n\nThis channel will be removed in 30 seconds.`).setTimestamp()] });
  }

  // Cleanup after 30s
  setTimeout(async () => {
    await cleanupLobby(guild, queue);
  }, 30 * 1000);
}

// ─── AI Screenshot Parser ─────────────────────────────────────────────────────

async function parseScreenshot(imageUrl, queue, guild) {
  try {
    // Fetch the image as base64
    const response = await fetch(imageUrl);
    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");
    const contentType = response.headers.get("content-type") || "image/png";

    // Call Claude vision API
    const apiResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body:JSON.stringify({
        model:"claude-sonnet-4-20250514",
        max_tokens:1000,
        messages:[{
          role:"user",
          content:[
            {
              type:"image",
              source:{ type:"base64", media_type:contentType, data:base64 }
            },
            {
              type:"text",
              text:`This is a Valorant end-of-game scoreboard screenshot. Extract each player's stats and return ONLY a JSON array, no other text, no markdown, no backticks. Format: [{"name":"PlayerName","agent":"AgentName","kills":0,"deaths":0,"assists":0,"acs":0,"team":"attack or defense or team1 or team2"}]. Use 0 for any value you can't read clearly.`
            }
          ]
        }]
      })
    });

    const data = await apiResponse.json();
    const text = data.content?.find(b=>b.type==="text")?.text || "";

    // Parse JSON from response
    const clean = text.replace(/```json|```/g, "").trim();
    const players = JSON.parse(clean);

    if (!Array.isArray(players) || players.length === 0) return null;

    // Try to match parsed names to Discord users in this lobby
    const allPlayers = [...queue.teams.team1, ...queue.teams.team2];
    const kdaMap = {};

    for (const parsed of players) {
      // Try to match by display name
      for (const uid of allPlayers) {
        const member = await guild.members.fetch(uid).catch(()=>null);
        if (!member) continue;
        const displayName = member.displayName.toLowerCase();
        const parsedName = (parsed.name || "").toLowerCase();
        // Fuzzy match — display name contains parsed name or vice versa
        if (displayName.includes(parsedName) || parsedName.includes(displayName) || parsedName.includes(displayName.split(" ")[0])) {
          kdaMap[uid] = { k:parsed.kills||0, d:parsed.deaths||0, a:parsed.assists||0, acs:parsed.acs||0, agent:parsed.agent||"" };
          break;
        }
      }
    }

    return { kdaMap, rawPlayers:players };
  } catch(e) {
    console.error("[Screenshot] Parse failed:", e);
    return null;
  }
}

// ─── Henrik API ──────────────────────────────────────────────────────────────

async function fetchMatchFromHenrik(matchId) {
  // Try v4 for each common region, then fall back to v2
  const regions = ["eu", "na", "ap", "kr"];
  for (const region of regions) {
    try {
      const res = await fetch(`${HENRIK_BASE}/v4/match/${region}/${matchId}`, {
        headers: { "Authorization": process.env.HENRIK_API_KEY },
      });
      if (res.ok) {
        const data = await res.json();
        if (data.status === 200 && data.data) {
          console.log(`[Henrik] v4 match found in region: ${region}`);
          return { version: "v4", data: data.data };
        }
      }
    } catch(e) {}
  }
  // Fall back to v2
  try {
    const res = await fetch(`${HENRIK_BASE}/v2/match/${matchId}`, {
      headers: { "Authorization": process.env.HENRIK_API_KEY },
    });
    if (res.ok) {
      const data = await res.json();
      if ((data.status === 200 || data.status === "ok") && data.data) {
        console.log("[Henrik] v2 match found");
        return { version: "v2", data: data.data };
      }
    }
  } catch(e) {}
  console.error(`[Henrik] Could not fetch match ${matchId} from any region/version`);
  return null;
}

// Parse Henrik match data and cross-reference with lobby players
// Returns { winnerTeam, kdaMap, mapName, score, matchId } or null
async function processHenrikMatch(matchResult, queue, guild) {
  if (!matchResult) return null;
  const { version, data: matchData } = matchResult;
  if (!matchData) return null;

  const allPlayers = [...(queue.teams?.team1||[]), ...(queue.teams?.team2||[])];

  // Build a map of riotId (lowercase) -> discordUserId
  const riotToDiscord = {};
  for (const uid of allPlayers) {
    const riot = getRiotId(guild.id, uid);
    if (riot) riotToDiscord[riot.toLowerCase().trim()] = uid;
  }

  const kdaMap = {};
  const teamAssignment = {};

  // Normalize player list — v4 uses flat array with agent.name and team_id
  // v2 uses players.all_players with character and team
  const playerList = version === "v4"
    ? (matchData.players || [])
    : (matchData.players?.all_players || []);

  const roundsPlayed = version === "v4"
    ? (matchData.metadata?.game_length_in_ms ? 1 : matchData.rounds?.length || 1)
    : (matchData.metadata?.rounds_played || 1);

  for (const p of playerList) {
    const name = p.name || "";
    const tag = p.tag || "";
    const exactKey = (name + "#" + tag).toLowerCase().trim();
    const nameOnlyKey = name.toLowerCase().trim();

    let discordId = riotToDiscord[exactKey];
    if (!discordId) {
      // fallback: match on name only — handles tag case differences
      for (const [storedKey, uid] of Object.entries(riotToDiscord)) {
        if (storedKey.split("#")[0] === nameOnlyKey) { discordId = uid; break; }
      }
    }
    if (!discordId) {
      console.log(`[Henrik] No match for player: ${name}#${tag}`);
      continue;
    }

    // v4: agent is { name: "Sova" }, team is team_id
    // v2: agent is character string, team is team
    const agentName = version === "v4"
      ? (p.agent?.name || "")
      : (p.character || "");
    const teamId = version === "v4"
      ? (p.team_id || "")
      : (p.team || "");
    const score = p.stats?.score || 0;
    const acs = Math.round(score / Math.max(roundsPlayed, 1));

    kdaMap[discordId] = {
      k: p.stats?.kills || 0,
      d: p.stats?.deaths || 0,
      a: p.stats?.assists || 0,
      acs,
      agent: agentName,
      team: teamId,
    };
    teamAssignment[discordId] = teamId;
    console.log(`[Henrik] Matched ${name}#${tag} -> Discord ID ${discordId} (team: ${teamId})`);
  }

  // Map our lobby teams to Henrik Red/Blue
  let team1Red = 0, team1Blue = 0;
  for (const uid of queue.teams.team1) {
    const t = teamAssignment[uid] || "";
    if (t === "Red") team1Red++;
    else if (t === "Blue") team1Blue++;
  }
  const team1HenrikTeam = team1Red >= team1Blue ? "Red" : "Blue";
  const team2HenrikTeam = team1HenrikTeam === "Red" ? "Blue" : "Red";

  // Get winning team — v4 and v2 both use teams.red.has_won / teams.blue.has_won
  const teamsData = matchData.teams;
  const redWon = version === "v4"
    ? teamsData?.find(t => t.team_id === "Red")?.won
    : teamsData?.red?.has_won;
  const blueWon = version === "v4"
    ? teamsData?.find(t => t.team_id === "Blue")?.won
    : teamsData?.blue?.has_won;

  const winningHenrikTeam = redWon ? "Red" : blueWon ? "Blue" : null;
  let winnerTeam = "tie";
  if (winningHenrikTeam === team1HenrikTeam) winnerTeam = "team1";
  else if (winningHenrikTeam === team2HenrikTeam) winnerTeam = "team2";

  // Get round scores
  const redRounds = version === "v4"
    ? (teamsData?.find(t => t.team_id === "Red")?.rounds?.won ?? "?")
    : (teamsData?.red?.rounds_won ?? "?");
  const blueRounds = version === "v4"
    ? (teamsData?.find(t => t.team_id === "Blue")?.rounds?.won ?? "?")
    : (teamsData?.blue?.rounds_won ?? "?");

  const team1Score = team1HenrikTeam === "Red" ? redRounds : blueRounds;
  const team2Score = team1HenrikTeam === "Red" ? blueRounds : redRounds;

  // Map name
  const mapName = version === "v4"
    ? (matchData.metadata?.map?.name || "Unknown Map")
    : (matchData.metadata?.map || "Unknown Map");

  console.log(`[Henrik] Result: ${winnerTeam} | Map: ${mapName} | Score: ${team1Score}-${team2Score} | Matched: ${Object.keys(kdaMap).length}/${allPlayers.length}`);

  return {
    winnerTeam,
    kdaMap,
    mapName,
    score: `${team1Score} - ${team2Score}`,
    matchedPlayers: Object.keys(kdaMap).length,
    totalPlayers: allPlayers.length,
  };
}

// ─── Auto Timer ───────────────────────────────────────────────────────────────

function startAutoQueue(guild, channelId) {
  const gs = getGuildState(guild.id);
  if (gs.interval) clearInterval(gs.interval);
  postQueueAlert(guild, channelId);
  gs.interval = setInterval(()=>postQueueAlert(guild, channelId), 40*60*1000);
}

// ─── Bot Ready ────────────────────────────────────────────────────────────────

client.once("clientReady", async () => {
  console.log(`[Bot] Logged in as ${client.user.tag}`);
  loadStats();
  for (const [guildId] of client.guilds.cache) {
    getGuildState(guildId);
    await registerCommands(guildId);
  }
});

client.on("guildCreate", async (guild) => {
  getGuildState(guild.id);
  await registerCommands(guild.id);
});

// ─── Slash Commands ───────────────────────────────────────────────────────────

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const guildId = interaction.guildId;
  const gs = getGuildState(guildId);
  const gp = getGuildParties(guildId);
  const { commandName } = interaction;

  if (commandName === "setup") {
    gs.channelId = interaction.channelId;
    await interaction.deferReply({ ephemeral:true });
    await lockChannel(interaction.channel, interaction.guild);
    await purgeChannel(interaction.channel);
    startAutoQueue(interaction.guild, interaction.channelId);
    await interaction.editReply({ content:`✅ Queue channel set. Channel purged and locked. Auto-queue active every 40 min.\nRank range: **${gs.rankRange.min} → ${gs.rankRange.max}**` });
  }

  else if (commandName === "setupresults") {
    gs.resultsChannelId = interaction.channelId;
    await lockChannel(interaction.channel, interaction.guild);
    await interaction.reply({ content:`✅ Results channel set to ${interaction.channel}. Results and stats will post here.`, ephemeral:true });
  }

  else if (commandName === "setuproles") {
    await interaction.deferReply({ ephemeral:true });
    await lockChannel(interaction.channel, interaction.guild);
    await purgeChannel(interaction.channel);
    const embed = new EmbedBuilder()
      .setColor(0xff4655).setTitle("🏅  Select Your Rank")
      .setDescription("Pick your **current Valorant rank** from the dropdown.\nSelecting a new rank removes your old one automatically.\n\n> ⚠️ **Please select your honest rank.** Misrepresenting your rank may result in a ban from this server.")
      .setFooter({ text:"VPS Scrims • One rank per player" }).setTimestamp();
    const menu = new StringSelectMenuBuilder().setCustomId("select_rank").setPlaceholder("Choose your rank...")
      .addOptions(RANK_ORDER.map(rank=>new StringSelectMenuOptionBuilder().setLabel(rank).setValue(rank).setEmoji(RANK_EMOJIS[rank])));
    await interaction.channel.send({ embeds:[embed], components:[new ActionRowBuilder().addComponents(menu)] });
    await interaction.editReply({ content:"✅ Rank selection embed posted, channel purged and locked." });
  }

  else if (commandName === "setrange") {
    const min = interaction.options.getString("min");
    const max = interaction.options.getString("max");
    if (getRankIndex(min) > getRankIndex(max)) return interaction.reply({ content:"❌ Min rank can't be higher than max.", ephemeral:true });
    gs.rankRange = { min, max };
    await interaction.reply({ content:`✅ Rank range: **${min} → ${max}**`, ephemeral:true });
  }

  else if (commandName === "startqueue") {
    if (!gs.channelId) return interaction.reply({ content:"❌ Run `/setup` first.", ephemeral:true });
    await postQueueAlert(interaction.guild, gs.channelId);
    await interaction.reply({ content:"✅ Queue alert posted.", ephemeral:true });
  }

  else if (commandName === "stopqueue") {
    if (gs.interval) { clearInterval(gs.interval); gs.interval = null; }
    await interaction.reply({ content:"✅ Auto-queue stopped.", ephemeral:true });
  }

  else if (commandName === "cancelqueue") {
    const id = interaction.options.getString("id");
    let queue = id ? activeQueues.get(id) : [...activeQueues.values()].filter(q=>q.guildId===guildId).pop();
    if (!queue) return interaction.reply({ content:"❌ No matching queue found.", ephemeral:true });
    // Delete the queue message
    try {
      const qChannel = await interaction.guild.channels.fetch(queue.channelId).catch(()=>null);
      if (qChannel) {
        const qMsg = await qChannel.messages.fetch(queue.messageId).catch(()=>null);
        if (qMsg) await qMsg.delete().catch(()=>{});
      }
    } catch(e) {}
    await cleanupLobby(interaction.guild, queue);
    await interaction.reply({ content:"✅ Queue cancelled and message deleted.", ephemeral:true });
  }

  else if (commandName === "status") {
    const qs = [...activeQueues.values()].filter(q=>q.guildId===guildId);
    if (!qs.length) return interaction.reply({ content:"No active queues.", ephemeral:true });
    const lines = qs.map(q=>`**ID:** ${q.id} | **Phase:** ${q.phase} | **Players:** ${q.players.size}/${QUEUE_SIZE}`);
    await interaction.reply({ content:lines.join("\n"), ephemeral:true });
  }

  else if (commandName === "closelobby") {
    const queueId = lobbyChannelToQueue.get(interaction.channelId);
    if (!queueId) return interaction.reply({ content:"❌ Use this command inside a `#lobby-info` channel.", ephemeral:true });
    const queue = activeQueues.get(queueId);
    if (!queue) return interaction.reply({ content:"❌ This lobby no longer exists.", ephemeral:true });
    if (queue.phase === "voting") return interaction.reply({ content:"❌ Vote already in progress.", ephemeral:true });
    const allPlayers = [...(queue.teams?.team1||[]), ...(queue.teams?.team2||[])];
    if (!allPlayers.includes(interaction.user.id) && !interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      return interaction.reply({ content:"❌ Only players in this lobby or admins can close it.", ephemeral:true });
    }
    await interaction.reply({ content:"🗳️ Starting result vote...", ephemeral:true });
    await postVote(interaction.guild, queue);
  }

  else if (commandName === "setresult") {
    const result = interaction.options.getString("result");
    const lobbyId = interaction.options.getString("lobbyid");

    let queue;
    if (lobbyId) {
      queue = [...activeQueues.values()].find(q=>q.lobbyChannelId===lobbyId || q.id===lobbyId);
    } else {
      queue = [...activeQueues.values()].filter(q=>q.guildId===guildId && q.phase==="voting").pop()
        || [...activeQueues.values()].filter(q=>q.guildId===guildId && q.phase==="ready").pop();
    }
    if (!queue) return interaction.reply({ content:"❌ No active lobby found.", ephemeral:true });
    if (!queue.teams) return interaction.reply({ content:"❌ Teams haven't been set yet.", ephemeral:true });

    await interaction.reply({ content:`✅ Result manually set: **${result}**`, ephemeral:true });
    await postResult(interaction.guild, queue, result);
  }

  else if (commandName === "lobby") {
    const queueId = lobbyChannelToQueue.get(interaction.channelId);
    if (!queueId) return interaction.reply({ content:"❌ Use this command inside a `#lobby-info` channel.", ephemeral:true });
    const q = activeQueues.get(queueId);
    if (!q) return interaction.reply({ content:"❌ This lobby no longer exists.", ephemeral:true });

    const allPlayers = [...(q.teams?.team1||[]), ...(q.teams?.team2||[])];
    if (!allPlayers.includes(interaction.user.id)) return interaction.reply({ content:"❌ You're not in this lobby.", ephemeral:true });

    const code = interaction.options.getString("code");
    const member = await interaction.guild.members.fetch(interaction.user.id).catch(()=>null);
    const displayName = member ? member.displayName : interaction.user.username;

    if (!code) {
      if (q.lobbyLeaderId && q.lobbyLeaderId !== interaction.user.id) {
        const cur = await interaction.guild.members.fetch(q.lobbyLeaderId).catch(()=>null);
        return interaction.reply({ content:`❌ **${cur?cur.displayName:"Someone"}** is already lobby leader.`, ephemeral:true });
      }
      q.lobbyLeaderId = interaction.user.id;
      for (const vcId of [q.voiceChannels.team1Id, q.voiceChannels.team2Id]) {
        if (!vcId) continue;
        const vc = await interaction.guild.channels.fetch(vcId).catch(()=>null);
        if (vc) await vc.permissionOverwrites.edit(interaction.user.id, { ViewChannel:true, Connect:true }).catch(()=>{});
      }
      await interaction.reply({ embeds:[new EmbedBuilder().setColor(0xff4655).setTitle("👑  Lobby Leader Assigned").setDescription(`**${displayName}** is the lobby leader.\n\nYou can join **both** voice channels.\n\nSet up the custom game in Valorant, then run \`/lobby [6-character code]\` to share it here.`).setTimestamp()] });
    } else {
      if (!q.lobbyLeaderId) return interaction.reply({ content:"❌ Run `/lobby` first to claim host.", ephemeral:true });
      if (q.lobbyLeaderId !== interaction.user.id) {
        const leader = await interaction.guild.members.fetch(q.lobbyLeaderId).catch(()=>null);
        return interaction.reply({ content:`❌ Only **${leader?leader.displayName:"the lobby leader"}** can share the code.`, ephemeral:true });
      }
      if (code.length !== 6) return interaction.reply({ content:`❌ Valorant lobby codes are exactly **6 characters**. You entered **${code.length}**.`, ephemeral:true });
      if (!LOBBY_CODE_REGEX.test(code)) return interaction.reply({ content:"❌ Only letters and numbers allowed.", ephemeral:true });

      const isUpdate = !!q.lobbyCode;
      q.lobbyCode = code.toUpperCase();
      const playerMentions = allPlayers.map(id=>`<@${id}>`).join(" ");
      const embed = new EmbedBuilder()
        .setColor(0x00ff88).setTitle(isUpdate ? "🔄  Lobby Code Updated" : "🎮  Lobby Code")
        .addFields({ name:"Code", value:`\`\`\`${q.lobbyCode}\`\`\``, inline:false }, { name:"Host", value:`<@${interaction.user.id}>`, inline:true })
        .setDescription(`${playerMentions}\n\nJoin the lobby then type **\`ready\`** in this channel.`)
        .setFooter({ text:"VPS Scrims • Custom Lobby" }).setTimestamp();
      await interaction.reply({ embeds:[embed] });
    }
  }

  else if (commandName === "stats") {
    const target = interaction.options.getUser("player") || interaction.user;
    const s = getPlayerStats(guildId, target.id);
    const member = await interaction.guild.members.fetch(target.id).catch(()=>null);
    const name = member ? member.displayName : target.username;
    const winRate = s.games > 0 ? ((s.wins/s.games)*100).toFixed(1) : "0.0";
    const avgK = s.kdaGames > 0 ? (s.kills/s.kdaGames).toFixed(1) : "—";
    const avgD = s.kdaGames > 0 ? (s.deaths/s.kdaGames).toFixed(1) : "—";
    const avgA = s.kdaGames > 0 ? (s.assists/s.kdaGames).toFixed(1) : "—";
    const kdRatio = s.kdaGames > 0 && s.deaths > 0 ? (s.kills/s.deaths).toFixed(2) : "—";

    const linkedRiot = getRiotId(guildId, target.id);
    const riotLine = linkedRiot ? `**Riot ID:** ${linkedRiot}\n` : "";

    const embed = new EmbedBuilder()
      .setColor(0xff4655).setTitle(`📊  Stats — ${name}`)
      .setDescription(riotLine || null)
      .addFields(
        { name:"Record", value:`**${s.wins}W / ${s.losses}L / ${s.ties}T**`, inline:true },
        { name:"Win Rate", value:`**${winRate}%**`, inline:true },
        { name:"Games Played", value:`**${s.games}**`, inline:true },
        { name:"Avg Kills", value:`**${avgK}**`, inline:true },
        { name:"Avg Deaths", value:`**${avgD}**`, inline:true },
        { name:"Avg Assists", value:`**${avgA}**`, inline:true },
        { name:"K/D Ratio", value:`**${kdRatio}**`, inline:true },
        { name:"KDA from Screenshots", value:`**${s.kdaGames}** games`, inline:true },
      )
      .setFooter({ text:"VPS Scrims • KDA tracked from scoreboard screenshots" }).setTimestamp();

    await interaction.reply({ embeds:[embed] });
  }

  else if (commandName === "leaderboard") {
    const guildStats = allStats[guildId] || {};
    const entries = Object.entries(guildStats)
      .map(([uid, s]) => ({ uid, ...s }))
      .filter(s => s.games > 0)
      .sort((a,b) => b.wins - a.wins || (b.wins/Math.max(b.games,1)) - (a.wins/Math.max(a.games,1)))
      .slice(0, 10);

    if (!entries.length) return interaction.reply({ content:"No stats recorded yet.", ephemeral:true });

    const lines = await Promise.all(entries.map(async (s, i) => {
      const member = await interaction.guild.members.fetch(s.uid).catch(()=>null);
      const name = member ? member.displayName : "Unknown";
      const winRate = s.games > 0 ? ((s.wins/s.games)*100).toFixed(0) : 0;
      const kd = s.kdaGames > 0 && s.deaths > 0 ? (s.kills/s.deaths).toFixed(2) : "—";
      const medals = ["🥇","🥈","🥉"];
      const prefix = medals[i] || `**${i+1}.**`;
      const riot = getRiotId(guildId, s.uid);
      const riotTag = riot ? ` • ${riot}` : "";
      return `${prefix} **${name}**${riotTag} — ${s.wins}W ${s.losses}L ${s.ties}T (${winRate}%) • K/D: ${kd}`;
    }));

    const embed = new EmbedBuilder()
      .setColor(0xff4655).setTitle("🏆  VPS Scrims Leaderboard")
      .setDescription(lines.join("\n"))
      .setFooter({ text:"Ranked by wins • VPS Scrims" }).setTimestamp();

    const gs2 = getGuildState(guildId);
    if (gs2.resultsChannelId && interaction.channelId !== gs2.resultsChannelId) {
      const resultsChannel = await interaction.guild.channels.fetch(gs2.resultsChannelId).catch(()=>null);
      if (resultsChannel) await resultsChannel.send({ embeds:[embed] });
      await interaction.reply({ content:`✅ Leaderboard posted in <#${gs2.resultsChannelId}>.`, ephemeral:true });
    } else {
      await interaction.reply({ embeds:[embed] });
    }
  }

  else if (commandName === "exportstats") {
    if (!fs.existsSync(STATS_FILE)) {
      return interaction.reply({ content:"❌ No stats file found yet — no games have been completed.", ephemeral:true });
    }
    try {
      const { AttachmentBuilder } = require("discord.js");
      const attachment = new AttachmentBuilder(STATS_FILE, { name:"stats.json" });
      await interaction.user.send({ content:"📊 Here's your current VPS Scrims stats file:", files:[attachment] });
      await interaction.reply({ content:"✅ Stats file sent to your DMs.", ephemeral:true });
    } catch(e) {
      await interaction.reply({ content:"❌ Couldn't DM you — make sure your DMs are open.", ephemeral:true });
    }
  }

  else if (commandName === "purge") {
    await interaction.deferReply({ ephemeral:true });
    await purgeChannel(interaction.channel);
    await interaction.editReply({ content:"✅ Channel purged." });
  }

  else if (commandName === "forceclose") {
    const queueId = lobbyChannelToQueue.get(interaction.channelId);
    if (!queueId) return interaction.reply({ content:"❌ Use this command inside a `#lobby-info` channel.", ephemeral:true });
    const queue = activeQueues.get(queueId);
    if (!queue) return interaction.reply({ content:"❌ This lobby no longer exists.", ephemeral:true });
    await interaction.reply({ content:"🗑️ Force closing lobby...", ephemeral:true });
    await cleanupLobby(interaction.guild, queue);
  }

  else if (commandName === "link") {
    const riotId = interaction.options.getString("riotid").trim();
    const parts = riotId.split("#");
    if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) {
      return interaction.reply({ content:"❌ Invalid format. Use **Name#TAG** (e.g. `TenZ#NA1`).", ephemeral:true });
    }
    if (parts[0].length > 16 || parts[1].length > 5) {
      return interaction.reply({ content:"❌ Invalid Riot ID — name max 16 chars, tag max 5.", ephemeral:true });
    }
    const normalizedRiotId = parts[0].trim() + "#" + parts[1].trim();
    setRiotId(guildId, interaction.user.id, normalizedRiotId);
    await interaction.reply({ content:`✅ Linked **${normalizedRiotId}** to your Discord.\n\nThis will show on team embeds, results, and your stats.`, ephemeral:true });
  }

  else if (commandName === "unlink") {
    const existing = getRiotId(guildId, interaction.user.id);
    if (!existing) return interaction.reply({ content:"You don't have a Riot ID linked.", ephemeral:true });
    if (riotIds[guildId]) delete riotIds[guildId][interaction.user.id];
    saveStats();
    await interaction.reply({ content:"✅ Riot ID unlinked.", ephemeral:true });
  }

  else if (commandName === "party") {
    const target = interaction.options.getUser("teammate");
    const inviterId = interaction.user.id;
    const targetId = target.id;
    if (inviterId === targetId) return interaction.reply({ content:"❌ You can't party with yourself.", ephemeral:true });
    const inviteKey = `${inviterId}-${targetId}`;
    if (pendingInvites.has(inviteKey)) return interaction.reply({ content:"❌ Pending invite already exists.", ephemeral:true });
    const targetUser = await client.users.fetch(targetId).catch(()=>null);
    if (!targetUser) return interaction.reply({ content:"❌ Couldn't find that user.", ephemeral:true });
    const inviterMember = await interaction.guild.members.fetch(inviterId).catch(()=>null);
    const inviterName = inviterMember ? inviterMember.displayName : interaction.user.username;
    const dmEmbed = new EmbedBuilder().setColor(0xff4655).setTitle("🤝  Party Invite").setDescription(`**${inviterName}** invited you to party up in **${interaction.guild.name}**.\n\nYou'll be on the same team.\n\nExpires in **60 seconds**.`).setTimestamp();
    const dmRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`party_accept-${inviteKey}`).setLabel("Accept").setStyle(ButtonStyle.Success).setEmoji("✅"),
      new ButtonBuilder().setCustomId(`party_decline-${inviteKey}`).setLabel("Decline").setStyle(ButtonStyle.Danger).setEmoji("❌")
    );
    let dmSent = false;
    try { await targetUser.send({ embeds:[dmEmbed], components:[dmRow] }); dmSent = true; } catch(e) {}
    if (!dmSent) return interaction.reply({ content:`❌ Couldn't DM <@${targetId}>. They may have DMs disabled.`, ephemeral:true });
    pendingInvites.set(inviteKey, { inviterId, targetId, guildId, inviterName, expiresAt:Date.now()+INVITE_TIMEOUT_MS });
    setTimeout(()=>pendingInvites.delete(inviteKey), INVITE_TIMEOUT_MS);
    await interaction.reply({ content:`📨 Party invite sent to <@${targetId}>! They have 60 seconds to accept.`, ephemeral:true });
  }

  else if (commandName === "leaveparty") {
    const userId = interaction.user.id;
    const wasLeader = gp.parties.has(userId) && (gp.parties.get(userId)||[]).length > 0;
    const wasMember = gp.partyOf.has(userId);
    if (!wasLeader && !wasMember) return interaction.reply({ content:"You're not in a party.", ephemeral:true });
    removeFromParty(userId, gp.parties, gp.partyOf);
    await interaction.reply({ content:wasLeader ? "✅ Party disbanded." : "✅ Left your party.", ephemeral:true });
  }

  else if (commandName === "partystatus") {
    const userId = interaction.user.id;
    const leader = gp.partyOf.get(userId);
    const members = gp.parties.get(userId) || [];
    if (leader) {
      const m = await interaction.guild.members.fetch(leader).catch(()=>null);
      await interaction.reply({ content:`🤝 You're in a party led by **${m?m.displayName:"Unknown"}**.`, ephemeral:true });
    } else if (members.length > 0) {
      const names = await Promise.all(members.map(async id=>{ const m=await interaction.guild.members.fetch(id).catch(()=>null); return m?m.displayName:"Unknown"; }));
      await interaction.reply({ content:`🤝 You're leading a party with: **${names.join(", ")}**`, ephemeral:true });
    } else {
      await interaction.reply({ content:"You're not in a party.", ephemeral:true });
    }
  }
});

// ─── Button Interactions ──────────────────────────────────────────────────────

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;
  const guildId = interaction.guildId;
  const gs = getGuildState(guildId);
  const gp = getGuildParties(guildId);

  // ── Party DM buttons ──
  if (interaction.customId.startsWith("party_accept-") || interaction.customId.startsWith("party_decline-")) {
    const isAccept = interaction.customId.startsWith("party_accept-");
    const inviteKey = interaction.customId.replace("party_accept-","").replace("party_decline-","");
    const invite = pendingInvites.get(inviteKey);
    if (!invite) return interaction.update({ embeds:[new EmbedBuilder().setColor(0x888888).setDescription("❌ This invite has expired.")], components:[] });
    pendingInvites.delete(inviteKey);
    if (!isAccept) {
      await interaction.update({ embeds:[new EmbedBuilder().setColor(0xff4655).setDescription(`❌ You declined the party invite from **${invite.inviterName}**.`)], components:[] });
      const inviterUser = await client.users.fetch(invite.inviterId).catch(()=>null);
      if (inviterUser) await inviterUser.send("❌ Your party invite was declined.").catch(()=>{});
      return;
    }
    const gp2 = getGuildParties(invite.guildId);
    removeFromParty(invite.inviterId, gp2.parties, gp2.partyOf);
    removeFromParty(invite.targetId, gp2.parties, gp2.partyOf);
    if (!gp2.parties.has(invite.inviterId)) gp2.parties.set(invite.inviterId, []);
    gp2.parties.get(invite.inviterId).push(invite.targetId);
    gp2.partyOf.set(invite.targetId, invite.inviterId);
    await interaction.update({ embeds:[new EmbedBuilder().setColor(0x00ff88).setDescription(`✅ You accepted the party invite from **${invite.inviterName}**!`)], components:[] });
    const inviterUser = await client.users.fetch(invite.inviterId).catch(()=>null);
    if (inviterUser) { const tu=await client.users.fetch(invite.targetId).catch(()=>null); await inviterUser.send(`✅ **${tu?tu.username:"Your teammate"}** accepted your party invite!`).catch(()=>{}); }
    return;
  }

  // ── Vote buttons ──
  if (interaction.customId.startsWith("vote_")) {
    const parts = interaction.customId.split("_"); // ["vote","team1","queueId"] or ["vote","team2","queueId"] or ["vote","tie","queueId"]
    const voteType = parts[1]; // "team1", "team2", "tie"
    const queueId = parts.slice(2).join("_");
    const queue = activeQueues.get(queueId);

    if (!queue || queue.voteClosed) {
      return interaction.reply({ content:"❌ This vote is no longer active.", ephemeral:true });
    }

    const allPlayers = [...queue.teams.team1, ...queue.teams.team2];
    if (!allPlayers.includes(interaction.user.id)) {
      return interaction.reply({ content:"❌ Only players in this lobby can vote.", ephemeral:true });
    }
    if (queue.votes.has(interaction.user.id)) {
      const prev = queue.votes.get(interaction.user.id);
      if (prev === voteType) return interaction.reply({ content:"You already voted for this option.", ephemeral:true });
      queue.votes.set(interaction.user.id, voteType);
      await interaction.reply({ content:`✅ Vote changed to **${voteType === "tie" ? "Tie" : voteType === "team1" ? "Team 1 Won" : "Team 2 Won"}**.`, ephemeral:true });
    } else {
      queue.votes.set(interaction.user.id, voteType);
      await interaction.reply({ content:`✅ Vote cast: **${voteType === "tie" ? "Tie" : voteType === "team1" ? "Team 1 Won" : "Team 2 Won"}**.`, ephemeral:true });
    }

    // Count votes
    const counts = { team1:0, team2:0, tie:0 };
    for (const v of queue.votes.values()) counts[v]++;

    // Update vote embed
    const lobbyChannel = await client.channels.fetch(queue.lobbyChannelId).catch(()=>null);
    if (lobbyChannel) {
      const embed = new EmbedBuilder()
        .setColor(0xff4655).setTitle("🗳️  Who Won?")
        .setDescription(`Vote for the result. First option to reach **${VOTES_NEEDED} votes** wins.\n\n🔴 Team 1 Won: **${counts.team1}** votes\n🔵 Team 2 Won: **${counts.team2}** votes\n🤝 Tie: **${counts.tie}** votes\n\n*${allPlayers.length - queue.votes.size} players haven't voted yet.*`)
        .setFooter({ text:`${VOTES_NEEDED}/${QUEUE_SIZE} votes needed` }).setTimestamp();

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`vote_team1_${queue.id}`).setLabel(`🔴 Team 1 Won (${counts.team1})`).setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`vote_team2_${queue.id}`).setLabel(`🔵 Team 2 Won (${counts.team2})`).setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`vote_tie_${queue.id}`).setLabel(`🤝 Tie (${counts.tie})`).setStyle(ButtonStyle.Secondary)
      );

      // Edit the vote message
      try {
        const messages = await lobbyChannel.messages.fetch({ limit:20 });
        const voteMsg = messages.find(m=>m.author.id===client.user.id && m.components.length > 0 && m.components[0].components[0]?.customId?.startsWith("vote_"));
        if (voteMsg) await voteMsg.edit({ embeds:[embed], components:[row] });
      } catch(e) {}
    }

    // Check if any option reached threshold
    for (const [option, count] of Object.entries(counts)) {
      if (count >= VOTES_NEEDED) {
        const guild = client.guilds.cache.get(queue.guildId);
        if (guild) await postResult(guild, queue, option);
        break;
      }
    }
    return;
  }

  // ── Queue buttons ──
  const queue = activeQueues.get(interaction.message.id);
  if (!queue) return interaction.reply({ content:"❌ This queue is no longer active.", ephemeral:true });

  if (interaction.customId === "join_queue") {
    if (queue.phase !== "queue") return interaction.reply({ content:"❌ Queue closed.", ephemeral:true });
    if (queue.players.size >= QUEUE_SIZE) return interaction.reply({ content:"❌ Queue is full.", ephemeral:true });
    if (queue.players.has(interaction.user.id)) return interaction.reply({ content:"You're already in the queue.", ephemeral:true });

    const member = await interaction.guild.members.fetch(interaction.user.id).catch(()=>null);
    if (!member) return interaction.reply({ content:"❌ Couldn't verify your roles.", ephemeral:true });
    if (!memberMeetsRankRequirement(member, gs.rankRange)) {
      return interaction.reply({ content:`❌ Your rank doesn't meet the requirement.\nRequired: **${gs.rankRange.min} → ${gs.rankRange.max}**`, ephemeral:true });
    }

    const userId = interaction.user.id;
    queue.players.add(userId);
    queue.playerRanks.set(userId, getMemberRank(member));

    const partyMembers = gp.parties.get(userId) || [];
    if (partyMembers.length > 0) {
      if (!queue.parties.has(userId)) queue.parties.set(userId, []);
      for (const memberId of partyMembers) {
        if (queue.players.size >= QUEUE_SIZE || queue.players.has(memberId)) continue;
        const pm = await interaction.guild.members.fetch(memberId).catch(()=>null);
        if (!pm || !memberMeetsRankRequirement(pm, gs.rankRange)) continue;
        queue.players.add(memberId);
        queue.playerRanks.set(memberId, getMemberRank(pm));
        queue.parties.get(userId).push(memberId);
        queue.partyOf.set(memberId, userId);
      }
    }

    await interaction.deferUpdate();
    await updateQueueEmbed(interaction.guild, queue);

    if (queue.players.size >= QUEUE_SIZE) {
      queue.phase = "teams";
      queue.teams = splitTeamsByRank(queue.players, queue.playerRanks, queue.parties, queue.partyOf);
      await postTeams(interaction.guild, queue);
    }
  }

  else if (interaction.customId === "leave_queue") {
    if (queue.phase !== "queue") return interaction.reply({ content:"❌ Queue already closed.", ephemeral:true });
    if (!queue.players.has(interaction.user.id)) return interaction.reply({ content:"You're not in the queue.", ephemeral:true });
    queue.players.delete(interaction.user.id);
    queue.playerRanks.delete(interaction.user.id);
    for (const m of (queue.parties.get(interaction.user.id)||[])) { queue.players.delete(m); queue.playerRanks.delete(m); }
    await interaction.deferUpdate();
    await updateQueueEmbed(interaction.guild, queue);
  }
});

// ─── Select Menu (rank) ───────────────────────────────────────────────────────

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isStringSelectMenu() || interaction.customId !== "select_rank") return;
  const selectedRank = interaction.values[0];
  const member = await interaction.guild.members.fetch(interaction.user.id).catch(()=>null);
  if (!member) return interaction.reply({ content:"❌ Couldn't fetch your data.", ephemeral:true });
  const toRemove = member.roles.cache.filter(r=>RANK_ORDER.includes(r.name));
  if (toRemove.size > 0) await member.roles.remove(toRemove).catch(()=>{});
  let role = interaction.guild.roles.cache.find(r=>r.name===selectedRank);
  if (!role) role = await interaction.guild.roles.create({ name:selectedRank, color:RANK_COLORS[selectedRank]||0x99aab5, reason:"VPS Scrims rank role" }).catch(()=>null);
  if (!role) return interaction.reply({ content:"❌ Failed to assign role.", ephemeral:true });
  await member.roles.add(role).catch(()=>{});
  await interaction.reply({ content:`✅ You've been assigned the **${RANK_EMOJIS[selectedRank]} ${selectedRank}** role.`, ephemeral:true });
});

// ─── Messages (ready check + tracker link + screenshot fallback) ─────────────

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;

  const queueId = lobbyChannelToQueue.get(message.channelId);
  if (!queueId) return;
  const queue = activeQueues.get(queueId);
  if (!queue) return;

  // Ready check
  if (message.content.trim().toLowerCase() === "ready") {
    await handleReadyCheck(message, queue);
    return;
  }

  // ── Option 1: Tracker.gg link → Henrik API ──
  if (queue.phase === "ready" || queue.phase === "voting") {
    const trackerMatch = message.content.match(TRACKER_REGEX);
    if (trackerMatch) {
      const allPlayers = [...(queue.teams?.team1||[]), ...(queue.teams?.team2||[])];
      if (!allPlayers.includes(message.author.id)) return;
      if (queue.voteClosed) {
        await message.reply("This lobby result has already been confirmed.").catch(()=>{});
        return;
      }

      const matchId = trackerMatch[1];
      const processing = await message.reply("🔍 Fetching match data from Henrik API...").catch(()=>null);
      const matchData = await fetchMatchFromHenrik(matchId);

      if (!matchData) {
        if (processing) await processing.edit([
          "⚠️ Could not fetch match data — Henrik API may be down or the match is not indexed yet.",
          "Falling back to manual vote. Use `/closelobby` to start the vote.",
        ].join("\n\n")).catch(()=>{});
        return;
      }

      const result = await processHenrikMatch(matchData, queue, message.guild);

      if (!result || result.matchedPlayers < 2) {
        const linked = result ? result.matchedPlayers : 0;
        if (processing) await processing.edit([
          `⚠️ Only **${linked}** players have a linked Riot ID — need at least 2 to auto-detect the result.`,
          "Ask players to run `/link RiotName#TAG` and try again, or use `/closelobby` for a manual vote.",
        ].join("\n\n")).catch(()=>{});
        return;
      }

      queue.kdaMap = result.kdaMap;

      const buildLines = async (ids) => Promise.all(ids.map(async id => {
        const m = await message.guild.members.fetch(id).catch(()=>null);
        const name = m ? m.displayName : "Unknown";
        const kda = result.kdaMap[id];
        const agent = kda && kda.agent ? ` (${kda.agent})` : "";
        const riot = getRiotId(message.guild.id, id);
        const riotTag = riot ? ` | ${riot}` : "";
        if (!kda) return `**${name}**${riotTag} — no data`;
        return `**${name}**${agent}${riotTag}\n${kda.k}/${kda.d}/${kda.a} • ACS: ${kda.acs}`;
      }));

      const [t1Lines, t2Lines] = await Promise.all([
        buildLines(queue.teams.team1),
        buildLines(queue.teams.team2),
      ]);

      const resultColors = { team1:0xff4655, team2:0x5865f2, tie:0x99aab5 };
      const resultLabels = { team1:"🔴 Team 1 Won", team2:"🔵 Team 2 Won", tie:"🤝 Tie" };

      const previewEmbed = new EmbedBuilder()
        .setColor(resultColors[result.winnerTeam])
        .setTitle(`⚔️ Match Result — ${resultLabels[result.winnerTeam]}`)
        .setDescription(`**Map:** ${result.mapName} • **Score:** ${result.score}\n**Matched:** ${result.matchedPlayers}/${result.totalPlayers} players via Riot ID`)
        .addFields(
          { name:"🔴  Team 1", value:t1Lines.join("\n\n")||"—", inline:true },
          { name:"🔵  Team 2", value:t2Lines.join("\n\n")||"—", inline:true }
        )
        .setFooter({ text:"Auto-detected via Henrik API • tracker.gg" })
        .setTimestamp();

      if (processing) await processing.edit({ content:"✅ Match found! Posting result...", embeds:[previewEmbed] }).catch(()=>{});
      await postResult(message.guild, queue, result.winnerTeam);
      return;
    }
  }

  // ── Option 2: Screenshot fallback (AI parsing) ──
  if ((queue.phase === "ready" || queue.phase === "voting") && message.attachments.size > 0) {
    const imageAttachment = message.attachments.find(a => a.contentType && a.contentType.startsWith("image/"));
    if (!imageAttachment) return;

    const allPlayers = [...(queue.teams?.team1||[]), ...(queue.teams?.team2||[])];
    if (!allPlayers.includes(message.author.id)) return;

    if (queue.screenshotProcessed) {
      await message.reply("A screenshot has already been processed. Paste a tracker.gg link for best results.").catch(()=>{});
      return;
    }

    queue.screenshotProcessed = true;
    queue.screenshotUrl = imageAttachment.url;

    const processing = await message.reply("🔍 Reading scoreboard via AI... (tip: paste your tracker.gg match link for better accuracy)").catch(()=>null);
    const parsed = await parseScreenshot(imageAttachment.url, queue, message.guild);

    if (!parsed || Object.keys(parsed.kdaMap).length === 0) {
      queue.screenshotProcessed = false;
      if (processing) await processing.edit("❌ Could not read the scoreboard. Try again or paste a tracker.gg link instead.").catch(()=>{});
      return;
    }

    queue.kdaMap = parsed.kdaMap;

    const buildLines2 = async (ids) => Promise.all(ids.map(async id => {
      const m = await message.guild.members.fetch(id).catch(()=>null);
      const name = m ? m.displayName : "Unknown";
      const kda = parsed.kdaMap[id];
      const agent = kda && kda.agent ? ` (${kda.agent})` : "";
      if (!kda) return `**${name}** — not found`;
      return `**${name}**${agent} — ${kda.k}/${kda.d}/${kda.a}${kda.acs ? ` • ACS: ${kda.acs}` : ""}`;
    }));

    const [t1Lines2, t2Lines2] = await Promise.all([buildLines2(queue.teams?.team1||[]), buildLines2(queue.teams?.team2||[])]);

    const scoreboardEmbed = new EmbedBuilder()
      .setColor(0x00b4ff).setTitle("📊 Scoreboard Read (AI)")
      .addFields(
        { name:"🔴  Team 1", value:t1Lines2.join("\n")||"—", inline:true },
        { name:"🔵  Team 2", value:t2Lines2.join("\n")||"—", inline:true }
      )
      .setFooter({ text:"KDA saved — use /closelobby to confirm the result" }).setTimestamp();

    if (processing) await processing.edit({ content:"✅ Scoreboard read! Use `/closelobby` to confirm the result.", embeds:[scoreboardEmbed] }).catch(()=>{});
  }
});

// ─── Login ────────────────────────────────────────────────────────────────────

client.login(process.env.DISCORD_TOKEN);