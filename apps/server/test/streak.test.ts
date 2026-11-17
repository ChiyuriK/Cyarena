import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreakLeaderboardResponse, StreakState, StreakStats } from "../../../packages/shared/src/index.ts";
import { loadGameData } from "../../../packages/engine/src/index.ts";
import { streakPool } from "../src/streak.ts";
import { closeAll, connectClient, guest, register, startTestServer } from "./helpers.ts";
import type { TestClient, TestServer } from "./helpers.ts";

const ANSWER = "画蛇添足";
const WRONGS = ["一心一意", "三心二意", "四通八达", "五颜六色", "画饼充饥", "画地为牢"];

async function requestJson(
  base: string,
  method: string,
  path: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

async function getStreak(base: string, variant: string, token: string): Promise<string> {
  const response = await fetch(`${base}/api/streak?variant=${variant}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  return response.text();
}

test("streak: start hides the answer, standard rejects non-idioms, guest is rejected", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER });
  const clients: TestClient[] = [];
  try {
    const user = await register(ts.base, "streak_one", "secret1", "连胜甲");
    const guestSession = await guest(ts.base, "连胜游客");

    const empty = await getStreak(ts.base, "standard", user.token);
    assert.equal(empty, "null", "no active run returns null");

    const started = await requestJson(ts.base, "POST", "/api/streak/start", { variant: "standard" }, user.token);
    assert.equal(started.status, 200);
    const state = started.json as unknown as StreakState;
    assert.equal(state.variant, "standard");
    assert.equal(state.status, "playing");
    assert.deepEqual(state.rows, []);
    assert.equal(state.maxRows, 6);
    assert.equal(state.remainingRows, 6);
    assert.equal(state.streak, 0);
    assert.equal(state.best, 0);
    assert.equal(state.answer, null);
    assert.equal(state.explanation, null);
    assert.ok(state.message.length > 0);

    const badStandard = await requestJson(
      ts.base,
      "POST",
      "/api/streak/guess",
      { word: "天天天天" },
      user.token,
    );
    assert.equal(badStandard.status, 400);

    const wrong = await requestJson(ts.base, "POST", "/api/streak/guess", { word: "画虎类犬" }, user.token);
    assert.equal(wrong.status, 200);
    const wrongState = wrong.json as unknown as StreakState;
    assert.equal(wrongState.rows.length, 1);
    assert.equal(wrongState.remainingRows, 5);
    assert.equal(wrongState.answer, null, "the active answer stays hidden");

    const correct = await requestJson(ts.base, "POST", "/api/streak/guess", { word: ANSWER }, user.token);
    assert.equal(correct.status, 200);
    const afterCorrect = correct.json as unknown as StreakState;
    assert.equal(afterCorrect.streak, 1);
    assert.deepEqual(afterCorrect.rows, [], "the next idiom starts with a clean board");
    assert.equal(afterCorrect.answer, null);
    assert.equal(afterCorrect.best, 1);
    assert.match(afterCorrect.message, /连胜 1/);

    // Guests cannot use any streak API.
    for (const [method, path, body] of [
      ["GET", "/api/streak?variant=standard", undefined],
      ["POST", "/api/streak/start", { variant: "standard" }],
      ["POST", "/api/streak/guess", { word: ANSWER }],
      ["POST", "/api/streak/quit", {}],
      ["GET", "/api/streak/leaderboard?variant=standard", undefined],
      ["GET", "/api/streak/stats", undefined],
    ] as const) {
      const response = await requestJson(ts.base, method, path, body, guestSession.token);
      assert.equal(response.status, 403, `${method} ${path} should reject guests`);
    }
    const anon = await requestJson(ts.base, "POST", "/api/streak/start", { variant: "standard" });
    assert.equal(anon.status, 401);
    const invalidVariant = await requestJson(
      ts.base,
      "POST",
      "/api/streak/start",
      { variant: "weird" },
      user.token,
    );
    assert.equal(invalidVariant.status, 400);

    const guestClient = await connectClient(ts.wsBase, guestSession.token);
    clients.push(guestClient);
  } finally {
    await closeAll(clients);
    await ts.close();
  }
});

test("streak variants use the right pools and free mode accepts non-idioms", async () => {
  const data = loadGameData();
  const standardPool = streakPool(data, "standard");
  const freePool = streakPool(data, "free");
  const advancedPool = streakPool(data, "advanced");
  assert.equal(standardPool, data.commonPool);
  assert.equal(freePool, data.commonPool);
  assert.ok(advancedPool.length > 0);
  assert.equal(
    advancedPool.every((word) => !data.commonSet.has(word)),
    true,
    "advanced answers exclude the common pool",
  );

  const ts = await startTestServer({ chooseAnswer: () => ANSWER });
  try {
    const freeUser = await register(ts.base, "streak_free", "secret1", "自由连胜");
    const freeStart = await requestJson(ts.base, "POST", "/api/streak/start", { variant: "free" }, freeUser.token);
    assert.equal(freeStart.status, 200);
    const freeGuess = await requestJson(
      ts.base,
      "POST",
      "/api/streak/guess",
      { word: "天天天天" },
      freeUser.token,
    );
    assert.equal(freeGuess.status, 200, "free mode accepts any renderable four-character word");
    assert.equal((freeGuess.json as unknown as StreakState).rows.length, 1);
    const freeCorrect = await requestJson(ts.base, "POST", "/api/streak/guess", { word: ANSWER }, freeUser.token);
    assert.equal((freeCorrect.json as unknown as StreakState).streak, 1);
    await requestJson(ts.base, "POST", "/api/streak/quit", {}, freeUser.token);

    const advancedUser = await register(ts.base, "streak_advanced", "secret1", "高阶连胜");
    await requestJson(ts.base, "POST", "/api/streak/start", { variant: "advanced" }, advancedUser.token);
    const advancedBad = await requestJson(
      ts.base,
      "POST",
      "/api/streak/guess",
      { word: "天天天天" },
      advancedUser.token,
    );
    assert.equal(advancedBad.status, 400, "advanced uses the standard dictionary for input");
    const advancedOk = await requestJson(
      ts.base,
      "POST",
      "/api/streak/guess",
      { word: "画虎类犬" },
      advancedUser.token,
    );
    assert.equal(advancedOk.status, 200);
  } finally {
    await ts.close();
  }
});

test("streak: six misses end the run and expose answer/explanation", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER });
  try {
    const user = await register(ts.base, "streak_six", "secret1", "六行连胜");
    await requestJson(ts.base, "POST", "/api/streak/start", { variant: "standard" }, user.token);
    // Solve one first so the run has a streak to preserve.
    const solved = await requestJson(ts.base, "POST", "/api/streak/guess", { word: ANSWER }, user.token);
    assert.equal((solved.json as unknown as StreakState).streak, 1);

    let last: StreakState | null = null;
    for (const [index, word] of WRONGS.entries()) {
      const response = await requestJson(ts.base, "POST", "/api/streak/guess", { word }, user.token);
      assert.equal(response.status, 200);
      last = response.json as unknown as StreakState;
      assert.equal(last.rows.length, index + 1);
      if (index < 5) assert.equal(last.status, "playing");
    }
    assert.ok(last);
    assert.equal(last.status, "ended");
    assert.equal(last.answer, ANSWER);
    assert.ok(String(last.explanation).length > 0);
    assert.equal(last.streak, 1);
    assert.equal(last.best, 1);
    assert.equal(last.remainingRows, 0);
    assert.match(last.message, /6 行/);

    assert.equal(await getStreak(ts.base, "standard", user.token), "null");
    const afterEnd = await requestJson(ts.base, "POST", "/api/streak/guess", { word: ANSWER }, user.token);
    assert.equal(afterEnd.status, 400);

    const stats = await requestJson(ts.base, "GET", "/api/streak/stats", undefined, user.token);
    assert.equal(stats.json.runs, 1);
    assert.equal(stats.json.solved, 1);
    assert.equal(stats.json.best, 1);
    assert.ok(Number(stats.json.totalSolveMs) > 0);
    assert.ok(Number(stats.json.fastestSolveMs) > 0);
    const ladder = await requestJson(
      ts.base,
      "GET",
      "/api/streak/leaderboard?variant=standard",
      undefined,
      user.token,
    );
    const board = ladder.json as unknown as StreakLeaderboardResponse;
    assert.equal(board.variant, "standard");
    assert.equal(board.rows.length, 1);
    assert.equal(board.rows[0].best, 1);
    assert.equal(board.rows[0].userId, user.user.id);
  } finally {
    await ts.close();
  }
});

test("streak best/stats persist, three leaderboards stay separate", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ciying-streak-"));
  let first: TestServer | null = null;
  let second: TestServer | null = null;
  try {
    first = await startTestServer({ dataDir, persistStore: true, chooseAnswer: () => ANSWER });
    const user = await register(first.base, "streak_persist", "secret1", "持久连胜");
    await requestJson(first.base, "POST", "/api/streak/start", { variant: "standard" }, user.token);
    for (let streak = 1; streak <= 3; streak += 1) {
      const response = await requestJson(first.base, "POST", "/api/streak/guess", { word: ANSWER }, user.token);
      const state = response.json as unknown as StreakState;
      assert.equal(state.streak, streak);
      assert.equal(state.best, streak);
      assert.deepEqual(state.rows, []);
    }
    const running = await requestJson(first.base, "GET", "/api/streak?variant=standard", undefined, user.token);
    const active = running.json as unknown as StreakState;
    assert.equal(active.streak, 3);
    assert.equal(active.best, 3);

    await requestJson(first.base, "POST", "/api/streak/quit", {}, user.token);
    assert.equal(await getStreak(first.base, "standard", user.token), "null");

    const statsBefore = await requestJson(first.base, "GET", "/api/streak/stats", undefined, user.token);
    assert.equal(statsBefore.json.runs, 1);
    assert.equal(statsBefore.json.solved, 3);
    assert.equal(statsBefore.json.best, 3);
    assert.ok(Number(statsBefore.json.totalSolveMs) > 0);
    assert.ok(Number(statsBefore.json.fastestSolveMs) > 0);
    for (const variant of ["standard", "free", "advanced"]) {
      const response = await requestJson(
        first.base,
        "GET",
        `/api/streak/leaderboard?variant=${variant}`,
        undefined,
        user.token,
      );
      const board = response.json as unknown as StreakLeaderboardResponse;
      assert.equal(board.rows.length, variant === "standard" ? 1 : 0, `${variant} board is separate`);
      if (variant === "standard") assert.equal(board.rows[0].best, 3);
    }
    await first.close();
    first = null;

    second = await startTestServer({ dataDir, persistStore: true });
    const statsAfter = await requestJson(second.base, "GET", "/api/streak/stats", undefined, user.token);
    assert.equal(statsAfter.json.runs, 1);
    assert.equal(statsAfter.json.solved, 3);
    assert.equal(statsAfter.json.best, 3);
    assert.ok(Number(statsAfter.json.totalSolveMs) > 0);
    assert.ok(Number(statsAfter.json.fastestSolveMs) > 0);
    const boardAfter = await requestJson(
      second.base,
      "GET",
      "/api/streak/leaderboard?variant=standard",
      undefined,
      user.token,
    );
    assert.equal((boardAfter.json as unknown as StreakLeaderboardResponse).rows[0].best, 3);
    assert.equal(
      await getStreak(second.base, "standard", user.token),
      "null",
      "the active run is memory-only and gone after a restart",
    );
  } finally {
    if (first) await first.close();
    if (second) await second.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("streak stats merge all variants across starts and quits", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER });
  try {
    const user = await register(ts.base, "streak_stats", "secret1", "合并连胜");
    for (const variant of ["standard", "free", "advanced"]) {
      const started = await requestJson(ts.base, "POST", "/api/streak/start", { variant }, user.token);
      assert.equal(started.status, 200);
      await requestJson(ts.base, "POST", "/api/streak/quit", {}, user.token);
    }
    const stats = await requestJson(ts.base, "GET", "/api/streak/stats", undefined, user.token);
    const merged = stats.json as unknown as StreakStats;
    assert.equal(merged.runs, 3);
    assert.equal(merged.solved, 0);
    assert.equal(merged.best, 0);
  } finally {
    await ts.close();
  }
});

test("streak active run expires after the disconnect grace", async () => {
  const ts = await startTestServer({
    chooseAnswer: () => ANSWER,
    streakDisconnectGraceMs: 40,
  });
  try {
    const user = await register(ts.base, "streak_timeout", "secret1", "断线连胜");
    const started = await requestJson(ts.base, "POST", "/api/streak/start", { variant: "standard" }, user.token);
    assert.equal(started.status, 200);
    assert.notEqual(await getStreak(ts.base, "standard", user.token), "null");
    await new Promise((resolve) => setTimeout(resolve, 90));
    assert.equal(await getStreak(ts.base, "standard", user.token), "null");
  } finally {
    await ts.close();
  }
});

test("streak applies a short intermission after a correct answer", async () => {
  const ts = await startTestServer({
    chooseAnswer: () => ANSWER,
    streakIntermissionMs: 40,
  });
  try {
    const user = await register(ts.base, "streak_pause", "secret1", "休息连胜");
    await requestJson(ts.base, "POST", "/api/streak/start", { variant: "standard" }, user.token);
    const solved = await requestJson(ts.base, "POST", "/api/streak/guess", { word: ANSWER }, user.token);
    assert.equal(solved.status, 200);
    assert.ok(Number((solved.json as unknown as StreakState).nextAt) > Date.now());
    const blocked = await requestJson(ts.base, "POST", "/api/streak/guess", { word: WRONGS[0] }, user.token);
    assert.equal(blocked.status, 400);
    await new Promise((resolve) => setTimeout(resolve, 70));
    const afterPause = await requestJson(ts.base, "POST", "/api/streak/guess", { word: WRONGS[0] }, user.token);
    assert.equal(afterPause.status, 200);
  } finally {
    await ts.close();
  }
});
