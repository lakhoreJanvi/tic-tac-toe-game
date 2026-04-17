// Nakama JavaScript runtime module (NOT Node.js).
// Do not use require/module.exports here.

var OPCODE_MOVE = 1;
var OPCODE_STATE = 100;
var OPCODE_ERROR = 101;

var TICK_RATE = 10;
var RECONNECT_GRACE_MS = 30000;
var TIMED_TURN_MS = 30000;

var WIN_LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6]
];

function createEmptyBoard() {
  return [0, 0, 0, 0, 0, 0, 0, 0, 0];
}

function applyMove(board, position, symbol) {
  if (position !== (position | 0) || position < 0 || position > 8) throw Error("Invalid position.");
  if (board[position] !== 0) throw Error("Cell already taken.");
  var next = board.slice(0);
  next[position] = symbol;
  return next;
}

function getWinner(board) {
  for (var i = 0; i < WIN_LINES.length; i++) {
    var a = WIN_LINES[i][0];
    var b = WIN_LINES[i][1];
    var c = WIN_LINES[i][2];
    var v = board[a];
    if (v !== 0 && v === board[b] && v === board[c]) return v;
  }
  return 0;
}

function isDraw(board) {
  if (getWinner(board) !== 0) return false;
  for (var i = 0; i < board.length; i++) if (board[i] === 0) return false;
  return true;
}

function encodeJson(v) {
  return JSON.stringify(v);
}

function uint8ToString(data) {
  var out = "";
  for (var i = 0; i < data.length; i++) out += String.fromCharCode(data[i]);
  return out;
}

function base64ToUint8Array(b64) {
  // Standard base64 (not URL-safe). Good enough for Nakama JS clients.
  var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  var clean = String(b64).replace(/[\r\n\s]/g, "");
  // Remove padding.
  var pad = 0;
  while (clean.length && clean.charAt(clean.length - 1) === "=") {
    clean = clean.substring(0, clean.length - 1);
    pad++;
  }
  var len = clean.length;
  if (len % 4 === 1) throw Error("Invalid base64.");

  var outLen = (len * 3) / 4 - pad;
  outLen = outLen | 0;
  var out = new Uint8Array(outLen);
  var outIndex = 0;

  var i = 0;
  while (i < len) {
    var c1 = chars.indexOf(clean.charAt(i++));
    var c2 = chars.indexOf(clean.charAt(i++));
    var c3 = i < len ? chars.indexOf(clean.charAt(i++)) : 0;
    var c4 = i < len ? chars.indexOf(clean.charAt(i++)) : 0;
    if (c1 < 0 || c2 < 0 || c3 < 0 || c4 < 0) throw Error("Invalid base64.");

    var n = (c1 << 18) | (c2 << 12) | (c3 << 6) | c4;
    if (outIndex < outLen) out[outIndex++] = (n >> 16) & 255;
    if (outIndex < outLen) out[outIndex++] = (n >> 8) & 255;
    if (outIndex < outLen) out[outIndex++] = n & 255;
  }
  return out;
}

function parseJsonOrBase64String(str) {
  // 1) Plain JSON string.
  try {
    return JSON.parse(str);
  } catch (eJson) {
    // 2) Base64 string which decodes to JSON.
    var b64 = String(str).replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4 !== 0) b64 += "=";
    var bytes = base64ToUint8Array(b64);
    return JSON.parse(uint8ToString(bytes));
  }
}

function decodeJson(d) {
  if (typeof d === "string") {
    return parseJsonOrBase64String(d);
  }
  // Nakama may deliver match data as an ArrayBuffer (binary).
  try {
    if (d instanceof ArrayBuffer) {
      return parseJsonOrBase64String(uint8ToString(new Uint8Array(d)));
    }
  } catch (eAb) {
    // ignore
  }
  // Sometimes Nakama may already give a decoded JS object.
  if (d && typeof d === "object" && !Array.isArray(d)) {
    if (typeof d.position === "number") return d;
    if (typeof d.data === "string") return JSON.parse(d.data);
  }
  try {
    if (d instanceof Uint8Array) return parseJsonOrBase64String(uint8ToString(d));
  } catch (e) {
    // ignore
  }
  // Some Nakama JS runtimes expose `data` as a raw JS array of byte values.
  if (Array.isArray(d)) {
    try {
      return parseJsonOrBase64String(uint8ToString(new Uint8Array(d)));
    } catch (e3) {
      // ignore
    }
  }
  // Some runtimes expose byte arrays as an array-like object: {0:..., 1:..., length:n}
  if (d && typeof d === "object" && typeof d.length === "number") {
    try {
      var n = d.length | 0;
      if (n >= 0 && n <= 1024 * 1024) {
        var bytes = new Uint8Array(n);
        for (var i = 0; i < n; i++) bytes[i] = d[i] & 255;
        return parseJsonOrBase64String(uint8ToString(bytes));
      }
    } catch (e4) {
      // ignore
    }
  }
  // Some Nakama runtimes expose a byte-array-like object with a .buffer.
  if (d && d.buffer && typeof d.byteLength === "number") {
    try {
      return parseJsonOrBase64String(uint8ToString(new Uint8Array(d.buffer)));
    } catch (e2) {
      // ignore
    }
  }
  // Last resort (may fail for "1,2,3" style stringification).
  return JSON.parse(String(d));
}

function debugMatchData(d) {
  try {
    var t = typeof d;
    var ctor = d && d.constructor && d.constructor.name ? d.constructor.name : "";
    var isArr = Array.isArray(d);
    var len = d && typeof d.length === "number" ? d.length : undefined;
    var sample = "";
    if (t === "string") sample = d.substring(0, 80);
    else if (isArr && len) sample = JSON.stringify(d.slice(0, Math.min(20, len)));
    else if (d && typeof d === "object" && len) {
      var max = Math.min(20, len);
      var tmp = [];
      for (var i = 0; i < max; i++) tmp.push(d[i]);
      sample = JSON.stringify(tmp);
    } else if (d && typeof d === "object") {
      sample = String(d).substring(0, 80);
    }
    return "type=" + t + " ctor=" + ctor + " isArray=" + isArr + " length=" + len + " sample=" + sample;
  } catch (e) {
    return "uninspectable";
  }
}

function otherSymbol(s) {
  return s === "X" ? "O" : "X";
}

function symbolToCell(s) {
  return s === "X" ? 1 : 2;
}

function presenceToPublic(p) {
  if (!p) return undefined;
  return { userId: p.userId, username: p.username };
}

function buildPublicState(state, nowMs) {
  var turnRemainingMs;
  if (state.status === "playing" && state.mode === "timed" && state.turnDeadlineMs) {
    turnRemainingMs = Math.max(0, state.turnDeadlineMs - nowMs);
  }
  var reconnectRemainingMs;
  if (state.status === "reconnect" && state.reconnectDeadlineMs) {
    reconnectRemainingMs = Math.max(0, state.reconnectDeadlineMs - nowMs);
  }

  return {
    board: state.board,
    status: state.status,
    mode: state.mode,
    players: { X: presenceToPublic(state.x), O: presenceToPublic(state.o) },
    turn: state.turn,
    winner: state.winner,
    turnRemainingMs: turnRemainingMs,
    reconnectRemainingMs: reconnectRemainingMs
  };
}

function stateLabel(state) {
  var open = state.status === "waiting";
  return JSON.stringify({ game: "tictactoe", mode: state.mode, open: open, status: state.status });
}

function broadcastState(dispatcher, state) {
  dispatcher.broadcastMessage(OPCODE_STATE, encodeJson(buildPublicState(state, Date.now())), null, null, true);
}

function reject(dispatcher, presence, message) {
  dispatcher.broadcastMessage(OPCODE_ERROR, encodeJson({ message: message }), [presence], null, true);
}

function setTurn(state, symbol) {
  state.turn = symbol;
  if (state.mode === "timed") state.turnDeadlineMs = Date.now() + TIMED_TURN_MS;
  else state.turnDeadlineMs = null;
}

// Stats + leaderboard
var STATS_COLLECTION = "tictactoe";
var STATS_KEY = "stats";
var LEADERBOARD_ID = "tictactoe_wins_v2";

function nowIso() {
  return new Date().toISOString();
}

function readStats(nk, userId) {
  var objs = nk.storageRead([{ collection: STATS_COLLECTION, key: STATS_KEY, userId: userId }]);
  if (!objs || objs.length === 0 || !objs[0].value) {
    return { wins: 0, losses: 0, draws: 0, games: 0, streak: 0, bestStreak: 0, updatedAt: nowIso() };
  }
  var v = objs[0].value || {};
  return {
    wins: v.wins || 0,
    losses: v.losses || 0,
    draws: v.draws || 0,
    games: v.games || 0,
    streak: v.streak || 0,
    bestStreak: v.bestStreak || 0,
    updatedAt: v.updatedAt || nowIso()
  };
}

function writeStats(nk, userId, stats) {
  stats.updatedAt = nowIso();
  nk.storageWrite([
    {
      collection: STATS_COLLECTION,
      key: STATS_KEY,
      userId: userId,
      value: stats,
      permissionRead: 2,
      permissionWrite: 0
    }
  ]);
}

function updateStatsOnResult(nk, result, userId) {
  var stats = readStats(nk, userId);
  stats.games += 1;
  if (result === "win") {
    stats.wins += 1;
    stats.streak += 1;
    if (stats.streak > stats.bestStreak) stats.bestStreak = stats.streak;
  } else if (result === "loss") {
    stats.losses += 1;
    stats.streak = 0;
  } else {
    stats.draws += 1;
    stats.streak = 0;
  }
  writeStats(nk, userId, stats);
  return stats;
}

function ensureLeaderboards(logger, nk) {
  try {
    // Use "set" so the leaderboard score always matches the user's total wins.
    // (Older versions used "incr" and would over-count if we wrote totals each time.)
    nk.leaderboardCreate(LEADERBOARD_ID, true, "desc", "set", null, { game: "tictactoe" });
  } catch (e) {
    logger.debug("leaderboardCreate failed: %s", e);
  }
}

function submitWinToLeaderboard(nk, userId, username, totalWins) {
  try {
    var uname = username ? String(username).toLowerCase() : username;
    nk.leaderboardRecordWrite(LEADERBOARD_ID, userId, uname, totalWins, 0, { totalWins: totalWins });
  } catch (e) {
    // optional
  }
}

function finalizeMatch(logger, nk, state) {
  if (!state.x || !state.o) return;
  var xId = state.x.userId;
  var oId = state.o.userId;

  if (state.winner === "draw") {
    var xStatsDraw = updateStatsOnResult(nk, "draw", xId);
    var oStatsDraw = updateStatsOnResult(nk, "draw", oId);
    submitWinToLeaderboard(nk, xId, state.x.username, xStatsDraw.wins);
    submitWinToLeaderboard(nk, oId, state.o.username, oStatsDraw.wins);
    return;
  }

  var winnerId = state.winner === "X" ? xId : oId;
  var loserId = state.winner === "X" ? oId : xId;
  var winnerUsername = state.winner === "X" ? state.x.username : state.o.username;
  var loserUsername = state.winner === "X" ? state.o.username : state.x.username;

  var winnerStats = updateStatsOnResult(nk, "win", winnerId);
  var loserStats = updateStatsOnResult(nk, "loss", loserId);

  // Keep the leaderboard in sync with the latest total wins for both players.
  submitWinToLeaderboard(nk, winnerId, winnerUsername, winnerStats.wins);
  submitWinToLeaderboard(nk, loserId, loserUsername, loserStats.wins);
}

function matchInit(ctx, logger, nk, params) {
  ensureLeaderboards(logger, nk);
  var mode = params && params.mode === "timed" ? "timed" : "classic";
  var state = { board: createEmptyBoard(), status: "waiting", mode: mode };
  return { state: state, tickRate: TICK_RATE, label: stateLabel(state) };
}

function matchJoinAttempt(ctx, logger, nk, dispatcher, tick, state, presence) {
  if (state.status === "finished") return { state: state, accept: false, rejectMessage: "Match is finished." };

  if ((state.x && state.x.userId === presence.userId) || (state.o && state.o.userId === presence.userId)) {
    return { state: state, accept: true };
  }

  if (state.status === "reconnect" && state.reconnectUserId === presence.userId) return { state: state, accept: true };

  var hasSlot = !state.x || !state.o;
  return { state: state, accept: hasSlot, rejectMessage: hasSlot ? undefined : "Match is full." };
}

function matchJoin(ctx, logger, nk, dispatcher, tick, state, presences) {
  for (var i = 0; i < presences.length; i++) {
    var p = presences[i];
    if (!state.x) state.x = p;
    else if (!state.o && state.x.userId !== p.userId) state.o = p;
    else if (state.x && state.x.userId === p.userId) state.x = p;
    else if (state.o && state.o.userId === p.userId) state.o = p;
  }

  if (state.status === "reconnect" && state.reconnectUserId) {
    var back = (state.x && state.x.userId === state.reconnectUserId) || (state.o && state.o.userId === state.reconnectUserId);
    if (back) {
      state.status = "playing";
      state.reconnectUserId = null;
      state.reconnectDeadlineMs = null;
    }
  }

  if (state.status === "waiting" && state.x && state.o) {
    state.status = "playing";
    setTurn(state, "X");
  }

  broadcastState(dispatcher, state);
  return { state: state, label: stateLabel(state) };
}

function matchLeave(ctx, logger, nk, dispatcher, tick, state, presences) {
  if (state.status === "playing") {
    for (var i = 0; i < presences.length; i++) {
      var p = presences[i];
      if ((state.x && state.x.userId === p.userId) || (state.o && state.o.userId === p.userId)) {
        state.status = "reconnect";
        state.reconnectUserId = p.userId;
        state.reconnectDeadlineMs = Date.now() + RECONNECT_GRACE_MS;
      }
    }
  }
  broadcastState(dispatcher, state);
  return { state: state, label: stateLabel(state) };
}

function matchLoop(ctx, logger, nk, dispatcher, tick, state, messages) {
  var nowMs = Date.now();
  var changed = false;

  if (state.status === "reconnect" && state.reconnectDeadlineMs && nowMs >= state.reconnectDeadlineMs) {
    if (state.x && state.o && state.reconnectUserId) {
      state.winner = state.x.userId === state.reconnectUserId ? "O" : "X";
      state.status = "finished";
      state.finishedAtTick = state.finishedAtTick || tick;
      finalizeMatch(logger, nk, state);
      changed = true;
    }
  }

  if (state.status === "playing" && state.mode === "timed" && state.turnDeadlineMs && nowMs >= state.turnDeadlineMs) {
    if (state.x && state.o && state.turn) {
      state.winner = otherSymbol(state.turn);
      state.status = "finished";
      state.finishedAtTick = state.finishedAtTick || tick;
      finalizeMatch(logger, nk, state);
      changed = true;
    }
  }

  if (state.status === "playing") {
    for (var i = 0; i < messages.length; i++) {
      var m = messages[i];
      if (m.opCode !== OPCODE_MOVE) continue;

      var move;
      try {
        move = decodeJson(m.data);
      } catch (e0) {
        logger.warn("MOVE decode failed: %s", debugMatchData(m.data));
        reject(dispatcher, m.sender, "Invalid move payload.");
        continue;
      }
      var playerSymbol = state.x && state.x.userId === m.sender.userId ? "X" : state.o && state.o.userId === m.sender.userId ? "O" : null;
      if (!playerSymbol) {
        reject(dispatcher, m.sender, "You are not a player in this match.");
        continue;
      }
      if (state.turn !== playerSymbol) {
        reject(dispatcher, m.sender, "Not your turn.");
        continue;
      }

      try {
        state.board = applyMove(state.board, move.position, symbolToCell(playerSymbol));
        state.lastMoveAtMs = nowMs;
        changed = true;
      } catch (e) {
        reject(dispatcher, m.sender, e.message);
        continue;
      }

      var winnerCell = getWinner(state.board);
      if (winnerCell !== 0) {
        state.winner = winnerCell === 1 ? "X" : "O";
        state.status = "finished";
        state.finishedAtTick = state.finishedAtTick || tick;
        finalizeMatch(logger, nk, state);
        break;
      }
      if (isDraw(state.board)) {
        state.winner = "draw";
        state.status = "finished";
        state.finishedAtTick = state.finishedAtTick || tick;
        finalizeMatch(logger, nk, state);
        break;
      }

      setTurn(state, otherSymbol(playerSymbol));
    }
  }

  if (changed) broadcastState(dispatcher, state);

  if (state.status === "finished") {
    state.finishedAtTick = state.finishedAtTick || tick;
    if (tick - state.finishedAtTick >= 10 * TICK_RATE) return null;
  }

  return { state: state, label: stateLabel(state) };
}

function matchTerminate(ctx, logger, nk, dispatcher, tick, state) {
  return { state: state };
}

function matchSignal(ctx, logger, nk, dispatcher, tick, state) {
  return { state: state, data: "ok" };
}

// RPCs
function rpcCreateMatch(ctx, logger, nk, payload) {
  var data = payload ? JSON.parse(payload) : {};
  var mode = data.mode === "timed" ? "timed" : "classic";
  var matchId = nk.matchCreate("tictactoe", { mode: mode });
  return JSON.stringify({ matchId: matchId });
}

function rpcMyStats(ctx, logger, nk) {
  var s = readStats(nk, ctx.userId);
  try {
    // Backfill/update the leaderboard record for this user.
    submitWinToLeaderboard(nk, ctx.userId, ctx.username, s.wins);
  } catch (e) {}
  return JSON.stringify(s);
}

function rpcTopWins(ctx, logger, nk, payload) {
  var limit = 10;
  if (payload) {
    try {
      var d = JSON.parse(payload);
      if (d && d.limit) limit = d.limit;
    } catch (e) {}
  }
  var records = nk.leaderboardRecordsList(LEADERBOARD_ID, [], limit, null);
  return JSON.stringify(records);
}

// Matchmaker hook
function matchmakerMatched(ctx, logger, nk, matches) {
  // NOTE: This hook MUST return a match id string (authoritative match),
  // or null to allow the matchmaker to proceed as a relayed match.
  var mode = "classic";

  try {
    if (matches && typeof matches.length === "number") {
      for (var i = 0; i < matches.length; i++) {
        var m = matches[i] || {};
        var props = m.properties || m.stringProperties || m.string_properties || {};
        if (props.mode === "timed") mode = "timed";
      }
    } else if (matches && (matches.users || matches.self)) {
      // Some versions may pass a single "matched" object instead of an array.
      var users = matches.users || [];
      for (var j = 0; j < users.length; j++) {
        var u = users[j] || {};
        var sp = u.string_properties || u.stringProperties || (u.properties && u.properties.string_properties) || {};
        if (sp.mode === "timed") mode = "timed";
      }
      var self = matches.self || {};
      var sp2 = self.string_properties || self.stringProperties || {};
      if (sp2.mode === "timed") mode = "timed";
    }
  } catch (e) {
    logger.debug("matchmakerMatched properties parse failed: %s", e);
  }

  var matchId = nk.matchCreate("tictactoe", { mode: mode });
  logger.info("Created authoritative match from matchmaker: %s", matchId);
  return matchId;
}

function InitModule(ctx, logger, nk, initializer) {
  logger.info("TicTacToe runtime loaded (Nakama JS).");
  logger.info("Registering match + RPCs…");
  initializer.registerMatch("tictactoe", {
    matchInit: matchInit,
    matchJoinAttempt: matchJoinAttempt,
    matchJoin: matchJoin,
    matchLeave: matchLeave,
    matchLoop: matchLoop,
    matchTerminate: matchTerminate,
    matchSignal: matchSignal
  });
  initializer.registerRpc("create_match", rpcCreateMatch);
  initializer.registerRpc("my_stats", rpcMyStats);
  initializer.registerRpc("top_wins", rpcTopWins);
  initializer.registerMatchmakerMatched(matchmakerMatched);
  logger.info("Registration complete.");
}
