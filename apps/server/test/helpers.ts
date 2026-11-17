import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import type {
  ClientMessage,
  RoomRules,
  RoomState,
  ServerMessage,
  SessionResponse,
} from "../../../packages/shared/src/index.ts";
import type { CreateServerOptions, ServerHandle } from "../src/index.ts";
import { createServer } from "../src/index.ts";
import type { RoomConfig } from "../src/rooms.ts";

/** Fast timers and accelerated 1v1/team sets so matches finish quickly in tests. */
export const TEST_CONFIG: Partial<RoomConfig> = {
  countdownMs: 40,
  roundEndMs: 25,
  setEndDelayMs: 25,
  guessCooldownMs: 0,
  idleTimeoutMs: 2_000,
  leaveGraceMs: 120,
  roomIdleMs: 60_000,
  ffaTargetScore: 2,
  pointsToWin: 2,
  pointLead: 1,
  defaultBestOf: 3,
};

export interface TestServer {
  server: ServerHandle;
  base: string;
  wsBase: string;
  dataDir: string;
  close(): Promise<void>;
}

export async function startTestServer(options: Partial<CreateServerOptions> = {}): Promise<TestServer> {
  const persist = options.persistStore ?? false;
  let ownsDir = false;
  let dataDir: string;
  if (persist) {
    dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), "ciying-test-"));
    ownsDir = !options.dataDir;
  } else {
    // In-memory store: the path is never touched.
    dataDir = options.dataDir ?? join(tmpdir(), "ciying-arena-memory-store");
  }
  let server: ServerHandle;
  try {
    server = await createServer({
      ...options,
      dataDir,
      persistStore: persist,
      streakIntermissionMs: options.streakIntermissionMs ?? 0,
      config: { ...TEST_CONFIG, ...(options.config ?? {}) },
      logger: false,
    });
    const port = await server.listen(0, "127.0.0.1");
    return {
      server,
      dataDir,
      base: `http://127.0.0.1:${port}`,
      wsBase: `ws://127.0.0.1:${port}`,
      async close(): Promise<void> {
        await server.close();
        if (ownsDir) rmSync(dataDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (ownsDir) rmSync(dataDir, { recursive: true, force: true });
    throw error;
  }
}

async function postJson(base: string, path: string, body: unknown, token?: string): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

export async function guest(base: string, name: string): Promise<SessionResponse> {
  const response = await postJson(base, "/api/session/guest", { name });
  if (response.status !== 200) throw new Error(`guest failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as SessionResponse;
}

export async function register(
  base: string,
  username: string,
  password: string,
  name?: string,
): Promise<SessionResponse> {
  const response = await postJson(base, "/api/auth/register", { username, password, name });
  if (response.status !== 201) throw new Error(`register failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as SessionResponse;
}

export async function getJson<T>(base: string, path: string, token?: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${base}${path}`, { headers });
  if (!response.ok) throw new Error(`GET ${path} failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

type StateMessage = { type: "state"; state: RoomState };
type ErrorMessage = { type: "error"; message: string };

export class TestClient {
  readonly ws: WebSocket;
  readonly received: ServerMessage[] = [];
  readonly pending: ServerMessage[] = [];
  private waiters: Array<{
    predicate: (message: ServerMessage) => boolean;
    resolve: (message: ServerMessage) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(data)) as ServerMessage;
      } catch {
        return;
      }
      this.received.push(message);
      const index = this.waiters.findIndex((waiter) => waiter.predicate(message));
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
        return;
      }
      this.pending.push(message);
    });
  }

  static async connect(wsBase: string, token: string): Promise<TestClient> {
    const ws = new WebSocket(`${wsBase}/ws?token=${encodeURIComponent(token)}`);
    const client = new TestClient(ws);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("ws open timeout")), 4_000);
      ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    return client;
  }

  send(message: ClientMessage): void {
    this.ws.send(JSON.stringify(message));
  }

  /** Wait for the next (possibly already buffered) matching message. */
  next<T extends ServerMessage = ServerMessage>(
    predicate: (message: ServerMessage) => boolean,
    timeoutMs = 4_000,
  ): Promise<T> {
    const bufferedIndex = this.pending.findIndex(predicate);
    if (bufferedIndex >= 0) {
      const [message] = this.pending.splice(bufferedIndex, 1);
      return Promise.resolve(message as T);
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter.timer !== timer);
        reject(new Error("timeout waiting for websocket message"));
      }, timeoutMs);
      this.waiters.push({
        predicate,
        resolve: (message) => resolve(message as T),
        timer,
      });
    });
  }

  nextState(predicate: (state: RoomState) => boolean, timeoutMs = 4_000): Promise<RoomState> {
    return this.next<StateMessage>(
      (message) => message.type === "state" && predicate((message as StateMessage).state),
      timeoutMs,
    ).then((message) => message.state);
  }

  nextError(timeoutMs = 4_000): Promise<string> {
    return this.next<ErrorMessage>((message) => message.type === "error", timeoutMs).then(
      (message) => message.message,
    );
  }

  lastState(): RoomState | null {
    for (let i = this.received.length - 1; i >= 0; i -= 1) {
      const message = this.received[i];
      if (message.type === "state") return (message as StateMessage).state;
    }
    return null;
  }

  states(): RoomState[] {
    return this.received
      .filter((message): message is StateMessage => message.type === "state")
      .map((message) => message.state);
  }

  close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        try {
          this.ws.terminate();
        } catch {
          /* ignore */
        }
        resolve();
      }, 250);
      this.ws.once("close", finish);
      try {
        this.ws.close();
      } catch {
        finish();
      }
    });
  }
}

/** Close every websocket client, ignoring individual errors. */
export async function closeAll(clients: Array<TestClient | null | undefined>): Promise<void> {
  await Promise.all(
    clients.filter((client): client is TestClient => Boolean(client)).map((client) => client.close().catch(() => undefined)),
  );
}

/**
 * Quick-match helper: the host proposes rules, every other player accepts and
 * the room becomes agreed. Returns the proposal id.
 */
export async function proposeAndAgreeRules(
  host: TestClient,
  others: TestClient[],
  rules: RoomRules,
  timeoutMs = 4_000,
): Promise<string> {
  host.send({ type: "room.proposeRules", rules });
  const withProposal = await host.nextState((state) => state.proposal !== null, timeoutMs);
  const proposalId = withProposal.proposal!.id;
  for (const client of others) {
    await client.nextState((state) => state.proposal?.id === proposalId, timeoutMs);
    client.send({ type: "room.acceptRules", proposalId });
  }
  await host.nextState((state) => state.rulesAgreed === true, timeoutMs);
  return proposalId;
}

/** Wait until every client sees the same room code in a waiting state. */
export async function waitQuickMatchState(clients: TestClient[], predicate: (state: RoomState) => boolean, timeoutMs = 5_000): Promise<RoomState> {
  const states = await Promise.all(clients.map((client) => client.nextState(predicate, timeoutMs)));
  return states[0];
}

/** Convenience: connect and wait for the hello message. */
export async function connectClient(wsBase: string, token: string): Promise<TestClient> {
  const client = await TestClient.connect(wsBase, token);
  await client.next((message) => message.type === "hello");
  return client;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
