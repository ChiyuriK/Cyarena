/**
 * 好友页（#/friends）：搜索、好友列表、申请处理、私信与资料。
 */

import * as api from "../api.js";
import { store, on } from "../store.js";
import {
  h,
  icon,
  openModal,
  toast,
  loadingBlock,
  currentTheme,
  toggleTheme,
  avatarNode,
  safeText,
  formatDateTime,
  formatPercent,
  formatDurationMs,
} from "../ui.js";

function relationLabel(relation) {
  if (relation === "friend") return "已是好友";
  if (relation === "outgoing") return "已申请";
  if (relation === "incoming") return "待处理";
  return "加好友";
}

export function createFriendsView(ctx) {
  let friends = null;
  let incoming = [];
  let outgoing = [];
  let searchResults = [];
  let searchQuery = "";
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
  const helpButton = h(
    "button",
    { class: "btn btn-ghost btn-sm", type: "button", onclick: () => ctx.goHelp() },
    icon("help", 16),
    "帮助",
  );
  const notificationsButton = h(
    "button",
    { class: "btn btn-ghost btn-sm", type: "button", onclick: () => ctx.goNotifications() },
    "通知",
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
        h("h1", { class: "brand-title", text: "好友" }),
        h("p", { class: "brand-sub", text: "Friends" }),
      ),
    ),
    h("div", { class: "header-actions" }, notificationsButton, helpButton, themeButton),
  );

  const searchInput = h("input", {
    class: "input friend-search-input",
    type: "search",
    placeholder: "搜索昵称",
    "aria-label": "搜索昵称",
  });
  const searchForm = h(
    "form",
    { class: "friend-search-form" },
    searchInput,
    h("button", { class: "btn btn-primary", type: "submit" }, "搜索"),
  );
  const searchResultsList = h("div", { class: "friend-search-results" });
  const friendsList = h("div", { class: "friends-list" });
  const requestsList = h("div", { class: "friend-requests-list" });
  const outgoingList = h("div", { class: "friend-outgoing-list" });
  const body = h("div", { class: "friends-body" });

  const searchCard = h(
    "section",
    { class: "panel friends-section" },
    h("h2", { class: "page-title", text: "搜索玩家" }),
    searchForm,
    searchResultsList,
  );
  const friendsCard = h(
    "section",
    { class: "panel friends-section" },
    h("h2", { class: "page-title", text: "我的好友" }),
    friendsList,
  );
  const requestCard = h(
    "section",
    { class: "panel friends-section" },
    h("h2", { class: "page-title", text: "好友申请" }),
    requestsList,
    h("p", { class: "friends-sub", text: "我发出的申请" }),
    outgoingList,
  );

  function renderGate(reason) {
    body.replaceChildren(
      h(
        "div",
        { class: "stats-gate" },
        h("span", { class: "stats-gate-icon" }, icon("lock", 26)),
        h("h3", { class: "guest-title", text: "登录后使用好友功能" }),
        h("p", { class: "guest-desc", text: reason }),
        h(
          "button",
          { class: "btn btn-primary", type: "button", onclick: () => ctx.openAuth("login") },
          "登录 / 注册",
        ),
      ),
    );
  }

  async function openChat(user) {
    let messages = [];
    let chatModal = null;
    const list = h("div", { class: "friend-chat-list" });
    const input = h("input", {
      class: "input",
      type: "text",
      maxlength: "200",
      placeholder: "输入私信",
      "aria-label": "私信内容",
    });
    const send = h("button", { class: "btn btn-primary", type: "submit" }, "发送");
    const form = h("form", { class: "friend-chat-form" }, input, send);
    const content = h(
      "div",
      { class: "friend-chat" },
      h("h3", { class: "profile-title", text: `与 ${safeText(user.name, "好友")} 的私信` }),
      list,
      form,
    );
    function renderMessages() {
      list.replaceChildren(
        ...(messages.length === 0
          ? [h("p", { class: "friends-sub", text: "还没有私信，打个招呼吧。" })]
          : messages.map((message) =>
              h(
                "div",
                {
                  class: `friend-message${message.fromId === (store.user && store.user.id) ? " is-me" : ""}`,
                },
                h("span", { class: "friend-message-name", text: safeText(message.fromName, "好友") }),
                h("span", { class: "friend-message-text", text: safeText(message.text, "") }),
                h("span", { class: "friend-message-time", text: formatDateTime(message.ts) }),
              ),
            )),
      );
    }
    async function reload() {
      const data = await api.fetchFriendMessages(user.id);
      messages = Array.isArray(data && data.messages) ? data.messages : [];
      renderMessages();
    }
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      send.disabled = true;
      try {
        await api.sendFriendMessage(user.id, text);
        input.value = "";
        await reload();
      } catch (err) {
        toast(err && err.message ? err.message : "发送失败", "error");
      } finally {
        send.disabled = false;
      }
    });
    try {
      await reload();
    } catch (err) {
      list.replaceChildren(h("p", { class: "friends-sub", text: err && err.message ? err.message : "加载失败" }));
    }
    chatModal = openModal({ title: "私信", content, onClose: () => { chatModal = null; } });
  }

  async function openProfile(userId, knownUser) {
    try {
      const profile = await api.fetchFriendProfile(userId);
      const user = (profile && profile.user) || knownUser || {};
      const stats = profile && profile.stats;
      const statsNode =
        profile && profile.statsVisible && stats
          ? h(
              "div",
              { class: "friend-profile-stats" },
              h("span", { class: "friend-stat" }, h("strong", { text: Number(stats.matches) || 0 }), " 场次"),
              h("span", { class: "friend-stat" }, h("strong", { text: formatPercent(stats.winRate) }), " 胜率"),
              h("span", { class: "friend-stat" }, h("strong", { text: formatPercent(stats.solveRate) }), " 猜出率"),
              h("span", { class: "friend-stat" }, h("strong", { text: formatDurationMs(stats.avgSolveMs) }), " 平均猜出"),
            )
          : h("p", { class: "friends-sub", text: "对方未公开数据" });
      const content = h(
        "div",
        { class: "friend-profile" },
        h("h3", { class: "profile-title", text: "好友资料" }),
        h(
          "div",
          { class: "friend-profile-head" },
          avatarNode(safeText(user.name, "未知玩家"), user.avatar, "avatar-lg"),
          h(
            "div",
            {},
            h("h3", { class: "profile-title", text: safeText(user.name, "未知玩家") }),
            h("p", { class: "friends-sub", text: user.online ? "在线" : "离线" }),
          ),
        ),
        statsNode,
        h(
          "div",
          { class: "friend-profile-actions" },
          h(
            "button",
            {
              class: "btn btn-primary btn-sm",
              type: "button",
              onclick: () => {
                if (profileModal) profileModal.close();
                openChat(user);
              },
            },
            "发私信",
          ),
          store.room
            ? h(
                "button",
                {
                  class: "btn btn-ghost btn-sm",
                  type: "button",
                  onclick: async () => {
                    try {
                      const result = await api.inviteFriend(userId);
                      toast(`已邀请 ${safeText(user.name, "好友")} 加入房间 ${result.roomCode}`, "success");
                    } catch (err) {
                      toast(err && err.message ? err.message : "邀请失败", "error");
                    }
                  },
                },
                "邀请对局",
              )
            : null,
        ),
      );
      var profileModal = openModal({ title: "好友资料", content });
    } catch (err) {
      toast(err && err.message ? err.message : "资料加载失败", "error");
    }
  }

  function renderSearchResults() {
    if (searchResults.length === 0) {
      searchResultsList.replaceChildren(
        h("p", { class: "friends-sub", text: searchQuery ? "没有找到匹配玩家。" : "输入昵称搜索全站玩家。" }),
      );
      return;
    }
    searchResultsList.replaceChildren(
      ...searchResults.map((row) =>
        h(
          "div",
          { class: "friend-row" },
          avatarNode(safeText(row.name, "未知玩家"), row.avatar, "avatar-sm"),
          h("span", { class: "friend-row-name", text: safeText(row.name, "未知玩家") }),
          h("span", { class: "friend-relation", text: relationLabel(row.relation) }),
          row.relation === "incoming"
            ? h("span", { class: "friends-sub", text: "请在好友申请中处理" })
            : h(
                "button",
                {
                  class: "btn btn-ghost btn-sm",
                  type: "button",
                  disabled: row.relation !== "none",
                  onclick: async () => {
                    try {
                      await api.sendFriendRequest(row.id);
                      toast("好友申请已发送", "success");
                      await load();
                      await search();
                    } catch (err) {
                      toast(err && err.message ? err.message : "发送失败", "error");
                    }
                  },
                },
                relationLabel(row.relation),
              ),
        ),
      ),
    );
  }

  function renderFriends() {
    if (!friends || friends.length === 0) {
      friendsList.replaceChildren(h("p", { class: "friends-sub", text: "还没有好友，搜索昵称添加吧。" }));
    } else {
      friendsList.replaceChildren(
        ...friends.map((friend) =>
          h(
            "div",
            { class: "friend-row" },
            avatarNode(safeText(friend.name, "未知玩家"), friend.avatar, "avatar-sm"),
            h(
              "span",
              { class: "friend-row-main" },
              h("span", { class: "friend-row-name", text: safeText(friend.name, "未知玩家") }),
              h("span", { class: `friend-online${friend.online ? " is-online" : ""}`, text: friend.online ? "在线" : "离线" }),
            ),
            h(
              "button",
              { class: "btn btn-ghost btn-sm", type: "button", onclick: () => openProfile(friend.id, friend) },
              "资料",
            ),
            h(
              "button",
              { class: "btn btn-ghost btn-sm", type: "button", onclick: () => openChat(friend) },
              "私信",
            ),
            store.room
              ? h(
                  "button",
                  {
                    class: "btn btn-primary btn-sm",
                    type: "button",
                    onclick: async () => {
                      try {
                        const result = await api.inviteFriend(friend.id);
                        toast(`已邀请 ${safeText(friend.name, "好友")} 加入房间 ${result.roomCode}`, "success");
                      } catch (err) {
                        toast(err && err.message ? err.message : "邀请失败", "error");
                      }
                    },
                  },
                  "邀请",
                )
              : null,
          ),
        ),
      );
    }
    if (incoming.length === 0) {
      requestsList.replaceChildren(h("p", { class: "friends-sub", text: "暂无待处理的好友申请。" }));
    } else {
      requestsList.replaceChildren(
        ...incoming.map((request) =>
          h(
            "div",
            { class: "friend-row" },
            avatarNode(safeText(request.user && request.user.name, "未知玩家"), request.user && request.user.avatar, "avatar-sm"),
            h(
              "span",
              { class: "friend-row-main" },
              h("span", { class: "friend-row-name", text: safeText(request.user && request.user.name, "未知玩家") }),
              h("span", { class: "friends-sub", text: formatDateTime(request.createdAt) }),
            ),
            h(
              "button",
              {
                class: "btn btn-primary btn-sm",
                type: "button",
                onclick: async () => {
                  await api.acceptFriendRequest(request.id);
                  toast("已添加好友", "success");
                  await load();
                },
              },
              "同意",
            ),
            h(
              "button",
              {
                class: "btn btn-ghost btn-sm",
                type: "button",
                onclick: async () => {
                  await api.rejectFriendRequest(request.id);
                  await load();
                },
              },
              "拒绝",
            ),
          ),
        ),
      );
    }
    if (outgoing.length === 0) {
      outgoingList.replaceChildren(h("p", { class: "friends-sub", text: "暂无已发出申请。" }));
    } else {
      outgoingList.replaceChildren(
        ...outgoing.map((request) =>
          h("p", { class: "friends-sub", text: `等待 ${safeText(request.user && request.user.name, "玩家")} 通过` }),
        ),
      );
    }
    searchResultsList.classList.toggle("is-hidden", searchResults.length === 0 && !searchQuery);
  }

  function render() {
    if (!store.user || store.user.isGuest) {
      renderGate("游客不能添加好友或发送私信，请先注册账号。");
      return;
    }
    if (unauthorized) {
      renderGate("登录状态已失效，请重新登录。");
      return;
    }
    if (loading && !friends) {
      body.replaceChildren(loadingBlock("正在加载好友…"));
      return;
    }
    if (error) {
      body.replaceChildren(
        h(
          "div",
          { class: "stats-error" },
          h("p", { class: "empty-title", text: "好友加载失败" }),
          h("p", { class: "empty-desc", text: error }),
          h("button", { class: "btn btn-ghost btn-sm", type: "button", onclick: () => load(true) }, "重试"),
        ),
      );
      return;
    }
    body.replaceChildren(
      h(
        "div",
        { class: "friends-layout" },
        h("div", { class: "friends-main" }, searchCard, friendsCard),
        requestCard,
      ),
    );
    renderSearchResults();
    renderFriends();
  }

  async function search() {
    const query = searchInput.value.trim();
    searchQuery = query;
    if (!query) {
      searchResults = [];
      renderSearchResults();
      return;
    }
    try {
      searchResults = await api.searchUsers(query);
      renderSearchResults();
    } catch (err) {
      toast(err && err.message ? err.message : "搜索失败", "error");
    }
  }

  searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    search();
  });

  async function load(force = false) {
    if (!store.user || store.user.isGuest) {
      render();
      return;
    }
    const currentRequest = ++requestId;
    loading = true;
    error = "";
    unauthorized = false;
    if (force) friends = null;
    render();
    try {
      const data = await api.fetchFriends();
      if (destroyed || currentRequest !== requestId) return;
      friends = Array.isArray(data && data.friends) ? data.friends : [];
      incoming = Array.isArray(data && data.incoming) ? data.incoming : [];
      outgoing = Array.isArray(data && data.outgoing) ? data.outgoing : [];
    } catch (err) {
      if (destroyed || currentRequest !== requestId) return;
      if (err && err.status === 401) unauthorized = true;
      else error = err && err.message ? err.message : "网络异常";
    } finally {
      if (destroyed || currentRequest !== requestId) return;
      loading = false;
      render();
    }
  }

  const el = h(
    "div",
    { class: "view friends-view" },
    header,
    h("main", { class: "friends-main-page" }, body),
  );

  unsubscribe.push(on("user", () => load(true)));
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
