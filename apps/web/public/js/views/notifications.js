/**
 * 通知页（#/notifications）：更新公告、好友申请、私信、对局邀请与系统通知。
 */

import * as api from "../api.js";
import * as ws from "../ws.js";
import { store, on } from "../store.js";
import { CHANGELOG_LOG } from "./changelog.js";
import {
  h,
  icon,
  toast,
  loadingBlock,
  currentTheme,
  toggleTheme,
  avatarNode,
  safeText,
  formatDateTime,
} from "../ui.js";

export function createNotificationsView(ctx) {
  let notifications = [];
  let incoming = [];
  let unread = 0;
  let loading = false;
  let error = "";
  let unauthorized = false;
  let destroyed = false;
  let requestId = 0;
  const unsubscribe = [];

  const themeButton = h(
    "button",
    {
      class: "icon-btn",
      type: "button",
      title: "切换深浅色",
      "aria-label": "切换深浅色",
      onclick: () => {
        toggleTheme();
        themeButton.replaceChildren(icon(currentTheme() === "dark" ? "sun" : "moon", 18));
      },
    },
    icon(currentTheme() === "dark" ? "sun" : "moon", 18),
  );
  const backButton = h(
    "button",
    { class: "btn btn-ghost btn-sm", type: "button", onclick: () => ctx.goLobby() },
    icon("arrowLeft", 17),
    "返回大厅",
  );
  const friendsButton = h(
    "button",
    { class: "btn btn-ghost btn-sm", type: "button", onclick: () => ctx.goFriends() },
    icon("users", 16),
    "好友",
  );
  const helpButton = h(
    "button",
    { class: "btn btn-ghost btn-sm", type: "button", onclick: () => ctx.goHelp() },
    icon("help", 16),
    "帮助",
  );
  const markAllButton = h(
    "button",
    { class: "btn btn-ghost btn-sm", type: "button", onclick: () => markAllRead() },
    "全部已读",
  );
  const header = h(
    "header",
    { class: "site-header compact" },
    h(
      "div",
      { class: "leaderboard-brand" },
      backButton,
      h(
        "div",
        { class: "brand-text" },
        h("h1", { class: "brand-title", text: "通知" }),
        h("p", { class: "brand-sub", text: "Notifications" }),
      ),
    ),
    h("div", { class: "header-actions" }, markAllButton, friendsButton, helpButton, themeButton),
  );

  const body = h("div", { class: "notifications-body" });

  function updatesModule() {
    const latest = CHANGELOG_LOG.slice(0, 3);
    return h(
      "section",
      { class: "panel notification-module" },
      h(
        "div",
        { class: "notification-module-head" },
        h("h2", { class: "page-title", text: "更新公告" }),
        h("span", { class: "notification-count", text: "最近 3 天" }),
      ),
      ...latest.map((entry) =>
        h(
          "div",
          { class: "notification-update" },
          h("strong", { class: "notification-update-date", text: entry.title }),
          ...["added", "optimized", "fixed"].flatMap((key) =>
            (entry[key] || []).slice(0, 2).map((text) =>
              h("p", { class: "notification-update-line", text }),
            ),
          ),
        ),
      ),
    );
  }

  function friendRequestsModule() {
    return h(
      "section",
      { class: "panel notification-module" },
      h(
        "div",
        { class: "notification-module-head" },
        h("h2", { class: "page-title", text: "好友申请" }),
        h("span", { class: "notification-count", text: `${incoming.length} 条` }),
      ),
      incoming.length === 0
        ? h("p", { class: "friends-sub", text: "暂无好友申请。" })
        : h(
            "div",
            { class: "notification-list" },
            ...incoming.map((request) =>
              h(
                "div",
                { class: "notification-item friend-request-item" },
                avatarNode(
                  safeText(request.user && request.user.name, "未知玩家"),
                  request.user && request.user.avatar,
                  "avatar-sm",
                ),
                h(
                  "div",
                  { class: "notification-item-main" },
                  h("strong", { text: safeText(request.user && request.user.name, "未知玩家") }),
                  h("span", { class: "friends-sub", text: formatDateTime(request.createdAt) }),
                ),
                h(
                  "button",
                  {
                    class: "btn btn-primary btn-sm",
                    type: "button",
                    onclick: () => respondRequest(request.id, true),
                  },
                  "同意",
                ),
                h(
                  "button",
                  {
                    class: "btn btn-ghost btn-sm",
                    type: "button",
                    onclick: () => respondRequest(request.id, false),
                  },
                  "拒绝",
                ),
              ),
            ),
          ),
    );
  }

  function notificationModule(title, items, emptyText) {
    return h(
      "section",
      { class: "panel notification-module" },
      h(
        "div",
        { class: "notification-module-head" },
        h("h2", { class: "page-title", text: title }),
        h("span", { class: "notification-count", text: `${items.length} 条` }),
      ),
      items.length === 0
        ? h("p", { class: "friends-sub", text: emptyText })
        : h("div", { class: "notification-list" }, ...items),
    );
  }

  function messageItem(notification) {
    return h(
      "div",
      { class: `notification-item${notification.read ? " is-read" : ""}` },
      h("span", { class: "notification-type", text: "私信" }),
      h(
        "div",
        { class: "notification-item-main" },
        h("strong", { text: safeText(notification.title, "私信") }),
        h("p", { class: "notification-text", text: safeText(notification.text, "") }),
      ),
      notification.read
        ? null
        : h(
            "button",
            {
              class: "btn btn-ghost btn-sm",
              type: "button",
              onclick: () => markRead(notification.id),
            },
            "已读",
          ),
      h(
        "button",
        {
          class: "btn btn-ghost btn-sm",
          type: "button",
          onclick: async () => {
            await markRead(notification.id);
            ctx.goFriends();
          },
        },
        "去好友页回复",
      ),
    );
  }

  function inviteItem(notification) {
    return h(
      "div",
      { class: `notification-item${notification.read ? " is-read" : ""}` },
      h("span", { class: "notification-type", text: "对局邀请" }),
      h(
        "div",
        { class: "notification-item-main" },
        h("strong", { text: safeText(notification.title, "对局邀请") }),
        h("p", { class: "notification-text", text: safeText(notification.text, "") }),
        notification.roomCode
          ? h("span", { class: "friends-sub", text: `房间码 ${notification.roomCode}` })
          : null,
      ),
      notification.read
        ? null
        : h(
            "button",
            {
              class: "btn btn-ghost btn-sm",
              type: "button",
              onclick: () => markRead(notification.id),
            },
            "已读",
          ),
      notification.roomCode
        ? h(
            "button",
            {
              class: "btn btn-primary btn-sm",
              type: "button",
              onclick: async () => {
                await markRead(notification.id);
                ws.joinRoom(notification.roomCode);
              },
            },
            "加入房间",
          )
        : null,
    );
  }

  function systemItem(notification) {
    return h(
      "div",
      { class: `notification-item${notification.read ? " is-read" : ""}` },
      h("span", { class: "notification-type", text: "系统" }),
      h(
        "div",
        { class: "notification-item-main" },
        h("strong", { text: safeText(notification.title, "系统通知") }),
        h("p", { class: "notification-text", text: safeText(notification.text, "") }),
      ),
      notification.read
        ? null
        : h(
            "button",
            {
              class: "btn btn-ghost btn-sm",
              type: "button",
              onclick: () => markRead(notification.id),
            },
            "标记已读",
          ),
    );
  }

  function render() {
    if (!store.user || store.user.isGuest) {
      body.replaceChildren(
        h(
          "div",
          { class: "stats-gate" },
          h("span", { class: "stats-gate-icon" }, icon("lock", 26)),
          h("h3", { class: "guest-title", text: "登录后查看通知" }),
          h("p", { class: "guest-desc", text: "游客不能接收好友申请、私信与对局邀请。" }),
          h(
            "button",
            { class: "btn btn-primary", type: "button", onclick: () => ctx.openAuth("login") },
            "登录 / 注册",
          ),
        ),
      );
      return;
    }
    if (unauthorized) {
      body.replaceChildren(
        h(
          "div",
          { class: "stats-gate" },
          h("span", { class: "stats-gate-icon" }, icon("lock", 26)),
          h("h3", { class: "guest-title", text: "登录状态已失效" }),
          h(
            "button",
            { class: "btn btn-primary", type: "button", onclick: () => ctx.openAuth("login") },
            "重新登录",
          ),
        ),
      );
      return;
    }
    if (loading) {
      body.replaceChildren(loadingBlock("正在加载通知…"));
      return;
    }
    if (error) {
      body.replaceChildren(
        h(
          "div",
          { class: "stats-error" },
          h("p", { class: "empty-title", text: "通知加载失败" }),
          h("p", { class: "empty-desc", text: error }),
          h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => load() }, "重试"),
        ),
      );
      return;
    }
    const messages = notifications.filter((item) => item.type === "friend_message");
    const invites = notifications.filter((item) => item.type === "game_invite");
    const systems = notifications.filter(
      (item) =>
        item.type !== "friend_message" &&
        item.type !== "game_invite" &&
        item.type !== "friend_request",
    );
    body.replaceChildren(
      h(
        "div",
        { class: "notifications-meta" },
        h("span", { text: `${unread} 条未读` }),
        h(
          "button",
          { class: "btn btn-ghost btn-sm", type: "button", onclick: () => markAllRead() },
          "全部已读",
        ),
      ),
      updatesModule(),
      friendRequestsModule(),
      notificationModule("私信", messages.map(messageItem), "暂无未读私信。"),
      notificationModule("对局邀请", invites.map(inviteItem), "暂无对局邀请。"),
      notificationModule("系统通知", systems.map(systemItem), "暂无系统通知。"),
    );
  }

  async function markRead(id) {
    try {
      const result = await api.markNotificationsRead(id);
      const item = notifications.find((entry) => entry.id === id);
      if (item) item.read = true;
      const actual = Number(result && result.unread);
      unread = Number.isFinite(actual) ? actual : Math.max(0, unread - 1);
      render();
    } catch (err) {
      toast(err && err.message ? err.message : "操作失败", "error");
    }
  }

  async function markAllRead() {
    try {
      const result = await api.markNotificationsRead(null);
      notifications.forEach((item) => { item.read = true; });
      unread = Number(result && result.unread) || 0;
      render();
    } catch (err) {
      toast(err && err.message ? err.message : "操作失败", "error");
    }
  }

  async function respondRequest(requestIdValue, accept) {
    try {
      if (accept) await api.acceptFriendRequest(requestIdValue);
      else await api.rejectFriendRequest(requestIdValue);
      toast(accept ? "已添加好友" : "已拒绝申请", accept ? "success" : "info");
      await load();
    } catch (err) {
      toast(err && err.message ? err.message : "操作失败", "error");
    }
  }

  async function load() {
    if (!store.user || store.user.isGuest) {
      render();
      return;
    }
    const currentRequest = ++requestId;
    loading = true;
    error = "";
    unauthorized = false;
    render();
    try {
      const [notificationData, friendData] = await Promise.all([
        api.fetchNotifications(),
        api.fetchFriends().catch(() => null),
      ]);
      if (destroyed || currentRequest !== requestId) return;
      notifications = Array.isArray(notificationData && notificationData.notifications)
        ? notificationData.notifications
        : [];
      unread = Number(notificationData && notificationData.unread) || 0;
      incoming = Array.isArray(friendData && friendData.incoming) ? friendData.incoming : [];
    } catch (err) {
      if (destroyed || currentRequest !== requestId) return;
      if (err && err.status === 401) unauthorized = true;
      else error = err && err.message ? err.message : "网络异常";
    } finally {
      if (!destroyed && currentRequest === requestId) {
        loading = false;
        render();
      }
    }
  }

  const el = h(
    "div",
    { class: "view notifications-view" },
    header,
    h("main", { class: "notifications-main" }, body),
  );

  unsubscribe.push(on("user", () => load()));
  render();
  load();

  return {
    el,
    destroy() {
      destroyed = true;
      requestId += 1;
      for (const off of unsubscribe) off();
    },
  };
}
