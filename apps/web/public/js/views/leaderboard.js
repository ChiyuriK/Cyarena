/**
 * 排行榜页：按模式展示 GET /api/leaderboard?mode=... 的数据。
 */

import * as api from "../api.js";
import { store, on } from "../store.js";
import { RANKED_MODES, modeMeta } from "../constants.js";
import {
  h,
  icon,
  modeLabel,
  emptyState,
  loadingBlock,
  currentTheme,
  toggleTheme,
  avatarNode,
  safeText,
} from "../ui.js";

export function createLeaderboardView(ctx, initialMode = "duel") {
  let mode = RANKED_MODES.includes(initialMode) ? initialMode : "duel";
  let rows = [];
  let loading = false;
  let error = "";
  let requestId = 0;
  let destroyed = false;
  const cache = new Map();

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

  const changelogButton = h(
    "button",
    { class: "btn btn-ghost btn-sm", type: "button", onclick: () => ctx.goChangelog() },
    "更新日志",
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
        h("h1", { class: "brand-title", text: "天梯排行榜" }),
        h("p", { class: "brand-sub", text: "Ciying Arena Top 50" }),
      ),
    ),
    h("div", { class: "header-actions" }, changelogButton, helpButton, themeButton),
  );

  const modeTabs = h("div", { class: "segmented leaderboard-tabs", role: "tablist" });
  const modeButtons = new Map();
  for (const item of RANKED_MODES) {
    const button = h(
      "button",
      {
        class: "segmented-btn",
        type: "button",
        role: "tab",
        onclick: () => selectMode(item),
      },
      modeMeta(item).label,
    );
    modeButtons.set(item, button);
    modeTabs.appendChild(button);
  }

  const modeDescription = h("p", { class: "leaderboard-desc", text: modeMeta(mode).description });
  const tableWrap = h("div", { class: "leaderboard-table-wrap" });
  const refreshButton = h(
    "button",
    {
      class: "btn btn-ghost btn-sm",
      type: "button",
      onclick: () => load(true),
    },
    icon("refresh", 16),
    "刷新",
  );
  const metaLine = h("p", { class: "leaderboard-meta", text: "" });

  const el = h(
    "div",
    { class: "view leaderboard-view" },
    header,
    h(
      "main",
      { class: "leaderboard-main" },
      h(
        "section",
        { class: "panel leaderboard-panel" },
        h(
          "div",
          { class: "leaderboard-head" },
          h(
            "div",
            {},
            h("h2", { class: "page-title", text: "排行榜" }),
            h("p", {
              class: "page-sub",
              text: "仅统计注册用户。初始 1200 分，按模式分别计算。",
            }),
          ),
          refreshButton,
        ),
        modeTabs,
        modeDescription,
        tableWrap,
        metaLine,
      ),
    ),
  );

  function selectMode(nextMode) {
    if (!RANKED_MODES.includes(nextMode)) return;
    if (mode === nextMode) return;
    mode = nextMode;
    for (const [item, button] of modeButtons) {
      const active = item === mode;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
    }
    modeDescription.textContent = modeMeta(mode).description;
    syncHash();
    load(false);
  }

  function syncHash() {
    try {
      history.replaceState(null, "", `#/leaderboard/${mode}`);
    } catch {
      /* ignore */
    }
  }

  function renderTabs() {
    for (const [item, button] of modeButtons) {
      const active = item === mode;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
    }
  }

  function renderTable() {
    refreshButton.classList.toggle("is-spinning", loading);
    if (loading && rows.length === 0) {
      metaLine.textContent = "";
      tableWrap.replaceChildren(loadingBlock("正在加载排行榜…"));
      return;
    }
    if (error) {
      metaLine.textContent = "";
      tableWrap.replaceChildren(
        h(
          "div",
          { class: "leaderboard-error" },
          h("p", { class: "empty-title", text: "排行榜加载失败" }),
          h("p", { class: "empty-desc", text: error }),
          h(
            "button",
            { class: "btn btn-ghost btn-sm", type: "button", onclick: () => load(true) },
            "重试",
          ),
        ),
      );
      return;
    }
    if (!rows.length) {
      metaLine.textContent = "";
      tableWrap.replaceChildren(
        emptyState("暂无排行数据", "还没人在这项模式完成过一场天梯对局。"),
      );
      return;
    }
    metaLine.textContent = `${modeLabel(mode)}，共 ${rows.length} 位玩家`;
    const currentUserId = store.user ? store.user.id : "";
    const isFfa = mode === "ffa3";
    const zero = (value) => String(Number(value) || 0);
    const headerCell = (label, short = "", className = "") =>
      h(
        "th",
        { class: className },
        h("span", { class: "th-full", text: label }),
        short ? h("span", { class: "th-short", text: short }) : null,
      );
    const headerCells = isFfa
      ? [
          headerCell("排名"),
          headerCell("玩家"),
          headerCell("积分"),
          headerCell("场次"),
          headerCell("第一名", "一", "cell-first"),
          headerCell("第二名", "二", "cell-second"),
          headerCell("第三名", "三", "cell-third"),
          headerCell("和", "和", "cell-draw"),
        ]
      : [
          headerCell("排名"),
          headerCell("玩家"),
          headerCell("积分"),
          headerCell("场次"),
          headerCell("胜"),
          headerCell("负"),
          headerCell("平"),
        ];
    const bodyRows = rows.map((row, index) => {
      const rank = Number(row.rank) || index + 1;
      const isMe = row.userId === currentUserId;
      const common = [
        h(
          "td",
          { class: "cell-rank" },
          rank <= 3
            ? h(
                "span",
                { class: `rank-medal rank-${rank}` },
                icon("trophy", 15),
                String(rank),
              )
            : String(rank),
        ),
        h(
          "td",
          { class: "cell-name" },
          h(
            "span",
            { class: "leader-user" },
            avatarNode(safeText(row.name, "未知玩家"), row.avatar, "avatar-xs"),
            h("span", { class: "leader-name", text: safeText(row.name, "未知玩家") }),
          ),
          isMe ? h("span", { class: "badge badge-me", text: "你" }) : null,
        ),
        h("td", { class: "cell-rating", text: String(row.rating ?? 1200) }),
        h("td", { class: "cell-games", text: zero(row.games) }),
      ];
      const stats = isFfa
        ? [
            h("td", { class: "cell-first", text: zero(row.firsts) }),
            h("td", { class: "cell-second", text: zero(row.seconds) }),
            h("td", { class: "cell-third", text: zero(row.thirds) }),
            h("td", { class: "cell-draw", text: zero(row.draws) }),
          ]
        : [
            h("td", { class: "cell-win", text: zero(row.wins) }),
            h("td", { class: "cell-loss", text: zero(row.losses) }),
            h("td", { class: "cell-draw", text: zero(row.draws) }),
          ];
      return h("tr", { class: isMe ? "is-me" : "" }, ...common, ...stats);
    });
    tableWrap.replaceChildren(
      h(
        "table",
        { class: `leaderboard-table${isFfa ? " is-ffa" : ""}` },
        h("thead", {}, h("tr", {}, ...headerCells)),
        h("tbody", {}, ...bodyRows),
      ),
    );
  }

  async function load(force) {
    const currentRequest = ++requestId;
    loading = true;
    error = "";
    rows = cache.has(mode) && !force ? cache.get(mode) : rows;
    renderTable();
    try {
      const data = cache.has(mode) && !force ? cache.get(mode) : await api.fetchLeaderboard(mode);
      if (destroyed || currentRequest !== requestId) return;
      rows = Array.isArray(data) ? data : [];
      cache.set(mode, rows);
    } catch (loadError) {
      if (destroyed || currentRequest !== requestId) return;
      error = loadError && loadError.message ? loadError.message : "网络错误";
      rows = [];
    } finally {
      if (destroyed || currentRequest !== requestId) return;
      loading = false;
      renderTable();
    }
  }

  unsubscribe.push(
    on("leaderboard", (payload) => {
      if (!payload || payload.mode !== mode) return;
      rows = Array.isArray(payload.rows) ? payload.rows : [];
      cache.set(mode, rows);
      error = "";
      loading = false;
      renderTable();
    }),
    on("user", () => {
      if (rows.length) renderTable();
    }),
  );

  renderTabs();
  modeDescription.textContent = modeMeta(mode).description;
  syncHash();
  renderTable();
  load(false);

  return {
    el,
    destroy() {
      destroyed = true;
      for (const off of unsubscribe) off();
    },
  };
}
