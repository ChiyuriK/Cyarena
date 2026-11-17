import { WebSocket } from "ws";

const BASE = process.env.BASE ?? "http://127.0.0.1:3000";
const WS_BASE = BASE.replace(/^http/, "ws");

async function post(path, body) {
  const response = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, data: await response.json().catch(() => null) };
}

class Client {
  constructor() {
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
      const timer = setTimeout(() => reject(new Error("ws timeout")), 5000);
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
        reject(new Error("timeout"));
      }, timeout);
      this.waiters.push({ predicate, resolve, timer });
    });
  }
  async state(predicate, timeout = 8000) {
    return (await this.waitFor((message) => message.type === "state" && predicate(message.state), timeout)).state;
  }
  close() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close();
  }
}

const username = `release_${Date.now().toString(36)}`;
const registered = await post("/api/auth/register", {
  username,
  password: "secret123",
  name: `释放测试${username.slice(-4)}`,
});
if (registered.status !== 201) throw new Error("register failed");
const client = new Client();
await client.connect(registered.data.token);
const create = (visibility = "private") => ({
  type: "room.create",
  mode: "duel",
  visibility,
  bestOf: 1,
  guessMode: "free",
  dictionary: "common",
  pointsToWin: 11,
});
client.send(create());
const first = await client.state((state) => state.players.length === 1 && state.code);
client.send({ type: "room.leave" });
await client.state((state) => state.code === first.code && state.players[0].connected === false);
client.send(create());
const second = await client.state((state) => state.code !== first.code && state.players.length === 1);
console.log("R13 RELEASE OK", first.code, "->", second.code);
const leaderboard = await fetch(BASE + "/api/leaderboard?mode=ffa3").then((r) => r.json());
if (!leaderboard || !Array.isArray(leaderboard.rows)) throw new Error("ffa leaderboard not array");
console.log("ffaRows", leaderboard.rows.length);
client.close();
process.exit(0);
