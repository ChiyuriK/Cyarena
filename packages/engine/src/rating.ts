import type { Mode, Team } from "../../shared/src/index.ts";
import { MODE_META } from "../../shared/src/index.ts";

export const INITIAL_RATING = 1200;
export const DUEL_K = 32;
export const FFA_K = 24;
export const TEAM_K = 32;

/** One row of persisted per-mode ladder data. */
export interface RatingEntry {
  rating: number;
  games: number;
  wins: number;
  losses: number;
  draws: number;
}

export function createRatingEntry(rating = INITIAL_RATING): RatingEntry {
  return { rating, games: 0, wins: 0, losses: 0, draws: 0 };
}

/** Standard Elo expectation for player A against B. */
export function expectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
}

export interface RatingParticipant {
  userId: string;
  rating: number;
  score: number;
  team?: Team | null;
}

export interface MatchOutcome {
  winnerId?: string | null;
  winnerTeam?: Team | null;
  isDraw: boolean;
}

export interface RatingChange {
  userId: string;
  before: number;
  after: number;
  delta: number;
  /** 1 = win, 0.5 = draw, 0 = loss (team modes use the team result). */
  result: 0 | 0.5 | 1;
}

function change(userId: string, before: number, delta: number, result: 0 | 0.5 | 1): RatingChange {
  const rounded = Math.round(delta);
  const normalized = rounded === 0 ? 0 : rounded;
  return { userId, before, after: before + normalized, delta: normalized, result };
}

/** 1v1 standard Elo with K=32. */
export function duelRatings(a: RatingParticipant, b: RatingParticipant, outcome: MatchOutcome): RatingChange[] {
  const expectedA = expectedScore(a.rating, b.rating);
  const scoreA: 0 | 0.5 | 1 = outcome.isDraw ? 0.5 : outcome.winnerId === a.userId ? 1 : 0;
  const deltaA = Math.round(DUEL_K * (scoreA - expectedA));
  return [change(a.userId, a.rating, deltaA, scoreA), change(b.userId, b.rating, -deltaA, scoreA === 1 ? 0 : scoreA === 0 ? 1 : 0.5)];
}

/**
 * Free-for-all Elo: every pair is compared once (K=24). Participants must be
 * ordered from best to worst; equal scores count as a 0.5 pairwise result.
 */
export function ffaRatings(players: RatingParticipant[]): RatingChange[] {
  const totals = new Map<string, number>();
  for (const player of players) totals.set(player.userId, 0);
  for (let i = 0; i < players.length; i += 1) {
    for (let j = i + 1; j < players.length; j += 1) {
      const high = players[i];
      const low = players[j];
      const expectedHigh = expectedScore(high.rating, low.rating);
      const actualHigh: 0 | 0.5 | 1 = high.score > low.score ? 1 : high.score === low.score ? 0.5 : 0;
      totals.set(high.userId, (totals.get(high.userId) ?? 0) + FFA_K * (actualHigh - expectedHigh));
      totals.set(low.userId, (totals.get(low.userId) ?? 0) - FFA_K * (actualHigh - expectedHigh));
    }
  }
  const bestScore = Math.max(...players.map((player) => player.score));
  const leaders = players.filter((player) => player.score === bestScore);
  return players.map((player) => {
    const result: 0 | 0.5 | 1 = player.score !== bestScore ? 0 : leaders.length === 1 ? 1 : 0.5;
    return change(player.userId, player.rating, totals.get(player.userId) ?? 0, result);
  });
}

function averageRating(team: RatingParticipant[]): number {
  if (team.length === 0) return INITIAL_RATING;
  return team.reduce((sum, player) => sum + player.rating, 0) / team.length;
}

/** 2v2 team Elo: team average is used for the expectation, K=32, every member gets the team delta. */
export function team2v2Ratings(
  teamA: RatingParticipant[],
  teamB: RatingParticipant[],
  outcome: MatchOutcome,
): RatingChange[] {
  const averageA = averageRating(teamA);
  const averageB = averageRating(teamB);
  const expectedA = expectedScore(averageA, averageB);
  const scoreA: 0 | 0.5 | 1 = outcome.isDraw ? 0.5 : outcome.winnerTeam === "A" ? 1 : 0;
  const delta = Math.round(TEAM_K * (scoreA - expectedA));
  const changes: RatingChange[] = [];
  for (const player of teamA) changes.push(change(player.userId, player.rating, delta, scoreA));
  for (const player of teamB) changes.push(change(player.userId, player.rating, -delta, scoreA === 1 ? 0 : scoreA === 0 ? 1 : 0.5));
  return changes;
}

/** Sort free-for-all participants best-first (by score, stable for ties). */
export function rankParticipants(participants: RatingParticipant[]): RatingParticipant[] {
  return [...participants].sort((a, b) => b.score - a.score);
}

/**
 * Pure rating settlement for one finished match. Returns one change per
 * participant; only pass registered participants (guests are never settled).
 */
export function applyRatings(mode: Mode, participants: RatingParticipant[], outcome: MatchOutcome): RatingChange[] {
  if (participants.length === 0) return [];
  if (MODE_META[mode].teams) {
    const teamA = participants.filter((player) => player.team === "A");
    const teamB = participants.filter((player) => player.team === "B");
    return team2v2Ratings(teamA, teamB, outcome);
  }
  if (mode === "duel") {
    const [a, b] = participants;
    if (!a || !b) return [];
    return duelRatings(a, b, outcome);
  }
  return ffaRatings(rankParticipants(participants));
}

/** Update a persisted rating entry with one change (pure helper). */
export function applyRatingChange(entry: RatingEntry, changeRow: RatingChange): RatingEntry {
  return {
    rating: changeRow.after,
    games: entry.games + 1,
    wins: entry.wins + (changeRow.result === 1 ? 1 : 0),
    losses: entry.losses + (changeRow.result === 0 ? 1 : 0),
    draws: entry.draws + (changeRow.result === 0.5 ? 1 : 0),
  };
}
