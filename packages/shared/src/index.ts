export const TARGET_SCORE = 3;
export const MAX_ROUNDS = 7;
export const ROWS_PER_ROUND = 6;
/** 每次抢答后的个人冷却（服务端强制）。 */
export const GUESS_COOLDOWN_MS = 1000;
/** 本轮无人作答的倒计时；每次有效猜测会重置。 */
export const IDLE_ROUND_TIMEOUT_MS = 60_000;
/** 兼容旧字段名：现在表示“无人作答超时”，不是整轮总时长。 */
export const ROUND_DURATION_MS = IDLE_ROUND_TIMEOUT_MS;
export const ROUND_END_DELAY_MS = 2_500;
/** 小局结束后给结算页留的展示时间。 */
export const SET_END_DELAY_MS = 5_000;
export const COUNTDOWN_MS = 3_000;
/** 离开/断线后保留座位、允许重连的时间；超时判对手胜。 */
export const LEAVE_GRACE_MS = 180_000;
export const TEAM_CHAT_TEAMMATE_LIMIT = 4;
/** 三人混战：先到 7 分获胜。 */
export const FFA_TARGET_SCORE = 7;
/** 团队战：房间不设固定人数上限，用这个值作为 UI/服务端的“不限”哨兵。 */
export const TEAM_UNLIMITED_CAPACITY = 99;

export type GuessMode = "standard" | "free";
export const GUESS_MODES: GuessMode[] = ["standard", "free"];
export const DEFAULT_GUESS_MODE: GuessMode = "standard";

export function isGuessMode(value: unknown): value is GuessMode {
  return value === "standard" || value === "free";
}

/** 标准模式词库范围：common 仅常见成语，all 全量可用成语。 */
export type DictionaryMode = "common" | "all";
export const DICTIONARY_MODES: DictionaryMode[] = ["common", "all"];
export const DEFAULT_DICTIONARY: DictionaryMode = "common";

export function isDictionaryMode(value: unknown): value is DictionaryMode {
  return value === "common" || value === "all";
}

/** 每小局可选分数，默认 11；房主也可以自定义。 */
export const POINTS_TO_WIN_OPTIONS = [7, 11, 15, 21] as const;
export const DEFAULT_POINTS_TO_WIN = 11;
export const MIN_POINTS_TO_WIN = 1;
export const MAX_POINTS_TO_WIN = 99;

export interface RoomRules {
  /** 大比分几局几胜；快速匹配固定 1。 */
  bestOf: number;
  guessMode: GuessMode;
  dictionary: DictionaryMode;
  /** 1v1/团队的小局目标分，或三人战的目标分。 */
  pointsToWin: number;
}

export const DEFAULT_ROOM_RULES: RoomRules = {
  bestOf: 1,
  guessMode: "free",
  dictionary: "common",
  pointsToWin: DEFAULT_POINTS_TO_WIN,
};

export interface RulesProposal {
  id: string;
  proposerId: string;
  proposerName: string;
  rules: RoomRules;
  createdAt: number;
}

export interface DrawOffer {
  proposerId: string;
  proposerName: string;
  acceptedBy: string[];
  createdAt: number;
}


/** 1v1 小局：先到 11 分且领先 2 分获胜（10:10 后继续，直到领先 2 分）。 */
export const DUEL_POINTS_TO_WIN = 11;
export const DUEL_POINT_LEAD = 2;
/** 1v1 大比分默认三局两胜；房主可在建房时选择 1/3/5/7 局。 */
export const DUEL_DEFAULT_BEST_OF = 3;
export const DUEL_BEST_OF_OPTIONS = [1, 3, 5, 7] as const;
export type DuelBestOf = (typeof DUEL_BEST_OF_OPTIONS)[number];

export function setsToWinForBestOf(bestOf: number): number {
  return Math.floor((bestOf + 1) / 2);
}

export function isDuelBestOf(value: unknown): value is DuelBestOf {
  return typeof value === "number" && (DUEL_BEST_OF_OPTIONS as readonly number[]).includes(value);
}

export const MODES = ["duel", "ffa3", "team2v2", "practice"] as const;
export type Mode = (typeof MODES)[number];
/** 参与天梯/排行榜的模式，练习模式不计入。 */
export const RANKED_MODES = ["duel", "ffa3", "team2v2"] as const;
export type RankedMode = (typeof RANKED_MODES)[number];

export const TEAMS = ["A", "B"] as const;
export type Team = (typeof TEAMS)[number];

export type Visibility = "public" | "private";
export type RoomStatus = "waiting" | "countdown" | "playing" | "roundEnd" | "matchEnd";
export type RoundStatus = "idle" | "countdown" | "playing" | "ended";
export type RoundResult = "solved" | "exhausted" | "timeout";
export type ViewerRole = "player" | "spectator";
export type ChatScope = "room" | "team";

export interface ModeMeta {
  mode: Mode;
  label: string;
  shortLabel: string;
  capacity: number;
  teams: boolean;
  unlimited?: boolean;
  description: string;
}

export const MODE_META: Record<Mode, ModeMeta> = {
  duel: {
    mode: "duel",
    label: "1v1 单挑",
    shortLabel: "1v1",
    capacity: 2,
    teams: false,
    description:
      "两名玩家抢答同一张棋盘，每轮先猜中者得 1 分；小局先到 11 分且领先 2 分获胜，大比分由房主选择 1/3/5/7 局。",
  },
  ffa3: {
    mode: "ffa3",
    label: "3 人混战",
    shortLabel: "3 人",
    capacity: 3,
    teams: false,
    description: "三名玩家各自计分，先到 7 分获胜。",
  },
  team2v2: {
    mode: "team2v2",
    label: "团队战",
    shortLabel: "团队",
    capacity: TEAM_UNLIMITED_CAPACITY,
    teams: true,
    unlimited: true,
    description:
      "分 A/B 两队，每队人数不限；队伍共享小局分。赛制同 1v1：小局先到 11 分且领先 2 分，大比分由房主选择 1/3/5/7 局。",
  },
  practice: {
    mode: "practice",
    label: "个人练习",
    shortLabel: "练习",
    capacity: 1,
    teams: false,
    description: "单人练习一张词影棋盘，不计天梯与总统计；练习数据单独累计。",
  },
};

export function isMode(value: unknown): value is Mode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value);
}

export function modeCapacity(mode: Mode): number {
  return MODE_META[mode].capacity;
}

export function teamForSlot(mode: Mode, slot: number): Team | null {
  if (!MODE_META[mode].teams) return null;
  return slot % 2 === 0 ? "A" : "B";
}

export interface PublicUser {
  id: string;
  name: string;
  avatar: string;
  isGuest: boolean;
  username?: string;
}

export interface RoomPlayer {
  id: string;
  name: string;
  avatar: string;
  team: Team | null;
  score: number;
  ready: boolean;
  connected: boolean;
  isGuest: boolean;
  isHost: boolean;
  guesses: number;
  /** 离开/断线后保留座位的截止时间；null 表示在线且未进入重连宽限。 */
  rejoinDeadline: number | null;
}

export interface SpectatorInfo {
  id: string;
  name: string;
}

export interface RoomSummary {
  code: string;
  mode: Mode;
  status: RoomStatus;
  visibility: Visibility;
  playerCount: number;
  capacity: number;
  spectatorCount: number;
  hostName: string;
  round: number;
  guessMode: GuessMode;
  dictionary: DictionaryMode;
  pointsToWin: number;
}

export interface QueueState {
  mode: Mode;
  size: number;
  needed: number;
  position: number;
}

export interface LeaderboardRow {
  rank: number;
  userId: string;
  name: string;
  avatar: string;
  rating: number;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  /** 三人混战专用名次统计。 */
  firsts: number;
  seconds: number;
  thirds: number;
}

export interface MatchPlayerSummary {
  id: string;
  name: string;
  avatar: string;
  team: Team | null;
  score: number;
  setWins: number;
  ratingBefore?: number;
  ratingAfter?: number;
  ratingDelta?: number;
}

export interface SetHistoryEntry {
  setNumber: number;
  winnerId: string | null;
  winnerTeam: Team | null;
  scores: Record<string, number>;
  teamScores: Record<Team, number>;
  pointsToWin: number;
  endedAt: number;
}

export interface RoundHistoryEntry {
  index: number;
  answer: string;
  /** 成语释义，侧栏显示一行小字。 */
  explanation: string;
  result: RoundResult | null;
  winnerId: string | null;
  winnerName: string | null;
  awardedTo: string[];
  awardedTeam: Team | null;
  setWinnerId: string | null;
  setWinnerTeam: Team | null;
  endedAt: number;
}

export interface MatchSummary {
  id: string;
  mode: Mode;
  endedAt: number;
  winnerName: string;
  winnerId: string | null;
  winnerTeam: Team | null;
  isDraw: boolean;
  forfeitById: string | null;
  forfeitTeam: Team | null;
  rounds: number;
  rules: RoomRules;
  setHistory: SetHistoryEntry[];
  players: MatchPlayerSummary[];
  /** 每位玩家的高光成语，按猜出次数升序，最多 3 条。 */
  highlights: Record<string, MatchHighlight[]>;
}

export interface MatchHighlight {
  word: string;
  guesses: number;
}

export type DailyColor = "green" | "yellow" | "gray";

export interface DailyRowView {
  word: string;
  tiles: TileFeedback[];
  summary: DailyColor[];
}

export interface DailyLeaderboardRow {
  rank: number;
  userId: string;
  name: string;
  avatar: string;
  attempts: number;
  solvedAt: number;
  /** 解出所用的时长（毫秒）。 */
  durationMs: number;
}

export interface DailyMe {
  rank: number | null;
  attempts: number;
  solvedAt: number | null;
  durationMs: number | null;
}

export interface DailyState {
  date: string;
  weekday: number;
  isCommonDay: boolean;
  intro: string;
  rows: DailyRowView[];
  solved: boolean;
  answer: string | null;
  explanation: string | null;
  attempts: number;
  durationMs: number | null;
  /** 截至今天的连续挑战成功天数。 */
  streakDays: number;
  me: DailyMe | null;
  leaderboard: DailyLeaderboardRow[];
}

export interface CluePath {
  d: string;
  fill: "correct" | "shadow" | "white";
  opacity: number;
  dx: number;
  dy: number;
}

export interface TileFeedback {
  bg: "correct" | "none";
  char: string;
  description: string;
  paths: CluePath[];
}

export interface RoomRow {
  id: number;
  playerId: string;
  playerName: string;
  word: string;
  tiles: TileFeedback[];
  correct: boolean;
  createdAt: number;
}

export interface RoundState {
  index: number;
  status: RoundStatus;
  rows: RoomRow[];
  maxRows: number;
  remainingRows: number;
  startedAt: number;
  /** 本轮“无人作答”倒计时截止；每次有效猜测都会往后顺延。 */
  endsAt: number;
  endedAt: number | null;
  result: RoundResult | null;
  winnerId: string | null;
  winnerName: string | null;
  /** 第 6 行仍未猜中时，系统奖励给对手的玩家 id / 队伍。 */
  awardedTo: string[];
  awardedTeam: Team | null;
  /** 本轮是否同时决出了一个小局（1v1 / 团队战）。 */
  setWinnerId: string | null;
  setWinnerTeam: Team | null;
  answer: string | null;
}

export interface ChatMessage {
  id: string;
  scope: ChatScope;
  userId: string;
  name: string;
  text: string;
  ts: number;
}

export interface MatchState {
  /** Legacy 3-point target for non-duel modes. */
  targetScore: number;
  /** Legacy max round count for non-duel modes. */
  maxRounds: number;
  /** Global round number in this match (1-based; increments across sets). */
  roundNumber: number;
  /** Current set number (1-based). Duel uses this; other modes keep 1. */
  setNumber: number;
  /** How many sets a player/team must win the match. */
  setsToWin: number;
  /** Best-of value selected by the host (duel only; 1/3/5/7). */
  bestOf: number;
  /** Sets won by each player id (duel) or team key (team modes). */
  setWins: Record<string, number>;
  /** Points needed to win one set (duel: 11). */
  pointsToWin: number;
  /** Required lead to win a set (duel: 2). */
  pointLead: number;
  winnerId: string | null;
  winnerName: string | null;
  winnerTeam: Team | null;
  isDraw: boolean;
  /** 因离开/断线超时被判负的玩家；null 表示正常结束。 */
  forfeitById: string | null;
  /** 因对方弃权而获胜的队伍；null 表示无队伍弃权。 */
  forfeitTeam: Team | null;
  /** 每个小局的比分快照，用于比赛结束页保留每局小比分。 */
  setHistory: SetHistoryEntry[];
  /** 每位玩家的高光成语，按猜出次数升序，最多 3 条。 */
  highlights: Record<string, MatchHighlight[]>;
  /** 比赛结束后的天梯分变化，key 为玩家 id；游客/未计分玩家不在其中。 */
  ratingDeltas: Record<string, number>;
}

export interface RoomState {
  id: string;
  code: string;
  mode: Mode;
  visibility: Visibility;
  rules: RoomRules;
  /** 快速匹配生成的房间需要双方先协商规则。 */
  requiresAgreement: boolean;
  rulesAgreed: boolean;
  proposal: RulesProposal | null;
  /** 当前待处理的求和请求；双方同意后以平局结束。 */
  drawOffer: DrawOffer | null;
  guessMode: GuessMode;
  status: RoomStatus;
  hostId: string;
  players: RoomPlayer[];
  spectators: SpectatorInfo[];
  teamScores: Record<Team, number>;
  round: RoundState;
  /** 最近 5 轮答案，用于游戏内侧边栏。 */
  recentRounds: RoundHistoryEntry[];
  match: MatchState;
  chat: ChatMessage[];
  viewerRole: ViewerRole;
  viewerId: string;
  countdownEndsAt: number | null;
  createdAt: number;
  serverTime: number;
}

export type ClientMessage =
  | {
      type: "room.create";
      mode: Mode;
      visibility: Visibility;
      bestOf?: number;
      guessMode?: GuessMode;
      dictionary?: DictionaryMode;
      pointsToWin?: number;
    }
  | { type: "room.join"; code: string }
  | { type: "room.leave" }
  | { type: "room.ready"; ready: boolean }
  | { type: "room.start" }
  | { type: "room.setTeam"; team: Team; userId?: string }
  | { type: "room.proposeRules"; rules: RoomRules }
  | { type: "room.acceptRules"; proposalId: string }
  | { type: "room.counterRules"; rules: RoomRules }
  | { type: "room.updateRules"; rules: RoomRules }
  | { type: "room.offerDraw" }
  | { type: "room.respondDraw"; accept: boolean }
  | { type: "room.guess"; word: string }
  | { type: "room.chat"; scope: ChatScope; text: string }
  | { type: "room.rematch" }
  | { type: "spectate.join"; code: string }
  | { type: "spectate.leave" }
  | { type: "queue.join"; mode: Mode }
  | { type: "queue.leave" }
  | { type: "ping" };

export type ServerMessage =
  | { type: "hello"; user: PublicUser }
  | { type: "state"; state: RoomState }
  | { type: "rooms"; rooms: RoomSummary[] }
  | { type: "queue"; state: QueueState | null }
  | { type: "leaderboard"; mode: Mode; rows: LeaderboardRow[] }
  | { type: "match.found"; code: string }
  | { type: "error"; message: string }
  | { type: "toast"; message: string }
  | { type: "pong"; serverTime: number };

export interface GuestSessionRequest {
  name: string;
}

export interface AuthRequest {
  username: string;
  password: string;
  name?: string;
}

export interface SessionResponse {
  token: string;
  user: PublicUser;
}

export interface SiteStats {
  registeredUsers: number;
  onlineUsers: number;
}

export interface ProfileUpdateRequest {
  name?: string;
  avatar?: string;
}

export interface MatchHistoryRow {
  id: string;
  mode: Mode;
  endedAt: number;
  opponentNames: string[];
  winnerName: string;
  winnerId: string | null;
  winnerTeam: Team | null;
  isDraw: boolean;
  forfeit: boolean;
  setWins: Record<string, number>;
  setHistory: SetHistoryEntry[];
  players: MatchPlayerSummary[];
  ratingBefore: number | null;
  ratingAfter: number | null;
  ratingDelta: number | null;
  smallScores: Record<string, number>;
}

export interface RecentIdiom {
  word: string;
  explanation: string;
  at: number;
}

export interface RecentIdiomsResponse {
  rows: RecentIdiom[];
}

export interface MatchHistoryResponse {
  rows: MatchHistoryRow[];
}

export const NAME_MAX = 16;
export const CHAT_MAX = 200;
export const GUESS_LENGTH = 4;

/** 持久化的个人累计统计（按模式分别存储）。 */
export interface PlayerStats {
  matches: number;
  wins: number;
  losses: number;
  draws: number;
  /** 三人混战名次统计；其他模式保持 0。 */
  firsts: number;
  seconds: number;
  thirds: number;
  /** 参与过的总轮数（一轮 = 一张 6 行共享盘）。 */
  rounds: number;
  /** 至少提交过一次猜测的轮数，用于计算“猜出率”。 */
  roundsWithGuess: number;
  guesses: number;
  solves: number;
  /** 所有猜出用时的总和（毫秒），用于计算平均猜出时间。 */
  totalSolveMs: number;
  /** 历史最快猜出时间（毫秒）；0 表示还没有猜出过。 */
  fastestSolveMs: number;
  /** 在多少场比赛中拥有全场最快平均猜出时间。 */
  fastestMatchAwards: number;
  /** 累计得分（小局分）。 */
  points: number;
  /** 赢下的小局数。 */
  setsWon: number;
}

/** 对外返回时附带派生比例。 */
export interface PlayerStatsView extends PlayerStats {
  winRate: number;
  /** solves / roundsWithGuess */
  solveRate: number;
  /** solves / guesses */
  guessAccuracy: number;
  /** totalSolveMs / solves */
  avgSolveMs: number;
}

export interface StatsResponse {
  total: PlayerStatsView;
  modes: Record<Mode, PlayerStatsView>;
}

/* ------------------------------------------------------------------ */
/* 连胜挑战                                                            */
/* ------------------------------------------------------------------ */

export const STREAK_VARIANTS = ["standard", "free", "advanced"] as const;
export type StreakVariant = (typeof STREAK_VARIANTS)[number];

export interface StreakRowView {
  word: string;
  tiles: TileFeedback[];
}

export interface StreakState {
  variant: StreakVariant;
  status: "playing" | "ended";
  rows: StreakRowView[];
  maxRows: number;
  remainingRows: number;
  streak: number;
  best: number;
  /** 当前这一题的开始时间戳（服务端时间）。 */
  startedAt: number;
  /** 答对后到下一题开始前的休息截止时间；0 表示不在休息。 */
  nextAt: number;
  /** 最近一次答对用时；未答对过为 null。 */
  lastSolveMs: number | null;
  averageSolveMs: number;
  fastestSolveMs: number;
  answer: string | null;
  explanation: string | null;
  message: string;
}

export interface StreakLeaderboardRow {
  rank: number;
  userId: string;
  name: string;
  avatar: string;
  best: number;
}

export interface StreakStats {
  runs: number;
  solved: number;
  best: number;
  totalSolveMs: number;
  fastestSolveMs: number;
}

export interface StreakLeaderboardResponse {
  variant: StreakVariant;
  rows: StreakLeaderboardRow[];
}

/* ------------------------------------------------------------------ */
/* 好友与通知                                                          */
/* ------------------------------------------------------------------ */

export interface FriendUser {
  id: string;
  name: string;
  avatar: string;
  online: boolean;
}

export interface FriendRequestView {
  id: string;
  direction: "incoming" | "outgoing";
  user: FriendUser;
  createdAt: number;
}

export interface FriendMessageView {
  id: string;
  fromId: string;
  toId: string;
  fromName: string;
  text: string;
  ts: number;
  read: boolean;
}

export interface FriendNotificationView {
  id: string;
  type: "friend_request" | "friend_message" | "game_invite";
  title: string;
  text: string;
  createdAt: number;
  read: boolean;
  userId: string | null;
  roomCode?: string | null;
}

export interface FriendsResponse {
  friends: FriendUser[];
  incoming: FriendRequestView[];
  outgoing: FriendRequestView[];
  notifications: FriendNotificationView[];
  unread: number;
}

export interface FriendProfileResponse {
  user: FriendUser;
  statsVisible: boolean;
  stats: PlayerStatsView | null;
}

export interface UserSearchResult {
  id: string;
  name: string;
  avatar: string;
  relation: "none" | "friend" | "incoming" | "outgoing";
}

export interface PrivacySettings {
  showStatsToFriends: boolean;
}

