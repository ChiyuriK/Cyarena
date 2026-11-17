/**
 * 应用入口：会话恢复、路由、全局事件。
 *
 * 路由采用 hash（`#/`、`#/room/CODE`、`#/leaderboard/mode`），另支持 `?room=CODE`
 * 直接观战。没有构建步骤，服务端直接从 apps/web/public 静态托管。
 */

import * as api from "./api.js";
import * as ws from "./ws.js";
import {
  store,
  on,
  emit,
  setLastRoom,
  loadLastRoom,
  saveRejoin,
  clearRejoin,
} from "./store.js";
import {
  initMockFromUrl,
  isMockMode,
  getSpectateCodeFromUrl,
  getRoomFromHash,
  getLeaderboardFromHash,
  getStatsFromHash,
  getHelpFromHash,
  getChangelogFromHash,
  getHistoryFromHash,
  getIdiomsFromHash,
  getDailyFromHash,
  getStreakFromHash,
  getFriendsFromHash,
  getNotificationsFromHash,
} from "./env.js";
import { LEAVE_GRACE_MS } from "./constants.js";
import { h, toast, initTheme, loadingBlock } from "./ui.js";
import { createLobbyView } from "./views/lobby.js";
import { createRoomView } from "./views/room.js";
import { createLeaderboardView } from "./views/leaderboard.js";
import { createStatsView } from "./views/stats.js";
import { createHelpView } from "./views/help.js";
import { createChangelogView } from "./views/changelog.js";
import { createHistoryView } from "./views/history.js";
import { createIdiomsView } from "./views/idioms.js";
import { createDailyView } from "./views/daily.js";
import { createStreakView } from "./views/streak.js";
import { createFriendsView } from "./views/friends.js";
import { createNotificationsView } from "./views/notifications.js";
import { openAuthModal } from "./views/auth.js";

const app = document.getElementById("app");
const DEFAULT_TITLE = "词影竞技场 Ciying Arena";

let activeView = null;
let activeName = "";
let booted = false;

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

function replaceHash(hash) {
  try {
    const url = new URL(location.href);
    // `?room=CODE` 只是进入观战的入口参数，进入/离开后从地址栏清理，避免刷新后重复观战。
    url.searchParams.delete("room");
    url.hash = hash;
    history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    location.hash = hash;
  }
}

function setDocumentTitle(title) {
  document.title = title;
}

function mount(name, factory) {
  if (activeView && typeof activeView.destroy === "function") activeView.destroy();
  activeView = factory();
  activeName = name;
  if (activeView && activeView.el) app.replaceChildren(activeView.el);
  app.dataset.view = name;
  if (name !== "room") setDocumentTitle(DEFAULT_TITLE);
  else setDocumentTitle(store.room ? `对局 ${store.room.code} 词影竞技场` : DEFAULT_TITLE);
}

function navigateLobby() {
  store.route = { name: "lobby" };
  replaceHash("#/");
  // 即使已经在大厅也重新挂载，确保退出登录等操作后 UI 完全刷新。
  mount("lobby", () => createLobbyView(ctx));
}

function navigateLeaderboard(mode = "duel") {
  store.route = { name: "leaderboard", mode };
  replaceHash(`#/leaderboard/${mode}`);
  mount("leaderboard", () => createLeaderboardView(ctx, mode));
}

function navigateStats() {
  store.route = { name: "stats" };
  replaceHash("#/stats");
  mount("stats", () => createStatsView(ctx));
}

function navigateHelp() {
  store.route = { name: "help" };
  replaceHash("#/help");
  mount("help", () => createHelpView(ctx));
}

function navigateChangelog() {
  store.route = { name: "changelog" };
  replaceHash("#/changelog");
  mount("changelog", () => createChangelogView(ctx));
}

function navigateHistory() {
  store.route = { name: "history" };
  replaceHash("#/history");
  mount("history", () => createHistoryView(ctx));
}

function navigateIdioms() {
  store.route = { name: "idioms" };
  replaceHash("#/idioms");
  mount("idioms", () => createIdiomsView(ctx));
}

function navigateDaily() {
  store.route = { name: "daily" };
  replaceHash("#/daily");
  mount("daily", () => createDailyView(ctx));
}

function navigateStreak(variant = "standard") {
  const safeVariant = ["standard", "free", "advanced"].includes(variant) ? variant : "standard";
  store.route = { name: "streak", variant: safeVariant };
  replaceHash(`#/streak/${safeVariant}`);
  mount("streak", () => createStreakView(ctx, safeVariant));
}

function navigateFriends() {
  store.route = { name: "friends" };
  replaceHash("#/friends");
  mount("friends", () => createFriendsView(ctx));
}

function navigateNotifications() {
  store.route = { name: "notifications" };
  replaceHash("#/notifications");
  mount("notifications", () => createNotificationsView(ctx));
}

function navigateRoom() {
  const code = (store.room && store.room.code) || (store.lastRoom && store.lastRoom.code) || "";
  store.route = { name: "room", code };
  if (code) replaceHash(`#/room/${code}`);
  mount("room", () => createRoomView(ctx));
}

/** 主动离开前记录“3 分钟内可重新加入”（只对局中/倒计时/结算中有效）。 */
function rememberRejoin() {
  const room = store.room;
  if (!room) return;
  if (room.viewerRole === "player" && room.mode !== "practice") {
    const active =
      room.status === "playing" || room.status === "roundEnd" || room.status === "countdown";
    if (active) {
      saveRejoin({
        code: room.code,
        mode: room.mode,
        guessMode: room.guessMode || "standard",
        savedAt: Date.now(),
        expiresAt: Date.now() + LEAVE_GRACE_MS,
      });
      return;
    }
  }
  clearRejoin();
}

/** 主动离开：对局中记录“3 分钟内可重新加入”，等待/结束则不记录。 */
function leaveCurrentRoom() {
  rememberRejoin();
  ws.leaveRoom();
  navigateLobby();
}

/* ------------------------------------------------------------------ */
/* 全局动作                                                            */
/* ------------------------------------------------------------------ */

const ctx = {
  goLobby: navigateLobby,
  goLeaderboard: navigateLeaderboard,
  goStats: navigateStats,
  goHelp: () => {
    if (store.route.name === "room" && store.room) {
      rememberRejoin();
      ws.leaveRoom();
    }
    navigateHelp();
  },
  goChangelog: () => {
    if (store.route.name === "room" && store.room) {
      rememberRejoin();
      ws.leaveRoom();
    }
    navigateChangelog();
  },
  goHistory: () => {
    if (store.route.name === "room" && store.room) {
      rememberRejoin();
      ws.leaveRoom();
    }
    navigateHistory();
  },
  goIdioms: () => {
    if (store.route.name === "room" && store.room) {
      rememberRejoin();
      ws.leaveRoom();
    }
    navigateIdioms();
  },
  goDaily: () => {
    if (store.route.name === "room" && store.room) {
      rememberRejoin();
      ws.leaveRoom();
    }
    navigateDaily();
  },
  goStreak: (variant) => {
    if (store.route.name === "room" && store.room) {
      rememberRejoin();
      ws.leaveRoom();
    }
    navigateStreak(variant);
  },
  goFriends: () => {
    if (store.route.name === "room" && store.room) {
      rememberRejoin();
      ws.leaveRoom();
    }
    navigateFriends();
  },
  goNotifications: () => {
    if (store.route.name === "room" && store.room) {
      rememberRejoin();
      ws.leaveRoom();
    }
    navigateNotifications();
  },
  accountDeleted: () => {
    ws.disconnect();
    api.clearSession();
    clearRejoin();
    store.token = "";
    store.user = null;
    clearClientState();
    emit("user", null);
    navigateLobby();
    toast("账号已注销");
  },
  goRoom: navigateRoom,
  openAuth: (tab) => openAuthModal(ctx, tab || "login"),
  leaveRoom: () => {
    leaveCurrentRoom();
  },
  logout: () => {
    doLogout();
  },
  onAuthSuccess: () => {
    handleAuthSuccess();
  },
};

/* ------------------------------------------------------------------ */
/* 会话                                                                */
/* ------------------------------------------------------------------ */

async function restoreSession() {
  store.token = api.getToken();
  store.user = api.getStoredUser();
  if (!store.token) {
    store.user = null;
    return;
  }
  try {
    const user = await api.me();
    store.user = user;
    api.saveUser(user);
    emit("user", user);
  } catch (error) {
    if (error && error.status === 401) {
      api.clearSession();
      store.token = "";
      store.user = null;
    } else if (!store.user) {
      // 网络暂时不可用：保留 token，等待 WebSocket 重连。
      store.user = null;
    }
  }
}

function clearClientState() {
  store.room = null;
  store.queue = null;
  store.rooms = [];
  store.roomsReady = false;
  setLastRoom(null);
  emit("room", null);
  emit("queue", null);
  emit("rooms", []);
}

async function doLogout() {
  if (store.route.name === "room") {
    ws.leaveRoom();
  }
  try {
    await api.logout();
  } catch {
    /* 即使服务端登出失败，本地也要清理 */
  }
  ws.disconnect();
  api.clearSession();
  clearRejoin();
  store.token = "";
  store.user = null;
  clearClientState();
  emit("user", null);
  navigateLobby();
  toast("已退出登录");
}

function handleAuthSuccess() {
  const returnRoute = store.route && store.route.name;
  if (store.route.name === "room") {
    ws.leaveRoom();
  }
  ws.disconnect();
  clearRejoin();
  clearClientState();
  ws.connect();
  if (returnRoute === "daily") {
    navigateDaily();
  } else {
    navigateLobby();
  }
}

function bootSplash() {
  return h(
    "div",
    { class: "boot-splash" },
    h("span", { class: "brand-mark brand-mark-xl", text: "词" }),
    loadingBlock("正在连接词影竞技场…"),
    isMockMode() ? h("p", { class: "boot-mock", text: "MOCK 预览模式，数据为本地模拟" }) : null,
  );
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

async function boot() {
  initMockFromUrl();
  initTheme();
  app.replaceChildren(bootSplash());

  /* URL 意图（在会话恢复前解析，避免闪一下大厅） */
  const spectateCode = getSpectateCodeFromUrl();
  const hashRoomCode = getRoomFromHash();
  const leaderboardMode = getLeaderboardFromHash();
  const statsRoute = getStatsFromHash();
  const streakVariant = getStreakFromHash();
  const friendsRoute = getFriendsFromHash();
  const notificationsRoute = getNotificationsFromHash();
  const storedLastRoom = loadLastRoom();

  await restoreSession();

  let route = { name: "lobby" };
  if (spectateCode) {
    setLastRoom({ code: spectateCode, role: "spectator" });
    route = { name: "room", code: spectateCode };
  } else if (hashRoomCode) {
    const canRestorePlayer =
      storedLastRoom &&
      storedLastRoom.code === hashRoomCode &&
      storedLastRoom.role === "player";
    setLastRoom(
      canRestorePlayer ? storedLastRoom : { code: hashRoomCode, role: "spectator" },
    );
    route = { name: "room", code: hashRoomCode };
  } else if (statsRoute) {
    route = { name: "stats" };
  } else if (getHelpFromHash()) {
    route = { name: "help" };
  } else if (getChangelogFromHash()) {
    route = { name: "changelog" };
  } else if (getHistoryFromHash()) {
    route = { name: "history" };
  } else if (getIdiomsFromHash()) {
    route = { name: "idioms" };
  } else if (getDailyFromHash()) {
    route = { name: "daily" };
  } else if (streakVariant) {
    route = { name: "streak", variant: streakVariant };
  } else if (friendsRoute) {
    route = { name: "friends" };
  } else if (notificationsRoute) {
    route = { name: "notifications" };
  } else if (leaderboardMode) {
    route = { name: "leaderboard", mode: leaderboardMode };
  } else if (storedLastRoom) {
    setLastRoom(storedLastRoom);
  }

  if (route.name === "room" && !store.token) {
    // 没有会话就不能连 WS：先留在大厅取昵称，拿到会话后自动恢复观战。
    store.route = { name: "lobby" };
    mount("lobby", () => createLobbyView(ctx));
    toast("观战前请先输入昵称或登录", "warn", 4200);
  } else if (route.name === "room") {
    store.route = route;
    mount("room", () => createRoomView(ctx));
  } else if (route.name === "stats") {
    store.route = route;
    mount("stats", () => createStatsView(ctx));
  } else if (route.name === "help") {
    store.route = route;
    mount("help", () => createHelpView(ctx));
  } else if (route.name === "changelog") {
    store.route = route;
    mount("changelog", () => createChangelogView(ctx));
  } else if (route.name === "history") {
    store.route = route;
    mount("history", () => createHistoryView(ctx));
  } else if (route.name === "idioms") {
    store.route = route;
    mount("idioms", () => createIdiomsView(ctx));
  } else if (route.name === "daily") {
    store.route = route;
    mount("daily", () => createDailyView(ctx));
  } else if (route.name === "streak") {
    store.route = route;
    mount("streak", () => createStreakView(ctx, route.variant));
  } else if (route.name === "friends") {
    store.route = route;
    mount("friends", () => createFriendsView(ctx));
  } else if (route.name === "notifications") {
    store.route = route;
    mount("notifications", () => createNotificationsView(ctx));
  } else if (route.name === "leaderboard") {
    store.route = route;
    mount("leaderboard", () => createLeaderboardView(ctx, route.mode));
  } else {
    store.route = { name: "lobby" };
    mount("lobby", () => createLobbyView(ctx));
  }

  if (store.token) ws.connect();
  booted = true;
}

/* ------------------------------------------------------------------ */
/* 全局事件                                                            */
/* ------------------------------------------------------------------ */

on("room", (state) => {
  if (!state) return;
  // 已经作为玩家进入/回到房间：清除“最近房间”重连入口。
  if (state.viewerRole === "player" || state.status === "matchEnd") clearRejoin();
  if (!store.route || store.route.name !== "room" || store.route.code !== state.code) {
    store.route = { name: "room", code: state.code };
    replaceHash(`#/room/${state.code}`);
    mount("room", () => createRoomView(ctx));
  }
});

on("restoreFailed", (detail) => {
  if (!booted) return;
  toast(
    detail && detail.message ? detail.message : "无法进入该房间（可能已结束或已销毁）",
    "error",
    4000,
  );
  if (!store.room && store.route && store.route.name === "room") {
    navigateLobby();
  }
});

on("authExpired", () => {
  if (!store.token && !store.user) return;
  ws.disconnect();
  api.clearSession();
  clearRejoin();
  store.token = "";
  store.user = null;
  clearClientState();
  emit("user", null);
  navigateLobby();
  toast("登录状态已失效，请重新输入昵称", "warn", 4200);
});

window.addEventListener("hashchange", () => {
  if (!booted) return;
  const hashRoom = getRoomFromHash();
  const leaderboardMode = getLeaderboardFromHash();
  const statsRoute = getStatsFromHash();
  const helpRoute = getHelpFromHash();
  const changelogRoute = getChangelogFromHash();
  const historyRoute = getHistoryFromHash();
  const idiomsRoute = getIdiomsFromHash();
  const dailyRoute = getDailyFromHash();
  const streakRoute = getStreakFromHash();
  const friendsRoute = getFriendsFromHash();
  const notificationsRoute = getNotificationsFromHash();
  const currentCode = store.room ? store.room.code : "";
  if (
    hashRoom &&
    hashRoom !== currentCode &&
    !(store.route.name === "room" && store.route.code === hashRoom)
  ) {
    if (store.room && store.room.code !== hashRoom) {
      rememberRejoin();
      ws.leaveRoom();
    }
    setLastRoom({ code: hashRoom, role: "spectator" });
    store.route = { name: "room", code: hashRoom };
    mount("room", () => createRoomView(ctx));
    ws.spectate(hashRoom);
    return;
  }
  if (statsRoute && store.route.name !== "stats") {
    if (store.route.name === "room") {
      rememberRejoin();
      ws.leaveRoom();
    }
    navigateStats();
    return;
  }
  if (helpRoute && store.route.name !== "help") {
    if (store.route.name === "room") {
      rememberRejoin();
      ws.leaveRoom();
    }
    navigateHelp();
    return;
  }
  if (changelogRoute && store.route.name !== "changelog") {
    if (store.route.name === "room") {
      rememberRejoin();
      ws.leaveRoom();
    }
    navigateChangelog();
    return;
  }
  if (historyRoute && store.route.name !== "history") {
    if (store.route.name === "room") {
      rememberRejoin();
      ws.leaveRoom();
    }
    navigateHistory();
    return;
  }
  if (idiomsRoute && store.route.name !== "idioms") {
    if (store.route.name === "room") {
      rememberRejoin();
      ws.leaveRoom();
    }
    navigateIdioms();
    return;
  }
  if (dailyRoute && store.route.name !== "daily") {
    if (store.route.name === "room") {
      rememberRejoin();
      ws.leaveRoom();
    }
    navigateDaily();
    return;
  }
  if (streakRoute && store.route.name !== "streak") {
    if (store.route.name === "room") {
      rememberRejoin();
      ws.leaveRoom();
    }
    navigateStreak(streakRoute);
    return;
  }
  if (friendsRoute && store.route.name !== "friends") {
    if (store.route.name === "room") {
      rememberRejoin();
      ws.leaveRoom();
    }
    navigateFriends();
    return;
  }
  if (notificationsRoute && store.route.name !== "notifications") {
    if (store.route.name === "room") {
      rememberRejoin();
      ws.leaveRoom();
    }
    navigateNotifications();
    return;
  }
  if (leaderboardMode && store.route.name !== "leaderboard") {
    if (store.route.name === "room") {
      rememberRejoin();
      ws.leaveRoom();
    }
    navigateLeaderboard(leaderboardMode);
    return;
  }
  if (
    !hashRoom &&
    !leaderboardMode &&
    !statsRoute &&
    !helpRoute &&
    !changelogRoute &&
    !historyRoute &&
    !idiomsRoute &&
    !dailyRoute &&
    !streakRoute &&
    !friendsRoute &&
    !notificationsRoute &&
    store.route.name !== "lobby"
  ) {
    if (store.route.name === "room") {
      rememberRejoin();
      ws.leaveRoom();
    }
    navigateLobby();
  }
});

boot();
