/**
 * 每日一题（#/daily）。全服同一题，东八区 00:00 换题。
 */

import * as api from "../api.js";
import { store, on } from "../store.js";
import { feedbackTileNode } from "../board.js";
import {
  h,
  icon,
  toast,
  copyText,
  openModal,
  loadingBlock,
  currentTheme,
  toggleTheme,
  formatDuration,
  avatarNode,
  safeText,
} from "../ui.js";

const DAILY_INTRO =
  "今天的题更难一点，慢慢看笔画。全服同一道题，每天 00:00 更新，四个汉字就能猜，答对就能上榜。";
const INTRO_SEEN_PREFIX = "ciying.dailyIntro.";

function weekdayLabel(value) {
  const labels = { 1: "周一", 2: "周二", 3: "周三", 4: "周四", 5: "周五", 6: "周六", 7: "周日", 0: "周日" };
  return labels[Number(value)] || "";
}

function summaryColorClass(value) {
  if (value === "green") return "daily-cell is-green";
  if (value === "yellow") return "daily-cell is-yellow";
  return "daily-cell is-gray";
}

function emojiMatrix(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) =>
      (Array.isArray(row.summary) ? row.summary : [])
        .map((value) => (value === "green" ? "🟩" : value === "yellow" ? "🟨" : "⬜"))
        .join(""),
    )
    .join("\n");
}

export function createDailyView(ctx) {
  let state = null;
  let loading = false;
  let error = "";
  let busy = false;
  let destroyed = false;
  let requestId = 0;
  let message = "";
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
  const introButton = h(
    "button",
    {
      class: "btn btn-ghost btn-sm",
      type: "button",
      onclick: () => openDailyIntro(),
    },
    "游戏说明",
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
        h("h1", { class: "brand-title", text: "每日挑战" }),
        h("p", { class: "brand-sub", text: "Daily Ciying" }),
      ),
    ),
    h("div", { class: "header-actions" }, introButton, changelogButton, helpButton, themeButton),
  );

  const body = h("div", { class: "daily-body" });
  const input = h("input", {
    class: "input daily-input",
    type: "text",
    maxlength: "4",
    placeholder: "输入四个汉字",
    autocomplete: "off",
    "aria-label": "每日一题答案",
  });
  const submit = h("button", { class: "btn btn-primary daily-submit", type: "submit" }, "提交");
  const form = h("form", { class: "daily-form" }, input, submit);
  const feedback = h("p", { class: "daily-message is-hidden", role: "alert" });
  const copyButton = h(
    "button",
    { class: "btn btn-primary", type: "button" },
    icon("copy", 16),
    "复制战绩卡",
  );
  let introModal = null;
  let introTimer = null;

  function introKey() {
    return `${INTRO_SEEN_PREFIX}${store.user && store.user.id ? store.user.id : "guest"}`;
  }

  function introSeen() {
    try {
      return localStorage.getItem(introKey()) === "1";
    } catch {
      return false;
    }
  }

  function markIntroSeen() {
    try {
      localStorage.setItem(introKey(), "1");
    } catch {
      /* ignore */
    }
  }

  function openDailyIntro() {
    if (introModal) return;
    const content = h(
      "div",
      { class: "daily-intro-modal" },
      h("h3", { class: "profile-title", text: "每日一题玩法" }),
      h("p", { class: "help-paragraph", text: "每天全服同一道四字成语题，答案只在答对后公布。" }),
      h(
        "ul",
        { class: "onboarding-list" },
        h("li", { text: "每次提交四个汉字，逐位比较笔画，最多可以猜很多次。" }),
        h("li", { text: "正确笔画显示绿色，相似笔画显示黑色或灰色，完全正确时整格绿底。" }),
        h("li", { text: "自由猜词不要求来自词库，四个汉字就能猜。" }),
        h("li", { text: "东八区每天 00:00 换题，答对后按猜测次数和用时排名。" }),
      ),
      h(
        "button",
        {
          class: "btn btn-primary btn-block",
          type: "button",
          onclick: () => {
            markIntroSeen();
            if (introModal) introModal.close();
            introModal = null;
          },
        },
        "知道了",
      ),
    );
    introModal = openModal({
      title: "每日一题玩法",
      content,
      onClose: () => {
        introModal = null;
      },
    });
  }

  function maybeAutoIntro() {
    if (introSeen()) return;
    openDailyIntro();
  }

  function canGuess() {
    return Boolean(store.user && !store.user.isGuest);
  }

  function renderRows() {
    const rows = Array.isArray(state && state.rows) ? state.rows : [];
    if (rows.length === 0) {
      return h("p", { class: "daily-empty", text: "还没有猜测，输入四个汉字试试看。" });
    }
    return h(
      "div",
      { class: "daily-rows" },
      ...rows.map((row, index) =>
        h(
          "div",
          { class: "daily-row" },
          h("span", { class: "daily-row-no", text: String(index + 1).padStart(2, "0") }),
          h("div", { class: "daily-row-main" },
            h("div", { class: "daily-row-word", text: safeText(row.word, "未知") }),
            h(
              "div",
              { class: "daily-tiles" },
              ...(Array.isArray(row.tiles) ? row.tiles : []).map((tile, tileIndex) =>
                feedbackTileNode(tile, tileIndex),
              ),
            ),
          ),
        ),
      ),
    );
  }

  function renderLeaderboard() {
    const rows = Array.isArray(state && state.leaderboard) ? state.leaderboard : [];
    if (rows.length === 0) {
      return h("p", { class: "daily-empty", text: "还没有人完成今天的题目。" });
    }
    return h(
      "div",
      { class: "daily-leaderboard" },
      ...rows.map((row) =>
        h(
          "div",
          { class: "daily-rank-row" },
          h("span", { class: "daily-rank-cell", text: safeText(row.rank, "—") }),
          avatarNode(safeText(row.name, "未知玩家"), row.avatar, "avatar-xs"),
          h("span", { class: "daily-rank-name", text: safeText(row.name, "未知玩家") }),
          h("span", { class: "daily-rank-attempts", text: `${Number(row.attempts) || 0} 次` }),
          h("span", {
            class: "daily-rank-time",
            text:
              row.durationMs !== null && row.durationMs !== undefined
                ? `用时 ${formatDuration(row.durationMs)}`
                : "—",
          }),
        ),
      ),
    );
  }

  function render() {
    if (!state) {
      body.replaceChildren(loadingBlock("正在加载今日题目…"));
      return;
    }
    const solved = Boolean(state.solved);
    const rows = Array.isArray(state.rows) ? state.rows : [];
    const me = state.me;
    const result = solved
      ? h(
          "section",
          { class: "panel daily-result" },
          h("p", { class: "daily-result-kicker", text: "今日已完成" }),
          h("h2", { class: "daily-answer", text: safeText(state.answer, "") }),
          h("p", { class: "daily-explanation", text: safeText(state.explanation, "暂无解释") }),
          h(
            "p",
            { class: "daily-rank-line" },
            `全服第 ${me && Number(me.rank) ? Number(me.rank) : "—"} 名，用了 ${Number(state.attempts) || 0} 次${
              state.durationMs !== null && state.durationMs !== undefined
                ? `，用时 ${formatDuration(state.durationMs)}`
                : ""
            }`,
          ),
        )
      : null;

    const gate = !canGuess()
      ? h(
          "div",
          { class: "daily-gate" },
          h("p", { class: "daily-gate-text", text: "登录或注册后即可参与每日一题。" }),
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
          h("p", { class: "daily-gate-note", text: "游客可以查看题目和排行榜，但不能提交答案。" }),
        )
      : null;

    form.classList.toggle("is-hidden", solved || !canGuess());
    feedback.textContent = message;
    feedback.classList.toggle("is-hidden", !message);
    copyButton.classList.toggle("is-hidden", !solved);

    body.replaceChildren(
      h(
        "div",
        { class: "daily-layout" },
        h(
          "section",
          { class: "panel daily-panel" },
          h(
            "div",
            { class: "daily-head" },
            h("span", { class: "daily-badge", text: safeText(state.date, "今日") }),
            h("span", { class: "daily-weekday", text: weekdayLabel(state.weekday) }),
            h("span", {
              class: "daily-difficulty",
              text: state.isCommonDay ? "周日特别题" : "今日题目更难",
            }),
          ),
          h("p", { class: "daily-intro", text: DAILY_INTRO }),
          Number(state.streakDays) > 0
            ? h("p", {
                class: "daily-streak",
                text: `已连续挑战成功 ${Number(state.streakDays)} 天`,
              })
            : null,
          result,
          renderRows(),
          gate,
          form,
          feedback,
          h("div", { class: "daily-actions" }, copyButton),
        ),
        h(
          "aside",
          { class: "panel daily-board-panel" },
          h(
            "div",
            { class: "daily-board-head" },
            h("h2", { class: "page-title", text: "全服排行榜" }),
            h("span", {
              class: "daily-board-count",
              text: `${Array.isArray(state.leaderboard) ? state.leaderboard.length : 0} 人完成`,
            }),
          ),
          renderLeaderboard(),
        ),
      ),
    );
  }

  async function copyResult() {
    if (!state || !state.solved) return;
    const rows = Array.isArray(state.rows) ? state.rows : [];
    const rank = state.me && Number(state.me.rank) ? Number(state.me.rank) : "—";
    const text = [
      `词影竞技场 每日一题 ${safeText(state.date, "")}`,
      emojiMatrix(rows),
      `猜测 ${Number(state.attempts) || 0} 次`,
      `全服第 ${rank} 名`,
      "今天的题目更难，你能猜出来吗？",
      `${location.origin}/#/daily`,
    ].join("\n");
    const ok = await copyText(text);
    toast(ok ? "战绩卡已复制" : "复制失败，请手动选择文本", ok ? "success" : "warn");
  }

  async function submitGuess() {
    if (busy) return;
    if (!canGuess()) {
      ctx.openAuth("login");
      return;
    }
    const word = input.value.trim();
    if (Array.from(word).length !== 4) {
      message = "请输入四个汉字";
      render();
      return;
    }
    busy = true;
    submit.disabled = true;
    submit.textContent = "提交中…";
    message = "";
    try {
      const data = await api.guessDaily(word);
      if (destroyed) return;
      state = data;
      input.value = "";
      if (state.solved) message = "回答正确";
      else message = "继续尝试";
      render();
      if (state.solved) toast("答对了，今日一题完成", "success");
    } catch (err) {
      if (destroyed) return;
      if (err && err.status === 401) {
        message = "登录状态已失效，请重新登录";
        ctx.openAuth("login");
      } else if (err && err.status === 403) {
        message = "注册用户才能参与每日一题";
      } else {
        message = err && err.message ? err.message : "提交失败，请稍后再试";
      }
      render();
    } finally {
      busy = false;
      submit.disabled = false;
      submit.textContent = "提交";
    }
  }

  copyButton.addEventListener("click", copyResult);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submitGuess();
    }
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submitGuess();
  });

  async function load() {
    if (loading) return;
    const currentRequest = ++requestId;
    loading = true;
    error = "";
    render();
    try {
      const data = await api.fetchDaily();
      if (destroyed || currentRequest !== requestId) return;
      state = data;
    } catch (err) {
      if (destroyed || currentRequest !== requestId) return;
      error = err && err.message ? err.message : "网络异常";
    } finally {
      if (!destroyed && currentRequest === requestId) {
        loading = false;
        if (error && !state) {
          body.replaceChildren(
            h(
              "div",
              { class: "stats-error" },
              h("p", { class: "empty-title", text: "每日一题加载失败" }),
              h("p", { class: "empty-desc", text: error }),
              h(
                "button",
                { class: "btn btn-ghost btn-sm", type: "button", onclick: () => load() },
                "重试",
              ),
            ),
          );
        } else {
          render();
        }
      }
    }
  }

  unsubscribe.push(
    on("user", () => {
      maybeAutoIntro();
      load();
    }),
  );

  const el = h(
    "div",
    { class: "view daily-view" },
    header,
    h("main", { class: "daily-main" }, body),
  );

  load();
  introTimer = setTimeout(maybeAutoIntro, 80);

  return {
    el,
    destroy() {
      destroyed = true;
      requestId += 1;
      clearTimeout(introTimer);
      introTimer = null;
      if (introModal) introModal.close();
      introModal = null;
      for (const off of unsubscribe) off();
    },
  };
}
