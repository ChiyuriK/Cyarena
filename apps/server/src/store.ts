import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  LeaderboardRow,
  MatchHighlight,
  MatchHistoryRow,
  MatchPlayerSummary,
  MatchSummary,
  Mode,
  PlayerStats,
  PlayerStatsView,
  PublicUser,
  RankedMode,
  RoomRules,
  SessionResponse,
  StatsResponse,
  StreakLeaderboardRow,
  StreakStats,
  StreakVariant,
} from "../../../packages/shared/src/index.ts";
import { DEFAULT_ROOM_RULES, MODES, RANKED_MODES, STREAK_VARIANTS } from "../../../packages/shared/src/index.ts";
import type { RatingEntry } from "../../../packages/engine/src/index.ts";
import { applyRatingChange, createRatingEntry, INITIAL_RATING } from "../../../packages/engine/src/index.ts";
import type { DailyResultRecord } from "./daily.ts";
import { DAILY_KEEP_DAYS, dailyDateKey } from "./daily.ts";

export const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
export const MIN_PASSWORD_LENGTH = 6;
export const NAME_MIN = 1;
export const NAME_MAX = 16;

/** A fresh all-zero per-mode stat row. */
export function emptyPlayerStats(): PlayerStats {
  return {
    matches: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    firsts: 0,
    seconds: 0,
    thirds: 0,
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
}

/** Fill in fields that older store.json versions did not have. */
export function normalizePlayerStats(raw: Partial<PlayerStats> | undefined | null): PlayerStats {
  const next = emptyPlayerStats();
  if (!raw || typeof raw !== "object") return next;
  for (const key of Object.keys(next) as Array<keyof PlayerStats>) {
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value)) next[key] = value;
  }
  return next;
}

/** Add per-match counters into an existing stat row (pure). */
export function applyPlayerStatsDelta(current: PlayerStats, delta: Partial<PlayerStats>): PlayerStats {
  const next: PlayerStats = { ...current };
  const additive: Array<keyof PlayerStats> = [
    "matches",
    "wins",
    "losses",
    "draws",
    "firsts",
    "seconds",
    "thirds",
    "rounds",
    "roundsWithGuess",
    "guesses",
    "solves",
    "totalSolveMs",
    "fastestMatchAwards",
    "points",
    "setsWon",
  ];
  for (const key of additive) {
    const value = delta[key];
    if (typeof value === "number" && Number.isFinite(value)) next[key] += value;
  }
  const fastest = delta.fastestSolveMs;
  if (typeof fastest === "number" && fastest > 0) {
    next.fastestSolveMs = next.fastestSolveMs > 0 ? Math.min(next.fastestSolveMs, fastest) : fastest;
  }
  return next;
}

/** Sum several stat rows into one; fastestSolveMs keeps the best value. */
export function sumPlayerStats(rows: PlayerStats[]): PlayerStats {
  const total = emptyPlayerStats();
  for (const row of rows) {
    total.matches += row.matches;
    total.wins += row.wins;
    total.losses += row.losses;
    total.draws += row.draws;
    total.firsts += row.firsts;
    total.seconds += row.seconds;
    total.thirds += row.thirds;
    total.rounds += row.rounds;
    total.roundsWithGuess += row.roundsWithGuess;
    total.guesses += row.guesses;
    total.solves += row.solves;
    total.totalSolveMs += row.totalSolveMs;
    total.fastestMatchAwards += row.fastestMatchAwards;
    total.points += row.points;
    total.setsWon += row.setsWon;
    if (row.fastestSolveMs > 0) {
      total.fastestSolveMs =
        total.fastestSolveMs > 0 ? Math.min(total.fastestSolveMs, row.fastestSolveMs) : row.fastestSolveMs;
    }
  }
  return total;
}

/** Attach derived rates for the API. */
export function toStatsView(stats: PlayerStats): PlayerStatsView {
  return {
    ...stats,
    winRate: stats.matches > 0 ? stats.wins / stats.matches : 0,
    solveRate: stats.roundsWithGuess > 0 ? stats.solves / stats.roundsWithGuess : 0,
    guessAccuracy: stats.guesses > 0 ? stats.solves / stats.guesses : 0,
    avgSolveMs: stats.solves > 0 ? stats.totalSolveMs / stats.solves : 0,
  };
}

/** Error that carries an HTTP-ish status code for the REST layer. */
export class StoreError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "StoreError";
    this.status = status;
  }
}

export interface StoredUser {
  id: string;
  name: string;
  avatar: string;
  username?: string;
  isGuest: boolean;
  createdAt: number;
  passHash?: string;
  salt?: string;
  /** Recently served answers (registered users only, newest first, max 30). */
  recentIdioms?: Array<{ word: string; at: number }>;
  /** Best streak per streak variant. */
  streakBest?: Record<StreakVariant, number>;
  /** Aggregated streak counters across all variants. */
  streakStats?: StreakStats;
  /** Bidirectional friend ids. */
  friendIds?: string[];
  /** Whether friends may see this user's per-mode statistics. */
  showStatsToFriends?: boolean;
}

/** Default avatar: the first character of the nickname (or a fallback emoji). */
export function defaultAvatarFor(name: string): string {
  const first = Array.from(String(name ?? "").trim())[0];
  return first && first.length > 0 ? first : "🎯";
}

const MAX_AVATAR_TEXT_LENGTH = 16;
/** Uploaded avatars are compressed to 96x96 JPEG by the client; allow a few KB. */
const MAX_AVATAR_DATA_URL_LENGTH = 20_000;
const AVATAR_DATA_URL_PATTERN = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const AVATAR_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * Avatars are either a short emoji/text (1~16 characters) or an inline
 * base64 image data URL (png/jpeg/webp, up to 20k characters). External URLs,
 * SVG and HTML are rejected so the client can render the value safely.
 */
export function validateAvatar(raw: unknown): string {
  if (typeof raw !== "string") throw new StoreError("头像格式不正确", 400);
  const avatar = raw.trim();
  if (avatar.length === 0) throw new StoreError("头像不能为空", 400);
  if (avatar.startsWith("//")) {
    throw new StoreError("头像不支持外部链接，请上传 png/jpeg/webp 图片", 400);
  }
  if (AVATAR_SCHEME_PATTERN.test(avatar)) {
    if (!avatar.startsWith("data:")) {
      throw new StoreError("头像不支持外部链接，请上传 png/jpeg/webp 图片", 400);
    }
    if (avatar.length > MAX_AVATAR_DATA_URL_LENGTH) {
      throw new StoreError(`头像图片过大，请控制在 ${MAX_AVATAR_DATA_URL_LENGTH} 字符以内`, 400);
    }
    if (!AVATAR_DATA_URL_PATTERN.test(avatar)) {
      throw new StoreError("头像仅支持 png/jpeg/webp 的 base64 图片", 400);
    }
    return avatar;
  }
  if (/[<>\u0000-\u001f\u007f]/.test(avatar)) {
    throw new StoreError("头像包含非法字符", 400);
  }
  const length = Array.from(avatar).length;
  if (length < 1 || length > MAX_AVATAR_TEXT_LENGTH) {
    throw new StoreError(`头像长度需为 1~${MAX_AVATAR_TEXT_LENGTH} 个字符`, 400);
  }
  return avatar;
}

function normalizeStoredUser(raw: Partial<StoredUser>): StoredUser {
  const user: StoredUser = {
    id: String(raw.id ?? createId("u")),
    name: String(raw.name ?? "玩家"),
    avatar: typeof raw.avatar === "string" && raw.avatar.length > 0 ? raw.avatar : defaultAvatarFor(String(raw.name ?? "")),
    isGuest: Boolean(raw.isGuest),
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(),
  };
  if (typeof raw.username === "string" && raw.username.length > 0) user.username = raw.username;
  if (typeof raw.passHash === "string") user.passHash = raw.passHash;
  if (typeof raw.salt === "string") user.salt = raw.salt;
  user.recentIdioms = normalizeRecentIdioms(raw.recentIdioms);
  user.streakBest = normalizeStreakBest(raw.streakBest);
  user.streakStats = normalizeStreakStats(raw.streakStats);
  user.friendIds = Array.isArray(raw.friendIds)
    ? [...new Set(raw.friendIds.filter((id): id is string => typeof id === "string" && id.length > 0))]
    : [];
  user.showStatsToFriends = raw.showStatsToFriends !== false;
  return user;
}

export const RECENT_IDIOM_LIMIT = 30;

function normalizeRecentIdioms(raw: unknown): Array<{ word: string; at: number }> {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const rows: Array<{ word: string; at: number }> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const word = (entry as { word?: unknown }).word;
    const at = (entry as { at?: unknown }).at;
    if (typeof word !== "string" || word.length === 0 || seen.has(word)) continue;
    seen.add(word);
    rows.push({ word, at: typeof at === "number" && Number.isFinite(at) ? at : 0 });
    if (rows.length >= RECENT_IDIOM_LIMIT) break;
  }
  return rows;
}

export function emptyStreakBest(): Record<StreakVariant, number> {
  return { standard: 0, free: 0, advanced: 0 };
}

export function emptyStreakStats(): StreakStats {
  return { runs: 0, solved: 0, best: 0, totalSolveMs: 0, fastestSolveMs: 0 };
}

function normalizeStreakBest(raw: unknown): Record<StreakVariant, number> {
  const result = emptyStreakBest();
  if (!raw || typeof raw !== "object") return result;
  for (const variant of STREAK_VARIANTS) {
    const value = (raw as Record<string, unknown>)[variant];
    result[variant] = typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  }
  return result;
}

function normalizeStreakStats(raw: unknown): StreakStats {
  const result = emptyStreakStats();
  if (!raw || typeof raw !== "object") return result;
  for (const key of ["runs", "solved", "best", "totalSolveMs", "fastestSolveMs"] as const) {
    const value = (raw as Record<string, unknown>)[key];
    result[key] = typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  }
  return result;
}

function defaultRulesForMode(mode: Mode): RoomRules {
  return {
    ...DEFAULT_ROOM_RULES,
    bestOf: 1,
    guessMode: "standard",
    dictionary: "common",
    pointsToWin: mode === "ffa3" ? 7 : 11,
  };
}

/** Fill in fields that older store.json versions did not have. */
function normalizeMatchSummary(raw: MatchSummary): MatchSummary {
  const mode = raw.mode;
  const fallbackRules = defaultRulesForMode(mode);
  return {
    ...raw,
    forfeitById: raw.forfeitById ?? null,
    forfeitTeam: raw.forfeitTeam ?? null,
    winnerId: raw.winnerId ?? null,
    rules: raw.rules ?? fallbackRules,
    setHistory: Array.isArray(raw.setHistory) ? raw.setHistory : [],
    highlights: normalizeHighlights(raw.highlights),
    players: Array.isArray(raw.players)
      ? raw.players.map((player) => ({
          ...player,
          avatar: player.avatar ?? defaultAvatarFor(player.name),
          setWins: typeof player.setWins === "number" ? player.setWins : 0,
        }))
      : [],
  };
}

function normalizeHighlights(raw: unknown): Record<string, MatchHighlight[]> {
  if (!raw || typeof raw !== "object") return {};
  const result: Record<string, MatchHighlight[]> = {};
  for (const [playerId, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const highlights: MatchHighlight[] = [];
    for (const entry of list) {
      if (!entry || typeof entry !== "object") continue;
      const word = (entry as { word?: unknown }).word;
      const guesses = (entry as { guesses?: unknown }).guesses;
      if (typeof word !== "string" || word.length === 0) continue;
      highlights.push({ word, guesses: typeof guesses === "number" && guesses > 0 ? Math.floor(guesses) : 1 });
    }
    result[playerId] = highlights.slice(0, 3);
  }
  return result;
}

function normalizeDailyResult(raw: unknown): DailyResultRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Partial<DailyResultRecord>;
  const date = typeof record.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(record.date) ? record.date : null;
  const userId = typeof record.userId === "string" && record.userId.length > 0 ? record.userId : null;
  if (!date || !userId) return null;
  const guesses = Array.isArray(record.guesses)
    ? record.guesses.filter((word): word is string => typeof word === "string" && word.length > 0)
    : [];
  const solved = Boolean(record.solved);
  const solvedAt =
    solved && typeof record.solvedAt === "number" && Number.isFinite(record.solvedAt) ? record.solvedAt : null;
  const attempts =
    typeof record.attempts === "number" && Number.isFinite(record.attempts) && record.attempts >= 0
      ? Math.floor(record.attempts)
      : guesses.length;
  // Older records have no startedAt/durationMs: fall back to solvedAt.
  const startedAt =
    typeof record.startedAt === "number" && Number.isFinite(record.startedAt)
      ? record.startedAt
      : solvedAt;
  const derivedDuration =
    solved && solvedAt !== null && startedAt !== null ? Math.max(0, solvedAt - startedAt) : null;
  const durationMs =
    typeof record.durationMs === "number" && Number.isFinite(record.durationMs)
      ? Math.max(0, Math.floor(record.durationMs))
      : derivedDuration;
  return { date, userId, guesses, solved, solvedAt, attempts, startedAt, durationMs };
}

export interface FriendRequestRecord {
  id: string;
  fromUserId: string;
  toUserId: string;
  status: "pending" | "accepted" | "rejected";
  createdAt: number;
}

export interface FriendMessageRecord {
  id: string;
  fromUserId: string;
  toUserId: string;
  text: string;
  createdAt: number;
  read: boolean;
}

export interface FriendNotificationRecord {
  id: string;
  userId: string;
  type: "friend_request" | "friend_message" | "game_invite";
  title: string;
  text: string;
  createdAt: number;
  read: boolean;
  fromUserId: string | null;
  roomCode: string | null;
  messageId: string | null;
}

function normalizeFriendRequest(raw: unknown): FriendRequestRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Partial<FriendRequestRecord>;
  const id = typeof record.id === "string" && record.id.length > 0 ? record.id : null;
  const fromUserId = typeof record.fromUserId === "string" && record.fromUserId.length > 0 ? record.fromUserId : null;
  const toUserId = typeof record.toUserId === "string" && record.toUserId.length > 0 ? record.toUserId : null;
  const status =
    record.status === "accepted" || record.status === "rejected" || record.status === "pending"
      ? record.status
      : "pending";
  if (!id || !fromUserId || !toUserId) return null;
  return {
    id,
    fromUserId,
    toUserId,
    status,
    createdAt: typeof record.createdAt === "number" && Number.isFinite(record.createdAt) ? record.createdAt : 0,
  };
}

function normalizeFriendMessage(raw: unknown): FriendMessageRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Partial<FriendMessageRecord>;
  const id = typeof record.id === "string" && record.id.length > 0 ? record.id : null;
  const fromUserId = typeof record.fromUserId === "string" && record.fromUserId.length > 0 ? record.fromUserId : null;
  const toUserId = typeof record.toUserId === "string" && record.toUserId.length > 0 ? record.toUserId : null;
  const text = typeof record.text === "string" ? record.text.trim() : "";
  if (!id || !fromUserId || !toUserId || text.length === 0) return null;
  return {
    id,
    fromUserId,
    toUserId,
    text: text.slice(0, 500),
    createdAt: typeof record.createdAt === "number" && Number.isFinite(record.createdAt) ? record.createdAt : 0,
    read: Boolean(record.read),
  };
}

function normalizeFriendNotification(raw: unknown): FriendNotificationRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Partial<FriendNotificationRecord>;
  const id = typeof record.id === "string" && record.id.length > 0 ? record.id : null;
  const userId = typeof record.userId === "string" && record.userId.length > 0 ? record.userId : null;
  const type =
    record.type === "friend_request" || record.type === "friend_message" || record.type === "game_invite"
      ? record.type
      : null;
  if (!id || !userId || !type) return null;
  return {
    id,
    userId,
    type,
    title: typeof record.title === "string" ? record.title : "",
    text: typeof record.text === "string" ? record.text : "",
    createdAt: typeof record.createdAt === "number" && Number.isFinite(record.createdAt) ? record.createdAt : 0,
    read: Boolean(record.read),
    fromUserId: typeof record.fromUserId === "string" && record.fromUserId.length > 0 ? record.fromUserId : null,
    roomCode: typeof record.roomCode === "string" && record.roomCode.length > 0 ? record.roomCode : null,
    messageId: typeof record.messageId === "string" && record.messageId.length > 0 ? record.messageId : null,
  };
}

interface StoreShape {
  version: number;
  users: StoredUser[];
  /** token -> userId */
  sessions: Record<string, string>;
  /** Ladder ratings are stored for ranked modes only. */
  ratings: Record<RankedMode, Record<string, RatingEntry>>;
  stats: Record<Mode, Record<string, PlayerStats>>;
  matches: MatchSummary[];
  /** `${date}:${userId}` -> daily attempt. */
  daily: Record<string, DailyResultRecord>;
  friendRequests: FriendRequestRecord[];
  friendMessages: FriendMessageRecord[];
  friendNotifications: FriendNotificationRecord[];
}

export interface StoreOptions {
  dataDir?: string;
  /** Set to false to keep everything in memory (used by tests). */
  persist?: boolean;
}

function emptyShape(): StoreShape {
  const ratings = {} as Record<RankedMode, Record<string, RatingEntry>>;
  const stats = {} as Record<Mode, Record<string, PlayerStats>>;
  for (const mode of RANKED_MODES) ratings[mode] = {};
  for (const mode of MODES) stats[mode] = {};
  return {
    version: 1,
    users: [],
    sessions: {},
    ratings,
    stats,
    matches: [],
    daily: {},
    friendRequests: [],
    friendMessages: [],
    friendNotifications: [],
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Validate/normalize a display name. Returns null when valid. */
export function validateDisplayName(raw: unknown): string | null {
  if (typeof raw !== "string") return "昵称必须是字符串";
  const name = raw.trim();
  const length = Array.from(name).length;
  if (length < NAME_MIN) return "昵称不能为空";
  if (length > NAME_MAX) return `昵称最多 ${NAME_MAX} 个字符`;
  return null;
}

/** Validate a username. Returns null when valid. */
export function validateUsername(raw: unknown): string | null {
  if (typeof raw !== "string") return "用户名必须是字符串";
  const username = raw.trim();
  if (username.length < 3 || username.length > 20) return "用户名需为 3~20 位字母、数字或下划线";
  if (!USERNAME_RE.test(username)) return "用户名只能包含字母、数字或下划线";
  return null;
}

/** Validate a password. Returns null when valid. */
export function validatePassword(raw: unknown): string | null {
  if (typeof raw !== "string") return "密码必须是字符串";
  if (raw.length < MIN_PASSWORD_LENGTH) return `密码至少 ${MIN_PASSWORD_LENGTH} 位`;
  if (raw.length > 128) return "密码过长";
  return null;
}

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString("hex");
}

function verifyPassword(password: string, salt: string, expectedHex: string): boolean {
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, "hex");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

function createId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

/** JSON backed persistence for users, sessions, ratings and match history. */
export class Store {
  readonly dataDir: string;
  readonly filePath: string;
  readonly persist: boolean;
  private data: StoreShape;

  constructor(options: StoreOptions = {}) {
    this.dataDir = resolve(options.dataDir ?? process.env.DATA_DIR ?? "./data");
    this.filePath = join(this.dataDir, "store.json");
    this.persist = options.persist ?? true;
    this.data = this.load();
  }

  private load(): StoreShape {
    if (!this.persist) return emptyShape();
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<StoreShape>;
      const shape = emptyShape();
      shape.users = Array.isArray(parsed.users)
        ? (parsed.users as StoredUser[]).map((user) => normalizeStoredUser(user))
        : [];
      shape.sessions = parsed.sessions && typeof parsed.sessions === "object" ? { ...parsed.sessions } : {};
      shape.matches = Array.isArray(parsed.matches)
        ? (parsed.matches as MatchSummary[]).map((match) => normalizeMatchSummary(match))
        : [];
      if (parsed.ratings && typeof parsed.ratings === "object") {
        for (const mode of RANKED_MODES) {
          const bucket = (parsed.ratings as Record<string, unknown>)[mode];
          if (bucket && typeof bucket === "object") shape.ratings[mode] = { ...(bucket as Record<string, never>) };
        }
      }
      if (parsed.stats && typeof parsed.stats === "object") {
        for (const mode of MODES) {
          const bucket = parsed.stats[mode];
          if (!bucket || typeof bucket !== "object") continue;
          const rows: Record<string, PlayerStats> = {};
          for (const [userId, row] of Object.entries(bucket)) {
            rows[userId] = normalizePlayerStats(row as Partial<PlayerStats>);
          }
          shape.stats[mode] = rows;
        }
      }
      if (parsed.daily && typeof parsed.daily === "object") {
        for (const value of Object.values(parsed.daily as Record<string, unknown>)) {
          const entry = normalizeDailyResult(value);
          if (entry) shape.daily[`${entry.date}:${entry.userId}`] = entry;
        }
      }
      if (Array.isArray(parsed.friendRequests)) {
        shape.friendRequests = parsed.friendRequests
          .map((entry) => normalizeFriendRequest(entry))
          .filter((entry): entry is FriendRequestRecord => entry !== null);
      }
      if (Array.isArray(parsed.friendMessages)) {
        shape.friendMessages = parsed.friendMessages
          .map((entry) => normalizeFriendMessage(entry))
          .filter((entry): entry is FriendMessageRecord => entry !== null);
      }
      if (Array.isArray(parsed.friendNotifications)) {
        shape.friendNotifications = parsed.friendNotifications
          .map((entry) => normalizeFriendNotification(entry))
          .filter((entry): entry is FriendNotificationRecord => entry !== null);
      }
      this.prune(shape);
      return shape;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return emptyShape();
      // A corrupt store should not prevent the server from starting.
      try {
        renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
      } catch {
        /* ignore */
      }
      return emptyShape();
    }
  }

  /** Drop long dead guests that no session points to. */
  private prune(shape: StoreShape): void {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const activeUserIds = new Set(Object.values(shape.sessions));
    shape.users = shape.users.filter(
      (user) => !user.isGuest || activeUserIds.has(user.id) || user.createdAt >= cutoff,
    );
    const known = new Set(shape.users.map((user) => user.id));
    // Sessions that reference removed users are useless.
    for (const [token, userId] of Object.entries(shape.sessions)) {
      if (!known.has(userId)) delete shape.sessions[token];
    }
    // Daily results older than the retention window are dropped.
    const dailyCutoff = dailyDateKey(new Date(Date.now() - DAILY_KEEP_DAYS * 24 * 60 * 60 * 1000));
    for (const [key, entry] of Object.entries(shape.daily)) {
      if (entry.date < dailyCutoff) delete shape.daily[key];
    }
    // Friendships and social records only reference known users.
    for (const user of shape.users) {
      user.friendIds = (user.friendIds ?? []).filter((id) => id !== user.id && known.has(id));
    }
    for (const user of shape.users) {
      const ids = user.friendIds ?? [];
      for (const friendId of ids) {
        const friend = shape.users.find((candidate) => candidate.id === friendId);
        if (!friend) continue;
        if (!(friend.friendIds ?? []).includes(user.id)) {
          friend.friendIds = [...(friend.friendIds ?? []), user.id];
        }
      }
    }
    shape.friendRequests = shape.friendRequests.filter(
      (entry) => known.has(entry.fromUserId) && known.has(entry.toUserId),
    );
    shape.friendMessages = shape.friendMessages.filter(
      (entry) => known.has(entry.fromUserId) && known.has(entry.toUserId),
    );
    shape.friendNotifications = shape.friendNotifications.filter(
      (entry) => known.has(entry.userId) && (entry.fromUserId === null || known.has(entry.fromUserId)),
    );
  }

  private ensureDir(): void {
    if (!this.persist) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
  }

  /** Atomic write (tmp file + rename). */
  save(): void {
    if (!this.persist) return;
    this.ensureDir();
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
    try {
      renameSync(tmp, this.filePath);
    } catch {
      // Windows can refuse to replace an existing file in rare cases.
      try {
        unlinkSync(this.filePath);
      } catch {
        /* ignore */
      }
      renameSync(tmp, this.filePath);
    }
  }

  // ------------------------------------------------------------------
  // users / sessions
  // ------------------------------------------------------------------

  getUserById(id: string): StoredUser | null {
    return this.data.users.find((user) => user.id === id) ?? null;
  }

  getUserByUsername(username: string): StoredUser | null {
    const wanted = username.trim().toLowerCase();
    return this.data.users.find((user) => !user.isGuest && (user.username ?? "").toLowerCase() === wanted) ?? null;
  }

  userCount(): number {
    return this.data.users.length;
  }

  toPublicUser(user: StoredUser): PublicUser {
    const publicUser: PublicUser = {
      id: user.id,
      name: user.name,
      avatar: user.avatar || defaultAvatarFor(user.name),
      isGuest: user.isGuest,
    };
    if (user.username) publicUser.username = user.username;
    return publicUser;
  }

  /** Registered users only (guests are ignored). */
  registeredUserCount(): number {
    return this.data.users.filter((user) => !user.isGuest).length;
  }

  /** True when another registered user already uses this display name (case-insensitive). */
  isDisplayNameTaken(name: string, excludeUserId?: string): boolean {
    const wanted = String(name ?? "").trim().toLowerCase();
    if (!wanted) return false;
    return this.data.users.some(
      (user) =>
        !user.isGuest &&
        user.id !== excludeUserId &&
        user.name.trim().toLowerCase() === wanted,
    );
  }

  createSession(userId: string): string {
    const token = randomBytes(32).toString("hex");
    this.data.sessions[token] = userId;
    this.save();
    return token;
  }

  getSessionUserId(token: string | undefined | null): string | null {
    if (!isNonEmptyString(token)) return null;
    return this.data.sessions[token] ?? null;
  }

  me(token: string | undefined | null): PublicUser | null {
    const userId = this.getSessionUserId(token);
    if (!userId) return null;
    const user = this.getUserById(userId);
    return user ? this.toPublicUser(user) : null;
  }

  logout(token: string | undefined | null): boolean {
    if (!isNonEmptyString(token) || !(token in this.data.sessions)) return false;
    delete this.data.sessions[token];
    this.save();
    return true;
  }

  createGuest(rawName: unknown): SessionResponse {
    const error = validateDisplayName(rawName);
    if (error) throw new StoreError(error, 400);
    const name = (rawName as string).trim();
    const user: StoredUser = {
      id: createId("u"),
      name,
      avatar: defaultAvatarFor(name),
      isGuest: true,
      createdAt: Date.now(),
      recentIdioms: [],
    };
    this.data.users.push(user);
    const token = this.createSession(user.id);
    return { token, user: this.toPublicUser(user) };
  }

  register(input: { username: unknown; password: unknown; name?: unknown }): SessionResponse {
    const usernameError = validateUsername(input.username);
    if (usernameError) throw new StoreError(usernameError, 400);
    const passwordError = validatePassword(input.password);
    if (passwordError) throw new StoreError(passwordError, 400);
    const username = (input.username as string).trim();
    const nameError = validateDisplayName(input.name ?? username);
    if (nameError) throw new StoreError(nameError, 400);
    const name = String(input.name ?? username).trim();
    if (this.getUserByUsername(username)) throw new StoreError("用户名已被占用", 409);
    if (this.isDisplayNameTaken(name)) throw new StoreError("昵称已被使用", 409);

    const salt = randomBytes(16).toString("hex");
    const user: StoredUser = {
      id: createId("u"),
      name,
      avatar: defaultAvatarFor(name),
      username,
      isGuest: false,
      createdAt: Date.now(),
      salt,
      passHash: hashPassword(input.password as string, salt),
      recentIdioms: [],
      streakBest: emptyStreakBest(),
      streakStats: emptyStreakStats(),
      friendIds: [],
      showStatsToFriends: true,
    };
    this.data.users.push(user);
    const token = this.createSession(user.id);
    return { token, user: this.toPublicUser(user) };
  }

  /** Update display name / avatar for a registered user. */
  updateProfile(userId: string, patch: { name?: unknown; avatar?: unknown }): PublicUser {
    const user = this.getUserById(userId);
    if (!user) throw new StoreError("用户不存在", 404);
    if (user.isGuest) throw new StoreError("游客不能修改资料，请先注册", 403);
    if (patch.name !== undefined) {
      const error = validateDisplayName(patch.name);
      if (error) throw new StoreError(error, 400);
      const name = String(patch.name).trim();
      if (this.isDisplayNameTaken(name, user.id)) throw new StoreError("昵称已被使用", 409);
      user.name = name;
    }
    if (patch.avatar !== undefined) {
      user.avatar = validateAvatar(patch.avatar);
    }
    this.save();
    return this.toPublicUser(user);
  }

  /**
   * Remember an answer served to a registered player: dedupe, newest first,
   * at most RECENT_IDIOM_LIMIT entries. Guests and practice boards are ignored.
   */
  recordRecentIdiom(userId: string, word: string, at = Date.now()): void {
    const user = this.getUserById(userId);
    if (!user || user.isGuest) return;
    const trimmed = String(word ?? "").trim();
    if (trimmed.length === 0) return;
    const rows = (user.recentIdioms ?? []).filter((entry) => entry.word !== trimmed);
    rows.unshift({ word: trimmed, at });
    user.recentIdioms = rows.slice(0, RECENT_IDIOM_LIMIT);
    this.save();
  }

  /** Recent answers for a user, newest first (raw entries without explanations). */
  recentIdiomsFor(userId: string): Array<{ word: string; at: number }> {
    const user = this.getUserById(userId);
    if (!user) return [];
    return (user.recentIdioms ?? []).map((entry) => ({ word: entry.word, at: entry.at }));
  }

  /** Delete a guest account together with all of its sessions. */
  deleteGuest(userId: string): boolean {
    const user = this.getUserById(userId);
    if (!user || !user.isGuest) return false;
    this.data.users = this.data.users.filter((candidate) => candidate.id !== userId);
    for (const [token, sessionUserId] of Object.entries(this.data.sessions)) {
      if (sessionUserId === userId) delete this.data.sessions[token];
    }
    this.save();
    return true;
  }

  login(input: { username: unknown; password: unknown }): SessionResponse {
    if (typeof input.username !== "string" || typeof input.password !== "string") {
      throw new StoreError("请输入用户名和密码", 400);
    }
    const user = this.getUserByUsername(input.username);
    if (!user || user.isGuest || !user.passHash || !user.salt) {
      throw new StoreError("用户名或密码错误", 401);
    }
    if (!verifyPassword(input.password, user.salt, user.passHash)) {
      throw new StoreError("用户名或密码错误", 401);
    }
    const token = this.createSession(user.id);
    return { token, user: this.toPublicUser(user) };
  }

  // ------------------------------------------------------------------
  // ratings
  // ------------------------------------------------------------------

  getRating(mode: Mode, userId: string): RatingEntry {
    // Practice never participates in the ladder.
    if (mode === "practice") return createRatingEntry(INITIAL_RATING);
    const bucket = this.data.ratings[mode];
    const entry = bucket[userId];
    if (!entry) return createRatingEntry(INITIAL_RATING);
    return {
      rating: typeof entry.rating === "number" ? entry.rating : INITIAL_RATING,
      games: entry.games ?? 0,
      wins: entry.wins ?? 0,
      losses: entry.losses ?? 0,
      draws: entry.draws ?? 0,
    };
  }

  setRating(mode: Mode, userId: string, entry: RatingEntry): void {
    if (mode === "practice") return;
    this.data.ratings[mode][userId] = entry;
  }

  /** Apply one rating change row to the persisted entry. */
  applyRating(mode: Mode, userId: string, before: number, after: number, delta: number, result: 0 | 0.5 | 1): RatingEntry {
    const current = this.getRating(mode, userId);
    if (mode === "practice") return current;
    const updated = applyRatingChange(current, { userId, before, after, delta, result });
    this.data.ratings[mode][userId] = updated;
    return updated;
  }

  leaderboard(mode: RankedMode, limit = 50): LeaderboardRow[] {
    const rows: Array<LeaderboardRow & { games: number }> = [];
    for (const user of this.data.users) {
      if (user.isGuest) continue;
      const entry = this.data.ratings[mode][user.id];
      if (!entry) continue;
      const stats = this.data.stats[mode][user.id];
      rows.push({
        rank: 0,
        userId: user.id,
        name: user.name,
        avatar: user.avatar || defaultAvatarFor(user.name),
        rating: entry.rating,
        games: entry.games,
        wins: entry.wins,
        losses: entry.losses,
        draws: entry.draws,
        firsts: stats?.firsts ?? 0,
        seconds: stats?.seconds ?? 0,
        thirds: stats?.thirds ?? 0,
      });
    }
    rows.sort((a, b) => b.rating - a.rating || b.games - a.games || a.name.localeCompare(b.name));
    return rows.slice(0, Math.max(1, limit)).map((row, index) => ({ ...row, rank: index + 1 }));
  }

  // ------------------------------------------------------------------
  // per-mode player statistics
  // ------------------------------------------------------------------

  getPlayerStats(mode: Mode, userId: string): PlayerStats {
    const entry = this.data.stats[mode][userId];
    return entry ? { ...emptyPlayerStats(), ...entry } : emptyPlayerStats();
  }

  /** Merge one finished-match delta into the persisted stat row. */
  mergePlayerStats(mode: Mode, userId: string, delta: Partial<PlayerStats>): PlayerStats {
    const current = this.getPlayerStats(mode, userId);
    const next = applyPlayerStatsDelta(current, delta);
    this.data.stats[mode][userId] = next;
    return next;
  }

  /** Stats response for the profile page: per-mode rows plus an aggregated total. */
  statsResponse(userId: string): StatsResponse {
    const modes = {} as Record<Mode, PlayerStatsView>;
    const rankedRows: PlayerStats[] = [];
    for (const mode of MODES) {
      const row = this.getPlayerStats(mode, userId);
      modes[mode] = toStatsView(row);
      if (mode !== "practice") rankedRows.push(row);
    }
    // total excludes practice by design.
    return { total: toStatsView(sumPlayerStats(rankedRows)), modes };
  }

  // ------------------------------------------------------------------
  // matches
  // ------------------------------------------------------------------

  addMatch(summary: MatchSummary): void {
    this.data.matches.unshift(summary);
    const maxStored = 200;
    if (this.data.matches.length > maxStored) this.data.matches.length = maxStored;
    this.save();
  }

  recentMatches(limit = 20): MatchSummary[] {
    return this.data.matches.slice(0, Math.max(1, limit));
  }

  /** Personal ranked match history (practice matches are never stored anyway). */
  matchHistory(userId: string, limit = 20): MatchHistoryRow[] {
    return this.data.matches
      .filter((match) => match.mode !== "practice" && match.players.some((player) => player.id === userId))
      .slice(0, Math.max(1, limit))
      .map((match) => {
        const me = match.players.find((player) => player.id === userId);
        const setWins: Record<string, number> = {};
        const smallScores: Record<string, number> = {};
        for (const player of match.players) {
          setWins[player.id] = player.setWins ?? 0;
          smallScores[player.id] = player.score;
        }
        const players: MatchPlayerSummary[] = match.players.map((player) => ({
          ...player,
          avatar: player.avatar ?? defaultAvatarFor(player.name),
          setWins: player.setWins ?? 0,
        }));
        return {
          id: match.id,
          mode: match.mode,
          endedAt: match.endedAt,
          opponentNames: match.players.filter((player) => player.id !== userId).map((player) => player.name),
          winnerName: match.winnerName,
          winnerId: match.winnerId ?? null,
          winnerTeam: match.winnerTeam,
          isDraw: match.isDraw,
          forfeit: Boolean(match.forfeitById || match.forfeitTeam),
          setWins,
          setHistory: match.setHistory ?? [],
          players,
          ratingBefore: me?.ratingBefore ?? null,
          ratingAfter: me?.ratingAfter ?? null,
          ratingDelta: me?.ratingDelta ?? null,
          smallScores,
        } satisfies MatchHistoryRow;
      });
  }

  getDailyResult(date: string, userId: string): DailyResultRecord | null {
    const entry = this.data.daily[`${date}:${userId}`];
    if (!entry) return null;
    return { ...entry, guesses: [...entry.guesses] };
  }

  /** Persist (or replace) one user's daily result. */
  saveDailyResult(record: DailyResultRecord): void {
    const stored: DailyResultRecord = { ...record, guesses: [...record.guesses] };
    this.data.daily[`${record.date}:${record.userId}`] = stored;
    this.save();
  }

  /** Every stored attempt for one date (used to build the daily leaderboard). */
  listDailyResults(date: string): DailyResultRecord[] {
    return Object.values(this.data.daily)
      .filter((entry) => entry.date === date)
      .map((entry) => ({ ...entry, guesses: [...entry.guesses] }));
  }

  /** Daily attempts of one user (used for streak-day calculations). */
  dailyResultsForUser(userId: string): DailyResultRecord[] {
    return Object.values(this.data.daily)
      .filter((entry) => entry.userId === userId)
      .map((entry) => ({ ...entry, guesses: [...entry.guesses] }));
  }

  // ------------------------------------------------------------------
  // streak challenge
  // ------------------------------------------------------------------

  getStreakBest(userId: string): Record<StreakVariant, number> {
    const user = this.getUserById(userId);
    return normalizeStreakBest(user?.streakBest);
  }

  getStreakStats(userId: string): StreakStats {
    const user = this.getUserById(userId);
    return normalizeStreakStats(user?.streakStats);
  }

  /** Called when a new streak run starts (quit/fail still counts as a run). */
  recordStreakStart(userId: string): StreakStats {
    const user = this.getUserById(userId);
    if (!user) return emptyStreakStats();
    const stats = normalizeStreakStats(user.streakStats);
    stats.runs += 1;
    user.streakStats = stats;
    this.save();
    return stats;
  }

  /** One correct idiom inside a streak run. */
  recordStreakSolved(userId: string, solveMs = 0): StreakStats {
    const user = this.getUserById(userId);
    if (!user) return emptyStreakStats();
    const stats = normalizeStreakStats(user.streakStats);
    stats.solved += 1;
    const ms = Math.max(0, Math.floor(Number(solveMs) || 0));
    stats.totalSolveMs += ms;
    if (ms > 0 && (stats.fastestSolveMs === 0 || ms < stats.fastestSolveMs)) {
      stats.fastestSolveMs = ms;
    }
    user.streakStats = stats;
    this.save();
    return stats;
  }

  /** Persist the best streak for one variant and the aggregated best. */
  updateStreakBest(userId: string, variant: StreakVariant, streak: number): Record<StreakVariant, number> {
    const user = this.getUserById(userId);
    if (!user) return emptyStreakBest();
    const best = normalizeStreakBest(user.streakBest);
    if (streak > best[variant]) best[variant] = streak;
    user.streakBest = best;
    const stats = normalizeStreakStats(user.streakStats);
    if (streak > stats.best) stats.best = streak;
    user.streakStats = stats;
    this.save();
    return best;
  }

  /** Global best-streak leaderboard for one variant. */
  streakLeaderboard(variant: StreakVariant, limit = 50): StreakLeaderboardRow[] {
    const rows: Array<Omit<StreakLeaderboardRow, "rank">> = [];
    for (const user of this.data.users) {
      if (user.isGuest) continue;
      const best = normalizeStreakBest(user.streakBest)[variant];
      if (best <= 0) continue;
      rows.push({
        userId: user.id,
        name: user.name,
        avatar: user.avatar || defaultAvatarFor(user.name),
        best,
      });
    }
    rows.sort((a, b) => b.best - a.best || a.name.localeCompare(b.name));
    return rows.slice(0, Math.max(1, limit)).map((row, index) => ({ ...row, rank: index + 1 }));
  }

  // ------------------------------------------------------------------
  // friends / messages / notifications / privacy
  // ------------------------------------------------------------------

  getFriendIds(userId: string): string[] {
    return [...(this.getUserById(userId)?.friendIds ?? [])];
  }

  isFriend(a: string, b: string): boolean {
    if (a === b) return false;
    return this.getUserById(a)?.friendIds?.includes(b) ?? false;
  }

  /** Registered users whose nickname contains the query (excluding self). */
  searchUsers(query: string, selfId: string, limit = 20): StoredUser[] {
    const wanted = String(query ?? "").trim().toLowerCase();
    if (!wanted) return [];
    return this.data.users
      .filter(
        (user) =>
          !user.isGuest &&
          user.id !== selfId &&
          user.name.toLowerCase().includes(wanted),
      )
      .slice(0, limit);
  }

  /** pending request from one side to the other, if any. */
  pendingRequestBetween(fromUserId: string, toUserId: string): FriendRequestRecord | null {
    return (
      this.data.friendRequests.find(
        (request) =>
          request.status === "pending" &&
          ((request.fromUserId === fromUserId && request.toUserId === toUserId) ||
            (request.fromUserId === toUserId && request.toUserId === fromUserId)),
      ) ?? null
    );
  }

  createFriendRequest(fromUserId: string, toUserId: string): FriendRequestRecord {
    const request: FriendRequestRecord = {
      id: createId("fr"),
      fromUserId,
      toUserId,
      status: "pending",
      createdAt: Date.now(),
    };
    this.data.friendRequests.push(request);
    const from = this.getUserById(fromUserId);
    this.addNotification({
      userId: toUserId,
      type: "friend_request",
      title: "好友申请",
      text: `${from?.name ?? "玩家"} 请求添加你为好友`,
      fromUserId,
      roomCode: null,
      messageId: null,
    });
    this.save();
    return request;
  }

  getFriendRequest(requestId: string): FriendRequestRecord | null {
    return this.data.friendRequests.find((request) => request.id === requestId) ?? null;
  }

  incomingRequests(userId: string): FriendRequestRecord[] {
    return this.data.friendRequests.filter(
      (request) => request.status === "pending" && request.toUserId === userId,
    );
  }

  outgoingRequests(userId: string): FriendRequestRecord[] {
    return this.data.friendRequests.filter(
      (request) => request.status === "pending" && request.fromUserId === userId,
    );
  }

  markFriendRequestNotificationsRead(userId: string, fromUserId: string | null): void {
    for (const notification of this.data.friendNotifications) {
      if (notification.userId !== userId || notification.type !== "friend_request") continue;
      if (fromUserId !== null && notification.fromUserId !== fromUserId) continue;
      notification.read = true;
    }
  }

  acceptFriendRequest(requestId: string, userId: string): FriendRequestRecord {
    const request = this.getFriendRequest(requestId);
    if (!request) throw new StoreError("好友申请不存在", 404);
    if (request.toUserId !== userId) throw new StoreError("只能处理发给自己的好友申请", 403);
    if (request.status !== "pending") throw new StoreError("好友申请已处理", 400);
    request.status = "accepted";
    this.addFriendPair(request.fromUserId, request.toUserId);
    this.markFriendRequestNotificationsRead(userId, request.fromUserId);
    this.save();
    return request;
  }

  rejectFriendRequest(requestId: string, userId: string): FriendRequestRecord {
    const request = this.getFriendRequest(requestId);
    if (!request) throw new StoreError("好友申请不存在", 404);
    if (request.toUserId !== userId) throw new StoreError("只能处理发给自己的好友申请", 403);
    if (request.status !== "pending") throw new StoreError("好友申请已处理", 400);
    request.status = "rejected";
    this.markFriendRequestNotificationsRead(userId, request.fromUserId);
    this.save();
    return request;
  }

  private addFriendPair(a: string, b: string): void {
    const first = this.getUserById(a);
    const second = this.getUserById(b);
    if (!first || !second) return;
    first.friendIds = [...new Set([...(first.friendIds ?? []), b])];
    second.friendIds = [...new Set([...(second.friendIds ?? []), a])];
  }

  removeFriend(a: string, b: string): boolean {
    const first = this.getUserById(a);
    const second = this.getUserById(b);
    if (!first || !second) return false;
    const before = (first.friendIds ?? []).includes(b);
    first.friendIds = (first.friendIds ?? []).filter((id) => id !== b);
    second.friendIds = (second.friendIds ?? []).filter((id) => id !== a);
    this.save();
    return before;
  }

  sendFriendMessage(fromUserId: string, toUserId: string, rawText: string): FriendMessageRecord {
    const from = this.getUserById(fromUserId);
    const text = String(rawText ?? "").trim();
    if (text.length === 0) throw new StoreError("消息不能为空", 400);
    if (text.length > 500) throw new StoreError("消息最多 500 个字符", 400);
    const message: FriendMessageRecord = {
      id: createId("fm"),
      fromUserId,
      toUserId,
      text,
      createdAt: Date.now(),
      read: false,
    };
    this.data.friendMessages.push(message);
    this.addNotification({
      userId: toUserId,
      type: "friend_message",
      title: "新的私信",
      text: `${from?.name ?? "好友"}：${text.slice(0, 60)}`,
      fromUserId,
      roomCode: null,
      messageId: message.id,
    });
    this.save();
    return message;
  }

  listConversation(userId: string, otherId: string, limit = 50): FriendMessageRecord[] {
    return this.data.friendMessages
      .filter(
        (message) =>
          (message.fromUserId === userId && message.toUserId === otherId) ||
          (message.fromUserId === otherId && message.toUserId === userId),
      )
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-Math.max(1, Math.min(100, limit)));
  }

  /** Mark messages from `otherId` to `userId` (and their notifications) as read. */
  markConversationRead(userId: string, otherId: string): void {
    for (const message of this.data.friendMessages) {
      if (message.fromUserId === otherId && message.toUserId === userId) message.read = true;
    }
    for (const notification of this.data.friendNotifications) {
      if (
        notification.userId === userId &&
        notification.type === "friend_message" &&
        notification.fromUserId === otherId
      ) {
        notification.read = true;
      }
    }
    this.save();
  }

  addNotification(input: {
    userId: string;
    type: FriendNotificationRecord["type"];
    title: string;
    text: string;
    fromUserId: string | null;
    roomCode: string | null;
    messageId: string | null;
  }): FriendNotificationRecord {
    const notification: FriendNotificationRecord = {
      id: createId("fn"),
      userId: input.userId,
      type: input.type,
      title: input.title,
      text: input.text,
      createdAt: Date.now(),
      read: false,
      fromUserId: input.fromUserId,
      roomCode: input.roomCode,
      messageId: input.messageId,
    };
    this.data.friendNotifications.push(notification);
    return notification;
  }

  createGameInvite(fromUserId: string, toUserId: string, roomCode: string): FriendNotificationRecord {
    const from = this.getUserById(fromUserId);
    const notification = this.addNotification({
      userId: toUserId,
      type: "game_invite",
      title: "对局邀请",
      text: `${from?.name ?? "好友"} 邀请你加入房间 ${roomCode}`,
      fromUserId,
      roomCode,
      messageId: null,
    });
    this.save();
    return notification;
  }

  listNotifications(userId: string): FriendNotificationRecord[] {
    return this.data.friendNotifications
      .filter((notification) => notification.userId === userId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  unreadNotificationCount(userId: string): number {
    return this.data.friendNotifications.filter(
      (notification) => notification.userId === userId && !notification.read,
    ).length;
  }

  markNotificationRead(userId: string, notificationId: string | null): number {
    for (const notification of this.data.friendNotifications) {
      if (notification.userId !== userId) continue;
      if (notificationId !== null && notification.id !== notificationId) continue;
      notification.read = true;
      if (notification.messageId) {
        const message = this.data.friendMessages.find((entry) => entry.id === notification.messageId);
        if (message && message.toUserId === userId) message.read = true;
      }
    }
    this.save();
    return this.unreadNotificationCount(userId);
  }

  getPrivacy(userId: string): { showStatsToFriends: boolean } {
    return { showStatsToFriends: this.getUserById(userId)?.showStatsToFriends !== false };
  }

  setPrivacy(userId: string, showStatsToFriends: boolean): { showStatsToFriends: boolean } {
    const user = this.getUserById(userId);
    if (!user) throw new StoreError("用户不存在", 404);
    user.showStatsToFriends = Boolean(showStatsToFriends);
    this.save();
    return { showStatsToFriends: user.showStatsToFriends };
  }

  /**
   * Permanently remove a registered user and every row that references them.
   * Matches keep the other players; a match left empty is removed.
   */
  deleteUser(userId: string): boolean {
    const user = this.getUserById(userId);
    if (!user || user.isGuest) return false;
    const deletedName = user.name;
    this.data.users = this.data.users.filter((candidate) => candidate.id !== userId);
    for (const [token, sessionUserId] of Object.entries(this.data.sessions)) {
      if (sessionUserId === userId) delete this.data.sessions[token];
    }
    for (const mode of RANKED_MODES) delete this.data.ratings[mode][userId];
    for (const mode of MODES) delete this.data.stats[mode][userId];
    for (const [key, entry] of Object.entries(this.data.daily)) {
      if (entry.userId === userId) delete this.data.daily[key];
    }
    const matches: MatchSummary[] = [];
    for (const match of this.data.matches) {
      const players = match.players.filter((player) => player.id !== userId);
      if (players.length < 1) continue;
      matches.push({
        ...match,
        players,
        winnerId: match.winnerId === userId ? null : match.winnerId,
        winnerName:
          match.winnerId === userId || match.winnerName === deletedName ? "已注销玩家" : match.winnerName,
        forfeitById: match.forfeitById === userId ? null : match.forfeitById,
      });
    }
    this.data.matches = matches;
    for (const candidate of this.data.users) {
      candidate.friendIds = (candidate.friendIds ?? []).filter((id) => id !== userId);
    }
    this.data.friendRequests = this.data.friendRequests.filter(
      (request) => request.fromUserId !== userId && request.toUserId !== userId,
    );
    this.data.friendMessages = this.data.friendMessages.filter(
      (message) => message.fromUserId !== userId && message.toUserId !== userId,
    );
    this.data.friendNotifications = this.data.friendNotifications.filter(
      (notification) => notification.userId !== userId && notification.fromUserId !== userId,
    );
    this.save();
    return true;
  }

  matchCount(): number {
    return this.data.matches.length;
  }

  stats(): { users: number; matches: number; sessions: number } {
    return {
      users: this.data.users.length,
      matches: this.data.matches.length,
      sessions: Object.keys(this.data.sessions).length,
    };
  }
}

/** Build a fresh match id. */
export function createMatchId(): string {
  return createId("m");
}
