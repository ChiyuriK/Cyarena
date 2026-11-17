import test from "node:test";
import assert from "node:assert/strict";
import { closeAll, connectClient, guest, startTestServer } from "./helpers.ts";
import type { TestClient } from "./helpers.ts";

const ANSWER = "画蛇添足";

test("spectators can send room chat but not team chat", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER });
  const clients: TestClient[] = [];
  try {
    const hostUser = await guest(ts.base, "观战房主");
    const spectatorUser = await guest(ts.base, "观战聊天者");
    const host = await connectClient(ts.wsBase, hostUser.token);
    clients.push(host);
    const spectator = await connectClient(ts.wsBase, spectatorUser.token);
    clients.push(spectator);
    host.send({ type: "room.create", mode: "duel", visibility: "public" });
    const created = await host.nextState((state) => state.players.length === 1);
    spectator.send({ type: "spectate.join", code: created.code });
    await spectator.nextState((state) => state.code === created.code && state.viewerRole === "spectator");

    spectator.send({ type: "room.chat", scope: "room", text: "观战加油" });
    const hostView = await host.nextState((state) => state.chat.length === 1);
    assert.equal(hostView.chat[0].name, spectatorUser.user.name);
    assert.equal(hostView.chat[0].scope, "room");
    assert.equal(hostView.chat[0].text, "观战加油");
    const spectatorView = await spectator.nextState((state) => state.chat.length === 1);
    assert.equal(spectatorView.chat[0].name, spectatorUser.user.name);

    spectator.send({ type: "room.chat", scope: "team", text: "队伍消息" });
    assert.match(await spectator.nextError(), /观战者不能发送队伍消息/);
    assert.equal(host.lastState()?.chat.length, 1, "the rejected team message is not stored");

    host.send({ type: "room.chat", scope: "room", text: "房主说话" });
    const both = await spectator.nextState((state) => state.chat.length === 2);
    assert.deepEqual(
      both.chat.map((message) => message.text),
      ["观战加油", "房主说话"],
    );
  } finally {
    await closeAll(clients);
    await ts.close();
  }
});

test("a spectator can take a free seat in a waiting room", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER });
  const clients: TestClient[] = [];
  try {
    const hostUser = await guest(ts.base, "入座房主");
    const spectatorUser = await guest(ts.base, "入座观战");
    const host = await connectClient(ts.wsBase, hostUser.token);
    clients.push(host);
    const spectator = await connectClient(ts.wsBase, spectatorUser.token);
    clients.push(spectator);
    host.send({ type: "room.create", mode: "duel", visibility: "public" });
    const created = await host.nextState((state) => state.players.length === 1);
    spectator.send({ type: "spectate.join", code: created.code });
    const watching = await spectator.nextState((state) => state.code === created.code && state.viewerRole === "spectator");
    assert.equal(watching.spectators.length, 1);
    await host.nextState((state) => state.spectators.length === 1);

    spectator.send({ type: "room.join", code: created.code });
    const seated = await spectator.nextState((state) => state.viewerRole === "player" && state.players.length === 2);
    assert.equal(seated.spectators.length, 0, "the spectator slot is released");
    assert.equal(seated.players.some((player) => player.id === spectatorUser.user.id), true);
    const hostSeesSeat = await host.nextState((state) => state.players.length === 2 && state.spectators.length === 0);
    assert.equal(hostSeesSeat.players.some((player) => player.id === spectatorUser.user.id), true);

    spectator.send({ type: "room.ready", ready: true });
    await host.nextState((state) => state.status === "waiting" && state.players.every((player) => player.ready));
    host.send({ type: "room.start" });
    const playing = await host.nextState((state) => state.status === "playing");
    assert.equal(playing.players.length, 2);
  } finally {
    await closeAll(clients);
    await ts.close();
  }
});

test("full and in-progress rooms reject a spectator taking a seat", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER });
  const clients: TestClient[] = [];
  try {
    const hostUser = await guest(ts.base, "满房房主");
    const playerUser = await guest(ts.base, "满房玩家");
    const spectatorUser = await guest(ts.base, "满房观战");
    const host = await connectClient(ts.wsBase, hostUser.token);
    clients.push(host);
    const player = await connectClient(ts.wsBase, playerUser.token);
    clients.push(player);
    const spectator = await connectClient(ts.wsBase, spectatorUser.token);
    clients.push(spectator);
    host.send({ type: "room.create", mode: "duel", visibility: "public" });
    const created = await host.nextState((state) => state.players.length === 1);
    player.send({ type: "room.join", code: created.code });
    await host.nextState((state) => state.players.length === 2);
    await player.nextState((state) => state.players.length === 2);

    spectator.send({ type: "spectate.join", code: created.code });
    await spectator.nextState((state) => state.code === created.code && state.viewerRole === "spectator");
    spectator.send({ type: "room.join", code: created.code });
    assert.match(await spectator.nextError(), /房间已满/);

    player.send({ type: "room.ready", ready: true });
    await host.nextState((state) => state.status === "waiting" && state.players.every((entry) => entry.ready));
    host.send({ type: "room.start" });
    await host.nextState((state) => state.status === "playing");
    spectator.send({ type: "room.join", code: created.code });
    assert.match(await spectator.nextError(), /房间已开始/);
  } finally {
    await closeAll(clients);
    await ts.close();
  }
});
