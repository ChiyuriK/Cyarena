import { WebSocket } from "ws";

const BASE = process.env.BASE ?? "http://127.0.0.1:3123";
const WS_BASE = BASE.replace(/^http/, "ws");

async function post(path, body) {
  const response = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${path} failed ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

async function guest(name) {
  return post("/api/session/guest", { name });
}

class Client {
  constructor(name) {
    this.name = name;
    this.ws = null;
    this.messages = [];
    this.waiters = [];
  }

  async connect(token) {
    this.ws = new WebSocket(`${WS_BASE}/ws?token=${encodeURIComponent(token)}`);
    this.ws.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      this.messages.push(message);
      if (message.type === "error" || message.type === "toast") {
        console.log(`[${this.name}] ${message.type}: ${message.message}`);
      }
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

  waitFor(predicate, timeout = 8000, label = "message") {
    const buffered = this.messages.findIndex(predicate);
    if (buffered >= 0) {
      const [message] = this.messages.splice(buffered, 1);
      return Promise.resolve(message);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter.timer !== timer);
        reject(new Error(`${this.name}: timeout waiting for ${label}`));
      }, timeout);
      this.waiters.push({ predicate, resolve, timer });
    });
  }

  async state(predicate, timeout = 8000, label = "state") {
    const message = await this.waitFor(
      (item) => item.type === "state" && predicate(item.state),
      timeout,
      label,
    );
    return message.state;
  }

  close() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close();
  }
}

const a = await guest("E2E甲");
const b = await guest("E2E乙");
const c = await guest("E2E观众");
const ca = new Client("A");
const cb = new Client("B");
const cc = new Client("C");
await Promise.all([ca.connect(a.token), cb.connect(b.token), cc.connect(c.token)]);

ca.send({ type: "room.create", mode: "duel", visibility: "public", bestOf: 1, guessMode: "free" });
const created = await ca.state((state) => state.players.length === 1);
const code = created.code;
if (created.match.bestOf !== 1 || created.match.setsToWin !== 1) throw new Error("bestOf not applied");
if (created.match.pointsToWin !== 11 || created.match.pointLead !== 2) throw new Error("duel set rules wrong");
if (created.match.setNumber !== 1) throw new Error("setNumber wrong");
if (created.guessMode !== "free") throw new Error("guessMode not applied");
console.log("room", code, "mode", created.mode, "guessMode", created.guessMode, "bestOf", created.match.bestOf, "target", created.match.pointsToWin, "+", created.match.pointLead);

cb.send({ type: "room.join", code });
await ca.state((state) => state.players.length === 2, 8000, "A sees B");
const joined = await cb.state((state) => state.players.length === 2, 8000, "B joined");
console.log("joined", joined.players.map((player) => player.name).join(" / "));

ca.send({ type: "room.ready", ready: true });
cb.send({ type: "room.ready", ready: true });
await ca.state((state) => state.players.length === 2 && state.players.every((player) => player.ready), 5000, "both ready").then((state) => {
  console.log("ready players", state.players.map((player) => `${player.name}:${player.ready}/${player.isHost}`).join(", "));
});
ca.send({ type: "room.start" });
const playing = await ca.state((state) => state.status === "playing" && state.round.status === "playing", 10000, "round start");
if (playing.round.answer !== null) throw new Error("answer leaked during play!");
console.log("round", playing.round.index, "answer hidden, rows", playing.round.remainingRows);

cc.send({ type: "spectate.join", code });
const spectating = await cc.state((state) => state.viewerRole === "spectator", 8000, "spectator state");
console.log("spectator sees", spectating.players.length, "players, answer", spectating.round.answer);
cc.send({ type: "room.guess", word: "画龙点睛" });
const spectatorError = await cc.waitFor((message) => message.type === "error", 5000, "spectator error");
console.log("spectator blocked:", spectatorError.message);

const guesses = ["画龙点睛", "画饼充饥", "画地为牢", "画虎类犬", "画中有诗", "画意诗情"];
for (let index = 0; index < guesses.length; index += 1) {
  const client = index % 2 === 0 ? ca : cb;
  client.send({ type: "room.guess", word: guesses[index] });
  const state = await client.state(
    (item) => item.round.rows.length === index + 1 || item.round.status === "ended",
    8000,
    `row ${index + 1}`,
  );
  if (state.round.status === "ended") {
    console.log("round ended early with", guesses[index], "result", state.round.result);
    break;
  }
  console.log("row", index + 1, "guess", guesses[index], "remaining", state.round.remainingRows);
  await new Promise((resolve) => setTimeout(resolve, 2100));
}

const ended = await ca.state((state) => state.round.status === "ended", 10000, "round ended");
console.log("round result", ended.round.result, "answer", ended.round.answer);

ca.send({ type: "room.chat", scope: "room", text: "e2e hello\nworld" });
const chat = await ca.state((state) => state.chat.length > 0, 5000, "chat");
console.log("chat", JSON.stringify(chat.chat.at(-1).text));

const rooms = await (await fetch(BASE + "/api/rooms")).json();
const summary = rooms.rooms.find((room) => room.code === code);
console.log("lobby entry", summary ? `${summary.playerCount}/${summary.capacity} spectators=${summary.spectatorCount}` : "missing");

ca.close();
cb.close();
cc.close();
console.log("E2E SMOKE OK");
process.exit(0);
