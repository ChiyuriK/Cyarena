import { WebSocket } from "ws";

const BASE = process.env.BASE ?? "http://127.0.0.1:3000";
const WS_BASE = BASE.replace(/^http/, "ws");

async function post(path, body) {
  const response = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} ${response.status}`);
  return response.json();
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
      const index = this.waiters.findIndex((waiter) => waiter.predicate(message));
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
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
    await this.waitFor((message) => message.type === "hello");
  }

  send(message) {
    this.ws.send(JSON.stringify(message));
  }

  waitFor(predicate, timeout = 8000) {
    const buffered = this.messages.findIndex(predicate);
    if (buffered >= 0) return Promise.resolve(this.messages.splice(buffered, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter.timer !== timer);
        reject(new Error(`${this.name}: timeout`));
      }, timeout);
      this.waiters.push({ predicate, resolve, timer });
    });
  }

  async state(predicate, timeout = 8000) {
    const message = await this.waitFor(
      (item) => item.type === "state" && predicate(item.state),
      timeout,
    );
    return message.state;
  }

  close() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close();
  }
}

const aSession = await post("/api/session/guest", { name: "PracticeA" });
const bSession = await post("/api/session/guest", { name: "TeamB" });
const cSession = await post("/api/session/guest", { name: "TeamC" });
const a = new Client("A");
const b = new Client("B");
const c = new Client("C");
await Promise.all([a.connect(aSession.token), b.connect(bSession.token), c.connect(cSession.token)]);

a.send({ type: "room.create", mode: "practice", visibility: "private", guessMode: "standard" });
const practice = await a.state((state) => state.mode === "practice");
if (practice.status !== "playing" || practice.players.length !== 1) throw new Error("practice not auto-started");
if (practice.round.endsAt !== 0) throw new Error("practice idle timer must be disabled");
a.send({ type: "room.guess", word: "画蛇添足" });
const practiceRow = await a.state((state) => state.round.rows.length >= 1 || state.round.status === "ended");
console.log("practice ok", practice.mode, "players", practice.players.length, "rows", practiceRow.round.rows.length);
a.send({ type: "room.leave" });
await new Promise((resolve) => setTimeout(resolve, 100));

a.send({ type: "room.create", mode: "team2v2", visibility: "private", bestOf: 3, guessMode: "standard" });
const created = await a.state((state) => state.mode === "team2v2" && state.players.length === 1);
const code = created.code;
console.log("team created", code);
b.send({ type: "room.join", code });
c.send({ type: "room.join", code });
const joined = await a.state((state) => state.mode === "team2v2" && state.players.length === 3);
console.log("joined", joined.players.map((player) => `${player.name}:${player.team}`).join(" "));
a.send({ type: "room.setTeam", team: "B", userId: cSession.user.id });
const moved = await a.state(
  (state) =>
    state.mode === "team2v2" &&
    state.players.filter((player) => player.team === "A").length === 1 &&
    state.players.filter((player) => player.team === "B").length === 2,
);
console.log("moved", moved.players.map((player) => `${player.name}:${player.team}`).join(" "));
b.send({ type: "room.ready", ready: true });
c.send({ type: "room.ready", ready: true });
await a.state((state) => state.players.filter((player) => !player.isHost).every((player) => player.ready));
a.send({ type: "room.start" });
const playing = await a.state((state) => state.mode === "team2v2" && state.status === "playing");
console.log("team ok", playing.players.map((player) => `${player.name}:${player.team}`).join(" "), "bestOf", playing.match.bestOf);

const help = await (await fetch(BASE + "/js/views/help.js")).text();
if (!help.includes("cy.surprising.studio") || !help.includes("store.steampowered.com/app/2331660")) {
  throw new Error("help links missing");
}
if (help.includes("·") || /[^|]\|[^|]/.test(help)) throw new Error("help has banned separators");

a.close();
b.close();
c.close();
console.log("R4 E2E OK");
process.exit(0);
