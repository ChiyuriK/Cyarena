import { WebSocket } from "ws";

const BASE = process.env.BASE ?? "http://127.0.0.1:3000";
const WS_BASE = BASE.replace(/^http/, "ws");
async function json(path, options = {}) {
  const response = await fetch(BASE + path, options);
  const data = await response.json().catch(() => null);
  return { status: response.status, data };
}
async function register(name) {
  const username = `r9_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4)}`;
  const result = await json("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: "secret123", name }),
  });
  if (result.status !== 201) throw new Error("register " + JSON.stringify(result));
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
      const index = this.waiters.findIndex((w) => w.predicate(message));
      if (index >= 0) {
        const [w] = this.waiters.splice(index, 1);
        clearTimeout(w.timer);
        w.resolve(message);
      }
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("ws timeout")), 5000);
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
  waitFor(predicate, timeout = 10000) {
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
  async state(predicate, timeout = 10000) {
    return (await this.waitFor((m) => m.type === "state" && predicate(m.state), timeout)).state;
  }
  close() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close();
  }
}

const suffix = Date.now().toString(36).slice(-4);
const a = await register(`求和甲${suffix}`);
const b = await register(`求和乙${suffix}`);
const ca = new Client("A");
const cb = new Client("B");
await Promise.all([ca.connect(a.token), cb.connect(b.token)]);
ca.send({
  type: "room.create",
  mode: "duel",
  visibility: "private",
  bestOf: 1,
  guessMode: "free",
  dictionary: "common",
  pointsToWin: 11,
});
const created = await ca.state((s) => s.mode === "duel" && s.players.length === 1);
cb.send({ type: "room.join", code: created.code });
await ca.state((s) => s.players.length === 2);
cb.send({ type: "room.ready", ready: true });
await ca.state((s) => s.players.filter((p) => !p.isHost).every((p) => p.ready));
ca.send({ type: "room.start" });
await ca.state((s) => s.status === "playing");
ca.send({ type: "room.offerDraw" });
const offered = await cb.state((s) => Boolean(s.drawOffer));
if (offered.drawOffer.proposerId !== a.user.id) throw new Error("wrong proposer");
cb.send({ type: "room.respondDraw", accept: true });
const ended = await ca.state((s) => s.status === "matchEnd");
if (!ended.match.isDraw) throw new Error("match not draw");
if (ended.drawOffer) throw new Error("drawOffer not cleared");
if (Object.keys(ended.match.ratingDeltas).length !== 2) throw new Error("ratingDeltas missing");
for (const value of Object.values(ended.match.ratingDeltas)) {
  if (Number(value) !== 0) throw new Error("draw rating delta should be 0");
}
const history = await json("/api/me/matches", {
  headers: { authorization: `Bearer ${a.token}` },
});
const row = history.data.rows[0];
if (!row || !row.isDraw || !row.players || row.players.length !== 2) throw new Error("history draw row wrong");
const mobileCss = await (await fetch(BASE + "/styles.css")).text();
if (!mobileCss.includes(".user-greeting-text")) throw new Error("mobile account CSS missing");
console.log("R9 DRAW OK", JSON.stringify({ isDraw: ended.match.isDraw, ratingDeltas: ended.match.ratingDeltas, historyPlayers: row.players.length }));
ca.close();
cb.close();
process.exit(0);
