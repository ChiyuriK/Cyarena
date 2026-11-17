import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import type { ClientMessage, ServerMessage } from "../../../packages/shared/src/index.ts";
import type { RoomManager } from "./rooms.ts";
import { RoomError } from "./rooms.ts";
import type { Store } from "./store.ts";

export const WS_HEARTBEAT_MS = 30_000;

export interface WsHubOptions {
  server: HttpServer;
  store: Store;
  manager: RoomManager;
  /** Ping interval for dead-socket detection (defaults to WS_HEARTBEAT_MS). */
  heartbeatMs?: number;
}

interface AliveWebSocket extends WebSocket {
  isAlive?: boolean;
}

/**
 * WebSocket hub living on the same HTTP port as Fastify (`/ws?token=...`).
 * One user may hold several sockets; room state is pushed to every socket.
 */
export class WsHub {
  private readonly store: Store;
  private readonly manager: RoomManager;
  private readonly wss: WebSocketServer;
  private readonly clients = new Map<string, Set<WebSocket>>();
  private readonly httpServer: HttpServer;
  private readonly upgradeHandler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(options: WsHubOptions) {
    this.store = options.store;
    this.manager = options.manager;
    this.httpServer = options.server;
    this.wss = new WebSocketServer({ noServer: true });
    this.upgradeHandler = (req, socket, head) => this.handleUpgrade(req, socket, head);
    this.httpServer.on("upgrade", this.upgradeHandler);
    this.heartbeat = setInterval(() => this.sweepSockets(), options.heartbeatMs ?? WS_HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  /** Ping every socket; terminate the ones that missed the previous pong. */
  private sweepSockets(): void {
    for (const set of this.clients.values()) {
      for (const ws of set) {
        const socket = ws as AliveWebSocket;
        if (socket.isAlive === false) {
          try {
            socket.terminate();
          } catch {
            /* ignore */
          }
          continue;
        }
        socket.isAlive = false;
        try {
          socket.ping();
        } catch {
          try {
            socket.terminate();
          } catch {
            /* ignore */
          }
        }
      }
    }
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== "/ws" && url.pathname !== "/") {
      socket.destroy();
      return;
    }
    const token = url.searchParams.get("token") ?? "";
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.attach(ws, token);
    });
  }

  private attach(ws: WebSocket, token: string): void {
    const userId = this.store.getSessionUserId(token);
    const user = userId ? this.store.getUserById(userId) : null;
    if (!user || !userId) {
      this.sendRaw(ws, { type: "error", message: "登录状态已失效，请重新进入" });
      ws.close(4401, "unauthorized");
      return;
    }
    const set = this.clients.get(userId) ?? new Set<WebSocket>();
    set.add(ws);
    this.clients.set(userId, set);

    const socket = ws as AliveWebSocket;
    socket.isAlive = true;
    ws.on("pong", () => {
      socket.isAlive = true;
    });
    ws.on("message", (data) => this.onMessage(userId, data));
    ws.on("close", () => this.onClose(userId, ws));
    ws.on("error", () => {
      /* handled by close */
    });

    this.sendToSocket(ws, { type: "hello", user: this.store.toPublicUser(user) });
    this.sendToSocket(ws, { type: "rooms", rooms: this.manager.getPublicRooms() });
    this.manager.handleConnect(userId);
  }

  private onMessage(userId: string, data: unknown): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(data));
    } catch {
      this.sendToUser(userId, { type: "error", message: "消息格式错误" });
      return;
    }
    if (!parsed || typeof parsed !== "object" || typeof (parsed as { type?: unknown }).type !== "string") {
      this.sendToUser(userId, { type: "error", message: "消息格式错误" });
      return;
    }
    try {
      this.manager.handleMessage(userId, parsed as ClientMessage);
    } catch (error) {
      const message = error instanceof RoomError ? error.message : "服务器处理请求失败";
      this.sendToUser(userId, { type: "error", message });
    }
  }

  private onClose(userId: string, ws: WebSocket): void {
    const set = this.clients.get(userId);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) {
      this.clients.delete(userId);
      this.manager.handleDisconnect(userId);
      this.cleanupGuestIfIdle(userId);
    }
  }

  /**
   * A guest is removed from the store when it has no socket and no seat /
   * queue / spectate relation left. Registered users are never touched.
   */
  cleanupGuestIfIdle(userId: string): void {
    if (this.clients.has(userId)) return;
    const user = this.store.getUserById(userId);
    if (!user || !user.isGuest) return;
    if (this.manager.hasPresence(userId)) return;
    this.store.deleteGuest(userId);
  }

  private sendRaw(ws: WebSocket, message: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }

  private sendToSocket(ws: WebSocket, message: ServerMessage): void {
    this.sendRaw(ws, message);
  }

  sendToUser(userId: string, message: ServerMessage): void {
    const set = this.clients.get(userId);
    if (!set) return;
    for (const ws of set) this.sendRaw(ws, message);
  }

  broadcastRooms(rooms: unknown): void {
    const payload = JSON.stringify({ type: "rooms", rooms });
    for (const set of this.clients.values()) {
      for (const ws of set) {
        if (ws.readyState === WebSocket.OPEN) ws.send(payload);
      }
    }
  }

  onlineCount(): number {
    return this.clients.size;
  }

  isOnline(userId: string): boolean {
    return (this.clients.get(userId)?.size ?? 0) > 0;
  }

  /** Terminate every socket of a user (used by account deletion). */
  disconnectUser(userId: string): void {
    const set = this.clients.get(userId);
    if (!set) return;
    for (const ws of [...set]) {
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
    }
  }

  close(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    this.httpServer.off("upgrade", this.upgradeHandler);
    for (const set of this.clients.values()) {
      for (const ws of set) {
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
      }
    }
    this.clients.clear();
    try {
      this.wss.close();
    } catch {
      /* ignore */
    }
  }
}
