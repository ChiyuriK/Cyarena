import test from "node:test";
import assert from "node:assert/strict";
import type { GameData } from "../../../packages/engine/src/index.ts";
import { explanationFor, loadGameData } from "../../../packages/engine/src/index.ts";
import type { RecentIdiomsResponse } from "../../../packages/shared/src/index.ts";
import { closeAll, connectClient, getJson, guest, register, startTestServer } from "./helpers.ts";
import type { TestClient, TestServer } from "./helpers.ts";

const ANSWER = "画蛇添足";

interface Duel {
  host: TestClient;
  guest: TestClient;
  clients: TestClient[];
  tokens: { host: string; guest: string };
  users: Array<{ id: string; name: string }>;
}

async function startRegisteredDuel(
  ts: TestServer,
  options: { pointsToWin?: number } = {},
): Promise<Duel> {
  const hostSession = await register(ts.base, "recent_host", "secret1", "最近甲");
  const guestSession = await register(ts.base, "recent_guest", "secret1", "最近乙");
  const clients: TestClient[] = [];
  const host = await connectClient(ts.wsBase, hostSession.token);
  clients.push(host);
  const guestClient = await connectClient(ts.wsBase, guestSession.token);
  clients.push(guestClient);
  host.send({
    type: "room.create",
    mode: "duel",
    visibility: "private",
    bestOf: 1,
    guessMode: "free",
    pointsToWin: options.pointsToWin ?? 1,
  });
  const created = await host.nextState((state) => state.players.length === 1);
  guestClient.send({ type: "room.join", code: created.code });
  await host.nextState((state) => state.players.length === 2);
  await guestClient.nextState((state) => state.players.length === 2);
  guestClient.send({ type: "room.ready", ready: true });
  await host.nextState((state) => state.status === "waiting" && state.players.every((player) => player.ready));
  host.send({ type: "room.start" });
  await host.nextState((state) => state.status === "countdown");
  await host.nextState((state) => state.status === "playing" && state.round.status === "playing");
  return {
    host,
    guest: guestClient,
    clients,
    tokens: { host: hostSession.token, guest: guestSession.token },
    users: [hostSession.user, guestSession.user],
  };
}

test("recent idioms record the answer with its explanation for registered players", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER });
  let duel: Duel | null = null;
  try {
    duel = await startRegisteredDuel(ts);
    const { host, guest: guestClient, tokens } = duel;
    host.send({ type: "room.guess", word: ANSWER });
    await host.nextState((state) => state.status === "matchEnd");

    const expectedExplanation = explanationFor(loadGameData(), ANSWER);
    assert.ok(expectedExplanation.length > 0);
    const hostIdioms = await getJson<RecentIdiomsResponse>(ts.base, "/api/me/idioms", tokens.host);
    assert.equal(hostIdioms.rows.length, 1);
    assert.equal(hostIdioms.rows[0].word, ANSWER);
    assert.equal(hostIdioms.rows[0].explanation, expectedExplanation);
    assert.ok(hostIdioms.rows[0].at > 0);
    assert.equal(hostIdioms.rows[0].explanation.startsWith("【解释】"), false);
    assert.equal(hostIdioms.rows[0].explanation.includes("\n"), false);

    const guestIdioms = await getJson<RecentIdiomsResponse>(ts.base, "/api/me/idioms", tokens.guest);
    assert.equal(guestIdioms.rows.length, 1, "every registered player records the answer");
    assert.equal(guestIdioms.rows[0].word, ANSWER);

    // A repeated answer is deduped and moved to the front with a newer timestamp.
    const firstAt = hostIdioms.rows[0].at;
    host.send({ type: "room.rematch" });
    await host.nextState((state) => state.status === "waiting");
    guestClient.send({ type: "room.ready", ready: true });
    await host.nextState((state) => state.status === "waiting" && state.players.every((player) => player.ready));
    host.send({ type: "room.start" });
    await host.nextState((state) => state.status === "playing" && state.round.status === "playing");
    host.send({ type: "room.guess", word: ANSWER });
    await host.nextState((state) => state.status === "matchEnd");
    const deduped = await getJson<RecentIdiomsResponse>(ts.base, "/api/me/idioms", tokens.host);
    assert.equal(deduped.rows.length, 1);
    assert.equal(deduped.rows[0].word, ANSWER);
    assert.ok(deduped.rows[0].at >= firstAt);

    const guestSession = await guest(ts.base, "最近游客");
    const guestResponse = await fetch(`${ts.base}/api/me/idioms`, {
      headers: { authorization: `Bearer ${guestSession.token}` },
    });
    assert.equal(guestResponse.status, 403);
  } finally {
    if (duel) await closeAll(duel.clients);
    await ts.close();
  }
});

test("practice answers are not recorded", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER });
  const clients: TestClient[] = [];
  try {
    const session = await register(ts.base, "recent_practice", "secret1", "练习最近");
    const client = await connectClient(ts.wsBase, session.token);
    clients.push(client);
    client.send({ type: "room.create", mode: "practice", visibility: "private" });
    await client.nextState((state) => state.mode === "practice" && state.status === "playing");
    client.send({ type: "room.guess", word: ANSWER });
    await client.nextState((state) => state.status === "matchEnd");
    const idioms = await getJson<RecentIdiomsResponse>(ts.base, "/api/me/idioms", session.token);
    assert.deepEqual(idioms.rows, []);
  } finally {
    await closeAll(clients);
    await ts.close();
  }
});

test("recent idioms are capped at 30, newest first, each with an explanation", async () => {
  const answers: string[] = [];
  const chooseAnswer = (data: GameData): string => {
    const word = data.answerPool[answers.length % data.answerPool.length];
    answers.push(word);
    return word;
  };
  const ts = await startTestServer({
    chooseAnswer,
    config: { idleTimeoutMs: 50, roundEndMs: 10, countdownMs: 10 },
  });
  let duel: Duel | null = null;
  try {
    duel = await startRegisteredDuel(ts, { pointsToWin: 99 });
    const { host, tokens } = duel;
    for (let round = 1; round <= 32; round += 1) {
      const ended = await host.nextState(
        (state) => state.round.status === "ended" && state.round.index === round,
        4_000,
      );
      assert.equal(ended.round.result, "timeout");
    }
    assert.equal(answers.length, 32);
    const idioms = await getJson<RecentIdiomsResponse>(ts.base, "/api/me/idioms", tokens.host);
    assert.equal(idioms.rows.length, 30);
    assert.equal(idioms.rows[0].word, answers[31], "newest answer comes first");
    assert.equal(idioms.rows[29].word, answers[2], "oldest answers are dropped");
    for (let index = 1; index < idioms.rows.length; index += 1) {
      assert.ok(idioms.rows[index - 1].at >= idioms.rows[index].at);
    }
    for (const row of idioms.rows) {
      assert.ok(row.explanation.length > 0, `${row.word} has no explanation`);
    }
  } finally {
    if (duel) await closeAll(duel.clients);
    await ts.close();
  }
});
