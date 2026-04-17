# Multiplayer Tic-Tac-Toe (Nakama)

This project implements a **server-authoritative**, **real-time multiplayer Tic‑Tac‑Toe** game using **Nakama** for backend infrastructure and a **React (Vite) web app** frontend (plain JavaScript).

It covers the assignment requirements:

- Server-authoritative game state and validation (no client-side cheating)
- Real-time state broadcasting to connected clients
- Matchmaking (quick play), room creation, room discovery + joining
- Graceful disconnect handling
- Optional/bonus: **timed turns** + **leaderboard/stats**

## Repo layout

- `backend/nakama/` — Nakama JavaScript runtime module (`index.js`, server-authoritative logic)
- `frontend/` — React web app
- `docker-compose.yml` — local production-like stack (Postgres + Nakama)

## Quick start (local)

Prereqs:

- Node.js 18+ (or 20+)
- Docker + Docker Compose

### 1) Start Postgres + Nakama

From the repo root:

```bash
docker compose up -d --build
```

Nakama ports:

- gRPC: `127.0.0.1:7349`
- Game API: `http://127.0.0.1:7350`
- Console: `http://127.0.0.1:7351`

### 2) Start the frontend

```bash
cd frontend
npm install
cp .env.example .env
npm run dev
```

Open the web app (Vite will print the URL, typically `http://127.0.0.1:5173`).

## How the solution maps to the assignment

### Server-authoritative game logic

All game state exists **only** on the server in a Nakama **authoritative match**:

- Clients send move requests (`opCode=1`).
- The server validates:
  - it is the sender’s turn
  - the chosen cell is in range and empty
  - the match is still in progress
- The server applies the move, checks for win/draw, then broadcasts the updated state (`opCode=100`).

The frontend never “decides” the game result; it only renders the last authoritative state.

### Matchmaking + room discovery

You get two ways to start playing:

1. **Quick Match**: uses Nakama matchmaker; the server creates a match when two players are paired.
2. **Create Room + Join Room**:
   - Create a new authoritative match via RPC (`create_match`).
   - Rooms are discoverable via Nakama match listing (labels include game + mode + open/closed).

### Disconnect handling

If a player disconnects mid-game, the match:

- enters a reconnect grace state
- if the player doesn’t return within the grace period, the remaining player wins by forfeit

### Timed mode (bonus)

In “Timed” mode, each turn has a deadline (default 30s). If the current player does not move in time, they forfeit.

### Leaderboard + stats (bonus)

On match end, the server updates:

- per-user persistent stats (wins/losses/draws/streak)
- a Nakama leaderboard (total wins)

The frontend can display your stats and a “Top Players” leaderboard view.

## Server API reference (what the frontend uses)

### RPCs

- `create_match` → `{ mode: "classic" | "timed" }` → `{ matchId }`
- `my_stats` → returns your persisted stats
- `top_wins` → `{ limit?: number }` → returns leaderboard records payload

### Match opCodes

- `1` (MOVE) — client → server: `{ position: number }`
- `100` (STATE) — server → clients: full public match state (board, players, turn, timers, status)
- `101` (ERROR) — server → a single client: `{ message }`

## How to test multiplayer locally

1. Open the frontend in two different browser profiles (or incognito + normal).
2. Use **Quick Match** (classic or timed).
3. Make moves from both windows and confirm:
   - only the active player can move
   - state updates appear instantly in the other window
   - invalid moves are rejected (cell already taken, wrong turn)

For a detailed requirement-by-requirement walkthrough, see `ARCHITECTURE.md`.

## Deploy on Render (free)

This repo includes a Render Blueprint in `render.yaml` that deploys:

- Render Postgres (`ttt-postgres`)
- Nakama backend (`ttt-nakama`) as a Docker web service
- React frontend (`ttt-frontend`) as a static site

### Steps

1. Commit + push these files to GitHub:
   - `render.yaml`
   - `backend/Dockerfile.render-nakama`
   - `backend/render/nakama-entrypoint.sh`

2. In Render Dashboard:
   - Go to **Blueprints** → **New Blueprint Instance**
   - Select your GitHub repo
   - Click **Apply**

3. Wait for deploys to finish. Then:
   - Open `ttt-frontend` URL (static site)
   - Multiplayer test: open that URL in normal + incognito windows, login with two names, quick match, play.

4. Github repo link : https://github.com/lakhoreJanvi/tic-tac-toe-game

5. Deployed link : https://ttt-frontend-imw9.onrender.com/

### Notes

- Render free web services can sleep when idle, which can disconnect realtime sessions.
- The Blueprint does **not** hardcode the backend hostname. It pulls `RENDER_EXTERNAL_HOSTNAME` from the `ttt-nakama` service into the static site's `VITE_NAKAMA_HOST` at build time.
