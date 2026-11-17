import { WebSocket } from "ws";

const BASE = process.env.BASE ?? "http://127.0.0.1:3000";
const WS_BASE = BASE.replace(/^http/, "ws");
let seq = Date.now().toString(36).slice(-5);

async function json(path, options = {}) {
  const response = await fetch(BASE + path, options);
  const data = await response.json().catch(() => null);
  return { status: response.status, data };
}

async function register(name) {
  const username = `r6_${seq}_${Math.floor(Math.random() * 1e5)}`;
  const result = await json("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: "secret123", name }),
  });
  if (result.status !== 201) throw new Error("register failed " + JSON.stringify(result));
  return result.data;
}

class Client {
  constructor(name) {
    this.name = name;
    this.messages = [];
    this.waiters = [];
  }
  async connect(token) {
    this.ws = new WebSocket(`${WS_BASE}/ws?token=${encodeURIComponent(token)}`);
    this.ws.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      this.messages.push(message);
      const idx = this.waiters.findIndex((w) => w.predicate(message));
      if (idx >= 0) {
        const [w] = this.waiters.splice(idx, 1);
        clearTimeout(w.timer);
        w.resolve(message);
      }
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.name} ws timeout`)), 5000);
      this.ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.once("error", reject);
    });
    await this.waitFor((m) => m.type === "hello");
  }
  send(message) {
    this.ws.send(JSON.stringify(message));
  }
  waitFor(predicate, timeout = 8000) {
    const buffered = this.messages.findIndex(predicate);
    if (buffered >= 0) return Promise.resolve(this.messages.splice(buffered, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(new Error(`${this.name}: timeout`));
      }, timeout);
      this.waiters.push({ predicate, resolve, timer });
    });
  }
  async state(predicate, timeout = 8000) {
    const message = await this.waitFor(
      (m) => m.type === "state" && predicate(m.state),
      timeout,
    );
    return message.state;
  }
  close() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close();
  }
}

const aSession = await register("R6甲");
const bSession = await register("R6乙");

// profile avatar + unique nickname
const update = await json("/api/me/profile", {
  method: "PATCH",
  headers: { "content-type": "application/json", authorization: `Bearer ${aSession.token}` },
  body: JSON.stringify({ avatar: "🐟", name: "R6甲改" }),
});
if (update.status !== 200 || update.data.user.name !== "R6甲改" || update.data.user.avatar !== "🐟") {
  throw new Error("profile update failed " + JSON.stringify(update));
}
const duplicate = await json("/api/me/profile", {
  method: "PATCH",
  headers: { "content-type": "application/json", authorization: `Bearer ${bSession.token}` },
  body: JSON.stringify({ name: "R6甲改" }),
});
if (duplicate.status !== 409) throw new Error("duplicate nickname not rejected");

const site = await json("/api/site");
if (site.status !== 200 || site.data.registeredUsers < 2) throw new Error("site stats failed");
const history = await json("/api/me/matches", {
  headers: { authorization: `Bearer ${aSession.token}` },
});
if (history.status !== 200 || !Array.isArray(history.data.rows)) throw new Error("history failed");

// quick match + rules negotiation
const a = new Client("A");
const b = new Client("B");
await Promise.all([a.connect(aSession.token), b.connect(bSession.token)]);
a.send({ type: "queue.join", mode: "duel" });
b.send({ type: "queue.join", mode: "duel" });
const foundA = await a.waitFor((m) => m.type === "match.found");
const foundB = await b.waitFor((m) => m.type === "match.found");
const code = foundA.code;
if (foundB.code !== code) throw new Error("match code mismatch");
const room = await a.state((s) => s.mode === "duel" && s.players.length === 2);
if (!room.requiresAgreement || room.rulesAgreed) throw new Error("quick match should require agreement");
if (room.rules.bestOf !== 1 || room.rules.guessMode !== "free" || room.rules.dictionary !== "common") {
  throw new Error("quick match defaults wrong " + JSON.stringify(room.rules));
}
a.send({
  type: "room.proposeRules",
  rules: { bestOf: 1, guessMode: "standard", dictionary: "all", pointsToWin: 7 },
});
const proposal = await b.state((s) => Boolean(s.proposal));
if (!proposal.proposal) throw new Error("proposal missing");
b.send({ type: "room.acceptRules", proposalId: proposal.proposal.id });
const agreed = await a.state((s) => s.rulesAgreed === true);
if (agreed.rules.pointsToWin !== 7 || agreed.rules.dictionary !== "all") throw new Error("rules not applied");
a.send({ type: "room.start" });
const playing = await a.state((s) => s.status === "playing");
if (playing.rules.pointsToWin !== 7) throw new Error("playing rules wrong");

// standard suggestion
a.send({ type: "room.guess", word: "不以为哦" });
const error = await a.waitFor((m) => m.type === "error");
if (!/你是否要输入/.test(error.message)) throw new Error("suggestion missing: " + error.message);
console.log("suggestion:", error.message);

// static help/changelog/ICP
for (const path of ["/js/views/help.js", "/js/views/changelog.js", "/js/views/history.js", "/"]) {
  const response = await fetch(BASE + path);
  if (!response.ok) throw new Error("static missing " + path);
}
const index = await (await fetch(BASE + "/")).text();
if (!index.includes("辽ICP备2026026747号-1")) throw new Error("ICP footer missing");

a.close();
b.close();
console.log("R6 E2E OK", code, JSON.stringify(playing.rules));
process.exit(0);
