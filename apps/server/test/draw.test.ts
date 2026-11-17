import test from "node:test";
import assert from "node:assert/strict";
import { SET_END_DELAY_MS } from "../../../packages/shared/src/index.ts";
import type { MatchSummary, RoomState, StatsResponse } from "../../../packages/shared/src/index.ts";
import {
  closeAll,
  connectClient,
  getJson,
  guest,
  proposeAndAgreeRules,
  register,
  startTestServer,
} from "./helpers.ts";
import type { TestClient, TestServer } from "./helpers.ts";

const ANSWER = "画蛇添足";

interface DuelSetup {
  c1: TestClient;
  c2: TestClient;
  users: Array<{ id: string; name: string }>;
  clients: TestClient[];
  state: RoomState;
}

async function startQuickDuel(
  ts: TestServer,
  options: { registered?: boolean; pointsToWin?: number } = {},
): Promise<DuelSetup> {
  const sessions = options.registered
    ? [
        await register(ts.base, "draw_user_a", "secret1", "求和甲"),
        await register(ts.base, "draw_user_b", "secret1", "求和乙"),
      ]
    : [await guest(ts.base, "求和甲"), await guest(ts.base, "求和乙")];
  const users = sessions.map((session) => session.user);
  const clients: TestClient[] = [];
  const c1 = await connectClient(ts.wsBase, sessions[0].token);
  clients.push(c1);
  const c2 = await connectClient(ts.wsBase, sessions[1].token);
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
    pointsToWin: options.pointsToWin ?? 9,
  });
  c1.send({ type: "room.start" });
  await c1.nextState((state) => state.status === "countdown");
  const state = await c1.nextState((state) => state.status === "playing" && state.round.status === "playing");
  await c2.nextState((state) => state.status === "playing" && state.round.status === "playing");
  return { c1, c2, users, clients, state };
}

test("registered 1v1 draw: offer/accept ends as a draw with zero rating deltas", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER });
  let duel: DuelSetup | null = null;
  try {
    duel = await startQuickDuel(ts, { registered: true });
    const { c1, c2, users } = duel;
    const [u1, u2] = users;
    assert.deepEqual(duel.state.match.ratingDeltas, {}, "no deltas before the match ends");
    assert.equal(duel.state.drawOffer, null);

    c1.send({ type: "room.offerDraw" });
    const offered = await c1.nextState((state) => state.drawOffer !== null);
    assert.equal(offered.drawOffer!.proposerId, u1.id);
    assert.equal(offered.drawOffer!.proposerName, u1.name);
    assert.deepEqual(offered.drawOffer!.acceptedBy, [u1.id]);
    assert.ok(offered.drawOffer!.createdAt > 0);
    await c2.nextState((state) => state.drawOffer?.proposerId === u1.id);

    // Repeating the offer only toasts; the pending offer is kept.
    c2.send({ type: "room.offerDraw" });
    const pendingToast = await c2.next(
      (message) => message.type === "toast" && message.message.includes("已有求和请求"),
    );
    assert.ok(pendingToast);
    assert.equal(c2.lastState()?.drawOffer?.proposerId, u1.id);

    // The proposer cannot respond to their own offer.
    c1.send({ type: "room.respondDraw", accept: true });
    assert.match(await c1.nextError(), /不能回应自己的求和/);

    c2.send({ type: "room.respondDraw", accept: true });
    const ended = await c1.nextState((state) => state.status === "matchEnd");
    assert.equal(ended.match.isDraw, true);
    assert.equal(ended.match.winnerId, null);
    assert.equal(ended.match.winnerName, null);
    assert.equal(ended.drawOffer, null);
    assert.deepEqual(ended.match.ratingDeltas, { [u1.id]: 0, [u2.id]: 0 });
    assert.equal(ended.countdownEndsAt, null);

    const recent = await getJson<{ matches: MatchSummary[] }>(ts.base, "/api/matches/recent?limit=1");
    const summary = recent.matches[0];
    assert.equal(summary.isDraw, true);
    assert.equal(summary.players.find((player) => player.id === u1.id)?.ratingDelta, 0);
    assert.equal(summary.players.find((player) => player.id === u2.id)?.ratingDelta, 0);

    const login = await fetch(`${ts.base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "draw_user_a", password: "secret1" }),
    });
    const loginBody = (await login.json()) as { token: string };
    const stats = await getJson<StatsResponse>(ts.base, "/api/stats/me", loginBody.token);
    assert.equal(stats.modes.duel.draws, 1);
    assert.equal(stats.modes.duel.wins, 0);
    assert.equal(stats.modes.duel.losses, 0);

    // Rematch clears the draw offer and the rating deltas.
    c1.send({ type: "room.rematch" });
    const again = await c1.nextState((state) => state.status === "waiting");
    assert.equal(again.drawOffer, null);
    assert.deepEqual(again.match.ratingDeltas, {});
  } finally {
    if (duel) await closeAll(duel.clients);
    await ts.close();
  }
});

test("draw offer can be rejected, cleared and re-offered", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER });
  let duel: DuelSetup | null = null;
  try {
    duel = await startQuickDuel(ts);
    const { c1, c2 } = duel;

    // No pending offer yet.
    c2.send({ type: "room.respondDraw", accept: true });
    assert.match(await c2.nextError(), /没有求和请求/);

    c1.send({ type: "room.offerDraw" });
    await c2.nextState((state) => state.drawOffer?.proposerId === duel!.users[0].id);
    c2.send({ type: "room.respondDraw", accept: false });
    const rejected = await c2.nextState((state) => state.drawOffer === null && state.status === "playing");
    assert.equal(rejected.status, "playing");
    const rejectedToast = await c1.next(
      (message) => message.type === "toast" && message.message.includes("拒绝了求和"),
    );
    assert.ok(rejectedToast.type === "toast" && rejectedToast.message.includes("拒绝了求和"));

    // The rejected offer can be proposed again, this time by the opponent.
    c2.send({ type: "room.offerDraw" });
    const reOffered = await c1.nextState((state) => state.drawOffer?.proposerId === duel!.users[1].id);
    assert.deepEqual(reOffered.drawOffer!.acceptedBy, [duel.users[1].id]);
    c1.send({ type: "room.respondDraw", accept: true });
    const ended = await c1.nextState((state) => state.status === "matchEnd");
    assert.equal(ended.match.isDraw, true);
    assert.deepEqual(ended.match.ratingDeltas, {}, "guest matches are not rated");
  } finally {
    if (duel) await closeAll(duel.clients);
    await ts.close();
  }
});

test("draw offer is allowed during roundEnd", async () => {
  const ts = await startTestServer({
    chooseAnswer: () => ANSWER,
    config: { idleTimeoutMs: 100, roundEndMs: 900, countdownMs: 10 },
  });
  let duel: DuelSetup | null = null;
  try {
    duel = await startQuickDuel(ts);
    const { c1, c2 } = duel;
    const roundEnd = await c1.nextState((state) => state.status === "roundEnd" && state.round.status === "ended", 3_000);
    assert.equal(roundEnd.round.result, "timeout");
    assert.equal(SET_END_DELAY_MS, 5_000, "set-end display delay stays 5 seconds");

    c1.send({ type: "room.offerDraw" });
    const offered = await c2.nextState((state) => state.drawOffer !== null);
    assert.equal(offered.status, "roundEnd");
    c2.send({ type: "room.respondDraw", accept: true });
    const ended = await c1.nextState((state) => state.status === "matchEnd");
    assert.equal(ended.match.isDraw, true);
    assert.equal(ended.round.endedAt, roundEnd.round.endedAt, "round end timestamp is not rewritten");
    assert.equal(ended.countdownEndsAt, null);
  } finally {
    if (duel) await closeAll(duel.clients);
    await ts.close();
  }
});

test("practice, spectators and outsiders cannot use draw messages", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER });
  const clients: TestClient[] = [];
  let duel: DuelSetup | null = null;
  try {
    const practicer = await guest(ts.base, "求和练习");
    const practiceClient = await connectClient(ts.wsBase, practicer.token);
    clients.push(practiceClient);
    practiceClient.send({ type: "room.create", mode: "practice", visibility: "private" });
    await practiceClient.nextState((state) => state.mode === "practice" && state.status === "playing");
    practiceClient.send({ type: "room.offerDraw" });
    assert.match(await practiceClient.nextError(), /练习模式不能求和/);

    duel = await startQuickDuel(ts);
    const code = duel.state.code;
    const spectatorSession = await guest(ts.base, "求和观战");
    const spectator = await connectClient(ts.wsBase, spectatorSession.token);
    clients.push(spectator);
    spectator.send({ type: "spectate.join", code });
    await spectator.nextState((state) => state.code === code && state.viewerRole === "spectator");
    spectator.send({ type: "room.offerDraw" });
    assert.match(await spectator.nextError(), /观战者不能求和/);
    spectator.send({ type: "room.respondDraw", accept: true });
    assert.match(await spectator.nextError(), /观战者不能回应求和/);

    const outsiderSession = await guest(ts.base, "求和路人");
    const outsider = await connectClient(ts.wsBase, outsiderSession.token);
    clients.push(outsider);
    outsider.send({ type: "room.offerDraw" });
    assert.match(await outsider.nextError(), /当前不在房间中/);
    outsider.send({ type: "room.respondDraw", accept: false });
    assert.match(await outsider.nextError(), /当前不在房间中/);
  } finally {
    if (duel) await closeAll(duel.clients);
    await closeAll(clients);
    await ts.close();
  }
});

test("team2v2 draw needs every other player to accept", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER });
  const clients: TestClient[] = [];
  try {
    const sessions = [
      await guest(ts.base, "团队求和甲"),
      await guest(ts.base, "团队求和乙"),
      await guest(ts.base, "团队求和丙"),
    ];
    for (const session of sessions) clients.push(await connectClient(ts.wsBase, session.token));
    const [host, teammate, opponent] = clients;
    host.send({
      type: "room.create",
      mode: "team2v2",
      visibility: "private",
      bestOf: 1,
      guessMode: "free",
      pointsToWin: 9,
    });
    const created = await host.nextState((state) => state.players.length === 1);
    for (const client of [teammate, opponent]) {
      client.send({ type: "room.join", code: created.code });
      await host.nextState((state) => state.players.length >= 2);
    }
    await teammate.nextState((state) => state.players.length === 3);
    await opponent.nextState((state) => state.players.length === 3);
    teammate.send({ type: "room.ready", ready: true });
    opponent.send({ type: "room.ready", ready: true });
    await host.nextState((state) => state.status === "waiting" && state.players.every((player) => player.ready));
    host.send({ type: "room.start" });
    const playing = await host.nextState((state) => state.status === "playing" && state.round.status === "playing");
    assert.equal(playing.players.length, 3);

    // One reject clears the offer.
    host.send({ type: "room.offerDraw" });
    await opponent.nextState((state) => state.drawOffer !== null);
    opponent.send({ type: "room.respondDraw", accept: false });
    await host.nextState((state) => state.drawOffer === null && state.status === "playing");

    host.send({ type: "room.offerDraw" });
    await host.nextState((state) => state.drawOffer !== null);
    teammate.send({ type: "room.respondDraw", accept: true });
    const partial = await host.nextState((state) => state.drawOffer?.acceptedBy.length === 2);
    assert.equal(partial.status, "playing", "one acceptance is not enough in a 3 player room");
    opponent.send({ type: "room.respondDraw", accept: true });
    const ended = await host.nextState((state) => state.status === "matchEnd");
    assert.equal(ended.match.isDraw, true);
    assert.equal(ended.drawOffer, null);
    assert.deepEqual(ended.match.ratingDeltas, {}, "guest team matches are not rated");
  } finally {
    await closeAll(clients);
    await ts.close();
  }
});

test("ffa3 draw needs both other players to accept", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER });
  const clients: TestClient[] = [];
  try {
    const sessions = [
      await guest(ts.base, "混战求和甲"),
      await guest(ts.base, "混战求和乙"),
      await guest(ts.base, "混战求和丙"),
    ];
    for (const session of sessions) clients.push(await connectClient(ts.wsBase, session.token));
    const [c0, c1, c2] = clients;
    for (const client of clients) client.send({ type: "queue.join", mode: "ffa3" });
    await Promise.all(clients.map((client) => client.next((message) => message.type === "match.found")));
    await Promise.all(
      clients.map((client) =>
        client.nextState((state) => state.status === "waiting" && state.requiresAgreement === true),
      ),
    );
    await proposeAndAgreeRules(c0, [c1, c2], {
      bestOf: 1,
      guessMode: "free",
      dictionary: "common",
      pointsToWin: 9,
    });
    c0.send({ type: "room.start" });
    await c0.nextState((state) => state.status === "countdown");
    const playing = await c0.nextState((state) => state.status === "playing" && state.round.status === "playing");
    assert.equal(playing.players.length, 3);

    c0.send({ type: "room.offerDraw" });
    await c0.nextState((state) => state.drawOffer !== null);
    c1.send({ type: "room.respondDraw", accept: true });
    const partial = await c0.nextState((state) => state.drawOffer?.acceptedBy.length === 2);
    assert.equal(partial.status, "playing");
    c2.send({ type: "room.respondDraw", accept: true });
    const ended = await c0.nextState((state) => state.status === "matchEnd");
    assert.equal(ended.match.isDraw, true);
    assert.deepEqual(ended.match.ratingDeltas, {});
  } finally {
    await closeAll(clients);
    await ts.close();
  }
});

test("ratingDeltas appear only after settlement and match the summary", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER });
  let duel: DuelSetup | null = null;
  try {
    duel = await startQuickDuel(ts, { registered: true, pointsToWin: 1 });
    const { c1, users } = duel;
    const [winner, loser] = users;
    assert.deepEqual(duel.state.match.ratingDeltas, {});

    c1.send({ type: "room.guess", word: ANSWER });
    const ended = await c1.nextState((state) => state.status === "matchEnd");
    assert.equal(ended.match.ratingDeltas[winner.id], 16);
    assert.equal(ended.match.ratingDeltas[loser.id], -16);
    assert.equal(Object.prototype.hasOwnProperty.call(ended.match.ratingDeltas, "before"), false);
    assert.equal(ended.countdownEndsAt, null, "no countdown is left after the match ends");

    const recent = await getJson<{ matches: MatchSummary[] }>(ts.base, "/api/matches/recent?limit=1");
    const summary = recent.matches[0];
    for (const player of summary.players) {
      assert.equal(ended.match.ratingDeltas[player.id], player.ratingDelta);
    }
  } finally {
    if (duel) await closeAll(duel.clients);
    await ts.close();
  }
});
