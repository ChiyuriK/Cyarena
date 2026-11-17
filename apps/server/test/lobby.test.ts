import test from "node:test";
import assert from "node:assert/strict";
import { sleep, closeAll, connectClient, guest, getJson, startTestServer } from "./helpers.ts";
import type { TestClient } from "./helpers.ts";
import { WS_HEARTBEAT_MS } from "../src/ws.ts";

test("waiting single host keeps the room and can rejoin within the grace window", async () => {
  const ts = await startTestServer({ config: { leaveGraceMs: 120 } });
  const clients: TestClient[] = [];
  try {
    const hostUser = await guest(ts.base, "单人房主");
    const host = await connectClient(ts.wsBase, hostUser.token);
    clients.push(host);
    host.send({ type: "room.create", mode: "duel", visibility: "public" });
    const created = await host.nextState((state) => state.players.length === 1);
    assert.match(created.code, /^\d{5}$/);

    host.send({ type: "room.leave" });
    const reserved = await host.nextState(
      (state) => state.players.length === 1 && state.players[0].connected === false,
    );
    assert.ok(reserved.players[0].rejoinDeadline);
    assert.ok(reserved.players[0].rejoinDeadline! > Date.now());
    assert.equal(reserved.players[0].isHost, true);

    const health = await getJson<{ stats: { rooms: number } }>(ts.base, "/api/health");
    assert.equal(health.stats.rooms, 1, "the room survives the lone host leaving");

    host.send({ type: "room.join", code: created.code });
    const restored = await host.nextState(
      (state) => state.players.length === 1 && state.players[0].connected === true,
    );
    assert.equal(restored.players[0].rejoinDeadline, null);
    assert.equal(restored.players[0].isHost, true);
  } finally {
    await closeAll(clients);
    await ts.close();
  }
});

test("waiting single host reconnect restores the reserved seat", async () => {
  const ts = await startTestServer({ config: { leaveGraceMs: 120 } });
  let first: TestClient | null = null;
  let second: TestClient | null = null;
  try {
    const hostUser = await guest(ts.base, "断线房主");
    first = await connectClient(ts.wsBase, hostUser.token);
    first.send({ type: "room.create", mode: "duel", visibility: "public" });
    const created = await first.nextState((state) => state.players.length === 1);

    await first.close();
    first = null;
    await sleep(30);
    const health = await getJson<{ stats: { rooms: number } }>(ts.base, "/api/health");
    assert.equal(health.stats.rooms, 1, "disconnect keeps a lone host room");

    second = await connectClient(ts.wsBase, hostUser.token);
    const restored = await second.nextState(
      (state) => state.code === created.code && state.players[0]?.connected === true,
    );
    assert.equal(restored.players.length, 1);
    assert.equal(restored.players[0].rejoinDeadline, null);
  } finally {
    await closeAll([first, second]);
    await ts.close();
  }
});

test("waiting single host room is destroyed when the grace window expires", async () => {
  const ts = await startTestServer({ config: { leaveGraceMs: 60 } });
  const clients: TestClient[] = [];
  try {
    const hostUser = await guest(ts.base, "超时房主");
    const host = await connectClient(ts.wsBase, hostUser.token);
    clients.push(host);
    host.send({ type: "room.create", mode: "duel", visibility: "public" });
    const created = await host.nextState((state) => state.players.length === 1);
    host.send({ type: "room.leave" });
    await host.nextState((state) => state.players[0]?.connected === false);
    await sleep(140);

    const health = await getJson<{ stats: { rooms: number } }>(ts.base, "/api/health");
    assert.equal(health.stats.rooms, 0, "room is gone after the grace window");

    const otherUser = await guest(ts.base, "迟到玩家");
    const other = await connectClient(ts.wsBase, otherUser.token);
    clients.push(other);
    other.send({ type: "room.join", code: created.code });
    assert.match(await other.nextError(), /房间不存在/);
  } finally {
    await closeAll(clients);
    await ts.close();
  }
});

test("waiting rooms with several players still remove the leaver immediately", async () => {
  const ts = await startTestServer();
  const clients: TestClient[] = [];
  try {
    const hostUser = await guest(ts.base, "多人房主");
    const guestUser = await guest(ts.base, "多人玩家");
    const host = await connectClient(ts.wsBase, hostUser.token);
    clients.push(host);
    const player = await connectClient(ts.wsBase, guestUser.token);
    clients.push(player);
    host.send({ type: "room.create", mode: "duel", visibility: "public" });
    const created = await host.nextState((state) => state.players.length === 1);
    player.send({ type: "room.join", code: created.code });
    await host.nextState((state) => state.players.length === 2);
    await player.nextState((state) => state.players.length === 2);

    player.send({ type: "room.leave" });
    const remaining = await host.nextState((state) => state.players.length === 1);
    assert.equal(remaining.players[0].isHost, true);
    assert.equal(remaining.players[0].connected, true);
    const health = await getJson<{ stats: { rooms: number } }>(ts.base, "/api/health");
    assert.equal(health.stats.rooms, 1);
  } finally {
    await closeAll(clients);
    await ts.close();
  }
});

test("websocket heartbeat keeps healthy sockets alive", async () => {
  assert.equal(WS_HEARTBEAT_MS, 30_000);
  const ts = await startTestServer({ heartbeatMs: 40 });
  const clients: TestClient[] = [];
  try {
    const user = await guest(ts.base, "心跳玩家");
    const client = await connectClient(ts.wsBase, user.token);
    clients.push(client);
    await sleep(160);
    client.send({ type: "ping" });
    const pong = await client.next((message) => message.type === "pong");
    assert.ok(pong.type === "pong");

    const site = await getJson<{ onlineUsers: number }>(ts.base, "/api/site");
    assert.equal(site.onlineUsers, 1);
  } finally {
    await closeAll(clients);
    await sleep(20);
    await ts.close();
  }
});

test("creating a new room releases an abandoned lone waiting room", async () => {
  const ts = await startTestServer({ config: { leaveGraceMs: 500 } });
  const clients: TestClient[] = [];
  try {
    const hostUser = await guest(ts.base, "释放房主");
    const host = await connectClient(ts.wsBase, hostUser.token);
    clients.push(host);
    host.send({ type: "room.create", mode: "duel", visibility: "public" });
    const oldRoom = await host.nextState((state) => state.players.length === 1);
    host.send({ type: "room.leave" });
    await host.nextState((state) => state.players[0]?.connected === false);

    // Rejoining the reserved room still works before entering a new room.
    host.send({ type: "room.join", code: oldRoom.code });
    await host.nextState((state) => state.code === oldRoom.code && state.players[0]?.connected === true);
    host.send({ type: "room.leave" });
    await host.nextState((state) => state.players[0]?.connected === false);

    // Creating another room releases the old one instead of failing.
    host.send({ type: "room.create", mode: "duel", visibility: "public" });
    const newRoom = await host.nextState(
      (state) => state.code !== oldRoom.code && state.players.length === 1 && state.players[0].connected,
    );
    assert.match(newRoom.code, /^\d{5}$/);
    const health = await getJson<{ stats: { rooms: number } }>(ts.base, "/api/health");
    assert.equal(health.stats.rooms, 1, "the abandoned room is gone");

    const otherUser = await guest(ts.base, "释放路人");
    const other = await connectClient(ts.wsBase, otherUser.token);
    clients.push(other);
    other.send({ type: "room.join", code: oldRoom.code });
    assert.match(await other.nextError(), /房间不存在/);
  } finally {
    await closeAll(clients);
    await ts.close();
  }
});

test("joining another room releases an abandoned lone waiting room", async () => {
  const ts = await startTestServer({ config: { leaveGraceMs: 500 } });
  const clients: TestClient[] = [];
  try {
    const hostUser = await guest(ts.base, "释放加入甲");
    const otherUser = await guest(ts.base, "释放加入乙");
    const thirdUser = await guest(ts.base, "释放加入丙");
    const host = await connectClient(ts.wsBase, hostUser.token);
    clients.push(host);
    const other = await connectClient(ts.wsBase, otherUser.token);
    clients.push(other);
    const third = await connectClient(ts.wsBase, thirdUser.token);
    clients.push(third);

    host.send({ type: "room.create", mode: "duel", visibility: "public" });
    const abandoned = await host.nextState((state) => state.players.length === 1);
    host.send({ type: "room.leave" });
    await host.nextState((state) => state.players[0]?.connected === false);

    other.send({ type: "room.create", mode: "duel", visibility: "public" });
    const otherRoom = await other.nextState((state) => state.players.length === 1);
    host.send({ type: "room.join", code: otherRoom.code });
    await host.nextState((state) => state.code === otherRoom.code && state.players.length === 2);
    assert.equal(host.lastState()?.players.find((player) => player.id === hostUser.user.id)?.connected, true);
    third.send({ type: "room.join", code: abandoned.code });
    assert.match(await third.nextError(), /房间不存在/);
  } finally {
    await closeAll(clients);
    await ts.close();
  }
});

test("queue.join releases an abandoned lone waiting room", async () => {
  const ts = await startTestServer({ config: { leaveGraceMs: 500 } });
  const clients: TestClient[] = [];
  try {
    const hostUser = await guest(ts.base, "释放排队甲");
    const peerUser = await guest(ts.base, "释放排队乙");
    const host = await connectClient(ts.wsBase, hostUser.token);
    clients.push(host);
    const peer = await connectClient(ts.wsBase, peerUser.token);
    clients.push(peer);
    host.send({ type: "room.create", mode: "duel", visibility: "public" });
    await host.nextState((state) => state.players.length === 1);
    host.send({ type: "room.leave" });
    await host.nextState((state) => state.players[0]?.connected === false);

    host.send({ type: "queue.join", mode: "duel" });
    const queued = await host.next((message) => message.type === "queue" && message.state !== null);
    assert.ok(queued.type === "queue" && queued.state?.mode === "duel");
    const health = await getJson<{ stats: { rooms: number } }>(ts.base, "/api/health");
    assert.equal(health.stats.rooms, 0, "queueing drops the abandoned room");

    peer.send({ type: "queue.join", mode: "duel" });
    await host.next((message) => message.type === "match.found");
    await peer.next((message) => message.type === "match.found");
  } finally {
    await closeAll(clients);
    await ts.close();
  }
});

test("multi-player waiting rooms and in-progress rooms are not released", async () => {
  const ts = await startTestServer({ config: { leaveGraceMs: 90 } });
  const clients: TestClient[] = [];
  try {
    const hostUser = await guest(ts.base, "不受影响甲");
    const guestUser = await guest(ts.base, "不受影响乙");
    const thirdUser = await guest(ts.base, "不受影响丙");
    const host = await connectClient(ts.wsBase, hostUser.token);
    clients.push(host);
    const player = await connectClient(ts.wsBase, guestUser.token);
    clients.push(player);
    const third = await connectClient(ts.wsBase, thirdUser.token);
    clients.push(third);

    host.send({ type: "room.create", mode: "duel", visibility: "public" });
    const waitingRoom = await host.nextState((state) => state.players.length === 1);
    player.send({ type: "room.join", code: waitingRoom.code });
    await host.nextState((state) => state.players.length === 2);
    // A multi-player waiting room removes the leaver immediately.
    host.send({ type: "room.leave" });
    await player.nextState((state) => state.players.length === 1);
    host.send({ type: "room.create", mode: "duel", visibility: "public" });
    const secondRoom = await host.nextState(
      (state) => state.code !== waitingRoom.code && state.players.length === 1,
    );

    // The remaining player leaves the abandoned room and joins the new one.
    player.send({ type: "room.leave" });
    await player.nextState((state) => state.players[0]?.connected === false);
    player.send({ type: "room.join", code: secondRoom.code });
    await host.nextState((state) => state.code === secondRoom.code && state.players.length === 2);
    third.send({ type: "room.join", code: waitingRoom.code });
    assert.match(await third.nextError(), /房间不存在/);

    // Start the match, then leave mid-game: the reserved seat blocks new rooms.
    player.send({ type: "room.ready", ready: true });
    await host.nextState((state) => state.status === "waiting" && state.players.every((entry) => entry.ready));
    host.send({ type: "room.start" });
    await host.nextState((state) => state.status === "playing");
    player.send({ type: "room.leave" });
    await host.nextState(
      (state) => state.players.find((entry) => entry.id === guestUser.user.id)?.connected === false,
    );
    player.send({ type: "room.create", mode: "duel", visibility: "public" });
    assert.match(await player.nextError(), /已经在房间中/);
    assert.equal(clients.length, 3);
  } finally {
    await closeAll(clients);
    await ts.close();
  }
});

