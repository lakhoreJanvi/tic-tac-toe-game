import { Client, Session } from "@heroiclabs/nakama-js";

function env(name, fallback) {
  const v = import.meta.env?.[name];
  return v === undefined || v === null || v === "" ? fallback : v;
}

function readRuntimeOverrides() {
  // Allows configuring the deployed static site without rebuilding:
  //   ?nakamaHost=...&nakamaPort=...&nakamaSSL=true|false
  // Values from the query string are persisted in localStorage.
  if (typeof window === "undefined") return {};

  const params = new URLSearchParams(window.location.search);
  const keyHost = "ttt_nakama_host";
  const keyPort = "ttt_nakama_port";
  const keySSL = "ttt_nakama_ssl";

  const fromQS = {
    host: params.get("nakamaHost"),
    port: params.get("nakamaPort"),
    ssl: params.get("nakamaSSL")
  };

  if (fromQS.host) localStorage.setItem(keyHost, fromQS.host);
  if (fromQS.port) localStorage.setItem(keyPort, fromQS.port);
  if (fromQS.ssl) localStorage.setItem(keySSL, fromQS.ssl);

  return {
    host: fromQS.host || localStorage.getItem(keyHost) || undefined,
    port: fromQS.port || localStorage.getItem(keyPort) || undefined,
    ssl: fromQS.ssl || localStorage.getItem(keySSL) || undefined
  };
}

export function getClientConfig() {
  const overrides = readRuntimeOverrides();
  const host = overrides.host ?? env("VITE_NAKAMA_HOST", "127.0.0.1");
  const port = overrides.port ?? env("VITE_NAKAMA_PORT", "7350");
  const sslRaw = overrides.ssl ?? env("VITE_NAKAMA_SSL", "false");
  const useSSL = String(sslRaw) === "true";
  const serverKey = env("VITE_NAKAMA_SERVER_KEY", "defaultkey");
  return { host, port, useSSL, serverKey };
}

export function getClient() {
  const { host, port, useSSL, serverKey } = getClientConfig();
  return new Client(serverKey, host, port, useSSL);
}

export function getOrCreateDeviceId() {
  const key = "ttt_device_id";
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const id = crypto.randomUUID();
  localStorage.setItem(key, id);
  return id;
}

export async function authenticate(client, username) {
  const canonical = String(username || "").trim().toLowerCase() || undefined;

  // If a username is provided, authenticate by a stable "custom id" derived from the canonical username.
  // This makes usernames case-insensitive across browsers/devices:
  // "Sohel", "sohel", "SOHEL" -> same canonical user.
  if (canonical) {
    const customId = `ttt:${canonical}`;
    try {
      const session = await client.authenticateCustom(customId, true, canonical);
      localStorage.setItem("ttt_session", session.token);
      localStorage.setItem("ttt_refresh", session.refresh_token);
      return session;
    } catch (e) {
      const msg = String(e?.message ?? "");
      const status = e?.statusCode ?? e?.status_code ?? e?.status ?? null;

      // If the custom user already exists, try login without creating.
      try {
        const session = await client.authenticateCustom(customId, false, undefined);
        localStorage.setItem("ttt_session", session.token);
        localStorage.setItem("ttt_refresh", session.refresh_token);
        return session;
      } catch {
        // If create failed due to username conflict, it's usually because a legacy account already has that username.
        if (status === 409 || msg.includes("409") || msg.toLowerCase().includes("conflict")) {
          throw new Error(
            `Username "${canonical}" already exists from an older account. To make names case-insensitive, reset the local DB (docker volumes) or choose a different username.`
          );
        }
        throw e;
      }
    }
  }

  // Otherwise fall back to device auth (anonymous).
  const deviceId = getOrCreateDeviceId();
  const session = await client.authenticateDevice(deviceId, true, undefined);
  localStorage.setItem("ttt_session", session.token);
  localStorage.setItem("ttt_refresh", session.refresh_token);
  return session;
}

export function loadSession() {
  const token = localStorage.getItem("ttt_session");
  const refresh = localStorage.getItem("ttt_refresh");
  if (!token || !refresh) return null;
  const session = Session.restore(token, refresh);
  const nowSec = Math.floor(Date.now() / 1000);
  if (session.isexpired(nowSec)) return null;
  return session;
}

export async function connectSocket(client, session) {
  const { useSSL } = getClientConfig();
  const socket = client.createSocket(useSSL, false);
  const updated = await socket.connect(session, true);
  localStorage.setItem("ttt_session", updated.token);
  localStorage.setItem("ttt_refresh", updated.refresh_token);
  return socket;
}

export function decodeJson(data) {
  // Nakama JS client delivers match data as Uint8Array.
  return JSON.parse(new TextDecoder().decode(data));
}
