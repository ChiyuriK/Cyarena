import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dailyAnswer, dailyDateKey } from "../src/daily.ts";
import { loadGameData, explanationFor } from "../../../packages/engine/src/index.ts";
import type {
  FriendMessageView,
  FriendNotificationView,
  FriendProfileResponse,
  FriendsResponse,
  UserSearchResult,
} from "../../../packages/shared/src/index.ts";
import { closeAll, connectClient, getJson, guest, register, sleep, startTestServer } from "./helpers.ts";
import type { TestClient, TestServer } from "./helpers.ts";

const ANSWER = "画蛇添足";
const data = loadGameData();

async function requestJson(
  base: string,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

async function befriend(a: TestServer, aToken: string, bToken: string, bId: string): Promise<void> {
  const sent = await requestJson(a.base, "POST", "/api/friends/request", { userId: bId }, aToken);
  assert.equal(sent.status, 200);
  const request = (sent.json.request as { id: string }).id;
  const accepted = await requestJson(a.base, "POST", "/api/friends/accept", { requestId: request }, bToken);
  assert.equal(accepted.status, 200);
}

test("friend search relations, request, accept, reject and delete", async () => {
  const ts = await startTestServer();
  try {
    const a = await register(ts.base, "friend_a", "secret1", "好友甲");
    const b = await register(ts.base, "friend_b", "secret1", "好友乙");
    const c = await register(ts.base, "friend_c", "secret1", "搜索丙");
    const guestSession = await guest(ts.base, "好友游客");

    const guestSearch = await requestJson(ts.base, "GET", "/api/users/search?q=好友", undefined, guestSession.token);
    assert.equal(guestSearch.status, 403);
    const anonSearch = await requestJson(ts.base, "GET", "/api/users/search?q=好友");
    assert.equal(anonSearch.status, 401);

    const search = await getJson<{ rows: UserSearchResult[] }>(ts.base, "/api/users/search?q=好友", a.token);
    assert.equal(search.rows.some((row) => row.id === a.user.id), false, "search excludes self");
    const foundB = search.rows.find((row) => row.id === b.user.id);
    assert.ok(foundB);
    assert.equal(foundB!.relation, "none");
    assert.equal(search.rows.some((row) => row.name === "好友游客"), false, "guests are not searchable");

    const request = await requestJson(ts.base, "POST", "/api/friends/request", { userId: b.user.id }, a.token);
    assert.equal(request.status, 200);
    const requestView = request.json.request as { id: string; direction: string; user: { id: string } };
    assert.equal(requestView.direction, "outgoing");
    assert.equal(requestView.user.id, b.user.id);

    const outgoingSearch = await getJson<{ rows: UserSearchResult[] }>(ts.base, "/api/users/search?q=好友乙", a.token);
    assert.equal(outgoingSearch.rows[0].relation, "outgoing");
    const incomingSearch = await getJson<{ rows: UserSearchResult[] }>(ts.base, "/api/users/search?q=好友甲", b.token);
    assert.equal(incomingSearch.rows[0].relation, "incoming");

    const bFriends = await getJson<FriendsResponse>(ts.base, "/api/friends", b.token);
    assert.equal(bFriends.friends.length, 0);
    assert.equal(bFriends.incoming.length, 1);
    assert.equal(bFriends.incoming[0].user.id, a.user.id);
    assert.equal(bFriends.notifications.length, 1);
    assert.equal(bFriends.notifications[0].type, "friend_request");
    assert.equal(bFriends.unread, 1);

    const accepted = await requestJson(ts.base, "POST", "/api/friends/accept", { requestId: requestView.id }, b.token);
    assert.equal(accepted.status, 200);
    const aFriends = await getJson<FriendsResponse>(ts.base, "/api/friends", a.token);
    assert.equal(aFriends.friends.length, 1);
    assert.equal(aFriends.friends[0].id, b.user.id);
    assert.equal(aFriends.incoming.length, 0);
    const bAfter = await getJson<FriendsResponse>(ts.base, "/api/friends", b.token);
    assert.equal(bAfter.notifications.every((notification) => notification.read), true);
    assert.equal(bAfter.unread, 0);

    const duplicate = await requestJson(ts.base, "POST", "/api/friends/request", { userId: b.user.id }, a.token);
    assert.equal(duplicate.status, 400);
    assert.match(String(duplicate.json.error), /已经是好友/);
    const selfRequest = await requestJson(ts.base, "POST", "/api/friends/request", { userId: a.user.id }, a.token);
    assert.equal(selfRequest.status, 400);
    const guestTarget = await requestJson(
      ts.base,
      "POST",
      "/api/friends/request",
      { userId: guestSession.user.id },
      a.token,
    );
    assert.equal(guestTarget.status, 404);

    const cRequest = await requestJson(ts.base, "POST", "/api/friends/request", { userId: a.user.id }, c.token);
    assert.equal(cRequest.status, 200);
    const cRequestId = (cRequest.json.request as { id: string }).id;
    const rejected = await requestJson(ts.base, "POST", "/api/friends/reject", { requestId: cRequestId }, a.token);
    assert.equal(rejected.status, 200);
    const cAfterReject = await getJson<FriendsResponse>(ts.base, "/api/friends", c.token);
    assert.equal(cAfterReject.outgoing.length, 0);

    const unfriend = await requestJson(ts.base, "DELETE", `/api/friends/${b.user.id}`, undefined, a.token);
    assert.equal(unfriend.status, 200);
    const afterDelete = await getJson<FriendsResponse>(ts.base, "/api/friends", a.token);
    assert.equal(afterDelete.friends.length, 0);

    const badAccept = await requestJson(ts.base, "POST", "/api/friends/accept", { requestId: "missing" }, a.token);
    assert.equal(badAccept.status, 404);
  } finally {
    await ts.close();
  }
});

test("privacy controls friend statistics visibility", async () => {
  const ts = await startTestServer();
  try {
    const a = await register(ts.base, "privacy_a", "secret1", "隐私甲");
    const b = await register(ts.base, "privacy_b", "secret1", "隐私乙");
    const c = await register(ts.base, "privacy_c", "secret1", "隐私丙");
    await befriend(ts, a.token, b.token, b.user.id);

    const defaults = await getJson<{ showStatsToFriends: boolean }>(ts.base, "/api/me/privacy", a.token);
    assert.deepEqual(defaults, { showStatsToFriends: true });

    const hidden = await requestJson(
      ts.base,
      "PATCH",
      "/api/me/privacy",
      { showStatsToFriends: false },
      a.token,
    );
    assert.equal(hidden.status, 200);
    assert.deepEqual(hidden.json, { showStatsToFriends: false });

    const friendView = await getJson<FriendProfileResponse>(ts.base, `/api/friends/${a.user.id}`, b.token);
    assert.equal(friendView.statsVisible, false);
    assert.equal(friendView.stats, null);
    const nonFriendView = await getJson<FriendProfileResponse>(ts.base, `/api/friends/${a.user.id}`, c.token);
    assert.equal(nonFriendView.statsVisible, false);
    assert.equal(nonFriendView.stats, null);

    await requestJson(ts.base, "PATCH", "/api/me/privacy", { showStatsToFriends: true }, a.token);
    const visible = await getJson<FriendProfileResponse>(ts.base, `/api/friends/${a.user.id}`, b.token);
    assert.equal(visible.statsVisible, true);
    assert.ok(visible.stats);
    assert.equal(typeof visible.stats!.matches, "number");
    assert.equal(nonFriendView.user.id, a.user.id);

    const selfView = await getJson<FriendProfileResponse>(ts.base, `/api/friends/${a.user.id}`, a.token);
    assert.equal(selfView.statsVisible, true);
    assert.ok(selfView.stats);

    const invalid = await requestJson(ts.base, "PATCH", "/api/me/privacy", { showStatsToFriends: "no" }, a.token);
    assert.equal(invalid.status, 400);
    const guestSession = await guest(ts.base, "隐私游客");
    const guestPrivacy = await requestJson(ts.base, "GET", "/api/me/privacy", undefined, guestSession.token);
    assert.equal(guestPrivacy.status, 403);
  } finally {
    await ts.close();
  }
});

test("friend messages and notifications become read", async () => {
  const ts = await startTestServer();
  try {
    const a = await register(ts.base, "msg_a", "secret1", "私信甲");
    const b = await register(ts.base, "msg_b", "secret1", "私信乙");
    const c = await register(ts.base, "msg_c", "secret1", "私信丙");
    await befriend(ts, a.token, b.token, b.user.id);

    const sent = await requestJson(
      ts.base,
      "POST",
      "/api/friends/message",
      { userId: b.user.id, text: "你好呀" },
      a.token,
    );
    assert.equal(sent.status, 200);
    const message = sent.json.message as FriendMessageView;
    assert.equal(message.text, "你好呀");
    assert.equal(message.fromId, a.user.id);
    assert.equal(message.toId, b.user.id);
    assert.equal(message.fromName, a.user.name);
    assert.equal(message.read, false);

    const bNotifications = await getJson<{ notifications: FriendNotificationView[]; unread: number }>(
      ts.base,
      "/api/notifications",
      b.token,
    );
    assert.equal(bNotifications.unread, 1);
    assert.equal(bNotifications.notifications[0].type, "friend_message");
    assert.equal(bNotifications.notifications[0].userId, a.user.id);

    const conversation = await getJson<{ messages: FriendMessageView[]; unread: number }>(
      ts.base,
      `/api/friends/${a.user.id}/messages`,
      b.token,
    );
    assert.equal(conversation.messages.length, 1);
    assert.equal(conversation.messages[0].read, true, "reading the conversation marks it read");
    assert.equal(conversation.unread, 0);
    const afterRead = await getJson<{ unread: number }>(ts.base, "/api/notifications", b.token);
    assert.equal(afterRead.unread, 0);

    const reply = await requestJson(
      ts.base,
      "POST",
      "/api/friends/message",
      { userId: a.user.id, text: "在的" },
      b.token,
    );
    assert.equal(reply.status, 200);
    const aConversation = await getJson<{ messages: FriendMessageView[] }>(
      ts.base,
      `/api/friends/${b.user.id}/messages`,
      a.token,
    );
    assert.equal(aConversation.messages.length, 2);
    assert.equal(aConversation.messages[0].text, "你好呀");
    assert.equal(aConversation.messages[1].text, "在的");
    assert.equal(aConversation.messages[0].read, true);
    assert.equal(aConversation.messages[1].read, true);

    const notify = await getJson<{ notifications: FriendNotificationView[]; unread: number }>(
      ts.base,
      "/api/notifications",
      b.token,
    );
    assert.ok(notify.notifications.length >= 2);
    const firstId = notify.notifications[0].id;
    const readOne = await requestJson(ts.base, "POST", "/api/notifications/read", { id: firstId }, b.token);
    assert.equal(readOne.status, 200);
    await requestJson(ts.base, "POST", "/api/notifications/read", { all: true }, b.token);
    const allRead = await getJson<{ unread: number }>(ts.base, "/api/notifications", b.token);
    assert.equal(allRead.unread, 0);

    const nonFriendMessage = await requestJson(
      ts.base,
      "POST",
      "/api/friends/message",
      { userId: c.user.id, text: "hi" },
      a.token,
    );
    assert.equal(nonFriendMessage.status, 400);
    const emptyMessage = await requestJson(
      ts.base,
      "POST",
      "/api/friends/message",
      { userId: b.user.id, text: "  " },
      a.token,
    );
    assert.equal(emptyMessage.status, 400);
    const longMessage = await requestJson(
      ts.base,
      "POST",
      "/api/friends/message",
      { userId: b.user.id, text: "字".repeat(501) },
      a.token,
    );
    assert.equal(longMessage.status, 400);
    const nonFriendView = await fetch(`${ts.base}/api/friends/${c.user.id}/messages`, {
      headers: { authorization: `Bearer ${a.token}` },
    });
    assert.equal(nonFriendView.status, 403);
  } finally {
    await ts.close();
  }
});

test("game invite requires a room, friendship and an online target", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER });
  const clients: TestClient[] = [];
  try {
    const a = await register(ts.base, "invite_a", "secret1", "邀请甲");
    const b = await register(ts.base, "invite_b", "secret1", "邀请乙");
    const c = await register(ts.base, "invite_c", "secret1", "邀请丙");
    await befriend(ts, a.token, b.token, b.user.id);
    const aClient = await connectClient(ts.wsBase, a.token);
    clients.push(aClient);
    const bClient = await connectClient(ts.wsBase, b.token);
    clients.push(bClient);

    const noRoom = await requestJson(ts.base, "POST", "/api/friends/invite", { userId: b.user.id }, a.token);
    assert.equal(noRoom.status, 400);
    assert.match(String(noRoom.json.error), /进入房间/);

    aClient.send({ type: "room.create", mode: "duel", visibility: "public" });
    const created = await aClient.nextState((state) => state.players.length === 1);
    const invited = await requestJson(ts.base, "POST", "/api/friends/invite", { userId: b.user.id }, a.token);
    assert.equal(invited.status, 200);
    assert.equal(invited.json.roomCode, created.code);

    const bNotifications = await getJson<{ notifications: FriendNotificationView[] }>(
      ts.base,
      "/api/notifications",
      b.token,
    );
    const invite = bNotifications.notifications.find((notification) => notification.type === "game_invite");
    assert.ok(invite);
    assert.equal(invite!.roomCode, created.code);
    assert.equal(invite!.userId, a.user.id);

    await bClient.close();
    await sleep(30);
    const offline = await requestJson(ts.base, "POST", "/api/friends/invite", { userId: b.user.id }, a.token);
    assert.equal(offline.status, 400);
    assert.match(String(offline.json.error), /好友不在线/);
    const notFriend = await requestJson(ts.base, "POST", "/api/friends/invite", { userId: c.user.id }, a.token);
    assert.equal(notFriend.status, 400);
    assert.match(String(notFriend.json.error), /只能邀请好友/);
  } finally {
    await closeAll(clients);
    await ts.close();
  }
});

test("account deletion clears user data, relations, matches and sessions", async () => {
  const ts = await startTestServer({ chooseAnswer: () => ANSWER });
  const clients: TestClient[] = [];
  try {
    const a = await register(ts.base, "delete_a", "secret1", "注销甲");
    const b = await register(ts.base, "delete_b", "secret1", "注销乙");
    await befriend(ts, a.token, b.token, b.user.id);
    await requestJson(ts.base, "POST", "/api/friends/message", { userId: b.user.id, text: "再见" }, a.token);

    const aClient = await connectClient(ts.wsBase, a.token);
    clients.push(aClient);
    const bClient = await connectClient(ts.wsBase, b.token);
    clients.push(bClient);
    aClient.send({ type: "room.create", mode: "duel", visibility: "private", bestOf: 1, guessMode: "free", pointsToWin: 1 });
    const room = await aClient.nextState((state) => state.players.length === 1);
    bClient.send({ type: "room.join", code: room.code });
    await aClient.nextState((state) => state.players.length === 2);
    await bClient.nextState((state) => state.players.length === 2);
    bClient.send({ type: "room.ready", ready: true });
    await aClient.nextState((state) => state.status === "waiting" && state.players.every((player) => player.ready));
    aClient.send({ type: "room.start" });
    await aClient.nextState((state) => state.status === "playing");
    aClient.send({ type: "room.guess", word: ANSWER });
    await aClient.nextState((state) => state.status === "matchEnd");

    // Daily + streak rows for A, to prove they are cleaned up too.
    const dailyDate = dailyDateKey();
    const answer = dailyAnswer(data, dailyDate);
    await requestJson(ts.base, "POST", `/api/daily/guess?date=${dailyDate}`, { word: answer }, a.token);
    await requestJson(ts.base, "POST", "/api/streak/start", { variant: "standard" }, a.token);

    const deleted = await requestJson(ts.base, "DELETE", "/api/me", undefined, a.token);
    assert.equal(deleted.status, 200);
    assert.deepEqual(deleted.json, { ok: true });

    const meAfter = await fetch(`${ts.base}/api/me`, { headers: { authorization: `Bearer ${a.token}` } });
    assert.equal(meAfter.status, 401);

    const search = await getJson<{ rows: UserSearchResult[] }>(ts.base, "/api/users/search?q=注销甲", b.token);
    assert.deepEqual(search.rows, []);

    const ladder = await getJson<{ rows: Array<{ userId: string }> }>(ts.base, "/api/leaderboard?mode=duel");
    assert.equal(ladder.rows.some((row) => row.userId === a.user.id), false);
    const dailyBoard = await getJson<{ leaderboard: Array<{ userId: string }> }>(
      ts.base,
      `/api/daily?date=${dailyDate}`,
    );
    assert.equal(dailyBoard.leaderboard.some((row) => row.userId === a.user.id), false);
    const streakBoard = await getJson<{ rows: Array<{ userId: string }> }>(
      ts.base,
      "/api/streak/leaderboard?variant=standard",
      b.token,
    );
    assert.equal(streakBoard.rows.some((row) => row.userId === a.user.id), false);

    const bFriends = await getJson<FriendsResponse>(ts.base, "/api/friends", b.token);
    assert.equal(bFriends.friends.length, 0);
    assert.equal(bFriends.notifications.length, 0, "messages/notifications from the deleted user are gone");

    const recent = await getJson<{ matches: Array<{ players: Array<{ id: string }>; winnerId: string | null }> }>(
      ts.base,
      "/api/matches/recent",
    );
    const match = recent.matches[0];
    assert.ok(match);
    assert.equal(match.players.some((player) => player.id === a.user.id), false);
    assert.equal(match.players.length, 1);
    assert.equal(match.winnerId, null, "the deleted winner id is cleared");

    const guestSession = await guest(ts.base, "注销游客");
    const guestDelete = await requestJson(ts.base, "DELETE", "/api/me", undefined, guestSession.token);
    assert.equal(guestDelete.status, 403);
    const anonDelete = await requestJson(ts.base, "DELETE", "/api/me");
    assert.equal(anonDelete.status, 401);
    assert.equal(dailyAnswer.length > 0 && explanationFor(data, answer).length > 0, true);
  } finally {
    await closeAll(clients);
    await ts.close();
  }
});
