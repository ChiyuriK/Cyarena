import test from "node:test";
import assert from "node:assert/strict";
import type { LeaderboardRow, MatchSummary, RoomState, StatsResponse } from "../../../packages/shared/src/index.ts";
import { closeAll, connectClient, getJson, guest, register, sleep, startTestServer } from "./helpers.ts";
import type { TestClient, TestServer } from "./helpers.ts";

const ANSWER = "画蛇添足";
const WRONG_WORDS = ["画龙点睛", "画饼充饥", "画地为牢", "画中有诗", "一心一意", "三心二意"];

interface PracticeSetup {
  client: TestClient;
  state: RoomState;
  token: string;
  userId: string;
}

async function startPractice(
  ts: TestServer,
  userName: string,
  options: { guessMode?: "standard" | "free"; registered?: boolean; visibility?: "public" | "private" } = {},
): Promise<PracticeSetup> {
  const session = options.registered
    ? await register(ts.base, userName, "secret1", userName)
    : await guest(ts.base, userName);
  const client = await connectClient(ts.wsBase, session.token);
  client.send({
    type: "room.create",
    mode: "practice",
    visibility: options.visibility ?? "public",
    guessMode: options.guessMode ?? "standard",
  });
  const state = await client.nextState(
    (candidate) => candidate.mode === "practice" && candidate.status === "playing" && candidate.round.status === "playing",
  );
  return { client, state, token: session.token, userId: session.user.id };
}

test("practice starts immediately, is invisible in the lobby and refuses queue/spectate", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER, config: { idleTimeoutMs: 60_000 } });
  const clients: TestClient[] = [];
  try {
    const practice = await startPractice(ts, "练习自动开始");
    clients.push(practice.client);
    const state = practice.state;
    assert.equal(state.mode, "practice");
    assert.equal(state.players.length, 1, "solo room");
    assert.equal(state.players[0].ready, true, "no ready click needed");
    assert.equal(state.round.index, 1);
    assert.equal(state.round.status, "playing");
    assert.equal(state.round.answer, null);
    assert.equal(state.round.endsAt, 0, "practice has no idle countdown");
    assert.equal(state.match.targetScore, 0);
    assert.equal(state.match.bestOf, 1);

    const rooms = await getJson<{ rooms: Array<{ code: string }> }>(ts.base, "/api/rooms");
    assert.equal(rooms.rooms.some((room) => room.code === state.code), false, "practice is never listed");

    practice.client.send({ type: "queue.join", mode: "practice" });
    assert.match(await practice.client.nextError(), /练习模式不支持快速匹配/);
    practice.client.send({ type: "room.ready", ready: true });
    assert.match(await practice.client.nextError(), /练习模式无需准备/);
    practice.client.send({ type: "room.start" });
    assert.match(await practice.client.nextError(), /练习模式无需开始/);

    const watcher = await guest(ts.base, "想观战的人");
    const watcherClient = await connectClient(ts.wsBase, watcher.token);
    clients.push(watcherClient);
    watcherClient.send({ type: "spectate.join", code: state.code });
    assert.match(await watcherClient.nextError(), /练习模式不能观战/);

    // Leaving destroys the solo room and releases the seat immediately.
    practice.client.send({ type: "room.leave" });
    await practice.client.next((message) => message.type === "toast" && message.message === "已离开房间");
    practice.client.send({ type: "room.create", mode: "practice", visibility: "private" });
    const second = await practice.client.nextState(
      (candidate) => candidate.mode === "practice" && candidate.status === "playing" && candidate.code !== state.code,
    );
    assert.match(second.code, /^\d{5}$/);
  } finally {
    await closeAll(clients);
    await ts.close();
  }
});

test("practice has no idle timeout even when the config timeout is tiny", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER, config: { idleTimeoutMs: 40 } });
  let practice: PracticeSetup | null = null;
  try {
    practice = await startPractice(ts, "慢慢练习");
    await sleep(180);
    const last = practice.client.lastState();
    assert.equal(last?.status, "playing");
    assert.equal(last?.round.status, "playing");
    assert.equal(last?.round.answer, null);
  } finally {
    if (practice) await closeAll([practice.client]);
    await ts.close();
  }
});

test("practice: a correct guess ends the board and rematch starts a new one", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER });
  let practice: PracticeSetup | null = null;
  try {
    practice = await startPractice(ts, "练习猜中");
    const client = practice.client;
    client.send({ type: "room.guess", word: WRONG_WORDS[0] });
    await client.nextState((state) => state.round.rows.length === 1);
    client.send({ type: "room.guess", word: ANSWER });
    const solved = await client.nextState((state) => state.round.status === "ended");
    assert.equal(solved.round.result, "solved");
    assert.equal(solved.round.answer, ANSWER);
    assert.equal(solved.round.winnerId, practice.userId);
    const matchEnd = await client.nextState((state) => state.status === "matchEnd");
    assert.equal(matchEnd.match.isDraw, true);
    assert.equal(matchEnd.match.winnerId, null);
    assert.equal(matchEnd.match.forfeitById, null);
    assert.equal(matchEnd.match.roundNumber, 1);

    const recent = await getJson<{ matches: MatchSummary[] }>(ts.base, "/api/matches/recent");
    assert.equal(recent.matches.length, 0, "practice is not written to match history");

    client.send({ type: "room.rematch" });
    const nextBoard = await client.nextState(
      (state) => state.status === "playing" && state.round.status === "playing" && state.serverTime >= matchEnd.serverTime,
    );
    assert.equal(nextBoard.round.index, 1, "a new board restarts at round 1");
    assert.equal(nextBoard.round.rows.length, 0);
    assert.equal(nextBoard.round.answer, null);
    assert.equal(nextBoard.match.isDraw, false);
  } finally {
    if (practice) await closeAll([practice.client]);
    await ts.close();
  }
});

test("practice: the sixth wrong row ends the board without awards", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER });
  let practice: PracticeSetup | null = null;
  try {
    practice = await startPractice(ts, "练习流局");
    const client = practice.client;
    let exhausted: RoomState | null = null;
    for (let index = 0; index < WRONG_WORDS.length; index += 1) {
      client.send({ type: "room.guess", word: WRONG_WORDS[index] });
      const state = await client.nextState((candidate) => candidate.round.rows.length === index + 1);
      if (index === WRONG_WORDS.length - 1) exhausted = state;
    }
    assert.ok(exhausted);
    assert.equal(exhausted.round.result, "exhausted");
    assert.equal(exhausted.round.answer, ANSWER);
    assert.deepEqual(exhausted.round.awardedTo, []);
    assert.equal(exhausted.round.awardedTeam, null);
    assert.equal(exhausted.round.setWinnerId, null);
    assert.equal(exhausted.players[0].score, 0);
    const matchEnd = await client.nextState((state) => state.status === "matchEnd");
    assert.equal(matchEnd.match.isDraw, true);
    assert.equal(matchEnd.match.winnerId, null);
  } finally {
    if (practice) await closeAll([practice.client]);
    await ts.close();
  }
});

test("practice: guess mode standard vs free", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER });
  const clients: TestClient[] = [];
  try {
    const free = await startPractice(ts, "自由练习", { guessMode: "free" });
    clients.push(free.client);
    assert.equal(free.state.guessMode, "free");
    free.client.send({ type: "room.guess", word: "天天天天" });
    const freeRow = await free.client.nextState((state) => state.round.rows.length === 1);
    assert.equal(freeRow.round.rows[0].word, "天天天天");
    assert.equal(freeRow.round.rows[0].correct, false);

    const standard = await startPractice(ts, "标准练习", { guessMode: "standard" });
    clients.push(standard.client);
    assert.equal(standard.state.guessMode, "standard");
    standard.client.send({ type: "room.guess", word: "天天天天" });
    assert.match(await standard.client.nextError(), /词库/);
  } finally {
    await closeAll(clients);
    await ts.close();
  }
});

test("practice stats are separate from total, ladder and match history", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER });
  let practice: PracticeSetup | null = null;
  try {
    practice = await startPractice(ts, "practice_stats", { registered: true });
    const client = practice.client;
    // Board 1: solve on the first guess.
    client.send({ type: "room.guess", word: ANSWER });
    await client.nextState((state) => state.round.status === "ended");
    const firstEnd = await client.nextState((state) => state.status === "matchEnd");
    // Board 2: burn all six rows.
    client.send({ type: "room.rematch" });
    await client.nextState(
      (state) => state.status === "playing" && state.round.status === "playing" && state.serverTime >= firstEnd.serverTime,
    );
    for (let index = 0; index < WRONG_WORDS.length; index += 1) {
      client.send({ type: "room.guess", word: WRONG_WORDS[index] });
      await client.nextState((state) => state.round.rows.length === index + 1);
    }
    await client.nextState((state) => state.status === "matchEnd");

    const stats = await getJson<StatsResponse>(ts.base, "/api/stats/me", practice.token);
    const mode = stats.modes.practice;
    assert.equal(mode.matches, 2, "one match per practice board");
    assert.equal(mode.rounds, 2);
    assert.equal(mode.roundsWithGuess, 2);
    assert.equal(mode.guesses, 7);
    assert.equal(mode.solves, 1);
    assert.ok(mode.fastestSolveMs > 0);
    assert.ok(mode.avgSolveMs > 0);
    assert.equal(mode.points, 0);
    assert.equal(mode.setsWon, 0);
    assert.equal(mode.wins, 0);
    assert.equal(mode.losses, 0);
    assert.equal(mode.draws, 0);
    assert.equal(mode.fastestMatchAwards, 0);
    assert.ok(mode.solveRate > 0 && mode.solveRate <= 1);

    // Practice is excluded from the aggregated total.
    assert.equal(stats.total.matches, 0, "practice is not counted in total");
    assert.equal(stats.total.guesses, 0);
    assert.equal(stats.total.solves, 0);
    assert.equal(stats.total.rounds, 0);

    // No ladder entries, no match history.
    const ladder = await getJson<{ rows: LeaderboardRow[] }>(ts.base, "/api/leaderboard?mode=duel");
    assert.equal(ladder.rows.length, 0);
    const me = await getJson<{ ratings: Record<string, { rating: number; games: number }> }>(
      ts.base,
      "/api/me",
      practice.token,
    );
    assert.deepEqual(Object.keys(me.ratings).sort(), ["duel", "ffa3", "team2v2"]);
    for (const modeName of Object.keys(me.ratings)) {
      assert.equal(me.ratings[modeName].rating, 1200);
      assert.equal(me.ratings[modeName].games, 0);
    }
    const recent = await getJson<{ matches: MatchSummary[] }>(ts.base, "/api/matches/recent");
    assert.equal(recent.matches.length, 0);
  } finally {
    if (practice) await closeAll([practice.client]);
    await ts.close();
  }
});

test("guests can play practice but never get persistent stats", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER });
  let practice: PracticeSetup | null = null;
  try {
    practice = await startPractice(ts, "练习游客");
    const client = practice.client;
    client.send({ type: "room.guess", word: ANSWER });
    const matchEnd = await client.nextState((state) => state.status === "matchEnd");
    assert.equal(matchEnd.match.isDraw, true);

    const response = await fetch(`${ts.base}/api/stats/me`, {
      headers: { authorization: `Bearer ${practice.token}` },
    });
    assert.equal(response.status, 401, "guest stats are not persisted");
  } finally {
    if (practice) await closeAll([practice.client]);
    await ts.close();
  }
});
