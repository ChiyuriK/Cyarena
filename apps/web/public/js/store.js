/**
 * 极简全局状态 + 事件总线。
 *
 * 视图订阅 store 事件做局部重渲染；所有服务端推送先写入 store 再 emit，
 * 保证 UI 永远以最后一次服务端状态为准（服务端权威）。
 */

const LAST_ROOM_KEY = "ciying.lastRoom";
/**
 * 对局中主动离开后用于大厅“最近房间 / 3 分钟内可重新加入”的持久记录。
 * 放在 localStorage（与用于自动恢复的 sessionStorage 同名但互不影响）。
 */
const REJOIN_KEY = "ciying.lastRoom";

export const store = {
  /** 当前登录 token（游客也有）。 */
  token: "",
  /** PublicUser | null */
  user: null,
  /** idle | connecting | open | reconnecting | closed */
  connection: "idle",
  /** RoomSummary[] */
  rooms: [],
  roomsReady: false,
  /** QueueState | null */
  queue: null,
  /** RoomState | null */
  room: null,
  /** 最近离开房间的最近 5 轮答案快照，用于大厅侧栏。 */
  /** { code: string, role: 'player'|'spectator' } | null */
  lastRoom: null,
  /** { name: 'lobby'|'room'|'leaderboard', code?: string } */
  route: { name: "lobby" },
  /** 服务端时间与本地时间的偏差：serverNow = Date.now() + offset */
  serverOffset: 0,
  /** 启动阶段的错误提示 */
  bootError: "",
  /** 是否处于观战待进入状态（用于 UI 提示） */
  spectatingIntent: false,
};

const listeners = new Map();

export function on(event, handler) {
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
  }
  set.add(handler);
  return function off() {
    const current = listeners.get(event);
    if (!current) return;
    current.delete(handler);
    if (current.size === 0) listeners.delete(event);
  };
}

export function emit(event, payload) {
  const set = listeners.get(event);
  if (!set || set.size === 0) return;
  for (const handler of Array.from(set)) {
    try {
      handler(payload);
    } catch (error) {
      console.error(`[store] listener for "${event}" failed`, error);
    }
  }
}

export function setConnection(connection) {
  if (store.connection === connection) return;
  store.connection = connection;
  emit("connection", connection);
}

export function serverNow() {
  return Date.now() + store.serverOffset;
}

export function setLastRoom(value) {
  store.lastRoom = value || null;
  try {
    if (value) sessionStorage.setItem(LAST_ROOM_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(LAST_ROOM_KEY);
  } catch {
    /* ignore */
  }
}

export function loadLastRoom() {
  try {
    const raw = sessionStorage.getItem(LAST_ROOM_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.code !== "string") return null;
    if (parsed.role !== "player" && parsed.role !== "spectator") return null;
    return { code: parsed.code.toUpperCase(), role: parsed.role };
  } catch {
    return null;
  }
}

export function clearRoomState() {
  store.room = null;
  setLastRoom(null);
  emit("room", null);
}

/** 保存“最近房间”重连入口（localStorage，跨刷新保留）。 */
export function saveRejoin(value) {
  try {
    if (!value || typeof value.code !== "string") {
      localStorage.removeItem(REJOIN_KEY);
      return;
    }
    localStorage.setItem(REJOIN_KEY, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

export function loadRejoin() {
  try {
    const raw = localStorage.getItem(REJOIN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.code !== "string") return null;
    if (!Number.isFinite(Number(parsed.expiresAt))) return null;
    return {
      code: parsed.code,
      mode: typeof parsed.mode === "string" ? parsed.mode : "duel",
      guessMode: typeof parsed.guessMode === "string" ? parsed.guessMode : "standard",
      savedAt: Number(parsed.savedAt) || 0,
      expiresAt: Number(parsed.expiresAt),
    };
  } catch {
    return null;
  }
}

export function clearRejoin() {
  try {
    localStorage.removeItem(REJOIN_KEY);
  } catch {
    /* ignore */
  }
}
