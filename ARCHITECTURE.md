# Architecture & design decisions (assignment walkthrough)

This document maps the PDF requirements to the concrete implementation in this repo.

## 1) Server-authoritative game logic (anti-cheat)

**Goal:** The server is the source of truth; clients cannot cheat by modifying local state.

**Implementation:**

- The authoritative match lives in `backend/nakama/index.js` (single-file Nakama JS module).
- The match state contains the board, players, turn, timers, and status.
- Clients can only send **intent** (“I want to place my mark at position N”).
- The server validates the intent, updates state, and broadcasts the new state.

**Move validation rules (server-side):**

- Sender must be one of the two players in the match.
- Sender’s symbol must match the match’s `turn`.
- `position` must be an integer 0–8.
- The chosen cell must be empty.
- The match must be in `playing` status.

If validation fails, the server sends an error message (`opCode=101`) back to that client only.

## 2) Real-time game state updates

**Goal:** Both clients see the same state immediately.

**Implementation:**

- On every accepted move, the server broadcasts the full public state to all connected presences.
- Broadcast uses `opCode=100` (STATE).
- The frontend listens to `socket.onmatchdata` and updates the React UI.

## 3) Matchmaking system (create rooms, auto-pair, discovery)

### 3.1 Create new game rooms

**Implementation:**

- RPC `create_match` in `backend/nakama/index.js` calls `nk.matchCreate("tictactoe", { mode })`.
- The frontend calls `client.rpc(session, "create_match", { mode })` and then `socket.joinMatch(matchId)`.

### 3.2 Automatic matchmaking (quick play)

**Implementation:**

- The frontend calls `socket.addMatchmaker(...)` with string properties:
  - `game=tictactoe`
  - `mode=classic|timed`
- The server hook `matchmakerMatched` lives in `backend/nakama/index.js` and creates a new authoritative match and returns its `matchId`.
- The frontend receives `socket.onmatchmakermatched`, then joins that match.

### 3.3 Room discovery and joining

**Implementation:**

- The match sets a JSON label like:
  - `{ "game": "tictactoe", "mode": "classic", "open": true, "status": "waiting" }`
- The frontend uses Nakama’s match listing API with a query that filters:
  - the game name
  - the selected mode
  - `open:true` (waiting for a second player)

This enables “lobby style” discovery without custom database tables.

## 4) Connections, disconnections, and recovery

**Goal:** Handle real-world network issues.

**Implementation:**

- If a player leaves while the match is `playing`, the match enters `reconnect` status.
- A grace timer starts (30 seconds).
- If the disconnected player doesn’t return in time, the remaining player wins by forfeit.

## 5) Concurrent game support

**Goal:** Multiple games can run simultaneously without state collision.

**Implementation:**

- Each game is a separate Nakama authoritative match instance.
- State lives in-memory inside each match handler instance; isolation is guaranteed by Nakama.

## 6) Timer-based game mode (bonus)

**Goal:** Each player must move within a time limit.

**Implementation:**

- In `timed` mode, each turn sets a `turnDeadlineMs` (now + 30s).
- The match loop checks deadlines; if expired, the current player forfeits and the other wins.
- The public state includes `turnRemainingMs` so the UI can render a countdown.

## 7) Leaderboard + persistent stats (bonus)

**Persistent stats**

- Stored per-user in Nakama storage (`collection=tictactoe`, `key=stats`).
- Updated when a match finishes (win/loss/draw + streak).
- Exposed via RPC `my_stats`.

**Leaderboard**

- Uses a Nakama leaderboard `tictactoe_wins` (total wins).
- Updated when the winner’s stats change.
- Exposed to the frontend via RPC `top_wins` (returns `nk.leaderboardRecordsList` output).

## 8) Files to review for grading

- Runtime module entrypoint: `backend/nakama/index.js`
- Frontend Nakama wiring: `frontend/src/nakama.js`
- UI flows: `frontend/src/App.jsx`
