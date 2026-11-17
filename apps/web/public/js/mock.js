/**
 * 本地预览 Mock（仅在 URL 带 `?mock=1` 时启用）。
 *
 * 默认情况下 api.js / ws.js 都走真实 REST + WebSocket；这个模块只负责在没有后端时
 * 提供一份可交互的假数据，方便纯前端调试。棋盘笔画使用合成的示意路径（非真实
 * datasets/strokes.json），因此观感仅供预览，不能作为真实对局依据。
 */

import {
  MODE_META,
  MODES,
  RANKED_MODES,
  ROWS_PER_ROUND,
  TARGET_SCORE,
  MAX_ROUNDS,
  ROUND_DURATION_MS,
  ROUND_END_DELAY_MS,
  SET_END_DELAY_MS,
  COUNTDOWN_MS,
  CHAT_MAX,
  DUEL_POINTS_TO_WIN,
  DUEL_POINT_LEAD,
  DUEL_DEFAULT_BEST_OF,
  setsToWinForBestOf,
  isDuelBestOf,
  FFA_TARGET_SCORE,
  LEAVE_GRACE_MS,
  GUESS_COOLDOWN_MS,
  DEFAULT_GUESS_MODE,
  isGuessMode,
  DEFAULT_DICTIONARY,
  isDictionaryMode,
  DEFAULT_POINTS_TO_WIN,
  defaultPointsForMode,
  normalizeRoomRules,
  modeUsesSets,
} from "./constants.js";

let mockUser = null;
let counter = 0;

const MOCK_ANSWER = "山清水秀";
const MOCK_ANSWER_EXPLANATION = "形容山水风景清秀明丽，也常用来夸赞自然景色。";
const DAILY_ANSWER = "难上加难";
const DAILY_EXPLANATION = "形容事情非常困难，难度在原有基础上进一步增加。";
let mockDailyData = null;

function shanghaiDateParts() {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
  const parts = formatter.formatToParts(new Date());
  const pick = (type) => (parts.find((item) => item.type === type) || {}).value || "";
  const date = `${pick("year")}-${pick("month")}-${pick("day")}`;
  const weekdayText = pick("weekday");
  const weekdayMap = { Sun: 7, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { date, weekday: weekdayMap[weekdayText] || 1 };
}

function createMockDaily() {
  const { date, weekday } = shanghaiDateParts();
  const now = Date.now();
  return {
    date,
    weekday,
    isCommonDay: weekday === 7,
    intro:
      "题库比匹配更难。周一至周六使用全词库中的非常用词，周日使用常用词库。全服同一题，每天东八区 00:00 换题，不限猜测次数。",
    rows: [],
    solved: false,
    answer: null,
    explanation: null,
    attempts: 0,
    durationMs: null,
    streakDays: 3,
    startedAt: now,
    me: null,
    leaderboard: [
      { rank: 1, userId: "daily-1", name: "折枝", avatar: "🦊", attempts: 6, solvedAt: now - 900_000, durationMs: 83_000 },
      { rank: 2, userId: "daily-2", name: "问渠", avatar: "🐱", attempts: 8, solvedAt: now - 700_000, durationMs: 121_000 },
      { rank: 3, userId: "daily-3", name: "听雨", avatar: "🐼", attempts: 11, solvedAt: now - 500_000, durationMs: 167_000 },
      { rank: 4, userId: "daily-4", name: "墨客", avatar: "🐯", attempts: 14, solvedAt: now - 300_000, durationMs: 240_000 },
    ],
  };
}

function ensureMockDaily() {
  const { date } = shanghaiDateParts();
  if (!mockDailyData || mockDailyData.date !== date) mockDailyData = createMockDaily();
  return mockDailyData;
}

export function mockDailyState() {
  const daily = ensureMockDaily();
  return JSON.parse(JSON.stringify(daily));
}

export function mockDailyGuess(word) {
  const daily = ensureMockDaily();
  if (!mockUser) {
    const error = new Error("请先登录后作答");
    error.status = 401;
    throw error;
  }
  if (mockUser.isGuest) {
    const error = new Error("注册用户才能参与每日一题");
    error.status = 403;
    throw error;
  }
  const guess = String(word || "").trim();
  if (!/^[\u4e00-\u9fff]{4}$/.test(guess)) {
    const error = new Error("请输入四个汉字");
    error.status = 400;
    throw error;
  }
  const answerChars = Array.from(DAILY_ANSWER);
  const guessChars = Array.from(guess);
  const summary = guessChars.map((char, index) => {
    if (char === answerChars[index]) return "green";
    if (answerChars.includes(char)) return "yellow";
    return "gray";
  });
  daily.rows.push({ word: guess, tiles: buildTiles(DAILY_ANSWER, guess), summary });
  daily.attempts += 1;
  if (guess === DAILY_ANSWER && !daily.solved) {
    daily.solved = true;
    daily.answer = DAILY_ANSWER;
    daily.explanation = DAILY_EXPLANATION;
    daily.durationMs = Math.max(1000, Date.now() - daily.startedAt);
    daily.streakDays = (Number(daily.streakDays) || 0) + 1;
    const me = {
      rank: 1,
      attempts: daily.attempts,
      solvedAt: Date.now(),
      durationMs: daily.durationMs,
    };
    daily.me = me;
    daily.leaderboard = daily.leaderboard
      .map((row) => ({ ...row, rank: (Number(row.rank) || 0) + 1 }))
      .concat([
        {
          rank: 1,
          userId: mockUser.id,
          name: mockUser.name,
          avatar: mockUser.avatar || "🐼",
          attempts: daily.attempts,
          solvedAt: me.solvedAt,
          durationMs: me.durationMs,
        },
      ]);
  }
  return JSON.parse(JSON.stringify(daily));
}
const STREAK_BEST = { standard: 7, free: 9, advanced: 4 };
const STREAK_STATS = { runs: 12, solved: 39, best: 9, totalSolveMs: 187000, fastestSolveMs: 2400 };
let mockStreak = null;
let mockStreakVariant = "standard";

function freshStreakState(variant) {
  return {
    variant,
    status: "ended",
    rows: [],
    maxRows: 6,
    remainingRows: 6,
    streak: 0,
    best: STREAK_BEST[variant] || 0,
    startedAt: Date.now(),
    nextAt: 0,
    lastSolveMs: null,
    averageSolveMs: STREAK_STATS.solved > 0 ? STREAK_STATS.totalSolveMs / STREAK_STATS.solved : 0,
    fastestSolveMs: STREAK_STATS.fastestSolveMs,
    answer: null,
    explanation: null,
    message: "选择变体开始挑战",
  };
}

function ensureMockStreak(variant) {
  if (!mockStreak || mockStreakVariant !== variant) {
    mockStreakVariant = variant;
    mockStreak = freshStreakState(variant);
  }
  return mockStreak;
}

export function mockStreakState(variant) {
  return JSON.parse(JSON.stringify(ensureMockStreak(variant)));
}

export function mockStreakStart(variant) {
  mockStreakVariant = variant;
  mockStreak = freshStreakState(variant);
  mockStreak.status = "playing";
  mockStreak.message = "开始挑战，答对进入下一题";
  return JSON.parse(JSON.stringify(mockStreak));
}

export function mockStreakGuess(word) {
  const state = ensureMockStreak(mockStreakVariant);
  if (state.status !== "playing") {
    const error = new Error("当前没有进行中的挑战");
    error.status = 400;
    throw error;
  }
  if (Number(state.nextAt) > Date.now()) {
    const error = new Error("休息 1 秒后再猜");
    error.status = 400;
    throw error;
  }
  const guess = String(word || "").trim();
  if (!/^[\u4e00-\u9fff]{4}$/.test(guess)) {
    const error = new Error("请输入四个汉字");
    error.status = 400;
    throw error;
  }
  const correct = guess === MOCK_ANSWER;
  state.rows.push({ word: guess, tiles: buildTiles(MOCK_ANSWER, guess) });
  state.remainingRows = Math.max(0, 6 - state.rows.length);
  if (correct) {
    const solveMs = Math.max(1, Date.now() - (state.startedAt || Date.now()));
    state.streak += 1;
    state.best = Math.max(state.best, state.streak);
    state.lastSolveMs = solveMs;
    STREAK_BEST[mockStreakVariant] = Math.max(STREAK_BEST[mockStreakVariant] || 0, state.best);
    STREAK_STATS.best = Math.max(STREAK_STATS.best, state.best);
    STREAK_STATS.solved += 1;
    STREAK_STATS.totalSolveMs += solveMs;
    STREAK_STATS.fastestSolveMs =
      STREAK_STATS.fastestSolveMs > 0 ? Math.min(STREAK_STATS.fastestSolveMs, solveMs) : solveMs;
    state.averageSolveMs = STREAK_STATS.totalSolveMs / STREAK_STATS.solved;
    state.fastestSolveMs = STREAK_STATS.fastestSolveMs;
    state.rows = [];
    state.remainingRows = 6;
    state.startedAt = Date.now() + 1000;
    state.nextAt = state.startedAt;
    state.message = `答对了，用时 ${(solveMs / 1000).toFixed(1)} 秒，当前连胜 ${state.streak} 题，休息 1 秒后继续`;
    state.answer = null;
    state.explanation = null;
    return JSON.parse(JSON.stringify(state));
  }
  if (state.rows.length >= 6) {
    state.status = "ended";
    state.answer = MOCK_ANSWER;
    state.explanation = MOCK_ANSWER_EXPLANATION;
    state.message = `挑战结束，本局连胜 ${state.streak}`;
    STREAK_STATS.runs += 1;
    STREAK_STATS.solved += state.streak;
  }
  return JSON.parse(JSON.stringify(state));
}

export function mockStreakQuit() {
  const state = ensureMockStreak(mockStreakVariant);
  if (state.status === "playing") {
    state.status = "ended";
    state.answer = MOCK_ANSWER;
    state.explanation = MOCK_ANSWER_EXPLANATION;
    state.message = `已结束挑战，本局连胜 ${state.streak}`;
    STREAK_STATS.runs += 1;
    STREAK_STATS.solved += state.streak;
  }
  return JSON.parse(JSON.stringify(state));
}

export function mockStreakLeaderboard(variant) {
  const names = ["折枝", "问渠", "听雨", "墨客", "小满", "空山"];
  const avatars = ["🦊", "🐱", "🐼", "🐯", "🦁", "🐸"];
  const base = variant === "free" ? 12 : variant === "advanced" ? 6 : 9;
  return names.map((name, index) => ({
    rank: index + 1,
    userId: `streak-${variant}-${index}`,
    name,
    avatar: avatars[index],
    best: Math.max(1, base - index),
  }));
}

export function mockStreakStats() {
  return { ...STREAK_STATS };
}
const MOCK_CODES = ["24680", "13579", "86420"];

/* ------------------------------------------------------------------ */
/* 好友 / 通知 / 隐私 / 注销 Mock                                      */
/* ------------------------------------------------------------------ */

let mockFriendIds = ["friend-1", "friend-2"];
let mockIncoming = [
  {
    id: "request-1",
    direction: "incoming",
    user: { id: "request-user-1", name: "听雨", avatar: "🐼", online: true },
    createdAt: Date.now() - 600_000,
  },
];
let mockOutgoing = [];
let mockReadState = new Map();
let mockPrivacyShow = true;
const MOCK_FRIEND_USERS = [
  { id: "friend-1", name: "折枝", avatar: "🦊", online: true },
  { id: "friend-2", name: "问渠", avatar: "🐱", online: false },
  { id: "request-user-1", name: "听雨", avatar: "🐼", online: true },
  { id: "search-user-1", name: "小满", avatar: "🦁", online: true },
];
const mockConversations = new Map([
  [
    "friend-1",
    [
      { id: "m1", fromId: "friend-1", toId: "me", fromName: "折枝", text: "晚上来一局？", ts: Date.now() - 300_000, read: true },
      { id: "m2", fromId: "me", toId: "friend-1", fromName: "我", text: "好，等我开房。", ts: Date.now() - 200_000, read: true },
    ],
  ],
]);

function requireMockRegistered() {
  if (!mockUser) {
    const error = new Error("请先登录");
    error.status = 401;
    throw error;
  }
  if (mockUser.isGuest) {
    const error = new Error("注册用户才能使用好友功能");
    error.status = 403;
    throw error;
  }
}

function friendUserView(user) {
  return { id: user.id, name: user.name, avatar: user.avatar, online: Boolean(user.online) };
}

function mockNotifyList() {
  return [
    {
      id: "notif-request-1",
      type: "friend_request",
      title: "好友申请",
      text: "听雨 请求添加你为好友",
      createdAt: Date.now() - 600_000,
      read: Boolean(mockReadState.get("notif-request-1")),
      userId: "request-user-1",
    },
    {
      id: "notif-message-1",
      type: "friend_message",
      title: "私信",
      text: "折枝：晚上来一局？",
      createdAt: Date.now() - 300_000,
      read: Boolean(mockReadState.get("notif-message-1")),
      userId: "friend-1",
    },
    {
      id: "notif-invite-1",
      type: "game_invite",
      title: "对局邀请",
      text: "折枝 邀请你加入房间 24680",
      createdAt: Date.now() - 120_000,
      read: Boolean(mockReadState.get("notif-invite-1")),
      userId: "friend-1",
      roomCode: "24680",
    },
  ];
}

export function mockSearchUsers(query) {
  const q = String(query || "").trim();
  return MOCK_FRIEND_USERS.filter((user) => !q || user.name.includes(q)).map((user) => {
    const relation = mockFriendIds.includes(user.id)
      ? "friend"
      : mockIncoming.some((item) => item.user.id === user.id)
        ? "incoming"
        : mockOutgoing.some((item) => item.user.id === user.id)
          ? "outgoing"
          : "none";
    return { id: user.id, name: user.name, avatar: user.avatar, relation };
  });
}

export function mockFriends() {
  return {
    friends: mockFriendIds
      .map((id) => MOCK_FRIEND_USERS.find((user) => user.id === id))
      .filter(Boolean)
      .map(friendUserView),
    incoming: mockIncoming.map((item) => ({ ...item, user: friendUserView(item.user) })),
    outgoing: mockOutgoing.map((item) => ({ ...item, user: friendUserView(item.user) })),
    notifications: mockNotifyList(),
    unread: mockNotifyList().filter((item) => !item.read).length,
  };
}

export function mockFriendRequest(userId) {
  requireMockRegistered();
  const user = MOCK_FRIEND_USERS.find((item) => item.id === userId);
  if (!user) {
    const error = new Error("用户不存在");
    error.status = 404;
    throw error;
  }
  if (mockFriendIds.includes(userId)) throw new Error("你们已经是好友了");
  if (!mockOutgoing.some((item) => item.user.id === userId)) {
    mockOutgoing.push({
      id: `request-out-${Date.now()}`,
      direction: "outgoing",
      user: friendUserView(user),
      createdAt: Date.now(),
    });
  }
  return { ok: true };
}

export function mockFriendRespond(requestId, accept) {
  requireMockRegistered();
  const index = mockIncoming.findIndex((item) => item.id === requestId);
  if (index < 0) throw new Error("好友申请不存在");
  const request = mockIncoming[index];
  mockIncoming.splice(index, 1);
  mockReadState.set("notif-request-1", true);
  if (accept && !mockFriendIds.includes(request.user.id)) mockFriendIds.push(request.user.id);
  return { ok: true };
}

export function mockRemoveFriend(userId) {
  requireMockRegistered();
  mockFriendIds = mockFriendIds.filter((id) => id !== userId);
  return { ok: true };
}

export function mockFriendProfile(userId) {
  requireMockRegistered();
  const user = MOCK_FRIEND_USERS.find((item) => item.id === userId);
  if (!user) throw new Error("用户不存在");
  return {
    user: friendUserView(user),
    statsVisible: mockPrivacyShow,
    stats: mockPrivacyShow ? mockStats().total : null,
  };
}

export function mockSendFriendMessage(userId, text) {
  requireMockRegistered();
  const list = mockConversations.get(userId) || [];
  const message = {
    id: `m-${Date.now()}`,
    fromId: mockUser.id,
    toId: userId,
    fromName: mockUser.name,
    text: String(text || ""),
    ts: Date.now(),
    read: true,
  };
  list.push(message);
  mockConversations.set(userId, list);
  return { ok: true, message };
}

export function mockFriendMessages(userId) {
  requireMockRegistered();
  return { messages: [...(mockConversations.get(userId) || [])], unread: 0 };
}

export function mockInviteFriend(userId) {
  requireMockRegistered();
  return { ok: true, roomCode: "24680", userId };
}

export function mockNotifications() {
  const list = mockNotifyList();
  return { notifications: list, unread: list.filter((item) => !item.read).length };
}

export function mockReadNotifications(id) {
  if (id) mockReadState.set(id, true);
  else for (const item of mockNotifyList()) mockReadState.set(item.id, true);
  const unread = mockNotifyList().filter((item) => !item.read).length;
  return { ok: true, unread };
}

export function mockPrivacy() {
  return { showStatsToFriends: mockPrivacyShow };
}

export function mockUpdatePrivacy(show) {
  mockPrivacyShow = Boolean(show);
  return { showStatsToFriends: mockPrivacyShow };
}

export function mockDeleteAccount() {
  mockUser = null;
  mockFriendIds = [];
  mockIncoming = [];
  mockOutgoing = [];
  return { ok: true };
}

const MOCK_DICTIONARY = new Set([  MOCK_ANSWER,
  "风和日丽",
  "山高水长",
  "坚定不移",
  "一心一意",
  "春暖花开",
  "天长地久",
  "海阔天空",
  "一鸣惊人",
  "画蛇添足",
  "亡羊补牢",
  "守株待兔",
  "掩耳盗铃",
  "刻舟求剑",
  "井底之蛙",
  "对牛弹琴",
  "望梅止渴",
  "愚公移山",
]);

function nearestMockWord(word) {
  let best = "";
  let bestDistance = 3;
  for (const candidate of MOCK_DICTIONARY) {
    if (candidate === word || candidate.length !== word.length) continue;
    let distance = 0;
    for (let index = 0; index < word.length; index += 1) {
      if (candidate[index] !== word[index]) distance += 1;
    }
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return bestDistance <= 1 ? best : "";
}

const MOCK_ROOM_SUMMARIES = [
  {
    code: "24680",
    mode: "duel",
    status: "waiting",
    visibility: "public",
    playerCount: 1,
    capacity: 2,
    spectatorCount: 3,
    hostName: "听雨",
    round: 0,
    guessMode: "standard",
    dictionary: "common",
    pointsToWin: 11,
  },
  {
    code: "13579",
    mode: "team2v2",
    status: "playing",
    visibility: "public",
    playerCount: 4,
    capacity: MODE_META.team2v2.capacity,
    spectatorCount: 7,
    hostName: "墨客",
    round: 5,
    guessMode: "free",
    dictionary: "all",
    pointsToWin: 15,
  },
  {
    code: "86420",
    mode: "ffa3",
    status: "waiting",
    visibility: "public",
    playerCount: 2,
    capacity: 3,
    spectatorCount: 0,
    hostName: "小满",
    round: 0,
    guessMode: "standard",
    dictionary: "common",
    pointsToWin: 7,
  },
];

const BOT_NAMES = ["听雨", "墨客", "小满", "折枝", "问渠"];

function nextId(prefix) {
  counter += 1;
  return `${prefix}-${counter}`;
}

export function mockGuest(name) {
  const safeName = String(name || "").slice(0, 16) || "游客";
  mockUser = { id: "mock-guest", name: safeName, avatar: "🐱", isGuest: true };
  return { token: "mock-token", user: mockUser };
}

export function mockLogin(username) {
  mockUser = { id: "mock-user-1", name: username, avatar: "🦊", isGuest: false, username };
  return { token: "mock-token", user: mockUser };
}

export function mockRegister(username, name) {
  mockUser = { id: "mock-user-2", name: name || username, avatar: "🐼", isGuest: false, username };
  return { token: "mock-token", user: mockUser };
}

export function mockLogout() {
  mockUser = null;
}

export function mockMe() {
  return mockUser || { id: "mock-guest", name: "游客", avatar: "🐱", isGuest: true };
}

export function mockUpdateProfile(payload) {
  if (!mockUser) throw new Error("请先登录");
  const nextName = String((payload && payload.name) || mockUser.name).trim();
  if (!nextName) throw new Error("昵称不能为空");
  if (nextName === "已存在") throw new Error("昵称已被使用");
  const rawAvatar = String((payload && payload.avatar) || mockUser.avatar || "🐱");
  const avatar = /^data:image\/(png|jpeg|webp);base64,/i.test(rawAvatar)
    ? rawAvatar
    : Array.from(rawAvatar).slice(0, 4).join("");
  mockUser = { ...mockUser, name: nextName.slice(0, 16), avatar };
  return { ...mockUser };
}

export function mockSiteStats() {
  return { registeredUsers: 128, onlineUsers: 7 };
}

export function mockMyMatches() {
  const base = Date.now() - 3600_000;
  const meId = mockUser ? mockUser.id : "mock-me";
  const meName = mockUser ? mockUser.name : "我";
  const meAvatar = mockUser && mockUser.avatar ? mockUser.avatar : "🐼";
  const oppId = "mock-opponent-1";
  const mateId = "mock-teammate-1";
  return [
    {
      id: "mock-match-1",
      mode: "duel",
      endedAt: base,
      opponentNames: ["折枝"],
      opponents: [{ name: "折枝", avatar: "🦊" }],
      winnerName: meName,
      winnerId: meId,
      winnerTeam: null,
      isDraw: false,
      forfeit: false,
      setWins: { [meId]: 2, [oppId]: 1 },
      players: [
        { id: meId, name: meName, avatar: meAvatar, team: null, score: 29, setWins: 2 },
        { id: oppId, name: "折枝", avatar: "🦊", team: null, score: 28, setWins: 1 },
      ],
      setHistory: [
        { setNumber: 1, winnerId: meId, winnerTeam: null, scores: { [meId]: 11, [oppId]: 9 }, teamScores: { A: 0, B: 0 }, pointsToWin: 11, endedAt: base - 1200_000 },
        { setNumber: 2, winnerId: oppId, winnerTeam: null, scores: { [meId]: 7, [oppId]: 11 }, teamScores: { A: 0, B: 0 }, pointsToWin: 11, endedAt: base - 600_000 },
        { setNumber: 3, winnerId: meId, winnerTeam: null, scores: { [meId]: 11, [oppId]: 8 }, teamScores: { A: 0, B: 0 }, pointsToWin: 11, endedAt: base },
      ],
      ratingBefore: 1200,
      ratingAfter: 1218,
      ratingDelta: 18,
      smallScores: { [meId]: 29, [oppId]: 28 },
    },
    {
      id: "mock-match-2",
      mode: "team2v2",
      endedAt: base - 7200_000,
      opponentNames: ["听雨", "墨客"],
      opponents: [{ name: "听雨", avatar: "🦊" }, { name: "墨客", avatar: "🐯" }],
      winnerName: "对手队",
      winnerId: null,
      winnerTeam: "B",
      isDraw: false,
      forfeit: true,
      setWins: { [meId]: 0, [oppId]: 1, [mateId]: 0 },
      players: [
        { id: meId, name: meName, avatar: meAvatar, team: "A", score: 8, setWins: 0 },
        { id: mateId, name: "队友", avatar: "🐸", team: "A", score: 8, setWins: 0 },
        { id: oppId, name: "听雨", avatar: "🦊", team: "B", score: 11, setWins: 1 },
      ],
      setHistory: [
        { setNumber: 1, winnerId: null, winnerTeam: "B", scores: {}, teamScores: { A: 8, B: 11 }, pointsToWin: 11, endedAt: base - 7200_000 },
      ],
      ratingBefore: 1190,
      ratingAfter: 1174,
      ratingDelta: -16,
      smallScores: { [meId]: 8, [oppId]: 11 },
    },
    {
      id: "mock-match-3",
      mode: "ffa3",
      endedAt: base - 10800_000,
      opponentNames: ["小满", "空山"],
      winnerName: meName,
      winnerId: meId,
      winnerTeam: null,
      isDraw: false,
      forfeit: false,
      setWins: { [meId]: 0, [oppId]: 0, [mateId]: 0 },
      players: [
        { id: meId, name: meName, avatar: meAvatar, team: null, score: 7, setWins: 0 },
        { id: oppId, name: "小满", avatar: "🦊", team: null, score: 3, setWins: 0 },
        { id: mateId, name: "空山", avatar: "🐸", team: null, score: 2, setWins: 0 },
      ],
      setHistory: [],
      ratingBefore: null,
      ratingAfter: null,
      ratingDelta: null,
      smallScores: { [meId]: 7, [oppId]: 3, [mateId]: 2 },
    },
    {
      id: "mock-match-4",
      mode: "duel",
      endedAt: base - 14400_000,
      opponentNames: ["旧对手"],
      winnerName: "null",
      winnerTeam: null,
      isDraw: false,
      forfeit: false,
      setWins: { [meId]: 1, [oppId]: 1 },
      setHistory: [],
      ratingBefore: 1200,
      ratingAfter: 1200,
      ratingDelta: 0,
      smallScores: { [meId]: 1, [oppId]: 1 },
    },
    {
      id: "mock-match-5",
      mode: "duel",
      endedAt: base - 18000_000,
      opponentNames: ["掉线对手"],
      winnerName: meName,
      winnerId: meId,
      winnerTeam: null,
      isDraw: false,
      forfeit: true,
      setWins: { [meId]: 0, [oppId]: 0 },
      players: [
        { id: meId, name: meName, avatar: meAvatar, team: null, score: 0, setWins: 0 },
        { id: oppId, name: "掉线对手", avatar: "🦊", team: null, score: 0, setWins: 0 },
      ],
      setHistory: [],
      ratingBefore: 1200,
      ratingAfter: 1212,
      ratingDelta: 12,
      smallScores: { [meId]: 0, [oppId]: 0 },
    },
  ];
}

export function mockMyIdioms() {
  const words = [
    ["山清水秀", "形容山水风景清秀明丽。"],
    ["山高水长", "比喻人品高尚，情谊深厚。"],
    ["坚定不移", "立场、主张、意志等稳定坚强，不动摇。"],
    ["风和日丽", "微风和暖，阳光明丽。"],
    ["水到渠成", "条件成熟，事情自然成功。"],
    ["一鸣惊人", "平时没有突出表现，一下子做出惊人的成绩。"],
    ["画龙点睛", "在关键处点明要旨，使内容更加生动传神。"],
    ["守株待兔", "比喻不主动努力，心存侥幸，希望得到意外收获。"],
    ["刻舟求剑", "比喻拘泥成法，不懂得随情况变化而变通。"],
    ["掩耳盗铃", "比喻自己欺骗自己，明明掩盖不住的事情偏要设法掩盖。"],
    ["亡羊补牢", "出了问题以后及时补救，可以防止继续受损失。"],
    ["井底之蛙", "比喻见识狭窄的人。"],
  ];
  return words.map(([word, explanation], index) => ({
    word,
    explanation,
    at: Date.now() - index * 3600_000,
  }));
}

export function mockRooms() {
  return MOCK_ROOM_SUMMARIES.map((room) => ({ ...room }));
}

export function mockLeaderboard(mode) {
  const base = { duel: 1420, ffa3: 1380, team2v2: 1350 }[mode] || 1200;
  const names = ["折枝", "问渠", "听雨", "墨客", "小满", "空山", "新雨", "青枫"];
  const avatars = ["🐱", "🦊", "🐼", "🐯", "🦁", "🐸", "🐧", "🦄"];
  return names.map((name, index) => ({
    rank: index + 1,
    userId: `mock-lb-${index}`,
    name,
    avatar: avatars[index],
    rating: base - index * 23 - (index % 3) * 7,
    games: 40 - index * 3,
    wins: 26 - index * 2,
    losses: 10 + index,
    draws: 4 - (index % 3),
  }));
}

function makeStatsView(mode) {
  const base = {
    duel: { matches: 18, wins: 11, losses: 6, draws: 1, setsWon: 27, points: 210 },
    ffa3: { matches: 7, wins: 3, losses: 4, draws: 0, setsWon: 0, points: 23 },
    team2v2: { matches: 9, wins: 5, losses: 3, draws: 1, setsWon: 12, points: 96 },
    practice: { matches: 26, wins: 0, losses: 0, draws: 0, setsWon: 0, points: 0 },
  }[mode];
  const rounds = base.matches * 9;
  const roundsWithGuess = Math.round(rounds * 0.8);
  const guesses = Math.round(roundsWithGuess * 4.2);
  const solves = Math.round(roundsWithGuess * 0.42);
  const totalSolveMs = solves * 12345;
  const stats = {
    ...base,
    rounds,
    roundsWithGuess,
    guesses,
    solves,
    totalSolveMs,
    fastestSolveMs: 2100 + (mode.length % 4) * 300,
    fastestMatchAwards: Math.max(1, Math.round(base.matches / 5)),
  };
  return {
    ...stats,
    winRate: stats.matches ? stats.wins / stats.matches : 0,
    solveRate: stats.roundsWithGuess ? stats.solves / stats.roundsWithGuess : 0,
    guessAccuracy: stats.guesses ? stats.solves / stats.guesses : 0,
    avgSolveMs: stats.solves ? stats.totalSolveMs / stats.solves : 0,
  };
}

export function mockStats() {
  const modes = {
    duel: makeStatsView("duel"),
    ffa3: makeStatsView("ffa3"),
    team2v2: makeStatsView("team2v2"),
    practice: makeStatsView("practice"),
  };
  const totals = {
    matches: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    rounds: 0,
    roundsWithGuess: 0,
    guesses: 0,
    solves: 0,
    totalSolveMs: 0,
    fastestSolveMs: 0,
    fastestMatchAwards: 0,
    points: 0,
    setsWon: 0,
  };
  for (const mode of RANKED_MODES) {
    const view = modes[mode];
    for (const key of Object.keys(totals)) {
      if (key === "fastestSolveMs") {
        const value = Number(view.fastestSolveMs) || 0;
        if (value > 0 && (totals.fastestSolveMs === 0 || value < totals.fastestSolveMs)) {
          totals.fastestSolveMs = value;
        }
      } else {
        totals[key] += Number(view[key]) || 0;
      }
    }
  }
  const total = {
    ...totals,
    winRate: totals.matches ? totals.wins / totals.matches : 0,
    solveRate: totals.roundsWithGuess ? totals.solves / totals.roundsWithGuess : 0,
    guessAccuracy: totals.guesses ? totals.solves / totals.guesses : 0,
    avgSolveMs: totals.solves ? totals.totalSolveMs / totals.solves : 0,
  };
  return { total, modes };
}

/* ------------------------------------------------------------------ */
/* 合成棋盘笔画                                                        */
/* ------------------------------------------------------------------ */

function pseudo(text) {
  let hash = 0;
  for (const char of String(text)) hash = (hash * 31 + char.codePointAt(0)) % 9973;
  return hash;
}

function syntheticStrokes(char, fill) {
  const seed = pseudo(char);
  const count = 2 + (seed % 2);
  const paths = [];
  for (let index = 0; index < count; index += 1) {
    const y = 190 + index * 250 + (seed % 60);
    const x1 = 110 + ((seed + index * 97) % 110);
    const x2 = 910 - ((seed + index * 61) % 130);
    paths.push({ d: `M${x1} ${y} L${x2} ${y}`, fill, opacity: 1, dx: 0, dy: 0 });
  }
  return paths;
}

function buildTiles(answer, guess) {
  const tiles = [];
  for (let index = 0; index < 4; index += 1) {
    const answerChar = answer[index];
    const guessChar = guess[index];
    if (answerChar === guessChar) {
      tiles.push({
        bg: "correct",
        char: answerChar,
        description: "完全正确",
        paths: syntheticStrokes(answerChar, "white"),
      });
      continue;
    }
    const seed = pseudo(answerChar + guessChar);
    const paths = syntheticStrokes(guessChar, "shadow").flatMap((path, strokeIndex) => {
      const distance = ((seed + strokeIndex * 137) % 100) / 100;
      if (distance < 0.45) return [{ ...path, fill: "correct", opacity: 1 }];
      if (distance < 0.85) {
        return [
          {
            ...path,
            fill: "shadow",
            opacity: Number(((1 - distance) / 0.5).toFixed(2)),
            dx: (seed % 41) - 20,
            dy: (seed % 57) - 28,
          },
        ];
      }
      return [];
    });
    tiles.push({ bg: "none", char: guessChar, description: "", paths });
  }
  return tiles;
}

/* ------------------------------------------------------------------ */
/* Mock 房间状态                                                       */
/* ------------------------------------------------------------------ */

function emptyRound(index) {
  return {
    index,
    status: "idle",
    rows: [],
    maxRows: ROWS_PER_ROUND,
    remainingRows: ROWS_PER_ROUND,
    startedAt: 0,
    endsAt: 0,
    endedAt: null,
    result: null,
    winnerId: null,
    winnerName: null,
    awardedTo: [],
    awardedTeam: null,
    setWinnerId: null,
    setWinnerTeam: null,
    answer: null,
  };
}

function emptyMatch(mode = "duel", bestOf = DUEL_DEFAULT_BEST_OF) {
  const setMode = modeUsesSets(mode);
  const resolvedBestOf = setMode && isDuelBestOf(bestOf) ? bestOf : 1;
  return {
    targetScore: mode === "ffa3" ? FFA_TARGET_SCORE : TARGET_SCORE,
    maxRounds: MAX_ROUNDS,
    roundNumber: 0,
    setNumber: 1,
    setsToWin: setMode ? setsToWinForBestOf(resolvedBestOf) : 1,
    bestOf: resolvedBestOf,
    setWins: {},
    pointsToWin: mode === "ffa3" ? FFA_TARGET_SCORE : DUEL_POINTS_TO_WIN,
    pointLead: setMode ? DUEL_POINT_LEAD : 0,
    winnerId: null,
    winnerName: null,
    winnerTeam: null,
    isDraw: false,
    forfeitById: null,
    forfeitTeam: null,
    ratingDeltas: {},
    highlights: {},
  };
}

function teamForSlot(mode, slot) {
  if (!MODE_META[mode].teams) return null;
  return slot % 2 === 0 ? "A" : "B";
}

function defaultSetWins(mode, players) {
  const wins = {};
  if (MODE_META[mode].teams) {
    wins.A = 0;
    wins.B = 0;
  } else {
    for (const player of players) wins[player.id] = 0;
  }
  return wins;
}

function makeBots(count) {
  const bots = [];
  for (let index = 0; index < count; index += 1) {
    bots.push({
      id: nextId("mock-bot"),
      name: BOT_NAMES[index % BOT_NAMES.length],
      isReady: true,
    });
  }
  return bots;
}

function makeRoomState(options) {
  const {
    code,
    mode,
    visibility = "public",
    status = "waiting",
    viewerRole = "player",
    includeSelf = true,
    statusForRound = "",
    bestOf = DUEL_DEFAULT_BEST_OF,
    guessMode = DEFAULT_GUESS_MODE,
    dictionary = DEFAULT_DICTIONARY,
    pointsToWin = defaultPointsForMode(mode),
    requiresAgreement = false,
    rules: rawRules = null,
  } = options;

  const capacity = MODE_META[mode].capacity;
  const players = [];
  const selfId = mockUser ? mockUser.id : "mock-guest";
  const selfName = mockUser ? mockUser.name : "你";
  const selfAvatar = mockUser && mockUser.avatar ? mockUser.avatar : "🐱";
  const rules = normalizeRoomRules(
    rawRules || { bestOf, guessMode, dictionary, pointsToWin },
    mode,
  );

  if (viewerRole === "player" && includeSelf) {
    players.push({
      id: selfId,
      name: selfName,
      avatar: selfAvatar,
      team: teamForSlot(mode, players.length),
      score: 0,
      ready: false,
      connected: true,
      isGuest: mockUser ? Boolean(mockUser.isGuest) : true,
      isHost: true,
      guesses: 0,
      rejoinDeadline: null,
    });
  }

  const botCount =
    mode === "practice"
      ? 0
      : mode === "team2v2"
        ? 3
        : Math.max(0, Math.min(capacity, 3) - players.length);
  for (const bot of makeBots(Math.max(0, botCount))) {
    players.push({
      id: bot.id,
      name: bot.name,
      avatar: "🐸",
      team: teamForSlot(mode, players.length),
      score: 0,
      ready: bot.isReady,
      connected: true,
      isGuest: false,
      isHost: players.length === 0,
      guesses: 0,
      rejoinDeadline: null,
    });
  }

  const state = {
    id: nextId("mock-room"),
    code,
    mode,
    visibility,
    rules,
    requiresAgreement: Boolean(requiresAgreement && mode !== "practice"),
    rulesAgreed: !requiresAgreement || mode === "practice",
    proposal: null,
    drawOffer: null,
    guessMode: rules.guessMode,
    dictionary: rules.dictionary,
    status,
    hostId: players.length > 0 ? players[0].id : selfId,
    players,
    spectators: viewerRole === "spectator" ? [{ id: selfId, name: selfName }] : [],
    teamScores: { A: 0, B: 0 },
    round: emptyRound(0),
    recentRounds: [],
    match: emptyMatch(mode, rules.bestOf),
    chat: [
      {
        id: nextId("mock-chat"),
        scope: "room",
        userId: players[0] ? players[0].id : selfId,
        name: players[0] ? players[0].name : selfName,
        text: "欢迎来到词影竞技场（mock 预览）",
        ts: Date.now() - 20000,
      },
    ],
    viewerRole,
    viewerId: selfId,
    countdownEndsAt: null,
    createdAt: Date.now(),
    serverTime: Date.now(),
  };
  state.match.setWins = defaultSetWins(mode, players);
  state.match.pointsToWin = rules.pointsToWin;
  state.match.bestOf = rules.bestOf;
  state.match.setsToWin = setsToWinForBestOf(rules.bestOf);
  state.match.setHistory = [];

  if (statusForRound === "playing") {
    state.round = {
      ...emptyRound(1),
      status: "playing",
      startedAt: Date.now() - 30000,
      endsAt: Date.now() + 30000,
      rows: [
        {
          id: nextId("mock-row"),
          playerId: players[1] ? players[1].id : selfId,
          playerName: players[1] ? players[1].name : selfName,
          word: "风和日丽",
          tiles: buildTiles(MOCK_ANSWER, "风和日丽"),
          correct: false,
          createdAt: Date.now() - 12000,
        },
        {
          id: nextId("mock-row"),
          playerId: players[2] ? players[2].id : selfId,
          playerName: players[2] ? players[2].name : selfName,
          word: "山高水长",
          tiles: buildTiles(MOCK_ANSWER, "山高水长"),
          correct: false,
          createdAt: Date.now() - 5000,
        },
      ],
      remainingRows: ROWS_PER_ROUND - 2,
    };
    state.match.roundNumber = 1;
    state.match.setNumber = 1;
  }

  return state;
}

/* ------------------------------------------------------------------ */
/* Mock WebSocket 传输                                                 */
/* ------------------------------------------------------------------ */

class MockTransport {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.closed = false;
    this.room = null;
    this.queue = null;
    this.timers = new Set();
    this.roundTimer = null;
    this.lastGuessAt = 0;
    /** 测试可关闭；预览时与真实服务端一样有 1 秒冷却。 */
    this.enforceCooldown = true;
    this.schedule(() => this.emit({ type: "hello", user: mockUser || mockMe() }), 60);
    this.schedule(() => this.emit({ type: "rooms", rooms: mockRooms() }), 120);
  }

  schedule(callback, delay) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.closed) callback();
    }, delay);
    this.timers.add(timer);
    return timer;
  }

  emit(message) {
    if (this.closed) return;
    this.onMessage(message);
  }

  emitState() {
    if (!this.room) return;
    this.room.serverTime = Date.now();
    this.emit({ type: "state", state: this.room });
  }

  emitError(message) {
    this.emit({ type: "error", message });
  }

  close() {
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.clearRoundTimer();
  }

  clearRoundTimer() {
    if (this.roundTimer) clearTimeout(this.roundTimer);
    this.roundTimer = null;
  }

  send(message) {
    if (this.closed || !message || typeof message.type !== "string") return;
    switch (message.type) {
      case "room.create":
        this.createRoom(message.mode, message.visibility, message);
        break;
      case "room.join":
        this.joinRoom(message.code);
        break;
      case "room.leave":
        this.leaveRoom();
        break;
      case "room.ready":
        this.setReady(Boolean(message.ready));
        break;
      case "room.setTeam":
        this.setTeam(message.team, message.userId);
        break;
      case "room.proposeRules":
        this.proposeRules(message.rules);
        break;
      case "room.acceptRules":
        this.acceptRules(message.proposalId);
        break;
      case "room.counterRules":
        this.counterRules(message.rules);
        break;
      case "room.updateRules":
        this.updateRules(message.rules);
        break;
      case "room.offerDraw":
        this.offerDraw();
        break;
      case "room.respondDraw":
        this.respondDraw(Boolean(message.accept));
        break;
      case "room.start":
        this.startMatch();
        break;
      case "room.guess":
        this.guess(String(message.word || ""));
        break;
      case "room.chat":
        this.chat(message.scope, String(message.text || ""));
        break;
      case "room.rematch":
        this.rematch();
        break;
      case "spectate.join":
        this.spectate(message.code);
        break;
      case "spectate.leave":
        this.room = null;
        break;
      case "queue.join":
        this.queueJoin(message.mode);
        break;
      case "queue.leave":
        this.queueLeave();
        break;
      case "ping":
        this.emit({ type: "pong", serverTime: Date.now() });
        break;
      default:
        break;
    }
  }

  createRoom(mode, visibility, options = {}) {
    const safeMode = MODES.includes(mode) ? mode : "duel";
    const opts = options && typeof options === "object" ? options : {};
    const code = MOCK_CODES[Math.floor(Math.random() * MOCK_CODES.length)];
    this.room = makeRoomState({
      code,
      mode: safeMode,
      visibility: visibility === "private" ? "private" : "public",
      bestOf:
        modeUsesSets(safeMode) && isDuelBestOf(opts.bestOf)
          ? opts.bestOf
          : DUEL_DEFAULT_BEST_OF,
      guessMode: isGuessMode(opts.guessMode) ? opts.guessMode : DEFAULT_GUESS_MODE,
      dictionary: isDictionaryMode(opts.dictionary) ? opts.dictionary : DEFAULT_DICTIONARY,
      pointsToWin: Number(opts.pointsToWin) || defaultPointsForMode(safeMode),
      requiresAgreement: false,
    });
    if (safeMode === "practice") {
      // 练习建房即自动开局。
      this.beginMatch();
      return;
    }
    this.emitState();
  }

  joinRoom(code) {
    const normalized = String(code || "00000").slice(0, 5);
    // 对局中离开后可用同一房号恢复（预览“最近房间/重新加入”）。
    if (
      this.room &&
      this.room.code === normalized &&
      this.room.viewerRole === "player" &&
      (this.room.status === "playing" ||
        this.room.status === "roundEnd" ||
        this.room.status === "countdown")
    ) {
      const me = this.room.players.find((player) => player.id === this.room.viewerId);
      if (me) {
        me.connected = true;
        me.rejoinDeadline = null;
      }
      this.emitState();
      return;
    }
    const summary = MOCK_ROOM_SUMMARIES.find((room) => room.code === normalized);
    const mode = summary ? summary.mode : "duel";
    this.room = makeRoomState({
      code: normalized,
      mode,
      statusForRound: summary && summary.status === "playing" ? "playing" : "",
      status: summary && summary.status === "playing" ? "playing" : "waiting",
      bestOf: DUEL_DEFAULT_BEST_OF,
      guessMode: summary ? summary.guessMode : DEFAULT_GUESS_MODE,
    });
    this.emitState();
  }

  leaveRoom() {
    const room = this.room;
    if (!room) return;
    if (room.mode === "practice") {
      this.room = null;
      return;
    }
    const active =
      room.status === "playing" || room.status === "roundEnd" || room.status === "countdown";
    if (room.viewerRole === "player" && active) {
      const me = room.players.find((player) => player.id === room.viewerId);
      if (me) {
        me.connected = false;
        me.rejoinDeadline = Date.now() + LEAVE_GRACE_MS;
      }
      return; // 保留 mock 房间，稍后 room.join 可恢复
    }
    this.room = null;
  }

  spectate(code) {
    const normalized = String(code || "00000").slice(0, 5);
    const summary = MOCK_ROOM_SUMMARIES.find((room) => room.code === normalized);
    const mode = summary ? summary.mode : "duel";
    this.room = makeRoomState({
      code: normalized,
      mode,
      viewerRole: "spectator",
      includeSelf: false,
      status: summary && summary.status === "playing" ? "playing" : "waiting",
      statusForRound: summary && summary.status === "playing" ? "playing" : "",
      bestOf: DUEL_DEFAULT_BEST_OF,
      guessMode: summary ? summary.guessMode : DEFAULT_GUESS_MODE,
    });
    this.emitState();
  }

  setReady(ready) {
    if (!this.room) return;
    const me = this.room.players.find((player) => player.id === this.room.viewerId);
    if (!me || me.isHost) return;
    me.ready = ready;
    this.emitState();
  }

  setTeam(team, userId) {
    const room = this.room;
    if (!room || room.mode !== "team2v2" || room.status !== "waiting") {
      this.emitError("当前不能调整队伍");
      return;
    }
    if (team !== "A" && team !== "B") {
      this.emitError("队伍只能是 A 或 B");
      return;
    }
    const me = room.players.find((player) => player.id === room.viewerId);
    if (!me) {
      this.emitError("你不在这个房间中");
      return;
    }
    const targetId = userId || me.id;
    if (!me.isHost && targetId !== me.id) {
      this.emitError("只有房主可以调整其他玩家的队伍");
      return;
    }
    const target = room.players.find((player) => player.id === targetId);
    if (!target) {
      this.emitError("玩家不在房间中");
      return;
    }
    if (target.team !== team) {
      target.team = team;
      this.emitState();
    }
  }

  applyRulesToRoom(rules) {
    const room = this.room;
    if (!room) return;
    const normalized = normalizeRoomRules(rules, room.mode);
    room.rules = normalized;
    room.guessMode = normalized.guessMode;
    room.dictionary = normalized.dictionary;
    room.match.bestOf = normalized.bestOf;
    room.match.setsToWin = setsToWinForBestOf(normalized.bestOf);
    room.match.pointsToWin = normalized.pointsToWin;
    room.match.targetScore = normalized.pointsToWin;
    room.proposal = null;
    room.rulesAgreed = true;
    this.emitState();
  }

  proposeRules(rules) {
    const room = this.room;
    if (!room || room.mode === "practice") return;
    if (room.status !== "waiting") {
      this.emitError("当前不能协商规则");
      return;
    }
    const me = room.players.find((player) => player.id === room.viewerId);
    if (!me) {
      this.emitError("你不在这个房间中");
      return;
    }
    if (!room.requiresAgreement) {
      this.emitError("当前房间不需要协商规则");
      return;
    }
    room.proposal = {
      id: nextId("mock-proposal"),
      proposerId: me.id,
      proposerName: me.name,
      rules: normalizeRoomRules(rules, room.mode),
      createdAt: Date.now(),
    };
    room.rulesAgreed = false;
    this.emitState();
    this.schedule(() => {
      if (this.room === room && room.proposal) this.applyRulesToRoom(room.proposal.rules);
    }, 700);
  }

  counterRules(rules) {
    const room = this.room;
    if (!room || room.mode === "practice") return;
    if (room.status !== "waiting") {
      this.emitError("当前不能协商规则");
      return;
    }
    const me = room.players.find((player) => player.id === room.viewerId);
    if (!me) {
      this.emitError("你不在这个房间中");
      return;
    }
    room.proposal = {
      id: nextId("mock-proposal"),
      proposerId: me.id,
      proposerName: me.name,
      rules: normalizeRoomRules(rules, room.mode),
      createdAt: Date.now(),
    };
    room.rulesAgreed = false;
    this.emitState();
    this.schedule(() => {
      if (this.room === room && room.proposal) this.applyRulesToRoom(room.proposal.rules);
    }, 700);
  }

  acceptRules(proposalId) {
    const room = this.room;
    if (!room || !room.proposal || room.proposal.id !== proposalId) return;
    this.applyRulesToRoom(room.proposal.rules);
  }

  updateRules(rules) {
    const room = this.room;
    if (!room || room.status !== "waiting" || room.requiresAgreement) {
      this.emitError("当前不能修改规则");
      return;
    }
    const me = room.players.find((player) => player.id === room.viewerId);
    if (!me || !me.isHost) {
      this.emitError("只有房主可以修改规则");
      return;
    }
    this.applyRulesToRoom(rules);
    this.emitState();
  }

  offerDraw() {
    const room = this.room;
    if (!room || room.mode === "practice") return;
    if (room.status !== "playing" && room.status !== "roundEnd") {
      this.emitError("当前不能求和");
      return;
    }
    if (room.drawOffer) return;
    const me = room.players.find((player) => player.id === room.viewerId);
    if (!me) {
      this.emitError("你不在这个房间中");
      return;
    }
    room.drawOffer = {
      proposerId: me.id,
      proposerName: me.name,
      acceptedBy: [],
      createdAt: Date.now(),
    };
    const offer = room.drawOffer;
    this.emitState();
    this.schedule(() => {
      if (this.room !== room || room.status === "matchEnd") return;
      if (room.drawOffer !== offer) return;
      room.drawOffer.acceptedBy = room.players
        .filter((player) => player.id !== room.drawOffer.proposerId)
        .map((player) => player.id);
      this.finishDrawMatch();
    }, 1200);
  }

  respondDraw(accept) {
    const room = this.room;
    if (!room || !room.drawOffer) {
      this.emitError("当前没有求和请求");
      return;
    }
    const me = room.players.find((player) => player.id === room.viewerId);
    if (!me) return;
    if (room.drawOffer.proposerId === me.id) {
      this.emitError("提议者不能响应自己的求和");
      return;
    }
    if (!accept) {
      room.drawOffer = null;
      this.emit({ type: "toast", message: "已拒绝平局" });
      this.emitState();
      return;
    }
    room.drawOffer.acceptedBy = [me.id];
    this.finishDrawMatch();
  }

  finishDrawMatch() {
    const room = this.room;
    if (!room) return;
    room.status = "matchEnd";
    room.drawOffer = null;
    room.match.winnerId = null;
    room.match.winnerName = null;
    room.match.winnerTeam = null;
    room.match.isDraw = true;
    room.match.forfeitById = null;
    room.match.forfeitTeam = null;
    room.match.ratingDeltas = Object.fromEntries(
      room.players.filter((player) => !player.isGuest).map((player) => [player.id, 0]),
    );
    this.clearRoundTimer();
    this.emitState();
  }

  startMatch() {
    if (!this.room || this.room.status !== "waiting") return;
    if (this.room.requiresAgreement && !this.room.rulesAgreed) {
      this.emitError("请先完成规则协商");
      return;
    }
    this.room.status = "countdown";
    this.room.countdownEndsAt = Date.now() + COUNTDOWN_MS;
    this.emitState();
    this.schedule(() => {
      if (!this.room || this.room.status !== "countdown") return;
      this.beginMatch();
    }, COUNTDOWN_MS);
  }

  beginMatch() {
    const room = this.room;
    if (!room) return;
    room.status = "playing";
    room.countdownEndsAt = null;
    room.drawOffer = null;
    room.match = emptyMatch(room.mode, room.match.bestOf);
    room.match.setWins = defaultSetWins(room.mode, room.players);
    room.match.pointsToWin = room.rules ? room.rules.pointsToWin : room.match.pointsToWin;
    room.match.targetScore = room.rules ? room.rules.pointsToWin : room.match.targetScore;
    room.match.setHistory = [];
    room.recentRounds = [];
    room.teamScores = { A: 0, B: 0 };
    this.lastGuessAt = 0;
    for (const player of room.players) {
      player.score = 0;
      player.guesses = 0;
      player.ready = true;
      player.lastGuessAt = 0;
    }
    this.beginRound();
  }

  beginRound() {
    const room = this.room;
    if (!room) return;
    this.clearRoundTimer();
    const roundNumber = (Number(room.match.roundNumber) || 0) + 1;
    room.match.roundNumber = roundNumber;
    room.status = "playing";
    room.round = {
      ...emptyRound(roundNumber),
      status: "playing",
      startedAt: Date.now(),
      endsAt: room.mode === "practice" ? 0 : Date.now() + ROUND_DURATION_MS,
    };
    this.emitState();
    if (room.mode !== "practice") this.scheduleIdleTimeout();
  }

  scheduleIdleTimeout() {
    const room = this.room;
    if (!room || !room.round || room.round.status !== "playing") return;
    this.clearRoundTimer();
    const delay = Math.max(1, room.round.endsAt - Date.now());
    this.roundTimer = this.schedule(() => {
      this.roundTimer = null;
      if (!this.room || this.room.status !== "playing" || !this.room.round) return;
      if (this.room.round.status !== "playing") return;
      this.endRound("timeout", true);
    }, delay);
  }

  touchRoundTimer() {
    const room = this.room;
    if (!room || !room.round || room.round.status !== "playing") return;
    if (room.mode === "practice") {
      room.round.endsAt = 0;
      this.emitState();
      return;
    }
    room.round.endsAt = Date.now() + ROUND_DURATION_MS;
    this.scheduleIdleTimeout();
    this.emitState();
  }

  currentSetWinner() {
    const room = this.room;
    if (!room || !modeUsesSets(room.mode)) return null;
    const match = room.match;
    const points = Number(match.pointsToWin) || DUEL_POINTS_TO_WIN;
    const lead = Number.isFinite(match.pointLead) ? match.pointLead : DUEL_POINT_LEAD;
    if (room.mode === "duel") {
      for (const player of room.players) {
        const bestOther = room.players
          .filter((item) => item.id !== player.id)
          .reduce((max, item) => Math.max(max, Number(item.score) || 0), 0);
        const score = Number(player.score) || 0;
        if (score >= points && score - bestOther >= lead) return { id: player.id, team: null };
      }
      return null;
    }
    for (const team of ["A", "B"]) {
      const other = team === "A" ? "B" : "A";
      const score = Number(room.teamScores[team]) || 0;
      const otherScore = Number(room.teamScores[other]) || 0;
      if (score >= points && score - otherScore >= lead) return { id: null, team };
    }
    return null;
  }

  applySetWin() {
    const room = this.room;
    if (!room) return;
    const winner = this.currentSetWinner();
    if (!winner) return;
    const round = room.round;
    if (winner.id) {
      round.setWinnerId = winner.id;
      const setWins = room.match.setWins || (room.match.setWins = {});
      setWins[winner.id] = (Number(setWins[winner.id]) || 0) + 1;
    } else if (winner.team) {
      round.setWinnerTeam = winner.team;
      const setWins = room.match.setWins || (room.match.setWins = {});
      setWins[winner.team] = (Number(setWins[winner.team]) || 0) + 1;
    }
  }

  guess(word) {
    const room = this.room;
    if (!room || room.status !== "playing" || !room.round || room.round.status !== "playing") {
      this.emitError("当前不能提交猜测");
      return;
    }
    const round = room.round;
    const chars = Array.from(word);
    if (chars.length !== 4) {
      this.emitError("请输入 4 个字符");
      return;
    }
    if (room.guessMode === "free") {
      if (!chars.every((char) => /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(char))) {
        this.emitError("自由模式只能输入 4 个汉字");
        return;
      }
    } else if (!MOCK_DICTIONARY.has(word)) {
      const suggestion = nearestMockWord(word);
      this.emitError(
        suggestion
          ? `标准模式词库中没有这个成语，你是否要输入「${suggestion}」？`
          : "标准模式只能猜词库中的成语",
      );
      return;
    }
    if (round.rows.some((row) => row.word === word)) {
      this.emitError("这个成语本轮已经猜过了");
      return;
    }
    const now = Date.now();
    if (this.enforceCooldown && this.lastGuessAt > 0 && now - this.lastGuessAt < GUESS_COOLDOWN_MS) {
      const remaining = Math.ceil((GUESS_COOLDOWN_MS - (now - this.lastGuessAt)) / 1000);
      this.emitError(`冷却中，还需等待 ${remaining} 秒`);
      return;
    }
    this.lastGuessAt = now;
    const me = room.players.find((player) => player.id === room.viewerId);
    if (!me) {
      this.emitError("你不在这个房间中");
      return;
    }
    me.guesses += 1;
    const correct = word === MOCK_ANSWER;
    round.rows.push({
      id: nextId("mock-row"),
      playerId: me.id,
      playerName: me.name,
      word,
      tiles: buildTiles(MOCK_ANSWER, word),
      correct,
      createdAt: Date.now(),
    });
    round.remainingRows = Math.max(0, round.maxRows - round.rows.length);

    if (correct) {
      me.score += 1;
      if (room.mode === "team2v2" && me.team) room.teamScores[me.team] += 1;
      if (room.mode !== "practice") this.applySetWin();
      this.endRound("solved", true, me);
      return;
    }

    if (round.rows.length >= round.maxRows) {
      if (room.mode !== "practice") this.applyAward();
      this.endRound("exhausted", true);
      return;
    }
    this.touchRoundTimer();
  }

  applyAward() {
    const room = this.room;
    if (!room) return;
    const round = room.round;
    const guesserId = round.rows.length ? round.rows[round.rows.length - 1].playerId : null;
    if (room.mode === "ffa3") {
      round.awardedTo = room.players
        .filter((player) => player.id !== guesserId)
        .map((player) => player.id);
      for (const player of room.players) {
        if (player.id !== guesserId) player.score += 1;
      }
      return;
    }
    if (room.mode === "team2v2") {
      const guesser = room.players.find((player) => player.id === guesserId);
      const otherTeam = guesser && guesser.team === "A" ? "B" : "A";
      round.awardedTeam = otherTeam;
      room.teamScores[otherTeam] = (Number(room.teamScores[otherTeam]) || 0) + 1;
      this.applySetWin();
      return;
    }
    const guesser = room.players.find((player) => player.id === guesserId);
    const winner = room.players.find((player) => player.id !== guesserId);
    if (winner) {
      winner.score += 1;
      round.awardedTo = [winner.id];
      this.applySetWin();
    }
  }

  endRound(result, scheduleNext, winner = null) {
    const room = this.room;
    if (!room || !room.round) return;
    this.clearRoundTimer();
    const round = room.round;
    if (round.status !== "playing") return;
    round.status = "ended";
    round.result = result;
    round.endedAt = Date.now();
    round.answer = MOCK_ANSWER;
    if (winner) {
      round.winnerId = winner.id;
      round.winnerName = winner.name;
    }
    const recentEntry = {
      index: round.index,
      answer: MOCK_ANSWER,
      explanation: MOCK_ANSWER_EXPLANATION,
      result,
      winnerId: round.winnerId,
      winnerName: round.winnerName,
      awardedTo: Array.isArray(round.awardedTo) ? [...round.awardedTo] : [],
      awardedTeam: round.awardedTeam,
      setWinnerId: round.setWinnerId,
      setWinnerTeam: round.setWinnerTeam,
      endedAt: round.endedAt,
    };
    room.recentRounds = [...(room.recentRounds || []), recentEntry].slice(-5);
    if (round.setWinnerId || round.setWinnerTeam) {
      const scores = {};
      for (const player of room.players) scores[player.id] = Number(player.score) || 0;
      room.match.setHistory = [
        ...(room.match.setHistory || []),
        {
          setNumber: Number(room.match.setNumber) || 1,
          winnerId: round.setWinnerId || null,
          winnerTeam: round.setWinnerTeam || null,
          scores,
          teamScores: { ...room.teamScores },
          pointsToWin: Number(room.match.pointsToWin) || DUEL_POINTS_TO_WIN,
          endedAt: round.endedAt,
        },
      ];
    }
    room.status = "roundEnd";
    this.emitState();
    if (!scheduleNext) return;
    if (room.mode === "practice") {
      this.schedule(() => {
        if (this.room !== room || room.status !== "roundEnd") return;
        room.status = "matchEnd";
        room.match.isDraw = true;
        this.emitState();
      }, ROUND_END_DELAY_MS);
      return;
    }
    const setEnded = Boolean(round.setWinnerId || round.setWinnerTeam);
    const delay = setEnded ? SET_END_DELAY_MS : ROUND_END_DELAY_MS;
    this.schedule(() => this.afterRound(), delay);
  }

  afterRound() {
    const room = this.room;
    if (!room || room.status !== "roundEnd") return;
    const round = room.round;
    const setEnded = Boolean(round && (round.setWinnerId || round.setWinnerTeam));
    if (setEnded) {
      const setWins = room.match.setWins || {};
      const winnerKey = round.setWinnerId || round.setWinnerTeam;
      const setsToWin =
        Number(room.match.setsToWin) || setsToWinForBestOf(room.match.bestOf);
      if ((Number(setWins[winnerKey]) || 0) >= setsToWin) {
        this.finishSetMatch();
        return;
      }
      this.beginNextSet();
      return;
    }
    if (room.mode === "ffa3") {
      const target = Number(room.match.targetScore) || FFA_TARGET_SCORE;
      if (room.players.some((player) => player.score >= target)) {
        this.finishFfaMatch();
        return;
      }
    }
    this.beginRound();
  }

  beginNextSet() {
    const room = this.room;
    if (!room) return;
    room.match.setNumber = (Number(room.match.setNumber) || 1) + 1;
    room.teamScores = { A: 0, B: 0 };
    this.lastGuessAt = 0;
    for (const player of room.players) {
      player.score = 0;
      player.guesses = 0;
      player.lastGuessAt = 0;
    }
    room.round = emptyRound(room.match.roundNumber);
    this.emitState();
    this.beginRound();
  }

  finishSetMatch() {
    const room = this.room;
    if (!room) return;
    room.status = "matchEnd";
    const setWins = room.match.setWins || {};
    if (room.mode === "team2v2") {
      const a = Number(setWins.A) || 0;
      const b = Number(setWins.B) || 0;
      room.match.winnerTeam = a === b ? null : a > b ? "A" : "B";
      room.match.winnerId = null;
      room.match.winnerName = null;
      room.match.isDraw = a === b;
    } else {
      const sorted = [...room.players].sort(
        (left, right) =>
          (Number(setWins[right.id]) || 0) - (Number(setWins[left.id]) || 0),
      );
      const top = sorted[0];
      const second = sorted[1];
      if (!top) return;
      const topWins = Number(setWins[top.id]) || 0;
      const secondWins = second ? Number(setWins[second.id]) || 0 : 0;
      room.match.winnerId = topWins === secondWins ? null : top.id;
      room.match.winnerName = topWins === secondWins ? null : top.name;
      room.match.isDraw = topWins === secondWins;
    }
    room.match.ratingDeltas = Object.fromEntries(
      room.players
        .filter((player) => !player.isGuest)
        .map((player) => {
          if (room.match.isDraw) return [player.id, 0];
          const win =
            room.mode === "team2v2"
              ? player.team === room.match.winnerTeam
              : player.id === room.match.winnerId;
          return [player.id, win ? 16 : -16];
        }),
    );
    this.emitState();
  }

  finishFfaMatch() {
    const room = this.room;
    if (!room) return;
    room.status = "matchEnd";
    const best = Math.max(...room.players.map((player) => Number(player.score) || 0));
    const leaders = room.players.filter((player) => Number(player.score) === best);
    room.match.isDraw = leaders.length !== 1;
    room.match.winnerId = leaders.length === 1 ? leaders[0].id : null;
    room.match.winnerName = leaders.length === 1 ? leaders[0].name : null;
    room.match.ratingDeltas = Object.fromEntries(
      room.players
        .filter((player) => !player.isGuest)
        .map((player) => [
          player.id,
          room.match.isDraw ? 0 : player.id === room.match.winnerId ? 16 : -8,
        ]),
    );
    this.emitState();
  }

  rematch() {
    const room = this.room;
    if (!room) return;
    if (room.mode === "practice") {
      const guessMode = room.guessMode;
      room.status = "playing";
      room.drawOffer = null;
      room.match = emptyMatch("practice", 1);
      room.match.setWins = defaultSetWins(room.mode, room.players);
      room.match.setHistory = [];
      room.recentRounds = [];
      room.round = emptyRound(0);
      room.teamScores = { A: 0, B: 0 };
      this.lastGuessAt = 0;
      for (const player of room.players) {
        player.score = 0;
        player.guesses = 0;
        player.lastGuessAt = 0;
        player.rejoinDeadline = null;
      }
      room.guessMode = guessMode;
      this.beginRound();
      return;
    }
    if (room.status !== "matchEnd") return;
    const bestOf = room.match.bestOf;
    const guessMode = room.guessMode;
    room.status = "waiting";
    room.countdownEndsAt = null;
    room.drawOffer = null;
    room.match = emptyMatch(room.mode, bestOf);
    room.match.setWins = defaultSetWins(room.mode, room.players);
    room.match.setHistory = [];
    room.recentRounds = [];
    room.match.pointsToWin = room.rules ? room.rules.pointsToWin : room.match.pointsToWin;
    room.match.targetScore = room.rules ? room.rules.pointsToWin : room.match.targetScore;
    room.round = emptyRound(0);
    room.teamScores = { A: 0, B: 0 };
    this.lastGuessAt = 0;
    for (const player of room.players) {
      player.score = 0;
      player.guesses = 0;
      player.ready = player.isHost ? false : true;
      player.lastGuessAt = 0;
      player.rejoinDeadline = null;
    }
    room.guessMode = guessMode;
    this.emitState();
  }

  chat(scope, text) {
    if (!this.room) return;
    const clean = text.trim().slice(0, CHAT_MAX);
    if (!clean) return;
    const me = this.room.players.find((player) => player.id === this.room.viewerId);
    if (!me) {
      this.emitError("观战者不能发言");
      return;
    }
    this.room.chat.push({
      id: nextId("mock-chat"),
      scope: scope === "team" ? "team" : "room",
      userId: me.id,
      name: me.name,
      text: clean,
      ts: Date.now(),
    });
    this.emitState();
  }

  queueJoin(mode) {
    if (mode !== "duel" && mode !== "ffa3") {
      this.emitError("团队战人数不限，请创建房间或输入房号加入");
      return;
    }
    this.queue = {
      mode,
      size: 1,
      needed: MODE_META[mode].capacity,
      position: 1,
    };
    this.emit({ type: "queue", state: this.queue });
    this.schedule(() => {
      if (this.closed || this.room) return;
      this.queue = null;
      this.emit({ type: "queue", state: null });
      this.room = makeRoomState({
        code: MOCK_CODES[0],
        mode,
        status: "waiting",
        bestOf: 1,
        guessMode: "free",
        dictionary: DEFAULT_DICTIONARY,
        pointsToWin: defaultPointsForMode(mode),
        requiresAgreement: true,
      });
      this.emitState();
    }, 2500);
  }

  queueLeave() {
    this.queue = null;
    this.emit({ type: "queue", state: null });
  }
}

export function createMockTransport(onMessage) {
  return new MockTransport(onMessage);
}
