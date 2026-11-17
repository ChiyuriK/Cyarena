import type { GameData } from "../../../packages/engine/src/index.ts";
import {
  buildRowFeedback,
  createRoundState,
  explanationFor,
  validateFreeGuessDetail,
  validateGuessDetail,
} from "../../../packages/engine/src/index.ts";
import type {
  StreakRowView,
  StreakState,
  StreakVariant,
} from "../../../packages/shared/src/index.ts";
import { STREAK_VARIANTS } from "../../../packages/shared/src/index.ts";
import type { Store } from "./store.ts";

export const STREAK_MAX_ROWS = 6;
/** 答对后进入下一题前的固定休息时间。 */
export const STREAK_INTERMISSION_MS = 1_000;
/** 连胜挑战断开 60 秒后结束当前挑战。 */
export const STREAK_DISCONNECT_GRACE_MS = 60_000;

export class StreakError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "StreakError";
    this.status = status;
  }
}

interface ActiveStreak {
  userId: string;
  variant: StreakVariant;
  answer: string;
  feedback: ReturnType<typeof createRoundState>;
  rows: StreakRowView[];
  streak: number;
  /** 当前题开始时间。 */
  startedAt: number;
  /** 答对后的休息截止时间。 */
  nextAt: number;
  lastSolveMs: number | null;
  /** 页面断线/关闭后 60 秒自动结束。 */
  graceTimer?: ReturnType<typeof setTimeout>;
}

export interface StreakManagerOptions {
  data: GameData;
  store: Store;
  /** Test hook shared with rooms; when present it overrides answer picking. */
  chooseAnswer?: (data: GameData) => string;
  /** Override disconnect grace for tests. */
  disconnectGraceMs?: number;
  /** Override the 1s intermission for tests. */
  intermissionMs?: number;
}

export function isStreakVariant(value: unknown): value is StreakVariant {
  return typeof value === "string" && (STREAK_VARIANTS as readonly string[]).includes(value);
}

/** Answer pool for a variant. */
export function streakPool(data: GameData, variant: StreakVariant): string[] {
  if (variant === "advanced") return data.answerPool.filter((word) => !data.commonSet.has(word));
  return data.commonPool;
}

/**
 * Personal single-player streak challenge. Active runs live in memory; only
 * best/stats are persisted, so a restart at worst loses the current run.
 */
export class StreakManager {
  private readonly data: GameData;
  private readonly store: Store;
  private readonly chooseAnswer: ((data: GameData) => string) | null;
  private readonly disconnectGraceMs: number;
  private readonly intermissionMs: number;
  private readonly active = new Map<string, ActiveStreak>();

  constructor(options: StreakManagerOptions) {
    this.data = options.data;
    this.store = options.store;
    this.chooseAnswer = options.chooseAnswer ?? null;
    this.disconnectGraceMs =
      Number.isFinite(options.disconnectGraceMs) && Number(options.disconnectGraceMs) > 0
        ? Number(options.disconnectGraceMs)
        : STREAK_DISCONNECT_GRACE_MS;
    this.intermissionMs =
      Number.isFinite(options.intermissionMs) && Number(options.intermissionMs) >= 0
        ? Number(options.intermissionMs)
        : STREAK_INTERMISSION_MS;
  }

  start(userId: string, variant: unknown): StreakState {
    if (!isStreakVariant(variant)) throw new StreakError("未知的连胜模式");
    this.store.recordStreakStart(userId);
    const active: ActiveStreak = {
      userId,
      variant,
      answer: this.pickAnswer(variant, null),
      feedback: createRoundState(),
      rows: [],
      streak: 0,
      startedAt: Date.now(),
      nextAt: 0,
      lastSolveMs: null,
    };
    this.active.set(userId, active);
    this.armGraceTimer(active);
    return this.buildState(active, "playing", "挑战开始，连着猜对越多越好！");
  }

  getState(userId: string, variant: unknown): StreakState | null {
    if (!isStreakVariant(variant)) throw new StreakError("未知的连胜模式");
    const active = this.active.get(userId);
    if (!active || active.variant !== variant) return null;
    if (active.nextAt > 0 && Date.now() >= active.nextAt) active.nextAt = 0;
    this.armGraceTimer(active);
    return this.buildState(active, "playing", "继续挑战");
  }

  guess(userId: string, rawWord: unknown): StreakState {
    const active = this.active.get(userId);
    if (!active) throw new StreakError("当前没有进行中的连胜挑战");
    if (active.nextAt > 0 && Date.now() < active.nextAt) {
      throw new StreakError("休息 1 秒后再猜");
    }
    active.nextAt = 0;
    if (typeof rawWord !== "string") throw new StreakError("猜测词必须是字符串");
    const word = rawWord.trim();
    const validation =
      active.variant === "free"
        ? validateFreeGuessDetail(this.data, word)
        : validateGuessDetail(this.data, word, "all");
    if (!validation.ok) throw new StreakError(validation.reason);
    if (active.feedback.tried.has(word)) throw new StreakError("这一题已经猜过这个成语了，换一个试试");

    const tiles = buildRowFeedback(this.data, active.answer, word, active.feedback);
    active.rows.push({ word, tiles });
    this.armGraceTimer(active);
    if (word === active.answer) {
      const solvedAt = Date.now();
      const solveMs = Math.max(1, solvedAt - active.startedAt);
      active.streak += 1;
      active.lastSolveMs = solveMs;
      this.store.recordStreakSolved(userId, solveMs);
      this.store.updateStreakBest(userId, active.variant, active.streak);
      const streak = active.streak;
      // Immediately serve the next idiom in the same run.
      active.answer = this.pickAnswer(active.variant, active.answer);
      active.feedback = createRoundState();
      active.rows = [];
      active.startedAt = Date.now() + this.intermissionMs;
      active.nextAt = active.startedAt;
      const seconds = (solveMs / 1000).toFixed(1);
      return this.buildState(
        active,
        "playing",
        `答对了，用时 ${seconds} 秒，当前连胜 ${streak} 题，休息 1 秒后继续`,
      );
    }
    if (active.rows.length >= STREAK_MAX_ROWS) {
      const state: StreakState = {
        ...this.buildState(active, "ended", `6 行未猜中，本次连胜 ${active.streak} 题`),
        answer: active.answer,
        explanation: explanationFor(this.data, active.answer) || null,
      };
      this.clearGraceTimer(active);
      this.active.delete(userId);
      return state;
    }
    return this.buildState(active, "playing", `没猜中，还剩 ${STREAK_MAX_ROWS - active.rows.length} 行`);
  }

  quit(userId: string): void {
    const active = this.active.get(userId);
    if (active) this.clearGraceTimer(active);
    this.active.delete(userId);
  }

  hasActive(userId: string): boolean {
    return this.active.has(userId);
  }

  private armGraceTimer(active: ActiveStreak): void {
    this.clearGraceTimer(active);
    active.graceTimer = setTimeout(() => {
      if (this.active.get(active.userId) !== active) return;
      this.clearGraceTimer(active);
      this.active.delete(active.userId);
    }, this.disconnectGraceMs);
    active.graceTimer.unref?.();
  }

  private clearGraceTimer(active: ActiveStreak): void {
    if (active.graceTimer) {
      clearTimeout(active.graceTimer);
      active.graceTimer = undefined;
    }
  }

  private pickAnswer(variant: StreakVariant, avoid: string | null): string {
    if (this.chooseAnswer) return this.chooseAnswer(this.data);
    const pool = streakPool(this.data, variant);
    if (pool.length === 0) return this.data.answerPool[0] ?? "";
    let word = pool[Math.floor(Math.random() * pool.length)] ?? pool[0] ?? "";
    // Avoid repeating the same idiom immediately across two boards.
    if (avoid && pool.length > 1) {
      let attempts = 0;
      while (word === avoid && attempts < 8) {
        word = pool[Math.floor(Math.random() * pool.length)] ?? pool[0] ?? "";
        attempts += 1;
      }
    }
    return word;
  }

  private buildState(
    active: ActiveStreak,
    status: "playing" | "ended",
    message: string,
  ): StreakState {
    const best = this.store.getStreakBest(active.userId)[active.variant];
    const stats = this.store.getStreakStats(active.userId);
    return {
      variant: active.variant,
      status,
      rows: active.rows.map((row) => ({
        word: row.word,
        tiles: row.tiles.map((tile) => ({
          ...tile,
          paths: tile.paths.map((path) => ({ ...path })),
        })),
      })),
      maxRows: STREAK_MAX_ROWS,
      remainingRows: Math.max(0, STREAK_MAX_ROWS - active.rows.length),
      streak: active.streak,
      best,
      startedAt: active.startedAt,
      nextAt: active.nextAt,
      lastSolveMs: active.lastSolveMs,
      averageSolveMs: stats.solved > 0 ? stats.totalSolveMs / stats.solved : 0,
      fastestSolveMs: stats.fastestSolveMs,
      answer: null,
      explanation: null,
      message,
    };
  }
}
