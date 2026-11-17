import test from "node:test";
import assert from "node:assert/strict";
import type { LeaderboardRow, StatsResponse } from "../../../packages/shared/src/index.ts";
import { closeAll, connectClient, getJson, proposeAndAgreeRules, register, startTestServer } from "./helpers.ts";
import type { TestClient, TestServer } from "./helpers.ts";

const ANSWER = "画蛇添足";

interface Ffa {
  clients: TestClient[];
  tokens: string[];
  users: Array<{ id: string; name: string }>;
}

async function startFfa(ts: TestServer, pointsToWin = 4): Promise<Ffa> {
  const sessions = [
    await register(ts.base, "ranking_a", "secret1", "名次甲"),
    await register(ts.base, "ranking_b", "secret1", "名次乙"),
    await register(ts.base, "ranking_c", "secret1", "名次丙"),
  ];
  const clients: TestClient[] = [];
  for (const session of sessions) clients.push(await connectClient(ts.wsBase, session.token));
  for (const client of clients) client.send({ type: "queue.join", mode: "ffa3" });
  await Promise.all(clients.map((client) => client.next((message) => message.type === "match.found")));
  await Promise.all(
    clients.map((client) =>
      client.nextState((state) => state.status === "waiting" && state.requiresAgreement === true),
    ),
  );
  await proposeAndAgreeRules(clients[0], [clients[1], clients[2]], {
    bestOf: 1,
    guessMode: "free",
    dictionary: "common",
    pointsToWin,
  });
  clients[0].send({ type: "room.start" });
  await clients[0].nextState((state) => state.status === "countdown");
  await Promise.all(
    clients.map((client) => client.nextState((state) => state.status === "playing" && state.round.status === "playing")),
  );
  return { clients, tokens: sessions.map((session) => session.token), users: sessions.map((session) => session.user) };
}

async function solveRound(ffa: Ffa, actorIndex: number, round: number): Promise<void> {
  const actor = ffa.clients[actorIndex];
  const last = actor.lastState();
  const alreadyPlaying =
    last?.status === "playing" && last.round.index === round && last.round.status === "playing";
  if (!alreadyPlaying) {
    await actor.nextState(
      (state) => state.status === "playing" && state.round.index === round && state.round.status === "playing",
    );
  }
  actor.send({ type: "room.guess", word: ANSWER });
  await actor.nextState((state) => state.round.index === round && state.round.status === "ended");
}

async function rematch(ffa: Ffa): Promise<void> {
  // Drop buffered states from the finished match so round indexes cannot match stale frames.
  for (const client of ffa.clients) {
    client.pending.length = 0;
    client.received.length = 0;
  }
  ffa.clients[0].send({ type: "room.rematch" });
  await ffa.clients[0].nextState((state) => state.status === "waiting");
  ffa.clients[0].send({ type: "room.start" });
  await ffa.clients[0].nextState((state) => state.status === "playing" && state.round.status === "playing");
}

test("ffa3 placements: first/second/third, shared second and draw", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER });
  let ffa: Ffa | null = null;
  try {
    ffa = await startFfa(ts, 4);
    const [c0] = ffa.clients;

    // Match 1: 4 / 2 / 1 -> distinct placements.
    for (const [round, actor] of [
      [1, 0],
      [2, 1],
      [3, 2],
      [4, 0],
      [5, 1],
      [6, 0],
      [7, 0],
    ] as const) {
      await solveRound(ffa, actor, round);
    }
    await c0.nextState((state) => state.status === "matchEnd");

    // Match 2: 4 / 2 / 2 -> p1 and p2 share second place.
    await rematch(ffa);
    for (const [round, actor] of [
      [1, 1],
      [2, 2],
      [3, 1],
      [4, 2],
      [5, 0],
      [6, 0],
      [7, 0],
      [8, 0],
    ] as const) {
      await solveRound(ffa, actor, round);
    }
    await c0.nextState((state) => state.status === "matchEnd");

    // Match 3: draw -> draws only, no placement counters.
    await rematch(ffa);
    c0.send({ type: "room.offerDraw" });
    await ffa.clients[1].nextState((state) => state.drawOffer !== null);
    ffa.clients[1].send({ type: "room.respondDraw", accept: true });
    await ffa.clients[2].nextState((state) => state.drawOffer !== null);
    ffa.clients[2].send({ type: "room.respondDraw", accept: true });
    await c0.nextState((state) => state.status === "matchEnd");

    const stats: StatsResponse[] = await Promise.all(
      ffa.tokens.map((token) => getJson<StatsResponse>(ts.base, "/api/stats/me", token)),
    );
    const [s0, s1, s2] = stats.map((response) => response.modes.ffa3);
    assert.deepEqual(
      {
        matches: s0.matches,
        wins: s0.wins,
        losses: s0.losses,
        draws: s0.draws,
        firsts: s0.firsts,
        seconds: s0.seconds,
        thirds: s0.thirds,
      },
      { matches: 3, wins: 2, losses: 0, draws: 1, firsts: 2, seconds: 0, thirds: 0 },
    );
    assert.deepEqual(
      {
        matches: s1.matches,
        wins: s1.wins,
        losses: s1.losses,
        draws: s1.draws,
        firsts: s1.firsts,
        seconds: s1.seconds,
        thirds: s1.thirds,
      },
      { matches: 3, wins: 0, losses: 2, draws: 1, firsts: 0, seconds: 2, thirds: 0 },
    );
    assert.deepEqual(
      {
        matches: s2.matches,
        wins: s2.wins,
        losses: s2.losses,
        draws: s2.draws,
        firsts: s2.firsts,
        seconds: s2.seconds,
        thirds: s2.thirds,
      },
      { matches: 3, wins: 0, losses: 2, draws: 1, firsts: 0, seconds: 1, thirds: 1 },
    );
    assert.equal(stats[0].total.firsts, 2);
    assert.equal(stats[0].total.seconds, 0);

    const ladder = await getJson<{ rows: LeaderboardRow[] }>(ts.base, "/api/leaderboard?mode=ffa3");
    const ffaSetup: Ffa = ffa;
    for (const [index, user] of ffaSetup.users.entries()) {
      const row: LeaderboardRow | undefined = ladder.rows.find((entry) => entry.userId === user.id);
      assert.ok(row, `leaderboard row missing for ${user.name}`);
      assert.equal(row.firsts, stats[index].modes.ffa3.firsts);
      assert.equal(row.seconds, stats[index].modes.ffa3.seconds);
      assert.equal(row.thirds, stats[index].modes.ffa3.thirds);
      assert.equal(row.games, 3);
    }

    // Other modes keep all placement counters at zero.
    await Promise.all(ffa.clients.map((client) => client.send({ type: "room.leave" })));
    for (const client of ffa.clients) {
      client.pending.length = 0;
      client.received.length = 0;
    }
    const host = ffa.users[0];
    c0.send({ type: "room.create", mode: "duel", visibility: "private", bestOf: 1, guessMode: "free", pointsToWin: 1 });
    const duelRoom = await c0.nextState((state) => state.mode === "duel" && state.players.length === 1);
    ffa.clients[1].send({ type: "room.join", code: duelRoom.code });
    await c0.nextState((state) => state.players.length === 2);
    ffa.clients[1].send({ type: "room.ready", ready: true });
    await c0.nextState((state) => state.status === "waiting" && state.players.every((player) => player.ready));
    c0.send({ type: "room.start" });
    await c0.nextState((state) => state.status === "playing" && state.round.status === "playing");
    c0.send({ type: "room.guess", word: ANSWER });
    await c0.nextState((state) => state.status === "matchEnd");
    const duelStats = await getJson<StatsResponse>(ts.base, "/api/stats/me", ffa.tokens[0]);
    assert.equal(duelStats.modes.duel.wins, 1);
    assert.equal(duelStats.modes.duel.firsts, 0);
    assert.equal(duelStats.modes.duel.seconds, 0);
    assert.equal(duelStats.modes.duel.thirds, 0);
    const duelLadder = await getJson<{ rows: LeaderboardRow[] }>(ts.base, "/api/leaderboard?mode=duel");
    const duelRow = duelLadder.rows.find((row) => row.userId === host.id);
    assert.ok(duelRow);
    assert.equal(duelRow!.firsts, 0);
    assert.equal(duelRow!.seconds, 0);
    assert.equal(duelRow!.thirds, 0);
  } finally {
    if (ffa) await closeAll(ffa.clients);
    await ts.close();
  }
});
