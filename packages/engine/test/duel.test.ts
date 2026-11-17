import test from "node:test";
import assert from "node:assert/strict";
import {
  DUEL_BEST_OF_OPTIONS,
  DUEL_DEFAULT_BEST_OF,
  DUEL_POINT_LEAD,
  DUEL_POINTS_TO_WIN,
  setsToWinForBestOf,
} from "../../shared/src/index.ts";
import {
  duelMatchWinner,
  duelSetWinner,
  duelSetWinsLeader,
  duelSetsToWin,
  normalizeBestOf,
} from "../src/index.ts";

const rows = (a: number, b: number) => [
  { playerId: "a", score: a },
  { playerId: "b", score: b },
];

test("duel shared constants: 11 points / lead 2 / best-of 1,3,5,7", () => {
  assert.equal(DUEL_POINTS_TO_WIN, 11);
  assert.equal(DUEL_POINT_LEAD, 2);
  assert.equal(DUEL_DEFAULT_BEST_OF, 3);
  assert.deepEqual([...DUEL_BEST_OF_OPTIONS], [1, 3, 5, 7]);
  assert.deepEqual(
    [1, 3, 5, 7].map((bestOf) => setsToWinForBestOf(bestOf)),
    [1, 2, 3, 4],
  );
  assert.deepEqual([1, 3, 5, 7].map((bestOf) => duelSetsToWin(bestOf)), [1, 2, 3, 4]);
});

test("duelSetWinner: 11 point set needs a two point lead", () => {
  assert.equal(duelSetWinner(rows(10, 8)), null, "10 points is not enough");
  assert.equal(duelSetWinner(rows(11, 9)), "a", "11:9 is a two point lead");
  assert.equal(duelSetWinner(rows(11, 10)), null, "11:10 only leads by one");
  assert.equal(duelSetWinner(rows(12, 10)), "a", "12:10 after a deuce");
  assert.equal(duelSetWinner(rows(13, 11)), "a");
  assert.equal(duelSetWinner(rows(11, 10)), null);
  assert.equal(duelSetWinner(rows(10, 10)), null);
  assert.equal(duelSetWinner(rows(0, 0)), null);
  assert.equal(duelSetWinner(rows(9, 11)), "b");
});

test("duelSetWinner: accelerated test config (3 points / lead 2) covers 3:1, 3:3 and 5:3", () => {
  assert.equal(duelSetWinner(rows(2, 0), 3, 2), null, "2:0 has not reached the target");
  assert.equal(duelSetWinner(rows(3, 1), 3, 2), "a", "3:1 wins the set");
  assert.equal(duelSetWinner(rows(3, 2), 3, 2), null, "3:2 only leads by one");
  assert.equal(duelSetWinner(rows(3, 3), 3, 2), null, "3:3 keeps playing");
  assert.equal(duelSetWinner(rows(4, 3), 3, 2), null, "4:3 keeps playing");
  assert.equal(duelSetWinner(rows(5, 3), 3, 2), "a", "5:3 wins after a deuce");
  assert.equal(duelSetWinner(rows(5, 4), 3, 2), null);
  assert.equal(duelSetWinner(rows(3, 5), 3, 2), "b");
});

test("duelSetWinner: custom lead of 1 ends as soon as the target is reached", () => {
  assert.equal(duelSetWinner(rows(3, 2), 3, 1), "a");
  assert.equal(duelSetWinner(rows(2, 2), 3, 1), null);
});

test("duelMatchWinner: first side to setsToWin sets", () => {
  assert.equal(duelMatchWinner({ a: 0, b: 0 }, 2), null);
  assert.equal(duelMatchWinner({ a: 1, b: 1 }, 2), null);
  assert.equal(duelMatchWinner({ a: 2, b: 1 }, 2), "a");
  assert.equal(duelMatchWinner({ a: 1, b: 2 }, 2), "b");
  assert.equal(duelMatchWinner({ a: 1, b: 0 }, 1), "a");
  assert.equal(duelMatchWinner({ a: 2, b: 2 }, 3), null);
  assert.equal(duelMatchWinner({ a: 3, b: 2 }, 3), "a");
});

test("duelSetWinsLeader reports the current big score leader", () => {
  assert.deepEqual(duelSetWinsLeader({}), { leaderId: null, leaderWins: 0, tied: true });
  assert.deepEqual(duelSetWinsLeader({ a: 0, b: 1 }), { leaderId: "b", leaderWins: 1, tied: false });
  assert.deepEqual(duelSetWinsLeader({ a: 1, b: 1 }), { leaderId: null, leaderWins: 1, tied: true });
  assert.deepEqual(duelSetWinsLeader({ a: 2, b: 1 }), { leaderId: "a", leaderWins: 2, tied: false });
});

test("normalizeBestOf validates duel only", () => {
  assert.equal(normalizeBestOf("duel", undefined), 3);
  assert.equal(normalizeBestOf("duel", 5), 5);
  assert.equal(normalizeBestOf("duel", 1), 1);
  assert.equal(normalizeBestOf("ffa3", 7), 1, "bestOf is ignored outside duel");
  assert.equal(normalizeBestOf("team2v2", 5), 1);
  for (const bad of [0, 2, 4, 6, 9, "3"]) {
    assert.throws(() => normalizeBestOf("duel", bad), /1、3、5 或 7/);
  }
  assert.equal(normalizeBestOf("duel", null), 3, "null falls back to the default");
  assert.equal(normalizeBestOf("duel", 3, 5), 3, "explicit bestOf wins over the fallback");
  assert.equal(normalizeBestOf("duel", undefined, 5), 5, "fallback is configurable");
});
