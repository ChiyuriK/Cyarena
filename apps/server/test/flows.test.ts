import test from "node:test";
import assert from "node:assert/strict";
import { DUEL_POINT_LEAD, DUEL_POINTS_TO_WIN } from "../../../packages/shared/src/index.ts";
import type { MatchSummary, RoomState, StatsResponse } from "../../../packages/shared/src/index.ts";
import { closeAll, connectClient, getJson, guest, proposeAndAgreeRules, register, sleep, startTestServer } from "./helpers.ts";
import type { TestClient, TestServer } from "./helpers.ts";

const ANSWER = "画蛇添足";
const WRONG_WORDS = ["画龙点睛", "画饼充饥", "画地为牢", "画中有诗", "一心一意", "三心二意"];

interface Duel {
  a: TestClient;
  b: TestClient;
  userA: { id: string; name: string };
  userB: { id: string; name: string };
  tokenA: string;
  tokenB: string;
  code: string;
  clients: TestClient[];
}

/** Create a duel room, have the guest ready up, then let the host start. */
async function startDuelRoom(ts: TestServer, bestOf = 1): Promise<Duel> {
  const clients: TestClient[] = [];
  try {
    const userA = await guest(ts.base, "流程甲");
    const userB = await guest(ts.base, "流程乙");
    const a = await connectClient(ts.wsBase, userA.token);
    clients.push(a);
    const b = await connectClient(ts.wsBase, userB.token);
    clients.push(b);
    a.send({ type: "room.create", mode: "duel", visibility: "public", bestOf });
    const created = await a.nextState((state) => state.players.length === 1);
    assert.equal(created.players[0].ready, true, "host is ready automatically");
    b.send({ type: "room.join", code: created.code });
    await a.nextState((state) => state.players.length === 2);
    await b.nextState((state) => state.players.length === 2);
    b.send({ type: "room.ready", ready: true });
    await a.nextState((state) => state.status === "waiting" && state.players.every((player) => player.ready));
    a.send({ type: "room.start" });
    await a.nextState((state) => state.status === "countdown");
    await a.nextState((state) => state.status === "playing" && state.round.status === "playing");
    await b.nextState((state) => state.status === "playing" && state.round.status === "playing");
    return {
      a,
      b,
      userA: userA.user,
      userB: userB.user,
      tokenA: userA.token,
      tokenB: userB.token,
      code: created.code,
      clients,
    };
  } catch (error) {
    await closeAll(clients);
    throw error;
  }
}

/** Two-player team room (A vs B) with the host on A. */
async function startTeamDuo(ts: TestServer, bestOf = 1): Promise<{
  a: TestClient;
  b: TestClient;
  userA: { id: string; name: string };
  userB: { id: string; name: string };
  clients: TestClient[];
}> {
  const clients: TestClient[] = [];
  try {
    const userA = await guest(ts.base, "团队甲");
    const userB = await guest(ts.base, "团队乙");
    const a = await connectClient(ts.wsBase, userA.token);
    clients.push(a);
    const b = await connectClient(ts.wsBase, userB.token);
    clients.push(b);
    a.send({ type: "room.create", mode: "team2v2", visibility: "public", bestOf });
    const created = await a.nextState((state) => state.players.length === 1);
    b.send({ type: "room.join", code: created.code });
    await a.nextState((state) => state.players.length === 2);
    await b.nextState((state) => state.players.length === 2);
    b.send({ type: "room.ready", ready: true });
    await a.nextState((state) => state.status === "waiting" && state.players.every((player) => player.ready));
    a.send({ type: "room.start" });
    await a.nextState((state) => state.status === "countdown");
    await a.nextState((state) => state.status === "playing" && state.round.status === "playing");
    await b.nextState((state) => state.status === "playing" && state.round.status === "playing");
    return { a, b, userA: userA.user, userB: userB.user, clients };
  } catch (error) {
    await closeAll(clients);
    throw error;
  }
}

/** Three guests matched by the ffa3 queue, then agreeing on rules and starting. */
async function startFfaQueue(
  ts: TestServer,
  pointsToWin = 7,
): Promise<{ clients: TestClient[]; users: Array<{ id: string; name: string }> }> {
  const clients: TestClient[] = [];
  try {
    const sessions = [
      await guest(ts.base, "混战甲"),
      await guest(ts.base, "混战乙"),
      await guest(ts.base, "混战丙"),
    ];
    for (const session of sessions) {
      clients.push(await connectClient(ts.wsBase, session.token));
    }
    for (const client of clients) client.send({ type: "queue.join", mode: "ffa3" });
    await Promise.all(clients.map((client) => client.next((message) => message.type === "match.found")));
    await clients[0].nextState((state) => state.status === "waiting" && state.requiresAgreement === true);
    await promiseRules(clients, pointsToWin);
    clients[0].send({ type: "room.start" });
    await clients[0].nextState((state) => state.status === "countdown");
    await clients[0].nextState((state) => state.status === "playing" && state.round.status === "playing");
    await Promise.all(
      clients
        .slice(1)
        .map((client) => client.nextState((state) => state.status === "playing" && state.round.status === "playing")),
    );
    return { clients, users: sessions.map((session) => session.user) };
  } catch (error) {
    await closeAll(clients);
    throw error;
  }
}

/** Agree on quick-match rules for all clients (host = first client). */
async function promiseRules(clients: TestClient[], pointsToWin: number): Promise<void> {
  await proposeAndAgreeRules(clients[0], clients.slice(1), {
    bestOf: 1,
    guessMode: "free",
    dictionary: "common",
    pointsToWin,
  });
}

function scoreOf(state: RoomState, userId: string): number {
  return state.players.find((player) => player.id === userId)?.score ?? 0;
}

test("6th wrong row awards +1 to the opponent (duel)", async () => {
  const ts = await startTestServer({
    chooseAnswer: () => ANSWER,
    config: { pointsToWin: 3, pointLead: 2 },
  });
  let duel: Duel | null = null;
  try {
    duel = await startDuelRoom(ts, 1);
    const { a, userA, userB } = duel;
    let exhausted: RoomState | null = null;
    for (let index = 0; index < WRONG_WORDS.length; index += 1) {
      a.send({ type: "room.guess", word: WRONG_WORDS[index] });
      const state = await a.nextState((current) => current.round.rows.length === index + 1);
      if (index === WRONG_WORDS.length - 1) exhausted = state;
    }
    assert.ok(exhausted);
    assert.equal(exhausted.round.result, "exhausted");
    assert.equal(exhausted.round.answer, ANSWER);
    assert.deepEqual(exhausted.round.awardedTo, [userB.id]);
    assert.equal(exhausted.round.awardedTeam, null);
    assert.equal(scoreOf(exhausted, userA.id), 0);
    assert.equal(scoreOf(exhausted, userB.id), 1, "opponent gets the point");
    assert.equal(exhausted.match.setWins[userB.id], 0, "one point is not enough for the set");
    assert.equal(exhausted.round.remainingRows, 0);

    // The next round is clean and the awarded players reset.
    const nextRound = await a.nextState(
      (state) => state.status === "playing" && state.round.status === "playing" && state.round.index === 2,
    );
    assert.deepEqual(nextRound.round.awardedTo, []);
    assert.equal(nextRound.round.answer, null);
  } finally {
    if (duel) await closeAll(duel.clients);
    await ts.close();
  }
});

test("6th wrong row awards +1 to the other team (team2v2)", async () => {
  const ts = await startTestServer({
    chooseAnswer: () => ANSWER,
    config: { pointsToWin: 3, pointLead: 2 },
  });
  let team: Awaited<ReturnType<typeof startTeamDuo>> | null = null;
  try {
    team = await startTeamDuo(ts, 1);
    const { a, userB } = team;
    let exhausted: RoomState | null = null;
    for (let index = 0; index < WRONG_WORDS.length; index += 1) {
      a.send({ type: "room.guess", word: WRONG_WORDS[index] });
      const state = await a.nextState((current) => current.round.rows.length === index + 1);
      if (index === WRONG_WORDS.length - 1) exhausted = state;
    }
    assert.ok(exhausted);
    assert.equal(exhausted.round.result, "exhausted");
    assert.equal(exhausted.round.awardedTeam, "B");
    assert.deepEqual(exhausted.round.awardedTo, [userB.id]);
    assert.deepEqual(exhausted.teamScores, { A: 0, B: 1 });
    assert.equal(exhausted.match.setWins.B, 0);
  } finally {
    if (team) await closeAll(team.clients);
    await ts.close();
  }
});

test("6th wrong row awards +1 to both other players (ffa3)", async () => {
  const ts = await startTestServer({
    chooseAnswer: () => ANSWER,
    config: { ffaTargetScore: 7 },
  });
  let ffa: Awaited<ReturnType<typeof startFfaQueue>> | null = null;
  try {
    ffa = await startFfaQueue(ts);
    const [c0, c1, c2] = ffa.clients;
    const [u0, u1, u2] = ffa.users;
    let exhausted: RoomState | null = null;
    for (let index = 0; index < WRONG_WORDS.length; index += 1) {
      c0.send({ type: "room.guess", word: WRONG_WORDS[index] });
      const state = await c0.nextState((current) => current.round.rows.length === index + 1);
      if (index === WRONG_WORDS.length - 1) exhausted = state;
    }
    assert.ok(exhausted);
    assert.equal(exhausted.round.result, "exhausted");
    assert.deepEqual(new Set(exhausted.round.awardedTo), new Set([u1.id, u2.id]));
    assert.equal(scoreOf(exhausted, u0.id), 0);
    assert.equal(scoreOf(exhausted, u1.id), 1);
    assert.equal(scoreOf(exhausted, u2.id), 1);
    // ffa3 has no sets: setWins only tracks zeroed player keys.
    assert.equal(exhausted.match.setWins[u0.id], 0);
    assert.equal(exhausted.match.targetScore, 7);
    await c1.nextState((state) => state.round.rows.length === 6);
    await c2.nextState((state) => state.round.rows.length === 6);
  } finally {
    if (ffa) await closeAll(ffa.clients);
    await ts.close();
  }
});

test("duel: a 6th-row award can finish the set and the match", async () => {
  const ts = await startTestServer({
    chooseAnswer: () => ANSWER,
    config: { pointsToWin: 2, pointLead: 1, countdownMs: 15, roundEndMs: 15, setEndDelayMs: 15 },
  });
  let duel: Duel | null = null;
  try {
    duel = await startDuelRoom(ts, 1);
    const { a, b, userB } = duel;
    // B takes the first point of the set.
    b.send({ type: "room.guess", word: ANSWER });
    await b.nextState((state) => state.round.status === "ended" && state.round.index === 1);
    // A burns all six rows in the next round: B is awarded +1 -> 2:0 set, match.
    await a.nextState(
      (state) => state.status === "playing" && state.round.status === "playing" && state.round.index === 2,
    );
    let exhausted: RoomState | null = null;
    for (let index = 0; index < WRONG_WORDS.length; index += 1) {
      a.send({ type: "room.guess", word: WRONG_WORDS[index] });
      const state = await a.nextState((current) => current.round.rows.length === index + 1);
      if (index === WRONG_WORDS.length - 1) exhausted = state;
    }
    assert.ok(exhausted);
    assert.equal(exhausted.round.result, "exhausted");
    assert.deepEqual(exhausted.round.awardedTo, [userB.id]);
    assert.equal(exhausted.round.setWinnerId, userB.id, "the awarded point finishes the set");
    assert.equal(exhausted.match.setWins[userB.id], 1);
    assert.equal(scoreOf(exhausted, userB.id), 2);

    const matchEnd = await a.nextState((state) => state.status === "matchEnd");
    assert.equal(matchEnd.match.winnerId, userB.id);
    assert.equal(matchEnd.match.forfeitById, null);
  } finally {
    if (duel) await closeAll(duel.clients);
    await ts.close();
  }
});

test("team2v2: a 6th-row award can finish a team set", async () => {
  const ts = await startTestServer({
    chooseAnswer: () => ANSWER,
    config: { pointsToWin: 2, pointLead: 1, countdownMs: 15, roundEndMs: 15, setEndDelayMs: 15 },
  });
  let team: Awaited<ReturnType<typeof startTeamDuo>> | null = null;
  try {
    team = await startTeamDuo(ts, 1);
    const { a, b } = team;
    // A (host) scores one team point.
    a.send({ type: "room.guess", word: ANSWER });
    await a.nextState((state) => state.round.status === "ended" && state.round.index === 1);
    await b.nextState(
      (state) => state.status === "playing" && state.round.status === "playing" && state.round.index === 2,
    );
    // B's 6th miss awards A's team +1 -> 2:0 set, match.
    let exhausted: RoomState | null = null;
    for (let index = 0; index < WRONG_WORDS.length; index += 1) {
      b.send({ type: "room.guess", word: WRONG_WORDS[index] });
      const state = await b.nextState((current) => current.round.rows.length === index + 1);
      if (index === WRONG_WORDS.length - 1) exhausted = state;
    }
    assert.ok(exhausted);
    assert.equal(exhausted.round.result, "exhausted");
    assert.equal(exhausted.round.awardedTeam, "A");
    assert.equal(exhausted.round.setWinnerTeam, "A");
    assert.equal(exhausted.match.setWins.A, 1);
    assert.deepEqual(exhausted.teamScores, { A: 2, B: 0 });

    const matchEnd = await a.nextState((state) => state.status === "matchEnd");
    assert.equal(matchEnd.match.winnerTeam, "A");
  } finally {
    if (team) await closeAll(team.clients);
    await ts.close();
  }
});

test("ffa3: awarded points can reach the 7-point target", async () => {
  const ts = await startTestServer({
    chooseAnswer: () => ANSWER,
    config: { ffaTargetScore: 2, countdownMs: 15, roundEndMs: 15 },
  });
  let ffa: Awaited<ReturnType<typeof startFfaQueue>> | null = null;
  try {
    ffa = await startFfaQueue(ts, 2);
    const [c0, c1] = ffa.clients;
    const [u0, , u2] = ffa.users;
    // p0 scores the first point.
    c0.send({ type: "room.guess", word: ANSWER });
    await c0.nextState((state) => state.round.status === "ended" && state.round.index === 1);
    await c1.nextState(
      (state) => state.status === "playing" && state.round.status === "playing" && state.round.index === 2,
    );
    // p1 burns six rows: p0 and p2 are awarded +1 -> p0 reaches 2 and wins.
    let exhausted: RoomState | null = null;
    for (let index = 0; index < WRONG_WORDS.length; index += 1) {
      c1.send({ type: "room.guess", word: WRONG_WORDS[index] });
      const state = await c1.nextState(
        (current) => current.round.index === 2 && current.round.rows.length === index + 1,
      );
      if (index === WRONG_WORDS.length - 1) exhausted = state;
    }
    assert.ok(exhausted);
    assert.equal(exhausted.round.result, "exhausted");
    assert.deepEqual(new Set(exhausted.round.awardedTo), new Set([u0.id, u2.id]));
    assert.equal(scoreOf(exhausted, u0.id), 2);

    const matchEnd = await c0.nextState((state) => state.status === "matchEnd");
    assert.equal(matchEnd.match.winnerId, u0.id);
    assert.equal(matchEnd.match.isDraw, false);
  } finally {
    if (ffa) await closeAll(ffa.clients);
    await ts.close();
  }
});

test("idle timeout ends the round without points; a valid guess resets the countdown", async () => {
  const ts = await startTestServer({
    chooseAnswer: () => ANSWER,
    config: { idleTimeoutMs: 300, countdownMs: 15, roundEndMs: 15 },
  });
  let duel: Duel | null = null;
  try {
    duel = await startDuelRoom(ts, 1);
    const { a } = duel;
    const initial = a.lastState();
    assert.ok(initial);
    const initialEndsAt = initial!.round.endsAt;
    assert.ok(initialEndsAt > Date.now(), "endsAt is the next idle deadline");
    await sleep(140);
    a.send({ type: "room.guess", word: WRONG_WORDS[0] });
    const afterGuess = await a.nextState((state) => state.round.rows.length === 1);
    assert.ok(afterGuess.round.endsAt > initialEndsAt, "valid guess pushes the idle deadline");

    const timeout = await a.nextState((state) => state.round.status === "ended", 2_000);
    assert.equal(timeout.round.result, "timeout");
    assert.equal(timeout.round.answer, ANSWER);
    assert.equal(timeout.round.awardedTo.length, 0);
    for (const player of timeout.players) assert.equal(player.score, 0, "timeouts award nothing");

    // The next round starts with a fresh idle deadline.
    const nextRound = await a.nextState(
      (state) => state.status === "playing" && state.round.status === "playing" && state.round.index === 2,
      2_000,
    );
    assert.ok(nextRound.round.endsAt > Date.now() - 1_000);
    assert.equal(nextRound.round.answer, null);
  } finally {
    if (duel) await closeAll(duel.clients);
    await ts.close();
  }
});

test("1v1 set rules: 3 points / lead 2 covers 3:1, 3:3, 5:3 and best-of-3 sets", async () => {
  const ts = await startTestServer({
    chooseAnswer: () => ANSWER,
    config: { pointsToWin: 3, pointLead: 2, countdownMs: 15, roundEndMs: 15, setEndDelayMs: 15 },
  });
  let duel: Duel | null = null;
  try {
    duel = await startDuelRoom(ts, 3);
    const { a, b, userA, userB } = duel;

    let round = 1;
    let first = true;
    async function waitPlaying(): Promise<RoomState> {
      return a.nextState(
        (state) => state.status === "playing" && state.round.status === "playing" && state.round.index === round,
      );
    }
    async function point(who: "a" | "b"): Promise<RoomState> {
      if (!first) await waitPlaying();
      first = false;
      const client = who === "a" ? a : b;
      client.send({ type: "room.guess", word: ANSWER });
      const state = await client.nextState(
        (current) => current.round.status === "ended" && current.round.index === round,
      );
      round += 1;
      return state;
    }

    // ---- set 1: A wins 3:1
    const s1 = [await point("a"), await point("a"), await point("b"), await point("a")];
    assert.deepEqual(s1.map((state) => [scoreOf(state, userA.id), scoreOf(state, userB.id)]), [
      [1, 0],
      [2, 0],
      [2, 1],
      [3, 1],
    ]);
    assert.equal(s1[3].round.answer, ANSWER);
    assert.equal(s1[3].match.setWins[userA.id], 1, "3:1 wins the set");
    assert.equal(s1[3].match.setWins[userB.id], 0);
    assert.equal(s1[3].round.setWinnerId, userA.id);
    assert.equal(s1[3].status, "roundEnd");

    // ---- set 2 starts with cleared points but keeps the big score
    const secondSet = await waitPlaying();
    assert.equal(secondSet.match.setNumber, 2);
    assert.equal(secondSet.match.setWins[userA.id], 1, "big score survives the set switch");
    assert.equal(scoreOf(secondSet, userA.id), 0);
    assert.equal(scoreOf(secondSet, userB.id), 0);
    assert.equal(secondSet.round.index, 5, "round numbers keep counting across sets");
    first = true; // the state above is already the playing state for this round

    // ---- set 2: trade to 3:3, then A pulls away 5:3
    const s2 = [await point("a"), await point("b"), await point("a"), await point("b"), await point("a"), await point("b")];
    assert.deepEqual([scoreOf(s2[5], userA.id), scoreOf(s2[5], userB.id)], [3, 3], "3:3 does not win the set");
    assert.equal(s2[5].match.setWins[userA.id], 1, "no set win at 3:3");
    const s2a = await point("a");
    assert.deepEqual([scoreOf(s2a, userA.id), scoreOf(s2a, userB.id)], [4, 3], "4:3 only leads by one");
    const s2b = await point("a");
    assert.deepEqual([scoreOf(s2b, userA.id), scoreOf(s2b, userB.id)], [5, 3], "5:3 wins after the deuce");
    assert.equal(s2b.match.setWins[userA.id], 2);

    const matchEnd = await a.nextState((state) => state.status === "matchEnd");
    assert.equal(matchEnd.match.winnerId, userA.id);
    assert.equal(matchEnd.match.isDraw, false);
    assert.equal(matchEnd.match.bestOf, 3);
    assert.equal(matchEnd.match.setsToWin, 2);
    assert.equal(matchEnd.match.setNumber, 2);
    assert.equal(matchEnd.match.roundNumber, 12);
    assert.equal(matchEnd.match.setWins[userA.id], 2);
    assert.equal(matchEnd.match.setWins[userB.id], 0);

    const recent = await getJson<{ matches: MatchSummary[] }>(ts.base, "/api/matches/recent");
    assert.equal(recent.matches.length, 1);
    assert.equal(recent.matches[0].winnerName, userA.name);
    assert.equal(recent.matches[0].rounds, 12);
    assert.equal(recent.matches[0].isDraw, false);
  } finally {
    if (duel) await closeAll(duel.clients);
    await ts.close();
  }
});

test("1v1 production defaults: 11 points with a 2 point lead wins the set", async () => {
  const ts = await startTestServer({
    chooseAnswer: () => ANSWER,
    config: {
      pointsToWin: DUEL_POINTS_TO_WIN,
      pointLead: DUEL_POINT_LEAD,
      countdownMs: 10,
      roundEndMs: 5,
      setEndDelayMs: 5,
    },
  });
  let duel: Duel | null = null;
  try {
    duel = await startDuelRoom(ts, 1);
    const { a, userA } = duel;
    const start = a.lastState();
    assert.equal(start?.match.pointsToWin, 11);
    assert.equal(start?.match.pointLead, 2);

    for (let round = 1; round <= 11; round += 1) {
      if (round > 1) {
        await a.nextState(
          (state) => state.status === "playing" && state.round.status === "playing" && state.round.index === round,
        );
      }
      a.send({ type: "room.guess", word: ANSWER });
      const ended = await a.nextState(
        (state) => state.round.status === "ended" && state.round.index === round,
      );
      assert.equal(ended.round.answer, ANSWER);
      assert.equal(scoreOf(ended, userA.id), round);
      assert.equal(ended.match.setWins[userA.id], round === 11 ? 1 : 0);
    }
    const matchEnd = await a.nextState((state) => state.status === "matchEnd");
    assert.equal(matchEnd.match.winnerId, userA.id);
    assert.equal(matchEnd.match.roundNumber, 11);
    assert.equal(matchEnd.match.setWins[userA.id], 1);
  } finally {
    if (duel) await closeAll(duel.clients);
    await ts.close();
  }
});

test("team2v2 set rules: multiple sets clear team scores and keep the big score", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER });
  let team: Awaited<ReturnType<typeof startTeamDuo>> | null = null;
  try {
    team = await startTeamDuo(ts, 3);
    const { a } = team;
    for (let round = 1; round <= 2; round += 1) {
      if (round > 1) {
        await a.nextState(
          (state) => state.status === "playing" && state.round.status === "playing" && state.round.index === round,
        );
      }
      a.send({ type: "room.guess", word: ANSWER });
      await a.nextState((state) => state.round.status === "ended" && state.round.index === round);
    }
    const firstSet = await a.nextState((state) => state.status === "playing" && state.match.setNumber === 2);
    assert.equal(firstSet.match.setWins.A, 1);
    assert.deepEqual(firstSet.teamScores, { A: 0, B: 0 }, "team scores reset between sets");
    assert.equal(firstSet.players.every((player) => player.score === 0), true);

    for (let round = 3; round <= 4; round += 1) {
      a.send({ type: "room.guess", word: ANSWER });
      await a.nextState((state) => state.round.status === "ended" && state.round.index === round);
      if (round < 4) {
        await a.nextState(
          (state) => state.status === "playing" && state.round.status === "playing" && state.round.index === round + 1,
        );
      }
    }
    const matchEnd = await a.nextState((state) => state.status === "matchEnd");
    assert.equal(matchEnd.match.winnerTeam, "A");
    assert.equal(matchEnd.match.setWins.A, 2);
    assert.equal(matchEnd.match.roundNumber, 4);
  } finally {
    if (team) await closeAll(team.clients);
    await ts.close();
  }
});

test("duel validates bestOf (1/3/5/7); team2v2 accepts it and ffa3 ignores it", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER });
  const clients: TestClient[] = [];
  try {
    const g1 = await guest(ts.base, "房主一");
    const g2 = await guest(ts.base, "房主二");
    const g3 = await guest(ts.base, "房主三");
    const g4 = await guest(ts.base, "房主四");
    const c1 = await connectClient(ts.wsBase, g1.token);
    clients.push(c1);
    const c2 = await connectClient(ts.wsBase, g2.token);
    clients.push(c2);
    const c3 = await connectClient(ts.wsBase, g3.token);
    clients.push(c3);
    const c4 = await connectClient(ts.wsBase, g4.token);
    clients.push(c4);

    c1.send({ type: "room.create", mode: "duel", visibility: "public", bestOf: 5 });
    const bestOfFive = await c1.nextState((state) => state.players.length === 1);
    assert.equal(bestOfFive.match.bestOf, 5);
    assert.equal(bestOfFive.match.setsToWin, 3);

    c2.send({ type: "room.create", mode: "duel", visibility: "public", bestOf: 4 });
    assert.match(await c2.nextError(), /1、3、5 或 7/);

    // A lone host now keeps their waiting room; use fresh hosts for the other modes.
    c3.send({ type: "room.create", mode: "team2v2", visibility: "public", bestOf: 7 });
    const team = await c3.nextState((state) => state.mode === "team2v2" && state.players.length === 1);
    assert.equal(team.match.bestOf, 7);
    assert.equal(team.match.setsToWin, 4);

    c4.send({ type: "room.create", mode: "ffa3", visibility: "public", bestOf: 7 });
    const ffa = await c4.nextState((state) => state.mode === "ffa3" && state.players.length === 1);
    assert.equal(ffa.match.bestOf, 1);
    assert.equal(ffa.match.setsToWin, 1);
    assert.equal(ffa.match.targetScore, 2, "accelerated test config");
  } finally {
    await closeAll(clients);
    await ts.close();
  }
});

test("duel rematch clears the big score and keeps the selected bestOf", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER });
  let duel: Duel | null = null;
  try {
    duel = await startDuelRoom(ts, 5);
    const { a, userA } = duel;
    // bestOf=5 -> 3 sets; 2 points per set with the accelerated config -> 6 rounds.
    for (let round = 1; round <= 6; round += 1) {
      if (round > 1) {
        await a.nextState(
          (state) => state.status === "playing" && state.round.status === "playing" && state.round.index === round,
        );
      }
      a.send({ type: "room.guess", word: ANSWER });
      await a.nextState((state) => state.round.status === "ended" && state.round.index === round);
    }
    const matchEnd = await a.nextState((state) => state.status === "matchEnd");
    assert.equal(matchEnd.match.bestOf, 5);
    assert.equal(matchEnd.match.setsToWin, 3);
    assert.equal(matchEnd.match.setWins[userA.id], 3);

    a.send({ type: "room.rematch" });
    const waiting = await a.nextState((state) => state.status === "waiting");
    assert.equal(waiting.match.bestOf, 5);
    assert.equal(waiting.match.setsToWin, 3);
    assert.equal(waiting.match.setNumber, 1);
    assert.equal(waiting.match.roundNumber, 0);
    assert.deepEqual(waiting.match.setWins, { [userA.id]: 0, [duel.userB.id]: 0 });
    assert.equal(waiting.players.find((player) => player.isHost)?.ready, true);
    assert.equal(waiting.players.filter((player) => !player.isHost).every((player) => !player.ready), true);
  } finally {
    if (duel) await closeAll(duel.clients);
    await ts.close();
  }
});

test("host is auto-ready and room.start requires only the other players to be ready", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER });
  const clients: TestClient[] = [];
  try {
    const hostUser = await guest(ts.base, "免准备房主");
    const guestUser = await guest(ts.base, "需要准备");
    const host = await connectClient(ts.wsBase, hostUser.token);
    clients.push(host);
    const player = await connectClient(ts.wsBase, guestUser.token);
    clients.push(player);

    host.send({ type: "room.create", mode: "duel", visibility: "public" });
    const created = await host.nextState((state) => state.players.length === 1);
    assert.equal(created.players[0].ready, true);
    player.send({ type: "room.join", code: created.code });
    await host.nextState((state) => state.players.length === 2);

    host.send({ type: "room.start" });
    assert.match(await host.nextError(), /没有准备/);

    // Host clicking ready is a no-op and keeps the host ready.
    host.send({ type: "room.ready", ready: false });
    await host.nextState((state) => state.players.find((candidate) => candidate.isHost)?.ready === true);

    player.send({ type: "room.ready", ready: true });
    await host.nextState((state) => state.status === "waiting" && state.players.every((candidate) => candidate.ready));
    host.send({ type: "room.start" });
    const playing = await host.nextState((state) => state.status === "playing");
    assert.equal(playing.players.length, 2);
  } finally {
    await closeAll(clients);
    await ts.close();
  }
});

test("leaving during a match keeps the seat and rejoining by code restores it", async () => {
  const ts = await startTestServer({
    chooseAnswer: () => ANSWER,
    config: { leaveGraceMs: 1_500 },
  });
  let duel: Duel | null = null;
  try {
    duel = await startDuelRoom(ts, 1);
    const { a, b, userA, userB, tokenA } = duel;
    assert.equal(a.lastState()?.hostId, userA.id);

    // Host disconnects mid-match: seat + host role move, but nothing is removed.
    await a.close();
    const offline = await b.nextState(
      (state) => state.players.find((player) => player.id === userA.id)?.connected === false,
    );
    const offlinePlayer = offline.players.find((player) => player.id === userA.id);
    assert.equal(offline.players.length, 2, "seat is kept during the grace period");
    assert.ok(offlinePlayer?.rejoinDeadline && offlinePlayer.rejoinDeadline > Date.now());
    assert.equal(offline.hostId, userB.id, "host transfers to the first online player");

    // Rejoin with the same token/room code restores the seat and score.
    const back = await connectClient(ts.wsBase, tokenA);
    const online = await back.nextState(
      (state) => state.players.find((player) => player.id === userA.id)?.connected === true,
    );
    assert.equal(online.players.length, 2);
    assert.equal(online.players.find((player) => player.id === userA.id)?.rejoinDeadline, null);
    assert.equal(online.hostId, userB.id, "host is not taken back");

    // Explicit leave during the match also just reserves the seat.
    back.send({ type: "room.leave" });
    const reserved = await b.nextState(
      (state) => state.players.find((player) => player.id === userA.id)?.connected === false,
    );
    assert.equal(reserved.players.length, 2);

    // The reserved seat blocks joining/creating another room until it is released.
    back.send({ type: "room.create", mode: "duel", visibility: "public" });
    assert.match(await back.nextError(), /已经在房间中/);

    back.send({ type: "room.join", code: duel.code });
    await back.nextState((state) => state.players.find((player) => player.id === userA.id)?.connected === true);
  } finally {
    if (duel) await closeAll(duel.clients);
    await ts.close();
  }
});

test("duel: seat reservation expiry forfeits the match to the opponent", async () => {
  const ts = await startTestServer({
    chooseAnswer: () => ANSWER,
    config: { leaveGraceMs: 120 },
  });
  let duel: Duel | null = null;
  try {
    duel = await startDuelRoom(ts, 1);
    const { a, b, userA, userB } = duel;
    await a.close();
    const matchEnd = await b.nextState((state) => state.status === "matchEnd", 3_000);
    assert.equal(matchEnd.match.winnerId, userB.id);
    assert.equal(matchEnd.match.isDraw, false);
    assert.equal(matchEnd.match.forfeitById, userA.id);
    assert.equal(matchEnd.match.forfeitTeam, null);
    assert.equal(matchEnd.match.setWins[userB.id], 1, "big score filled up to setsToWin");
  } finally {
    if (duel) await closeAll(duel.clients);
    await ts.close();
  }
});

test("team2v2: seat reservation expiry forfeits the match to the opponent team", async () => {
  const ts = await startTestServer({
    chooseAnswer: () => ANSWER,
    config: { leaveGraceMs: 120, defaultBestOf: 1 },
  });
  let team: Awaited<ReturnType<typeof startTeamDuo>> | null = null;
  try {
    team = await startTeamDuo(ts, 1);
    const { a, b, userA } = team;
    await a.close();
    const matchEnd = await b.nextState((state) => state.status === "matchEnd", 3_000);
    assert.equal(matchEnd.match.winnerTeam, "B");
    assert.equal(matchEnd.match.isDraw, false);
    assert.equal(matchEnd.match.forfeitById, userA.id);
    assert.equal(matchEnd.match.forfeitTeam, "B");
    assert.equal(matchEnd.match.setWins.B, matchEnd.match.setsToWin);
  } finally {
    if (team) await closeAll(team.clients);
    await ts.close();
  }
});

test("ffa3: expired seats remove players; the last remaining player wins", async () => {
  const ts = await startTestServer({
    chooseAnswer: () => ANSWER,
    config: { leaveGraceMs: 150, ffaTargetScore: 7 },
  });
  let ffa: Awaited<ReturnType<typeof startFfaQueue>> | null = null;
  try {
    ffa = await startFfaQueue(ts);
    const [c0, c1, c2] = ffa.clients;
    const [u0, u1, u2] = ffa.users;
    await c0.close();
    const afterFirst = await c1.nextState(
      (state) => state.players.length === 2 && !state.players.some((player) => player.id === u0.id),
      3_000,
    );
    assert.notEqual(afterFirst.status, "matchEnd", "two players remain, the match continues");
    await c1.close();
    const matchEnd = await c2.nextState((state) => state.status === "matchEnd", 3_000);
    assert.equal(matchEnd.match.winnerId, u2.id);
    assert.equal(matchEnd.match.isDraw, false);
    assert.equal(matchEnd.match.forfeitById, u1.id);
    assert.equal(matchEnd.players.length, 1);
    await c2.next((message) => message.type === "toast" || message.type === "state");
  } finally {
    if (ffa) await closeAll(ffa.clients);
    await ts.close();
  }
});

test("waiting-room leave removes the player immediately and transfers host", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER, config: { leaveGraceMs: 60 } });
  const clients: TestClient[] = [];
  try {
    const hostUser = await guest(ts.base, "等待房主");
    const guestUser = await guest(ts.base, "等待玩家");
    const host = await connectClient(ts.wsBase, hostUser.token);
    clients.push(host);
    const player = await connectClient(ts.wsBase, guestUser.token);
    clients.push(player);
    host.send({ type: "room.create", mode: "duel", visibility: "public" });
    const created = await host.nextState((state) => state.players.length === 1);
    player.send({ type: "room.join", code: created.code });
    await host.nextState((state) => state.players.length === 2);

    host.send({ type: "room.leave" });
    const transferred = await player.nextState((state) => state.players.length === 1 && state.hostId === guestUser.user.id);
    assert.equal(transferred.players[0].isHost, true);
    assert.equal(transferred.players[0].ready, true, "new host is auto-ready");

    // The last host leaves: the seat is reserved instead of the room dying at once.
    player.send({ type: "room.leave" });
    const reserved = await player.nextState(
      (state) => state.players.length === 1 && state.players[0].connected === false,
    );
    assert.ok(reserved.players[0].rejoinDeadline);
    const roomsDuringGrace = await getJson<{ rooms: Array<{ code: string; playerCount: number }> }>(ts.base, "/api/rooms");
    assert.equal(roomsDuringGrace.rooms.find((room) => room.code === created.code)?.playerCount, 1);
    await sleep(100);
    const roomsAfterGrace = await getJson<{ rooms: Array<{ code: string }> }>(ts.base, "/api/rooms");
    assert.equal(roomsAfterGrace.rooms.some((room) => room.code === created.code), false, "room is destroyed after grace");
  } finally {
    await closeAll(clients);
    await ts.close();
  }
});

test("guessMode standard vs free", async () => {
  const ts = await startTestServer({
    chooseAnswer: () => ANSWER,
    config: { pointsToWin: 1, pointLead: 1, leaveGraceMs: 60 },
  });
  const clients: TestClient[] = [];
  try {
    const hostUser = await guest(ts.base, "模式房主");
    const guestUser = await guest(ts.base, "模式玩家");
    const host = await connectClient(ts.wsBase, hostUser.token);
    clients.push(host);
    const player = await connectClient(ts.wsBase, guestUser.token);
    clients.push(player);

    // ---- standard room rejects non-dictionary words
    host.send({ type: "room.create", mode: "duel", visibility: "public", bestOf: 1 });
    const standard = await host.nextState((state) => state.players.length === 1);
    assert.equal(standard.guessMode, "standard");
    player.send({ type: "room.join", code: standard.code });
    await host.nextState((state) => state.players.length === 2);
    player.send({ type: "room.ready", ready: true });
    await host.nextState((state) => state.status === "waiting" && state.players.every((candidate) => candidate.ready));
    host.send({ type: "room.start" });
    await host.nextState((state) => state.status === "playing");
    player.send({ type: "room.guess", word: "天天天天" });
    assert.match(await player.nextError(), /词库/);

    // finish the match quickly so the room can be cleared
    player.send({ type: "room.guess", word: ANSWER });
    await host.nextState((state) => state.status === "matchEnd");
    host.send({ type: "room.rematch" });
    await host.nextState((state) => state.status === "waiting");
    host.send({ type: "room.leave" });
    // The host is removed from the waiting room; the remaining player keeps it alive.
    const remainingRoom = await player.nextState((state) => state.players.length === 1);
    assert.equal(remainingRoom.players[0].isHost, true);
    player.send({ type: "room.leave" });
    // The lone host now keeps a reserved seat until the grace window ends.
    await player.nextState((state) => state.players.length === 1 && state.players[0].connected === false);
    await sleep(100);

    // ---- free room accepts any renderable four-character word
    host.send({ type: "room.create", mode: "duel", visibility: "public", bestOf: 1, guessMode: "free" });
    const free = await host.nextState((state) => state.players.length === 1 && state.guessMode === "free");
    assert.equal(free.guessMode, "free");
    player.send({ type: "room.join", code: free.code });
    await host.nextState((state) => state.code === free.code && state.players.length === 2);
    player.send({ type: "room.ready", ready: true });
    await host.nextState(
      (state) => state.code === free.code && state.status === "waiting" && state.players.every((candidate) => candidate.ready),
    );
    host.send({ type: "room.start" });
    const freePlaying = await host.nextState(
      (state) => state.code === free.code && state.status === "playing" && state.round.status === "playing",
    );
    assert.equal(freePlaying.guessMode, "free");
    player.send({ type: "room.guess", word: "天天天天" });
    const freeRow = await player.nextState(
      (state) => state.code === free.code && state.round.rows.length === 1,
    );
    const row = freeRow.round.rows[0];
    assert.equal(row.word, "天天天天");
    assert.equal(row.correct, false);
    assert.equal(freeRow.round.answer, null);
    player.send({ type: "room.guess", word: "abcdef" });
    assert.match(await player.nextError(), /汉字/);

    const rooms = await getJson<{ rooms: Array<{ code: string; guessMode: string }> }>(ts.base, "/api/rooms");
    assert.equal(rooms.rooms.find((room) => room.code === free.code)?.guessMode, "free");
  } finally {
    await closeAll(clients);
    await ts.close();
  }
});

test("registered players accumulate per-mode statistics and /api/stats/me returns them", async () => {
  const ts = await startTestServer({
    chooseAnswer: () => ANSWER,
    config: { defaultBestOf: 1 },
  });
  const clients: TestClient[] = [];
  try {
    const winner = await register(ts.base, "stats_win", "secret1", "统计胜者");
    const loser = await register(ts.base, "stats_lose", "secret1", "统计败者");
    const c1 = await connectClient(ts.wsBase, winner.token);
    clients.push(c1);
    const c2 = await connectClient(ts.wsBase, loser.token);
    clients.push(c2);
    c1.send({ type: "queue.join", mode: "duel" });
    c2.send({ type: "queue.join", mode: "duel" });
    await c1.next((message) => message.type === "match.found");
    await c2.next((message) => message.type === "match.found");
    await c1.nextState((state) => state.status === "waiting" && state.requiresAgreement === true);
    await c2.nextState((state) => state.status === "waiting" && state.requiresAgreement === true);
    await proposeAndAgreeRules(c1, [c2], {
      bestOf: 1,
      guessMode: "free",
      dictionary: "common",
      pointsToWin: 2,
    });
    c1.send({ type: "room.start" });
    await c1.nextState((state) => state.status === "playing");
    // Ensure the recorded solve timestamps are non-zero even on a fast CI machine.
    await sleep(5);

    // The loser guesses once in round 1; the winner takes both points (bestOf=1 -> match ends).
    c2.send({ type: "room.guess", word: WRONG_WORDS[0] });
    await c2.nextState((state) => state.round.rows.length === 1);
    for (let round = 1; round <= 2; round += 1) {
      if (round > 1) {
        await c1.nextState(
          (state) => state.status === "playing" && state.round.status === "playing" && state.round.index === round,
        );
      }
      c1.send({ type: "room.guess", word: ANSWER });
      await c1.nextState((state) => state.round.status === "ended" && state.round.index === round);
    }
    await c1.nextState((state) => state.status === "matchEnd");

    const stats = await getJson<StatsResponse>(ts.base, "/api/stats/me", winner.token);
    const duel = stats.modes.duel;
    assert.equal(duel.matches, 1);
    assert.equal(duel.wins, 1);
    assert.equal(duel.losses, 0);
    assert.ok(duel.rounds >= 2, `rounds=${duel.rounds}`);
    assert.equal(duel.guesses, 2);
    assert.equal(duel.solves, 2);
    assert.equal(duel.points, 2);
    assert.equal(duel.setsWon, 1);
    assert.ok(duel.fastestSolveMs > 0, "solve time is recorded");
    assert.ok(duel.avgSolveMs > 0);
    assert.ok(duel.winRate > 0.99);
    assert.ok(duel.solveRate > 0);
    assert.ok(duel.guessAccuracy > 0);
    assert.equal(duel.fastestMatchAwards, 1, "fastest average solve in the match");
    assert.equal(stats.total.matches, 1);

    const loserStats = await getJson<StatsResponse>(ts.base, "/api/stats/me", loser.token);
    assert.equal(loserStats.modes.duel.matches, 1);
    assert.equal(loserStats.modes.duel.losses, 1);
    assert.equal(loserStats.modes.duel.guesses, 1);
    assert.equal(loserStats.modes.duel.solves, 0);

    // Guests do not have persistent stats.
    const guestSession = await guest(ts.base, "游客统计");
    const guestResponse = await fetch(`${ts.base}/api/stats/me`, {
      headers: { authorization: `Bearer ${guestSession.token}` },
    });
    assert.equal(guestResponse.status, 401);
  } finally {
    await closeAll(clients);
    await ts.close();
  }
});
