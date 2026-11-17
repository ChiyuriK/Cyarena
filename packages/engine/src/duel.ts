import type { DuelBestOf } from "../../shared/src/index.ts";
import { DUEL_DEFAULT_BEST_OF, DUEL_POINT_LEAD, DUEL_POINTS_TO_WIN, isDuelBestOf, setsToWinForBestOf } from "../../shared/src/index.ts";

export interface DuelScoreRow {
  playerId: string;
  score: number;
}

/**
 * Winner of one 1v1 set (小局): reach `pointsToWin` and lead by `pointLead`.
 * A 10:10 set keeps going until somebody leads by two (e.g. 12:10).
 *
 * Pure helper shared by the server room state machine and the engine tests.
 */
export function duelSetWinner(
  scores: DuelScoreRow[],
  pointsToWin = DUEL_POINTS_TO_WIN,
  pointLead = DUEL_POINT_LEAD,
): string | null {
  if (scores.length === 0) return null;
  const sorted = [...scores].sort((a, b) => b.score - a.score);
  const top = sorted[0];
  const runnerUp = sorted[1]?.score ?? 0;
  if (top.score < pointsToWin) return null;
  if (top.score - runnerUp < pointLead) return null;
  return top.playerId;
}

/**
 * Winner of a best-of series: the first side that reaches `setsToWin` sets.
 * Returns null while the series is still running.
 */
export function duelMatchWinner(setWins: Record<string, number>, setsToWin: number): string | null {
  if (setsToWin <= 0) return null;
  for (const [playerId, wins] of Object.entries(setWins)) {
    if (wins >= setsToWin) return playerId;
  }
  return null;
}

export interface DuelSetsLeader {
  leaderId: string | null;
  leaderWins: number;
  tied: boolean;
}

/** Current big-score leader, used when a match has to be decided without a clean series winner. */
export function duelSetWinsLeader(setWins: Record<string, number>): DuelSetsLeader {
  const entries = Object.entries(setWins);
  if (entries.length === 0) return { leaderId: null, leaderWins: 0, tied: true };
  const max = Math.max(...entries.map(([, wins]) => wins));
  const leaders = entries.filter(([, wins]) => wins === max);
  return {
    leaderId: leaders.length === 1 ? leaders[0][0] : null,
    leaderWins: max,
    tied: leaders.length !== 1,
  };
}

/** Normalise a `room.create` best-of value: duel only, 1/3/5/7, defaults to 3. */
export function normalizeBestOf(mode: string, rawBestOf: unknown, fallback: number = DUEL_DEFAULT_BEST_OF): number {
  if (mode !== "duel") return 1;
  if (rawBestOf === undefined || rawBestOf === null) return fallback;
  if (!isDuelBestOf(rawBestOf)) {
    throw new DuelBestOfError("大比分只能是 1、3、5 或 7 局");
  }
  return rawBestOf;
}

export class DuelBestOfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DuelBestOfError";
  }
}

/** Sets required to win a series (1v1). */
export function duelSetsToWin(bestOf: DuelBestOf | number): number {
  return setsToWinForBestOf(bestOf);
}
