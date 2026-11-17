import type { GameData } from "../../../packages/engine/src/index.ts";
import {
  buildRowFeedback,
  createRoundState,
  describeComparison,
  explanationFor,
  validateFreeGuessDetail,
} from "../../../packages/engine/src/index.ts";
import type {
  DailyColor,
  DailyLeaderboardRow,
  DailyRowView,
  DailyState,
  TileFeedback,
} from "../../../packages/shared/src/index.ts";

export const DAILY_TIME_ZONE = "Asia/Shanghai";
export const DAILY_INTRO =
  "每天 00:00 换题，题库比匹配更难；答对后按猜测次数排名，次数相同则按答对时间排序。";
export const DAILY_KEEP_DAYS = 35;
export const DAILY_LEADERBOARD_LIMIT = 50;

/** Internal persisted shape for one user's daily attempt. */
export interface DailyResultRecord {
  date: string;
  userId: string;
  guesses: string[];
  solved: boolean;
  solvedAt: number | null;
  attempts: number;
  /** When the user first opened/guessed the daily challenge. */
  startedAt: number | null;
  /** solvedAt - startedAt, persisted for leaderboard sorting. */
  durationMs: number | null;
}

/** Current date key (`YYYY-MM-DD`) in the daily time zone. */
export function dailyDateKey(date: Date = new Date(), timeZone = DAILY_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") values[part.type] = part.value;
  }
  return `${values.year}-${values.month}-${values.day}`;
}

/** ISO weekday for a date key: Monday=1 ... Sunday=7. */
export function dailyWeekday(dateKey: string): number {
  const day = new Date(`${dateKey}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

/** Move a `YYYY-MM-DD` key by a number of days. */
export function shiftDateKey(dateKey: string, days: number): string {
  const base = new Date(`${dateKey}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/**
 * Consecutive solved days up to `today`. A missing today does not reset the
 * streak yet; counting starts from yesterday in that case.
 */
export function dailyStreakDays(solvedDates: Iterable<string>, today: string): number {
  const solved = solvedDates instanceof Set ? solvedDates : new Set(solvedDates);
  let cursor = solved.has(today) ? today : shiftDateKey(today, -1);
  let days = 0;
  while (solved.has(cursor)) {
    days += 1;
    cursor = shiftDateKey(cursor, -1);
  }
  return days;
}

/** Sunday serves the common pool, Monday-Saturday the non-common pool. */
export function dailyPool(data: GameData, dateKey: string): string[] {
  if (dailyWeekday(dateKey) === 7) return data.commonPool;
  return data.answerPool.filter((word) => !data.commonSet.has(word));
}

/** FNV-1a 32-bit hash so the daily answer is deterministic across restarts. */
export function hashString(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** The single server-wide answer for one date. */
export function dailyAnswer(data: GameData, dateKey: string): string {
  const pool = dailyPool(data, dateKey);
  if (pool.length === 0) return data.answerPool[0] ?? "";
  return pool[hashString(dateKey) % pool.length];
}

function dailySummary(data: GameData, answer: string, word: string): DailyColor[] {
  const answerChars = Array.from(answer);
  const guessChars = Array.from(word);
  const colors: DailyColor[] = [];
  for (let position = 0; position < 4; position += 1) {
    const answerChar = answerChars[position] ?? "";
    const guessChar = guessChars[position] ?? "";
    if (answerChar === guessChar) {
      colors.push("green");
    } else if (describeComparison(data, answerChar, guessChar).percent >= 0.5) {
      // 至少一半笔画命中才算黄色，避免只有一笔相似就给出过强提示。
      colors.push("yellow");
    } else {
      colors.push("gray");
    }
  }
  return colors;
}

/** Replay every stored guess through the same stroke feedback engine used in matches. */
export function dailyRows(data: GameData, answer: string, guesses: string[]): DailyRowView[] {
  const feedback = createRoundState();
  const rows: DailyRowView[] = [];
  for (const word of guesses) {
    const tiles: TileFeedback[] = buildRowFeedback(data, answer, word, feedback);
    rows.push({ word, tiles, summary: dailySummary(data, answer, word) });
  }
  return rows;
}

export interface DailyLeaderboardEntry {
  userId: string;
  name: string;
  avatar: string;
  attempts: number;
  solvedAt: number;
  durationMs: number;
}

export interface DailyStateOptions {
  data: GameData;
  date: string;
  result: DailyResultRecord | null;
  leaderboard: DailyLeaderboardRow[];
  meRank: number | null;
  streakDays: number;
  user: { id: string; name: string; avatar: string } | null;
}

/** Compose the client-facing daily state without ever leaking an unsolved answer. */
export function buildDailyState(options: DailyStateOptions): DailyState {
  const { data, date, result, leaderboard, meRank, streakDays, user } = options;
  const answer = dailyAnswer(data, date);
  const solved = Boolean(result?.solved);
  const guesses = result?.guesses ?? [];
  const rows = user ? dailyRows(data, answer, guesses) : [];
  const attempts = result?.attempts ?? guesses.length;
  const durationMs = solved ? result?.durationMs ?? null : null;
  return {
    date,
    weekday: dailyWeekday(date),
    isCommonDay: dailyWeekday(date) === 7,
    intro: DAILY_INTRO,
    rows,
    solved,
    answer: solved ? answer : null,
    explanation: solved ? explanationFor(data, answer) || null : null,
    attempts,
    durationMs,
    streakDays: user ? streakDays : 0,
    me: user
      ? {
          rank: solved ? meRank : null,
          attempts,
          solvedAt: solved ? result?.solvedAt ?? null : null,
          durationMs,
        }
      : null,
    leaderboard,
  };
}

/** 每日挑战允许自由猜词：四个汉字且笔画库可渲染即可。 */
export function validateDailyGuess(data: GameData, word: string): { ok: true } | { ok: false; reason: string } {
  return validateFreeGuessDetail(data, word);
}
