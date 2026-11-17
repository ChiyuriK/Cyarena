import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectClient, guest, getJson, register, startTestServer } from "./helpers.ts";
import type { TestClient } from "./helpers.ts";

async function post(
  base: string,
  path: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return requestJson(base, "POST", path, body, token);
}

async function requestJson(
  base: string,
  method: string,
  path: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${base}${path}`, { method, headers, body: JSON.stringify(body) });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

test("health, modes, rooms, leaderboard and matches endpoints", async () => {
  const ts = await startTestServer();
  try {
    const health = await getJson<{
      ok: boolean;
      stats: { users: number; matches: number; rooms: number; online: number };
    }>(ts.base, "/api/health");
    assert.equal(health.ok, true);
    assert.equal(health.stats.rooms, 0);

    const modes = await getJson<{ modes: Array<{ mode: string; capacity: number; teams: boolean }> }>(
      ts.base,
      "/api/modes",
    );
    assert.deepEqual(
      modes.modes.map((mode) => mode.mode),
      ["duel", "ffa3", "team2v2", "practice"],
    );
    assert.deepEqual(
      modes.modes.map((mode) => mode.capacity),
      [2, 3, 99, 1],
    );

    const rooms = await getJson<{ rooms: unknown[] }>(ts.base, "/api/rooms");
    assert.deepEqual(rooms.rooms, []);
    const matches = await getJson<{ matches: unknown[] }>(ts.base, "/api/matches/recent");
    assert.deepEqual(matches.matches, []);

    for (const mode of ["duel", "ffa3", "team2v2"]) {
      const ladder = await getJson<{ mode: string; rows: unknown[] }>(ts.base, `/api/leaderboard?mode=${mode}`);
      assert.equal(ladder.mode, mode);
      assert.deepEqual(ladder.rows, []);
    }

    const badMode = await fetch(`${ts.base}/api/leaderboard?mode=nope`);
    assert.equal(badMode.status, 400);
    assert.ok((await badMode.json()).error);
    const practiceLadder = await fetch(`${ts.base}/api/leaderboard?mode=practice`);
    assert.equal(practiceLadder.status, 400, "practice is not a ranked mode");

    const missing = await fetch(`${ts.base}/api/definitely-missing`);
    assert.equal(missing.status, 404);
    assert.ok((await missing.json()).error);
  } finally {
    await ts.close();
  }
});

test("guest sessions: create, me, logout and validation", async () => {
  const ts = await startTestServer();
  try {
    const session = await guest(ts.base, "  小明  ");
    assert.equal(session.user.isGuest, true);
    assert.equal(session.user.name, "小明");
    assert.match(session.token, /^[0-9a-f]{64}$/);

    const me = await getJson<{ user: { id: string; name: string; isGuest: boolean }; ratings: Record<string, { rating: number }> }>(
      ts.base,
      "/api/me",
      session.token,
    );
    assert.equal(me.user.id, session.user.id);
    assert.equal(me.user.name, "小明");
    assert.equal(me.ratings.duel.rating, 1200);
    assert.deepEqual(Object.keys(me.ratings).sort(), ["duel", "ffa3", "team2v2"], "practice never appears in ratings");

    const unauthorized = await fetch(`${ts.base}/api/me`);
    assert.equal(unauthorized.status, 401);
    assert.ok((await unauthorized.json()).error);

    const emptyName = await post(ts.base, "/api/session/guest", { name: "" });
    assert.equal(emptyName.status, 400);
    const longName = await post(ts.base, "/api/session/guest", { name: "一".repeat(17) });
    assert.equal(longName.status, 400);
    const missingName = await post(ts.base, "/api/session/guest", {});
    assert.equal(missingName.status, 400);

    const logout = await post(ts.base, "/api/auth/logout", {}, session.token);
    assert.equal(logout.status, 200);
    assert.deepEqual(logout.json, { ok: true });
    assert.equal((await fetch(`${ts.base}/api/me`, { headers: { authorization: `Bearer ${session.token}` } })).status, 401);
    const logoutAgain = await post(ts.base, "/api/auth/logout", {}, session.token);
    assert.equal(logoutAgain.status, 401);
  } finally {
    await ts.close();
  }
});

test("registration and login rules", async () => {
  const ts = await startTestServer();
  try {
    const session = await register(ts.base, "Alice_01", "secret1", "爱丽丝");
    assert.equal(session.user.isGuest, false);
    assert.equal(session.user.username, "Alice_01");
    assert.equal(session.user.name, "爱丽丝");

    const duplicate = await post(ts.base, "/api/auth/register", {
      username: "alice_01",
      password: "secret2",
    });
    assert.equal(duplicate.status, 409);
    assert.ok(duplicate.json.error);

    for (const username of ["ab", "has space", "bad!", "a".repeat(21)]) {
      const invalid = await post(ts.base, "/api/auth/register", { username, password: "secret1" });
      assert.equal(invalid.status, 400, username);
    }
    const shortPassword = await post(ts.base, "/api/auth/register", {
      username: "bob_01",
      password: "12345",
    });
    assert.equal(shortPassword.status, 400);

    const login = await post(ts.base, "/api/auth/login", { username: "alice_01", password: "secret1" });
    assert.equal(login.status, 200);
    const loginToken = login.json.token as string;
    assert.match(loginToken, /^[0-9a-f]{64}$/);
    assert.notEqual(loginToken, session.token, "login creates a fresh token");
    const me = await getJson<{ user: { id: string } }>(ts.base, "/api/me", loginToken);
    assert.equal(me.user.id, session.user.id);

    const wrongPassword = await post(ts.base, "/api/auth/login", { username: "alice_01", password: "wrong-pass" });
    assert.equal(wrongPassword.status, 401);
    const unknownUser = await post(ts.base, "/api/auth/login", { username: "nobody_1", password: "secret1" });
    assert.equal(unknownUser.status, 401);
  } finally {
    await ts.close();
  }
});

test("store.json persists users/sessions with hashed passwords and no tmp leftovers", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ciying-persist-"));
  try {
    const first = await startTestServer({ dataDir, persistStore: true });
    const guestSession = await guest(first.base, "持久游客");
    const registered = await register(first.base, "persist_1", "topsecret");
    await first.close();

    const files = readdirSync(dataDir);
    assert.ok(files.includes("store.json"), `store.json missing: ${files.join(",")}`);
    assert.equal(files.some((file) => file.endsWith(".tmp")), false, "atomic write must clean tmp files");

    const raw = readFileSync(join(dataDir, "store.json"), "utf8");
    assert.equal(raw.includes("topsecret"), false, "password must never be stored in plaintext");
    assert.equal(raw.includes("密码"), false, "password must never be stored in plaintext");
    const parsed = JSON.parse(raw) as {
      users: Array<{ username?: string; passHash?: string; salt?: string; isGuest: boolean }>;
      sessions: Record<string, string>;
      ratings: Record<string, Record<string, unknown>>;
      stats: Record<string, Record<string, unknown>>;
      matches: unknown[];
    };
    const user = parsed.users.find((candidate) => candidate.username === "persist_1");
    assert.ok(user);
    assert.equal(user!.isGuest, false);
    assert.match(user!.passHash ?? "", /^[0-9a-f]{128}$/);
    assert.match(user!.salt ?? "", /^[0-9a-f]{32}$/);
    assert.ok(Object.keys(parsed.sessions).length >= 2);
    assert.ok(parsed.stats && typeof parsed.stats === "object", "stats section is persisted");
    assert.deepEqual(parsed.stats.duel ?? {}, {});
    assert.deepEqual(parsed.matches, []);

    // A restarted server restores sessions and users from disk.
    const second = await startTestServer({ dataDir, persistStore: true });
    try {
      const meGuest = await getJson<{ user: { id: string } }>(second.base, "/api/me", guestSession.token);
      assert.equal(meGuest.user.id, guestSession.user.id);
      const meRegistered = await getJson<{ user: { id: string; isGuest: boolean } }>(
        second.base,
        "/api/me",
        registered.token,
      );
      assert.equal(meRegistered.user.id, registered.user.id);
      assert.equal(meRegistered.user.isGuest, false);
      const login = await post(second.base, "/api/auth/login", { username: "persist_1", password: "topsecret" });
      assert.equal(login.status, 200);
    } finally {
      await second.close();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("stats endpoints: registered users get zeroed stats, guests are rejected", async () => {
  const ts = await startTestServer();
  try {
    const registered = await register(ts.base, "stats_rest", "secret1", "统计用户");
    const stats = await getJson<{
      total: { matches: number; winRate: number };
      modes: Record<string, { matches: number; setsWon: number }>;
    }>(ts.base, "/api/stats/me", registered.token);
    assert.equal(stats.total.matches, 0);
    assert.equal(stats.total.winRate, 0);
    assert.deepEqual(Object.keys(stats.modes).sort(), ["duel", "ffa3", "practice", "team2v2"]);
    for (const mode of ["duel", "ffa3", "team2v2", "practice"]) {
      assert.equal(stats.modes[mode].matches, 0);
      assert.equal(stats.modes[mode].setsWon, 0);
    }
    const publicStats = await getJson<{ total: { matches: number } }>(
      ts.base,
      `/api/stats/${registered.user.id}`,
    );
    assert.equal(publicStats.total.matches, 0);

    const guestSession = await guest(ts.base, "统计游客");
    const guestStats = await fetch(`${ts.base}/api/stats/me`, {
      headers: { authorization: `Bearer ${guestSession.token}` },
    });
    assert.equal(guestStats.status, 401);
    const anonymous = await fetch(`${ts.base}/api/stats/me`);
    assert.equal(anonymous.status, 401);
    const missing = await fetch(`${ts.base}/api/stats/u_does_not_exist`);
    assert.equal(missing.status, 404);
  } finally {
    await ts.close();
  }
});

test("site stats, profile update and nickname uniqueness", async () => {
  const ts = await startTestServer();
  try {
    const site0 = await getJson<{ registeredUsers: number; onlineUsers: number }>(ts.base, "/api/site");
    assert.deepEqual(site0, { registeredUsers: 0, onlineUsers: 0 });

    // Guests do not count as registered users.
    await guest(ts.base, "站点游客");
    const siteGuest = await getJson<{ registeredUsers: number }>(ts.base, "/api/site");
    assert.equal(siteGuest.registeredUsers, 0);

    const first = await register(ts.base, "profile_one", "secret1", "资料甲");
    assert.equal(first.user.avatar, "资", "default avatar is the first character");
    const second = await register(ts.base, "profile_two", "secret1", "资料乙");

    // A nickname already used by a registered user is rejected.
    const duplicate = await post(ts.base, "/api/auth/register", {
      username: "profile_three",
      password: "secret1",
      name: "资料甲",
    });
    assert.equal(duplicate.status, 409);
    assert.match(String(duplicate.json.error), /昵称/);

    // PATCH profile updates name + avatar and the session returns the new user.
    const updated = await requestJson(ts.base, "PATCH", "/api/me/profile", { name: "新昵称", avatar: "🎯" }, first.token);
    assert.equal(updated.status, 200);
    const updatedUser = updated.json.user as { name: string; avatar: string };
    assert.equal(updatedUser.name, "新昵称");
    assert.equal(updatedUser.avatar, "🎯");
    const me = await getJson<{ user: { name: string; avatar: string } }>(ts.base, "/api/me", first.token);
    assert.equal(me.user.name, "新昵称");
    assert.equal(me.user.avatar, "🎯");

    // POST works as an alias of PATCH.
    const viaPost = await post(ts.base, "/api/me/profile", { name: "POST昵称" }, second.token);
    assert.equal(viaPost.status, 200);

    // Duplicate name on update is rejected.
    const duplicateUpdate = await requestJson(
      ts.base,
      "PATCH",
      "/api/me/profile",
      { name: "POST昵称" },
      first.token,
    );
    assert.equal(duplicateUpdate.status, 409);

    // Validation.
    const emptyName = await requestJson(ts.base, "PATCH", "/api/me/profile", { name: "  " }, first.token);
    assert.equal(emptyName.status, 400);
    const badAvatar = await requestJson(ts.base, "PATCH", "/api/me/profile", { avatar: "😀".repeat(80) }, first.token);
    assert.equal(badAvatar.status, 400);
    const longTextAvatar = await requestJson(ts.base, "PATCH", "/api/me/profile", { avatar: "😀".repeat(17) }, first.token);
    assert.equal(longTextAvatar.status, 400);
    const htmlAvatar = await requestJson(ts.base, "PATCH", "/api/me/profile", { avatar: "<svg/onload=1>" }, first.token);
    assert.equal(htmlAvatar.status, 400);

    // Inline base64 image avatars (png/jpeg/webp) are accepted.
    const dataUrls = [
      "data:image/png;base64,iVBORw0KGgo=",
      "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
      "data:image/webp;base64,UklGRg==",
    ];
    for (const dataUrl of dataUrls) {
      const uploaded = await requestJson(ts.base, "PATCH", "/api/me/profile", { avatar: dataUrl }, first.token);
      assert.equal(uploaded.status, 200);
      assert.equal((uploaded.json.user as { avatar: string }).avatar, dataUrl);
    }
    const afterUpload = await getJson<{ user: { avatar: string } }>(ts.base, "/api/me", first.token);
    assert.equal(afterUpload.user.avatar, dataUrls[2]);

    // SVG, external links, oversized payloads and empty data URLs are rejected.
    for (const bad of [
      "data:image/svg+xml;base64,PHN2Zz4=",
      "data:image/gif;base64,R0lGODlhAQABAAAAACw=",
      "data:image/png;base64,",
      `data:image/png;base64,${"A".repeat(20_001)}`,
      "http://evil.test/avatar.png",
      "https://evil.test/avatar.png",
      "//evil.test/avatar.png",
      "javascript:alert(1)",
    ]) {
      const rejected = await requestJson(ts.base, "PATCH", "/api/me/profile", { avatar: bad }, first.token);
      assert.equal(rejected.status, 400, `avatar should be rejected: ${bad.slice(0, 40)}`);
    }

    const guestSession = await guest(ts.base, "资料游客");
    const guestProfile = await requestJson(ts.base, "PATCH", "/api/me/profile", { name: "游客改名" }, guestSession.token);
    assert.equal(guestProfile.status, 403);

    const siteFinal = await getJson<{ registeredUsers: number; onlineUsers: number }>(ts.base, "/api/site");
    assert.equal(siteFinal.registeredUsers, 2);
  } finally {
    await ts.close();
  }
});

test("guest cleanup: deletions happen when the guest has no seat/queue/spectate", async () => {
  const ts = await startTestServer();
  const clients: TestClient[] = [];
  try {
    // Plain guest: closing the socket deletes the guest and its sessions.
    const plain = await guest(ts.base, "临时游客甲");
    const plainClient = await connectClient(ts.wsBase, plain.token);
    clients.push(plainClient);
    const online = await getJson<{ onlineUsers: number }>(ts.base, "/api/site");
    assert.equal(online.onlineUsers, 1);
    await plainClient.close();
    await new Promise((resolve) => setTimeout(resolve, 120));
    const afterPlain = await fetch(`${ts.base}/api/me`, {
      headers: { authorization: `Bearer ${plain.token}` },
    });
    assert.equal(afterPlain.status, 401, "guest user and sessions are deleted");
    const offline = await getJson<{ onlineUsers: number }>(ts.base, "/api/site");
    assert.equal(offline.onlineUsers, 0);

    // Registered users are never deleted on disconnect.
    const registered = await register(ts.base, "keep_me", "secret1", "保留用户");
    const regClient = await connectClient(ts.wsBase, registered.token);
    clients.push(regClient);
    await regClient.close();
    await new Promise((resolve) => setTimeout(resolve, 120));
    const regMe = await getJson<{ user: { id: string } }>(ts.base, "/api/me", registered.token);
    assert.equal(regMe.user.id, registered.user.id);

    // Guest in a practice room: disconnect removes the room first, then the guest.
    const practicer = await guest(ts.base, "练习游客甲");
    const practiceClient = await connectClient(ts.wsBase, practicer.token);
    clients.push(practiceClient);
    practiceClient.send({ type: "room.create", mode: "practice", visibility: "private" });
    await practiceClient.nextState((state) => state.mode === "practice" && state.status === "playing");
    await practiceClient.close();
    await new Promise((resolve) => setTimeout(resolve, 120));
    const afterPractice = await fetch(`${ts.base}/api/me`, {
      headers: { authorization: `Bearer ${practicer.token}` },
    });
    assert.equal(afterPractice.status, 401);

    // Guest waiting in the queue: disconnect drops the queue slot, then the account.
    const queued = await guest(ts.base, "排队游客甲");
    const queueClient = await connectClient(ts.wsBase, queued.token);
    clients.push(queueClient);
    queueClient.send({ type: "queue.join", mode: "ffa3" });
    await queueClient.next((message) => message.type === "queue");
    await queueClient.close();
    await new Promise((resolve) => setTimeout(resolve, 120));
    const afterQueue = await fetch(`${ts.base}/api/me`, {
      headers: { authorization: `Bearer ${queued.token}` },
    });
    assert.equal(afterQueue.status, 401, "queue slot is dropped on disconnect");
  } finally {
    await closeAllGuests(clients);
    await ts.close();
  }
});

async function closeAllGuests(clients: TestClient[]): Promise<void> {
  for (const client of clients) {
    await client.close().catch(() => undefined);
  }
}

test("legacy store.json is migrated with default avatars and match fields", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "ciying-legacy-"));
  try {
    const legacy = {
      version: 1,
      users: [
        {
          id: "u_legacy",
          name: "旧用户",
          username: "legacy_user",
          isGuest: false,
          createdAt: Date.now() - 1_000,
        },
      ],
      sessions: { legacy_token: "u_legacy" },
      ratings: { duel: { u_legacy: { rating: 1234, games: 3, wins: 2, losses: 1, draws: 0 } } },
      stats: {
        duel: {
          u_legacy: {
            matches: 2,
            wins: 1,
            losses: 1,
            draws: 0,
            rounds: 4,
            roundsWithGuess: 3,
            guesses: 8,
            solves: 2,
            totalSolveMs: 3_000,
            fastestSolveMs: 1_200,
            fastestMatchAwards: 0,
            points: 2,
            setsWon: 1,
          },
        },
      },
      matches: [
        {
          id: "m_legacy",
          mode: "duel",
          endedAt: Date.now() - 500,
          winnerName: "旧用户",
          winnerTeam: null,
          isDraw: false,
          rounds: 2,
          players: [{ id: "u_legacy", name: "旧用户", team: null, score: 2 }],
        },
      ],
    };
    writeFileSync(join(dataDir, "store.json"), JSON.stringify(legacy), "utf8");

    const ts = await startTestServer({ dataDir, persistStore: true });
    try {
      const me = await getJson<{ user: { name: string; avatar: string } }>(ts.base, "/api/me", "legacy_token");
      assert.equal(me.user.name, "旧用户");
      assert.equal(me.user.avatar, "旧", "old users get a default avatar");

      // Old stat rows keep their counters and gain zeroed placement fields.
      const stats = await getJson<{
        total: { firsts: number; seconds: number; thirds: number };
        modes: { duel: { matches: number; firsts: number; seconds: number; thirds: number } };
      }>(ts.base, "/api/stats/me", "legacy_token");
      assert.equal(stats.modes.duel.matches, 2);
      assert.equal(stats.modes.duel.firsts, 0);
      assert.equal(stats.modes.duel.seconds, 0);
      assert.equal(stats.modes.duel.thirds, 0);
      assert.equal(stats.total.firsts, 0);
      assert.equal(stats.total.seconds, 0);
      assert.equal(stats.total.thirds, 0);

      const ladder = await getJson<{
        rows: Array<{ userId: string; firsts: number; seconds: number; thirds: number }>;
      }>(ts.base, "/api/leaderboard?mode=duel");
      const legacyRow = ladder.rows.find((row) => row.userId === "u_legacy");
      assert.ok(legacyRow);
      assert.equal(legacyRow!.firsts, 0);
      assert.equal(legacyRow!.seconds, 0);
      assert.equal(legacyRow!.thirds, 0);

      const recent = await getJson<{ matches: Array<Record<string, unknown>> }>(ts.base, "/api/matches/recent");
      const match = recent.matches[0] as {
        players: Array<{ avatar: string; setWins: number }>;
        rules: { bestOf: number };
        setHistory: unknown[];
        forfeitById: string | null;
        winnerId: string | null;
        highlights: Record<string, unknown[]>;
      };
      assert.equal(match.players[0].avatar, "旧", "old summaries get default avatars");
      assert.equal(match.players[0].setWins, 0);
      assert.deepEqual(match.setHistory, []);
      assert.equal(match.forfeitById, null);
      assert.equal(match.winnerId, null, "old summaries default winnerId to null");
      assert.deepEqual(match.highlights, {}, "old summaries default highlights to an empty object");
      assert.ok(match.rules && typeof match.rules.bestOf === "number");

      const history = await getJson<{ rows: Array<Record<string, unknown>> }>(
        ts.base,
        "/api/me/matches",
        "legacy_token",
      );
      assert.equal(history.rows.length, 1);
      assert.deepEqual(history.rows[0].opponentNames, []);
      assert.equal(history.rows[0].ratingBefore, null);
      assert.equal(history.rows[0].forfeit, false);
      assert.equal(history.rows[0].winnerId, null, "old history defaults winnerId to null");
      const legacyPlayers = history.rows[0].players as Array<{
        id: string;
        avatar: string;
        team: string | null;
        score: number;
        setWins: number;
      }>;
      assert.equal(legacyPlayers.length, 1);
      assert.equal(legacyPlayers[0].id, "u_legacy");
      assert.equal(legacyPlayers[0].avatar, "旧");
      assert.equal(legacyPlayers[0].team, null);
      assert.equal(legacyPlayers[0].score, 2);
      assert.equal(legacyPlayers[0].setWins, 0);
      assert.deepEqual(history.rows[0].setHistory, []);
      assert.deepEqual(history.rows[0].smallScores, { u_legacy: 2 });

      // Old users have no recentIdioms array; the endpoint returns an empty list.
      const idioms = await getJson<{ rows: unknown[] }>(ts.base, "/api/me/idioms", "legacy_token");
      assert.deepEqual(idioms.rows, []);

      // Old users have no streak fields: zeroed stats and empty boards.
      const streakStats = await getJson<{
        runs: number;
        solved: number;
        best: number;
        totalSolveMs: number;
        fastestSolveMs: number;
      }>(
        ts.base,
        "/api/streak/stats",
        "legacy_token",
      );
      assert.deepEqual(streakStats, {
        runs: 0,
        solved: 0,
        best: 0,
        totalSolveMs: 0,
        fastestSolveMs: 0,
      });
      const streakBoard = await getJson<{ rows: unknown[] }>(
        ts.base,
        "/api/streak/leaderboard?variant=standard",
        "legacy_token",
      );
      assert.deepEqual(streakBoard.rows, []);

      // Old users get default social data and privacy settings.
      const legacyFriends = await getJson<{
        friends: unknown[];
        incoming: unknown[];
        outgoing: unknown[];
        notifications: unknown[];
        unread: number;
      }>(ts.base, "/api/friends", "legacy_token");
      assert.deepEqual(legacyFriends, {
        friends: [],
        incoming: [],
        outgoing: [],
        notifications: [],
        unread: 0,
      });
      const legacyPrivacy = await getJson<{ showStatsToFriends: boolean }>(
        ts.base,
        "/api/me/privacy",
        "legacy_token",
      );
      assert.deepEqual(legacyPrivacy, { showStatsToFriends: true });
    } finally {
      await ts.close();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("server provides a fallback page when the web build is missing", async () => {
  const ts = await startTestServer({ publicDir: join(tmpdir(), "ciying-missing-public-dir") });
  try {
    const health = await getJson<{ ok: boolean }>(ts.base, "/api/health");
    assert.equal(health.ok, true);
    const page = await fetch(`${ts.base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /词影竞技场/);
    const asset = await fetch(`${ts.base}/js/app.js`);
    assert.equal(asset.status, 404);
  } finally {
    await ts.close();
  }
});
