# Valorant 10-Man Bot

A Discord bot that automates Valorant custom lobby 10-mans — queue alerts, team splitting, party system, voice channels, and ready-check.

## Features

- ⏰ Auto-queue alert every 40 minutes
- 🎮 Button-based join/leave
- 🤝 Party system — link with a friend to guarantee same-team placement
- ⚔️ Smart team split that respects parties
- 🔊 Auto-creates 2 voice channels (Team 1 / Team 2) when queue fills
- ✅ Ready-check: type `ready` in chat, game starts when all 10 are ready
- 🧹 Auto-cleans up voice channels after game starts

---

## Setup

### 1. Create a Discord Application

1. Go to https://discord.com/developers/applications
2. Click **New Application** → give it a name
3. Go to **Bot** tab → click **Add Bot**
4. Copy the **Token** (keep this secret!)
5. Go to **General Information** → copy the **Application ID** (this is your Client ID)
6. Under **Bot** → enable these **Privileged Gateway Intents**:
   - Server Members Intent
   - Message Content Intent

### 2. Invite the Bot to Your Server

Build this URL (replace `YOUR_CLIENT_ID`):
```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=8&scope=bot%20applications.commands
```
Permission `8` = Administrator (simplest for setup; you can tighten this later).

### 3. Install & Configure

```bash
# Clone / copy the project
cd valorant-10man-bot

# Install dependencies
npm install

# Set up environment
cp .env.example .env
# Edit .env and fill in your DISCORD_TOKEN and CLIENT_ID
```

### 4. Run

```bash
npm start

# Or for development with auto-restart:
npm run dev
```

---

## Commands

| Command | Who | Description |
|---|---|---|
| `/setup` | Admin | Sets current channel as queue channel, starts 40-min auto-timer |
| `/startqueue` | Admin | Manually post a queue alert right now |
| `/stopqueue` | Admin | Pause the auto-timer |
| `/cancelqueue` | Admin | Cancel active queue and clean up voice channels |
| `/party @user` | Anyone | Link with a friend to be placed on the same team |
| `/leaveparty` | Anyone | Leave your current party |
| `/status` | Anyone | Show current queue phase and player count |

---

## How It Works

1. Admin runs `/setup` in the desired channel
2. Every 40 minutes, the bot posts a queue embed with Join/Leave buttons
3. Players click **Join Queue** (parties are auto-added together)
4. When 10 players join, bot splits into 2 teams of 5 (respecting parties)
5. Bot creates `🔴 Team 1` and `🔵 Team 2` voice channels
6. Host sets up the custom lobby in Valorant and posts the code in chat
7. Each player types `ready` when they're in the lobby
8. When all 10 are ready, bot sends the start signal
9. Voice channels auto-delete 5 minutes later

---

## Party System

- Use `/party @friend` before or during a queue
- When you click Join Queue, your party members are also added automatically
- The team-split algorithm keeps party members together
- Parties of 3+ are supported but may cause slight imbalance (the algorithm does best-effort)
- Use `/leaveparty` to leave

---

## Notes on In-Game Automation

Riot does not provide an official API for creating lobbies, inviting players, or starting games. The bot therefore handles everything up to the point of lobby creation — the host creates the custom game manually and shares the code. This is the standard approach for all community 10-man tools.

---

## Hosting

To keep the bot online 24/7, host it on:
- **Railway** (free tier works, easy deploy)
- **Render** (free tier, slight cold starts)
- **VPS** (DigitalOcean, Hetzner — most reliable)
- **Your own machine** (fine for a friend group)
