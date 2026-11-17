import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import type {
  DailyLeaderboardRow,
  DailyState,
  FriendMessageView,
  FriendNotificationView,
  FriendProfileResponse,
  FriendRequestView,
  FriendsResponse,
  FriendUser,
  LeaderboardRow,
  Mode,
  PrivacySettings,
  PublicUser,
  RankedMode,
  RecentIdiomsResponse,
  RoomSummary,
  SessionResponse,
  StreakLeaderboardResponse,
  StreakState,
  StreakStats,
  StreakVariant,
  UserSearchResult,
} from "../../../packages/shared/src/index.ts";
import { MODES, MODE_META, RANKED_MODES, isMode } from "../../../packages/shared/src/index.ts";
import type { GameData } from "../../../packages/engine/src/index.ts";
import { explanationFor, loadGameData } from "../../../packages/engine/src/index.ts";
import type { RoomConfig } from "./rooms.ts";
import { RoomManager } from "./rooms.ts";
import {
  DAILY_LEADERBOARD_LIMIT,
  buildDailyState,
  dailyAnswer,
  dailyDateKey,
  dailyStreakDays,
  validateDailyGuess,
} from "./daily.ts";
import { StreakError, StreakManager, isStreakVariant } from "./streak.ts";
import { Store, StoreError } from "./store.ts";
import { WsHub } from "./ws.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DEFAULT_PUBLIC_DIR = resolve(HERE, "../../web/public");

export interface CreateServerOptions {
  dataDir?: string;
  /** Set to false for in-memory-only stores (tests). Defaults to true. */
  persistStore?: boolean;
  config?: Partial<RoomConfig>;
  chooseAnswer?: (data: GameData) => string;
  publicDir?: string;
  logger?: boolean;
  /** WebSocket heartbeat interval in ms (tests use a shorter one). */
  heartbeatMs?: number;
  /** 连胜挑战断线自动结束时间；测试可缩短。 */
  streakDisconnectGraceMs?: number;
  /** 连胜挑战每局之间的休息时间；测试可缩短。 */
  streakIntermissionMs?: number;
}

export interface ServerHandle {
  app: FastifyInstance;
  store: Store;
  manager: RoomManager;
  hub: WsHub;
  /** Actual bound URL, refreshed by `listen`. */
  url: string;
  listen(port?: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

interface ErrorBody {
  error: string;
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

function bodyOf(request: FastifyRequest): Record<string, unknown> {
  const body = request.body;
  if (body && typeof body === "object") return body as Record<string, unknown>;
  return {};
}

function parseLimit(raw: unknown, fallback: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.floor(parsed));
}

function isRankedMode(value: unknown): value is RankedMode {
  return typeof value === "string" && (RANKED_MODES as readonly string[]).includes(value);
}

function fallbackHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>词影竞技场</title></head>
<body style="font-family:system-ui;background:#0f172a;color:#e2e8f0;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0">
<main style="text-align:center">
<h1>词影竞技场 API 已启动</h1>
<p>前端静态文件尚未就绪（apps/web/public/index.html 不存在）。</p>
<p>健康检查：<a style="color:#5eead4" href="/api/health">/api/health</a></p>
</main>
</body>
</html>`;
}

/**
 * Build the Fastify app (REST + static files) together with the WebSocket hub
 * and the room manager. No listening happens here, which makes the server easy
 * to mount in tests on an ephemeral port.
 */
export async function createServer(options: CreateServerOptions = {}): Promise<ServerHandle> {
  const data = loadGameData();
  const store = new Store({ dataDir: options.dataDir, persist: options.persistStore ?? true });
  const streaks = new StreakManager({
    data,
    store,
    chooseAnswer: options.chooseAnswer,
    disconnectGraceMs: options.streakDisconnectGraceMs,
    intermissionMs: options.streakIntermissionMs,
  });
  const publicDir = options.publicDir ?? DEFAULT_PUBLIC_DIR;

  const app = Fastify({ logger: options.logger ?? false });
  await app.register(cors, { origin: true });
  if (existsSync(publicDir)) {
    await app.register(fastifyStatic, {
      root: publicDir,
      prefix: "/",
      index: ["index.html"],
    });
  }

  let hub: WsHub;
  const manager = new RoomManager({
    store,
    data,
    send: (userId, message) => hub?.sendToUser(userId, message),
    broadcastRooms: (rooms) => hub?.broadcastRooms(rooms),
    onPresenceChanged: (userId) => hub?.cleanupGuestIfIdle(userId),
    config: options.config,
    chooseAnswer: options.chooseAnswer,
  });
  hub = new WsHub({ server: app.server, store, manager, heartbeatMs: options.heartbeatMs });

  function requireUser(request: FastifyRequest, reply: FastifyReply): PublicUser | null {
    const user = store.me(bearerToken(request));
    if (!user) {
      reply.code(401).send({ error: "未登录或登录已失效" } satisfies ErrorBody);
      return null;
    }
    return user;
  }

  function requireRegistered(request: FastifyRequest, reply: FastifyReply): PublicUser | null {
    const user = requireUser(request, reply);
    if (!user) return null;
    if (user.isGuest) {
      reply.code(403).send({ error: "游客不能使用连胜挑战，请先注册" } satisfies ErrorBody);
      return null;
    }
    return user;
  }

  function parseDailyDate(raw: unknown): string | null {
    if (raw === undefined || raw === null || raw === "") return dailyDateKey();
    if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
    const parsed = new Date(`${raw}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) return null;
    return raw;
  }

  /** All solved players for a date, best (fewest guesses, then earliest) first. */
  function dailyLeaderboard(date: string): DailyLeaderboardRow[] {
    const solved = store
      .listDailyResults(date)
      .filter((entry) => entry.solved)
      .map((entry) => {
        const account = store.getUserById(entry.userId);
        if (!account || account.isGuest) return null;
        return {
          userId: entry.userId,
          name: account.name,
          avatar: account.avatar || "🎯",
          attempts: entry.attempts,
          solvedAt: entry.solvedAt ?? 0,
          durationMs: entry.durationMs ?? 0,
        };
      })
      .filter((row): row is Omit<DailyLeaderboardRow, "rank"> => row !== null);
    solved.sort(
      (a, b) =>
        a.attempts - b.attempts ||
        a.durationMs - b.durationMs ||
        a.solvedAt - b.solvedAt ||
        a.name.localeCompare(b.name),
    );
    return solved.map((row, index) => ({ ...row, rank: index + 1 }));
  }

  function dailyStateFor(date: string, account: PublicUser | null): DailyState {
    const board = dailyLeaderboard(date);
    const result = account ? store.getDailyResult(date, account.id) : null;
    const myRank = account ? board.find((row) => row.userId === account.id)?.rank ?? null : null;
    const solvedDates = account
      ? new Set(
          store
            .dailyResultsForUser(account.id)
            .filter((entry) => entry.solved)
            .map((entry) => entry.date),
        )
      : new Set<string>();
    return buildDailyState({
      data,
      date,
      result: account ? result : null,
      leaderboard: board.slice(0, DAILY_LEADERBOARD_LIMIT),
      meRank: myRank,
      streakDays: account ? dailyStreakDays(solvedDates, date) : 0,
      user: account ? { id: account.id, name: account.name, avatar: account.avatar } : null,
    });
  }

  function friendUserFor(userId: string): FriendUser | null {
    const user = store.getUserById(userId);
    if (!user || user.isGuest) return null;
    return {
      id: user.id,
      name: user.name,
      avatar: user.avatar || "🎯",
      online: hub.isOnline(user.id),
    };
  }

  function requestView(
    request: { id: string; fromUserId: string; toUserId: string; createdAt: number },
    direction: "incoming" | "outgoing",
    selfId: string,
  ): FriendRequestView | null {
    const otherId = request.fromUserId === selfId ? request.toUserId : request.fromUserId;
    const user = friendUserFor(otherId);
    if (!user) return null;
    return { id: request.id, direction, user, createdAt: request.createdAt };
  }

  function notificationView(record: {
    id: string;
    type: FriendNotificationView["type"];
    title: string;
    text: string;
    createdAt: number;
    read: boolean;
    fromUserId: string | null;
    roomCode: string | null;
  }): FriendNotificationView {
    const view: FriendNotificationView = {
      id: record.id,
      type: record.type,
      title: record.title,
      text: record.text,
      createdAt: record.createdAt,
      read: record.read,
      userId: record.fromUserId,
    };
    if (record.roomCode) view.roomCode = record.roomCode;
    return view;
  }

  function friendMessageView(record: {
    id: string;
    fromUserId: string;
    toUserId: string;
    text: string;
    createdAt: number;
    read: boolean;
  }): FriendMessageView | null {
    const from = store.getUserById(record.fromUserId);
    if (!from) return null;
    return {
      id: record.id,
      fromId: record.fromUserId,
      toId: record.toUserId,
      fromName: from.name,
      text: record.text,
      ts: record.createdAt,
      read: record.read,
    };
  }

  function friendsPayload(userId: string): FriendsResponse {
    const friends = store
      .getFriendIds(userId)
      .map((id) => friendUserFor(id))
      .filter((user): user is FriendUser => user !== null);
    const incoming = store
      .incomingRequests(userId)
      .map((request) => requestView(request, "incoming", userId))
      .filter((view): view is FriendRequestView => view !== null);
    const outgoing = store
      .outgoingRequests(userId)
      .map((request) => requestView(request, "outgoing", userId))
      .filter((view): view is FriendRequestView => view !== null);
    const notifications = store.listNotifications(userId).map((record) => notificationView(record));
    return {
      friends,
      incoming,
      outgoing,
      notifications,
      unread: store.unreadNotificationCount(userId),
    };
  }

  function relationFor(selfId: string, targetId: string): UserSearchResult["relation"] {
    if (store.isFriend(selfId, targetId)) return "friend";
    const pending = store.pendingRequestBetween(selfId, targetId);
    if (pending) return pending.fromUserId === selfId ? "outgoing" : "incoming";
    return "none";
  }

  function requireRegisteredUser(
    request: FastifyRequest,
    reply: FastifyReply,
    guestMessage = "游客不能使用该功能，请先注册",
  ): PublicUser | null {
    const user = requireUser(request, reply);
    if (!user) return null;
    if (user.isGuest) {
      reply.code(403).send({ error: guestMessage } satisfies ErrorBody);
      return null;
    }
    return user;
  }

  function registeredTarget(rawId: unknown): PublicUser | null {
    if (typeof rawId !== "string" || rawId.length === 0) return null;
    const user = store.getUserById(rawId);
    if (!user || user.isGuest) return null;
    return store.toPublicUser(user);
  }

  app.get("/api/health", async () => {
    return {
      ok: true,
      status: "ok",
      name: "ciying-arena",
      time: Date.now(),
      stats: {
        ...store.stats(),
        rooms: manager.roomCount(),
        online: hub.onlineCount(),
      },
    };
  });

  app.get("/api/modes", async () => {
    return {
      modes: MODES.map((mode) => MODE_META[mode]),
    };
  });

  app.get("/api/rooms", async () => {
    const rooms: RoomSummary[] = manager.getPublicRooms();
    return { rooms };
  });

  app.get("/api/site", async () => {
    return {
      registeredUsers: store.registeredUserCount(),
      onlineUsers: hub.onlineCount(),
    };
  });

  app.get("/api/leaderboard", async (request, reply) => {
    const query = request.query as { mode?: unknown; limit?: unknown } | undefined;
    const mode = query?.mode ?? "duel";
    if (!isRankedMode(mode)) {
      reply.code(400).send({ error: "mode 必须是 duel、ffa3 或 team2v2" } satisfies ErrorBody);
      return reply;
    }
    const limit = parseLimit(query?.limit, 50, 50);
    const rows: LeaderboardRow[] = store.leaderboard(mode as RankedMode, limit);
    return { mode, rows };
  });

  app.get("/api/matches/recent", async (request) => {
    const query = request.query as { limit?: unknown } | undefined;
    const limit = parseLimit(query?.limit, 20, 100);
    return { matches: store.recentMatches(limit) };
  });

  app.post("/api/session/guest", async (request, reply) => {
    const body = bodyOf(request);
    try {
      const session: SessionResponse = store.createGuest(body.name);
      return session;
    } catch (error) {
      return sendStoreError(reply, error);
    }
  });

  app.post("/api/auth/register", async (request, reply) => {
    const body = bodyOf(request);
    try {
      const session: SessionResponse = store.register({
        username: body.username,
        password: body.password,
        name: body.name,
      });
      reply.code(201);
      return session;
    } catch (error) {
      return sendStoreError(reply, error);
    }
  });

  app.post("/api/auth/login", async (request, reply) => {
    const body = bodyOf(request);
    try {
      const session: SessionResponse = store.login({ username: body.username, password: body.password });
      return session;
    } catch (error) {
      return sendStoreError(reply, error);
    }
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const token = bearerToken(request);
    if (!token || !store.logout(token)) {
      reply.code(401).send({ error: "未登录或登录已失效" } satisfies ErrorBody);
      return reply;
    }
    return { ok: true };
  });

  app.get("/api/me", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    return {
      user,
      ratings: Object.fromEntries(RANKED_MODES.map((mode) => [mode, store.getRating(mode, user.id)])),
    };
  });

  const updateProfile = async (request: FastifyRequest, reply: FastifyReply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    if (user.isGuest) {
      reply.code(403).send({ error: "游客不能修改资料，请先注册" } satisfies ErrorBody);
      return reply;
    }
    const body = bodyOf(request);
    try {
      const updated = store.updateProfile(user.id, { name: body.name, avatar: body.avatar });
      return { user: updated };
    } catch (error) {
      return sendStoreError(reply, error);
    }
  };
  app.patch("/api/me/profile", updateProfile);
  app.post("/api/me/profile", updateProfile);

  app.get("/api/me/matches", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    if (user.isGuest) {
      reply.code(403).send({ error: "游客没有战绩记录，请先注册" } satisfies ErrorBody);
      return reply;
    }
    const query = request.query as { limit?: unknown } | undefined;
    const limit = parseLimit(query?.limit, 20, 50);
    return { rows: store.matchHistory(user.id, limit) };
  });

  app.get("/api/me/idioms", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    if (user.isGuest) {
      reply.code(403).send({ error: "游客没有最近成语记录，请先注册" } satisfies ErrorBody);
      return reply;
    }
    const rows = store
      .recentIdiomsFor(user.id)
      .sort((a, b) => b.at - a.at)
      .slice(0, 30)
      .map((entry) => ({
        word: entry.word,
        explanation: explanationFor(data, entry.word),
        at: entry.at,
      }));
    const response: RecentIdiomsResponse = { rows };
    return response;
  });

  app.get("/api/daily", async (request, reply) => {
    const query = request.query as { date?: unknown } | undefined;
    const date = parseDailyDate(query?.date);
    if (!date) {
      reply.code(400).send({ error: "日期格式应为 YYYY-MM-DD" } satisfies ErrorBody);
      return reply;
    }
    const rawUser = store.me(bearerToken(request));
    const account = rawUser && !rawUser.isGuest ? rawUser : null;
    if (account) {
      const existing = store.getDailyResult(date, account.id);
      if (!existing) {
        // First visit starts the daily timer even before the first guess.
        store.saveDailyResult({
          date,
          userId: account.id,
          guesses: [],
          solved: false,
          solvedAt: null,
          attempts: 0,
          startedAt: Date.now(),
          durationMs: null,
        });
      } else if (!existing.solved && existing.startedAt === null) {
        // Older unsolved records get a timer when the player opens the page.
        store.saveDailyResult({ ...existing, startedAt: Date.now(), durationMs: null });
      }
    }
    return dailyStateFor(date, account);
  });

  app.post("/api/daily/guess", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    if (user.isGuest) {
      reply.code(403).send({ error: "游客不能提交每日一题，请先注册" } satisfies ErrorBody);
      return reply;
    }
    const body = bodyOf(request);
    const query = request.query as { date?: unknown } | undefined;
    const date = parseDailyDate(query?.date ?? body.date);
    if (!date) {
      reply.code(400).send({ error: "日期格式应为 YYYY-MM-DD" } satisfies ErrorBody);
      return reply;
    }
    if (typeof body.word !== "string" || body.word.trim().length === 0) {
      reply.code(400).send({ error: "请输入四字成语" } satisfies ErrorBody);
      return reply;
    }
    const word = body.word.trim();
    const validation = validateDailyGuess(data, word);
    if (!validation.ok) {
      reply.code(400).send({ error: validation.reason } satisfies ErrorBody);
      return reply;
    }
    const existing = store.getDailyResult(date, user.id);
    if (existing?.solved) {
      reply.code(400).send({ error: "今天已经答对过了，明天再来" } satisfies ErrorBody);
      return reply;
    }
    if (existing?.guesses.includes(word)) {
      reply.code(400).send({ error: "今天已经猜过这个成语了，换一个试试" } satisfies ErrorBody);
      return reply;
    }
    const guesses = [...(existing?.guesses ?? []), word];
    const answer = dailyAnswer(data, date);
    const solved = word === answer;
    const solvedAt = solved ? Date.now() : null;
    const startedAt = existing?.startedAt ?? Date.now();
    store.saveDailyResult({
      date,
      userId: user.id,
      guesses,
      solved,
      solvedAt,
      attempts: guesses.length,
      startedAt,
      durationMs: solved && solvedAt !== null ? Math.max(0, solvedAt - startedAt) : null,
    });
    return dailyStateFor(date, user);
  });

  app.get("/api/stats/me", async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    if (user.isGuest) {
      reply.code(401).send({ error: "游客不记录个人统计，请注册后查看" } satisfies ErrorBody);
      return reply;
    }
    return store.statsResponse(user.id);
  });

  app.get("/api/stats/:userId", async (request, reply) => {
    const params = request.params as { userId?: string };
    const user = params.userId ? store.getUserById(params.userId) : null;
    if (!user || user.isGuest) {
      reply.code(404).send({ error: "用户不存在或没有统计" } satisfies ErrorBody);
      return reply;
    }
    return store.statsResponse(user.id);
  });

  app.get("/api/streak", async (request, reply) => {
    const user = requireRegistered(request, reply);
    if (!user) return reply;
    const query = request.query as { variant?: unknown } | undefined;
    if (!isStreakVariant(query?.variant)) {
      reply.code(400).send({ error: "variant 必须是 standard、free 或 advanced" } satisfies ErrorBody);
      return reply;
    }
    return streaks.getState(user.id, query.variant);
  });

  app.post("/api/streak/start", async (request, reply) => {
    const user = requireRegistered(request, reply);
    if (!user) return reply;
    const body = bodyOf(request);
    if (!isStreakVariant(body.variant)) {
      reply.code(400).send({ error: "variant 必须是 standard、free 或 advanced" } satisfies ErrorBody);
      return reply;
    }
    return streaks.start(user.id, body.variant);
  });

  app.post("/api/streak/guess", async (request, reply) => {
    const user = requireRegistered(request, reply);
    if (!user) return reply;
    const body = bodyOf(request);
    return streaks.guess(user.id, body.word);
  });

  app.post("/api/streak/quit", async (request, reply) => {
    const user = requireRegistered(request, reply);
    if (!user) return reply;
    streaks.quit(user.id);
    return { ok: true };
  });

  app.get("/api/streak/leaderboard", async (request, reply) => {
    const user = requireRegistered(request, reply);
    if (!user) return reply;
    const query = request.query as { variant?: unknown } | undefined;
    if (!isStreakVariant(query?.variant)) {
      reply.code(400).send({ error: "variant 必须是 standard、free 或 advanced" } satisfies ErrorBody);
      return reply;
    }
    const response: StreakLeaderboardResponse = {
      variant: query.variant,
      rows: store.streakLeaderboard(query.variant, DAILY_LEADERBOARD_LIMIT),
    };
    return response;
  });

  app.get("/api/streak/stats", async (request, reply) => {
    const user = requireRegistered(request, reply);
    if (!user) return reply;
    const stats: StreakStats = store.getStreakStats(user.id);
    return stats;
  });

  app.get("/api/users/search", async (request, reply) => {
    const user = requireRegisteredUser(request, reply);
    if (!user) return reply;
    const query = request.query as { q?: unknown } | undefined;
    const q = typeof query?.q === "string" ? query.q : "";
    const rows: UserSearchResult[] = store.searchUsers(q, user.id, 20).map((target) => ({
      id: target.id,
      name: target.name,
      avatar: target.avatar || "🎯",
      relation: relationFor(user.id, target.id),
    }));
    return { rows };
  });

  app.get("/api/friends", async (request, reply) => {
    const user = requireRegisteredUser(request, reply);
    if (!user) return reply;
    return friendsPayload(user.id);
  });

  app.post("/api/friends/request", async (request, reply) => {
    const user = requireRegisteredUser(request, reply);
    if (!user) return reply;
    const body = bodyOf(request);
    const target = registeredTarget(body.userId);
    if (!target) {
      reply.code(404).send({ error: "用户不存在" } satisfies ErrorBody);
      return reply;
    }
    if (target.id === user.id) {
      reply.code(400).send({ error: "不能添加自己为好友" } satisfies ErrorBody);
      return reply;
    }
    if (store.isFriend(user.id, target.id)) {
      reply.code(400).send({ error: "你们已经是好友了" } satisfies ErrorBody);
      return reply;
    }
    if (store.pendingRequestBetween(user.id, target.id)) {
      reply.code(400).send({ error: "已有待处理的好友申请" } satisfies ErrorBody);
      return reply;
    }
    const record = store.createFriendRequest(user.id, target.id);
    const view = requestView(record, "outgoing", user.id);
    return { ok: true, request: view };
  });

  app.post("/api/friends/accept", async (request, reply) => {
    const user = requireRegisteredUser(request, reply);
    if (!user) return reply;
    const body = bodyOf(request);
    if (typeof body.requestId !== "string" || body.requestId.length === 0) {
      reply.code(400).send({ error: "requestId 不能为空" } satisfies ErrorBody);
      return reply;
    }
    try {
      store.acceptFriendRequest(body.requestId, user.id);
      return { ok: true };
    } catch (error) {
      return sendStoreError(reply, error);
    }
  });

  app.post("/api/friends/reject", async (request, reply) => {
    const user = requireRegisteredUser(request, reply);
    if (!user) return reply;
    const body = bodyOf(request);
    if (typeof body.requestId !== "string" || body.requestId.length === 0) {
      reply.code(400).send({ error: "requestId 不能为空" } satisfies ErrorBody);
      return reply;
    }
    try {
      store.rejectFriendRequest(body.requestId, user.id);
      return { ok: true };
    } catch (error) {
      return sendStoreError(reply, error);
    }
  });

  app.delete("/api/friends/:userId", async (request, reply) => {
    const user = requireRegisteredUser(request, reply);
    if (!user) return reply;
    const params = request.params as { userId?: string };
    if (!params.userId || !store.getUserById(params.userId)) {
      reply.code(404).send({ error: "用户不存在" } satisfies ErrorBody);
      return reply;
    }
    if (!store.isFriend(user.id, params.userId)) {
      reply.code(400).send({ error: "你们还不是好友" } satisfies ErrorBody);
      return reply;
    }
    store.removeFriend(user.id, params.userId);
    return { ok: true };
  });

  app.get("/api/friends/:userId", async (request, reply) => {
    const user = requireRegisteredUser(request, reply);
    if (!user) return reply;
    const params = request.params as { userId?: string };
    const target = params.userId ? store.getUserById(params.userId) : null;
    if (!target || target.isGuest) {
      reply.code(404).send({ error: "用户不存在" } satisfies ErrorBody);
      return reply;
    }
    const isSelf = target.id === user.id;
    const isFriend = store.isFriend(user.id, target.id);
    const statsVisible = isSelf || (isFriend && target.showStatsToFriends !== false);
    const response: FriendProfileResponse = {
      user: friendUserFor(target.id)!,
      statsVisible,
      stats: statsVisible ? store.statsResponse(target.id).total : null,
    };
    return response;
  });

  app.post("/api/friends/message", async (request, reply) => {
    const user = requireRegisteredUser(request, reply);
    if (!user) return reply;
    const body = bodyOf(request);
    const target = registeredTarget(body.userId);
    if (!target) {
      reply.code(404).send({ error: "用户不存在" } satisfies ErrorBody);
      return reply;
    }
    if (!store.isFriend(user.id, target.id)) {
      reply.code(400).send({ error: "只能给好友发送私信" } satisfies ErrorBody);
      return reply;
    }
    if (typeof body.text !== "string") {
      reply.code(400).send({ error: "消息不能为空" } satisfies ErrorBody);
      return reply;
    }
    try {
      const record = store.sendFriendMessage(user.id, target.id, body.text);
      const view = friendMessageView(record);
      return { ok: true, message: view };
    } catch (error) {
      return sendStoreError(reply, error);
    }
  });

  app.get("/api/friends/:userId/messages", async (request, reply) => {
    const user = requireRegisteredUser(request, reply);
    if (!user) return reply;
    const params = request.params as { userId?: string };
    const target = params.userId ? store.getUserById(params.userId) : null;
    if (!target || target.isGuest) {
      reply.code(404).send({ error: "用户不存在" } satisfies ErrorBody);
      return reply;
    }
    if (!store.isFriend(user.id, target.id)) {
      reply.code(403).send({ error: "只能查看好友的私信" } satisfies ErrorBody);
      return reply;
    }
    const query = request.query as { limit?: unknown } | undefined;
    const limit = parseLimit(query?.limit, 50, 100);
    store.markConversationRead(user.id, target.id);
    const messages = store
      .listConversation(user.id, target.id, limit)
      .map((record) => friendMessageView(record))
      .filter((view): view is FriendMessageView => view !== null);
    return { messages, unread: store.unreadNotificationCount(user.id) };
  });

  app.get("/api/notifications", async (request, reply) => {
    const user = requireRegisteredUser(request, reply);
    if (!user) return reply;
    const notifications = store.listNotifications(user.id).map((record) => notificationView(record));
    return { notifications, unread: store.unreadNotificationCount(user.id) };
  });

  app.post("/api/notifications/read", async (request, reply) => {
    const user = requireRegisteredUser(request, reply);
    if (!user) return reply;
    const body = bodyOf(request);
    if (body.all === true) {
      const unread = store.markNotificationRead(user.id, null);
      return { ok: true, unread };
    }
    if (typeof body.id !== "string" || body.id.length === 0) {
      reply.code(400).send({ error: "需要 notification id 或 all:true" } satisfies ErrorBody);
      return reply;
    }
    const unread = store.markNotificationRead(user.id, body.id);
    return { ok: true, unread };
  });

  app.post("/api/friends/invite", async (request, reply) => {
    const user = requireRegisteredUser(request, reply);
    if (!user) return reply;
    const body = bodyOf(request);
    const target = registeredTarget(body.userId);
    if (!target) {
      reply.code(404).send({ error: "用户不存在" } satisfies ErrorBody);
      return reply;
    }
    if (!store.isFriend(user.id, target.id)) {
      reply.code(400).send({ error: "只能邀请好友" } satisfies ErrorBody);
      return reply;
    }
    const roomCode = manager.currentRoomCode(user.id);
    if (!roomCode) {
      reply.code(400).send({ error: "请先进入房间再邀请好友" } satisfies ErrorBody);
      return reply;
    }
    if (!hub.isOnline(target.id)) {
      reply.code(400).send({ error: "好友不在线" } satisfies ErrorBody);
      return reply;
    }
    store.createGameInvite(user.id, target.id, roomCode);
    return { ok: true, roomCode };
  });

  app.get("/api/me/privacy", async (request, reply) => {
    const user = requireRegisteredUser(request, reply);
    if (!user) return reply;
    const settings: PrivacySettings = store.getPrivacy(user.id);
    return settings;
  });

  app.patch("/api/me/privacy", async (request, reply) => {
    const user = requireRegisteredUser(request, reply);
    if (!user) return reply;
    const body = bodyOf(request);
    if (typeof body.showStatsToFriends !== "boolean") {
      reply.code(400).send({ error: "showStatsToFriends 必须是布尔值" } satisfies ErrorBody);
      return reply;
    }
    const settings: PrivacySettings = store.setPrivacy(user.id, body.showStatsToFriends);
    return settings;
  });

  app.delete("/api/me", async (request, reply) => {
    const user = requireRegisteredUser(request, reply, "游客不能注销账号，请先注册");
    if (!user) return reply;
    const deleted = store.deleteUser(user.id);
    if (deleted) {
      streaks.quit(user.id);
      hub.disconnectUser(user.id);
    }
    return { ok: true };
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/") || /\.[a-zA-Z0-9]+(\?|$)/.test(request.url)) {
      reply.code(404).send({ error: "接口不存在" } satisfies ErrorBody);
      return;
    }
    reply.code(200).type("text/html; charset=utf-8").send(fallbackHtml());
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof StoreError) {
      reply.code(error.status).send({ error: error.message } satisfies ErrorBody);
      return;
    }
    if (error instanceof StreakError) {
      reply.code(error.status).send({ error: error.message } satisfies ErrorBody);
      return;
    }
    const message = error instanceof Error ? error.message : "服务器内部错误";
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode;
    reply
      .code(typeof statusCode === "number" && statusCode >= 400 && statusCode < 500 ? statusCode : 500)
      .send({ error: message } satisfies ErrorBody);
  });

  const handle: ServerHandle = {
    app,
    store,
    manager,
    hub,
    url: "",
    async listen(port, host): Promise<number> {
      const listenPort = port ?? Number(process.env.PORT ?? 3000);
      const listenHost = host ?? process.env.HOST ?? "0.0.0.0";
      await app.listen({ port: listenPort, host: listenHost });
      const address = app.server.address();
      const actualPort = address && typeof address === "object" ? address.port : listenPort;
      const displayHost = listenHost === "0.0.0.0" || listenHost === "::" ? "localhost" : listenHost;
      handle.url = `http://${displayHost}:${actualPort}`;
      return actualPort;
    },
    async close(): Promise<void> {
      hub.close();
      manager.shutdown();
      await app.close();
    },
  };
  return handle;
}

function sendStoreError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof StoreError) {
    reply.code(error.status).send({ error: error.message } satisfies ErrorBody);
    return reply;
  }
  reply.code(500).send({ error: error instanceof Error ? error.message : "服务器内部错误" } satisfies ErrorBody);
  return reply;
}

/** Used by the Docker/dev entry point only. */
export async function start(): Promise<ServerHandle> {
  const server = await createServer();
  const port = await server.listen();
  const wsUrl = server.url.replace(/^http/, "ws") + "/ws";
  console.log(`[ciying-arena] http: ${server.url}`);
  console.log(`[ciying-arena] ws:   ${wsUrl}?token=<token>`);
  const shutdown = () => {
    server
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return server;
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
const isMain = entry !== "" && entry === fileURLToPath(import.meta.url);
if (isMain) {
  start().catch((error) => {
    console.error("[ciying-arena] failed to start:", error);
    process.exitCode = 1;
  });
}
