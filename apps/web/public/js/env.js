/**
 * 运行环境 / URL 解析辅助。
 *
 * 默认始终连接真实 REST + WebSocket 接口；只有显式带上 `?mock=1` 时才开启
 * 本地 mock 预览模式（用于后端未就绪时查看界面），`?mock=0` 可关闭。
 */

const MOCK_KEY = "ciying.mock";
const ROOM_CODE_RE = /^\d{5}$/;

export function isMockMode() {
  try {
    return sessionStorage.getItem(MOCK_KEY) === "1";
  } catch {
    return false;
  }
}

export function initMockFromUrl() {
  try {
    const params = new URLSearchParams(location.search);
    const value = params.get("mock");
    if (value === "1") sessionStorage.setItem(MOCK_KEY, "1");
    else if (value === "0") sessionStorage.removeItem(MOCK_KEY);
  } catch {
    /* sessionStorage 可能被隐私模式禁用，忽略即可 */
  }
}

export function normalizeRoomCode(value) {
  const code = String(value || "").trim().toUpperCase();
  return ROOM_CODE_RE.test(code) ? code : "";
}

/** `?room=CODE` —— 直接以观战身份进入房间。 */
export function getSpectateCodeFromUrl() {
  try {
    const params = new URLSearchParams(location.search);
    return normalizeRoomCode(params.get("room"));
  } catch {
    return "";
  }
}

/** `#/room/CODE` —— 房间链接。 */
export function getRoomFromHash() {
  const match = /^#\/room\/(\d{5})\/?$/.exec(location.hash || "");
  return match ? normalizeRoomCode(match[1]) : "";
}

/** `#/leaderboard` 或 `#/leaderboard/ffa3`。 */
export function getLeaderboardFromHash() {
  const match = /^#\/leaderboard(?:\/(duel|ffa3|team2v2))?\/?$/.exec(location.hash || "");
  return match ? match[1] || "duel" : "";
}

/** `#/stats`。 */
export function getStatsFromHash() {
  return /^#\/stats\/?$/.test(location.hash || "");
}

/** `#/help`。 */
export function getHelpFromHash() {
  return /^#\/help\/?$/.test(location.hash || "");
}

/** `#/changelog`。 */
export function getChangelogFromHash() {
  return /^#\/changelog\/?$/.test(location.hash || "");
}

/** `#/history`。 */
export function getHistoryFromHash() {
  return /^#\/history\/?$/.test(location.hash || "");
}

/** `#/idioms`。 */
export function getIdiomsFromHash() {
  return /^#\/idioms\/?$/.test(location.hash || "");
}

/** `#/daily`。 */
export function getDailyFromHash() {
  return /^#\/daily\/?$/.test(location.hash || "");
}

/** `#/streak` 或 `#/streak/free`，返回变体或空字符串。 */
export function getStreakFromHash() {
  const match = /^#\/streak(?:\/(standard|free|advanced))?\/?$/.exec(location.hash || "");
  return match ? match[1] || "standard" : "";
}

/** `#/friends`。 */
export function getFriendsFromHash() {
  return /^#\/friends\/?$/.test(location.hash || "");
}

/** `#/notifications`。 */
export function getNotificationsFromHash() {
  return /^#\/notifications\/?$/.test(location.hash || "");
}

export function isMockPreview() {
  return isMockMode();
}
