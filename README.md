# VPS Scrims Bot

A Discord bot that automates Valorant 10-man custom scrims — queue alerts, rank gating, balanced team splitting, party system, voice channels, and ready-check.

---

## Features

- ⏰ Auto-queue alert every 40 minutes
- 🎮 Button-based join/leave
- 🏅 Rank gating — only players with the correct rank role can join
- ⚖️ Rank-balanced team split using snake draft (parties respected)
- 🤝 Party system — link with a friend to guarantee same-team placement
- 🔊 Auto-creates 2 voice channels (Team 1 / Team 2) when queue fills
- ✅ Ready-check: type `ready` in chat, game starts when all 10 are ready
- 🧹 Auto-cleans up voice channels 5 minutes after game starts

---

## Setup

### 1. Create a Discord Application

1. Go to https://discord.com/developers/applications
2. Click **New Application** → give it a name
3. Go to **Bot** tab → click **Add Bot**
4. Copy the **Token** (keep this secret — never share or commit it)
5. Go to **General Information** → copy the **Application ID** (your Client ID)
6. Under **Bot** → enable these **Privileged Gateway Intents**:
   - Server Members Intent
   - Message Content Intent

### 2. Invite the Bot to Your Server

Build this URL and open it in your browser (replace `YOUR_CLIENT_ID`):
```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=8&scope=bot%20applications.commands
```

### 3. Install Dependencies

```bash
cd VPSscrims
npm install
```

### 4. Configure Environment

Create a file called `env` in the project root (no dot prefix):
```
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_client_id_here
```

> ⚠️ Never upload this file to GitHub. Make sure `env` is listed in your `.gitignore`.

### 5. Run

```bash
npm start
```

You should see `[Bot] Logged in as VPS | Scrim Bot#xxxx` in the terminal.

---

## Commands

| Command | Who | Description |
|---|---|---|
| `/setup` | Admin | Sets current channel as queue channel, starts 40-min auto-timer |
| `/setrange min max` | Admin | Set the allowed rank range for the queue (e.g. Diamond → Radiant) |
| `/startqueue` | Admin | Manually post a queue alert right now |
| `/stopqueue` | Admin | Pause the auto-timer |
| `/cancelqueue` | Admin | Cancel active queue and clean up voice channels |
| `/party @user` | Anyone | Link with a friend to be placed on the same team |
| `/leaveparty` | Anyone | Leave or disband your current party |
| `/status` | Anyone | Show current queue phase, player count, and rank range |

---

## How It Works

1. Admin runs `/setup` in the desired channel
2. Every 40 minutes the bot posts a queue embed with Join/Leave buttons
3. Players click **Join Queue** — rank role is checked automatically
4. Party members are pulled in together when the party leader joins
5. When 10 players join, the bot splits into 2 rank-balanced teams of 5
6. Two voice channels are created: `🔴 Team 1` and `🔵 Team 2`
7. Host creates the custom lobby in Valorant and posts the **lobby code + password** in chat
8. Each player types `ready` when they're in the lobby
9. When all 10 are ready, the bot sends the start signal
10. Voice channels auto-delete 5 minutes later

---

## Rank System

### Required Discord Roles

Create roles in your server with these **exact names** (case-sensitive):

`Iron` `Bronze` `Silver` `Gold` `Platinum` `Diamond` `Ascendant` `Immortal` `Radiant`

Assign them to members manually or use a verification bot like **Blaze** to auto-assign based on Valorant accounts.

### Team Balancing

Teams are split using a snake draft sorted by rank:
- Players/parties are ranked highest to lowest
- Group 1 → Team 1, Group 2 → Team 2, Group 3 → Team 1, and so on
- Parties are kept together using their average rank for draft position
- Each team embed shows the average rank so you can see the balance

### Setting Rank Range

Use `/setrange` to restrict who can join. Example:
```
/setrange min:Diamond max:Radiant
```
Players without a rank role in that range will be blocked and told the requirement.

---

## Party System

- Use `/party @friend` before or during an active queue
- When the party leader clicks Join Queue, all party members are added automatically
- Party members that don't meet the rank requirement are skipped individually
- Use `/leaveparty` to leave, or if you're the leader it disbands the whole party

---

## Hosting (24/7)

To keep the bot online without leaving your computer on, deploy to **Railway**:

1. Push your project to GitHub (make sure `env` and `node_modules/` are in `.gitignore`)
2. Go to https://railway.app and sign up with GitHub
3. Click **New Project → Deploy from GitHub repo** → select your repo
4. Go to the **Variables** tab and add:
   - `DISCORD_TOKEN` = your bot token
   - `CLIENT_ID` = your client ID
5. Railway auto-detects Node.js and runs `npm start` — bot goes live

Other options: **Render** (free tier), **DigitalOcean** or **Hetzner** (VPS, most reliable).

---

## Notes on In-Game Automation

Riot does not provide an official API for creating lobbies, inviting players, or starting games. The bot handles everything up to lobby creation — the host sets up the custom game manually and shares the code in Discord. This is the standard for all community 10-man tools.
