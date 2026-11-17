/**
 * REST 客户端 + 本地会话持久化。
 *
 * 服务端接口（见 SPEC.md 第 4、5、6 节）：
 *   POST /api/session/guest   { name } -> { token, user }
 *   POST /api/auth/register   { username, password, name? } -> { token, user }
 *   POST /api/auth/login      { username, password } -> { token, user }
 *   POST /api/auth/logout
 *   GET  /api/me              -> PublicUser（兼容 { user } 包装）
 *   GET  /api/rooms           -> RoomSummary[]
 *   GET  /api/leaderboard?mode=duel|ffa3|team2v2
 *   GET  /api/matches/recent?limit=20
 *   GET  /api/stats/me        -> { total, modes }（Bearer）
 */

import { isMockMode } from "./env.js";
import {
  mockGuest,
  mockLogin,
  mockRegister,
  mockLogout,
  mockMe,
  mockRooms,
  mockLeaderboard,
  mockStats,
  mockSiteStats,
  mockMyMatches,
  mockUpdateProfile,
  mockMyIdioms,
  mockDailyState,
  mockDailyGuess,
  mockStreakState,
  mockStreakStart,
  mockStreakGuess,
  mockStreakQuit,
  mockStreakLeaderboard,
  mockStreakStats,
  mockSearchUsers,
  mockFriends,
  mockFriendRequest,
  mockFriendRespond,
  mockRemoveFriend,
  mockFriendProfile,
  mockSendFriendMessage,
  mockFriendMessages,
  mockInviteFriend,
  mockNotifications,
  mockReadNotifications,
  mockPrivacy,
  mockUpdatePrivacy,
  mockDeleteAccount,
} from "./mock.js";

const TOKEN_KEY = "ciying.token";
const USER_KEY = "ciying.user";
const GUEST_NAME_KEY = "ciying.guestName";

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status || 0;
  }
}

/* ------------------------------------------------------------------ */
/* 会话持久化                                                          */
/* ------------------------------------------------------------------ */

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

export function getStoredUser() {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.id !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveSession(token, user) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch {
    /* ignore */
  }
}

export function saveUser(user) {
  try {
    if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
    else localStorage.removeItem(USER_KEY);
  } catch {
    /* ignore */
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch {
    /* ignore */
  }
}

export function getRememberedName() {
  try {
    return localStorage.getItem(GUEST_NAME_KEY) || "";
  } catch {
    return "";
  }
}

export function rememberName(name) {
  try {
    localStorage.setItem(GUEST_NAME_KEY, String(name || "").slice(0, 16));
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* 基础请求                                                            */
/* ------------------------------------------------------------------ */

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    done() {
      clearTimeout(timer);
    },
  };
}

async function request(path, options = {}) {
  const { method = "GET", body, auth = true, timeout = 12000 } = options;
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const token = getToken();
  if (auth && token) headers.Authorization = `Bearer ${token}`;

  const gauge = withTimeout(timeout);
  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: gauge.signal,
      credentials: "same-origin",
    });
  } catch (error) {
    gauge.done();
    if (error && error.name === "AbortError") {
      throw new ApiError("请求超时，请检查网络", 0);
    }
    throw new ApiError("无法连接服务器，请稍后再试", 0);
  }
  gauge.done();

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text.slice(0, 200) };
    }
  }

  if (!response.ok) {
    const message =
      (data && (data.message || data.error)) || `请求失败（HTTP ${response.status}）`;
    throw new ApiError(String(message), response.status);
  }
  return data;
}

/* ------------------------------------------------------------------ */
/* 演示数据（仅 ?mock=1 时启用，默认走真实接口）                        */
/* ------------------------------------------------------------------ */

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeSession(data) {
  if (!data || typeof data.token !== "string" || !data.token) {
    throw new ApiError("服务器返回的会话无效", 0);
  }
  if (!data.user || typeof data.user.id !== "string") {
    throw new ApiError("服务器返回的会话缺少用户信息", 0);
  }
  return { token: data.token, user: data.user };
}

function normalizeUser(data) {
  if (data && data.user && typeof data.user.id === "string") return data.user;
  if (data && typeof data.id === "string") return data;
  throw new ApiError("无法获取当前用户", 0);
}

/* ------------------------------------------------------------------ */
/* 对外接口                                                            */
/* ------------------------------------------------------------------ */

export async function guestSession(name) {
  if (isMockMode()) {
    await delay(160);
    return normalizeSession(mockGuest(name));
  }
  const data = await request("/api/session/guest", {
    method: "POST",
    body: { name },
    auth: false,
  });
  return normalizeSession(data);
}

export async function login(username, password) {
  if (isMockMode()) {
    await delay(260);
    return normalizeSession(mockLogin(username));
  }
  const data = await request("/api/auth/login", {
    method: "POST",
    body: { username, password },
    auth: false,
  });
  return normalizeSession(data);
}

export async function register(username, password, name) {
  if (isMockMode()) {
    await delay(320);
    return normalizeSession(mockRegister(username, name));
  }
  const body = { username, password };
  if (name) body.name = name;
  const data = await request("/api/auth/register", { method: "POST", body, auth: false });
  return normalizeSession(data);
}

export async function logout() {
  if (isMockMode()) {
    await delay(80);
    mockLogout();
    return;
  }
  await request("/api/auth/logout", { method: "POST" });
}

export async function me() {
  if (isMockMode()) {
    await delay(80);
    return normalizeUser(mockMe());
  }
  return normalizeUser(await request("/api/me"));
}

export async function fetchRooms() {
  if (isMockMode()) {
    await delay(120);
    return mockRooms();
  }
  const data = await request("/api/rooms", { auth: false });
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.rooms)) return data.rooms;
  return [];
}

export async function fetchLeaderboard(mode) {
  if (isMockMode()) {
    await delay(180);
    return mockLeaderboard(mode);
  }
  const data = await request(`/api/leaderboard?mode=${encodeURIComponent(mode)}`, {
    auth: false,
  });
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.rows)) return data.rows;
  return [];
}

export async function fetchRecentMatches(limit = 20) {
  if (isMockMode()) {
    await delay(120);
    return [];
  }
  const data = await request(`/api/matches/recent?limit=${encodeURIComponent(limit)}`, {
    auth: false,
  });
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.matches)) return data.matches;
  return [];
}

/** 个人统计（需要登录；游客会收到 401）。 */
export async function fetchMyStats() {
  if (isMockMode()) {
    await delay(180);
    return mockStats();
  }
  const data = await request("/api/stats/me");
  if (!data || typeof data !== "object" || !data.total || !data.modes) {
    throw new ApiError("统计接口返回格式异常", 0);
  }
  return data;
}

/** 首页站点统计。 */
export async function fetchSiteStats() {
  if (isMockMode()) {
    await delay(80);
    return mockSiteStats();
  }
  const data = await request("/api/site", { auth: false });
  return {
    registeredUsers: Number(data && data.registeredUsers) || 0,
    onlineUsers: Number(data && data.onlineUsers) || 0,
  };
}

/** 我的战绩（注册用户）。 */
export async function fetchMyMatches(limit = 20) {
  if (isMockMode()) {
    await delay(150);
    return mockMyMatches();
  }
  const data = await request(`/api/me/matches?limit=${encodeURIComponent(limit)}`);
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.rows)) return data.rows;
  if (data && Array.isArray(data.matches)) return data.matches;
  return [];
}

/** 最近猜出过的成语（注册用户）。 */
export async function fetchMyIdioms(limit = 30) {
  if (isMockMode()) {
    await delay(150);
    return mockMyIdioms();
  }
  const data = await request(`/api/me/idioms?limit=${encodeURIComponent(limit)}`);
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.rows)) return data.rows;
  return [];
}

/** 每日一题（登录可选）。 */
export async function fetchDaily() {
  if (isMockMode()) {
    await delay(160);
    return mockDailyState();
  }
  return request("/api/daily");
}

/** 提交每日一题答案。 */
export async function guessDaily(word) {
  if (isMockMode()) {
    await delay(180);
    return mockDailyGuess(word);
  }
  return request("/api/daily/guess", { method: "POST", body: { word } });
}

/* ------------------------------------------------------------------ */
/* 连胜挑战                                                            */
/* ------------------------------------------------------------------ */

export async function fetchStreak(variant) {
  if (isMockMode()) {
    await delay(100);
    return mockStreakState(variant);
  }
  return request(`/api/streak?variant=${encodeURIComponent(variant)}`);
}

export async function startStreak(variant) {
  if (isMockMode()) {
    await delay(140);
    return mockStreakStart(variant);
  }
  return request("/api/streak/start", { method: "POST", body: { variant } });
}

export async function guessStreak(word) {
  if (isMockMode()) {
    await delay(160);
    return mockStreakGuess(word);
  }
  return request("/api/streak/guess", { method: "POST", body: { word } });
}

export async function quitStreak() {
  if (isMockMode()) {
    await delay(100);
    return mockStreakQuit();
  }
  return request("/api/streak/quit", { method: "POST" });
}

export async function fetchStreakLeaderboard(variant) {
  if (isMockMode()) {
    await delay(140);
    return mockStreakLeaderboard(variant);
  }
  const data = await request(`/api/streak/leaderboard?variant=${encodeURIComponent(variant)}`);
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.rows)) return data.rows;
  return [];
}

export async function fetchStreakStats() {
  if (isMockMode()) {
    await delay(120);
    return mockStreakStats();
  }
  return request("/api/streak/stats");
}

/* ------------------------------------------------------------------ */
/* 好友 / 通知 / 隐私 / 注销                                            */
/* ------------------------------------------------------------------ */

export async function searchUsers(query) {
  if (isMockMode()) {
    await delay(120);
    return mockSearchUsers(query);
  }
  const data = await request(`/api/users/search?q=${encodeURIComponent(query)}`);
  return Array.isArray(data && data.rows) ? data.rows : [];
}

export async function fetchFriends() {
  if (isMockMode()) {
    await delay(120);
    return mockFriends();
  }
  return request("/api/friends");
}

export async function sendFriendRequest(userId) {
  if (isMockMode()) {
    await delay(120);
    return mockFriendRequest(userId);
  }
  return request("/api/friends/request", { method: "POST", body: { userId } });
}

export async function acceptFriendRequest(requestId) {
  if (isMockMode()) {
    await delay(100);
    return mockFriendRespond(requestId, true);
  }
  return request("/api/friends/accept", { method: "POST", body: { requestId } });
}

export async function rejectFriendRequest(requestId) {
  if (isMockMode()) {
    await delay(100);
    return mockFriendRespond(requestId, false);
  }
  return request("/api/friends/reject", { method: "POST", body: { requestId } });
}

export async function removeFriend(userId) {
  if (isMockMode()) {
    await delay(100);
    return mockRemoveFriend(userId);
  }
  return request(`/api/friends/${encodeURIComponent(userId)}`, { method: "DELETE" });
}

export async function fetchFriendProfile(userId) {
  if (isMockMode()) {
    await delay(120);
    return mockFriendProfile(userId);
  }
  return request(`/api/friends/${encodeURIComponent(userId)}`);
}

export async function sendFriendMessage(userId, text) {
  if (isMockMode()) {
    await delay(100);
    return mockSendFriendMessage(userId, text);
  }
  return request("/api/friends/message", { method: "POST", body: { userId, text } });
}

export async function fetchFriendMessages(userId, limit = 50) {
  if (isMockMode()) {
    await delay(100);
    return mockFriendMessages(userId);
  }
  return request(
    `/api/friends/${encodeURIComponent(userId)}/messages?limit=${encodeURIComponent(limit)}`,
  );
}

export async function inviteFriend(userId) {
  if (isMockMode()) {
    await delay(120);
    return mockInviteFriend(userId);
  }
  return request("/api/friends/invite", { method: "POST", body: { userId } });
}

export async function fetchNotifications() {
  if (isMockMode()) {
    await delay(100);
    return mockNotifications();
  }
  return request("/api/notifications");
}

export async function markNotificationsRead(id = null) {
  if (isMockMode()) {
    await delay(80);
    return mockReadNotifications(id);
  }
  return request("/api/notifications/read", {
    method: "POST",
    body: id ? { id } : { all: true },
  });
}

export async function fetchPrivacy() {
  if (isMockMode()) {
    await delay(80);
    return mockPrivacy();
  }
  return request("/api/me/privacy");
}

export async function updatePrivacy(showStatsToFriends) {
  if (isMockMode()) {
    await delay(100);
    return mockUpdatePrivacy(showStatsToFriends);
  }
  return request("/api/me/privacy", {
    method: "PATCH",
    body: { showStatsToFriends: Boolean(showStatsToFriends) },
  });
}

export async function deleteAccount() {
  if (isMockMode()) {
    await delay(160);
    return mockDeleteAccount();
  }
  return request("/api/me", { method: "DELETE" });
}

/** 修改昵称/头像。后端可能只接受 PATCH 或 POST，两个都兼容。 */
export async function updateProfile(payload) {
  if (isMockMode()) {
    await delay(180);
    return normalizeUser(mockUpdateProfile(payload));
  }
  let data;
  try {
    data = await request("/api/me/profile", { method: "PATCH", body: payload });
  } catch (error) {
    if (error && (error.status === 404 || error.status === 405)) {
      data = await request("/api/me/profile", { method: "POST", body: payload });
    } else {
      throw error;
    }
  }
  return normalizeUser(data && data.user ? data.user : data);
}
