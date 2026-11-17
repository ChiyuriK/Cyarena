import test from "node:test";
import assert from "node:assert/strict";
import type { LeaderboardRow, MatchSummary, RoomState } from "../../../packages/shared/src/index.ts";
import { explanationFor, loadGameData } from "../../../packages/engine/src/index.ts";
import {
  closeAll,
  connectClient,
  getJson,
  guest,
  proposeAndAgreeRules,
  register,
  sleep,
  startTestServer,
} from "./helpers.ts";
import type { TestClient, TestServer } from "./helpers.ts";

const ANSWER = "画蛇添足";

interface ManualDuel {
  host: TestClient;
  guest: TestClient;
  clients: TestClient[];
  users: Array<{ id: string; name: string }>;
  state: RoomState;
}

async function startManualDuel(
  ts: TestServer,
  create: {
    bestOf?: number;
    guessMode?: "standard" | "free";
    dictionary?: "common" | "all";
    pointsToWin?: number;
  } = {},
): Promise<ManualDuel> {
  const clients: TestClient[] = [];
  const hostUser = await guest(ts.base, "规则房主");
  const guestUser = await guest(ts.base, "规则玩家");
  const host = await connectClient(ts.wsBase, hostUser.token);
  clients.push(host);
  const guestClient = await connectClient(ts.wsBase, guestUser.token);
  clients.push(guestClient);
  host.send({ type: "room.create", mode: "duel", visibility: "private", ...create });
  const created = await host.nextState((state) => state.players.length === 1);
  guestClient.send({ type: "room.join", code: created.code });
  await host.nextState((state) => state.players.length === 2);
  await guestClient.nextState((state) => state.players.length === 2);
  guestClient.send({ type: "room.ready", ready: true });
  await host.nextState((state) => state.status === "waiting" && state.players.every((player) => player.ready));
  host.send({ type: "room.start" });
  await host.nextState((state) => state.status === "countdown");
  const state = await host.nextState((state) => state.status === "playing" && state.round.status === "playing");
  await guestClient.nextState((state) => state.status === "playing" && state.round.status === "playing");
  return { host, guest: guestClient, clients, users: [hostUser.user, guestUser.user], state };
}

function scoreOf(state: RoomState, userId: string): number {
  return state.players.find((player) => player.id === userId)?.score ?? 0;
}

interface MatchHistoryFixture {
  mode: string;
  opponentNames: string[];
  winnerName: string;
  winnerTeam: "A" | "B" | null;
  isDraw: boolean;
  forfeit: boolean;
  setWins: Record<string, number>;
  setHistory: Array<{ setNumber: number; scores: Record<string, number>; teamScores: Record<string, number> }>;
  players: Array<{
    id: string;
    name: string;
    avatar: string;
    team: "A" | "B" | null;
    score: number;
    setWins: number;
    ratingBefore?: number;
    ratingAfter?: number;
    ratingDelta?: number;
  }>;
  smallScores: Record<string, number>;
  ratingBefore: number | null;
  ratingAfter: number | null;
  ratingDelta: number | null;
}

test("quick match: default rules, proposal/accept and best-of-1 lock", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER });
  const clients: TestClient[] = [];
  try {
    const u1 = await guest(ts.base, "匹配甲");
    const u2 = await guest(ts.base, "匹配乙");
    const c1 = await connectClient(ts.wsBase, u1.token);
    clients.push(c1);
    const c2 = await connectClient(ts.wsBase, u2.token);
    clients.push(c2);
    c1.send({ type: "queue.join", mode: "duel" });
    c2.send({ type: "queue.join", mode: "duel" });
    await c1.next((message) => message.type === "match.found");
    await c2.next((message) => message.type === "match.found");
    const waiting = await c1.nextState((state) => state.status === "waiting" && state.requiresAgreement === true);
    await c2.nextState((state) => state.status === "waiting" && state.requiresAgreement === true);
    assert.deepEqual(waiting.rules, { bestOf: 1, guessMode: "free", dictionary: "common", pointsToWin: 11 });
    assert.equal(waiting.rulesAgreed, false);
    assert.equal(waiting.proposal, null);
    assert.equal(waiting.players.every((player) => player.ready), true, "quick match auto-readies");

    c1.send({ type: "room.start" });
    assert.match(await c1.nextError(), /确认规则/);

    // The guest (non-host) may propose; the proposal keeps best-of at 1.
    c2.send({
      type: "room.proposeRules",
      rules: { bestOf: 3, guessMode: "free", dictionary: "common", pointsToWin: 1 },
    });
    const proposalState = await c1.nextState((state) => state.proposal !== null);
    assert.equal(proposalState.proposal!.proposerName, u2.user.name);
    assert.equal(proposalState.proposal!.rules.bestOf, 1, "quick match stays best-of-1");
    assert.equal(proposalState.proposal!.rules.pointsToWin, 1);
    c1.send({ type: "room.acceptRules", proposalId: proposalState.proposal!.id });
    const agreed = await c1.nextState((state) => state.rulesAgreed === true);
    assert.equal(agreed.rules.bestOf, 1);
    assert.equal(agreed.rules.pointsToWin, 1);
    assert.equal(agreed.proposal, null);
    c1.send({ type: "room.start" });
    const playing = await c1.nextState((state) => state.status === "playing" && state.round.status === "playing");
    assert.equal(playing.match.bestOf, 1);
    assert.equal(playing.match.pointsToWin, 1);

    // Win the single point, then rematch keeps the agreed rules and agreement.
    c1.send({ type: "room.guess", word: ANSWER });
    const ended = await c1.nextState((state) => state.round.status === "ended");
    assert.equal(ended.match.setWins[u1.user.id], 1);
    const matchEnd = await c1.nextState((state) => state.status === "matchEnd");
    assert.equal(matchEnd.match.winnerId, u1.user.id);
    c1.send({ type: "room.rematch" });
    const again = await c1.nextState((state) => state.status === "waiting");
    assert.deepEqual(again.rules, { bestOf: 1, guessMode: "free", dictionary: "common", pointsToWin: 1 });
    assert.equal(again.rulesAgreed, true, "agreement survives a rematch");
    c1.send({ type: "room.start" });
    const secondMatch = await c1.nextState((state) => state.status === "playing" && state.round.status === "playing");
    assert.equal(secondMatch.match.pointsToWin, 1);
  } finally {
    await closeAll(clients);
    await ts.close();
  }
});

test("quick match: counter proposal replaces the proposal and resets acceptance", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER });
  const clients: TestClient[] = [];
  try {
    const users = [
      await guest(ts.base, "反提议甲"),
      await guest(ts.base, "反提议乙"),
      await guest(ts.base, "反提议丙"),
    ];
    for (const user of users) clients.push(await connectClient(ts.wsBase, user.token));
    const [c0, c1, c2] = clients;
    for (const client of clients) client.send({ type: "queue.join", mode: "ffa3" });
    await Promise.all(clients.map((client) => client.next((message) => message.type === "match.found")));
    await Promise.all(
      clients.map((client) =>
        client.nextState((state) => state.status === "waiting" && state.requiresAgreement === true),
      ),
    );

    c0.send({
      type: "room.proposeRules",
      rules: { bestOf: 1, guessMode: "free", dictionary: "common", pointsToWin: 7 },
    });
    const first = await c0.nextState((state) => state.proposal !== null);
    const firstId = first.proposal!.id;
    // The proposer cannot counter their own proposal.
    c0.send({
      type: "room.counterRules",
      rules: { bestOf: 1, guessMode: "free", dictionary: "common", pointsToWin: 5 },
    });
    assert.match(await c0.nextError(), /提议者不能修改/);

    // One non-proposer accepts, then the other counters: acceptance is reset.
    c1.send({ type: "room.acceptRules", proposalId: firstId });
    await c0.nextState((state) => state.proposal?.id === firstId && state.rulesAgreed === false);
    c2.send({
      type: "room.counterRules",
      rules: { bestOf: 1, guessMode: "standard", dictionary: "all", pointsToWin: 15 },
    });
    const countered = await c0.nextState((state) => state.proposal !== null && state.proposal.id !== firstId);
    assert.equal(countered.proposal!.proposerId, users[2].user.id);
    assert.equal(countered.rules.pointsToWin, 11, "rules are not applied until agreement");
    assert.equal(countered.rulesAgreed, false);
    const counterId = countered.proposal!.id;

    // Both non-proposers of the new proposal must accept it.
    c0.send({ type: "room.acceptRules", proposalId: counterId });
    c1.send({ type: "room.acceptRules", proposalId: counterId });
    const agreed = await c0.nextState((state) => state.rulesAgreed === true);
    assert.deepEqual(agreed.rules, { bestOf: 1, guessMode: "standard", dictionary: "all", pointsToWin: 15 });
    c0.send({ type: "room.start" });
    const playing = await c0.nextState((state) => state.status === "playing");
    assert.equal(playing.match.targetScore, 15);
    assert.equal(playing.rules.dictionary, "all");
  } finally {
    await closeAll(clients);
    await ts.close();
  }
});

test("room.create rules: custom points, validation and dictionary scopes", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER, config: { leaveGraceMs: 30 } });
  const clients: TestClient[] = [];
  try {
    const hostUser = await guest(ts.base, "规则自定义");
    const host = await connectClient(ts.wsBase, hostUser.token);
    clients.push(host);
    for (const points of [7, 11, 15, 21, 33]) {
      host.send({ type: "room.create", mode: "duel", visibility: "private", bestOf: 1, pointsToWin: points });
      const state = await host.nextState(
        (s) => s.status === "waiting" && s.rules.pointsToWin === points && s.match.pointsToWin === points,
      );
      assert.equal(state.rules.pointsToWin, points);
      assert.equal(state.match.pointsToWin, points);
      host.send({ type: "room.leave" });
      await host.next((message) => message.type === "toast" && message.message.includes("已离开房间"));
      // A single host keeps the room for the grace window; wait it out.
      await sleep(60);
    }

    for (const bad of [0, 100, 2.5, "11"]) {
      host.send({ type: "room.create", mode: "duel", visibility: "private", pointsToWin: bad as unknown as number });
      assert.match(await host.nextError(), /目标分/);
    }
    host.send({ type: "room.create", mode: "duel", visibility: "private", dictionary: "weird" as unknown as "common" });
    assert.match(await host.nextError(), /词库/);

    host.send({ type: "room.create", mode: "duel", visibility: "private", bestOf: 1, dictionary: "all" });
    const allRoom = await host.nextState(
      (s) => s.status === "waiting" && s.rules.dictionary === "all" && s.players.length === 1,
    );
    assert.equal(allRoom.rules.dictionary, "all");
  } finally {
    await closeAll(clients);
    await ts.close();
  }
});

test("standard validation always uses the full dictionary + one-character suggestion", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER });
  let commonRoom: ManualDuel | null = null;
  try {
    commonRoom = await startManualDuel(ts, { bestOf: 1, pointsToWin: 9, dictionary: "common" });
    const { host, guest: guestClient } = commonRoom;
    assert.equal(commonRoom.state.rules.dictionary, "common");
    assert.equal(commonRoom.state.players[0].avatar, "规", "room players expose avatars");
    // Non-common idioms are accepted as guesses even in a common-answer room.
    guestClient.send({ type: "room.guess", word: "画虎类犬" });
    const accepted = await guestClient.nextState((state) => state.round.rows.length === 1);
    assert.equal(accepted.round.rows[0].word, "画虎类犬");
    assert.equal(accepted.round.rows[0].correct, false);
    // 画蛇添手 is not an idiom but differs by one character from 画蛇添足.
    guestClient.send({ type: "room.guess", word: "画蛇添手" });
    const hint = await guestClient.nextError();
    assert.match(hint, /你是否要输入「/);
    assert.equal((hint.match(/「/g) ?? []).length, 1, "only one suggestion");
    assert.match(hint, /」？$/);
    host.send({ type: "room.leave" });
    await host.next((message) => message.type === "toast");
  } finally {
    if (commonRoom) await closeAll(commonRoom.clients);
    await ts.close();
  }

  const ts2 = await startTestServer({ chooseAnswer: () => ANSWER });
  let allRoom: ManualDuel | null = null;
  try {
    allRoom = await startManualDuel(ts2, { bestOf: 1, pointsToWin: 9, dictionary: "all" });
    allRoom.guest.send({ type: "room.guess", word: "画虎类犬" });
    const row = await allRoom.guest.nextState((state) => state.round.rows.length === 1);
    assert.equal(row.round.rows[0].word, "画虎类犬");
    assert.equal(row.round.rows[0].correct, false);
  } finally {
    if (allRoom) await closeAll(allRoom.clients);
    await ts2.close();
  }
});

test("host can update waiting room rules; non-host, started and quick-match rooms cannot", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER });
  const clients: TestClient[] = [];
  try {
    const hostUser = await guest(ts.base, "改规则房主");
    const guestUser = await guest(ts.base, "改规则玩家");
    const host = await connectClient(ts.wsBase, hostUser.token);
    clients.push(host);
    const player = await connectClient(ts.wsBase, guestUser.token);
    clients.push(player);
    host.send({ type: "room.create", mode: "duel", visibility: "public", bestOf: 1, dictionary: "common", pointsToWin: 11 });
    const created = await host.nextState((state) => state.players.length === 1);
    player.send({ type: "room.join", code: created.code });
    await host.nextState((state) => state.players.length === 2);
    await player.nextState((state) => state.players.length === 2);

    player.send({
      type: "room.updateRules",
      rules: { bestOf: 1, guessMode: "free", dictionary: "all", pointsToWin: 15 },
    });
    assert.match(await player.nextError(), /只有房主可以修改规则/);

    host.send({
      type: "room.updateRules",
      rules: { bestOf: 1, guessMode: "free", dictionary: "all", pointsToWin: 15 },
    });
    const updated = await host.nextState((state) => state.rules.pointsToWin === 15 && state.rules.dictionary === "all");
    assert.deepEqual(updated.rules, { bestOf: 1, guessMode: "free", dictionary: "all", pointsToWin: 15 });
    assert.equal(updated.match.pointsToWin, 15);
    const listed = await getJson<{ rooms: Array<{ code: string; dictionary: string; pointsToWin: number }> }>(
      ts.base,
      "/api/rooms",
    );
    assert.equal(listed.rooms.find((room) => room.code === created.code)?.pointsToWin, 15);
    assert.equal(listed.rooms.find((room) => room.code === created.code)?.dictionary, "all");

    player.send({ type: "room.ready", ready: true });
    await host.nextState((state) => state.status === "waiting" && state.players.every((entry) => entry.ready));
    host.send({ type: "room.start" });
    await host.nextState((state) => state.status === "playing");
    host.send({
      type: "room.updateRules",
      rules: { bestOf: 1, guessMode: "free", dictionary: "common", pointsToWin: 5 },
    });
    assert.match(await host.nextError(), /比赛开始后不能修改规则/);

    // Practice rooms and quick-match rooms reject the message with their own errors.
    const practiceUser = await guest(ts.base, "改规则练习");
    const practice = await connectClient(ts.wsBase, practiceUser.token);
    clients.push(practice);
    practice.send({ type: "room.create", mode: "practice", visibility: "private" });
    await practice.nextState((state) => state.mode === "practice" && state.status === "playing");
    practice.send({
      type: "room.updateRules",
      rules: { bestOf: 1, guessMode: "free", dictionary: "all", pointsToWin: 5 },
    });
    assert.match(await practice.nextError(), /练习模式无需修改规则/);

    const q1 = await guest(ts.base, "改规则匹配甲");
    const q2 = await guest(ts.base, "改规则匹配乙");
    const c1 = await connectClient(ts.wsBase, q1.token);
    clients.push(c1);
    const c2 = await connectClient(ts.wsBase, q2.token);
    clients.push(c2);
    c1.send({ type: "queue.join", mode: "duel" });
    c2.send({ type: "queue.join", mode: "duel" });
    await c1.next((message) => message.type === "match.found");
    await c2.next((message) => message.type === "match.found");
    await c1.nextState((state) => state.status === "waiting" && state.requiresAgreement === true);
    c1.send({
      type: "room.updateRules",
      rules: { bestOf: 1, guessMode: "free", dictionary: "common", pointsToWin: 7 },
    });
    assert.match(await c1.nextError(), /快速匹配请使用规则协商/);
  } finally {
    await closeAll(clients);
    await ts.close();
  }
});

test("recentRounds keeps the last five rounds", async () => {
  const ts = await startTestServer({
    chooseAnswer: () => ANSWER,
    config: { idleTimeoutMs: 90, countdownMs: 10, roundEndMs: 10 },
  });
  let duel: ManualDuel | null = null;
  try {
    duel = await startManualDuel(ts, { bestOf: 1, pointsToWin: 99 });
    const { host } = duel;
    for (let round = 1; round <= 6; round += 1) {
      if (round > 1) {
        await host.nextState(
          (state) => state.status === "playing" && state.round.status === "playing" && state.round.index === round,
        );
      }
      const ended = await host.nextState(
        (state) => state.round.status === "ended" && state.round.index === round,
        3_000,
      );
      assert.equal(ended.round.result, "timeout");
      assert.equal(ended.round.answer, ANSWER);
    }
    const state = host.lastState()!;
    assert.equal(state.recentRounds.length, 5, "only the last five rounds are kept");
    assert.deepEqual(
      state.recentRounds.map((entry) => entry.index),
      [2, 3, 4, 5, 6],
    );
    for (const entry of state.recentRounds) {
      assert.equal(entry.answer, ANSWER);
      assert.equal(entry.explanation, explanationFor(loadGameData(), ANSWER));
      assert.ok(entry.explanation.length > 0, "recent rounds carry an explanation");
      assert.equal(entry.result, "timeout");
      assert.equal(entry.winnerId, null);
      assert.deepEqual(entry.awardedTo, []);
      assert.equal(entry.setWinnerId, null);
      assert.ok(entry.endedAt > 0);
    }
  } finally {
    if (duel) await closeAll(duel.clients);
    await ts.close();
  }
});

test("setHistory and MatchSummary carry rules, per-set scores and avatars", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER });
  let duel: ManualDuel | null = null;
  try {
    duel = await startManualDuel(ts, { bestOf: 3, pointsToWin: 2 });
    const { host, users } = duel;
    const [hostUser, guestUser] = users;
    for (let round = 1; round <= 4; round += 1) {
      if (round > 1) {
        await host.nextState(
          (state) => state.status === "playing" && state.round.status === "playing" && state.round.index === round,
        );
      }
      host.send({ type: "room.guess", word: ANSWER });
      const ended = await host.nextState((state) => state.round.status === "ended" && state.round.index === round);
      if (round === 2) {
        assert.equal(ended.match.setHistory.length, 1);
        assert.equal(ended.match.setHistory[0].setNumber, 1);
        assert.equal(ended.match.setHistory[0].winnerId, hostUser.id);
        assert.deepEqual(ended.match.setHistory[0].scores, { [hostUser.id]: 2, [guestUser.id]: 0 });
        assert.equal(ended.match.setHistory[0].pointsToWin, 2);
      }
    }
    const matchEnd = await host.nextState((state) => state.status === "matchEnd");
    assert.equal(matchEnd.match.setHistory.length, 2);
    assert.deepEqual(
      matchEnd.match.setHistory.map((entry) => entry.setNumber),
      [1, 2],
    );
    assert.equal(matchEnd.match.setWins[hostUser.id], 2);

    const recent = await getJson<{ matches: MatchSummary[] }>(ts.base, "/api/matches/recent?limit=1");
    const summary = recent.matches[0];
    assert.deepEqual(summary.rules, { bestOf: 3, guessMode: "standard", dictionary: "common", pointsToWin: 2 });
    assert.equal(summary.setHistory.length, 2);
    assert.equal(summary.forfeitById, null);
    assert.equal(summary.forfeitTeam, null);
    assert.equal(summary.players.length, 2);
    for (const player of summary.players) {
      assert.ok(player.avatar.length >= 1);
      assert.equal(typeof player.setWins, "number");
    }
    assert.equal(summary.players.find((player) => player.id === hostUser.id)?.setWins, 2);
    assert.equal(summary.players.find((player) => player.id === guestUser.id)?.setWins, 0);

    // Rematch clears histories but keeps the rules.
    host.send({ type: "room.rematch" });
    const waiting = await host.nextState((state) => state.status === "waiting");
    assert.deepEqual(waiting.match.setHistory, []);
    assert.deepEqual(waiting.recentRounds, []);
    assert.deepEqual(waiting.rules, summary.rules);
  } finally {
    if (duel) await closeAll(duel.clients);
    await ts.close();
  }
});

test("leaderboard rows include avatars", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER });
  const clients: TestClient[] = [];
  try {
    const a = await register(ts.base, "avatar_a", "secret1", "头像甲");
    const b = await register(ts.base, "avatar_b", "secret1", "头像乙");
    const c1 = await connectClient(ts.wsBase, a.token);
    clients.push(c1);
    const c2 = await connectClient(ts.wsBase, b.token);
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
      pointsToWin: 1,
    });
    c1.send({ type: "room.start" });
    await c1.nextState((state) => state.status === "playing");
    c1.send({ type: "room.guess", word: ANSWER });
    await c1.nextState((state) => state.status === "matchEnd");
    const ladder = await getJson<{ rows: LeaderboardRow[] }>(ts.base, "/api/leaderboard?mode=duel");
    assert.equal(ladder.rows.length, 2);
    assert.equal(ladder.rows[0].avatar, "头");
    assert.equal(ladder.rows[1].avatar, "头");
  } finally {
    await closeAll(clients);
    await ts.close();
  }
});

test("ranked match history: opponent, set wins, per-set scores, rating delta", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER });
  const clients: TestClient[] = [];
  try {
    const winner = await register(ts.base, "history_win", "secret1", "战绩甲");
    const loser = await register(ts.base, "history_lose", "secret1", "战绩乙");
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
      pointsToWin: 1,
    });
    c1.send({ type: "room.start" });
    await c1.nextState((state) => state.status === "playing");
    c1.send({ type: "room.guess", word: ANSWER });
    await c1.nextState((state) => state.status === "matchEnd");

    const history = await getJson<{ rows: MatchHistoryFixture[] }>(ts.base, "/api/me/matches?limit=20", winner.token);
    assert.equal(history.rows.length, 1);
    const row = history.rows[0];
    assert.equal(row.mode, "duel");
    assert.deepEqual(row.opponentNames, [loser.user.name]);
    assert.equal(row.winnerName, winner.user.name);
    assert.equal(row.isDraw, false);
    assert.equal(row.forfeit, false);
    assert.equal(row.setWins[winner.user.id], 1);
    assert.equal(row.setWins[loser.user.id], 0);
    assert.equal(row.setHistory.length, 1);
    assert.equal(row.setHistory[0].setNumber, 1);
    assert.equal(row.smallScores[winner.user.id], 1);
    assert.equal(row.ratingBefore, 1200);
    assert.equal(row.ratingAfter, 1216);
    assert.equal(row.ratingDelta, 16);
    assert.equal(row.players.length, 2);
    const rowPlayers = new Map(row.players.map((player) => [player.id, player]));
    assert.equal(rowPlayers.get(winner.user.id)?.score, 1);
    assert.equal(rowPlayers.get(winner.user.id)?.setWins, 1);
    assert.equal(rowPlayers.get(winner.user.id)?.avatar, "战");
    assert.equal(rowPlayers.get(loser.user.id)?.score, 0);
    assert.equal(rowPlayers.get(loser.user.id)?.setWins, 0);
    assert.deepEqual(row.setHistory[0].scores, { [winner.user.id]: 1, [loser.user.id]: 0 });
    assert.deepEqual(row.setHistory[0].teamScores, { A: 0, B: 0 });

    // The same match from the opponent's (second player in the room) view.
    const loserHistory = await getJson<{ rows: MatchHistoryFixture[] }>(
      ts.base,
      "/api/me/matches",
      loser.token,
    );
    assert.equal(loserHistory.rows.length, 1);
    const loserRow = loserHistory.rows[0];
    assert.deepEqual(loserRow.opponentNames, [winner.user.name]);
    assert.equal(loserRow.ratingAfter, 1184);
    assert.equal(loserRow.ratingDelta, -16);
    const loserPlayers = new Map(loserRow.players.map((player) => [player.id, player]));
    assert.deepEqual([...loserPlayers.keys()].sort(), [winner.user.id, loser.user.id].sort());
    assert.equal(loserPlayers.get(loser.user.id)?.score, 0);
    assert.equal(loserPlayers.get(loser.user.id)?.setWins, 0);
    assert.equal(loserPlayers.get(winner.user.id)?.score, 1);
    assert.equal(loserPlayers.get(winner.user.id)?.setWins, 1);
    assert.deepEqual(loserRow.setHistory[0].scores, { [winner.user.id]: 1, [loser.user.id]: 0 });
    assert.deepEqual(loserRow.smallScores, { [winner.user.id]: 1, [loser.user.id]: 0 });

    // Practice boards never appear in match history.
    c1.send({ type: "room.leave" });
    c2.send({ type: "room.leave" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    c1.send({ type: "room.create", mode: "practice", visibility: "private" });
    await c1.nextState((state) => state.mode === "practice" && state.status === "playing");
    c1.send({ type: "room.guess", word: ANSWER });
    await c1.nextState((state) => state.status === "matchEnd");
    const afterPractice = await getJson<{ rows: unknown[] }>(ts.base, "/api/me/matches", winner.token);
    assert.equal(afterPractice.rows.length, 1, "practice is excluded from personal match history");

    const guestSession = await guest(ts.base, "战绩游客");
    const guestHistory = await fetch(`${ts.base}/api/me/matches`, {
      headers: { authorization: `Bearer ${guestSession.token}` },
    });
    assert.equal(guestHistory.status, 403);
  } finally {
    await closeAll(clients);
    await ts.close();
  }
});

test("team match history keeps player teams for small-score mapping", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER });
  const clients: TestClient[] = [];
  try {
    const hostUser = await register(ts.base, "team_history_a", "secret1", "队史甲");
    const guestUser = await register(ts.base, "team_history_b", "secret1", "队史乙");
    const host = await connectClient(ts.wsBase, hostUser.token);
    clients.push(host);
    const guestClient = await connectClient(ts.wsBase, guestUser.token);
    clients.push(guestClient);
    host.send({
      type: "room.create",
      mode: "team2v2",
      visibility: "private",
      bestOf: 1,
      pointsToWin: 1,
    });
    const created = await host.nextState((state) => state.players.length === 1);
    guestClient.send({ type: "room.join", code: created.code });
    await host.nextState((state) => state.players.length === 2);
    await guestClient.nextState((state) => state.players.length === 2);
    guestClient.send({ type: "room.ready", ready: true });
    await host.nextState((state) => state.status === "waiting" && state.players.every((player) => player.ready));
    host.send({ type: "room.start" });
    await host.nextState((state) => state.status === "countdown");
    const playing = await host.nextState((state) => state.status === "playing" && state.round.status === "playing");
    assert.equal(playing.players.find((player) => player.id === hostUser.user.id)?.team, "A");
    assert.equal(playing.players.find((player) => player.id === guestUser.user.id)?.team, "B");
    host.send({ type: "room.guess", word: ANSWER });
    const matchEnd = await host.nextState((state) => state.status === "matchEnd");
    assert.equal(matchEnd.match.winnerTeam, "A");

    const history = await getJson<{ rows: MatchHistoryFixture[] }>(ts.base, "/api/me/matches", hostUser.token);
    assert.equal(history.rows.length, 1);
    const row = history.rows[0];
    assert.equal(row.mode, "team2v2");
    assert.equal(row.winnerTeam, "A");
    const players = new Map(row.players.map((player) => [player.id, player]));
    assert.equal(players.get(hostUser.user.id)?.team, "A");
    assert.equal(players.get(guestUser.user.id)?.team, "B");
    assert.equal(players.get(hostUser.user.id)?.score, 1);
    assert.equal(players.get(guestUser.user.id)?.score, 0);
    assert.equal(players.get(hostUser.user.id)?.setWins, 1);
    assert.equal(players.get(guestUser.user.id)?.setWins, 0);
    assert.deepEqual(row.setHistory[0].scores, { A: 1, B: 0 });
    assert.deepEqual(row.setHistory[0].teamScores, { A: 1, B: 0 });
    assert.equal(players.get(hostUser.user.id)?.ratingDelta, 16);
    assert.equal(players.get(guestUser.user.id)?.ratingDelta, -16);
  } finally {
    await closeAll(clients);
    await ts.close();
  }
});

test("ffa3 default target follows the configured default (7 in production)", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER, config: { ffaTargetScore: 7 } });
  const clients: TestClient[] = [];
  try {
    const hostUser = await guest(ts.base, "混战规则");
    const host = await connectClient(ts.wsBase, hostUser.token);
    clients.push(host);
    host.send({ type: "room.create", mode: "ffa3", visibility: "private" });
    const state = await host.nextState((s) => s.mode === "ffa3" && s.players.length === 1);
    assert.equal(state.rules.pointsToWin, 7);
    assert.equal(state.match.targetScore, 7);
    assert.equal(state.rules.bestOf, 1);
  } finally {
    await closeAll(clients);
    await ts.close();
  }
});

test("room rules are preserved on rematch", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER });
  let duel: ManualDuel | null = null;
  try {
    duel = await startManualDuel(ts, { bestOf: 1, pointsToWin: 1, dictionary: "all", guessMode: "free" });
    const { host } = duel;
    host.send({ type: "room.guess", word: ANSWER });
    await host.nextState((state) => state.status === "matchEnd");
    host.send({ type: "room.rematch" });
    const waiting = await host.nextState((state) => state.status === "waiting");
    assert.deepEqual(waiting.rules, {
      bestOf: 1,
      guessMode: "free",
      dictionary: "all",
      pointsToWin: 1,
    });
  } finally {
    if (duel) await closeAll(duel.clients);
    await ts.close();
  }
});
