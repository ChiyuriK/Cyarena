import test from "node:test";
import assert from "node:assert/strict";
import type { MatchSummary } from "../../../packages/shared/src/index.ts";
import { closeAll, connectClient, getJson, guest, startTestServer } from "./helpers.ts";
import type { TestClient, TestServer } from "./helpers.ts";

const WRONG = ["一心一意", "三心二意", "四通八达", "五颜六色"];

interface Duel {
  host: TestClient;
  guest: TestClient;
  clients: TestClient[];
  users: Array<{ id: string; name: string }>;
  code: string;
}

async function startDuel(ts: TestServer, options: { pointsToWin: number }): Promise<Duel> {
  const hostUser = await guest(ts.base, "高光甲");
  const guestUser = await guest(ts.base, "高光乙");
  const clients: TestClient[] = [];
  const host = await connectClient(ts.wsBase, hostUser.token);
  clients.push(host);
  const guestClient = await connectClient(ts.wsBase, guestUser.token);
  clients.push(guestClient);
  host.send({
    type: "room.create",
    mode: "duel",
    visibility: "private",
    bestOf: 1,
    guessMode: "free",
    pointsToWin: options.pointsToWin,
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
  return { host, guest: guestClient, clients, users: [hostUser.user, guestUser.user], code: created.code };
}

test("solved rounds keep the three fewest-guess highlights per player", async () => {
  const ANSWERS = ["画蛇添足", "画龙点睛", "画饼充饥", "画地为牢", "画中有诗"];
  let answerIndex = 0;
  const ts = await startTestServer({ chooseAnswer: () => ANSWERS[answerIndex++] });
  let duel: Duel | null = null;
  try {
    duel = await startDuel(ts, { pointsToWin: 99 });
    const { host, guest: guestClient } = duel;

    const playRound = async (round: number, actor: TestClient, wrongs: string[], answer: string) => {
      const last = actor.lastState();
      const alreadyPlaying =
        last?.status === "playing" && last.round.index === round && last.round.status === "playing";
      if (!alreadyPlaying) {
        await actor.nextState(
          (state) => state.status === "playing" && state.round.status === "playing" && state.round.index === round,
        );
      }
      for (const [index, wrong] of wrongs.entries()) {
        actor.send({ type: "room.guess", word: wrong });
        await actor.nextState(
          (state) => state.round.index === round && state.round.rows.length === index + 1,
        );
      }
      actor.send({ type: "room.guess", word: answer });
      await host.nextState((state) => state.round.index === round && state.round.status === "ended");
    };

    // host: 2, 3, 1 and 4 guesses; guest: 1 guess.
    await playRound(1, host, [WRONG[0]], ANSWERS[0]);
    await playRound(2, host, [WRONG[1], WRONG[2]], ANSWERS[1]);
    await playRound(3, host, [], ANSWERS[2]);
    await playRound(4, host, [WRONG[3], WRONG[0], WRONG[1]], ANSWERS[3]);
    await playRound(5, guestClient, [], ANSWERS[4]);

    const state = host.lastState();
    assert.ok(state);
    const hostId = duel.users[0].id;
    const guestId = duel.users[1].id;
    const hostHighlights = state!.match.highlights[hostId];
    assert.deepEqual(hostHighlights, [
      { word: ANSWERS[2], guesses: 1 },
      { word: ANSWERS[0], guesses: 2 },
      { word: ANSWERS[1], guesses: 3 },
    ], "the 4-guess round is dropped");
    assert.deepEqual(state!.match.highlights[guestId], [{ word: ANSWERS[4], guesses: 1 }]);
    assert.deepEqual(hostHighlights.map((highlight) => highlight.word).includes(ANSWERS[3]), false);
  } finally {
    if (duel) await closeAll(duel.clients);
    await ts.close();
  }
});

test("match summaries copy highlights and old summaries default to {}", async () => {
  const ANSWER = "画蛇添足";
  const ts = await startTestServer({ chooseAnswer: () => ANSWER });
  let duel: Duel | null = null;
  try {
    duel = await startDuel(ts, { pointsToWin: 1 });
    const { host, users } = duel;
    host.send({ type: "room.guess", word: WRONG[0] });
    await host.nextState((state) => state.round.rows.length === 1);
    host.send({ type: "room.guess", word: ANSWER });
    const ended = await host.nextState((state) => state.status === "matchEnd");
    assert.deepEqual(ended.match.highlights[users[0].id], [{ word: ANSWER, guesses: 2 }]);
    assert.equal(ended.match.highlights[users[1].id] ?? undefined, undefined);

    const recent = await getJson<{ matches: MatchSummary[] }>(ts.base, "/api/matches/recent?limit=1");
    const summary = recent.matches[0];
    assert.deepEqual(summary.highlights[users[0].id], [{ word: ANSWER, guesses: 2 }]);
    assert.equal(summary.highlights[users[1].id] ?? undefined, undefined);
  } finally {
    if (duel) await closeAll(duel.clients);
    await ts.close();
  }
});
