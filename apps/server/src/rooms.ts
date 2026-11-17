import { randomBytes } from "node:crypto";
import type {
  ChatMessage,
  ChatScope,
  ClientMessage,
  DrawOffer,
  MatchPlayerSummary,
  MatchState,
  MatchSummary,
  Mode,
  PublicUser,
  RoomPlayer,
  RoomRow,
  RoomRules,
  RoomState,
  RoomStatus,
  RoomSummary,
  RoundHistoryEntry,
  RoundResult,
  RoundState,
  RoundStatus,
  RulesProposal,
  ServerMessage,
  SetHistoryEntry,
  SpectatorInfo,
  Team,
  TileFeedback,
  Visibility,
} from "../../../packages/shared/src/index.ts";
import {
  COUNTDOWN_MS,
  DEFAULT_DICTIONARY,
  DEFAULT_GUESS_MODE,
  DUEL_DEFAULT_BEST_OF,
  DUEL_POINT_LEAD,
  DUEL_POINTS_TO_WIN,
  FFA_TARGET_SCORE,
  GUESS_COOLDOWN_MS,
  IDLE_ROUND_TIMEOUT_MS,
  LEAVE_GRACE_MS,
  MAX_POINTS_TO_WIN,
  MIN_POINTS_TO_WIN,
  MODE_META,
  ROWS_PER_ROUND,
  ROUND_END_DELAY_MS,
  SET_END_DELAY_MS,
  isDictionaryMode,
  isDuelBestOf,
  isGuessMode,
  isMode,
  modeCapacity,
  setsToWinForBestOf,
} from "../../../packages/shared/src/index.ts";
import type { GameData } from "../../../packages/engine/src/index.ts";
import type { RoundFeedbackState } from "../../../packages/engine/src/index.ts";
import {
  applyRatings,
  buildRowFeedback,
  createRoundState,
  duelMatchWinner,
  duelSetWinner,
  duelSetWinsLeader,
  explanationFor,
  pickAnswer,
  suggestStandardWord,
  validateFreeGuessDetail,
  validateGuessDetail,
} from "../../../packages/engine/src/index.ts";
import type { RatingChange } from "../../../packages/engine/src/index.ts";
import type { Store } from "./store.ts";
import { createMatchId } from "./store.ts";

const ROOM_IDLE_MS = 10 * 60_000;
const SPECTATOR_LIMIT = 20;
const CHAT_HISTORY_LIMIT = 50;
const DISPLAY_CHAR_LIMIT = 200;
const IDLE_SWEEP_MS = 60_000;

export class RoomError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoomError";
  }
}

export interface RoomConfig {
  countdownMs: number;
  /** Normal round-end (answer showcase) delay. */
  roundEndMs: number;
  /** Set-end (set scoreboard) delay. */
  setEndDelayMs: number;
  guessCooldownMs: number;
  /** Idle timeout: the round ends when nobody guesses for this long. */
  idleTimeoutMs: number;
  /** Seat reservation after leaving / disconnecting during a match. */
  leaveGraceMs: number;
  roomIdleMs: number;
  spectatorLimit: number;
  rowsPerRound: number;
  /** FFA race to this score. */
  ffaTargetScore: number;
  /** Duel/team set target. */
  pointsToWin: number;
  /** Duel/team set required lead. */
  pointLead: number;
  /** Default best-of for duel/team rooms and quick match. */
  defaultBestOf: number;
}

export const DEFAULT_ROOM_CONFIG: RoomConfig = {
  countdownMs: COUNTDOWN_MS,
  roundEndMs: ROUND_END_DELAY_MS,
  setEndDelayMs: SET_END_DELAY_MS,
  guessCooldownMs: GUESS_COOLDOWN_MS,
  idleTimeoutMs: IDLE_ROUND_TIMEOUT_MS,
  leaveGraceMs: LEAVE_GRACE_MS,
  roomIdleMs: ROOM_IDLE_MS,
  spectatorLimit: SPECTATOR_LIMIT,
  rowsPerRound: ROWS_PER_ROUND,
  ffaTargetScore: FFA_TARGET_SCORE,
  pointsToWin: DUEL_POINTS_TO_WIN,
  pointLead: DUEL_POINT_LEAD,
  defaultBestOf: DUEL_DEFAULT_BEST_OF,
};

export interface RoomManagerOptions {
  store: Store;
  data: GameData;
  send: (userId: string, message: ServerMessage) => void;
  broadcastRooms: (rooms: RoomSummary[]) => void;
  config?: Partial<RoomConfig>;
  /** Test hook: override answer selection (rules carry the dictionary scope). */
  chooseAnswer?: (data: GameData, rules: RoomRules) => string;
  /** Called whenever a player leaves a seat / queue / spectate slot (guest cleanup). */
  onPresenceChanged?: (userId: string) => void;
}

interface PlayerInternal {
  id: string;
  name: string;
  avatar: string;
  isGuest: boolean;
  team: Team | null;
  /** Personal points (duel/ffa score; team contribution display only). */
  score: number;
  ready: boolean;
  connected: boolean;
  isHost: boolean;
  guesses: number;
  lastGuessAt: number;
  rejoinDeadline: number | null;
}

/** Per-match (not persisted) statistics accumulators. */
interface MatchStatEntry {
  userId: string;
  name: string;
  isGuest: boolean;
  team: Team | null;
  rounds: number;
  roundsWithGuess: number;
  guesses: number;
  solves: number;
  totalSolveMs: number;
  fastestSolveMs: number;
  points: number;
  setsWon: number;
}

interface RoundInternal {
  index: number;
  answer: string;
  rows: RoomRow[];
  status: RoundStatus;
  startedAt: number;
  /** When the current "nobody guessed" countdown fires (reset on every valid guess). */
  endsAt: number;
  endedAt: number | null;
  result: RoundResult | null;
  winnerId: string | null;
  winnerName: string | null;
  awardedTo: string[];
  awardedTeam: Team | null;
  setWinnerId: string | null;
  setWinnerTeam: Team | null;
  feedback: RoundFeedbackState;
  participantIds: string[];
  guessedPlayerIds: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
}

interface RoomInternal {
  id: string;
  code: string;
  mode: Mode;
  visibility: Visibility;
  rules: RoomRules;
  /** Quick-match rooms negotiate rules before the host can start. */
  requiresAgreement: boolean;
  rulesAgreed: boolean;
  proposal: RulesProposal | null;
  /** Player ids that already accepted the current proposal (proposer excluded). */
  proposalAcceptedBy: Set<string>;
  /** Pending draw offer; cleared when rejected, accepted, or the match ends. */
  drawOffer: DrawOffer | null;
  status: RoomStatus;
  hostId: string;
  players: PlayerInternal[];
  spectators: SpectatorInfo[];
  teamScores: Record<Team, number>;
  /** Last team assignment, used to alternate when both teams are equally sized. */
  teamLastAssigned: Team | null;
  round: RoundInternal | null;
  match: MatchState;
  /** Last few finished rounds for the sidebar. */
  recentRounds: RoundHistoryEntry[];
  chat: ChatMessage[];
  createdAt: number;
  lastActivity: number;
  countdownEndsAt: number | null;
  countdownTimer: ReturnType<typeof setTimeout> | null;
  roundEndTimer: ReturnType<typeof setTimeout> | null;
  /** Seat reservation timers (leave / disconnect during a match). */
  rejoinTimers: Map<string, ReturnType<typeof setTimeout>>;
  matchRecorded: boolean;
  matchStats: Map<string, MatchStatEntry>;
}

interface MatchDecision {
  winnerId: string | null;
  winnerName: string | null;
  winnerTeam: Team | null;
  isDraw: boolean;
  forfeitById: string | null;
  forfeitTeam: Team | null;
}

let chatCounter = 0;
let roomCounter = 0;

function createRoomId(): string {
  return `r_${randomBytes(8).toString("hex")}`;
}

function clampText(raw: unknown): string {
  const text = String(raw ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
  return text.slice(0, DISPLAY_CHAR_LIMIT);
}

/**
 * Server authoritative room state machine: rooms, sets, rounds, the idle
 * countdown, seat reservations/forfeits, chat, spectators and the quick match
 * queue. Mutations push a personalised {@link RoomState} through `send`.
 */
export class RoomManager {
  private readonly store: Store;
  private readonly data: GameData;
  private readonly send: (userId: string, message: ServerMessage) => void;
  private readonly broadcastRooms: (rooms: RoomSummary[]) => void;
  private readonly config: RoomConfig;
  private readonly chooseAnswer: (data: GameData, rules: RoomRules) => string;
  private readonly onPresenceChanged: ((userId: string) => void) | null;

  private readonly rooms = new Map<string, RoomInternal>();
  private readonly userRoom = new Map<string, string>();
  private readonly spectating = new Map<string, string>();
  private readonly queues: Record<Mode, string[]> = { duel: [], ffa3: [], team2v2: [], practice: [] };
  private idleSweep: ReturnType<typeof setInterval> | null = null;

  constructor(options: RoomManagerOptions) {
    this.store = options.store;
    this.data = options.data;
    this.send = options.send;
    this.broadcastRooms = options.broadcastRooms;
    this.config = { ...DEFAULT_ROOM_CONFIG, ...(options.config ?? {}) };
    this.chooseAnswer =
      options.chooseAnswer ?? ((data: GameData, rules: RoomRules) => pickAnswer(data, Math.random, rules.dictionary));
    this.onPresenceChanged = options.onPresenceChanged ?? null;
    this.idleSweep = setInterval(() => this.sweepIdleRooms(), IDLE_SWEEP_MS);
    this.idleSweep.unref?.();
  }

  /** True while the user still owns a seat, a queue slot or a spectate slot. */
  hasPresence(userId: string): boolean {
    if (this.userRoom.has(userId)) return true;
    if (this.spectating.has(userId)) return true;
    for (const queue of Object.values(this.queues)) {
      if (queue.includes(userId)) return true;
    }
    return false;
  }

  /** Room code the user currently occupies, or null when they are not in a room. */
  currentRoomCode(userId: string): string | null {
    const code = this.userRoom.get(userId);
    return code && this.rooms.has(code) ? code : null;
  }

  /** Default rules for a manually created room of the given mode. */
  private defaultRules(mode: Mode): RoomRules {
    const setBased = mode === "duel" || mode === "team2v2";
    return {
      bestOf: setBased ? this.config.defaultBestOf : 1,
      guessMode: DEFAULT_GUESS_MODE,
      dictionary: DEFAULT_DICTIONARY,
      pointsToWin: mode === "ffa3" ? this.config.ffaTargetScore : this.config.pointsToWin,
    };
  }

  /** Validate/normalize rules coming from a proposal (missing fields keep `fallback`). */
  private normalizeRules(mode: Mode, raw: unknown, fallback: RoomRules): RoomRules {
    const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const setBased = mode === "duel" || mode === "team2v2";
    const bestOf = setBased && isDuelBestOf(source.bestOf) ? source.bestOf : setBased ? fallback.bestOf : 1;
    const guessMode = isGuessMode(source.guessMode) ? source.guessMode : fallback.guessMode;
    const dictionary = isDictionaryMode(source.dictionary) ? source.dictionary : fallback.dictionary;
    const rawPoints = source.pointsToWin;
    const pointsToWin =
      typeof rawPoints === "number" && Number.isInteger(rawPoints) && rawPoints >= MIN_POINTS_TO_WIN && rawPoints <= MAX_POINTS_TO_WIN
        ? rawPoints
        : fallback.pointsToWin;
    return { bestOf, guessMode, dictionary, pointsToWin };
  }

  /** Mirror the room rules onto the (not yet started) match state. */
  private syncRulesToMatch(room: RoomInternal): void {
    const setBased = room.mode === "duel" || room.mode === "team2v2";
    room.match.bestOf = setBased ? room.rules.bestOf : 1;
    room.match.setsToWin = setBased ? setsToWinForBestOf(room.rules.bestOf) : 1;
    room.match.pointsToWin = setBased ? room.rules.pointsToWin : 0;
    room.match.targetScore = room.mode === "ffa3" ? room.rules.pointsToWin : 0;
    room.match.pointLead = setBased ? this.config.pointLead : 0;
  }

  // ------------------------------------------------------------------
  // public queries
  // ------------------------------------------------------------------

  getPublicRooms(): RoomSummary[] {
    const rooms: RoomSummary[] = [];
    for (const room of this.rooms.values()) {
      if (room.visibility !== "public") continue;
      // Practice rooms are personal: never listed in the lobby.
      if (room.mode === "practice") continue;
      rooms.push(this.toSummary(room));
    }
    return rooms.sort((a, b) => b.code.localeCompare(a.code));
  }

  getQueueState(userId: string): { mode: Mode; size: number; needed: number; position: number } | null {
    for (const mode of Object.keys(this.queues) as Mode[]) {
      const index = this.queues[mode].indexOf(userId);
      if (index >= 0) {
        return { mode, size: this.queues[mode].length, needed: modeCapacity(mode), position: index + 1 };
      }
    }
    return null;
  }

  findRoomByCode(code: string): { mode: Mode; status: RoomStatus } | null {
    const room = this.rooms.get(code);
    return room ? { mode: room.mode, status: room.status } : null;
  }

  roomCount(): number {
    return this.rooms.size;
  }

  shutdown(): void {
    if (this.idleSweep) {
      clearInterval(this.idleSweep);
      this.idleSweep = null;
    }
    for (const room of [...this.rooms.values()]) this.destroyRoom(room, null);
    this.queues.duel = [];
    this.queues.ffa3 = [];
    this.queues.team2v2 = [];
  }

  // ------------------------------------------------------------------
  // connection lifecycle
  // ------------------------------------------------------------------

  handleConnect(userId: string): void {
    const code = this.userRoom.get(userId);
    if (code) {
      const room = this.rooms.get(code);
      const player = room ? this.playerFor(room, userId) : null;
      if (room && player) {
        this.restoreSeat(room, player, true);
        this.sendStateTo(room, userId, "player");
        return;
      }
    }
    const spectatorCode = this.spectating.get(userId);
    if (spectatorCode) {
      const room = this.rooms.get(spectatorCode);
      if (room && room.spectators.some((spectator) => spectator.id === userId)) {
        this.sendStateTo(room, userId, "spectator");
        return;
      }
      this.spectating.delete(userId);
    }
    const queueState = this.getQueueState(userId);
    if (queueState) this.send(userId, { type: "queue", state: queueState });
  }

  handleDisconnect(userId: string): void {
    const code = this.userRoom.get(userId);
    if (code) {
      const room = this.rooms.get(code);
      const player = room ? this.playerFor(room, userId) : null;
      if (room && player) {
        if (
          room.mode !== "practice" &&
          room.status === "waiting" &&
          room.players.length === 1 &&
          player.isHost
        ) {
          // A lone host gets the same 3 minute seat reservation as in a match.
          this.beginSeatReservation(room, player, "断线");
          return;
        }
        if (room.mode === "practice" || room.status === "waiting" || room.status === "matchEnd") {
          this.removePlayer(room, userId, "断线");
          return;
        }
        this.beginSeatReservation(room, player, "断线");
        return;
      }
    }
    const spectatorCode = this.spectating.get(userId);
    if (spectatorCode) {
      const room = this.rooms.get(spectatorCode);
      this.spectating.delete(userId);
      if (room) {
        room.spectators = room.spectators.filter((spectator) => spectator.id !== userId);
        this.pushState(room);
      }
    }
    this.removeFromQueue(userId, false);
  }

  /** Mark a seat as temporarily empty; the player has `leaveGraceMs` to come back. */
  private beginSeatReservation(room: RoomInternal, player: PlayerInternal, reason: string): void {
    if (!player.connected && player.rejoinDeadline) return;
    player.connected = false;
    player.rejoinDeadline = Date.now() + this.config.leaveGraceMs;
    if (room.hostId === player.id) this.transferHost(room, player.id);
    const existing = room.rejoinTimers.get(player.id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      room.rejoinTimers.delete(player.id);
      this.handleRejoinExpired(room, player.id);
    }, this.config.leaveGraceMs);
    timer.unref?.();
    room.rejoinTimers.set(player.id, timer);
    this.touch(room);
    this.pushState(room);
    this.broadcastRoomList();
    this.sendToRoom(room, {
      type: "toast",
      message: `${player.name} ${reason}了，座位保留 ${Math.round(this.config.leaveGraceMs / 1000)} 秒`,
    });
  }

  private restoreSeat(room: RoomInternal, player: PlayerInternal, broadcast: boolean): void {
    player.connected = true;
    player.rejoinDeadline = null;
    const timer = room.rejoinTimers.get(player.id);
    if (timer) {
      clearTimeout(timer);
      room.rejoinTimers.delete(player.id);
    }
    this.touch(room);
    this.pushState(room);
    if (broadcast) this.broadcastRoomList();
  }

  private handleRejoinExpired(room: RoomInternal, userId: string): void {
    if (!this.rooms.has(room.code)) return;
    const player = this.playerFor(room, userId);
    if (!player || player.connected || player.rejoinDeadline === null) return;
    player.rejoinDeadline = null;
    if (room.status === "waiting") {
      // A reserved waiting-room seat simply disappears when the grace period ends.
      this.removePlayer(room, userId, "超时未归");
      return;
    }
    if (room.mode === "duel") {
      const opponent = room.players.find((candidate) => candidate.id !== userId) ?? null;
      if (!opponent) {
        this.removePlayer(room, userId, "断线");
        return;
      }
      room.match.setWins[opponent.id] = Math.max(
        room.match.setWins[opponent.id] ?? 0,
        room.match.setsToWin,
      );
      this.endMatch(room, {
        winnerId: opponent.id,
        winnerName: opponent.name,
        winnerTeam: null,
        isDraw: false,
        forfeitById: userId,
        forfeitTeam: null,
      });
      return;
    }
    if (room.mode === "team2v2") {
      const opponentTeam: Team = player.team === "A" ? "B" : "A";
      room.match.setWins[opponentTeam] = Math.max(
        room.match.setWins[opponentTeam] ?? 0,
        room.match.setsToWin,
      );
      this.endMatch(room, {
        winnerId: null,
        winnerName: null,
        winnerTeam: opponentTeam,
        isDraw: false,
        forfeitById: userId,
        forfeitTeam: opponentTeam,
      });
      return;
    }
    // ffa3: remove the player; if only one is left that player wins.
    this.removePlayer(room, userId, "断线");
    if (!this.rooms.has(room.code)) return;
    if (room.players.length === 1) {
      const winner = room.players[0];
      this.endMatch(room, {
        winnerId: winner.id,
        winnerName: winner.name,
        winnerTeam: null,
        isDraw: false,
        forfeitById: userId,
        forfeitTeam: null,
      });
    }
  }

  // ------------------------------------------------------------------
  // room operations
  // ------------------------------------------------------------------

  createRoom(
    user: PublicUser,
    mode: Mode,
    visibility: Visibility,
    rawBestOf?: unknown,
    rawGuessMode?: unknown,
    rawDictionary?: unknown,
    rawPointsToWin?: unknown,
  ): string {
    if (!isMode(mode)) throw new RoomError("未知的模式");
    if (visibility !== "public" && visibility !== "private") throw new RoomError("未知的房间可见性");
    const setBased = mode === "duel" || mode === "team2v2";
    const defaults = this.defaultRules(mode);
    if (rawGuessMode !== undefined && !isGuessMode(rawGuessMode)) throw new RoomError("未知的猜词模式");
    const guessMode = isGuessMode(rawGuessMode) ? rawGuessMode : defaults.guessMode;
    if (rawDictionary !== undefined && !isDictionaryMode(rawDictionary)) {
      throw new RoomError("词库只能是 common 或 all");
    }
    const dictionary = isDictionaryMode(rawDictionary) ? rawDictionary : defaults.dictionary;
    let bestOf = setBased ? defaults.bestOf : 1;
    if (setBased && rawBestOf !== undefined && rawBestOf !== null) {
      if (!isDuelBestOf(rawBestOf)) throw new RoomError("大比分只能是 1、3、5 或 7 局");
      bestOf = rawBestOf;
    }
    let pointsToWin = defaults.pointsToWin;
    if (rawPointsToWin !== undefined && rawPointsToWin !== null) {
      if (
        typeof rawPointsToWin !== "number" ||
        !Number.isInteger(rawPointsToWin) ||
        rawPointsToWin < MIN_POINTS_TO_WIN ||
        rawPointsToWin > MAX_POINTS_TO_WIN
      ) {
        throw new RoomError(`目标分需为 ${MIN_POINTS_TO_WIN} 到 ${MAX_POINTS_TO_WIN} 之间的整数`);
      }
      pointsToWin = rawPointsToWin;
    }
    const rules: RoomRules = { bestOf, guessMode, dictionary, pointsToWin };
    this.releaseAbandonedWaitingRoom(user.id);
    if (this.userRoom.has(user.id)) throw new RoomError("你已经在房间中，请先离开");
    this.leaveSpectate(user.id);
    this.removeFromQueue(user.id, true);
    const room = this.newRoom(mode, visibility, [user], false, rules, false);
    if (mode === "practice") {
      // Practice starts immediately: no ready, no countdown, no lobby listing.
      for (const player of room.players) player.ready = true;
      room.status = "playing";
      this.beginMatch(room);
      this.send(user.id, { type: "toast", message: "练习开始" });
      this.pushState(room);
      return room.code;
    }
    this.send(user.id, { type: "toast", message: "房间创建成功（房主无需准备）" });
    this.pushState(room);
    this.broadcastRoomList();
    return room.code;
  }

  joinRoom(user: PublicUser, rawCode: string): void {
    const code = String(rawCode ?? "").trim();
    if (!/^\d{5}$/.test(code)) throw new RoomError("请输入 5 位房号");
    const room = this.rooms.get(code);
    if (!room) throw new RoomError("房间不存在");
    const existing = this.playerFor(room, user.id);
    if (existing) {
      // Rejoin keeps the seat / team / score regardless of room status.
      this.restoreSeat(room, existing, true);
      this.send(user.id, { type: "toast", message: "已回到房间" });
      return;
    }
    this.releaseAbandonedWaitingRoom(user.id);
    if (this.userRoom.has(user.id)) throw new RoomError("你已经在其他房间中");
    if (room.status !== "waiting") throw new RoomError("房间已开始，无法加入");
    if (room.players.length >= modeCapacity(room.mode)) throw new RoomError("房间已满");
    this.leaveSpectate(user.id);
    this.removeFromQueue(user.id, true);
    const team = room.mode === "team2v2" ? this.assignTeam(room) : null;
    const player = this.makePlayer(user, team, false);
    room.players.push(player);
    if (team) room.teamLastAssigned = team;
    this.userRoom.set(user.id, room.code);
    this.ensureMatchStats(room, player);
    this.syncSetWins(room);
    this.touch(room);
    this.send(user.id, { type: "toast", message: `已加入房间 ${room.code}` });
    this.pushState(room);
    this.broadcastRoomList();
  }

  leaveRoom(userId: string): void {
    const room = this.roomOfUser(userId);
    if (!room) throw new RoomError("你当前不在房间中");
    const player = this.playerFor(room, userId);
    if (!player) throw new RoomError("你当前不在房间中");
    if (
      room.mode !== "practice" &&
      room.status === "waiting" &&
      room.players.length === 1 &&
      player.isHost
    ) {
      this.send(userId, {
        type: "toast",
        message: `已离开房间，房间保留 ${Math.round(this.config.leaveGraceMs / 1000)} 秒，可用房号回来`,
      });
      this.beginSeatReservation(room, player, "主动离开");
      return;
    }
    if (room.mode === "practice" || room.status === "waiting" || room.status === "matchEnd") {
      this.send(userId, { type: "toast", message: "已离开房间" });
      this.removePlayer(room, userId, "主动离开");
      return;
    }
    this.send(userId, {
      type: "toast",
      message: `已离开房间，座位保留 ${Math.round(this.config.leaveGraceMs / 1000)} 秒，可用房号回来`,
    });
    this.beginSeatReservation(room, player, "主动离开");
  }

  setReady(userId: string, ready: boolean): void {
    const room = this.requireRoomOfPlayer(userId);
    if (room.mode === "practice") throw new RoomError("练习模式无需准备");
    if (room.status !== "waiting") throw new RoomError("当前状态不能准备");
    const player = this.playerFor(room, userId);
    if (!player) throw new RoomError("你不在这个房间中");
    if (player.isHost) {
      player.ready = true;
      this.send(userId, { type: "toast", message: "房主无需准备" });
      this.pushState(room);
      return;
    }
    player.ready = Boolean(ready);
    this.touch(room);
    this.pushState(room);
    this.broadcastRoomList();
  }

  startRoom(userId: string): void {
    const room = this.requireRoomOfPlayer(userId);
    if (room.mode === "practice") throw new RoomError("练习模式无需开始");
    if (room.hostId !== userId) throw new RoomError("只有房主可以开始游戏");
    if (room.status === "countdown") {
      this.send(userId, { type: "toast", message: "已在倒计时中" });
      return;
    }
    if (room.status !== "waiting") throw new RoomError("当前状态不能开始游戏");
    if (room.requiresAgreement && !room.rulesAgreed) throw new RoomError("请先与对手确认规则");
    this.assertStartable(room);
    this.startCountdown(room);
  }

  /** Host can change rules while a private room is still waiting. */
  updateRules(userId: string, rawRules: unknown): void {
    const room = this.requireRoomOfPlayer(userId);
    if (room.mode === "practice") throw new RoomError("练习模式无需修改规则");
    if (room.hostId !== userId) throw new RoomError("只有房主可以修改规则");
    if (room.status !== "waiting") throw new RoomError("比赛开始后不能修改规则");
    if (room.requiresAgreement) throw new RoomError("快速匹配请使用规则协商");
    const rules = this.normalizeRules(room.mode, rawRules, room.rules);
    this.applyRules(room, rules);
  }

  /** Propose a rule set (any player may propose; a new proposal resets acceptance). */
  proposeRules(userId: string, rawRules: unknown): void {
    const room = this.requireRoomOfPlayer(userId);
    if (room.mode === "practice") throw new RoomError("练习模式无需协商规则");
    if (room.status !== "waiting") throw new RoomError("比赛开始后不能修改规则");
    const player = this.playerFor(room, userId);
    if (!player) throw new RoomError("你不在这个房间中");
    const rules = this.normalizeRules(room.mode, rawRules, room.rules);
    // Quick-match rooms stay best-of-1 regardless of the proposal.
    if (room.requiresAgreement) rules.bestOf = 1;
    room.proposal = {
      id: `p_${randomBytes(6).toString("hex")}`,
      proposerId: player.id,
      proposerName: player.name,
      rules,
      createdAt: Date.now(),
    };
    room.proposalAcceptedBy = new Set<string>();
    room.rulesAgreed = false;
    this.touch(room);
    this.pushState(room);
    this.sendToRoom(room, { type: "toast", message: `${player.name} 发起了规则提议` });
  }

  /** Accept the current proposal; all non-proposers accepting applies the rules. */
  acceptRules(userId: string, rawProposalId: unknown): void {
    const room = this.requireRoomOfPlayer(userId);
    if (room.status !== "waiting") throw new RoomError("比赛开始后不能协商规则");
    const proposal = room.proposal;
    if (!proposal) throw new RoomError("当前没有规则提议");
    if (typeof rawProposalId !== "string" || rawProposalId !== proposal.id) {
      throw new RoomError("规则提议已更新，请重新查看");
    }
    const player = this.playerFor(room, userId);
    if (!player) throw new RoomError("你不在这个房间中");
    if (player.id === proposal.proposerId) {
      this.send(userId, { type: "toast", message: "提议者无需重复同意" });
      return;
    }
    room.proposalAcceptedBy.add(player.id);
    const required = room.players
      .filter((candidate) => candidate.id !== proposal.proposerId)
      .map((candidate) => candidate.id);
    const allAccepted = required.every((id) => room.proposalAcceptedBy.has(id));
    if (allAccepted) {
      this.applyRules(room, proposal.rules);
      return;
    }
    this.touch(room);
    this.pushState(room);
    this.sendToRoom(room, {
      type: "toast",
      message: `${player.name} 已同意规则，等待其他人确认`,
    });
  }

  /** Counter a proposal: replaces it with a new proposal from the sender. */
  counterRules(userId: string, rawRules: unknown): void {
    const room = this.requireRoomOfPlayer(userId);
    if (room.status !== "waiting") throw new RoomError("比赛开始后不能修改规则");
    const proposal = room.proposal;
    if (!proposal) throw new RoomError("当前没有可修改的规则提议");
    if (proposal.proposerId === userId) throw new RoomError("提议者不能修改自己的提议");
    const player = this.playerFor(room, userId);
    if (!player) throw new RoomError("你不在这个房间中");
    const rules = this.normalizeRules(room.mode, rawRules, proposal.rules);
    if (room.requiresAgreement) rules.bestOf = 1;
    room.proposal = {
      id: `p_${randomBytes(6).toString("hex")}`,
      proposerId: player.id,
      proposerName: player.name,
      rules,
      createdAt: Date.now(),
    };
    room.proposalAcceptedBy = new Set<string>();
    room.rulesAgreed = false;
    this.touch(room);
    this.pushState(room);
    this.sendToRoom(room, { type: "toast", message: `${player.name} 修改了规则提议` });
  }

  private applyRules(room: RoomInternal, rules: RoomRules): void {
    room.rules = { ...rules };
    room.rulesAgreed = true;
    room.proposal = null;
    room.proposalAcceptedBy = new Set<string>();
    this.syncRulesToMatch(room);
    this.touch(room);
    this.pushState(room);
    this.broadcastRoomList();
    this.sendToRoom(room, { type: "toast", message: "规则已确认，房主可以开始比赛" });
  }

  /** Move a player between team A/B in a waiting team room. */
  setTeam(userId: string, rawTeam: unknown, rawTargetId?: unknown): void {
    const team = rawTeam === "A" || rawTeam === "B" ? rawTeam : null;
    if (!team) throw new RoomError("队伍必须是 A 或 B");
    const room = this.requireRoomOfPlayer(userId);
    if (room.mode !== "team2v2") throw new RoomError("只有团队战可以选队");
    if (room.status !== "waiting") throw new RoomError("比赛开始后不能换队");
    const targetId = typeof rawTargetId === "string" && rawTargetId.length > 0 ? rawTargetId : userId;
    const target = this.playerFor(room, targetId);
    if (!target) throw new RoomError("该玩家不在房间中");
    if (target.id !== userId && room.hostId !== userId) {
      throw new RoomError("只有房主可以调整其他玩家的队伍");
    }
    if (target.team === team) {
      this.pushState(room);
      return;
    }
    target.team = team;
    room.teamLastAssigned = team;
    this.syncSetWins(room);
    this.touch(room);
    this.pushState(room);
    this.broadcastRoomList();
    this.sendToRoom(room, { type: "toast", message: `${target.name} 已加入 ${team} 队` });
  }

  /** Propose a draw; every other player has to accept it. */
  offerDraw(userId: string): void {
    const room = this.roomOfUser(userId);
    if (!room) {
      if (this.spectating.has(userId)) throw new RoomError("观战者不能求和");
      throw new RoomError("你当前不在房间中");
    }
    const player = this.playerFor(room, userId);
    if (!player) throw new RoomError("观战者不能求和");
    if (room.mode === "practice") throw new RoomError("练习模式不能求和");
    if (room.status !== "playing" && room.status !== "roundEnd") {
      throw new RoomError("当前不能发起求和");
    }
    if (room.drawOffer) {
      this.send(userId, { type: "toast", message: "已有求和请求，等待回应" });
      return;
    }
    room.drawOffer = {
      proposerId: player.id,
      proposerName: player.name,
      acceptedBy: [player.id],
      createdAt: Date.now(),
    };
    this.touch(room);
    this.pushState(room);
    this.sendToRoom(room, { type: "toast", message: `${player.name} 发起求和，等待其他玩家同意` });
  }

  /** Accept or reject the pending draw offer (proposer may not respond). */
  respondDraw(userId: string, accept: boolean): void {
    const room = this.roomOfUser(userId);
    if (!room) {
      if (this.spectating.has(userId)) throw new RoomError("观战者不能回应求和");
      throw new RoomError("你当前不在房间中");
    }
    const player = this.playerFor(room, userId);
    if (!player) throw new RoomError("观战者不能回应求和");
    const offer = room.drawOffer;
    if (!offer) throw new RoomError("当前没有求和请求");
    if (offer.proposerId === player.id) throw new RoomError("不能回应自己的求和");
    if (!accept) {
      room.drawOffer = null;
      this.touch(room);
      this.pushState(room);
      this.sendToRoom(room, { type: "toast", message: `${player.name} 拒绝了求和` });
      return;
    }
    if (!offer.acceptedBy.includes(player.id)) offer.acceptedBy.push(player.id);
    const required = room.players.filter((candidate) => candidate.id !== offer.proposerId);
    const allAccepted = required.every((candidate) => offer.acceptedBy.includes(candidate.id));
    if (!allAccepted) {
      this.touch(room);
      this.pushState(room);
      this.sendToRoom(room, { type: "toast", message: `${player.name} 同意求和，等待其他玩家确认` });
      return;
    }
    room.drawOffer = null;
    this.endMatch(room, this.drawDecision());
  }

  rematch(userId: string): void {
    const room = this.requireRoomOfPlayer(userId);
    if (room.hostId !== userId) throw new RoomError("只有房主可以发起再来一局");
    if (room.status !== "matchEnd") throw new RoomError("比赛还没有结束");
    this.clearRoundTimers(room);
    // Any seat reservations end with the match.
    for (const timer of room.rejoinTimers.values()) clearTimeout(timer);
    room.rejoinTimers.clear();
    room.teamScores = { A: 0, B: 0 };
    room.match = this.freshMatch(room.mode, room.rules);
    room.round = null;
    room.matchRecorded = false;
    room.matchStats = new Map();
    room.recentRounds = [];
    room.proposal = null;
    room.proposalAcceptedBy = new Set();
    room.drawOffer = null;
    for (const player of room.players) {
      player.score = 0;
      player.guesses = 0;
      player.lastGuessAt = 0;
      player.rejoinDeadline = null;
      this.ensureMatchStats(room, player);
    }
    this.syncSetWins(room);
    this.touch(room);
    if (room.mode === "practice") {
      // Another practice board starts right away, no ready/start step.
      room.status = "playing";
      this.beginRound(room);
      this.send(userId, { type: "toast", message: "新的一局练习开始" });
      return;
    }
    room.status = "waiting";
    room.countdownEndsAt = null;
    for (const player of room.players) player.ready = room.requiresAgreement ? true : player.isHost;
    this.pushState(room);
    this.broadcastRoomList();
    this.send(userId, { type: "toast", message: "已回到准备房间" });
  }

  guess(userId: string, rawWord: string): void {
    const room = this.roomOfUser(userId);
    if (!room) {
      if (this.spectating.has(userId)) throw new RoomError("观战者不能猜词");
      throw new RoomError("你当前不在房间中");
    }
    if (!room.round || room.status !== "playing" || room.round.status !== "playing") {
      throw new RoomError("当前不能猜词");
    }
    const round = room.round;
    const player = this.playerFor(room, userId);
    if (!player) throw new RoomError("你不在这个房间中");
    if (!player.connected) throw new RoomError("你已离开座位，请先回到房间");
    const now = Date.now();
    if (player.lastGuessAt > 0) {
      const elapsed = now - player.lastGuessAt;
      if (elapsed < this.config.guessCooldownMs) {
        const remaining = Math.ceil((this.config.guessCooldownMs - elapsed) / 1000);
        throw new RoomError(`冷却中，还需等待 ${remaining} 秒`);
      }
    }
    if (typeof rawWord !== "string") throw new RoomError("猜测词必须是字符串");
    const word = rawWord.trim();
    let validation;
    if (room.rules.guessMode === "free") {
      validation = validateFreeGuessDetail(this.data, word);
    } else {
      // 标准模式的输入词库始终使用全量词库；房间词库设置只影响答案池。
      validation = validateGuessDetail(this.data, word, "all");
      if (!validation.ok) {
        const suggestion = suggestStandardWord(this.data, word, "all");
        if (suggestion) throw new RoomError(`词库中没有这个成语，你是否要输入「${suggestion}」？`);
      }
    }
    if (!validation.ok) throw new RoomError(validation.reason);
    if (round.feedback.tried.has(word)) throw new RoomError("本轮已经猜过这个成语了，换一个试试");

    // A valid guess resets the "nobody guessed" countdown.
    this.resetIdleTimer(room, round);

    player.lastGuessAt = now;
    player.guesses += 1;
    this.touch(room);

    const tiles: TileFeedback[] = buildRowFeedback(this.data, round.answer, word, round.feedback);
    const correct = word === round.answer;
    round.rows.push({
      id: round.rows.length + 1,
      playerId: player.id,
      playerName: player.name,
      word,
      tiles,
      correct,
      createdAt: now,
    });
    round.guessedPlayerIds.add(player.id);
    const stat = this.matchStatFor(room, player.id);
    if (stat) stat.guesses += 1;

    if (correct) {
      this.scorePoint(room, player, { solved: true, solveMs: now - round.startedAt });
      this.applySetCompletion(room, round);
      this.endRound(room, "solved", player);
      return;
    }
    if (round.rows.length >= this.config.rowsPerRound) {
      this.awardSixthRowFail(room, round, player);
      this.applySetCompletion(room, round);
      this.endRound(room, "exhausted", null);
      return;
    }
    this.pushState(room);
  }

  /** Add one point to a player (and their team in team mode) + stats. */
  private scorePoint(
    room: RoomInternal,
    player: PlayerInternal,
    options: { solved: boolean; solveMs?: number },
  ): void {
    const stat = this.matchStatFor(room, player.id);
    if (room.mode === "practice") {
      // Practice has no points/sets; only solve statistics matter.
      if (stat && options.solved) {
        stat.solves += 1;
        // Clamp to 1ms so instant answers still have a measurable solve time.
        const solveMs = Math.max(1, options.solveMs ?? 0);
        stat.totalSolveMs += solveMs;
        stat.fastestSolveMs = stat.fastestSolveMs > 0 ? Math.min(stat.fastestSolveMs, solveMs) : solveMs;
      }
      return;
    }
    player.score += 1;
    if (room.mode === "team2v2" && player.team) room.teamScores[player.team] += 1;
    if (stat) {
      stat.points += 1;
      if (options.solved) {
        stat.solves += 1;
        // Clamp to 1ms so instant answers still have a measurable solve time.
        const solveMs = Math.max(1, options.solveMs ?? 0);
        stat.totalSolveMs += solveMs;
        stat.fastestSolveMs = stat.fastestSolveMs > 0 ? Math.min(stat.fastestSolveMs, solveMs) : solveMs;
      }
    }
  }

  /** 6th wrong row: award +1 to the other side and mark the awarded players/team. */
  private awardSixthRowFail(room: RoomInternal, round: RoundInternal, lastPlayer: PlayerInternal): void {
    // Practice has no opponent to award.
    if (room.mode === "practice") return;
    if (room.mode === "duel") {
      const opponent = room.players.find((candidate) => candidate.id !== lastPlayer.id);
      if (!opponent) return;
      this.scorePoint(room, opponent, { solved: false });
      round.awardedTo = [opponent.id];
      round.awardedTeam = null;
      return;
    }
    if (room.mode === "team2v2") {
      const opponentTeam: Team = lastPlayer.team === "A" ? "B" : "A";
      room.teamScores[opponentTeam] += 1;
      round.awardedTo = room.players
        .filter((player) => player.team === opponentTeam)
        .map((player) => player.id);
      round.awardedTeam = opponentTeam;
      return;
    }
    const others = room.players.filter((candidate) => candidate.id !== lastPlayer.id);
    for (const other of others) this.scorePoint(room, other, { solved: false });
    round.awardedTo = others.map((other) => other.id);
    round.awardedTeam = null;
  }

  /** Record a completed set (duel/team) into the big score + history + stats. */
  private applySetCompletion(room: RoomInternal, round: RoundInternal): void {
    const { playerId, team } = this.currentSetWinner(room);
    if (!playerId && !team) return;
    const key = playerId ?? team!;
    room.match.setWins[key] = (room.match.setWins[key] ?? 0) + 1;
    round.setWinnerId = playerId;
    round.setWinnerTeam = team;
    if (playerId) {
      const stat = this.matchStatFor(room, playerId);
      if (stat) stat.setsWon += 1;
    }
    if (team) {
      for (const player of room.players) {
        if (player.team !== team) continue;
        const stat = this.matchStatFor(room, player.id);
        if (stat) stat.setsWon += 1;
      }
    }
    const scores: Record<string, number> = {};
    if (room.mode === "team2v2") {
      scores.A = room.teamScores.A;
      scores.B = room.teamScores.B;
    } else {
      for (const player of room.players) scores[player.id] = player.score;
    }
    const entry: SetHistoryEntry = {
      setNumber: room.match.setNumber,
      winnerId: playerId,
      winnerTeam: team,
      scores,
      teamScores: { A: room.teamScores.A, B: room.teamScores.B },
      pointsToWin: room.match.pointsToWin,
      endedAt: Date.now(),
    };
    room.match.setHistory.push(entry);
  }

  chat(userId: string, rawScope: ChatScope, rawText: string): void {
    const room = this.roomOfUser(userId);
    if (!room) {
      const spectatorCode = this.spectating.get(userId);
      const watched = spectatorCode ? this.rooms.get(spectatorCode) : null;
      const spectator = watched?.spectators.find((entry) => entry.id === userId);
      if (!watched || !spectator) {
        if (spectatorCode) throw new RoomError("观战者不能发言");
        throw new RoomError("你当前不在房间中");
      }
      if (rawScope === "team") throw new RoomError("观战者不能发送队伍消息");
      const text = clampText(rawText);
      if (!text) throw new RoomError("消息不能为空");
      const message: ChatMessage = {
        id: `c_${Date.now().toString(36)}_${(chatCounter += 1)}`,
        scope: "room",
        userId: spectator.id,
        name: spectator.name,
        text,
        ts: Date.now(),
      };
      watched.chat.push(message);
      if (watched.chat.length > CHAT_HISTORY_LIMIT) {
        watched.chat.splice(0, watched.chat.length - CHAT_HISTORY_LIMIT);
      }
      this.touch(watched);
      this.pushState(watched);
      return;
    }
    const player = this.playerFor(room, userId);
    if (!player) throw new RoomError("你当前不在房间中");
    const scope: ChatScope = rawScope === "team" ? "team" : "room";
    if (scope === "team" && !player.team) throw new RoomError("当前模式不支持队伍聊天");
    const text = clampText(rawText);
    if (!text) throw new RoomError("消息不能为空");
    const message: ChatMessage = {
      id: `c_${Date.now().toString(36)}_${(chatCounter += 1)}`,
      scope,
      userId: player.id,
      name: player.name,
      text,
      ts: Date.now(),
    };
    room.chat.push(message);
    if (room.chat.length > CHAT_HISTORY_LIMIT) room.chat.splice(0, room.chat.length - CHAT_HISTORY_LIMIT);
    this.touch(room);
    this.pushState(room);
  }

  // ------------------------------------------------------------------
  // spectators
  // ------------------------------------------------------------------

  spectateJoin(userId: string, rawCode: string): void {
    const code = String(rawCode ?? "").trim();
    if (!/^\d{5}$/.test(code)) throw new RoomError("请输入 5 位房号");
    const room = this.rooms.get(code);
    if (!room) throw new RoomError("房间不存在");
    if (room.mode === "practice") throw new RoomError("练习模式不能观战");
    if (this.userRoom.get(userId) === code) throw new RoomError("你已经是该房间的玩家");
    if (this.spectating.get(userId) === code) {
      this.sendStateTo(room, userId, "spectator");
      return;
    }
    this.leaveSpectate(userId);
    if (room.spectators.length >= this.config.spectatorLimit) throw new RoomError("观战人数已满");
    const user = this.store.getUserById(userId);
    if (!user) throw new RoomError("用户不存在");
    room.spectators.push({ id: user.id, name: user.name });
    this.spectating.set(userId, code);
    this.touch(room);
    this.send(userId, { type: "toast", message: "正在观战，仅可查看不能操作" });
    this.pushState(room);
    this.broadcastRoomList();
  }

  spectateLeave(userId: string): void {
    this.leaveSpectate(userId);
    this.send(userId, { type: "toast", message: "已退出观战" });
  }

  // ------------------------------------------------------------------
  // matchmaking queue (duel / ffa3 only; team needs a room code)
  // ------------------------------------------------------------------

  queueJoin(user: PublicUser, mode: Mode): void {
    if (!isMode(mode)) throw new RoomError("未知的模式");
    if (mode === "team2v2") throw new RoomError("团队战请用房号");
    if (mode === "practice") throw new RoomError("练习模式不支持快速匹配");
    this.releaseAbandonedWaitingRoom(user.id);
    if (this.userRoom.has(user.id)) throw new RoomError("你已经在房间中，请先离开");
    this.leaveSpectate(user.id);
    const needed = modeCapacity(mode);
    const queue = this.queues[mode];
    if (!queue.includes(user.id)) queue.push(user.id);
    if (queue.length >= needed) {
      const matched = queue.splice(0, needed);
      this.startQueueMatch(mode, matched);
      this.notifyQueue(mode);
      return;
    }
    this.notifyQueue(mode);
  }

  queueLeave(userId: string): void {
    this.removeFromQueue(userId, true);
  }

  // ------------------------------------------------------------------
  // client message dispatch
  // ------------------------------------------------------------------

  handleMessage(userId: string, message: ClientMessage): void {
    switch (message.type) {
      case "ping":
        this.send(userId, { type: "pong", serverTime: Date.now() });
        return;
      case "room.create":
        this.createRoom(
          this.requireUser(userId),
          message.mode,
          message.visibility,
          message.bestOf,
          message.guessMode,
          message.dictionary,
          message.pointsToWin,
        );
        return;
      case "room.join":
        this.joinRoom(this.requireUser(userId), message.code);
        return;
      case "room.leave":
        this.leaveRoom(userId);
        return;
      case "room.ready":
        this.setReady(userId, Boolean(message.ready));
        return;
      case "room.start":
        this.startRoom(userId);
        return;
      case "room.setTeam":
        this.setTeam(userId, message.team, message.userId);
        return;
      case "room.proposeRules":
        this.proposeRules(userId, message.rules);
        return;
      case "room.acceptRules":
        this.acceptRules(userId, message.proposalId);
        return;
      case "room.counterRules":
        this.counterRules(userId, message.rules);
        return;
      case "room.updateRules":
        this.updateRules(userId, message.rules);
        return;
      case "room.offerDraw":
        this.offerDraw(userId);
        return;
      case "room.respondDraw":
        this.respondDraw(userId, Boolean(message.accept));
        return;
      case "room.guess":
        this.guess(userId, message.word);
        return;
      case "room.chat":
        this.chat(userId, message.scope, message.text);
        return;
      case "room.rematch":
        this.rematch(userId);
        return;
      case "spectate.join":
        this.spectateJoin(userId, message.code);
        return;
      case "spectate.leave":
        this.spectateLeave(userId);
        return;
      case "queue.join":
        this.queueJoin(this.requireUser(userId), message.mode);
        return;
      case "queue.leave":
        this.queueLeave(userId);
        return;
      default:
        throw new RoomError("未知的消息类型");
    }
  }

  // ------------------------------------------------------------------
  // internals: room / player helpers
  // ------------------------------------------------------------------

  private requireUser(userId: string): PublicUser {
    const user = this.store.getUserById(userId);
    if (!user) throw new RoomError("登录状态已失效，请刷新页面重新进入");
    return this.store.toPublicUser(user);
  }

  /**
   * Drop a waiting room that only exists because its lone host left and the
   * seat is still reserved. Called before creating/joining another room or
   * entering a queue so an abandoned lobby cannot block the user.
   */
  private releaseAbandonedWaitingRoom(userId: string): void {
    const code = this.userRoom.get(userId);
    if (!code) return;
    const room = this.rooms.get(code);
    if (!room) {
      this.userRoom.delete(userId);
      return;
    }
    if (room.status !== "waiting" || room.players.length !== 1) return;
    const player = this.playerFor(room, userId);
    if (!player || player.connected || player.rejoinDeadline === null) return;
    this.removePlayer(room, userId, "主动离开");
  }

  private roomOfUser(userId: string): RoomInternal | null {
    const code = this.userRoom.get(userId);
    if (!code) return null;
    return this.rooms.get(code) ?? null;
  }

  private requireRoomOfPlayer(userId: string): RoomInternal {
    const room = this.roomOfUser(userId);
    if (!room) throw new RoomError("你当前不在房间中");
    return room;
  }

  private playerFor(room: RoomInternal, userId: string): PlayerInternal | null {
    return room.players.find((player) => player.id === userId) ?? null;
  }

  private touch(room: RoomInternal): void {
    room.lastActivity = Date.now();
  }

  /** Team assignment: smaller team first, alternating when both are equal. */
  private assignTeam(room: RoomInternal): Team {
    const sizeA = room.players.filter((player) => player.team === "A").length;
    const sizeB = room.players.filter((player) => player.team === "B").length;
    if (sizeA < sizeB) return "A";
    if (sizeB < sizeA) return "B";
    if (sizeA === 0) return "A";
    return room.teamLastAssigned === "A" ? "B" : "A";
  }

  private transferHost(room: RoomInternal, excludeId: string): void {
    const next =
      room.players.find((player) => player.id !== excludeId && player.connected) ??
      room.players.find((player) => player.id !== excludeId);
    if (!next) return;
    room.hostId = next.id;
    for (const player of room.players) player.isHost = player.id === room.hostId;
    // The host seat never needs a ready click.
    next.ready = true;
  }

  private makePlayer(user: PublicUser, team: Team | null, autoReady: boolean): PlayerInternal {
    return {
      id: user.id,
      name: user.name,
      avatar: user.avatar,
      isGuest: user.isGuest,
      team,
      score: 0,
      ready: autoReady,
      connected: true,
      isHost: false,
      guesses: 0,
      lastGuessAt: 0,
      rejoinDeadline: null,
    };
  }

  private freshMatch(mode: Mode, rules: RoomRules): MatchState {
    const setBased = mode === "duel" || mode === "team2v2";
    return {
      targetScore: mode === "ffa3" ? rules.pointsToWin : 0,
      maxRounds: 0,
      roundNumber: 0,
      setNumber: 1,
      setsToWin: setBased ? setsToWinForBestOf(rules.bestOf) : 1,
      bestOf: setBased ? rules.bestOf : 1,
      setWins: {},
      pointsToWin: setBased ? rules.pointsToWin : 0,
      pointLead: setBased ? this.config.pointLead : 0,
      winnerId: null,
      winnerName: null,
      winnerTeam: null,
      isDraw: false,
      forfeitById: null,
      forfeitTeam: null,
      setHistory: [],
      ratingDeltas: {},
      highlights: {},
    };
  }

  /** Keep `match.setWins` keyed by current players (team modes use A/B). */
  private syncSetWins(room: RoomInternal): void {
    const next: Record<string, number> = {};
    if (room.mode === "team2v2") {
      for (const team of ["A", "B"] as Team[]) next[team] = room.match.setWins[team] ?? 0;
    } else {
      for (const player of room.players) next[player.id] = room.match.setWins[player.id] ?? 0;
    }
    room.match.setWins = next;
  }

  /** Which side just won the current set (duel player id or team key). */
  private currentSetWinner(room: RoomInternal): { playerId: string | null; team: Team | null } {
    if (room.mode === "duel") {
      const winner = duelSetWinner(
        room.players.map((player) => ({ playerId: player.id, score: player.score })),
        room.match.pointsToWin,
        room.match.pointLead,
      );
      return { playerId: winner, team: null };
    }
    if (room.mode === "team2v2") {
      const winner = duelSetWinner(
        [
          { playerId: "A", score: room.teamScores.A },
          { playerId: "B", score: room.teamScores.B },
        ],
        room.match.pointsToWin,
        room.match.pointLead,
      );
      return { playerId: null, team: winner === "A" || winner === "B" ? winner : null };
    }
    return { playerId: null, team: null };
  }

  private newRoom(
    mode: Mode,
    visibility: Visibility,
    users: PublicUser[],
    autoReady: boolean,
    rules: RoomRules,
    requiresAgreement: boolean,
  ): RoomInternal {
    const code = this.generateCode();
    const players: PlayerInternal[] = users.map((user, index) => {
      const team = mode === "team2v2" ? (index % 2 === 0 ? "A" : "B") : null;
      const player = this.makePlayer(user, team, autoReady || index === 0);
      player.isHost = index === 0;
      return player;
    });
    const room: RoomInternal = {
      id: createRoomId(),
      code,
      mode,
      visibility,
      rules: { ...rules },
      requiresAgreement,
      rulesAgreed: !requiresAgreement,
      proposal: null,
      proposalAcceptedBy: new Set(),
      drawOffer: null,
      status: "waiting",
      hostId: users[0]?.id ?? "",
      players,
      spectators: [],
      teamScores: { A: 0, B: 0 },
      teamLastAssigned: players.length > 0 ? players[players.length - 1].team : null,
      round: null,
      match: this.freshMatch(mode, rules),
      recentRounds: [],
      chat: [],
      createdAt: Date.now(),
      lastActivity: Date.now(),
      countdownEndsAt: null,
      countdownTimer: null,
      roundEndTimer: null,
      rejoinTimers: new Map(),
      matchRecorded: false,
      matchStats: new Map(),
    };
    this.syncSetWins(room);
    for (const player of players) this.ensureMatchStats(room, player);
    this.rooms.set(code, room);
    for (const player of players) this.userRoom.set(player.id, code);
    return room;
  }

  private generateCode(): string {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      roomCounter += 1;
      const code = String((randomBytes(2).readUInt16BE(0) + roomCounter) % 100000).padStart(5, "0");
      if (!this.rooms.has(code)) return code;
    }
    throw new RoomError("房间创建失败，请稍后重试");
  }

  private toSummary(room: RoomInternal): RoomSummary {
    const host = room.players.find((player) => player.id === room.hostId);
    return {
      code: room.code,
      mode: room.mode,
      status: room.status,
      visibility: room.visibility,
      playerCount: room.players.length,
      capacity: MODE_META[room.mode].capacity,
      spectatorCount: room.spectators.length,
      hostName: host?.name ?? "",
      round: room.match.roundNumber,
      guessMode: room.rules.guessMode,
      dictionary: room.rules.dictionary,
      pointsToWin: room.rules.pointsToWin,
    };
  }

  private broadcastRoomList(): void {
    this.broadcastRooms(this.getPublicRooms());
  }

  // ------------------------------------------------------------------
  // internals: match statistics accumulators
  // ------------------------------------------------------------------

  private ensureMatchStats(room: RoomInternal, player: PlayerInternal): MatchStatEntry {
    let entry = room.matchStats.get(player.id);
    if (!entry) {
      entry = {
        userId: player.id,
        name: player.name,
        isGuest: player.isGuest,
        team: player.team,
        rounds: 0,
        roundsWithGuess: 0,
        guesses: 0,
        solves: 0,
        totalSolveMs: 0,
        fastestSolveMs: 0,
        points: 0,
        setsWon: 0,
      };
      room.matchStats.set(player.id, entry);
    } else {
      entry.name = player.name;
      entry.team = player.team;
    }
    return entry;
  }

  private matchStatFor(room: RoomInternal, userId: string): MatchStatEntry | null {
    const player = this.playerFor(room, userId);
    if (player) return this.ensureMatchStats(room, player);
    return room.matchStats.get(userId) ?? null;
  }

  private recordRoundStats(room: RoomInternal, round: RoundInternal): void {
    for (const userId of round.participantIds) {
      const entry = room.matchStats.get(userId);
      if (!entry) continue;
      entry.rounds += 1;
      if (round.guessedPlayerIds.has(userId)) entry.roundsWithGuess += 1;
    }
  }

  private finalizeStats(room: RoomInternal, decision: MatchDecision): void {
    const entries = [...room.matchStats.values()].filter((entry) => !entry.isGuest);
    if (entries.length === 0) return;
    if (room.mode === "practice") {
      // Practice keeps its own counters: boards, guesses, solves and solve time.
      for (const entry of entries) {
        this.store.mergePlayerStats("practice", entry.userId, {
          matches: 1,
          rounds: entry.rounds,
          roundsWithGuess: entry.roundsWithGuess,
          guesses: entry.guesses,
          solves: entry.solves,
          totalSolveMs: entry.totalSolveMs,
          fastestSolveMs: entry.fastestSolveMs,
        });
      }
      return;
    }
    const ffaRanks = room.mode === "ffa3" ? this.ffaRanking(entries, decision) : null;
    // Fastest average solve time in this match (only players who solved at least once).
    let fastestAvg = Number.POSITIVE_INFINITY;
    for (const entry of entries) {
      if (entry.solves <= 0) continue;
      fastestAvg = Math.min(fastestAvg, entry.totalSolveMs / entry.solves);
    }
    for (const entry of entries) {
      const result = this.matchResultFor(room, entry, decision);
      const fastestAward =
        Number.isFinite(fastestAvg) &&
        entry.solves > 0 &&
        Math.abs(entry.totalSolveMs / entry.solves - fastestAvg) < 1e-6
          ? 1
          : 0;
      const rank = ffaRanks?.get(entry.userId) ?? null;
      this.store.mergePlayerStats(room.mode, entry.userId, {
        matches: 1,
        wins: result === "win" ? 1 : 0,
        losses: result === "loss" ? 1 : 0,
        draws: result === "draw" ? 1 : 0,
        firsts: rank === "first" ? 1 : 0,
        seconds: rank === "second" ? 1 : 0,
        thirds: rank === "third" ? 1 : 0,
        rounds: entry.rounds,
        roundsWithGuess: entry.roundsWithGuess,
        guesses: entry.guesses,
        solves: entry.solves,
        totalSolveMs: entry.totalSolveMs,
        fastestSolveMs: entry.fastestSolveMs,
        fastestMatchAwards: fastestAward,
        points: entry.points,
        setsWon: entry.setsWon,
      });
    }
  }

  /**
   * FFA placement for one match. The winner is first; the remaining players
   * are grouped by score (descending) into dense ranks, so a tie shares a rank
   * and the next group still gets the following place.
   * Draws award no placement counters.
   */
  private ffaRanking(
    entries: MatchStatEntry[],
    decision: MatchDecision,
  ): Map<string, "first" | "second" | "third"> {
    const ranks = new Map<string, "first" | "second" | "third">();
    if (decision.isDraw) return ranks;
    const sorted = [...entries].sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
    const winner =
      (decision.winnerId ? entries.find((entry) => entry.userId === decision.winnerId) : undefined) ?? sorted[0];
    if (!winner) return ranks;
    ranks.set(winner.userId, "first");
    const rest = sorted.filter((entry) => entry.userId !== winner.userId);
    const labels = ["second", "third"] as const;
    let groupIndex = 0;
    let index = 0;
    while (index < rest.length && groupIndex < labels.length) {
      const score = rest[index].points;
      let end = index;
      while (end < rest.length && rest[end].points === score) end += 1;
      for (let cursor = index; cursor < end; cursor += 1) ranks.set(rest[cursor].userId, labels[groupIndex]);
      groupIndex += 1;
      index = end;
    }
    return ranks;
  }

  private matchResultFor(
    room: RoomInternal,
    entry: MatchStatEntry,
    decision: MatchDecision,
  ): "win" | "loss" | "draw" {
    if (decision.isDraw) return "draw";
    if (room.mode === "team2v2") {
      if (decision.winnerTeam) return entry.team === decision.winnerTeam ? "win" : "loss";
      return "draw";
    }
    if (decision.winnerId) return decision.winnerId === entry.userId ? "win" : "loss";
    return "draw";
  }

  // ------------------------------------------------------------------
  // internals: countdown / rounds / match end
  // ------------------------------------------------------------------

  private nonHostReady(room: RoomInternal): boolean {
    return room.players.filter((player) => !player.isHost).every((player) => player.ready);
  }

  private assertStartable(room: RoomInternal): void {
    if (room.mode === "duel") {
      if (room.players.length !== 2) throw new RoomError("人数不足，1v1 需要 2 名玩家");
    } else if (room.mode === "ffa3") {
      if (room.players.length !== 3) throw new RoomError("人数不足，3 人混战需要 3 名玩家");
    } else {
      const sizeA = room.players.filter((player) => player.team === "A").length;
      const sizeB = room.players.filter((player) => player.team === "B").length;
      if (sizeA < 1 || sizeB < 1) throw new RoomError("团队战需要 A/B 两队各至少 1 人");
    }
    if (!this.nonHostReady(room)) throw new RoomError("还有玩家没有准备");
  }

  private startCountdown(room: RoomInternal): void {
    if (room.status !== "waiting") return;
    this.assertStartable(room);
    room.status = "countdown";
    room.countdownEndsAt = Date.now() + this.config.countdownMs;
    for (const player of room.players) player.ready = true;
    this.touch(room);
    this.pushState(room);
    this.broadcastRoomList();
    this.sendToRoom(room, { type: "toast", message: "倒计时开始，准备抢答！" });
    room.countdownTimer = setTimeout(() => {
      room.countdownTimer = null;
      if (!this.rooms.has(room.code) || room.status !== "countdown") return;
      this.beginMatch(room);
    }, this.config.countdownMs);
    room.countdownTimer.unref?.();
  }

  private beginMatch(room: RoomInternal): void {
    room.status = "playing";
    room.countdownEndsAt = null;
    room.match = this.freshMatch(room.mode, room.rules);
    room.teamScores = { A: 0, B: 0 };
    room.matchStats = new Map();
    room.recentRounds = [];
    room.drawOffer = null;
    for (const player of room.players) {
      player.score = 0;
      player.guesses = 0;
      player.lastGuessAt = 0;
      player.ready = true;
      this.ensureMatchStats(room, player);
    }
    this.syncSetWins(room);
    this.beginRound(room);
  }

  private beginRound(room: RoomInternal): void {
    room.drawOffer = null;
    const roundNumber = room.match.roundNumber + 1;
    room.match.roundNumber = roundNumber;
    const now = Date.now();
    room.status = "playing";
    const round: RoundInternal = {
      index: roundNumber,
      answer: this.chooseAnswer(this.data, room.rules),
      rows: [],
      status: "playing",
      startedAt: now,
      endsAt: now + this.config.idleTimeoutMs,
      endedAt: null,
      result: null,
      winnerId: null,
      winnerName: null,
      awardedTo: [],
      awardedTeam: null,
      setWinnerId: null,
      setWinnerTeam: null,
      feedback: createRoundState(),
      participantIds: room.players.map((player) => player.id),
      guessedPlayerIds: new Set<string>(),
      timer: null,
    };
    room.round = round;
    this.touch(room);
    this.resetIdleTimer(room, round);
    this.pushState(room);
    this.broadcastRoomList();
  }

  /** (Re)start the "nobody guessed" countdown for the current round. */
  private resetIdleTimer(room: RoomInternal, round: RoundInternal): void {
    if (round.timer) {
      clearTimeout(round.timer);
      round.timer = null;
    }
    if (room.mode === "practice") {
      // Practice is untimed: only a solve or six wrong rows end the board.
      round.endsAt = 0;
      return;
    }
    round.endsAt = Date.now() + this.config.idleTimeoutMs;
    round.timer = setTimeout(() => {
      round.timer = null;
      if (!this.rooms.has(room.code)) return;
      this.endRound(room, "timeout", null);
    }, this.config.idleTimeoutMs);
    round.timer.unref?.();
  }

  /** Next 1v1/team set: keep the big score, clear the set score. */
  private beginNextSet(room: RoomInternal): void {
    room.match.setNumber += 1;
    room.teamScores = { A: 0, B: 0 };
    for (const player of room.players) {
      player.score = 0;
      player.guesses = 0;
      player.lastGuessAt = 0;
    }
    room.round = null;
    this.touch(room);
    this.beginRound(room);
  }

  /** Keep the three fastest solved idioms per player (fewest guesses first). */
  private recordHighlight(room: RoomInternal, playerId: string, word: string, guesses: number): void {
    const list = room.match.highlights[playerId] ?? [];
    list.push({ word, guesses });
    list.sort((a, b) => a.guesses - b.guesses);
    room.match.highlights[playerId] = list.slice(0, 3);
  }

  private endRound(room: RoomInternal, result: RoundResult, winner: PlayerInternal | null): void {
    const round = room.round;
    if (!round || round.status !== "playing") return;
    round.status = "ended";
    round.result = result;
    round.endedAt = Date.now();
    round.winnerId = winner?.id ?? null;
    round.winnerName = winner?.name ?? null;
    if (round.timer) {
      clearTimeout(round.timer);
      round.timer = null;
    }
    this.recordRoundStats(room, round);
    const setConcluded = Boolean(round.setWinnerId || round.setWinnerTeam);
    room.recentRounds.push({
      index: round.index,
      answer: round.answer,
      explanation: explanationFor(this.data, round.answer),
      result: round.result,
      winnerId: round.winnerId,
      winnerName: round.winnerName,
      awardedTo: [...round.awardedTo],
      awardedTeam: round.awardedTeam,
      setWinnerId: round.setWinnerId,
      setWinnerTeam: round.setWinnerTeam,
      endedAt: round.endedAt,
    });
    if (room.recentRounds.length > 5) room.recentRounds.splice(0, room.recentRounds.length - 5);
    if (round.result === "solved" && winner) {
      const guesses = round.rows.filter((row) => row.playerId === winner.id).length;
      this.recordHighlight(room, winner.id, round.answer, Math.max(1, guesses));
    }
    if (room.mode !== "practice") {
      for (const player of room.players) {
        if (!player.isGuest) this.store.recordRecentIdiom(player.id, round.answer);
      }
    }
    room.status = "roundEnd";
    this.touch(room);
    this.pushState(room);
    this.broadcastRoomList();
    if (round.awardedTo.length > 0) {
      const names = round.awardedTo.map((id) => this.playerFor(room, id)?.name ?? "玩家");
      this.sendToRoom(room, {
        type: "toast",
        message:
          room.mode === "team2v2"
            ? `第 6 行仍未猜中：${round.awardedTeam} 队 +1 分`
            : `第 6 行仍未猜中：${names.join("、")} +1 分`,
      });
    } else if (setConcluded) {
      const setName = round.setWinnerId
        ? this.playerFor(room, round.setWinnerId)?.name ?? ""
        : `${round.setWinnerTeam} 队`;
      this.sendToRoom(room, { type: "toast", message: `${setName} 赢下第 ${room.match.setNumber} 小局` });
    }
    const delay = setConcluded ? this.config.setEndDelayMs : this.config.roundEndMs;
    room.roundEndTimer = setTimeout(() => {
      room.roundEndTimer = null;
      if (!this.rooms.has(room.code) || room.status !== "roundEnd") return;
      this.advanceAfterRound(room);
    }, delay);
    room.roundEndTimer.unref?.();
  }

  private advanceAfterRound(room: RoomInternal): void {
    const round = room.round;
    if (room.mode === "practice") {
      // One board = one practice "match"; solve or 6 rows ends it.
      this.endMatch(room);
      return;
    }
    if (!round) {
      this.beginRound(room);
      return;
    }
    const setKey = round.setWinnerId ?? round.setWinnerTeam;
    if (setKey) {
      if ((room.match.setWins[setKey] ?? 0) >= room.match.setsToWin) {
        this.endMatch(room);
        return;
      }
      this.beginNextSet(room);
      return;
    }
    if (room.mode === "ffa3" && room.players.some((player) => player.score >= room.rules.pointsToWin)) {
      this.endMatch(room);
      return;
    }
    this.beginRound(room);
  }

  private decideWinner(room: RoomInternal): MatchDecision {
    if (room.mode === "practice") return this.drawDecision();
    if (room.mode === "duel") {
      if (room.players.length === 0) return this.drawDecision();
      const matchWinnerId = duelMatchWinner(room.match.setWins, room.match.setsToWin);
      const candidateId = matchWinnerId ?? duelSetWinsLeader(room.match.setWins).leaderId;
      const winner = candidateId ? this.playerFor(room, candidateId) : null;
      if (!winner) return this.drawDecision();
      return {
        winnerId: winner.id,
        winnerName: winner.name,
        winnerTeam: null,
        isDraw: false,
        forfeitById: null,
        forfeitTeam: null,
      };
    }
    if (room.mode === "team2v2") {
      const a = room.match.setWins.A ?? 0;
      const b = room.match.setWins.B ?? 0;
      if (a === b) return this.drawDecision();
      return {
        winnerId: null,
        winnerName: null,
        winnerTeam: a > b ? "A" : "B",
        isDraw: false,
        forfeitById: null,
        forfeitTeam: null,
      };
    }
    if (room.players.length === 0) return this.drawDecision();
    const best = Math.max(...room.players.map((player) => player.score));
    const leaders = room.players.filter((player) => player.score === best);
    if (leaders.length !== 1) return this.drawDecision();
    return {
      winnerId: leaders[0].id,
      winnerName: leaders[0].name,
      winnerTeam: null,
      isDraw: false,
      forfeitById: null,
      forfeitTeam: null,
    };
  }

  private drawDecision(): MatchDecision {
    return {
      winnerId: null,
      winnerName: null,
      winnerTeam: null,
      isDraw: true,
      forfeitById: null,
      forfeitTeam: null,
    };
  }

  private endMatch(room: RoomInternal, override?: MatchDecision): void {
    if (room.matchRecorded) return;
    room.matchRecorded = true;
    room.drawOffer = null;
    room.match.ratingDeltas = {};
    this.clearRoundTimers(room);
    // No more seat-reservation forfeits after the match is over.
    for (const timer of room.rejoinTimers.values()) clearTimeout(timer);
    room.rejoinTimers.clear();
    room.status = "matchEnd";
    room.countdownEndsAt = null;
    const decision = override ?? this.decideWinner(room);
    room.match.winnerId = decision.winnerId;
    room.match.winnerName = decision.winnerName;
    room.match.winnerTeam = decision.winnerTeam;
    room.match.isDraw = decision.isDraw;
    room.match.forfeitById = decision.forfeitById;
    room.match.forfeitTeam = decision.forfeitTeam;
    // A forfeited best-of-1 can end before any set was completed: show 1:0 for
    // the winner so the result page and match history do not display 0:0.
    const setBased = room.mode === "duel" || room.mode === "team2v2";
    if (setBased && decision.forfeitById && !decision.isDraw) {
      const totalSets = Object.values(room.match.setWins).reduce((sum, wins) => sum + (wins ?? 0), 0);
      if (totalSets === 0) {
        if (room.mode === "duel" && decision.winnerId) {
          room.match.setWins[decision.winnerId] = 1;
        } else if (room.mode === "team2v2" && decision.winnerTeam) {
          room.match.setWins[decision.winnerTeam] = 1;
        }
      }
    }
    this.touch(room);

    this.finalizeStats(room, decision);
    if (room.mode === "practice") {
      // Practice: no ladder, no match history entry, just persisted practice stats.
      this.store.save();
      this.pushState(room);
      this.sendToRoom(room, { type: "toast", message: "练习结束" });
      return;
    }
    const ratingRows = this.settleRatings(room, decision);
    if (ratingRows) {
      for (const [playerId, change] of ratingRows) {
        room.match.ratingDeltas[playerId] = change.delta;
      }
    }
    const summary = this.buildMatchSummary(room, decision, ratingRows);
    this.store.addMatch(summary);

    this.pushState(room);
    this.broadcastRoomList();
    const message = decision.isDraw
      ? "比赛结束：平局"
      : room.mode === "team2v2"
        ? `比赛结束：${decision.winnerTeam} 队获胜`
        : decision.forfeitById
          ? `比赛结束：${decision.winnerName ?? "对手"} 因对方离开获胜`
          : `比赛结束：${decision.winnerName} 获胜`;
    this.sendToRoom(room, { type: "toast", message });
  }

  private settleRatings(room: RoomInternal, decision: MatchDecision): Map<string, RatingChange> | null {
    // Practice never touches the ladder.
    if (room.mode === "practice") return null;
    const allRegistered = room.players.length > 0 && room.players.every((player) => !player.isGuest);
    if (!allRegistered) return null;
    const participants = room.players.map((player) => ({
      userId: player.id,
      rating: this.store.getRating(room.mode, player.id).rating,
      score: room.mode === "team2v2" ? (player.team ? room.teamScores[player.team] : 0) : player.score,
      team: player.team,
    }));
    const changes = applyRatings(room.mode, participants, {
      winnerId: decision.winnerId,
      winnerTeam: decision.winnerTeam,
      isDraw: decision.isDraw,
    });
    const map = new Map<string, RatingChange>();
    for (const change of changes) {
      this.store.applyRating(
        room.mode,
        change.userId,
        change.before,
        change.after,
        change.delta,
        change.result,
      );
      map.set(change.userId, change);
    }
    return map;
  }

  private buildMatchSummary(
    room: RoomInternal,
    decision: MatchDecision,
    ratingRows: Map<string, RatingChange> | null,
  ): MatchSummary {
    const players: MatchPlayerSummary[] = room.players.map((player) => {
      const row: MatchPlayerSummary = {
        id: player.id,
        name: player.name,
        avatar: player.avatar,
        team: player.team,
        score: player.score,
        setWins:
          room.mode === "team2v2"
            ? player.team
              ? room.match.setWins[player.team] ?? 0
              : 0
            : room.match.setWins[player.id] ?? 0,
      };
      const change = ratingRows?.get(player.id);
      if (change) {
        row.ratingBefore = change.before;
        row.ratingAfter = change.after;
        row.ratingDelta = change.delta;
      }
      return row;
    });
    return {
      id: createMatchId(),
      mode: room.mode,
      endedAt: Date.now(),
      winnerName: decision.isDraw ? "平局" : decision.winnerName ?? `${decision.winnerTeam ?? ""} 队`,
      winnerId: decision.winnerId,
      winnerTeam: decision.winnerTeam,
      isDraw: decision.isDraw,
      forfeitById: decision.forfeitById,
      forfeitTeam: decision.forfeitTeam,
      rounds: room.match.roundNumber,
      rules: { ...room.rules },
      setHistory: room.match.setHistory.map((entry) => ({
        ...entry,
        scores: { ...entry.scores },
        teamScores: { ...entry.teamScores },
      })),
      highlights: Object.fromEntries(
        Object.entries(room.match.highlights ?? {}).map(([playerId, list]) => [
          playerId,
          list.map((highlight) => ({ ...highlight })),
        ]),
      ),
      players,
    };
  }

  // ------------------------------------------------------------------
  // internals: removal / teardown
  // ------------------------------------------------------------------

  private removePlayer(room: RoomInternal, userId: string, reason: string): void {
    const index = room.players.findIndex((player) => player.id === userId);
    if (index < 0) return;
    room.players.splice(index, 1);
    this.userRoom.delete(userId);
    this.notifyPresence(userId);
    const timer = room.rejoinTimers.get(userId);
    if (timer) {
      clearTimeout(timer);
      room.rejoinTimers.delete(userId);
    }
    if (room.hostId === userId) this.transferHost(room, userId);
    this.touch(room);

    if (room.players.length === 0) {
      this.destroyRoom(room, reason === "主动离开" ? "房间已解散" : "玩家全部离开，房间已解散");
      return;
    }
    if (room.status === "countdown" && !this.canStillStart(room)) {
      if (room.countdownTimer) {
        clearTimeout(room.countdownTimer);
        room.countdownTimer = null;
      }
      room.status = "waiting";
      room.countdownEndsAt = null;
      for (const player of room.players) player.ready = player.isHost;
    }
    this.syncSetWins(room);
    this.pushState(room);
    this.broadcastRoomList();
  }

  private canStillStart(room: RoomInternal): boolean {
    if (room.mode === "duel") return room.players.length === 2;
    if (room.mode === "ffa3") return room.players.length === 3;
    return (
      room.players.some((player) => player.team === "A") &&
      room.players.some((player) => player.team === "B")
    );
  }

  private destroyRoom(room: RoomInternal, message: string | null): void {
    if (!this.rooms.has(room.code)) return;
    room.drawOffer = null;
    this.clearRoomTimers(room);
    this.rooms.delete(room.code);
    for (const player of room.players) {
      this.userRoom.delete(player.id);
      if (message) this.send(player.id, { type: "toast", message });
      this.send(player.id, { type: "rooms", rooms: this.getPublicRooms() });
      this.notifyPresence(player.id);
    }
    for (const spectator of room.spectators) {
      this.spectating.delete(spectator.id);
      if (message) this.send(spectator.id, { type: "toast", message });
      this.send(spectator.id, { type: "rooms", rooms: this.getPublicRooms() });
      this.notifyPresence(spectator.id);
    }
    room.players = [];
    room.spectators = [];
    this.broadcastRoomList();
  }

  private leaveSpectate(userId: string): void {
    const code = this.spectating.get(userId);
    if (!code) return;
    this.spectating.delete(userId);
    const room = this.rooms.get(code);
    if (!room) {
      this.notifyPresence(userId);
      return;
    }
    room.spectators = room.spectators.filter((spectator) => spectator.id !== userId);
    this.pushState(room);
    this.broadcastRoomList();
    this.notifyPresence(userId);
  }

  private notifyPresence(userId: string): void {
    if (!this.onPresenceChanged) return;
    try {
      this.onPresenceChanged(userId);
    } catch {
      /* ignore cleanup errors */
    }
  }

  private clearRoundTimers(room: RoomInternal): void {
    if (room.roundEndTimer) {
      clearTimeout(room.roundEndTimer);
      room.roundEndTimer = null;
    }
    if (room.round?.timer) {
      clearTimeout(room.round.timer);
      room.round.timer = null;
    }
  }

  private clearRoomTimers(room: RoomInternal): void {
    this.clearRoundTimers(room);
    if (room.countdownTimer) {
      clearTimeout(room.countdownTimer);
      room.countdownTimer = null;
    }
    for (const timer of room.rejoinTimers.values()) clearTimeout(timer);
    room.rejoinTimers.clear();
  }

  private sweepIdleRooms(): void {
    const now = Date.now();
    for (const room of [...this.rooms.values()]) {
      if (now - room.lastActivity >= this.config.roomIdleMs) {
        this.destroyRoom(room, "房间长时间无活动，已自动解散");
      }
    }
  }

  // ------------------------------------------------------------------
  // internals: queue
  // ------------------------------------------------------------------

  private removeFromQueue(userId: string, notify: boolean): void {
    for (const mode of Object.keys(this.queues) as Mode[]) {
      const queue = this.queues[mode];
      const index = queue.indexOf(userId);
      if (index >= 0) {
        queue.splice(index, 1);
        this.notifyPresence(userId);
        if (notify) {
          this.send(userId, { type: "queue", state: null });
          this.notifyQueue(mode);
        }
      }
    }
  }

  private notifyQueue(mode: Mode): void {
    const queue = this.queues[mode];
    const needed = modeCapacity(mode);
    queue.forEach((userId, index) => {
      this.send(userId, {
        type: "queue",
        state: { mode, size: queue.length, needed, position: index + 1 },
      });
    });
  }

  private startQueueMatch(mode: Mode, userIds: string[]): void {
    const users: PublicUser[] = [];
    const missing: string[] = [];
    for (const userId of userIds) {
      const user = this.store.getUserById(userId);
      if (user) users.push(this.store.toPublicUser(user));
      else missing.push(userId);
    }
    if (users.length < modeCapacity(mode)) {
      this.queues[mode].unshift(...missing.filter((id) => this.store.getUserById(id)));
      this.queues[mode].unshift(...users.map((user) => user.id));
      this.notifyQueue(mode);
      return;
    }
    // Quick match is best-of-1 free guessing on the common dictionary and
    // requires the players to agree on the rules before the host starts.
    const rules: RoomRules = {
      bestOf: 1,
      guessMode: "free",
      dictionary: "common",
      pointsToWin: 11,
    };
    const room = this.newRoom(mode, "public", users, true, rules, true);
    for (const player of room.players) {
      this.send(player.id, { type: "match.found", code: room.code });
    }
    this.sendToRoom(room, { type: "toast", message: "匹配成功，请先协商规则再开始" });
    this.pushState(room);
    this.broadcastRoomList();
  }

  // ------------------------------------------------------------------
  // internals: state serialization
  // ------------------------------------------------------------------

  private buildRoundState(room: RoomInternal): RoundState {
    const round = room.round;
    if (!round) {
      return {
        index: room.match.roundNumber,
        status: "idle",
        rows: [],
        maxRows: this.config.rowsPerRound,
        remainingRows: this.config.rowsPerRound,
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
    const ended = round.status === "ended";
    return {
      index: round.index,
      status: round.status,
      rows: round.rows.map((row) => ({
        ...row,
        tiles: row.tiles.map((tile) => ({ ...tile, paths: tile.paths.map((path) => ({ ...path })) })),
      })),
      maxRows: this.config.rowsPerRound,
      remainingRows: Math.max(0, this.config.rowsPerRound - round.rows.length),
      startedAt: round.startedAt,
      endsAt: round.endsAt,
      endedAt: round.endedAt,
      result: round.result,
      winnerId: round.winnerId,
      winnerName: round.winnerName,
      awardedTo: [...round.awardedTo],
      awardedTeam: round.awardedTeam,
      setWinnerId: round.setWinnerId,
      setWinnerTeam: round.setWinnerTeam,
      // The answer is only ever exposed after the round ended.
      answer: ended ? round.answer : null,
    };
  }

  private buildState(room: RoomInternal, viewerId: string, viewerRole: "player" | "spectator"): RoomState {
    this.syncSetWins(room);
    const viewer = this.playerFor(room, viewerId);
    const chat = room.chat.filter((message) => {
      if (message.scope === "room") return true;
      if (!viewer || !viewer.team) return false;
      const sender = this.playerFor(room, message.userId);
      return Boolean(sender && sender.team === viewer.team);
    });
    const players: RoomPlayer[] = room.players.map((player) => ({
      id: player.id,
      name: player.name,
      avatar: player.avatar,
      team: player.team,
      score: player.score,
      ready: player.ready,
      connected: player.connected,
      isGuest: player.isGuest,
      isHost: player.id === room.hostId,
      guesses: player.guesses,
      rejoinDeadline: player.rejoinDeadline,
    }));
    return {
      id: room.id,
      code: room.code,
      mode: room.mode,
      visibility: room.visibility,
      rules: { ...room.rules },
      requiresAgreement: room.requiresAgreement,
      rulesAgreed: room.rulesAgreed,
      proposal: room.proposal
        ? { ...room.proposal, rules: { ...room.proposal.rules } }
        : null,
      drawOffer: room.drawOffer
        ? {
            proposerId: room.drawOffer.proposerId,
            proposerName: room.drawOffer.proposerName,
            acceptedBy: [...room.drawOffer.acceptedBy],
            createdAt: room.drawOffer.createdAt,
          }
        : null,
      guessMode: room.rules.guessMode,
      status: room.status,
      hostId: room.hostId,
      players,
      spectators: room.spectators.map((spectator) => ({ ...spectator })),
      teamScores: { A: room.teamScores.A, B: room.teamScores.B },
      round: this.buildRoundState(room),
      recentRounds: room.recentRounds.map((entry) => ({
        ...entry,
        awardedTo: [...entry.awardedTo],
      })),
      match: {
        ...room.match,
        setWins: { ...room.match.setWins },
        ratingDeltas: { ...(room.match.ratingDeltas ?? {}) },
        setHistory: room.match.setHistory.map((entry) => ({
          ...entry,
          scores: { ...entry.scores },
          teamScores: { ...entry.teamScores },
        })),
        highlights: Object.fromEntries(
          Object.entries(room.match.highlights ?? {}).map(([playerId, list]) => [
            playerId,
            list.map((highlight) => ({ ...highlight })),
          ]),
        ),
      },
      chat: chat.map((message) => ({ ...message })),
      viewerRole,
      viewerId,
      countdownEndsAt: room.countdownEndsAt,
      createdAt: room.createdAt,
      serverTime: Date.now(),
    };
  }

  private sendStateTo(room: RoomInternal, userId: string, role: "player" | "spectator"): void {
    this.send(userId, { type: "state", state: this.buildState(room, userId, role) });
  }

  private pushState(room: RoomInternal): void {
    if (!this.rooms.has(room.code)) return;
    for (const player of room.players) this.sendStateTo(room, player.id, "player");
    for (const spectator of room.spectators) this.sendStateTo(room, spectator.id, "spectator");
  }

  private sendToRoom(room: RoomInternal, message: ServerMessage): void {
    for (const player of room.players) this.send(player.id, message);
    for (const spectator of room.spectators) this.send(spectator.id, message);
  }
}
