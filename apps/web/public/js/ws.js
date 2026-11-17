/**
 * WebSocket 连接管理：
 * - `ws(s)://<host>/ws?token=<token>`，消息为 JSON；
 * - 断线指数退避自动重连；
 * - 重连（或刷新页面）后根据 lastRoom 重新 room.join / spectate.join 恢复现场；
 * - 收到 state 直接写入 store 并 emit，视图按服务端状态重渲染。
 */

import { getToken, saveUser } from "./api.js";
import { isMockMode } from "./env.js";
import {
  isDuelBestOf,
  isGuessMode,
  isDictionaryMode,
  isPointsToWin,
  modeUsesSets,
  DEFAULT_GUESS_MODE,
  DEFAULT_DICTIONARY,
  DEFAULT_POINTS_TO_WIN,
} from "./constants.js";
import {
  store,
  emit,
  setConnection,
  setLastRoom,
  serverNow,
} from "./store.js";
import { createMockTransport } from "./mock.js";
import { toast } from "./ui.js";

const PING_INTERVAL_MS = 15_000;
const STALE_MESSAGE_MS = 45_000;
const VISIBILITY_STALE_MS = 30_000;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 8_000;
const RESTORE_GRACE_MS = 300;
const PENDING_RESTORE_TTL_MS = 15_000;

let socket = null;
let mockTransport = null;
let mockOpeningTimer = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
let manualClose = false;
let pingTimer = null;
let helloReceived = false;
let restoreTimer = null;
let pendingRestore = null;
let pendingRestoreTimer = null;
let lastPongAt = 0;
let lastMessageAt = 0;
let staleToastShown = false;
/**
 * 主动离开对局中的房间后，服务端仍会向保留的座位推送 state（座位保留 3 分钟）。
 * 客户端在大厅期间必须忽略该房间的推送，直到用户显式重新加入/观战/建房。
 */
let ignoreStateCode = (() => {
  try {
    return sessionStorage.getItem("ciying.ignoreRoom") || null;
  } catch {
    return null;
  }
})();

function ignoreStateFor(code) {
  ignoreStateCode = code || null;
  try {
    if (ignoreStateCode) sessionStorage.setItem("ciying.ignoreRoom", ignoreStateCode);
    else sessionStorage.removeItem("ciying.ignoreRoom");
  } catch {
    /* ignore */
  }
}

function clearIgnoreState() {
  ignoreStateCode = null;
  try {
    sessionStorage.removeItem("ciying.ignoreRoom");
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* 连接生命周期                                                        */
/* ------------------------------------------------------------------ */

export function connect() {
  if (!store.token) {
    setConnection("idle");
    return;
  }
  if (isMockMode()) {
    manualClose = false;
    connectMock();
    return;
  }
  if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) {
    return;
  }
  manualClose = false;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  setConnection(reconnectAttempt > 0 ? "reconnecting" : "connecting");

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${location.host}/ws?token=${encodeURIComponent(store.token)}`;

  let ws;
  try {
    ws = new WebSocket(url);
  } catch (error) {
    console.error("[ws] create failed", error);
    scheduleReconnect();
    return;
  }
  socket = ws;
  helloReceived = false;

  ws.addEventListener("open", () => {
    if (socket !== ws) return;
    reconnectAttempt = 0;
    lastPongAt = Date.now();
    lastMessageAt = Date.now();
    setConnection("open");
    startPing();
    clearTimeout(restoreTimer);
    // 服务端通常会主动下发 hello；若 1.5s 内没有，也尝试恢复房间。
    restoreTimer = setTimeout(() => {
      restoreTimer = null;
      if (!helloReceived) attemptRestore();
    }, 1500);
  });

  ws.addEventListener("message", (event) => {
    if (socket !== ws) return;
    lastMessageAt = Date.now();
    handleRawMessage(event.data);
  });

  ws.addEventListener("close", (event) => {
    if (socket !== ws) return;
    socket = null;
    // 服务端用 4401 表示 token 失效：停止重连并通知应用层清理会话。
    if (event && event.code === 4401) {
      manualClose = true;
      helloReceived = false;
      stopPing();
      clearRestoreTimer();
      clearTimeout(pendingRestoreTimer);
      pendingRestoreTimer = null;
      pendingRestore = null;
      setConnection("closed");
      emit("authExpired");
      return;
    }
    onTransportDown();
  });

  ws.addEventListener("error", () => {
    // close 事件一定会跟随，这里不重复处理。
  });
}

function connectMock() {
  if (mockTransport || mockOpeningTimer) return;
  setConnection("connecting");
  mockOpeningTimer = setTimeout(() => {
    mockOpeningTimer = null;
    if (manualClose) return;
    mockTransport = createMockTransport(handleMessage);
    reconnectAttempt = 0;
    lastPongAt = Date.now();
    lastMessageAt = Date.now();
    setConnection("open");
    startPing();
  }, 120);
}

function onTransportDown() {
  stopPing();
  helloReceived = false;
  clearRestoreTimer();
  pendingRestore = null;
  if (store.queue) {
    store.queue = null;
    emit("queue", null);
  }
  if (manualClose) {
    setConnection("closed");
    return;
  }
  setConnection("reconnecting");
  scheduleReconnect();
}

function scheduleReconnect() {
  if (manualClose || !store.token) return;
  if (reconnectTimer) return;
  reconnectAttempt += 1;
  const backoff = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** (reconnectAttempt - 1));
  const delay = backoff + Math.floor(Math.random() * 250);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

export function disconnect() {
  manualClose = true;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  clearTimeout(mockOpeningTimer);
  mockOpeningTimer = null;
  clearRestoreTimer();
  clearTimeout(pendingRestoreTimer);
  pendingRestoreTimer = null;
  pendingRestore = null;
  stopPing();
  reconnectAttempt = 0;
  helloReceived = false;

  if (socket) {
    const current = socket;
    socket = null;
    try {
      current.close();
    } catch {
      /* ignore */
    }
  }
  if (mockTransport) {
    mockTransport.close();
    mockTransport = null;
  }
  setConnection("closed");
}

export function forceReconnect() {
  if (manualClose) manualClose = false;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  reconnectAttempt = 0;
  stopPing();
  clearRestoreTimer();
  pendingRestore = null;
  clearTimeout(pendingRestoreTimer);
  pendingRestoreTimer = null;
  lastMessageAt = 0;
  if (socket) {
    const current = socket;
    socket = null;
    try {
      current.close();
    } catch {
      /* ignore */
    }
  }
  if (mockTransport) {
    mockTransport.close();
    mockTransport = null;
  }
  connect();
}

export function checkConnection(reason = "check") {
  if (!store.token || manualClose) return false;
  if (!isOpen()) {
    forceReconnect(reason);
    return true;
  }
  if (lastMessageAt && Date.now() - lastMessageAt > VISIBILITY_STALE_MS) {
    notifyStaleOnce();
    forceReconnect(reason);
    return true;
  }
  return false;
}

function notifyStaleOnce() {
  if (staleToastShown) return;
  staleToastShown = true;
  toast("网络连接已超时，正在重新连接…", "warn");
}

export function isOpen() {
  if (isMockMode()) return Boolean(mockTransport);
  return Boolean(socket && socket.readyState === WebSocket.OPEN);
}

/* ------------------------------------------------------------------ */
/* 心跳                                                                */
/* ------------------------------------------------------------------ */

function startPing() {
  stopPing();
  pingTimer = setInterval(() => {
    if (!isOpen()) return;
    if (lastMessageAt && Date.now() - lastMessageAt > STALE_MESSAGE_MS) {
      notifyStaleOnce();
      forceReconnect();
      return;
    }
    sendRaw({ type: "ping" });
  }, PING_INTERVAL_MS);
}

function stopPing() {
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = null;
}

/* ------------------------------------------------------------------ */
/* 消息接收                                                            */
/* ------------------------------------------------------------------ */

function handleRawMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  handleMessage(message);
}

function handleMessage(message) {
  if (!message || typeof message !== "object" || typeof message.type !== "string") return;
  lastMessageAt = Date.now();
  switch (message.type) {
    case "hello": {
      helloReceived = true;
      if (message.user && typeof message.user.id === "string") {
        store.user = message.user;
        saveUser(message.user);
        emit("user", message.user);
      }
      clearTimeout(restoreTimer);
      restoreTimer = setTimeout(() => {
        restoreTimer = null;
        attemptRestore();
      }, RESTORE_GRACE_MS);
      break;
    }
    case "state": {
      const state = message.state;
      if (!state || typeof state !== "object") return;
      // 主动离开后座位的后续推送：不要把人拉回房间。
      if (ignoreStateCode && state.code === ignoreStateCode) return;
      clearRestoreTimer();
      pendingRestore = null;
      store.room = state;
      if (typeof state.serverTime === "number") {
        store.serverOffset = state.serverTime - Date.now();
      }
      setLastRoom({
        code: state.code,
        role: state.viewerRole === "spectator" ? "spectator" : "player",
      });
      if (store.queue) {
        store.queue = null;
        emit("queue", null);
      }
      emit("room", state);
      break;
    }
    case "rooms": {
      store.rooms = Array.isArray(message.rooms) ? message.rooms : [];
      store.roomsReady = true;
      emit("rooms", store.rooms);
      break;
    }
    case "queue": {
      store.queue = message.state || null;
      emit("queue", store.queue);
      break;
    }
    case "leaderboard": {
      emit("leaderboard", {
        mode: message.mode,
        rows: Array.isArray(message.rows) ? message.rows : [],
      });
      break;
    }
    case "match.found": {
      if (store.queue) {
        store.queue = null;
        emit("queue", null);
      }
      // 服务端也会推送 toast，这里不重复提示。
      emit("matchFound", message.code);
      break;
    }
    case "error": {
      const text = message.message || "操作失败";
      const isAuthError = /登录状态已失效/.test(text);
      if (pendingRestore) {
        const failed = pendingRestore;
        pendingRestore = null;
        clearTimeout(pendingRestoreTimer);
        pendingRestoreTimer = null;
        setLastRoom(null);
        emit("restoreFailed", { code: failed.code, message: text });
      } else if (!isAuthError) {
        toast(text, "error");
      }
      emit("serverError", text);
      break;
    }
    case "toast": {
      toast(message.message || "", "info");
      break;
    }
    case "pong": {
      lastPongAt = Date.now();
      lastMessageAt = Date.now();
      if (typeof message.serverTime === "number") {
        store.serverOffset = message.serverTime - Date.now();
      }
      break;
    }
    case "ping": {
      lastPongAt = Date.now();
      lastMessageAt = Date.now();
      sendRaw({ type: "pong" });
      break;
    }
    default:
      break;
  }
}

function clearRestoreTimer() {
  if (restoreTimer) clearTimeout(restoreTimer);
  restoreTimer = null;
}

/* ------------------------------------------------------------------ */
/* 连接恢复                                                            */
/* ------------------------------------------------------------------ */

function attemptRestore() {
  const target = store.lastRoom;
  if (!target || !isOpen()) return;
  pendingRestore = { code: target.code, at: Date.now() };
  clearTimeout(pendingRestoreTimer);
  pendingRestoreTimer = setTimeout(() => {
    pendingRestore = null;
    pendingRestoreTimer = null;
  }, PENDING_RESTORE_TTL_MS);

  if (target.role === "spectator") {
    sendRaw({ type: "spectate.join", code: target.code });
  } else {
    sendRaw({ type: "room.join", code: target.code });
  }
}

/* ------------------------------------------------------------------ */
/* 消息发送                                                            */
/* ------------------------------------------------------------------ */

function sendRaw(message) {
  if (isMockMode()) {
    if (!mockTransport) return false;
    mockTransport.send(message);
    return true;
  }
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch (error) {
    console.error("[ws] send failed", error);
    return false;
  }
}

/** 对外发送：连接未就绪时给出提示。 */
export function send(message) {
  if (!store.token) {
    toast("请先输入昵称进入竞技场", "warn");
    return false;
  }
  const ok = sendRaw(message);
  if (!ok) toast("网络未连接，正在尝试重连…", "warn");
  return ok;
}

/* ------------------------------------------------------------------ */
/* 语义化动作                                                          */
/* ------------------------------------------------------------------ */

export function createRoom(mode, visibility, options = {}) {
  clearIgnoreState();
  // 兼容旧调用 createRoom(mode, visibility, bestOf)。
  const opts = typeof options === "number" ? { bestOf: options } : options || {};
  const message = {
    type: "room.create",
    mode,
    visibility: visibility === "private" ? "private" : "public",
  };
  // bestOf 只对 1v1 / 团队战有意义；其他模式不带该字段。
  if (modeUsesSets(mode) && isDuelBestOf(opts.bestOf)) message.bestOf = opts.bestOf;
  // 猜测模式对所有模式生效，默认标准。
  message.guessMode = isGuessMode(opts.guessMode) ? opts.guessMode : DEFAULT_GUESS_MODE;
  message.dictionary = isDictionaryMode(opts.dictionary) ? opts.dictionary : DEFAULT_DICTIONARY;
  message.pointsToWin = isPointsToWin(opts.pointsToWin)
    ? Number(opts.pointsToWin)
    : DEFAULT_POINTS_TO_WIN;
  return send(message);
}

export function proposeRules(rules) {
  return send({ type: "room.proposeRules", rules });
}

export function acceptRules(proposalId) {
  return send({ type: "room.acceptRules", proposalId: String(proposalId || "") });
}

export function counterRules(rules) {
  return send({ type: "room.counterRules", rules });
}

export function updateRules(rules) {
  return send({ type: "room.updateRules", rules });
}

export function offerDraw() {
  return send({ type: "room.offerDraw" });
}

export function respondDraw(accept) {
  return send({ type: "room.respondDraw", accept: Boolean(accept) });
}

export function joinRoom(code) {
  clearIgnoreState();
  return send({ type: "room.join", code: String(code || "").toUpperCase() });
}

export function spectate(code) {
  clearIgnoreState();
  return send({ type: "spectate.join", code: String(code || "").toUpperCase() });
}

export function leaveRoom() {
  const role = store.room && store.room.viewerRole === "spectator" ? "spectator" : "player";
  const leftCode = store.room && store.room.code;
  if (role === "spectator") sendRaw({ type: "spectate.leave" });
  else {
    if (leftCode) ignoreStateFor(leftCode);
    sendRaw({ type: "room.leave" });
  }
  pendingRestore = null;
  clearTimeout(pendingRestoreTimer);
  pendingRestoreTimer = null;
  store.room = null;
  setLastRoom(null);
  emit("room", null);
}

export function setReady(ready) {
  return send({ type: "room.ready", ready: Boolean(ready) });
}

/** 团队战选队：不传 userId 表示移动自己，房主可传任意玩家 id。 */
export function setTeam(team, userId) {
  if (team !== "A" && team !== "B") return false;
  const message = { type: "room.setTeam", team };
  if (userId) message.userId = String(userId);
  return send(message);
}

export function startMatch() {
  return send({ type: "room.start" });
}

export function submitGuess(word) {
  return send({ type: "room.guess", word: String(word || "") });
}

export function sendChat(scope, text) {
  return send({ type: "room.chat", scope: scope === "team" ? "team" : "room", text: String(text || "") });
}

export function rematch() {
  return send({ type: "room.rematch" });
}

export function joinQueue(mode) {
  clearIgnoreState();
  return send({ type: "queue.join", mode });
}

export function leaveQueue() {
  return send({ type: "queue.leave" });
}

export function serverNowMs() {
  return serverNow();
}

/* ------------------------------------------------------------------ */
/* 网络事件                                                            */
/* ------------------------------------------------------------------ */

if (typeof window !== "undefined") {
  const foregroundCheck = (reason) => {
    if (!store.token || manualClose) return;
    checkConnection(reason);
  };
  window.addEventListener("online", () => foregroundCheck("online"));
  window.addEventListener("pageshow", () => foregroundCheck("pageshow"));
  window.addEventListener("focus", () => foregroundCheck("focus"));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    foregroundCheck("visibility");
  });
}

export function currentToken() {
  return getToken();
}
