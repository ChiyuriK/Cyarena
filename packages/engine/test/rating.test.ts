import test from "node:test";
import assert from "node:assert/strict";
import {
  applyRatingChange,
  applyRatings,
  createRatingEntry,
  DUEL_K,
  expectedScore,
  FFA_K,
  ffaRatings,
  INITIAL_RATING,
  team2v2Ratings,
  TEAM_K,
} from "../src/index.ts";
import type { RatingParticipant } from "../src/index.ts";

const player = (userId: string, rating = INITIAL_RATING, score = 0, team: RatingParticipant["team"] = null): RatingParticipant => ({
  userId,
  rating,
  score,
  team,
});

test("expectedScore is symmetric around equal ratings", () => {
  assert.equal(expectedScore(1200, 1200), 0.5);
  assert.ok(expectedScore(1400, 1200) > 0.5);
  assert.ok(expectedScore(1200, 1400) < 0.5);
  assert.ok(Math.abs(expectedScore(1400, 1200) + expectedScore(1200, 1400) - 1) < 1e-12);
});

test("duel Elo uses K=32, zero sum, draws give no change", () => {
  const win = applyRatings("duel", [player("a", 1200), player("b", 1200)], { winnerId: "a", isDraw: false });
  assert.equal(win.length, 2);
  assert.deepEqual(
    win.map((row) => row.delta),
    [DUEL_K / 2, -DUEL_K / 2],
  );
  assert.deepEqual(
    win.map((row) => row.after),
    [1216, 1184],
  );
  assert.equal(win[0].result, 1);
  assert.equal(win[1].result, 0);

  const draw = applyRatings("duel", [player("a", 1200), player("b", 1200)], { winnerId: null, isDraw: true });
  assert.deepEqual(
    draw.map((row) => row.delta),
    [0, 0],
  );
  assert.equal(draw[0].result, 0.5);
});

test("duel Elo rewards an upset more than a favourite win", () => {
  const underdog = applyRatings("duel", [player("a", 1000), player("b", 1400)], { winnerId: "a", isDraw: false });
  const favourite = applyRatings("duel", [player("a", 1400), player("b", 1000)], { winnerId: "a", isDraw: false });
  assert.ok(underdog[0].delta > favourite[0].delta);
  assert.equal(underdog[0].delta, -underdog[1].delta);
});

test("ffa Elo compares every pair with K=24", () => {
  const rows = applyRatings(
    "ffa3",
    [player("a", 1200, 3), player("b", 1200, 2), player("c", 1200, 1)],
    { winnerId: "a", isDraw: false },
  );
  const delta = Object.fromEntries(rows.map((row) => [row.userId, row.delta]));
  assert.equal(delta.a, FFA_K);
  assert.equal(delta.b, 0);
  assert.equal(delta.c, -FFA_K);
  assert.deepEqual(
    rows.map((row) => row.result),
    [1, 0, 0],
  );
});

test("ffa Elo splits a tie between the leaders", () => {
  const rows = ffaRatings([player("a", 1200, 2), player("b", 1200, 2), player("c", 1200, 1)]);
  const delta = Object.fromEntries(rows.map((row) => [row.userId, row.delta]));
  assert.equal(delta.a, 12);
  assert.equal(delta.b, 12);
  assert.equal(delta.c, -24);
  assert.equal(rows[0].result, 0.5);
  assert.equal(rows[1].result, 0.5);
  assert.equal(rows[2].result, 0);
});

test("ffa Elo never moves the total rating pool", () => {
  const rows = ffaRatings([
    player("a", 1500, 3),
    player("b", 1100, 2),
    player("c", 1250, 1),
  ]);
  const total = rows.reduce((sum, row) => sum + row.delta, 0);
  assert.ok(Math.abs(total) <= 1, `total delta ${total}`);
});

test("team2v2 Elo uses the team average with K=32 for every member", () => {
  const rows = applyRatings(
    "team2v2",
    [player("a", 1200, 3, "A"), player("b", 1200, 3, "A"), player("c", 1200, 1, "B"), player("d", 1200, 1, "B")],
    { winnerTeam: "A", isDraw: false },
  );
  assert.deepEqual(
    rows.map((row) => [row.userId, row.delta]),
    [
      ["a", TEAM_K / 2],
      ["b", TEAM_K / 2],
      ["c", -TEAM_K / 2],
      ["d", -TEAM_K / 2],
    ],
  );
  const team = team2v2Ratings(
    [player("a", 1400, 3, "A"), player("b", 1400, 3, "A")],
    [player("c", 1200, 1, "B"), player("d", 1200, 1, "B")],
    { winnerTeam: "B", isDraw: false },
  );
  const deltaA = team.find((row) => row.userId === "a")!.delta;
  const deltaB = team.find((row) => row.userId === "c")!.delta;
  assert.equal(deltaA, -deltaB);
  assert.ok(deltaB > 0, "upset should reward B");
});

test("applyRatingChange updates persisted counters", () => {
  const entry = createRatingEntry(1200);
  const afterWin = applyRatingChange(entry, { userId: "a", before: 1200, after: 1216, delta: 16, result: 1 });
  assert.deepEqual(afterWin, { rating: 1216, games: 1, wins: 1, losses: 0, draws: 0 });
  const afterDraw = applyRatingChange(afterWin, { userId: "a", before: 1216, after: 1216, delta: 0, result: 0.5 });
  assert.deepEqual(afterDraw, { rating: 1216, games: 2, wins: 1, losses: 0, draws: 1 });
  const afterLoss = applyRatingChange(afterDraw, { userId: "a", before: 1216, after: 1200, delta: -16, result: 0 });
  assert.deepEqual(afterLoss, { rating: 1200, games: 3, wins: 1, losses: 1, draws: 1 });
});
