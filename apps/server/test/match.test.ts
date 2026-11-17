import test from "node:test";
import assert from "node:assert/strict";
import type { MatchSummary, RoomSummary } from "../../../packages/shared/src/index.ts";
import { closeAll, connectClient, getJson, guest, startTestServer } from "./helpers.ts";
import type { TestClient, TestServer } from "./helpers.ts";

const ANSWER = "画蛇添足";

interface DuelSetup {
  userA: { token: string; user: { id: string; name: string } };
  userB: { token: string; user: { id: string; name: string } };
  a: TestClient;
  b: TestClient;
  code: string;
}

async function startDuel(ts: TestServer): Promise<DuelSetup> {
  const clients: TestClient[] = [];
  try {
    const userA = await guest(ts.base, "玩家甲");
    const userB = await guest(ts.base, "玩家乙");
    const a = await connectClient(ts.wsBase, userA.token);
    clients.push(a);
    const b = await connectClient(ts.wsBase, userB.token);
    clients.push(b);

    a.send({ type: "room.create", mode: "duel", visibility: "public", bestOf: 1 });
    const created = await a.nextState((state) => state.players.length === 1);
    const code = created.code;
    assert.equal(created.players[0].ready, true, "host is ready without clicking ready");
    const rooms = await a.next(
      (message) => message.type === "rooms" && message.rooms.some((room) => room.code === code),
    );
    assert.ok(rooms.type === "rooms");
    const summary = rooms.rooms.find((room: RoomSummary) => room.code === code);
    assert.ok(summary, "public room should be listed");
    assert.equal(summary.playerCount, 1);
    assert.equal(summary.guessMode, "standard");

    b.send({ type: "room.join", code });
    const joined = await a.nextState((state) => state.players.length === 2);
    await b.nextState((state) => state.players.length === 2);
    assert.equal(joined.hostId, userA.user.id);
    assert.equal(joined.players.filter((player) => player.isHost).length, 1);

    // Host does not need to ready up: only the guest must be ready.
    b.send({ type: "room.ready", ready: true });
    await a.nextState((state) => state.status === "waiting" && state.players.every((player) => player.ready));
    a.send({ type: "room.start" });
    await a.nextState((state) => state.status === "countdown");
    const playingA = await a.nextState((state) => state.status === "playing" && state.round.status === "playing");
    const playingB = await b.nextState((state) => state.status === "playing" && state.round.status === "playing");
    assert.equal(playingA.round.answer, null, "answer must stay hidden during play");
    assert.equal(playingB.round.answer, null);
    assert.equal(playingA.round.index, 1);
    assert.equal(playingA.match.bestOf, 1);
    assert.equal(playingA.match.setsToWin, 1);
    assert.equal(playingA.match.setNumber, 1);
    assert.equal(playingA.match.pointsToWin, 2);
    assert.equal(playingA.match.pointLead, 1);
    assert.deepEqual(playingA.match.setWins, { [userA.user.id]: 0, [userB.user.id]: 0 });
    return { userA, userB, a, b, code };
  } catch (error) {
    await closeAll(clients);
    throw error;
  }
}

test("duel: wrong row, duplicate/invalid rejection, scoring, answer reveal and match end", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER });
  let setup: DuelSetup | null = null;
  try {
    setup = await startDuel(ts);
    const { userA, userB, a, b } = setup;

    // ---- wrong guess appends one row, answer still hidden
    a.send({ type: "room.guess", word: "画龙点睛" });
    const afterWrong = await a.nextState((state) => state.round.rows.length === 1);
    assert.equal(afterWrong.round.answer, null);
    assert.equal(afterWrong.round.remainingRows, 5);
    assert.equal(afterWrong.round.awardedTo.length, 0);
    const row = afterWrong.round.rows[0];
    assert.equal(row.playerId, userA.user.id);
    assert.equal(row.playerName, userA.user.name);
    assert.equal(row.word, "画龙点睛");
    assert.equal(row.correct, false);
    assert.equal(row.tiles.length, 4);
    assert.equal(row.tiles[0].bg, "correct");
    assert.equal(row.tiles[1].bg, "none");
    assert.ok(row.tiles[1].paths.length > 0);

    // ---- duplicate word is rejected without consuming a row
    a.send({ type: "room.guess", word: "画龙点睛" });
    assert.match(await a.nextError(), /已经猜过/);
    assert.equal(a.lastState()?.round.rows.length, 1);
    assert.equal(a.lastState()?.round.remainingRows, 5);

    // ---- invalid words are rejected
    a.send({ type: "room.guess", word: "abcd" });
    assert.match(await a.nextError(), /汉字/);
    a.send({ type: "room.guess", word: "阿阿阿阿" });
    assert.match(await a.nextError(), /词库/);

    // ---- correct guess scores, ends the round and reveals the answer
    b.send({ type: "room.guess", word: ANSWER });
    const solved = await b.nextState((state) => state.round.status === "ended");
    assert.equal(solved.status, "roundEnd");
    assert.equal(solved.round.answer, ANSWER);
    assert.equal(solved.round.result, "solved");
    assert.equal(solved.round.winnerId, userB.user.id);
    assert.equal(solved.players.find((player) => player.id === userB.user.id)?.score, 1);
    assert.equal(solved.round.rows.length, 2, "correct guess also appends a row");
    assert.deepEqual(
      solved.match.setWins,
      { [userA.user.id]: 0, [userB.user.id]: 0 },
      "1 point does not win the set",
    );

    // ---- one more point wins the set (accelerated 2 points / lead 1); bestOf=1 ends the match
    const nextRound = await b.nextState(
      (state) => state.status === "playing" && state.round.status === "playing" && state.round.index === 2,
    );
    assert.equal(nextRound.round.answer, null);
    b.send({ type: "room.guess", word: ANSWER });
    const setWon = await b.nextState((state) => state.round.status === "ended" && state.round.index === 2);
    assert.equal(setWon.round.answer, ANSWER);
    assert.equal(setWon.players.find((player) => player.id === userB.user.id)?.score, 2);
    assert.equal(setWon.match.setWins[userB.user.id], 1, "set win is recorded immediately");
    assert.equal(setWon.match.setWins[userA.user.id], 0);
    assert.equal(setWon.round.setWinnerId, userB.user.id);

    const matchEnd = await b.nextState((state) => state.status === "matchEnd");
    assert.equal(matchEnd.match.winnerId, userB.user.id);
    assert.equal(matchEnd.match.winnerName, userB.user.name);
    assert.equal(matchEnd.match.isDraw, false);
    assert.equal(matchEnd.match.roundNumber, 2);
    assert.equal(matchEnd.match.setNumber, 1);
    assert.equal(matchEnd.match.bestOf, 1);
    assert.equal(matchEnd.match.setsToWin, 1);
    assert.equal(matchEnd.match.setWins[userB.user.id], 1);
    assert.equal(matchEnd.round.answer, ANSWER, "answer is revealed after the final round");
    assert.equal(matchEnd.players.find((player) => player.id === userA.user.id)?.score, 0);
    assert.equal(matchEnd.match.forfeitById, null);

    // no state during play may ever leak the answer
    for (const state of a.states()) {
      if (state.status === "playing") assert.equal(state.round.answer, null);
    }

    // ---- recent matches are persisted
    const recent = await getJson<{ matches: MatchSummary[] }>(ts.base, "/api/matches/recent?limit=20");
    assert.equal(recent.matches.length, 1);
    const summary = recent.matches[0];
    assert.equal(summary.mode, "duel");
    assert.equal(summary.winnerName, userB.user.name);
    assert.equal(summary.isDraw, false);
    assert.equal(summary.rounds, 2);
    assert.equal(summary.players.length, 2);
    assert.equal(summary.players.find((player) => player.id === userB.user.id)?.score, 2);
    assert.equal(summary.players.find((player) => player.id === userB.user.id)?.ratingDelta, undefined);

    // guests never enter the ladder
    const ladder = await getJson<{ rows: unknown[] }>(ts.base, "/api/leaderboard?mode=duel");
    assert.equal(ladder.rows.length, 0);

    // ---- rematch resets the big score, keeps the host's best-of and scores
    a.send({ type: "room.rematch" });
    const waiting = await a.nextState((state) => state.status === "waiting");
    assert.equal(waiting.match.roundNumber, 0);
    assert.equal(waiting.match.setNumber, 1);
    assert.equal(waiting.match.bestOf, 1);
    assert.deepEqual(waiting.match.setWins, { [userA.user.id]: 0, [userB.user.id]: 0 });
    assert.equal(waiting.round.status, "idle");
    assert.equal(waiting.round.answer, null);
    for (const player of waiting.players) assert.equal(player.score, 0);
    assert.equal(waiting.players.find((player) => player.isHost)?.ready, true, "host stays ready on rematch");

    // ---- chat is broadcast to the room, newlines are flattened
    a.send({ type: "room.chat", scope: "room", text: "你好\n世界" });
    const chatState = await a.nextState((state) => state.chat.length === 1);
    assert.equal(chatState.chat[0].text, "你好 世界");
    assert.equal(chatState.chat[0].userId, userA.user.id);
    const chatForB = await b.nextState((state) => state.chat.length === 1);
    assert.equal(chatForB.chat[0].text, "你好 世界");
  } finally {
    if (setup) await closeAll([setup.a, setup.b]);
    await ts.close();
  }
});

test("spectators are read-only and do not leak answers", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER });
  const clients: TestClient[] = [];
  try {
    const player = await guest(ts.base, "房主");
    const watcher = await guest(ts.base, "观众");
    const host = await connectClient(ts.wsBase, player.token);
    clients.push(host);
    const spectator = await connectClient(ts.wsBase, watcher.token);
    clients.push(spectator);

    host.send({ type: "room.create", mode: "duel", visibility: "public" });
    const created = await host.nextState((state) => state.players.length === 1);

    spectator.send({ type: "spectate.join", code: created.code });
    const spectatorState = await spectator.nextState((state) => state.viewerRole === "spectator");
    assert.equal(spectatorState.viewerId, watcher.user.id);
    assert.equal(spectatorState.spectators.length, 1);
    assert.equal(spectatorState.round.answer, null);
    assert.equal(spectatorState.guessMode, "standard");

    spectator.send({ type: "room.guess", word: ANSWER });
    assert.match(await spectator.nextError(), /观战者不能/);
    // Spectators may chat in the room scope, but never in the team scope.
    spectator.send({ type: "room.chat", scope: "room", text: "hi" });
    const hostChat = await host.nextState((state) => state.chat.length === 1);
    assert.equal(hostChat.chat[0].name, watcher.user.name);
    assert.equal(hostChat.chat[0].scope, "room");
    spectator.send({ type: "room.chat", scope: "team", text: "team only" });
    assert.match(await spectator.nextError(), /观战者不能发送队伍消息/);

    const rooms = await getJson<{ rooms: RoomSummary[] }>(ts.base, "/api/rooms");
    const listed = rooms.rooms.find((room) => room.code === created.code);
    assert.ok(listed);
    assert.equal(listed.spectatorCount, 1);

    spectator.send({ type: "spectate.leave" });
    await spectator.next((message) => message.type === "toast");
    const afterLeave = await getJson<{ rooms: RoomSummary[] }>(ts.base, "/api/rooms");
    assert.equal(afterLeave.rooms.find((room) => room.code === created.code)?.spectatorCount, 0);
  } finally {
    await closeAll(clients);
    await ts.close();
  }
});

test("private rooms hide from the lobby but join by 5 digit code", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER });
  const clients: TestClient[] = [];
  try {
    const host = await guest(ts.base, "私房房主");
    const friend = await guest(ts.base, "朋友");
    const hostClient = await connectClient(ts.wsBase, host.token);
    clients.push(hostClient);
    const friendClient = await connectClient(ts.wsBase, friend.token);
    clients.push(friendClient);

    hostClient.send({ type: "room.create", mode: "duel", visibility: "private" });
    const created = await hostClient.nextState((state) => state.players.length === 1);
    assert.match(created.code, /^\d{5}$/);
    assert.equal(created.visibility, "private");

    const rooms = await getJson<{ rooms: RoomSummary[] }>(ts.base, "/api/rooms");
    assert.equal(
      rooms.rooms.some((room) => room.code === created.code),
      false,
      "private room must not be listed",
    );

    friendClient.send({ type: "room.join", code: created.code });
    const joined = await friendClient.nextState((state) => state.players.length === 2);
    assert.equal(joined.visibility, "private");
  } finally {
    await closeAll(clients);
    await ts.close();
  }
});

test("websocket rejects an invalid token", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER });
  try {
    const { WebSocket } = await import("ws");
    const ws = new WebSocket(`${ts.wsBase}/ws?token=not-a-real-token`);
    const messages: Array<{ type: string; message?: string }> = [];
    const closed = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("close timeout")), 4_000);
      ws.on("message", (data) => messages.push(JSON.parse(String(data))));
      ws.on("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      ws.on("error", () => {
        /* close follows */
      });
    });
    assert.equal(closed, 4401);
    assert.ok(messages.some((message) => message.type === "error"));
  } finally {
    await ts.close();
  }
});
