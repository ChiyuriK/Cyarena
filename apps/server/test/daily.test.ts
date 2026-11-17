import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DailyState } from "../../../packages/shared/src/index.ts";
import { explanationFor, loadGameData } from "../../../packages/engine/src/index.ts";
import { dailyAnswer, dailyDateKey, dailyWeekday, shiftDateKey } from "../src/daily.ts";
import { closeAll, connectClient, getJson, guest, register, startTestServer } from "./helpers.ts";
import type { TestClient } from "./helpers.ts";

const NON_SUNDAY = "2026-11-12";
const SUNDAY = "2026-11-15";
const data = loadGameData();

async function postJson(
  base: string,
  path: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

test("daily answer is deterministic and follows the weekday pools", () => {
  assert.equal(dailyWeekday(NON_SUNDAY), 4);
  assert.equal(dailyWeekday(SUNDAY), 7);
  const thursday = dailyAnswer(data, NON_SUNDAY);
  assert.equal(data.answerPool.includes(thursday), true);
  assert.equal(data.commonSet.has(thursday), false, "Monday-Saturday exclude the common pool");
  assert.ok(explanationFor(data, thursday).length > 0, "daily answer has an explanation");
  assert.equal(dailyAnswer(data, NON_SUNDAY), thursday, "same date is stable");

  const friday = dailyAnswer(data, "2026-11-13");
  assert.notEqual(friday, thursday, "the next day changes the answer");

  const sunday = dailyAnswer(data, SUNDAY);
  assert.equal(data.commonSet.has(sunday), true, "Sunday uses the common pool");
  assert.equal(dailyAnswer(data, SUNDAY), sunday);
  assert.equal(dailyWeekday("2026-11-09"), 1);
  assert.equal(data.commonSet.has(dailyAnswer(data, "2026-11-09")), false);
  assert.equal(data.commonSet.has(dailyAnswer(data, "2026-11-14")), false, "Saturday is not a common day");
});

test("GET /api/daily without a session exposes no answer and empty rows", async () => {
  const ts = await startTestServer();
  try {
    const state = await getJson<DailyState>(ts.base, `/api/daily?date=${NON_SUNDAY}`);
    assert.equal(state.date, NON_SUNDAY);
    assert.equal(state.weekday, 4);
    assert.equal(state.isCommonDay, false);
    assert.ok(state.intro.length > 0);
    assert.deepEqual(state.rows, []);
    assert.equal(state.solved, false);
    assert.equal(state.answer, null);
    assert.equal(state.explanation, null);
    assert.equal(state.attempts, 0);
    assert.equal(state.durationMs, null);
    assert.equal(state.streakDays, 0);
    assert.equal(state.me, null);
    assert.deepEqual(state.leaderboard, []);

    const invalid = await fetch(`${ts.base}/api/daily?date=2026-13-40`);
    assert.equal(invalid.status, 400);
    const bad = await fetch(`${ts.base}/api/daily?date=nope`);
    assert.equal(bad.status, 400);
  } finally {
    await ts.close();
  }
});

test("daily guessing: unlimited tries, duplicate prompt, hidden answer, leaderboard", async () => {
  const ts = await startTestServer();
  const clients: TestClient[] = [];
  try {
    const user = await register(ts.base, "daily_one", "secret1", "每日甲");
    const other = await register(ts.base, "daily_two", "secret1", "每日乙");
    const answer = dailyAnswer(data, NON_SUNDAY);
    const wrong = "一心一意";
    assert.notEqual(answer, wrong);

    const guestSession = await guest(ts.base, "每日游客");
    const guestGuess = await postJson(ts.base, `/api/daily/guess?date=${NON_SUNDAY}`, { word: wrong }, guestSession.token);
    assert.equal(guestGuess.status, 403);
    const anonGuess = await postJson(ts.base, `/api/daily/guess?date=${NON_SUNDAY}`, { word: wrong });
    assert.equal(anonGuess.status, 401);

    const first = await postJson(ts.base, `/api/daily/guess?date=${NON_SUNDAY}`, { word: wrong }, user.token);
    assert.equal(first.status, 200);
    const firstState = first.json as unknown as DailyState;
    assert.equal(firstState.solved, false);
    assert.equal(firstState.answer, null, "the answer stays hidden while unsolved");
    assert.equal(firstState.explanation, null);
    assert.equal(firstState.attempts, 1);
    assert.equal(firstState.rows.length, 1);
    assert.equal(firstState.rows[0].word, wrong);
    assert.equal(firstState.rows[0].tiles.length, 4);
    assert.equal(firstState.rows[0].summary.length, 4);
    assert.deepEqual(firstState.me, { rank: null, attempts: 1, solvedAt: null, durationMs: null });
    assert.equal(firstState.durationMs, null);
    assert.equal(firstState.streakDays, 0);

    const repeat = await postJson(ts.base, `/api/daily/guess?date=${NON_SUNDAY}`, { word: wrong }, user.token);
    assert.equal(repeat.status, 400);
    assert.match(String(repeat.json.error), /已经猜过/);
    const afterRepeat = await getJson<DailyState>(ts.base, `/api/daily?date=${NON_SUNDAY}`, user.token);
    assert.equal(afterRepeat.attempts, 1, "a duplicate does not consume an attempt");

    const solved = await postJson(ts.base, `/api/daily/guess?date=${NON_SUNDAY}`, { word: answer }, user.token);
    assert.equal(solved.status, 200);
    const solvedState = solved.json as unknown as DailyState;
    assert.equal(solvedState.solved, true);
    assert.equal(solvedState.answer, answer);
    assert.ok(String(solvedState.explanation).length > 0);
    assert.equal(solvedState.attempts, 2);
    assert.equal(solvedState.rows.length, 2);
    assert.equal(solvedState.rows[1].word, answer);
    assert.deepEqual(solvedState.rows[1].summary, ["green", "green", "green", "green"]);
    assert.equal(solvedState.me?.rank, 1);
    assert.equal(solvedState.me?.attempts, 2);
    assert.ok((solvedState.me?.solvedAt ?? 0) > 0);
    assert.equal(typeof solvedState.durationMs, "number");
    assert.ok((solvedState.durationMs ?? -1) >= 0);
    assert.equal(solvedState.me?.durationMs, solvedState.durationMs);
    assert.equal(solvedState.streakDays, 1, "solving today starts a one-day streak");
    assert.equal(solvedState.leaderboard.length, 1);
    assert.equal(solvedState.leaderboard[0].userId, user.user.id);
    assert.equal(solvedState.leaderboard[0].attempts, 2);
    assert.equal(solvedState.leaderboard[0].rank, 1);
    assert.equal(solvedState.leaderboard[0].durationMs, solvedState.durationMs);

    const persisted = await getJson<DailyState>(ts.base, `/api/daily?date=${NON_SUNDAY}`, user.token);
    assert.equal(persisted.solved, true);
    assert.equal(persisted.answer, answer);
    assert.equal(persisted.rows.length, 2);
    assert.ok(String(persisted.explanation).length > 0);

    const solvedAgain = await postJson(ts.base, `/api/daily/guess?date=${NON_SUNDAY}`, { word: answer }, user.token);
    assert.equal(solvedAgain.status, 400);
    assert.match(String(solvedAgain.json.error), /已经答对/);

    // A player solving with fewer attempts ranks first; the first player sees rank 2.
    const otherSolved = await postJson(ts.base, `/api/daily/guess?date=${NON_SUNDAY}`, { word: answer }, other.token);
    assert.equal(otherSolved.status, 200);
    const otherState = otherSolved.json as unknown as DailyState;
    assert.equal(otherState.me?.rank, 1);
    assert.equal(otherState.leaderboard.length, 2);
    assert.equal(otherState.leaderboard[0].userId, other.user.id);
    assert.equal(otherState.leaderboard[1].userId, user.user.id);
    const firstAgain = await getJson<DailyState>(ts.base, `/api/daily?date=${NON_SUNDAY}`, user.token);
    assert.equal(firstAgain.me?.rank, 2);
    assert.equal(firstAgain.leaderboard[1].rank, 2);

    // A guest can read the daily page but not submit.
    const guestClient = await connectClient(ts.wsBase, guestSession.token);
    clients.push(guestClient);
    const guestView = await getJson<DailyState>(ts.base, `/api/daily?date=${NON_SUNDAY}`, guestSession.token);
    assert.equal(guestView.me, null);
    assert.deepEqual(guestView.rows, []);
    assert.equal(guestView.solved, false);
  } finally {
    await closeAll(clients);
    await ts.close();
  }
});

test("daily accepts free four-character guesses outside the dictionary", async () => {
  const ts = await startTestServer();
  try {
    const user = await register(ts.base, "daily_free", "secret1", "自由每日");
    const guess = await postJson(ts.base, `/api/daily/guess?date=${NON_SUNDAY}`, { word: "天天天天" }, user.token);
    assert.equal(guess.status, 200);
    const state = guess.json as unknown as DailyState;
    assert.equal(state.rows.length, 1);
    assert.equal(state.rows[0].word, "天天天天");
    assert.equal(state.solved, false);
    assert.equal(state.answer, null);

    const invalid = await postJson(ts.base, `/api/daily/guess?date=${NON_SUNDAY}`, { word: "abc" }, user.token);
    assert.equal(invalid.status, 400);
  } finally {
    await ts.close();
  }
});

test("daily duration and streakDays: fastest same-attempt solve first, today not yet solved keeps streak", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ciying-daily-extra-"));
  const today = dailyDateKey();
  const yesterday = shiftDateKey(today, -1);
  const twoDaysAgo = shiftDateKey(today, -2);
  const now = Date.now();
  try {
    const entry = (
      date: string,
      userId: string,
      durationMs: number,
      attempts = 1,
    ) => ({
      date,
      userId,
      guesses: ["画蛇添足"],
      solved: true,
      solvedAt: now - durationMs,
      attempts,
      startedAt: now - durationMs * 2,
      durationMs,
    });
    const legacy = {
      version: 1,
      users: [
        { id: "u_a", name: "快用户", username: "fast_user", isGuest: false, createdAt: now },
        { id: "u_b", name: "昨日用户", username: "yesterday_user", isGuest: false, createdAt: now },
        { id: "u_c", name: "慢用户", username: "slow_user", isGuest: false, createdAt: now },
        { id: "u_d", name: "断签用户", username: "gap_user", isGuest: false, createdAt: now },
      ],
      sessions: { tok_a: "u_a", tok_b: "u_b", tok_c: "u_c", tok_d: "u_d" },
      ratings: {},
      stats: {},
      matches: [],
      daily: {
        [`${today}:u_a`]: entry(today, "u_a", 4_000),
        [`${yesterday}:u_a`]: entry(yesterday, "u_a", 1_000),
        [`${twoDaysAgo}:u_a`]: entry(twoDaysAgo, "u_a", 1_000),
        [`${yesterday}:u_b`]: entry(yesterday, "u_b", 1_000),
        [`${twoDaysAgo}:u_b`]: entry(twoDaysAgo, "u_b", 1_000),
        [`${today}:u_c`]: entry(today, "u_c", 12_000),
        [`${twoDaysAgo}:u_c`]: entry(twoDaysAgo, "u_c", 1_000),
        [`${today}:u_d`]: null,
      },
    };
    writeFileSync(join(dataDir, "store.json"), JSON.stringify(legacy), "utf8");
    const ts = await startTestServer({ dataDir, persistStore: true });
    try {
      const fast = await getJson<DailyState>(ts.base, `/api/daily?date=${today}`, "tok_a");
      assert.equal(fast.durationMs, 4_000);
      assert.equal(fast.me?.durationMs, 4_000);
      assert.equal(fast.streakDays, 3, "today + yesterday + two days ago");
      assert.equal(fast.me?.rank, 1);
      assert.deepEqual(
        fast.leaderboard.map((row) => [row.userId, row.durationMs]),
        [
          ["u_a", 4_000],
          ["u_c", 12_000],
        ],
        "same attempts: shorter duration ranks first",
      );

      const slow = await getJson<DailyState>(ts.base, `/api/daily?date=${today}`, "tok_c");
      assert.equal(slow.durationMs, 12_000);
      assert.equal(slow.streakDays, 1, "a gap resets the streak");
      assert.equal(slow.me?.rank, 2);

      const yesterdayOnly = await getJson<DailyState>(ts.base, `/api/daily?date=${today}`, "tok_b");
      assert.equal(yesterdayOnly.solved, false);
      assert.equal(yesterdayOnly.durationMs, null);
      assert.equal(yesterdayOnly.streakDays, 2, "today is not over yet, keep counting from yesterday");

      const gap = await getJson<DailyState>(ts.base, `/api/daily?date=${today}`, "tok_d");
      assert.equal(gap.streakDays, 0);

      const guestSession = await guest(ts.base, "时长游客");
      const guestView = await getJson<DailyState>(ts.base, `/api/daily?date=${today}`, guestSession.token);
      assert.equal(guestView.streakDays, 0);
      assert.equal(guestView.me, null);
    } finally {
      await ts.close();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("daily results persist across restarts, old dates are pruned", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ciying-daily-"));
  const today = dailyDateKey();
  try {
    const legacy = {
      version: 1,
      users: [{ id: "u_daily", name: "持久用户", username: "daily_persist", isGuest: false, createdAt: Date.now() }],
      sessions: { daily_token: "u_daily" },
      ratings: {},
      stats: {},
      matches: [],
      daily: {
        "2026-01-01:u_daily": {
          date: "2026-01-01",
          userId: "u_daily",
          guesses: ["画蛇添足"],
          solved: true,
          solvedAt: 1,
          attempts: 1,
        },
        [`${today}:u_daily`]: {
          date: today,
          userId: "u_daily",
          guesses: ["画蛇添足"],
          solved: true,
          solvedAt: Date.now() - 1_000,
          attempts: 1,
        },
      },
    };
    writeFileSync(join(dataDir, "store.json"), JSON.stringify(legacy), "utf8");

    const first = await startTestServer({ dataDir, persistStore: true });
    try {
      const current = await getJson<DailyState>(first.base, `/api/daily?date=${today}`, "daily_token");
      assert.equal(current.solved, true);
      assert.ok(current.answer);
      assert.equal(current.attempts, 1);
      assert.equal(current.durationMs, 0, "missing startedAt falls back to solvedAt");
      assert.equal(current.streakDays, 1);
      assert.equal(current.leaderboard.length, 1);
      assert.equal(current.leaderboard[0].userId, "u_daily");
      assert.equal(current.leaderboard[0].durationMs, 0);

      const old = await getJson<DailyState>(first.base, `/api/daily?date=2026-01-01`, "daily_token");
      assert.equal(old.solved, false, "records older than 35 days are pruned");
      assert.equal(old.attempts, 0);
      assert.deepEqual(old.leaderboard, []);
    } finally {
      await first.close();
    }

    const second = await startTestServer({ dataDir, persistStore: true });
    try {
      const again = await getJson<DailyState>(second.base, `/api/daily?date=${today}`, "daily_token");
      assert.equal(again.solved, true);
      assert.equal(again.attempts, 1);
      const ladder = await getJson<{ rows: unknown[] }>(second.base, `/api/leaderboard?mode=duel`);
      assert.equal(ladder.rows.length, 0);
    } finally {
      await second.close();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
