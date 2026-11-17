import { loadGameData } from "../packages/engine/src/data.ts";
import { dailyDateKey, dailyAnswer } from "../apps/server/src/daily.ts";

const BASE = process.env.BASE ?? "http://127.0.0.1:3000";
const data = loadGameData();
const date = dailyDateKey();
const answer = dailyAnswer(data, date);
const username = `daily_${Date.now().toString(36)}`;
const register = await fetch(BASE + "/api/auth/register", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username, password: "secret123", name: `每日测试${username.slice(-4)}` }),
});
const session = await register.json();
if (!session.token) throw new Error("register failed " + JSON.stringify(session));
const auth = { authorization: `Bearer ${session.token}` };
const before = await fetch(BASE + "/api/daily", { headers: auth }).then((r) => r.json());
if (before.answer !== null || before.solved) throw new Error("daily leaked answer before solve");
const wrong = await fetch(BASE + "/api/daily/guess", {
  method: "POST",
  headers: { "content-type": "application/json", ...auth },
  body: JSON.stringify({ word: "天地玄黄" }),
});
if (wrong.status !== 200) {
  const body = await wrong.text();
  if (!body.includes("词库")) throw new Error("wrong guess unexpected " + wrong.status + " " + body);
}
const solvedResponse = await fetch(BASE + "/api/daily/guess", {
  method: "POST",
  headers: { "content-type": "application/json", ...auth },
  body: JSON.stringify({ word: answer }),
});
const solved = await solvedResponse.json();
if (!solved.solved || solved.answer !== answer) throw new Error("daily not solved " + JSON.stringify(solved));
if (!solved.explanation || !solved.me || solved.me.rank === null) throw new Error("daily result incomplete");
const again = await fetch(BASE + "/api/daily/guess", {
  method: "POST",
  headers: { "content-type": "application/json", ...auth },
  body: JSON.stringify({ word: answer }),
});
if (again.status !== 400) throw new Error("daily solved repeat should be 400");
const guest = await fetch(BASE + "/api/daily/guess", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ word: answer }),
});
if (guest.status !== 401) throw new Error("guest daily should be 401");
console.log("R14 DAILY OK", { date, answer, rank: solved.me.rank, attempts: solved.attempts, explanation: solved.explanation.slice(0, 20) });
process.exit(0);
