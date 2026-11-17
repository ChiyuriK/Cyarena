import test from "node:test";
import assert from "node:assert/strict";
import type { LeaderboardRow, MatchSummary, RoomState } from "../../../packages/shared/src/index.ts";
import { closeAll, connectClient, getJson, guest, proposeAndAgreeRules, register, sleep, startTestServer } from "./helpers.ts";
import type { TestClient } from "./helpers.ts";

const ANSWER = "画蛇添足";

function playerOf(state: RoomState, userId: string) {
  return state.players.find((player) => player.id === userId) ?? null;
}

function teamOf(state: RoomState, userId: string): string | null {
  return playerOf(state, userId)?.team ?? null;
}

test("quick match queue: duel auto-creates a ready room and starts after countdown", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER });
  const clients: TestClient[] = [];
  try {
    const g1 = await guest(ts.base, "队列甲");
    const g2 = await guest(ts.base, "队列乙");
    const c1 = await connectClient(ts.wsBase, g1.token);
    clients.push(c1);
    const c2 = await connectClient(ts.wsBase, g2.token);
    clients.push(c2);

    c1.send({ type: "queue.join", mode: "duel" });
    const queued = await c1.next((message) => message.type === "queue");
    assert.ok(queued.type === "queue" && queued.state);
    assert.deepEqual(queued.state, { mode: "duel", size: 1, needed: 2, position: 1 });

    c2.send({ type: "queue.join", mode: "duel" });
    const found1 = await c1.next((message) => message.type === "match.found");
    const found2 = await c2.next((message) => message.type === "match.found");
    assert.ok(found1.type === "match.found" && found2.type === "match.found");
    assert.equal(found1.code, found2.code);
    assert.match(found1.code, /^\d{5}$/);

    const waiting1 = await c1.nextState((state) => state.status === "waiting" && state.requiresAgreement === true);
    await c2.nextState((state) => state.status === "waiting" && state.requiresAgreement === true);
    assert.deepEqual(waiting1.rules, {
      bestOf: 1,
      guessMode: "free",
      dictionary: "common",
      pointsToWin: 11,
    });
    assert.equal(waiting1.rulesAgreed, false);
    assert.equal(waiting1.proposal, null);
    c1.send({ type: "room.start" });
    assert.match(await c1.nextError(), /确认规则/);

    await proposeAndAgreeRules(c1, [c2], {
      bestOf: 1,
      guessMode: "free",
      dictionary: "common",
      pointsToWin: 2,
    });
    c1.send({ type: "room.start" });
    await c1.nextState((state) => state.status === "countdown");
    const playingA = await c1.nextState((state) => state.status === "playing" && state.round.status === "playing");
    const playingB = await c2.nextState((state) => state.status === "playing" && state.round.status === "playing");
    assert.equal(playingA.mode, "duel");
    assert.equal(playingA.players.length, 2);
    assert.equal(playingA.players.every((player) => player.ready), true, "quick match auto-readies everyone");
    assert.equal(playingA.round.answer, null);
    assert.equal(playingB.viewerRole, "player");
    for (const player of playingA.players) assert.equal(player.team, null);
    assert.equal(playingA.match.bestOf, 1, "quick match is best-of-1");
    assert.equal(playingA.match.setsToWin, 1);
    assert.equal(playingA.match.setNumber, 1);
    assert.equal(playingA.match.pointsToWin, 2, "negotiated test rules");
    assert.equal(playingA.match.pointLead, 1);
    assert.equal(playingA.rules.pointsToWin, 2);
    assert.equal(playingA.rulesAgreed, true);

    const rooms = await getJson<{
      rooms: Array<{ code: string; playerCount: number; capacity: number; guessMode: string; dictionary: string; pointsToWin: number }>;
    }>(ts.base, "/api/rooms");
    const listed = rooms.rooms.find((room) => room.code === found1.code);
    assert.ok(listed);
    assert.equal(listed.playerCount, 2);
    assert.equal(listed.capacity, 2);
    assert.equal(listed.guessMode, "free");
    assert.equal(listed.dictionary, "common");
    assert.equal(listed.pointsToWin, 2);
  } finally {
    await closeAll(clients);
    await ts.close();
  }
});

test("quick match queue: ffa3 fills with three players", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER });
  let clients: TestClient[] = [];
  try {
    const sessions = [
      await guest(ts.base, "混战甲"),
      await guest(ts.base, "混战乙"),
      await guest(ts.base, "混战丙"),
    ];
    clients = await Promise.all(sessions.map((session) => connectClient(ts.wsBase, session.token)));
    clients[0].send({ type: "queue.join", mode: "ffa3" });
    clients[1].send({ type: "queue.join", mode: "ffa3" });
    await clients[0].next((message) => message.type === "queue" && message.state?.size === 2);
    await clients[1].next((message) => message.type === "queue");
    clients[2].send({ type: "queue.join", mode: "ffa3" });

    const found = await Promise.all(clients.map((client) => client.next((message) => message.type === "match.found")));
    const codes = new Set(found.map((message) => (message.type === "match.found" ? message.code : "")));
    assert.equal(codes.size, 1);
    await Promise.all(
      clients.map((client) => client.nextState((state) => state.status === "waiting" && state.requiresAgreement === true)),
    );
    await proposeAndAgreeRules(clients[0], [clients[1], clients[2]], {
      bestOf: 1,
      guessMode: "free",
      dictionary: "common",
      pointsToWin: 2,
    });
    clients[0].send({ type: "room.start" });
    await clients[0].nextState((state) => state.status === "countdown");
    const playing = await clients[0].nextState((state) => state.status === "playing" && state.round.status === "playing");
    await Promise.all(
      clients.map((client) => client.nextState((state) => state.status === "playing" && state.round.status === "playing")),
    );
    assert.equal(playing.mode, "ffa3");
    assert.equal(playing.players.length, 3);
    assert.equal(playing.players.every((player) => player.team === null), true);
    assert.equal(playing.match.targetScore, 2, "negotiated ffa target");
    assert.equal(playing.match.bestOf, 1, "best-of is not used by ffa3");
    assert.equal(playing.round.maxRows, 6);
    assert.equal(playing.rules.pointsToWin, 2);
    assert.equal(playing.rules.dictionary, "common");
  } finally {
    await closeAll(clients);
    await ts.close();
  }
});

test("ffa3 races to 7 points with no sets and no round cap", async () => {
  const ts = await startTestServer({
    chooseAnswer: () => ANSWER,
    config: { ffaTargetScore: 7, countdownMs: 20, roundEndMs: 15, idleTimeoutMs: 5_000 },
  });
  let clients: TestClient[] = [];
  try {
    const sessions = [
      await guest(ts.base, "七分甲"),
      await guest(ts.base, "七分乙"),
      await guest(ts.base, "七分丙"),
    ];
    clients = await Promise.all(sessions.map((session) => connectClient(ts.wsBase, session.token)));
    for (const client of clients) client.send({ type: "queue.join", mode: "ffa3" });
    await Promise.all(clients.map((client) => client.next((message) => message.type === "match.found")));
    await Promise.all(
      clients.map((client) => client.nextState((state) => state.status === "waiting" && state.requiresAgreement === true)),
    );
    await proposeAndAgreeRules(clients[0], [clients[1], clients[2]], {
      bestOf: 1,
      guessMode: "free",
      dictionary: "common",
      pointsToWin: 7,
    });
    clients[0].send({ type: "room.start" });
    await clients[0].nextState((state) => state.status === "playing" && state.round.status === "playing");
    for (let round = 1; round <= 7; round += 1) {
      if (round > 1) {
        await clients[0].nextState(
          (state) => state.status === "playing" && state.round.status === "playing" && state.round.index === round,
        );
      }
      clients[0].send({ type: "room.guess", word: ANSWER });
      const solved = await clients[0].nextState(
        (state) => state.round.status === "ended" && state.round.index === round,
      );
      assert.equal(solved.round.answer, ANSWER);
      assert.equal(solved.players.find((player) => player.id === sessions[0].user.id)?.score, round);
    }
    const matchEnd = await clients[0].nextState((state) => state.status === "matchEnd");
    assert.equal(matchEnd.match.winnerId, sessions[0].user.id);
    assert.equal(matchEnd.match.targetScore, 7);
    assert.equal(matchEnd.match.roundNumber, 7);
    assert.equal(matchEnd.match.isDraw, false);
  } finally {
    await closeAll(clients);
    await ts.close();
  }
});

test("queue.leave removes the player and updates the remaining queue state", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER });
  const clients: TestClient[] = [];
  try {
    const g1 = await guest(ts.base, "排队甲");
    const g2 = await guest(ts.base, "排队乙");
    const c1 = await connectClient(ts.wsBase, g1.token);
    clients.push(c1);
    const c2 = await connectClient(ts.wsBase, g2.token);
    clients.push(c2);
    c1.send({ type: "queue.join", mode: "ffa3" });
    c2.send({ type: "queue.join", mode: "ffa3" });
    await c1.next((message) => message.type === "queue");
    await c2.next((message) => message.type === "queue");
    c1.send({ type: "queue.leave" });
    const left = await c1.next((message) => message.type === "queue" && message.state === null);
    assert.ok(left.type === "queue" && left.state === null);
    const remaining = await c2.next(
      (message) => message.type === "queue" && message.state !== null && message.state.position === 1,
    );
    assert.ok(remaining.type === "queue" && remaining.state);
    assert.equal(remaining.state.size, 1);
  } finally {
    await closeAll(clients);
    await ts.close();
  }
});

test("team2v2 is room-code only: queue.join returns an error", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER });
  const clients: TestClient[] = [];
  try {
    const g1 = await guest(ts.base, "团队队列");
    const c1 = await connectClient(ts.wsBase, g1.token);
    clients.push(c1);
    c1.send({ type: "queue.join", mode: "team2v2" });
    assert.match(await c1.nextError(), /团队战请用房号/);
  } finally {
    await closeAll(clients);
    await ts.close();
  }
});

test("team2v2: unlimited seats, alternating teams, team chat, team sets and Elo", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER });
  let clients: TestClient[] = [];
  try {
    const sessions = [
      await register(ts.base, "team_a1", "secret1", "甲一"),
      await register(ts.base, "team_b1", "secret1", "乙一"),
      await register(ts.base, "team_a2", "secret1", "甲二"),
      await register(ts.base, "team_b2", "secret1", "乙二"),
    ];
    clients = await Promise.all(sessions.map((session) => connectClient(ts.wsBase, session.token)));

    clients[0].send({ type: "room.create", mode: "team2v2", visibility: "public", bestOf: 1 });
    const created = await clients[0].nextState((state) => state.players.length === 1);
    assert.equal(created.match.bestOf, 1);
    assert.equal(created.match.pointsToWin, 2);
    assert.equal(created.guessMode, "standard");
    assert.equal(created.players[0].team, "A");

    for (let index = 1; index < clients.length; index += 1) {
      clients[index].send({ type: "room.join", code: created.code });
    }
    const full = await clients[0].nextState((state) => state.players.length === 4);
    assert.deepEqual(
      full.players.map((player) => [player.name, player.team]),
      [
        ["甲一", "A"],
        ["乙一", "B"],
        ["甲二", "A"],
        ["乙二", "B"],
      ],
    );
    assert.deepEqual(full.match.setWins, { A: 0, B: 0 }, "team big score is keyed by A/B");
    assert.equal(full.players.find((player) => player.isHost)?.ready, true, "host needs no ready");

    for (let index = 1; index < clients.length; index += 1) {
      clients[index].send({ type: "room.ready", ready: true });
    }
    await clients[0].nextState((state) => state.status === "waiting" && state.players.every((player) => player.ready));
    clients[0].send({ type: "room.start" });
    await clients[0].nextState((state) => state.status === "countdown");
    const playing = await clients[0].nextState(
      (state) => state.status === "playing" && state.round.status === "playing",
    );
    assert.equal(playing.players.length, 4);
    assert.deepEqual(playing.teamScores, { A: 0, B: 0 });

    // Team chat is only visible to teammates; room chat is visible to everyone.
    clients[0].send({ type: "room.chat", scope: "team", text: "A 队集合" });
    const teamChat = await clients[0].nextState((state) => state.chat.length === 1);
    assert.equal(teamChat.chat[0].scope, "team");
    const teammateView = await clients[2].nextState((state) => state.chat.length === 1);
    assert.equal(teammateView.chat.length, 1);
    await sleep(10);
    assert.equal(clients[1].lastState()?.chat.length, 0, "opponents must not see team chat");

    clients[0].send({ type: "room.chat", scope: "room", text: "全体注意" });
    const roomChat = await clients[1].nextState((state) => state.chat.length === 1);
    assert.equal(roomChat.chat[0].scope, "room");

    // Team A wins two rounds -> 2:0 set; bestOf=1 => match end.
    clients[0].send({ type: "room.guess", word: ANSWER });
    const first = await clients[0].nextState((state) => state.round.status === "ended" && state.round.index === 1);
    assert.equal(first.teamScores.A, 1);
    assert.equal(first.teamScores.B, 0);
    assert.equal(first.players.find((player) => player.id === sessions[0].user.id)?.score, 1, "personal score is display only");

    const nextRound = await clients[0].nextState(
      (state) => state.status === "playing" && state.round.status === "playing" && state.round.index === 2,
    );
    assert.equal(nextRound.round.answer, null);
    clients[2].send({ type: "room.guess", word: ANSWER });
    const setWon = await clients[0].nextState((state) => state.round.status === "ended" && state.round.index === 2);
    assert.equal(setWon.teamScores.A, 2);
    assert.equal(setWon.match.setWins.A, 1);
    assert.equal(setWon.round.setWinnerTeam, "A");
    assert.equal(setWon.match.setHistory.length, 1, "team set history is recorded");
    assert.equal(setWon.match.setHistory[0].winnerTeam, "A");
    assert.deepEqual(setWon.match.setHistory[0].teamScores, { A: 2, B: 0 });

    const matchEnd = await clients[0].nextState((state) => state.status === "matchEnd");
    assert.equal(matchEnd.match.winnerTeam, "A");
    assert.equal(matchEnd.match.isDraw, false);
    assert.equal(matchEnd.match.roundNumber, 2);

    // Ladder: every registered member is settled with K=32 (equal teams -> +/-16).
    const ladder = await getJson<{ rows: LeaderboardRow[] }>(ts.base, "/api/leaderboard?mode=team2v2");
    assert.equal(ladder.rows.length, 4);
    const ratingById = new Map(ladder.rows.map((row) => [row.userId, row]));
    for (const session of sessions) {
      const row = ratingById.get(session.user.id);
      assert.ok(row, `missing ladder row for ${session.user.name}`);
      assert.equal(row!.games, 1);
      assert.equal(row!.rating, row!.rating > 1200 ? 1216 : 1184);
    }
    assert.equal(ratingById.get(sessions[0].user.id)!.rating, 1216);
    assert.equal(ratingById.get(sessions[1].user.id)!.rating, 1184);

    const recent = await getJson<{ matches: MatchSummary[] }>(ts.base, "/api/matches/recent?limit=5");
    assert.equal(recent.matches.length, 1);
    const summary = recent.matches[0];
    assert.equal(summary.mode, "team2v2");
    assert.equal(summary.isDraw, false);
    assert.equal(summary.winnerTeam, "A");
    assert.equal(summary.rounds, 2);
    assert.equal(summary.players.length, 4);
    assert.equal(summary.players.find((player) => player.id === sessions[0].user.id)?.ratingDelta, 16);
    assert.equal(summary.players.find((player) => player.id === sessions[1].user.id)?.ratingDelta, -16);
  } finally {
    await closeAll(clients);
    await ts.close();
  }
});

test("team2v2 starts with uneven teams (3 players -> 2v1)", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER });
  const clients: TestClient[] = [];
  try {
    const sessions = [
      await guest(ts.base, "队长"),
      await guest(ts.base, "队员乙"),
      await guest(ts.base, "队员甲"),
    ];
    const c0 = await connectClient(ts.wsBase, sessions[0].token);
    clients.push(c0);
    const c1 = await connectClient(ts.wsBase, sessions[1].token);
    clients.push(c1);
    const c2 = await connectClient(ts.wsBase, sessions[2].token);
    clients.push(c2);

    c0.send({ type: "room.create", mode: "team2v2", visibility: "public", bestOf: 1 });
    const created = await c0.nextState((state) => state.players.length === 1);
    c1.send({ type: "room.join", code: created.code });
    c2.send({ type: "room.join", code: created.code });
    const full = await c0.nextState((state) => state.players.length === 3);
    assert.deepEqual(
      full.players.map((player) => [player.name, player.team]),
      [
        ["队长", "A"],
        ["队员乙", "B"],
        ["队员甲", "A"],
      ],
    );
    const rooms = await getJson<{ rooms: Array<{ code: string; capacity: number; playerCount: number }> }>(
      ts.base,
      "/api/rooms",
    );
    const listed = rooms.rooms.find((room) => room.code === created.code);
    assert.ok(listed);
    assert.equal(listed.capacity, 99, "team rooms report the unlimited sentinel");
    assert.equal(listed.playerCount, 3);

    c1.send({ type: "room.ready", ready: true });
    c2.send({ type: "room.ready", ready: true });
    await c0.nextState((state) => state.status === "waiting" && state.players.every((player) => player.ready));
    c0.send({ type: "room.start" });
    const playing = await c0.nextState(
      (state) => state.status === "playing" && state.round.status === "playing",
    );
    assert.equal(playing.players.filter((player) => player.team === "A").length, 2);
    assert.equal(playing.players.filter((player) => player.team === "B").length, 1);
  } finally {
    await closeAll(clients);
    await ts.close();
  }
});

test("duel between registered users changes individual Elo and leaderboard", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER });
  const clients: TestClient[] = [];
  try {
    const winner = await register(ts.base, "duel_win", "secret1", "胜者");
    const loser = await register(ts.base, "duel_lose", "secret1", "败者");
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

    // Quick match is best-of-1: 2 points with the accelerated config wins the match.
    for (let round = 1; round <= 2; round += 1) {
      if (round > 1) {
        await c1.nextState(
          (state) => state.status === "playing" && state.round.status === "playing" && state.round.index === round,
        );
      }
      c1.send({ type: "room.guess", word: ANSWER });
      await c1.nextState((state) => state.round.status === "ended" && state.round.index === round);
    }
    const matchEnd = await c1.nextState((state) => state.status === "matchEnd");
    assert.equal(matchEnd.match.winnerId, winner.user.id);
    assert.equal(matchEnd.match.setWins[winner.user.id], 1);
    assert.equal(matchEnd.match.roundNumber, 2);

    const ladder = await getJson<{ rows: LeaderboardRow[] }>(ts.base, "/api/leaderboard?mode=duel");
    assert.equal(ladder.rows.length, 2);
    assert.equal(ladder.rows[0].userId, winner.user.id);
    assert.equal(ladder.rows[0].rating, 1216);
    assert.equal(ladder.rows[0].games, 1);
    assert.equal(ladder.rows[0].wins, 1);
    assert.equal(ladder.rows[1].rating, 1184);
    assert.equal(ladder.rows[1].losses, 1);

    const recent = await getJson<{ matches: MatchSummary[] }>(ts.base, "/api/matches/recent");
    assert.equal(recent.matches[0].players.find((player) => player.id === winner.user.id)?.ratingAfter, 1216);
  } finally {
    await closeAll(clients);
    await ts.close();
  }
});
