const BASE = process.env.BASE ?? "http://127.0.0.1:3000";
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=";

async function json(path, options = {}) {
  const response = await fetch(BASE + path, options);
  const data = await response.json().catch(() => null);
  return { status: response.status, data };
}

const user = `r7_${Date.now().toString(36)}`;
const registered = await json("/api/auth/register", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: user, password: "secret123", name: "头像测试" }),
});
if (registered.status !== 201) throw new Error("register failed");
const token = registered.data.token;

const updated = await json("/api/me/profile", {
  method: "PATCH",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify({ avatar: PNG }),
});
if (updated.status !== 200 || updated.data.user.avatar !== PNG) {
  throw new Error("avatar data URL not saved " + JSON.stringify(updated));
}
const me = await json("/api/me", { headers: { authorization: `Bearer ${token}` } });
if (me.status !== 200 || me.data.user.avatar !== PNG) throw new Error("avatar not persisted");

const svg = await json("/api/me/profile", {
  method: "PATCH",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify({ avatar: "data:image/svg+xml;base64,PHN2Zy8+" }),
});
if (svg.status !== 400) throw new Error("SVG avatar should be rejected");

const history = await json("/api/me/matches", {
  headers: { authorization: `Bearer ${token}` },
});
if (history.status !== 200 || !Array.isArray(history.data.rows)) throw new Error("history failed");

const changelog = await (await fetch(BASE + "/js/views/changelog.js")).text();
if (!changelog.includes("2026-11-10")) throw new Error("changelog date missing");
if (changelog.includes("ICP") || changelog.includes("备案")) throw new Error("changelog has ICP");
if (changelog.includes("第一轮") || changelog.includes("第四轮")) throw new Error("old changelog remains");
const lobby = await (await fetch(BASE + "/js/views/lobby.js")).text();
if (lobby.includes("recentRounds") || lobby.includes("lobbyRecent")) throw new Error("lobby still has recent rounds");
const historySource = await (await fetch(BASE + "/js/views/history.js")).text();
if (!historySource.includes("row.players")) throw new Error("history not using players");
console.log("R7 E2E OK", { avatar: me.data.user.avatar.length, changelogDate: "2026-11-10" });
process.exit(0);
