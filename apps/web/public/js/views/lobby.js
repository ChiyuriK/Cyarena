/**
 * 大厅：游客/登录入口、创建房间、快速匹配、加入房间、公开房间列表、排行榜入口。
 */

import * as api from "../api.js";
import * as ws from "../ws.js";
import { store, on, emit, loadRejoin, clearRejoin, serverNow } from "../store.js";
import { isMockMode } from "../env.js";
import { avatarFileToDataUrl, validateAvatarFile, isAvatarDataUrl } from "../avatar.js";
import { shouldShowOnboarding, markOnboardingNever } from "../onboarding.js";
import {
  RANKED_MODES,
  modeMeta,
  NAME_MAX,
  DUEL_BEST_OF_OPTIONS,
  DUEL_DEFAULT_BEST_OF,
  DUEL_POINTS_TO_WIN,
  DUEL_POINT_LEAD,
  GUESS_MODES,
  DEFAULT_GUESS_MODE,
  DICTIONARY_MODES,
  DEFAULT_DICTIONARY,
  dictionaryLabel,
  dictionaryHint,
  POINTS_TO_WIN_OPTIONS,
  DEFAULT_POINTS_TO_WIN,
  MIN_POINTS_TO_WIN,
  MAX_POINTS_TO_WIN,
  defaultPointsForMode,
  isPointsToWin,
  TEAM_UNLIMITED_CAPACITY,
  bestOfLabel,
  capacityLabel,
  guessModeLabel,
  guessModeHint,
  modeUsesSets,
} from "../constants.js";
import {
  h,
  icon,
  toast,
  openModal,
  connectionBadge,
  modeBadge,
  modeClass,
  statusLabel,
  modeLabel,
  currentTheme,
  toggleTheme,
  avatarNode,
  emptyState,
  loadingBlock,
  formatDuration,
  safeText,
} from "../ui.js";

function dailyEntryLabel() {
  try {
    const now = new Date();
    const date = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      month: "long",
      day: "numeric",
    }).format(now);
    const weekday = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      weekday: "long",
    }).format(now);
    return `${date} ${weekday}`;
  } catch {
    return "每天 00:00 换题";
  }
}

export function createLobbyView(ctx) {  let selectedMode = "duel";
  let visibility = "public";
  let bestOf = DUEL_DEFAULT_BEST_OF;
  let guessMode = DEFAULT_GUESS_MODE;
  let dictionary = DEFAULT_DICTIONARY;
  let pointsToWin = DEFAULT_POINTS_TO_WIN;
  let useCustomPoints = false;
  let siteStats = null;
  let siteTimer = null;
  let unreadTimer = null;
  let roomsLoading = false;
  let roomsError = "";
  let destroyed = false;
  let rejoinTimer = null;
  let onboardingModal = null;
  let onboardingShownUserId = null;
  let onboardingTimer = null;
  let dailyInfo = null;
  let unreadNotifications = 0;

  const unsubscribe = [];

  /* ------------------------------------------------------------------ */
  /* 头部                                                                */
  /* ------------------------------------------------------------------ */

  const connSlot = h("div", { class: "header-conn" }, connectionBadge(store.connection));
  const themeButton = h(
    "button",
    {
      class: "icon-btn",
      type: "button",
      title: "切换深浅色",
      "aria-label": "切换深浅色",
      onclick: () => {
        toggleTheme();
        syncThemeButton();
      },
    },
  );
  function syncThemeButton() {
    themeButton.replaceChildren(icon(currentTheme() === "dark" ? "sun" : "moon", 18));
  }
  syncThemeButton();

  const leaderboardButton = h(
    "button",
    { class: "btn btn-ghost btn-sm", type: "button", onclick: () => ctx.goLeaderboard() },
    icon("trophy", 16),
    "排行榜",
  );

  const statsButton = h(
    "button",
    { class: "btn btn-ghost btn-sm", type: "button", onclick: () => ctx.goStats() },
    icon("chart", 16),
    "统计",
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
  const friendsButton = h(
    "button",
    {
      class: "btn btn-ghost btn-sm header-friends-btn",
      type: "button",
      title: "好友",
      "aria-label": "好友",
      onclick: () => ctx.goFriends(),
    },
    icon("users", 16),
    h("span", { class: "btn-label", text: "好友" }),
  );
  const unreadBadge = h("span", { class: "notification-badge is-hidden", text: "" });
  const notificationsButton = h(
    "button",
    {
      class: "btn btn-ghost btn-sm header-notification-btn",
      type: "button",
      title: "通知",
      "aria-label": "通知",
      onclick: () => ctx.goNotifications(),
    },
    icon("bell", 16),
    h("span", { class: "btn-label", text: "通知" }),
    unreadBadge,
  );

  const userSlot = h("div", { class: "user-slot" });

  const header = h(
    "header",
    { class: "site-header" },
    h(
      "div",
      { class: "brand" },
      h("span", { class: "brand-mark", text: "词" }),
      h(
        "div",
        { class: "brand-text" },
        h("h1", { class: "brand-title", text: "词影竞技场" }),
        h("p", { class: "brand-sub", text: "Ciying Arena" }),
      ),
    ),
    h(
      "div",
      { class: "header-actions" },
      isMockMode() ? h("span", { class: "mock-badge", text: "MOCK 预览" }) : null,
      connSlot,
      leaderboardButton,
      statsButton,
      friendsButton,
      notificationsButton,
      helpButton,
      changelogButton,
      themeButton,
      userSlot,
    ),
  );

  /* ------------------------------------------------------------------ */
  /* Hero / 会话区                                                       */
  /* ------------------------------------------------------------------ */

  const sessionSlot = h("div", { class: "session-slot" });
  const siteStatsBar = h("div", { class: "site-stats", text: "正在加载站点统计…" });
  const hero = h(
    "section",
    { class: "hero panel" },
    h(
      "div",
      { class: "hero-copy" },
      h("p", { class: "hero-kicker", text: "共享棋盘，抢答四字成语" }),
      h("h2", { class: "hero-title", text: "看笔画，猜成语，抢分制胜！" }),
      h(
        "p",
        { class: "hero-desc", text: "每轮全房共享一张 6 行棋盘；1v1 / 团队战小局先到 11 分，3 人混战先到 7 分。" },
      ),
    ),
    sessionSlot,
  );

  const dailyStatus = h("span", { class: "daily-entry-note", text: "今日题目更难" });
  const dailyStreak = h("span", { class: "daily-entry-streak is-hidden", text: "" });
  const dailyEntry = h(
    "button",
    {
      class: "daily-entry daily-hero panel",
      type: "button",
      onclick: () => ctx.goDaily(),
    },
    h(
      "span",
      { class: "daily-entry-icon" },
      icon("calendar", 26),
    ),
    h(
      "span",
      { class: "daily-entry-main" },
      h("span", { class: "daily-entry-kicker", text: "每日一题" }),
      h("strong", { class: "daily-entry-title", text: "每日挑战" }),
      h("span", { class: "daily-entry-date", text: dailyEntryLabel() }),
    ),
    h("span", { class: "daily-entry-meta" }, dailyStatus, dailyStreak),
    icon("arrowRight", 20),
  );

  function renderSession() {
    const user = store.user;
    if (!user) {
      const remembered = api.getRememberedName();
      const input = h("input", {
        class: "input guest-input",
        type: "text",
        maxlength: String(NAME_MAX),
        placeholder: "给自己起个昵称（1-16 字）",
        autocomplete: "nickname",
        value: remembered,
        "aria-label": "游客昵称",
      });
      const submit = h("button", { class: "btn btn-primary", type: "submit" }, "以游客身份进入");
      const form = h(
        "form",
        { class: "guest-form is-hidden", novalidate: true },
        h("div", { class: "guest-form-row" }, input, submit),
        h("p", { class: "guest-hint", text: "游客对局不计入天梯，关闭页面后进度可能丢失。" }),
      );
      const trialButton = h(
        "button",
        {
          class: "guest-trial-link",
          type: "button",
          onclick: () => {
            form.classList.remove("is-hidden");
            trialButton.classList.add("is-hidden");
            input.focus();
          },
        },
        "先以游客身份试玩",
      );
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (submit.dataset.busy === "1") return;
        const name = input.value.trim();
        if (!name) {
          toast("请输入昵称", "warn");
          input.focus();
          return;
        }
        if (Array.from(name).length > NAME_MAX) {
          toast(`昵称最多 ${NAME_MAX} 个字符`, "warn");
          return;
        }
        submit.dataset.busy = "1";
        submit.disabled = true;
        submit.textContent = "进入中…";
        try {
          const session = await api.guestSession(name);
          api.saveSession(session.token, session.user);
          api.rememberName(name);
          store.token = session.token;
          store.user = session.user;
          emit("user", session.user);
          ws.connect();
          toast(`欢迎，${session.user.name}`, "success");
        } catch (error) {
          toast(error && error.message ? error.message : "进入失败", "error");
        } finally {
          submit.dataset.busy = "0";
          submit.disabled = false;
          submit.textContent = "以游客身份进入";
        }
      });
      sessionSlot.replaceChildren(
        h(
          "div",
          { class: "guest-gate" },
          h("h3", { class: "guest-title", text: "注册账号，保存你的竞技记录" }),
          h("p", {
            class: "guest-desc",
            text: "注册后可保存天梯分、对局战绩、最近成语与头像，换设备也能继续使用。",
          }),
          h(
            "div",
            { class: "guest-actions" },
            h(
              "button",
              {
                class: "btn btn-primary",
                type: "button",
                onclick: () => ctx.openAuth("register"),
              },
              "注册账号",
            ),
            h(
              "button",
              {
                class: "btn btn-ghost",
                type: "button",
                onclick: () => ctx.openAuth("login"),
              },
              "登录",
            ),
          ),
          trialButton,
          form,
        ),
      );
      return;
    }

    const isGuest = Boolean(user.isGuest);
    sessionSlot.replaceChildren(
      h(
        "div",
        { class: "user-greeting" },
        avatarNode(safeText(user.name, "玩家"), user.avatar, "avatar-lg"),
        h(
          "div",
          { class: "user-greeting-text" },
          h("p", { class: "greeting-line" }, "欢迎回来，", h("strong", { text: safeText(user.name, "玩家") })),
          h(
            "p",
            { class: "greeting-sub", text: isGuest ? "游客身份，本局不计天梯" : "已登录，参与天梯排行" },
          ),
        ),
        isGuest
          ? h(
              "button",
              { class: "btn btn-ghost btn-sm", type: "button", onclick: () => ctx.openAuth("login") },
              "登录 / 注册",
            )
          : h(
              "div",
              { class: "user-greeting-actions" },
              h(
                "button",
                { class: "btn btn-ghost btn-sm", type: "button", onclick: () => ctx.goFriends() },
                "好友",
              ),
              h(
                "button",
                { class: "btn btn-ghost btn-sm", type: "button", onclick: () => ctx.goNotifications() },
                "通知",
              ),
              h(
                "button",
                { class: "btn btn-ghost btn-sm", type: "button", onclick: () => ctx.goHistory() },
                "我的战绩",
              ),
              h(
                "button",
                { class: "btn btn-ghost btn-sm", type: "button", onclick: () => openProfileEditor() },
                "修改资料",
              ),
            ),
      ),
    );
  }

  /* ------------------------------------------------------------------ */
  /* 最近房间 / 重新加入                                                  */
  /* ------------------------------------------------------------------ */

  const rejoinSlot = h("div", { class: "rejoin-slot is-hidden" });

  function renderRejoin() {
    if (destroyed) return;
    const record = loadRejoin();
    if (!record) {
      rejoinSlot.replaceChildren();
      rejoinSlot.classList.add("is-hidden");
      return;
    }
    const remaining = record.expiresAt - Date.now();
    if (remaining <= 0) {
      clearRejoin();
      rejoinSlot.replaceChildren();
      rejoinSlot.classList.add("is-hidden");
      return;
    }
    rejoinSlot.classList.remove("is-hidden");
    rejoinSlot.replaceChildren(
      h(
        "div",
        { class: "rejoin-banner" },
        h(
          "div",
          { class: "rejoin-main" },
          h("span", { class: "rejoin-icon" }, icon("clock", 18)),
          h(
            "div",
            {},
            h("p", {
              class: "rejoin-title",
              text: `最近房间 ${safeText(record.code, "—")}，${modeLabel(record.mode)}`,
            }),
            h("p", {
              class: "rejoin-sub",
              text: `剩余 ${formatDuration(remaining)} 可重新加入`,
            }),
          ),
        ),
        h(
          "button",
          {
            class: "btn btn-primary btn-sm",
            type: "button",
            onclick: () => ws.joinRoom(record.code),
          },
          "重新加入",
        ),
        h(
          "button",
          {
            class: "icon-btn",
            type: "button",
            title: "忽略最近房间",
            "aria-label": "忽略最近房间",
            onclick: () => {
              clearRejoin();
              renderRejoin();
            },
          },
          icon("x", 16),
        ),
      ),
    );
  }

  /* ------------------------------------------------------------------ */
  /* 创建房间                                                            */
  /* ------------------------------------------------------------------ */

  const modeDesc = h("p", { class: "mode-desc" });
  const modePicker = h("div", { class: "mode-picker" });
  const modeButtons = new Map();
  for (const mode of RANKED_MODES) {
    const meta = modeMeta(mode);
    const button = h(
      "button",
      {
        class: `mode-option ${modeClass(mode)}`,
        type: "button",
        "aria-pressed": "false",
        onclick: () => selectMode(mode),
      },
      h("span", { class: "mode-option-label", text: meta.label }),
      h("span", { class: "mode-option-meta", text: capacityLabel(mode) }),
    );
    modeButtons.set(mode, button);
    modePicker.appendChild(button);
  }

  const bestOfPicker = h("div", { class: "bestof-picker" });
  const bestOfButtons = new Map();
  for (const value of DUEL_BEST_OF_OPTIONS) {
    const button = h(
      "button",
      {
        class: "bestof-option",
        type: "button",
        "aria-pressed": "false",
        title: `小局先到 ${DUEL_POINTS_TO_WIN} 分且领先 ${DUEL_POINT_LEAD} 分获胜`,
        onclick: () => selectBestOf(value),
      },
      h("span", { class: "bestof-option-label", text: bestOfLabel(value) }),
    );
    bestOfButtons.set(value, button);
    bestOfPicker.appendChild(button);
  }
  const bestOfHint = h("p", { class: "bestof-hint" });
  const bestOfBlock = h(
    "div",
    { class: "bestof-block" },
    h(
      "div",
      { class: "bestof-head" },
      h("span", { class: "bestof-label", text: "大比分（几局几胜）" }),
      h("span", {
        class: "bestof-target",
        text: `小局 ${DUEL_POINTS_TO_WIN} 分，领先 ${DUEL_POINT_LEAD} 分`,
      }),
    ),
    bestOfPicker,
    bestOfHint,
  );

  function selectBestOf(value) {
    bestOf = value;
    const setsToWin = Math.floor((value + 1) / 2);
    for (const [key, button] of bestOfButtons) {
      const active = key === value;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    }
    bestOfHint.textContent =
      value === 1
        ? "一局定胜负：抢下这一小局即赢下整场比赛。"
        : `先赢 ${setsToWin} 个小局者赢下比赛；每个小局独立计分。`;
  }
  selectBestOf(bestOf);

  function selectMode(mode) {
    selectedMode = mode;
    for (const [key, button] of modeButtons) {
      const active = key === mode;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    }
    modeDesc.textContent = modeMeta(mode).description;
    // 大比分只对 1v1 / 团队战生效。
    bestOfBlock.classList.toggle("is-hidden", !modeUsesSets(mode));
    pointsToWin = defaultPointsForMode(mode);
    useCustomPoints = false;
    if (pointsCustomInput) pointsCustomInput.value = String(pointsToWin);
    syncPointsOptions();
  }

  /* 猜测模式：标准 / 自由 */
  const guessModePicker = h("div", { class: "bestof-picker guessmode-picker" });
  const guessModeButtons = new Map();
  for (const value of GUESS_MODES) {
    const button = h(
      "button",
      {
        class: "bestof-option",
        type: "button",
        "aria-pressed": "false",
        onclick: () => selectGuessMode(value),
      },
      h("span", { class: "bestof-option-label", text: guessModeLabel(value) }),
    );
    guessModeButtons.set(value, button);
    guessModePicker.appendChild(button);
  }
  const guessModeHintEl = h("p", { class: "bestof-hint" });
  const guessModeBlock = h(
    "div",
    { class: "bestof-block" },
    h(
      "div",
      { class: "bestof-head" },
      h("span", { class: "bestof-label", text: "猜词模式" }),
      h("span", { class: "bestof-target", text: "默认标准" }),
    ),
    guessModePicker,
    guessModeHintEl,
  );

  function selectGuessMode(value) {
    guessMode = value;
    for (const [key, button] of guessModeButtons) {
      const active = key === value;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    }
    guessModeHintEl.textContent = guessModeHint(value);
  }
  selectGuessMode(guessMode);

  /* 词库：标准模式常见 / 全部 */
  const dictionaryPicker = h("div", { class: "bestof-picker dictionary-picker" });
  const dictionaryButtons = new Map();
  for (const value of DICTIONARY_MODES) {
    const button = h(
      "button",
      {
        class: "bestof-option",
        type: "button",
        "aria-pressed": "false",
        onclick: () => selectDictionary(value),
      },
      h("span", { class: "bestof-option-label", text: dictionaryLabel(value) }),
    );
    dictionaryButtons.set(value, button);
    dictionaryPicker.appendChild(button);
  }
  const dictionaryHintEl = h("p", { class: "bestof-hint" });
  const dictionaryBlock = h(
    "div",
    { class: "bestof-block" },
    h(
      "div",
      { class: "bestof-head" },
      h("span", { class: "bestof-label", text: "词库" }),
      h("span", { class: "bestof-target", text: "默认常见成语" }),
    ),
    dictionaryPicker,
    dictionaryHintEl,
  );

  function selectDictionary(value) {
    dictionary = value;
    for (const [key, button] of dictionaryButtons) {
      const active = key === value;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    }
    dictionaryHintEl.textContent = dictionaryHint(value);
  }
  selectDictionary(dictionary);

  /* 每小局目标分 */
  const pointsPicker = h("div", { class: "bestof-picker points-picker" });
  const pointsButtons = new Map();
  for (const value of POINTS_TO_WIN_OPTIONS) {
    const button = h(
      "button",
      {
        class: "bestof-option",
        type: "button",
        "aria-pressed": "false",
        onclick: () => selectPoints(value),
      },
      String(value),
    );
    pointsButtons.set(value, button);
    pointsPicker.appendChild(button);
  }
  const pointsCustomButton = h(
    "button",
    {
      class: "bestof-option",
      type: "button",
      "aria-pressed": "false",
      onclick: () => selectPoints("custom"),
    },
    "自定义",
  );
  const pointsCustomInput = h("input", {
    class: "input points-custom-input is-hidden",
    type: "number",
    min: String(MIN_POINTS_TO_WIN),
    max: String(MAX_POINTS_TO_WIN),
    value: String(pointsToWin),
    "aria-label": "自定义目标分",
  });
  const pointsHint = h("p", { class: "bestof-hint" });
  const pointsBlock = h(
    "div",
    { class: "bestof-block" },
    h(
      "div",
      { class: "bestof-head" },
      h("span", { class: "bestof-label", text: "每小局目标分" }),
      h("span", { class: "bestof-target", text: "默认 11，三人战默认 7" }),
    ),
    pointsPicker,
    pointsCustomButton,
    pointsCustomInput,
    pointsHint,
  );

  function syncPointsOptions() {
    for (const [key, button] of pointsButtons) {
      const active = !useCustomPoints && key === pointsToWin;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    }
    pointsCustomButton.classList.toggle("is-active", useCustomPoints);
    pointsCustomButton.setAttribute("aria-pressed", String(useCustomPoints));
    pointsCustomInput.classList.toggle("is-hidden", !useCustomPoints);
    pointsHint.textContent = `当前目标 ${pointsToWin} 分，允许 1 到 99 的自定义分数。`;
  }

  function selectPoints(value) {
    if (value === "custom") {
      useCustomPoints = true;
      if (isPointsToWin(pointsCustomInput.value)) pointsToWin = Number(pointsCustomInput.value);
      syncPointsOptions();
      pointsCustomInput.focus();
      return;
    }
    useCustomPoints = false;
    pointsToWin = value;
    pointsCustomInput.value = String(value);
    syncPointsOptions();
  }

  pointsCustomInput.addEventListener("input", () => {
    useCustomPoints = true;
    const value = Number(pointsCustomInput.value);
    if (isPointsToWin(value)) pointsToWin = value;
    syncPointsOptions();
  });

  selectDictionary(dictionary);
  syncPointsOptions();
  selectMode(selectedMode);

  const visibilityButtons = new Map();
  function buildVisibilityOption(value, label, desc) {
    const button = h(
      "button",
      { class: "visibility-option", type: "button", onclick: () => selectVisibility(value) },
      h("span", { class: "visibility-title", text: label }),
      h("span", { class: "visibility-desc", text: desc }),
    );
    visibilityButtons.set(value, button);
    return button;
  }
  function selectVisibility(value) {
    visibility = value;
    for (const [key, button] of visibilityButtons) {
      button.classList.toggle("is-active", key === value);
    }
  }

  const createButton = h(
    "button",
    {
      class: "btn btn-primary btn-block",
      type: "button",
      onclick: () => {
        if (!requireSession()) return;
        if (useCustomPoints) {
          const customValue = Number(pointsCustomInput.value);
          if (!isPointsToWin(customValue)) {
            toast(`目标分需要在 ${MIN_POINTS_TO_WIN} 到 ${MAX_POINTS_TO_WIN} 之间`, "warn");
            pointsCustomInput.focus();
            return;
          }
          pointsToWin = customValue;
        }
        ws.createRoom(selectedMode, visibility, {
          bestOf,
          guessMode,
          dictionary,
          pointsToWin,
        });
        toast("正在创建房间…");
      },
    },
    icon("bolt", 16),
    "创建房间",
  );

  const createCard = h(
    "section",
    { class: "panel action-card create-card" },
    h(
      "div",
      { class: "card-head" },
      h("h3", { class: "card-title", text: "创建房间" }),
      h("p", { class: "card-sub", text: "选择模式与可见性，规则可在房间内继续调整。" }),
    ),
    modePicker,
    modeDesc,
    h(
      "div",
      { class: "visibility-picker" },
      buildVisibilityOption("public", "公开", "大厅可见"),
      buildVisibilityOption("private", "私有", "仅房号可见"),
    ),
    createButton,
  );
  selectVisibility(visibility);

  /* ------------------------------------------------------------------ */
  /* 快速匹配                                                            */
  /* ------------------------------------------------------------------ */

  const queueSlot = h("div", { class: "queue-slot" });
  const queueButtons = new Map();
  const queueButtonsWrap = h("div", { class: "queue-modes queue-modes-2" });
  for (const mode of ["duel", "ffa3"]) {
    const meta = modeMeta(mode);
    const button = h(
      "button",
      {
        class: `queue-mode-btn ${modeClass(mode)}`,
        type: "button",
        onclick: () => {
          if (!requireSession()) return;
          if (store.queue) return;
          ws.joinQueue(mode);
          toast(`已加入 ${meta.label} 匹配队列`);
        },
      },
      modeBadge(mode),
      h("span", { class: "queue-mode-label", text: meta.label }),
    );
    queueButtons.set(mode, button);
    queueButtonsWrap.appendChild(button);
  }

  function renderQueue() {
    const queue = store.queue;
    for (const [mode, button] of queueButtons) {
      button.disabled = Boolean(queue);
      button.classList.toggle("is-queued", Boolean(queue && queue.mode === mode));
    }
    if (!queue) {
      queueSlot.replaceChildren(
        h("p", { class: "queue-hint", text: "人数凑齐后自动建房并开始；快速匹配自动准备。" }),
      );
      return;
    }
    queueSlot.replaceChildren(
      h(
        "div",
        { class: "queue-banner" },
        h("span", { class: "queue-pulse", "aria-hidden": "true" }),
        h(
          "div",
          { class: "queue-banner-text" },
          h("p", { class: "queue-banner-title", text: `正在匹配，${modeLabel(queue.mode)}` }),
          h("p", {
            class: "queue-banner-sub",
            text: `队列 ${queue.size}/${queue.needed} 人${queue.position ? `，你的位置 ${queue.position}` : ""}`,
          }),
        ),
        h(
          "button",
          {
            class: "btn btn-ghost btn-sm",
            type: "button",
            onclick: () => {
              ws.leaveQueue();
              toast("已取消匹配");
            },
          },
          "取消",
        ),
      ),
    );
  }
  renderQueue();

  function startPractice(practiceGuessMode) {
    if (!requireSession()) return;
    ws.createRoom("practice", "private", { guessMode: practiceGuessMode });
    toast(`正在创建${guessModeLabel(practiceGuessMode)}练习`);
  }

  const practiceBlock = h(
    "div",
    { class: "practice-block" },
    h("p", { class: "practice-title", text: "个人练习" }),
    h("p", {
      class: "practice-desc",
      text: "单人一张 6 行棋盘，猜中或 6 行用完即结束。练习不计天梯与总统计。",
    }),
    h(
      "div",
      { class: "practice-actions" },
      h(
        "button",
        { class: "btn btn-ghost btn-sm", type: "button", onclick: () => startPractice("standard") },
        "标准练习",
      ),
      h(
        "button",
        { class: "btn btn-ghost btn-sm", type: "button", onclick: () => startPractice("free") },
        "自由练习",
      ),
    ),
  );

  const queueCard = h(
    "section",
    { class: "panel action-card queue-card" },
    h(
      "div",
      { class: "card-head" },
      h("h3", { class: "card-title", text: "快速匹配" }),
      h("p", { class: "card-sub", text: "按模式加入队列，人数达标自动开局。" }),
    ),
    queueButtonsWrap,
    h("p", { class: "queue-team-note", text: "团队战人数不限，请创建房间或输入房号加入。" }),
    queueSlot,
  );

  /* ------------------------------------------------------------------ */
  /* 加入房间                                                            */
  /* ------------------------------------------------------------------ */

  const codeInput = h("input", {
    class: "input code-input",
    type: "text",
    inputmode: "numeric",
    autocomplete: "off",
    spellcheck: "false",
    maxlength: "5",
    placeholder: "5 位房号",
    "aria-label": "房间号",
  });
  codeInput.addEventListener("input", () => {
    const clean = codeInput.value.replace(/\D/g, "").slice(0, 5);
    if (codeInput.value !== clean) codeInput.value = clean;
  });
  const joinForm = h(
    "form",
    { class: "join-form", novalidate: true },
    codeInput,
    h("button", { class: "btn btn-primary", type: "submit" }, "加入"),
  );
  joinForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!requireSession()) return;
    const code = codeInput.value.trim().toUpperCase();
    if (!/^\d{5}$/.test(code)) {
      toast("请输入 5 位数字房号", "warn");
      codeInput.focus();
      return;
    }
    ws.joinRoom(code);
    toast("正在加入房间…");
  });

  const spectateForm = h(
    "form",
    { class: "join-form spectate-form", novalidate: true },
    h("input", {
      class: "input",
      type: "text",
      maxlength: "5",
      placeholder: "房号，观战",
      "aria-label": "观战房间号",
      oninput: (event) => {
        event.target.value = event.target.value.replace(/\D/g, "").slice(0, 5);
      },
    }),
    h(
      "button",
      { class: "btn btn-ghost", type: "submit" },
      icon("eye", 16),
      "观战",
    ),
  );
  spectateForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!requireSession()) return;
    const input = spectateForm.querySelector("input");
    const code = input.value.trim();
    if (!/^\d{5}$/.test(code)) {
      toast("请输入 5 位数字房号", "warn");
      input.focus();
      return;
    }
    ws.spectate(code);
    toast("正在进入观战…");
  });

  const joinCard = h(
    "section",
    { class: "panel action-card join-card" },
    h(
      "div",
      { class: "card-head" },
      h("h3", { class: "card-title", text: "加入房间" }),
      h("p", { class: "card-sub", text: "输入好友分享的 5 位房号。" }),
    ),
    joinForm,
    h("div", { class: "divider" }),
    spectateForm,
  );

  createCard.append(
    h("div", { class: "divider" }),
    h("p", { class: "join-title", text: "加入房间" }),
    joinForm,
    spectateForm,
  );

  const personalCard = h(
    "section",
    { class: "panel action-card personal-card" },
    h(
      "div",
      { class: "card-head" },
      h("h3", { class: "card-title", text: "个人模式" }),
      h("p", { class: "card-sub", text: "单人挑战与练习，不计入排位对局。" }),
    ),
    h(
      "div",
      { class: "practice-block streak-block" },
      h("p", { class: "practice-title", text: "连胜挑战" }),
      h("p", {
        class: "practice-desc",
        text: "连续答对更多成语，刷新个人最高连胜。标准、自由、进阶分别排行。",
      }),
      h(
        "div",
        { class: "streak-actions" },
        h(
          "button",
          { class: "btn btn-primary btn-sm", type: "button", onclick: () => ctx.goStreak("standard") },
          "标准",
        ),
        h(
          "button",
          { class: "btn btn-ghost btn-sm", type: "button", onclick: () => ctx.goStreak("free") },
          "自由",
        ),
        h(
          "button",
          { class: "btn btn-ghost btn-sm", type: "button", onclick: () => ctx.goStreak("advanced") },
          "进阶",
        ),
      ),
    ),
    practiceBlock,
  );

  /* ------------------------------------------------------------------ */
  /* 公开房间列表                                                        */
  /* ------------------------------------------------------------------ */

  const roomsList = h("div", { class: "rooms-list" });
  const roomsMeta = h("p", { class: "card-sub rooms-meta", text: "加载中…" });
  const refreshButton = h(
    "button",
    {
      class: "icon-btn",
      type: "button",
      title: "刷新房间列表",
      "aria-label": "刷新房间列表",
      onclick: () => refreshRooms(),
    },
    icon("refresh", 18),
  );

  const roomsPanel = h(
    "section",
    { class: "panel rooms-panel" },
    h(
      "div",
      { class: "card-head rooms-head" },
      h("div", {}, h("h3", { class: "card-title", text: "公开房间" }), roomsMeta),
      refreshButton,
    ),
    roomsList,
  );

  function renderRooms() {
    refreshButton.classList.toggle("is-spinning", roomsLoading);
    if (roomsLoading && !store.roomsReady) {
      roomsMeta.textContent = "加载中…";
      roomsList.replaceChildren(loadingBlock("正在获取房间列表…"));
      return;
    }
    if (roomsError) {
      roomsMeta.textContent = "获取失败";
      roomsList.replaceChildren(
        h(
          "div",
          { class: "rooms-error" },
          h("p", { class: "empty-title", text: "无法获取房间列表" }),
          h("p", { class: "empty-desc", text: roomsError }),
          h(
            "button",
            { class: "btn btn-ghost btn-sm", type: "button", onclick: () => refreshRooms() },
            "重试",
          ),
        ),
      );
      return;
    }
    const rooms = (Array.isArray(store.rooms) ? store.rooms : []).filter(
      (room) => room && room.mode !== "practice",
    );
    roomsMeta.textContent = rooms.length ? `${rooms.length} 个可加入 / 观战的房间` : "暂无公开房间";
    if (rooms.length === 0) {
      roomsList.replaceChildren(
        emptyState("还没有公开房间", "创建一个公开房间，等待其他玩家加入吧。"),
      );
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const room of rooms) {
      fragment.appendChild(renderRoomCard(room));
    }
    roomsList.replaceChildren(fragment);
  }

  function renderRoomCard(room) {
    const meta = modeMeta(room.mode);
    const capacity = Number(room.capacity) || meta.capacity;
    const playerCount = Number(room.playerCount) || 0;
    const unlimited = Boolean(meta.unlimited) || capacity >= TEAM_UNLIMITED_CAPACITY;
    // 团队战用 99 作为“不限”哨兵：正常对局远达不到，但仍按 99 判断满员。
    const full = playerCount >= capacity;
    const joinable = !full && room.status === "waiting";
    const spectatorFull = Number(room.spectatorCount) >= 20;
    return h(
      "article",
      { class: `room-card ${modeClass(room.mode)}` },
      h(
        "div",
        { class: "room-card-top" },
        modeBadge(room.mode),
        h("span", { class: "room-code", text: room.code }),
        h("span", { class: "guessmode-pill", text: guessModeLabel(room.guessMode) }),
        h("span", { class: `status-pill status-${room.status}`, text: statusLabel(room.status) }),
      ),
      h(
        "div",
        { class: "room-card-body" },
        h(
          "div",
          { class: "room-card-meta" },
          h("span", { text: `房主 ${safeText(room.hostName, "未知")}` }),
          h("span", { class: "meta-sep", text: "，" }),
          h("span", { text: room.round > 0 ? `第 ${room.round} 轮` : "未开始" }),
          h("span", { class: "meta-sep", text: "，" }),
          h("span", { text: `观战 ${room.spectatorCount || 0}` }),
        ),
        h(
          "div",
          { class: "room-card-count" },
          h("strong", { text: `${playerCount}` }),
          h("span", { text: unlimited ? " 人，人数不限" : ` / ${capacity} 人` }),
        ),
      ),
      h(
        "div",
        { class: "room-card-actions" },
        h(
          "button",
          {
            class: "btn btn-primary btn-sm",
            type: "button",
            disabled: !joinable,
            onclick: () => {
              if (!requireSession()) return;
              ws.joinRoom(room.code);
            },
          },
          full ? "已满员" : joinable ? "加入" : "对局中",
        ),
        h(
          "button",
          {
            class: "btn btn-ghost btn-sm",
            type: "button",
            disabled: spectatorFull,
            onclick: () => {
              if (!requireSession()) return;
              ws.spectate(room.code);
            },
          },
          icon("eye", 16),
          spectatorFull ? "观战已满" : "观战",
        ),
      ),
    );
  }

  async function refreshRooms() {
    if (roomsLoading) return;
    roomsLoading = true;
    roomsError = "";
    renderRooms();
    try {
      const rooms = await api.fetchRooms();
      if (destroyed) return;
      store.rooms = Array.isArray(rooms) ? rooms : [];
      store.roomsReady = true;
      renderRooms();
    } catch (error) {
      if (destroyed) return;
      roomsError = error && error.message ? error.message : "网络错误";
      renderRooms();
    } finally {
      roomsLoading = false;
      if (!destroyed) renderRooms();
    }
  }

  /* ------------------------------------------------------------------ */
  /* 会话动作                                                            */
  /* ------------------------------------------------------------------ */

  function requireSession() {
    if (store.user && store.token) return true;
    toast("请先在顶部输入昵称或登录", "warn");
    const input = el.querySelector(".guest-input");
    if (input) {
      input.focus();
      input.scrollIntoView({ behavior: "smooth", block: "center" });
    } else if (store.user === null) {
      ctx.openAuth("login");
    }
    return false;
  }

  const AVATAR_PRESETS = ["🐱", "🐶", "🦊", "🐼", "🐯", "🦁", "🐸", "🐧", "🦄", "🐙", "🌟", "🎯"];

  function openDeleteAccount() {
    let activeModal = null;
    let timer = null;
    const closeActive = () => {
      if (timer) clearInterval(timer);
      timer = null;
      if (activeModal) activeModal.close();
      activeModal = null;
    };
    const stepOne = () => {
      closeActive();
      activeModal = openModal({
        title: "注销账号",
        onClose: () => {
          if (timer) clearInterval(timer);
          timer = null;
          activeModal = null;
        },
        content: h(
          "div",
          { class: "delete-account" },
          h("h3", { class: "profile-title", text: "确定要注销账号吗？" }),
          h("p", { class: "help-paragraph", text: "注销后会删除账号、排行榜记录、战绩、好友关系与设置，且无法恢复。" }),
          h(
            "div",
            { class: "delete-account-actions" },
            h("button", { class: "btn btn-ghost", type: "button", onclick: closeActive }, "取消"),
            h("button", { class: "btn btn-primary", type: "button", onclick: stepTwo }, "继续"),
          ),
        ),
      });
    };
    const stepTwo = () => {
      closeActive();
      const input = h("input", {
        class: "input",
        type: "text",
        placeholder: "输入注销",
        "aria-label": "输入注销确认",
      });
      const next = h("button", { class: "btn btn-primary", type: "button", disabled: true }, "继续");
      input.addEventListener("input", () => {
        next.disabled = input.value.trim() !== "注销";
      });
      next.addEventListener("click", stepThree);
      activeModal = openModal({
        title: "再次确认",
        content: h(
          "div",
          { class: "delete-account" },
          h("h3", { class: "profile-title", text: "输入“注销”继续" }),
          h("p", { class: "help-paragraph", text: "此操作会立即删除账号数据。" }),
          input,
          h(
            "div",
            { class: "delete-account-actions" },
            h("button", { class: "btn btn-ghost", type: "button", onclick: closeActive }, "取消"),
            next,
          ),
        ),
      });
    };
    const stepThree = () => {
      closeActive();
      let remaining = 5;
      const confirm = h(
        "button",
        { class: "btn btn-danger", type: "button", disabled: true },
        `确认注销（${remaining}s）`,
      );
      const tick = () => {
        remaining -= 1;
        if (remaining > 0) {
          confirm.textContent = `确认注销（${remaining}s）`;
          return;
        }
        if (timer) clearInterval(timer);
        timer = null;
        confirm.disabled = false;
        confirm.textContent = "确认注销账号";
      };
      timer = setInterval(tick, 1000);
      confirm.addEventListener("click", async () => {
        confirm.disabled = true;
        try {
          await api.deleteAccount();
          closeActive();
          ctx.accountDeleted();
        } catch (error) {
          toast(error && error.message ? error.message : "注销失败", "error");
          confirm.disabled = false;
        }
      });
      activeModal = openModal({
        title: "最终确认",
        onClose: () => {
          if (timer) clearInterval(timer);
          timer = null;
          activeModal = null;
        },
        content: h(
          "div",
          { class: "delete-account" },
          h("h3", { class: "profile-title", text: "最后一步" }),
          h("p", { class: "help-paragraph", text: "账号注销后无法找回。请等待倒计时结束再确认。" }),
          h(
            "div",
            { class: "delete-account-actions" },
            h("button", { class: "btn btn-ghost", type: "button", onclick: closeActive }, "取消"),
            confirm,
          ),
        ),
      });
    };
    stepOne();
  }

  function openProfileEditor() {
    const user = store.user;
    if (!user || user.isGuest) {
      ctx.openAuth("login");
      return;
    }
    let selectedAvatar = String(user.avatar || AVATAR_PRESETS[0]);
    const nameInput = h("input", {
      class: "input",
      type: "text",
      maxlength: String(NAME_MAX),
      value: String(user.name || ""),
      placeholder: "新的昵称",
      "aria-label": "昵称",
    });
    const errorEl = h("p", { class: "form-error is-hidden", text: "" });
    const avatarPreview = h("div", { class: "avatar-preview" });
    const avatarGrid = h("div", { class: "avatar-picker" });
    const avatarButtons = new Map();
    const previewName = () => safeText(nameInput.value.trim(), safeText(user.name, "玩家"));
    const refreshPreview = () => {
      avatarPreview.replaceChildren(avatarNode(previewName(), selectedAvatar, "avatar-lg"));
    };
    for (const avatar of AVATAR_PRESETS) {
      const button = h(
        "button",
        {
          class: "avatar-option",
          type: "button",
          "aria-label": `选择头像 ${avatar}`,
          onclick: () => {
            selectedAvatar = avatar;
            for (const [key, node] of avatarButtons) {
              node.classList.toggle("is-active", key === avatar);
            }
            errorEl.classList.add("is-hidden");
            refreshPreview();
          },
        },
        avatar,
      );
      avatarButtons.set(avatar, button);
      avatarGrid.appendChild(button);
    }
    avatarButtons.get(selectedAvatar)?.classList.add("is-active");
    const fileInput = h("input", {
      class: "avatar-file-input",
      type: "file",
      accept: "image/png,image/jpeg,image/webp",
      "aria-label": "上传头像图片",
    });
    const uploadLabel = h(
      "label",
      { class: "btn btn-ghost btn-sm avatar-upload" },
      fileInput,
      icon("image", 16),
      "上传图片",
    );
    const fileHint = h("p", {
      class: "profile-hint",
      text: "支持 PNG、JPEG、WebP，原图最大 5MB，自动裁剪为 96x96。",
    });
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files && fileInput.files[0];
      const validation = validateAvatarFile(file);
      if (validation) {
        errorEl.textContent = validation;
        errorEl.classList.remove("is-hidden");
        fileInput.value = "";
        return;
      }
      errorEl.classList.add("is-hidden");
      uploadLabel.classList.add("is-busy");
      fileHint.textContent = "正在处理图片…";
      try {
        const dataUrl = await avatarFileToDataUrl(file);
        selectedAvatar = dataUrl;
        for (const node of avatarButtons.values()) node.classList.remove("is-active");
        refreshPreview();
        fileHint.textContent = "图片已就绪，保存资料后生效。";
      } catch (error) {
        errorEl.textContent = error && error.message ? error.message : "图片处理失败";
        errorEl.classList.remove("is-hidden");
        fileHint.textContent = "支持 PNG、JPEG、WebP，原图最大 5MB，自动裁剪为 96x96。";
      } finally {
        uploadLabel.classList.remove("is-busy");
        fileInput.value = "";
      }
    });
    nameInput.addEventListener("input", refreshPreview);
    refreshPreview();
    const privacyInput = h("input", {
      type: "checkbox",
      class: "profile-privacy-input",
      checked: true,
    });
    const privacyPromise = api.fetchPrivacy().then((settings) => {
      if (settings && typeof settings.showStatsToFriends === "boolean") {
        privacyInput.checked = settings.showStatsToFriends;
      }
    }).catch(() => {});
    const privacyRow = h(
      "label",
      { class: "profile-privacy-row" },
      privacyInput,
      h(
        "span",
        {},
        h("strong", { text: "对好友展示我的数据" }),
        h("span", { class: "profile-hint", text: "关闭后好友无法查看你的天梯统计。" }),
      ),
    );
    const deleteButton = h(
      "button",
      { class: "btn btn-ghost btn-block delete-account-btn", type: "button", onclick: () => openDeleteAccount() },
      "注销账号",
    );
    const saveButton = h(
      "button",
      { class: "btn btn-primary btn-block", type: "button" },
      "保存资料",
    );
    const body = h(
      "div",
      { class: "profile-form" },
      h("h3", { class: "profile-title", text: "修改资料" }),
      h("p", { class: "profile-label", text: "昵称" }),
      nameInput,
      h("p", { class: "profile-label", text: "头像预览" }),
      avatarPreview,
      h("p", { class: "profile-label", text: "选择 emoji 或上传图片" }),
      avatarGrid,
      uploadLabel,
      fileHint,
      h("p", { class: "profile-label", text: "隐私设置" }),
      privacyRow,
      errorEl,
      saveButton,
      h("div", { class: "profile-security" }, h("p", { class: "profile-label", text: "账号安全" }), deleteButton),
    );
    const modal = openModal({ title: "修改资料", content: body });
    saveButton.addEventListener("click", async () => {
      const name = nameInput.value.trim();
      if (!name) {
        errorEl.textContent = "昵称不能为空";
        errorEl.classList.remove("is-hidden");
        return;
      }
      saveButton.disabled = true;
      saveButton.textContent = "保存中…";
      errorEl.classList.add("is-hidden");
      try {
        await privacyPromise;
        const [updated] = await Promise.all([
          api.updateProfile({ name, avatar: selectedAvatar }),
          api.updatePrivacy(privacyInput.checked),
        ]);
        const nextUser = { ...user, ...updated };
        api.saveUser(nextUser);
        store.user = nextUser;
        emit("user", nextUser);
        if (modal) modal.close();
        toast("资料已更新", "success");
      } catch (error) {
        errorEl.textContent = error && error.message ? error.message : "保存失败";
        errorEl.classList.remove("is-hidden");
      } finally {
        saveButton.disabled = false;
        saveButton.textContent = "保存资料";
      }
    });
  }

  function renderUserSlot() {
    const user = store.user;
    if (!user) {
      userSlot.replaceChildren(
        h(
          "button",
          { class: "btn btn-ghost btn-sm", type: "button", onclick: () => ctx.openAuth("login") },
          icon("user", 16),
          "登录 / 注册",
        ),
      );
      return;
    }
    const children = [
      h(
        "div",
        { class: "user-chip" },
        avatarNode(safeText(user.name, "玩家"), user.avatar),
        h(
          "div",
          { class: "user-chip-text" },
          h("span", { class: "user-chip-name", text: safeText(user.name, "玩家") }),
          h("span", { class: "user-chip-tag", text: user.isGuest ? "游客" : "天梯" }),
        ),
      ),
    ];
    if (user.isGuest) {
      children.push(
        h(
          "button",
          {
            class: "btn btn-ghost btn-sm hide-sm",
            type: "button",
            onclick: () => ctx.openAuth("login"),
          },
          "登录",
        ),
      );
    }
    children.push(
      h(
        "button",
        {
          class: "icon-btn",
          type: "button",
          title: "退出登录",
          "aria-label": "退出登录",
          onclick: () => ctx.logout(),
        },
        icon("logout", 17),
      ),
    );
    userSlot.replaceChildren(...children.filter(Boolean));
  }

  function closeOnboarding() {
    if (onboardingModal) {
      onboardingModal.close();
      onboardingModal = null;
    }
  }

  function maybeShowOnboarding() {
    clearTimeout(onboardingTimer);
    onboardingTimer = setTimeout(() => {
      onboardingTimer = null;
      if (destroyed) return;
      const user = store.user;
      if (!user || user.isGuest) {
        onboardingShownUserId = null;
        return;
      }
      if (onboardingShownUserId === user.id) return;
      if (!shouldShowOnboarding(user)) return;
      onboardingShownUserId = user.id;
      const content = h(
        "div",
        { class: "onboarding" },
        h("h3", { class: "profile-title", text: "新手玩法" }),
        h("img", {
          class: "onboarding-image",
          src: "/assets/ciying-gameplay.png",
          alt: "词影玩法示例，四字成语逐位比较笔画",
          width: "448",
          height: "253",
          loading: "eager",
          decoding: "async",
        }),
        h("p", {
          class: "onboarding-lead",
          text: "每轮猜一个四字成语，每次提交四个汉字。",
        }),
        h(
          "ul",
          { class: "onboarding-list" },
          h("li", { text: "最多 6 行猜测机会，逐位比较猜测与答案的笔画。" }),
          h("li", { text: "正确笔画显示绿色，相似笔画显示黑色或灰色，完全正确显示绿底。" }),
          h("li", { text: "前面猜过的线索会保留，帮助你逐步缩小范围。" }),
        ),
        h(
          "div",
          { class: "onboarding-actions" },
          h(
            "button",
            {
              class: "btn btn-primary",
              type: "button",
              onclick: () => closeOnboarding(),
            },
            "关闭",
          ),
          h(
            "button",
            {
              class: "btn btn-ghost",
              type: "button",
              onclick: () => {
                markOnboardingNever(user.id);
                closeOnboarding();
              },
            },
            "不再提示",
          ),
        ),
      );
      onboardingModal = openModal({
        title: "新手玩法",
        content,
        onClose: () => {
          onboardingModal = null;
        },
      });    }, 60);
  }

  async function loadUnreadNotifications() {
    if (!store.user || store.user.isGuest) {
      unreadNotifications = 0;
      unreadBadge.classList.add("is-hidden");
      return;
    }
    try {
      const data = await api.fetchNotifications();
      if (destroyed) return;
      unreadNotifications = Number(data && data.unread) || 0;
      unreadBadge.textContent = unreadNotifications > 99 ? "99+" : String(unreadNotifications);
      unreadBadge.classList.toggle("is-hidden", unreadNotifications === 0);
    } catch {
      /* 通知角标失败不影响大厅 */
    }
  }

  async function loadDailyEntry() {
    try {
      dailyInfo = await api.fetchDaily();
      if (destroyed) return;
      if (dailyInfo && dailyInfo.solved) {
        dailyStatus.textContent = "今日已完成";
      } else {
        dailyStatus.textContent = "今日题目更难";
      }
      const streakDays = Number(dailyInfo && dailyInfo.streakDays) || 0;
      if (streakDays > 0) {
        dailyStreak.textContent = `已连续挑战成功 ${streakDays} 天`;
        dailyStreak.classList.remove("is-hidden");
      } else {
        dailyStreak.classList.add("is-hidden");
      }
    } catch {
      /* 每日入口在接口失败时仍可进入 */
    }
  }

  async function loadSiteStats() {
    try {
      siteStats = await api.fetchSiteStats();
      siteStatsBar.textContent = `已注册 ${siteStats.registeredUsers} 人，当前在线 ${siteStats.onlineUsers} 人`;
    } catch {
      siteStatsBar.textContent = "站点统计暂不可用";
    }
  }

  /* ------------------------------------------------------------------ */
  /* 组装 + 事件                                                         */
  /* ------------------------------------------------------------------ */

  const el = h(
    "div",
    { class: "view lobby-view" },
    header,
    h(
      "main",
      { class: "lobby-main" },
      dailyEntry,
      siteStatsBar,
      hero,
      rejoinSlot,
      h("div", { class: "lobby-grid" }, queueCard, createCard, personalCard),
      roomsPanel,
    ),
  );

  renderSession();
  renderUserSlot();
  maybeShowOnboarding();
  renderRooms();
  renderRejoin();
  rejoinTimer = setInterval(renderRejoin, 1000);
  loadSiteStats();
  loadDailyEntry();
  loadUnreadNotifications();
  siteTimer = setInterval(loadSiteStats, 30000);
  unreadTimer = setInterval(loadUnreadNotifications, 30000);

  unsubscribe.push(
    on("user", () => {
      renderSession();
      renderUserSlot();
      loadDailyEntry();
      loadUnreadNotifications();
      if (!store.user) {
        onboardingShownUserId = null;
        unreadBadge.classList.add("is-hidden");
        closeOnboarding();
        return;
      }
      maybeShowOnboarding();
    }),
    on("connection", (connection) => {
      connSlot.replaceChildren(connectionBadge(connection));
      renderRooms();
    }),
    on("rooms", () => {
      renderRooms();
    }),
    on("queue", () => {
      renderQueue();
    }),
    on("serverError", (message) => {
      const record = loadRejoin();
      if (!record) return;
      if (/房间|不存在|已开始|已满|失效|不在房间/.test(String(message || ""))) {
        clearRejoin();
        renderRejoin();
      }
    }),
  );

  refreshRooms();

  return {
    el,
    destroy() {
      destroyed = true;
      clearTimeout(onboardingTimer);
      onboardingTimer = null;
      closeOnboarding();
      if (rejoinTimer) clearInterval(rejoinTimer);
      rejoinTimer = null;
      if (siteTimer) clearInterval(siteTimer);
      siteTimer = null;
      if (unreadTimer) clearInterval(unreadTimer);
      unreadTimer = null;
      for (const off of unsubscribe) off();
    },
  };
}