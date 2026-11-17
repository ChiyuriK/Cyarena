/**
 * 最近成语（#/idioms）。注册用户查看最近猜出的成语与解释。
 */

import * as api from "../api.js";
import { store, on } from "../store.js";
import {
  h,
  icon,
  loadingBlock,
  currentTheme,
  toggleTheme,
  formatDateTime,
  safeText,
} from "../ui.js";

export function createIdiomsView(ctx) {
  let rows = null;
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
    { class: "btn btn-ghost btn-sm", type: "button", onclick: () => ctx.goHistory() },
    icon("arrowLeft", 17),
    "返回战绩",
  );
  const helpButton = h(
    "button",
    { class: "btn btn-ghost btn-sm", type: "button", onclick: () => ctx.goHelp() },
    icon("help", 16),
    "帮助",
  );
  const refreshButton = h(
    "button",
    { class: "btn btn-ghost btn-sm", type: "button", onclick: () => load(true) },
    icon("refresh", 16),
    "刷新",
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
        h("h1", { class: "brand-title", text: "最近成语" }),
        h("p", { class: "brand-sub", text: "Recent Idioms" }),
      ),
    ),
    h("div", { class: "header-actions" }, helpButton, themeButton),
  );

  const body = h("div", { class: "idioms-body" });

  function render() {
    refreshButton.classList.toggle("is-spinning", loading);
    if (!store.user || store.user.isGuest) {
      body.replaceChildren(
        h(
          "div",
          { class: "stats-gate" },
          h("span", { class: "stats-gate-icon" }, icon("lock", 26)),
          h("h3", { class: "guest-title", text: "登录后查看最近成语" }),
          h("p", { class: "guest-desc", text: "游客对局不会记录最近成语。" }),
          h(
            "button",
            {
              class: "btn btn-primary",
              type: "button",
              onclick: () => ctx.openAuth("login"),
            },
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
          h("p", { class: "guest-desc", text: "请重新登录后查看最近成语。" }),
          h(
            "button",
            {
              class: "btn btn-primary",
              type: "button",
              onclick: () => ctx.openAuth("login"),
            },
            "重新登录",
          ),
        ),
      );
      return;
    }
    if (loading && !rows) {
      body.replaceChildren(loadingBlock("正在加载最近成语…"));
      return;
    }
    if (error) {
      body.replaceChildren(
        h(
          "div",
          { class: "stats-error" },
          h("p", { class: "empty-title", text: "最近成语加载失败" }),
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
    if (!rows || rows.length === 0) {
      body.replaceChildren(
        h(
          "div",
          { class: "stats-empty" },
          h("p", { class: "empty-title", text: "还没有最近成语" }),
          h("p", { class: "empty-desc", text: "猜中成语后，这里会留下最近 30 个记录。" }),
        ),
      );
      return;
    }
    body.replaceChildren(
      h(
        "div",
        { class: "idioms-list" },
        ...rows.map((row) =>
          h(
            "article",
            { class: "idioms-item" },
            h(
              "div",
              { class: "idioms-item-head" },
              h("strong", { class: "idioms-word", text: safeText(row.word, "未知成语") }),
              h("span", { class: "idioms-time", text: formatDateTime(row.at) }),
            ),
            h("p", {
              class: "idioms-explanation",
              text: safeText(row.explanation, "暂无解释"),
            }),
          ),
        ),
      ),
    );
  }

  async function load(force = false) {
    if (!store.user || store.user.isGuest) {
      render();
      return;
    }
    if (loading) return;
    const currentRequest = ++requestId;
    loading = true;
    error = "";
    unauthorized = false;
    if (force) rows = null;
    render();
    try {
      const data = await api.fetchMyIdioms(30);
      if (destroyed || currentRequest !== requestId) return;
      rows = Array.isArray(data) ? data : [];
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
    { class: "view idioms-view" },
    header,
    h(
      "main",
      { class: "idioms-main" },
      h(
        "section",
        { class: "panel idioms-panel" },
        h(
          "div",
          { class: "leaderboard-head" },
          h(
            "div",
            {},
            h("h2", { class: "page-title", text: "最近 30 个成语" }),
            h("p", { class: "page-sub", text: "只展示注册后猜中的成语。" }),
          ),
          refreshButton,
        ),
        body,
      ),
    ),
  );

  unsubscribe.push(
    on("user", () => {
      rows = null;
      load(true);
    }),
  );

  render();
  load(false);

  return {
    el,
    destroy() {
      destroyed = true;
      requestId += 1;
      for (const off of unsubscribe) off();
    },
  };
}
