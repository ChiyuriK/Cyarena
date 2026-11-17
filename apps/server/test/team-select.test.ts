import test from "node:test";
import assert from "node:assert/strict";
import type { ClientMessage, RoomState } from "../../../packages/shared/src/index.ts";
import { closeAll, connectClient, guest, startTestServer } from "./helpers.ts";
import type { TestClient } from "./helpers.ts";

const ANSWER = "画蛇添足";

function teamCounts(state: RoomState): { A: number; B: number } {
  return {
    A: state.players.filter((player) => player.team === "A").length,
    B: state.players.filter((player) => player.team === "B").length,
  };
}

test("team selection: self move, host move and non-host rejection", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER });
  const clients: TestClient[] = [];
  try {
    const sessions = [
      await guest(ts.base, "选队房主"),
      await guest(ts.base, "选队甲"),
      await guest(ts.base, "选队乙"),
      await guest(ts.base, "选队丙"),
    ];
    const [host, p1, p2, p3] = await Promise.all(
      sessions.map((session) => connectClient(ts.wsBase, session.token)),
    );
    clients.push(host, p1, p2, p3);
    const ids = sessions.map((session) => session.user.id);

    host.send({ type: "room.create", mode: "team2v2", visibility: "public", bestOf: 1 });
    const created = await host.nextState((state) => state.players.length === 1);
    for (const client of [p1, p2, p3]) client.send({ type: "room.join", code: created.code });
    const full = await host.nextState((state) => state.code === created.code && state.players.length === 4);
    assert.deepEqual(teamCounts(full), { A: 2, B: 2 }, "join auto-balances the teams");
    assert.equal(full.hostId, ids[0]);

    // Non-host cannot move somebody else.
    p1.send({ type: "room.setTeam", team: "A", userId: ids[0] });
    assert.match(await p1.nextError(), /只有房主/);

    // A player can move themself (no userId).
    p1.send({ type: "room.setTeam", team: "A" });
    const selfMoved = await host.nextState((state) => state.code === created.code && teamCounts(state).A === 3);
    assert.deepEqual(teamCounts(selfMoved), { A: 3, B: 1 });
    assert.equal(selfMoved.players.find((player) => player.id === ids[1])?.team, "A");
    assert.deepEqual(selfMoved.match.setWins, { A: 0, B: 0 });

    // Host can move any player: make it 4v0 then back to 3v1.
    host.send({ type: "room.setTeam", team: "A", userId: ids[3] });
    const fourZero = await host.nextState((state) => state.code === created.code && teamCounts(state).B === 0);
    assert.deepEqual(teamCounts(fourZero), { A: 4, B: 0 });
    host.send({ type: "room.setTeam", team: "B", userId: ids[1] });
    const threeOne = await host.nextState(
      (state) => state.code === created.code && teamCounts(state).A === 3 && teamCounts(state).B === 1,
    );
    assert.equal(threeOne.players.find((player) => player.id === ids[1])?.team, "B");

    // Players can also move themselves back, then the host starts a 3v1 match.
    p1.send({ type: "room.setTeam", team: "B" });
    const stable = await host.nextState(
      (state) => state.code === created.code && teamCounts(state).A === 3 && teamCounts(state).B === 1,
    );
    assert.equal(stable.players.find((player) => player.id === ids[1])?.team, "B");

    for (const client of [p1, p2, p3]) client.send({ type: "room.ready", ready: true });
    await host.nextState(
      (state) => state.code === created.code && state.status === "waiting" && state.players.every((player) => player.ready),
    );
    host.send({ type: "room.start" });
    const playing = await host.nextState(
      (state) => state.code === created.code && state.status === "playing" && state.round.status === "playing",
    );
    assert.deepEqual(teamCounts(playing), { A: 3, B: 1 }, "a 3v1 team match can start");

    // No team changes once the match is running.
    p1.send({ type: "room.setTeam", team: "A" });
    assert.match(await p1.nextError(), /比赛开始后/);
  } finally {
    await closeAll(clients);
    await ts.close();
  }
});

test("team selection is rejected outside team rooms", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER });
  const clients: TestClient[] = [];
  try {
    const user = await guest(ts.base, "单挑玩家");
    const client = await connectClient(ts.wsBase, user.token);
    clients.push(client);
    client.send({ type: "room.create", mode: "duel", visibility: "public" });
    await client.nextState((state) => state.players.length === 1);
    client.send({ type: "room.setTeam", team: "A" });
    assert.match(await client.nextError(), /只有团队战可以选队/);

    client.send({ type: "room.setTeam", team: "C" } as unknown as ClientMessage);
    assert.match(await client.nextError(), /A 或 B/);
  } finally {
    await closeAll(clients);
    await ts.close();
  }
});
