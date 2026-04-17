import React, { useEffect, useMemo, useRef, useState } from "react";
import Board from "./Board.jsx";
import { authenticate, connectSocket, decodeJson, getClient, loadSession } from "./nakama.js";

const OPCODE_MOVE = 1;
const OPCODE_STATE = 100;
const OPCODE_ERROR = 101;

function msToTimer(ms) {
  if (ms === undefined) return null;
  const s = Math.ceil(ms / 1000);
  return `${s}s`;
}

function getWinningLine(board, winnerCell) {
  if (!board || !winnerCell) return null;
  const lines = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6]
  ];
  for (const line of lines) {
    if (line.every((i) => board[i] === winnerCell)) return line;
  }
  return null;
}

function normalizePayload(payload) {
  if (!payload) return null;
  if (typeof payload === "string") {
    try {
      return JSON.parse(payload);
    } catch {
      return payload;
    }
  }
  return payload;
}

export default function App() {
  const client = useMemo(() => getClient(), []);
  const [session, setSession] = useState(() => loadSession());
  const [socket, setSocket] = useState(null);
  const [view, setView] = useState(session ? "lobby" : "auth");

  const [username, setUsername] = useState("");
  const [toast, setToast] = useState(null); // { kind: "good"|"bad", text: string }
  const [winnerModal, setWinnerModal] = useState(null); // { title, text }
  const [panelModal, setPanelModal] = useState(null); // { type: "stats"|"top", data }

  const [matchId, setMatchId] = useState(null);
  const [matchState, setMatchState] = useState(null);
  const [mode, setMode] = useState("classic"); // "classic" | "timed"

  const [rooms, setRooms] = useState([]); // { matchId, label, size }[]
  const [stats, setStats] = useState(null);
  const [topWins, setTopWins] = useState(null);

  const cleanupRef = useRef(null);
  const prevWinnerRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!session) return;
      const s = await connectSocket(client, session);
      if (cancelled) return;

      s.onmatchdata = (m) => {
        if (m.op_code === OPCODE_STATE) {
          const next = decodeJson(m.data);
          setMatchState(next);
          // Clear "joining" toast once we receive the first authoritative state.
          setToast(null);
        }
        if (m.op_code === OPCODE_ERROR) {
          const err = decodeJson(m.data);
          setToast({ kind: "bad", text: err.message });
        }
      };

      s.onmatchmakermatched = async (matched) => {
        try {
          setToast({ kind: "good", text: "Matched! Joining game…" });
          const id = matched.match_id;
          const joined =
            id && !String(id).endsWith(".") ? await s.joinMatch(id) : await s.joinMatch(undefined, matched.token);
          setMatchId(joined.match_id);
          setView("match");
        } catch (e) {
          setToast({ kind: "bad", text: `Failed to join matched game: ${e.message}` });
        }
      };

      cleanupRef.current = () => {
        try {
          s.disconnect(true);
        } catch {
          // ignore
        }
      };

      setSocket(s);
    }
    run();
    return () => {
      cancelled = true;
      cleanupRef.current?.();
      cleanupRef.current = null;
      setSocket(null);
    };
  }, [client, session]);

  async function onLogin() {
    try {
      const desired = username.trim();
      // Treat usernames case-insensitively by canonicalizing to lowercase.
      const canonical = desired ? desired.toLowerCase() : undefined;
      const s = await authenticate(client, canonical);
      setSession(s);
      setView("lobby");
      try {
        const acc = await client.getAccount(s);
        const uname = acc?.user?.username;
        setToast({ kind: "good", text: uname ? `Logged in as ${uname}.` : "Logged in." });
      } catch {
        setToast({ kind: "good", text: "Logged in." });
      }
    } catch (e) {
      setToast({ kind: "bad", text: e.message });
    }
  }

  function onLogout() {
    localStorage.removeItem("ttt_session");
    localStorage.removeItem("ttt_refresh");
    // Clear device id too so the next login can create a different user if desired.
    // (If we keep the same device id, Nakama will log back into the same account.)
    localStorage.removeItem("ttt_device_id");
    localStorage.removeItem("ttt_username");
    setSession(null);
    setMatchId(null);
    setMatchState(null);
    setView("auth");
  }

  async function refreshRooms() {
    if (!session) return;
    try {
      setToast({ kind: "good", text: "Refreshing rooms…" });

      // Some Nakama setups don't reliably support querying inside a JSON label with `label.field:value`.
      // So we fetch authoritative matches and filter by parsing the label JSON client-side.
      const res = await client.listMatches(session, 50, true, undefined, 0, 2, undefined);

      const list = (res.matches ?? [])
        .map((m) => {
          let labelObj = null;
          if (m.label) {
            try {
              labelObj = JSON.parse(m.label);
            } catch {
              labelObj = null;
            }
          }
          return {
            matchId: m.match_id,
            label: m.label ?? "",
            labelObj,
            size: m.size ?? 0
          };
        })
        .filter((r) => r.labelObj?.game === "tictactoe" && r.labelObj?.open === true && r.labelObj?.mode === mode)
        .map(({ matchId, label, size }) => ({ matchId, label, size }));

      setRooms(list);
      setToast({ kind: "good", text: `Found ${list.length} room(s).` });
      setTimeout(() => setToast(null), 1200);
    } catch (e) {
      setToast({ kind: "bad", text: `Failed to refresh rooms: ${e.message}` });
    }
  }

  async function createRoom() {
    if (!session || !socket) return;
    const res = await client.rpc(session, "create_match", { mode });
    const data = res.payload ?? {};
    const joined = await socket.joinMatch(data.matchId);
    setMatchId(joined.match_id);
    setView("match");
    setToast({ kind: "good", text: "Room created." });
  }

  async function quickMatch() {
    if (!socket) return;
    const query = `+properties.game:tictactoe +properties.mode:${mode}`;
    await socket.addMatchmaker(query, 2, 2, { game: "tictactoe", mode });
    setToast({ kind: "good", text: "Searching for an opponent…" });
  }

  async function joinRoom(id) {
    if (!socket) return;
    const joined = await socket.joinMatch(id);
    setMatchId(joined.match_id);
    setView("match");
  }

  async function loadMyStats() {
    if (!session) return;
    try {
      setToast({ kind: "good", text: "Loading stats…" });
      const res = await client.rpc(session, "my_stats", {});
      const data = normalizePayload(res.payload);
      setStats(data);
      setPanelModal({ type: "stats", data });
      setToast(null);
    } catch (e) {
      setToast({ kind: "bad", text: `Failed to load stats: ${e.message}` });
    }
  }

  async function loadTopWins() {
    if (!session) return;
    try {
      setToast({ kind: "good", text: "Loading leaderboard…" });
      const res = await client.rpc(session, "top_wins", { limit: 10 });
      const data = normalizePayload(res.payload);
      setTopWins(data);
      setPanelModal({ type: "top", data });
      setToast(null);
    } catch (e) {
      setToast({ kind: "bad", text: `Failed to load leaderboard: ${e.message}` });
    }
  }

  async function sendMove(position) {
    if (!socket || !matchId) return;
    try {
      await socket.sendMatchState(matchId, OPCODE_MOVE, JSON.stringify({ position }));
    } catch (e) {
      setToast({ kind: "bad", text: `Failed to send move: ${e.message}` });
    }
  }

  const youId = session?.user_id ?? null;
  const yourSymbol =
    matchState?.players?.X?.userId === youId ? "X" : matchState?.players?.O?.userId === youId ? "O" : null;
  const canMove = matchState?.status === "playing" && matchState.turn === yourSymbol;
  const winnerCell = matchState?.winner === "X" ? 1 : matchState?.winner === "O" ? 2 : 0;
  const winLine = matchState?.board ? getWinningLine(matchState.board, winnerCell) : null;

  useEffect(() => {
    // Ensure winner popups are evaluated per-match.
    prevWinnerRef.current = null;
  }, [matchId]);

  useEffect(() => {
    if (matchState?.status !== "finished") return;
    const winner = matchState?.winner ?? null;
    if (!winner || winner === prevWinnerRef.current) return;
    prevWinnerRef.current = winner;

    if (winner === "draw") {
      setWinnerModal({ title: "Game Over", text: "It’s a draw." });
      return;
    }
    const player = matchState?.players?.[winner];
    const name = player?.username || player?.userId || winner;
    setWinnerModal({
      title: "Congratulations!",
      text: `Player ${name} wins the game.`
    });
  }, [matchId, matchState?.status, matchState?.winner, matchState?.players]);

  return (
    <div className="container">
      <div className="header">
        <h1 className="title">Tic-Tac-Toe (Nakama, server-authoritative)</h1>
        {session ? (
          <div className="btns">
            <button onClick={onLogout}>Logout</button>
          </div>
        ) : null}
      </div>

      {view === "auth" ? (
        <div className="card">
          <div className="muted">Device auth (creates an account automatically).</div>
          <div style={{ height: 10 }} />
          <label className="muted">Optional username</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="e.g. janvi" />
          <div style={{ height: 12 }} />
          <div className="btns">
            <button className="primary" onClick={onLogin}>
              Login
            </button>
          </div>
        </div>
      ) : null}

      {view === "lobby" ? (
        <div className="row">
          <div className="card">
            <div className="muted">Mode</div>
            <div className="btns" style={{ marginTop: 10 }}>
              <button className={mode === "classic" ? "primary" : ""} onClick={() => setMode("classic")}>
                Classic
              </button>
              <button className={mode === "timed" ? "primary" : ""} onClick={() => setMode("timed")}>
                Timed (30s)
              </button>
            </div>
            <div style={{ height: 12 }} />
            <div className="btns">
              <button className="primary" disabled={!socket} onClick={quickMatch}>
                Quick Match
              </button>
              <button disabled={!socket} onClick={createRoom}>
                Create Room
              </button>
              <button disabled={!session} onClick={refreshRooms}>
                Refresh Rooms
              </button>
            </div>

            <div style={{ height: 14 }} />
            <div className="muted">Open rooms</div>
            <div style={{ height: 10 }} />
            {rooms.length === 0 ? (
              <div className="muted">No rooms found (create one, or refresh).</div>
            ) : (
              <div style={{ display: "grid", gap: 10 }}>
                {rooms.map((r) => (
                  <div key={r.matchId} className="card" style={{ padding: 12 }}>
                    <div className="muted" style={{ wordBreak: "break-all" }}>
                      {r.matchId}
                    </div>
                    <div className="muted">Players: {r.size}/2</div>
                    <div style={{ height: 10 }} />
                    <button className="primary" disabled={!socket} onClick={() => joinRoom(r.matchId)}>
                      Join
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card">
            <div className="muted">Stats + leaderboard</div>
            <div style={{ height: 10 }} />
            <div className="btns">
              <button disabled={!session} onClick={loadMyStats}>
                My Stats
              </button>
              <button disabled={!session} onClick={loadTopWins}>
                Top Wins
              </button>
            </div>
            <div style={{ height: 12 }} />
            {stats ? (
              <div className="kpis">
                <div className="kpi">
                  <div className="kpiLabel">Games</div>
                  <div className="kpiValue">{stats.games ?? 0}</div>
                </div>
                <div className="kpi">
                  <div className="kpiLabel">Wins</div>
                  <div className="kpiValue">{stats.wins ?? 0}</div>
                </div>
                <div className="kpi">
                  <div className="kpiLabel">Losses</div>
                  <div className="kpiValue">{stats.losses ?? 0}</div>
                </div>
                <div className="kpi">
                  <div className="kpiLabel">Draws</div>
                  <div className="kpiValue">{stats.draws ?? 0}</div>
                </div>
                <div className="kpi">
                  <div className="kpiLabel">Streak</div>
                  <div className="kpiValue">{stats.streak ?? 0}</div>
                </div>
                <div className="kpi">
                  <div className="kpiLabel">Best</div>
                  <div className="kpiValue">{stats.bestStreak ?? 0}</div>
                </div>
              </div>
            ) : (
              <div className="muted">Load your stats to view.</div>
            )}
            <div style={{ height: 12 }} />
            {topWins?.records?.length ? (
              <div className="table">
                {(topWins.records ?? []).slice(0, 5).map((r) => (
                  <div key={`${r.owner_id}-${r.rank}`} className="tableRow">
                    <div className="tableCell muted">#{r.rank}</div>
                    <div className="tableCell">{r.username || r.owner_id}</div>
                    <div className="tableCell muted" style={{ textAlign: "right" }}>
                      {r.score}
                    </div>
                  </div>
                ))}
                <div className="muted" style={{ marginTop: 8 }}>
                  Open “Top Wins” for full list.
                </div>
              </div>
            ) : (
              <div className="muted">Load Top Wins to view leaderboard.</div>
            )}
          </div>
        </div>
      ) : null}

      {view === "match" ? (
        <div className="card">
          <div className="muted" style={{ wordBreak: "break-all" }}>
            Match: {matchId}
          </div>
          <div style={{ height: 6 }} />
          <div className="muted">
            You: {youId} {yourSymbol ? `(playing ${yourSymbol})` : "(spectating)"}
          </div>
          <div style={{ height: 12 }} />

          {matchState ? (
            <>
              <div className="muted">
                Status: {matchState.status} • Mode: {matchState.mode}
                {matchState.status === "playing" ? ` • Turn: ${matchState.turn}` : ""}
                {matchState.turnRemainingMs !== undefined ? ` • Timer: ${msToTimer(matchState.turnRemainingMs)}` : ""}
                {matchState.reconnectRemainingMs !== undefined
                  ? ` • Reconnect: ${msToTimer(matchState.reconnectRemainingMs)}`
                  : ""}
              </div>
              <div style={{ height: 12 }} />
              <Board board={matchState.board} onMove={sendMove} disabled={!canMove} highlights={winLine ?? []} />
              <div style={{ height: 12 }} />
              {matchState.winner ? (
                <div className={`toast ${matchState.winner === "draw" ? "" : "good"}`}>
                  {matchState.winner === "draw" ? "Draw." : `Winner: ${matchState.winner}`}
                </div>
              ) : canMove ? (
                <div className="toast good">Your move.</div>
              ) : (
                <div className="toast">Waiting…</div>
              )}
              <div style={{ height: 12 }} />
              <div className="btns">
                <button
                  onClick={() => {
                    setView("lobby");
                    setMatchId(null);
                    setMatchState(null);
                  }}
                >
                  Back to Lobby
                </button>
              </div>
            </>
          ) : (
            <div className="muted">Waiting for state…</div>
          )}
        </div>
      ) : null}

      {toast ? (
        <div className={`toast ${toast.kind}`}>
          {toast.text}{" "}
          <button style={{ marginLeft: 10 }} onClick={() => setToast(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      {winnerModal ? (
        <div className="modalOverlay" role="dialog" aria-modal="true">
          <div className="modal">
            <div className="modalTitle">{winnerModal.title}</div>
            <div className="modalText">{winnerModal.text}</div>
            <div className="btns" style={{ marginTop: 14 }}>
              <button
                className="primary"
                onClick={() => {
                  setWinnerModal(null);
                  setView("lobby");
                  setMatchId(null);
                  setMatchState(null);
                }}
              >
                OK
              </button>
              <button onClick={() => setWinnerModal(null)}>Stay</button>
            </div>
          </div>
        </div>
      ) : null}

      {panelModal ? (
        <div className="modalOverlay" role="dialog" aria-modal="true">
          <div className="modal">
            <div className="modalTitle">{panelModal.type === "stats" ? "My Stats" : "Top Wins"}</div>

            {panelModal.type === "stats" ? (
              (() => {
                const s = panelModal.data ?? {};
                const games = Number(s.games ?? 0);
                const wins = Number(s.wins ?? 0);
                const losses = Number(s.losses ?? 0);
                const draws = Number(s.draws ?? 0);
                const winRate = games > 0 ? Math.round((wins / games) * 100) : 0;

                return (
                  <>
                    <div className="kpis" style={{ marginTop: 12 }}>
                      <div className="kpi">
                        <div className="kpiLabel">Games</div>
                        <div className="kpiValue">{games}</div>
                      </div>
                      <div className="kpi">
                        <div className="kpiLabel">Win Rate</div>
                        <div className="kpiValue">{winRate}%</div>
                      </div>
                      <div className="kpi">
                        <div className="kpiLabel">Streak</div>
                        <div className="kpiValue">{s.streak ?? 0}</div>
                      </div>
                      <div className="kpi">
                        <div className="kpiLabel">Best</div>
                        <div className="kpiValue">{s.bestStreak ?? 0}</div>
                      </div>
                    </div>

                    <div style={{ height: 12 }} />

                    <div className="muted">W / L / D</div>
                    <div className="table" style={{ marginTop: 6 }}>
                      <div className="tableRow">
                        <div className="tableCell">Wins</div>
                        <div className="tableCell muted" style={{ textAlign: "right" }}>
                          {wins}
                        </div>
                      </div>
                      <div className="tableRow">
                        <div className="tableCell">Losses</div>
                        <div className="tableCell muted" style={{ textAlign: "right" }}>
                          {losses}
                        </div>
                      </div>
                      <div className="tableRow">
                        <div className="tableCell">Draws</div>
                        <div className="tableCell muted" style={{ textAlign: "right" }}>
                          {draws}
                        </div>
                      </div>
                    </div>
                  </>
                );
              })()
            ) : (
              <>
                <div className="modalText" style={{ marginTop: 10 }}>
                  Ranked by total wins.
                </div>
                <div className="table" style={{ marginTop: 10 }}>
                  {(panelModal.data?.records ?? []).slice(0, 10).map((r) => (
                    <div key={`${r.owner_id}-${r.rank}`} className="tableRow">
                      <div className="tableCell muted" style={{ width: 56 }}>
                        #{r.rank}
                      </div>
                      <div className="tableCell">{r.username || r.owner_id}</div>
                      <div className="tableCell muted" style={{ textAlign: "right" }}>
                        {r.score} wins
                      </div>
                    </div>
                  ))}
                  {!panelModal.data?.records?.length ? <div className="muted">No records yet.</div> : null}
                </div>
              </>
            )}

            <div className="btns" style={{ marginTop: 14 }}>
              <button className="primary" onClick={() => setPanelModal(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
