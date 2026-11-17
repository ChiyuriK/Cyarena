import test from "node:test";
import assert from "node:assert/strict";
import type { MatchHistoryRow, MatchSummary, RoomState } from "../../../packages/shared/src/index.ts";
import { closeAll, connectClient, getJson, register, sleep, startTestServer } from "./helpers.ts";
import type { TestClient, TestServer } from "./helpers.ts";

const ANSWER = "画蛇添足";

interface Setup {
  host: TestClient;
  guest: TestClient;
  clients: TestClient[];
  tokens: { host: string; guest: string };
  users: Array<{ id: string; name: string }>;
  state: RoomState;
}

let setupCounter = 0;

async function startRegisteredDuel(
  ts: TestServer,
  options: { pointsToWin?: number; mode?: "duel" | "team2v2" } = {},
): Promise<Setup> {
  const mode = options.mode ?? "duel";
  const suffix = setupCounter++;
  const hostSession = await register(ts.base, `forfeit_host_${suffix}`, "secret1", `判胜甲${suffix}`);
  const guestSession = await register(ts.base, `forfeit_guest_${suffix}`, "secret1", `判胜乙${suffix}`);
  const clients: TestClient[] = [];
  const host = await connectClient(ts.wsBase, hostSession.token);
  clients.push(host);
  const guestClient = await connectClient(ts.wsBase, guestSession.token);
  clients.push(guestClient);
  host.send({
    type: "room.create",
    mode,
    visibility: "private",
    bestOf: 1,
    guessMode: "free",
    pointsToWin: options.pointsToWin ?? 9,
  });
  const created = await host.nextState((state) => state.players.length === 1);
  guestClient.send({ type: "room.join", code: created.code });
  await host.nextState((state) => state.players.length === 2);
  await guestClient.nextState((state) => state.players.length === 2);
  guestClient.send({ type: "room.ready", ready: true });
  await host.nextState((state) => state.status === "waiting" && state.players.every((player) => player.ready));
  host.send({ type: "room.start" });
  await host.nextState((state) => state.status === "countdown");
  const state = await host.nextState((state) => state.status === "playing" && state.round.status === "playing");
  return {
    host,
    guest: guestClient,
    clients,
    tokens: { host: hostSession.token, guest: guestSession.token },
    users: [hostSession.user, guestSession.user],
    state,
  };
}

test("1v1 forfeit records winnerId and a 1:0 set score", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER, config: { leaveGraceMs: 80 } });
  let setup: Setup | null = null;
  try {
    setup = await startRegisteredDuel(ts);
    const { host, guest: loser, tokens, users } = setup;
    const [winner, loserUser] = users;
    await loser.close();
    const ended = await host.nextState((state) => state.status === "matchEnd", 3_000);
    assert.equal(ended.match.forfeitById, loserUser.id);
    assert.equal(ended.match.winnerId, winner.id);
    assert.equal(ended.match.setWins[winner.id], 1);
    assert.equal(ended.match.setWins[loserUser.id] ?? 0, 0);

    const recent = await getJson<{ matches: MatchSummary[] }>(ts.base, "/api/matches/recent?limit=1");
    const summary = recent.matches[0];
    assert.equal(summary.winnerId, winner.id);
    assert.equal(summary.forfeitById, loserUser.id);
    assert.equal(summary.players.find((player) => player.id === winner.id)?.setWins, 1);
    assert.equal(summary.players.find((player) => player.id === loserUser.id)?.setWins, 0);

    const history = await getJson<{ rows: MatchHistoryRow[] }>(ts.base, "/api/me/matches", tokens.guest);
    assert.equal(history.rows.length, 1);
    assert.equal(history.rows[0].winnerId, winner.id);
    assert.equal(history.rows[0].forfeit, true);
    assert.equal(history.rows[0].setWins[winner.id], 1);
    assert.equal(history.rows[0].setWins[loserUser.id] ?? 0, 0);
    assert.equal(history.rows[0].winnerName, winner.name);
  } finally {
    if (setup) await closeAll(setup.clients);
    await ts.close();
  }
});

test("team forfeit awards the winning team one set", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER, config: { leaveGraceMs: 80 } });
  let setup: Setup | null = null;
  try {
    setup = await startRegisteredDuel(ts, { mode: "team2v2" });
    const { host, guest: loser, users } = setup;
    const [winner, loserUser] = users;
    await loser.close();
    const ended = await host.nextState((state) => state.status === "matchEnd", 3_000);
    assert.equal(ended.match.forfeitById, loserUser.id);
    assert.equal(ended.match.winnerId, null);
    assert.equal(ended.match.winnerTeam, "A");
    assert.equal(ended.match.setWins.A, 1);
    assert.equal(ended.match.setWins.B ?? 0, 0);
    assert.equal(ended.players.find((player) => player.id === winner.id)?.team, "A");

    const recent = await getJson<{ matches: MatchSummary[] }>(ts.base, "/api/matches/recent?limit=1");
    const summary = recent.matches[0];
    assert.equal(summary.winnerId, null);
    assert.equal(summary.winnerTeam, "A");
    assert.equal(summary.players.find((player) => player.team === "A")?.setWins, 1);
    assert.equal(summary.players.find((player) => player.team === "B")?.setWins, 0);
  } finally {
    if (setup) await closeAll(setup.clients);
    await ts.close();
  }
});

test("normal win still records 1:0 and a draw keeps 0:0", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER });
  let normal: Setup | null = null;
  let draw: Setup | null = null;
  try {
    normal = await startRegisteredDuel(ts, { pointsToWin: 1 });
    const [winner] = normal.users;
    normal.host.send({ type: "room.guess", word: ANSWER });
    const normalEnd = await normal.host.nextState((state) => state.status === "matchEnd");
    assert.equal(normalEnd.match.winnerId, winner.id);
    assert.equal(normalEnd.match.setWins[winner.id], 1);
    assert.equal(normalEnd.match.forfeitById, null);

    draw = await startRegisteredDuel(ts, { pointsToWin: 9 });
    const [drawHost, drawGuest] = draw.users;
    draw.host.send({ type: "room.offerDraw" });
    await draw.guest.nextState((state) => state.drawOffer !== null);
    draw.guest.send({ type: "room.respondDraw", accept: true });
    const drawEnd = await draw.host.nextState((state) => state.status === "matchEnd");
    assert.equal(drawEnd.match.isDraw, true);
    assert.equal(drawEnd.match.winnerId, null);
    assert.equal(drawEnd.match.setWins[drawHost.id] ?? 0, 0);
    assert.equal(drawEnd.match.setWins[drawGuest.id] ?? 0, 0);

    const recent = await getJson<{ matches: MatchSummary[] }>(ts.base, "/api/matches/recent?limit=2");
    const drawSummary = recent.matches.find((match) => match.isDraw);
    assert.ok(drawSummary);
    assert.equal(drawSummary!.winnerId, null);
    assert.equal(drawSummary!.players.every((player) => player.setWins === 0), true);
  } finally {
    if (normal) await closeAll(normal.clients);
    if (draw) await closeAll(draw.clients);
    await ts.close();
  }
});
