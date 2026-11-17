/**
 * 连胜挑战（#/streak）。三变体分别排行。
 */

import * as api from "../api.js";
import { store, on } from "../store.js";
import { STREAK_META, STREAK_VARIANTS, isStreakVariant } from "../constants.js";
import { feedbackTileNode } from "../board.js";
import {
  h,
  icon,
  toast,
  copyText,
  loadingBlock,
  currentTheme,
  toggleTheme,
  avatarNode,
  safeText,
  formatDurationMs,
} from "../ui.js";

function variantOf(value) {
  return isStreakVariant(value) ? value : "standard";
}

export function createStreakView(ctx, initialVariant = "standard") {
  let variant = variantOf(initialVariant);
  let state = null;
  let leaderboard = [];
  let stats = null;
  let loading = false;
  let busy = false;
  let error = "";
  let destroyed = false;
  let requestId = 0;
  let restTimer = null;
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
        h("h1", { class: "brand-title", text: "连胜挑战" }),
        h("p", { class: "brand-sub", text: "Streak Challenge" }),
      ),
    ),
    h("div", { class: "header-actions" }, helpButton, themeButton),
  );

  const tabs = h("div", { class: "segmented streak-tabs", role: "tablist" });
  const tabButtons = new Map();
  for (const item of STREAK_VARIANTS) {
    const button = h(
      "button",
      {
        class: "segmented-btn",
        type: "button",
        role: "tab",
        onclick: () => {
          if (variant === item) return;
          ctx.goStreak(item);
        },
      },
      STREAK_META[item].label,
    );
    tabButtons.set(item, button);
    tabs.appendChild(button);
  }

  const body = h("div", { class: "streak-body" });
  const input = h("input", {
    class: "input streak-input",
    type: "text",
    maxlength: "4",
    placeholder: "输入四个汉字",
    autocomplete: "off",
    "aria-label": "连胜挑战答案",
  });
  const submit = h("button", { class: "btn btn-primary", type: "submit" }, "提交");
  const form = h("form", { class: "streak-form" }, input, submit);
  const feedback = h("p", { class: "streak-message is-hidden", role: "alert" });
  const startButton = h(
    "button",
    { class: "btn btn-primary", type: "button", onclick: () => start() },
    icon("play", 16),
    "开始挑战",
  );
  const quitButton = h(
    "button",
    { class: "btn btn-ghost btn-sm", type: "button", onclick: () => quit() },
    "结束挑战",
  );
  const shareButton = h(
    "button",
    { class: "btn btn-primary", type: "button", onclick: () => share() },
    icon("copy", 16),
    "分享战绩",
  );

  function emptyRow(index) {
    return h(
      "div",
      { class: "streak-row is-empty" },
      h("span", { class: "streak-row-no", text: String(index + 1).padStart(2, "0") }),
      h(
        "div",
        { class: "streak-row-tiles" },
        ...[0, 1, 2, 3].map(() => h("div", { class: "tile is-empty" })),
      ),
    );
  }

  function renderBoard() {
    const rows = Array.isArray(state && state.rows) ? state.rows : [];
    const maxRows = Number(state && state.maxRows) || 6;
    const items = [];
    for (let index = 0; index < maxRows; index += 1) {
      const row = rows[index];
      if (!row) {
        items.push(emptyRow(index));
        continue;
      }
      items.push(
        h(
          "div",
          { class: "streak-row" },
          h("span", { class: "streak-row-no", text: String(index + 1).padStart(2, "0") }),
          h(
            "div",
            { class: "streak-row-main" },
            h("strong", { class: "streak-row-word", text: safeText(row.word, "未知") }),
            h(
              "div",
              { class: "streak-row-tiles" },
              ...(Array.isArray(row.tiles) ? row.tiles : []).map((tile, tileIndex) =>
                feedbackTileNode(tile, tileIndex),
              ),
            ),
          ),
        ),
      );
    }
    return h("div", { class: "streak-board" }, ...items);
  }

  function renderLeaderboard() {
    const rows = Array.isArray(leaderboard) ? leaderboard : [];
    if (rows.length === 0) return h("p", { class: "streak-empty", text: "暂无排行数据。" });
    return h(
      "div",
      { class: "streak-leaderboard" },
      ...rows.map((row) =>
        h(
          "div",
          { class: "streak-rank-row" },
          h("span", { class: "streak-rank", text: String(Number(row.rank) || "—") }),
          avatarNode(safeText(row.name, "未知玩家"), row.avatar, "avatar-xs"),
          h("span", { class: "streak-rank-name", text: safeText(row.name, "未知玩家") }),
          h("strong", { class: "streak-rank-best", text: `${Number(row.best) || 0} 连胜` }),
        ),
      ),
    );
  }

  function render() {
    if (!state) {
      body.replaceChildren(
        error
          ? h(
              "div",
              { class: "stats-error" },
              h("p", { class: "empty-title", text: "连胜挑战加载失败" }),
              h("p", { class: "empty-desc", text: error }),
            )
          : loadingBlock("正在加载连胜挑战…"),
      );
      return;
    }
    const playing = state.status === "playing";
    const ended = state.status === "ended";
    const canPlay = Boolean(store.user && !store.user.isGuest);
    const restMs = playing ? Math.max(0, Number(state.nextAt) - Date.now()) : 0;
    const resting = restMs > 0;
    if (restTimer) {
      clearTimeout(restTimer);
      restTimer = null;
    }
    if (resting) {
      restTimer = setTimeout(() => {
        restTimer = null;
        if (!destroyed) render();
      }, Math.min(1000, restMs + 30));
    }
    for (const [item, button] of tabButtons) {
      const active = item === variant;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
    }
    form.classList.toggle("is-hidden", !playing || !canPlay);
    startButton.classList.toggle("is-hidden", playing || !canPlay);
    quitButton.classList.toggle("is-hidden", !playing);
    input.disabled = !playing || !canPlay || resting;
    submit.disabled = !playing || !canPlay || resting;
    feedback.textContent = resting
      ? `休息中，${(restMs / 1000).toFixed(1)} 秒后开始下一题`
      : error || state.message || "";
    feedback.classList.toggle("is-hidden", !(resting || error || state.message));
    const canShare =
      ended && Boolean(state.answer || (Array.isArray(state.rows) && state.rows.length > 0) || Number(state.streak) > 0);
    shareButton.classList.toggle("is-hidden", !canShare);

    const endResult =
      ended && state.answer
        ? h(
            "section",
            { class: "panel streak-result" },
            h("p", { class: "streak-result-kicker", text: "本轮结束" }),
            h("strong", { class: "streak-answer", text: safeText(state.answer, "") }),
            h("p", { class: "streak-explanation", text: safeText(state.explanation, "暂无解释") }),
          )
        : null;
    const gate = !canPlay
      ? h(
          "div",
          { class: "streak-gate" },
          h("p", { class: "daily-gate-text", text: "登录后才能开始连胜挑战。" }),
          h(
            "div",
            { class: "daily-gate-actions" },
            h(
              "button",
              { class: "btn btn-primary", type: "button", onclick: () => ctx.openAuth("register") },
              "注册账号",
            ),
            h(
              "button",
              { class: "btn btn-ghost", type: "button", onclick: () => ctx.openAuth("login") },
              "登录",
            ),
          ),
        )
      : null;

    body.replaceChildren(
      h(
        "div",
        { class: "streak-layout" },
        h(
          "section",
          { class: "panel streak-panel" },
          tabs,
          h("p", { class: "streak-hint", text: STREAK_META[variant].hint }),
          h(
            "div",
            { class: "streak-stats" },
            h("span", { class: "streak-stat" }, h("strong", { text: Number(state.streak) || 0 }), " 当前连胜"),
            h("span", { class: "streak-stat" }, h("strong", { text: Number(state.best) || 0 }), " 最高连胜"),
            h("span", { class: "streak-stat" }, h("strong", { text: Number(state.remainingRows) || 0 }), " 剩余行"),
            h(
              "span",
              { class: "streak-stat" },
              h("strong", { text: formatDurationMs(state.averageSolveMs) }),
              " 平均用时",
            ),
            h(
              "span",
              { class: "streak-stat" },
              h("strong", { text: formatDurationMs(state.fastestSolveMs) }),
              " 最快用时",
            ),
          ),
          endResult,
          gate,
          h(
            "div",
            { class: "streak-actions" },
            startButton,
            quitButton,
            shareButton,
          ),
          h("div", { class: "streak-form-wrap" }, form, feedback),
          renderBoard(),
        ),
        h(
          "aside",
          { class: "panel streak-board-panel" },
          h(
            "div",
            { class: "leaderboard-head" },
            h("h2", { class: "page-title", text: "连胜排行榜" }),
            h("span", { class: "streak-board-count", text: `${leaderboard.length} 人` }),
          ),
          renderLeaderboard(),
          stats
            ? h(
                "p",
                { class: "streak-total" },
                `累计 ${Number(stats.runs) || 0} 次挑战，答对 ${Number(stats.solved) || 0} 题，最高 ${Number(stats.best) || 0} 连胜，平均 ${formatDurationMs(
                  Number(stats.solved) > 0 ? Number(stats.totalSolveMs) / Number(stats.solved) : 0,
                )}`,
              )
            : null,
        ),
      ),
    );
  }

  async function load() {
    if (loading) return;
    const currentRequest = ++requestId;
    loading = true;
    error = "";
    render();
    try {
      const [data, rows, statsData] = await Promise.all([
        api.fetchStreak(variant).catch(() => null),
        api.fetchStreakLeaderboard(variant).catch(() => []),
        api.fetchStreakStats().catch(() => null),
      ]);
      if (destroyed || currentRequest !== requestId) return;
      state = data || {
        variant,
        status: "ended",
        rows: [],
        maxRows: 6,
        remainingRows: 6,
        streak: 0,
        best: Number(statsData && statsData.best) || 0,
        answer: null,
        explanation: null,
        message: "选择变体开始挑战",
      };
      leaderboard = Array.isArray(rows) ? rows : [];
      stats = statsData;
    } catch (err) {
      if (destroyed || currentRequest !== requestId) return;
      error = err && err.message ? err.message : "网络异常";
    } finally {
      if (!destroyed && currentRequest === requestId) {
        loading = false;
        render();
      }
    }
  }

  async function start() {
    if (busy) return;
    busy = true;
    startButton.disabled = true;
    try {
      const data = await api.startStreak(variant);
      if (destroyed) return;
      state = data;
      error = "";
      toast("连胜挑战开始", "success");
      render();
    } catch (err) {
      error = err && err.message ? err.message : "开始失败";
      render();
    } finally {
      busy = false;
      startButton.disabled = false;
    }
  }

  async function guess() {
    if (busy || !state || state.status !== "playing") return;
    if (Number(state.nextAt) > Date.now()) return;
    const word = input.value.trim();
    if (Array.from(word).length !== 4) {
      error = "请输入四个汉字";
      render();
      return;
    }
    busy = true;
    submit.disabled = true;
    try {
      const data = await api.guessStreak(word);
      if (destroyed) return;
      state = data;
      input.value = "";
      error = "";
      render();
      if (state.status === "ended") toast("挑战结束", "warn");
    } catch (err) {
      error = err && err.message ? err.message : "提交失败";
      render();
    } finally {
      busy = false;
      submit.disabled = false;
    }
  }

  async function quit() {
    if (busy) return;
    busy = true;
    try {
      await api.quitStreak();
      const data = await api.fetchStreak(variant).catch(() => null);
      if (destroyed) return;
      state = data || {
        ...state,
        status: "ended",
        message: `已结束挑战，本局连胜 ${Number(state && state.streak) || 0}`,
      };
      error = "";
      render();
    } catch (err) {
      error = err && err.message ? err.message : "结束失败";
      render();
    } finally {
      busy = false;
    }
  }

  async function share() {
    if (!state) return;
    const text = [
      "🎮 词影竞技场 连胜挑战",
      `模式：${STREAK_META[variant].label}`,
      `本局连胜：${Number(state.streak) || 0}`,
      `最高连胜：${Number(state.best) || 0}`,
      "来挑战你的连胜：",
      `${location.origin}/`,
    ].join("\n");
    const ok = await copyText(text);
    toast(ok ? "战绩已复制" : "复制失败，请手动选择文本", ok ? "success" : "warn");
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    guess();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      guess();
    }
  });

  const el = h(
    "div",
    { class: "view streak-view" },
    header,
    h("main", { class: "streak-main" }, body),
  );

  unsubscribe.push(on("user", () => load()));
  const heartbeatTimer = setInterval(() => {
    if (destroyed || !state || state.status !== "playing") return;
    // 保持服务端 60 秒断线计时器存活；页面关闭或断网后计时器自然到期。
    api.fetchStreak(variant).catch(() => {});
  }, 20_000);
  render();
  load();

  return {
    el,
    destroy() {
      destroyed = true;
      requestId += 1;
      if (restTimer) clearTimeout(restTimer);
      clearInterval(heartbeatTimer);
      for (const off of unsubscribe) off();
    },
  };
}
