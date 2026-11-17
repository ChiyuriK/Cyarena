/**
 * 个人统计页（#/stats）。
 *
 * GET /api/stats/me（Bearer）返回 { total, modes }。游客 / 401 时展示登录提示，
 * 不抛错、不崩页面。
 */

import * as api from "../api.js";
import { store, on } from "../store.js";
import { MODES, RANKED_MODES } from "../constants.js";
import {
  h,
  icon,
  modeBadge,
  modeLabel,
  loadingBlock,
  currentTheme,
  toggleTheme,
  formatDurationMs,
  formatPercent,
} from "../ui.js";

const ZERO_STATS = {
  matches: 0,
  wins: 0,
  losses: 0,
  draws: 0,
  rounds: 0,
  roundsWithGuess: 0,
  guesses: 0,
  solves: 0,
  totalSolveMs: 0,
  fastestSolveMs: 0,
  fastestMatchAwards: 0,
  points: 0,
  setsWon: 0,
  winRate: 0,
  solveRate: 0,
  guessAccuracy: 0,
  avgSolveMs: 0,
};

function normalizeStatsView(source) {
  if (!source || typeof source !== "object") return { ...ZERO_STATS };
  return {
    ...ZERO_STATS,
    ...source,
    matches: Number(source.matches) || 0,
    wins: Number(source.wins) || 0,
    losses: Number(source.losses) || 0,
    draws: Number(source.draws) || 0,
    rounds: Number(source.rounds) || 0,
    roundsWithGuess: Number(source.roundsWithGuess) || 0,
    guesses: Number(source.guesses) || 0,
    solves: Number(source.solves) || 0,
    totalSolveMs: Number(source.totalSolveMs) || 0,
    fastestSolveMs: Number(source.fastestSolveMs) || 0,
    fastestMatchAwards: Number(source.fastestMatchAwards) || 0,
    points: Number(source.points) || 0,
    setsWon: Number(source.setsWon) || 0,
    winRate: Number(source.winRate) || 0,
    solveRate: Number(source.solveRate) || 0,
    guessAccuracy: Number(source.guessAccuracy) || 0,
    avgSolveMs: Number(source.avgSolveMs) || 0,
  };
}

function normalizeStatsResponse(data) {
  const modes = {};
  for (const mode of MODES) {
    modes[mode] = normalizeStatsView(data && data.modes ? data.modes[mode] : null);
  }
  return { total: normalizeStatsView(data && data.total), modes };
}

function statItem(label, value, hint) {
  return h(
    "div",
    { class: "stat-item" },
    h("span", { class: "stat-label", text: label }),
    h("strong", { class: "stat-value", text: String(value) }),
    hint ? h("span", { class: "stat-hint", text: hint }) : null,
  );
}

export function createStatsView(ctx) {
  let data = null;
  let loading = false;
  let error = null;
  let unauthorized = false;
  let destroyed = false;
  let requestId = 0;
  let streakStats = null;

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
        h("h1", { class: "brand-title", text: "个人统计" }),
        h("p", { class: "brand-sub", text: "Ciying Arena Stats" }),
      ),
    ),
    h("div", { class: "header-actions" }, changelogButton, helpButton, themeButton),
  );

  const body = h("div", { class: "stats-body" });
  const refreshButton = h(
    "button",
    { class: "btn btn-ghost btn-sm", type: "button", onclick: () => load(true) },
    icon("refresh", 16),
    "刷新",
  );

  const el = h(
    "div",
    { class: "view stats-view" },
    header,
    h(
      "main",
      { class: "stats-main" },
      h(
        "section",
        { class: "panel stats-panel" },
        h(
          "div",
          { class: "leaderboard-head" },
          h(
            "div",
            {},
            h("h2", { class: "page-title", text: "个人统计" }),
            h("p", {
              class: "page-sub",
              text: "仅登录账号记录，游客对局不计入。总览不含练习模式，练习数据单独展示。",
            }),
          ),
          refreshButton,
        ),
        body,
      ),
    ),
  );

  function requireLoginPanel(reason) {
    return h(
      "div",
      { class: "stats-gate" },
      h("span", { class: "stats-gate-icon" }, icon("lock", 26)),
      h("h3", { class: "guest-title", text: "登录后查看个人统计" }),
      h("p", {
        class: "guest-desc",
        text: reason || "游客对局不会写入持久统计。登录账号后即可查看各项数据。",
      }),
      h(
        "div",
        { class: "stats-gate-actions" },
        h(
          "button",
          { class: "btn btn-primary", type: "button", onclick: () => ctx.openAuth("login") },
          "登录 / 注册",
        ),
        h(
          "button",
          { class: "btn btn-ghost", type: "button", onclick: () => ctx.goLobby() },
          "返回大厅",
        ),
      ),
    );
  }

  function renderOverview(total) {
    const winLossDraw = `${total.wins} / ${total.losses} / ${total.draws}`;
    const cards = [
      statItem("总场次", total.matches),
      statItem("胜 / 负 / 平", winLossDraw),
      statItem("胜率", formatPercent(total.winRate)),
      statItem("累计得分", total.points),
      statItem("小局胜场", total.setsWon),
      statItem("参与轮数", total.rounds),
      statItem("猜出次数", total.solves),
      statItem("猜出率", formatPercent(total.solveRate)),
      statItem("猜测命中率", formatPercent(total.guessAccuracy)),
      statItem("平均猜出", formatDurationMs(total.avgSolveMs)),
      statItem("最快猜出", formatDurationMs(total.fastestSolveMs)),
      statItem("最快场次", total.fastestMatchAwards),
    ];
    return h(
      "section",
      { class: "stats-section" },
      h("h3", { class: "stats-section-title", text: "总览" }),
      h("div", { class: "stats-grid" }, ...cards),
      h(
        "p",
        { class: "stats-note" },
        `总猜测数 ${total.guesses} 次，有猜测的轮次 ${total.roundsWithGuess} 轮，累计猜出用时 ${formatDurationMs(total.totalSolveMs)}`,
      ),
    );
  }

  function renderModeDetail(mode, stats) {
    return h(
      "article",
      { class: `stats-mode-card ${mode === "team2v2" ? "team" : ""}` },
      h(
        "div",
        { class: "stats-mode-head" },
        modeBadge(mode),
        h("span", { class: "stats-mode-title", text: modeLabel(mode) }),
      ),
      h(
        "div",
        { class: "stats-mode-grid" },
        statItem("场次", stats.matches),
        statItem("胜 / 负 / 平", `${stats.wins} / ${stats.losses} / ${stats.draws}`),
        statItem("胜率", formatPercent(stats.winRate)),
        statItem("参与轮数", stats.rounds),
        statItem("猜出次数", stats.solves),
        statItem("猜出率", formatPercent(stats.solveRate)),
        statItem("命中率", formatPercent(stats.guessAccuracy)),
        statItem("平均猜出", formatDurationMs(stats.avgSolveMs)),
        statItem("最快猜出", formatDurationMs(stats.fastestSolveMs)),
        statItem("最快场次", stats.fastestMatchAwards),
        statItem("累计得分", stats.points),
        statItem("小局胜场", stats.setsWon),
      ),
    );
  }

  function renderPracticeDetail(stats) {
    return h(
      "article",
      { class: "stats-mode-card" },
      h(
        "div",
        { class: "stats-mode-head" },
        modeBadge("practice"),
        h("span", { class: "stats-mode-title", text: modeLabel("practice") }),
      ),
      h(
        "div",
        { class: "stats-mode-grid" },
        statItem("盘数", stats.matches),
        statItem("猜测", stats.guesses),
        statItem("猜出", stats.solves),
        statItem("猜出率", formatPercent(stats.solveRate)),
        statItem("平均猜出", formatDurationMs(stats.avgSolveMs)),
        statItem("最快猜出", formatDurationMs(stats.fastestSolveMs)),
      ),
    );
  }

  function renderStreakSection() {
    const stats = streakStats || {
      runs: 0,
      solved: 0,
      best: 0,
      totalSolveMs: 0,
      fastestSolveMs: 0,
    };
    const averageSolveMs =
      Number(stats.solved) > 0 ? Number(stats.totalSolveMs) / Number(stats.solved) : 0;
    return h(
      "section",
      { class: "stats-section" },
      h(
        "div",
        { class: "stats-section-head" },
        h("h3", { class: "stats-section-title", text: "连胜挑战" }),
        h(
          "button",
          {
            class: "btn btn-ghost btn-sm",
            type: "button",
            onclick: () => ctx.goStreak("standard"),
          },
          "去挑战",
        ),
      ),
      h(
        "div",
        { class: "stats-grid" },
        statItem("挑战次数", Number(stats.runs) || 0),
        statItem("累计答对", Number(stats.solved) || 0),
        statItem("最高连胜", Number(stats.best) || 0),
        statItem("平均用时", formatDurationMs(averageSolveMs)),
        statItem("最快用时", formatDurationMs(Number(stats.fastestSolveMs) || 0)),
      ),
      h("p", { class: "stats-note", text: "三种变体合并统计。" }),
    );
  }

  function renderBody() {
    refreshButton.classList.toggle("is-spinning", loading);
    if (!store.user || store.user.isGuest) {
      body.replaceChildren(requireLoginPanel("游客对局不会写入持久统计；登录账号后即可查看。"));
      return;
    }
    if (unauthorized) {
      body.replaceChildren(requireLoginPanel("登录状态已失效或需要登录后查看。"));
      return;
    }
    if (loading && !data) {
      body.replaceChildren(loadingBlock("正在加载个人统计…"));
      return;
    }
    if (error) {
      body.replaceChildren(
        h(
          "div",
          { class: "stats-error" },
          h("p", { class: "empty-title", text: "统计加载失败" }),
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
    if (!data) {
      body.replaceChildren(
        h(
          "div",
          { class: "stats-empty" },
          h("p", { class: "empty-title", text: "暂无统计数据" }),
          h("p", { class: "empty-desc", text: "完成一场对局后再来看看吧。" }),
        ),
      );
      return;
    }
    body.replaceChildren(
      renderOverview(data.total),
      renderStreakSection(),
      h(
        "section",
        { class: "stats-section" },
        h("h3", { class: "stats-section-title", text: "排位模式" }),
        h(
          "div",
          { class: "stats-modes" },
          ...RANKED_MODES.map((mode) => renderModeDetail(mode, data.modes[mode])),
        ),
      ),
      h(
        "section",
        { class: "stats-section" },
        h("h3", { class: "stats-section-title", text: "练习模式" }),
        h("p", {
          class: "stats-note",
          text: "练习模式单独累计，不计入天梯与总统计。",
        }),
        h(
          "div",
          { class: "stats-modes" },
          renderPracticeDetail(data.modes.practice),
        ),
      ),
      h("p", {
        class: "stats-note",
        text: "统计口径：猜出率 = 猜出次数 / 提交过猜测的轮数，命中率 = 猜出次数 / 总猜测数。",
      }),
    );
  }

  async function load(force = false) {
    if (!store.user || store.user.isGuest) {
      renderBody();
      return;
    }
    if (loading) return;
    const currentRequest = ++requestId;
    loading = true;
    error = null;
    unauthorized = false;
    if (force) data = null;
    renderBody();
    try {
      const [response, streakResponse] = await Promise.all([
        api.fetchMyStats(),
        api.fetchStreakStats().catch(() => null),
      ]);
      if (destroyed || currentRequest !== requestId) return;
      data = normalizeStatsResponse(response);
      streakStats = streakResponse;
    } catch (loadError) {
      if (destroyed || currentRequest !== requestId) return;
      if (loadError && loadError.status === 401) unauthorized = true;
      else error = loadError && loadError.message ? loadError.message : "网络错误";
      data = null;
    } finally {
      if (destroyed || currentRequest !== requestId) return;
      loading = false;
      renderBody();
    }
  }

  unsubscribe.push(
    on("user", () => {
      data = null;
      streakStats = null;
      unauthorized = false;
      error = null;
      renderBody();
    }),
  );

  renderBody();
  load(false);

  return {
    el,
    destroy() {
      destroyed = true;
      for (const off of unsubscribe) off();
    },
  };
}
