/**
 * 房间 / 对局页。
 *
 * - 顶部：模式、房号、状态、猜测模式、轮次/小局、比分、无人作答倒计时；
 * - 玩家列表：昵称、队伍、准备、在线/重连倒计时、房主；
 * - 棋盘：最多 6 行 × 4 列 SVG 格子（CSS 控制尺寸，尽量一屏放下）；
 * - 输入：4 个字符，回车提交，1 秒冷却；标准/自由模式提示不同；
 * - 小局结算页 / 比赛完整结束页；
 * - 观战：只读，不显示输入框；
 * - 断线自动重连由 ws.js 负责，这里展示连接与重连状态。
 */

import * as ws from "../ws.js";
import * as api from "../api.js";
import { store, on, serverNow } from "../store.js";
import {
  MODE_META,
  ROUND_END_DELAY_MS,
  SET_END_DELAY_MS,
  IDLE_ROUND_TIMEOUT_MS,
  GUESS_COOLDOWN_MS,
  CHAT_MAX,
  DUEL_POINTS_TO_WIN,
  DUEL_POINT_LEAD,
  DUEL_DEFAULT_BEST_OF,
  DUEL_BEST_OF_OPTIONS,
  setsToWinForBestOf,
  isDuelBestOf,
  bestOfLabel,
  modeUsesSets,
  isPracticeMode,
  guessModeLabel,
  guessModeHint,
  targetScoreFor,
  FFA_TARGET_SCORE,
  GUESS_MODES,
  DICTIONARY_MODES,
  dictionaryLabel,
  dictionaryHint,
  POINTS_TO_WIN_OPTIONS,
  MIN_POINTS_TO_WIN,
  MAX_POINTS_TO_WIN,
  defaultRoomRules,
  normalizeRoomRules,
  rulesSummary,
  isPointsToWin,
  TEAMS,
} from "../constants.js";
import {
  h,
  icon,
  toast,
  copyText,
  connectionBadge,
  modeBadge,
  modeLabel,
  statusLabel,
  roundResultLabel,
  formatDuration,
  formatDurationMs,
  formatClock,
  avatarNode,
  loadingBlock,
  safeText,
  openModal,
} from "../ui.js";
import { renderBoard } from "../board.js";

const EMPTY_TIME = "--:--";

export function createRoomView(ctx) {
  let room = store.room;
  let chatScope = "room";
  let cooldownUntil = 0;
  let destroyed = false;
  let lastChatSignature = "";
  let loadingHintTimer = null;
  let setSummaryCountdownEl = null;
  let setSummarySignature = "";
  let matchOverlaySignature = "";
  let rulesOverlayOpen = false;
  let rulesAutoProposalId = "";
  let pendingGuess = "";
  let suggestionText = "";
  let lastRoundToken = roundTokenOf(room);
  const friendIds = new Set();
  const outgoingFriendIds = new Set();
  const incomingFriendIds = new Set();

  function roundTokenOf(state) {
    if (!state || !state.round) return "";
    return `${state.round.index ?? ""}:${state.round.startedAt ?? ""}`;
  }

  const rejoinCountdownEls = new Map();
  const unsubscribe = [];

  /* ------------------------------------------------------------------ */
  /* 规则 / 比分辅助                                                     */
  /* ------------------------------------------------------------------ */

  function isSetMode(state = room) {
    return Boolean(state && modeUsesSets(state.mode));
  }

  function isPractice(state = room) {
    return Boolean(state && isPracticeMode(state.mode));
  }

  function setMatchInfo(state = room) {
    const match = (state && state.match) || {};
    const players = Array.isArray(state && state.players) ? state.players : [];
    const bestOf = isDuelBestOf(match.bestOf) ? match.bestOf : DUEL_DEFAULT_BEST_OF;
    const setsToWin = Number(match.setsToWin) || setsToWinForBestOf(bestOf);
    const pointsToWin = Number(match.pointsToWin) || DUEL_POINTS_TO_WIN;
    const pointLead = Number.isFinite(match.pointLead) ? match.pointLead : DUEL_POINT_LEAD;
    const setNumber = Number(match.setNumber) || 1;
    const setWins =
      match.setWins && typeof match.setWins === "object" ? match.setWins : Object.create(null);
    const team = (state && state.mode) === "team2v2";
    const setScoreA = team
      ? Number(setWins.A) || 0
      : Number(setWins[players[0] && players[0].id]) || 0;
    const setScoreB = team
      ? Number(setWins.B) || 0
      : Number(setWins[players[1] && players[1].id]) || 0;
    let scoreA = setScoreA;
    let scoreB = setScoreB;
    const forfeit =
      match.forfeitById !== null && match.forfeitById !== undefined
        ? true
        : Boolean(match.forfeitTeam);
    if (forfeit && !match.isDraw && scoreA === 0 && scoreB === 0) {
      if (team) {
        const winnerTeam = match.forfeitTeam || match.winnerTeam;
        scoreA = winnerTeam === "A" ? 1 : 0;
        scoreB = winnerTeam === "B" ? 1 : 0;
      } else if (match.winnerId && players.length > 0) {
        scoreA = players[0].id === match.winnerId ? 1 : 0;
        scoreB = scoreA === 1 ? 0 : 1;
      } else {
        scoreA = 1;
        scoreB = 0;
      }
    }
    return {
      match,
      players,
      team,
      bestOf,
      setsToWin,
      pointsToWin,
      pointLead,
      setNumber,
      setWins,
      setScoreA,
      setScoreB,
      bigScore: `${scoreA}:${scoreB}`,
    };
  }

  function playerSetWins(playerId) {
    const info = setMatchInfo();
    return Number(info.setWins[playerId]) || 0;
  }

  /** 玩家卡上的“大比分”：团队战取队伍大比分，1v1 取个人大比分。 */
  function bigScoreForPlayer(player) {
    const info = setMatchInfo();
    if (info.team) return Number(info.setWins[player && player.team]) || 0;
    return Number(info.setWins[player && player.id]) || 0;
  }

  function setEndInfo(state = room) {
    if (!state || !modeUsesSets(state.mode) || !state.round || state.round.status !== "ended") {
      return null;
    }
    const info = setMatchInfo(state);
    const players = info.players;
    let winnerId = state.round.setWinnerId || null;
    let winnerTeam = state.round.setWinnerTeam || null;

    // 兼容旧服务端/早期 mock：没有 setWinner 字段时用比分差回推。
    if (!winnerId && !winnerTeam && state.round.result === "solved") {
      if (!info.team) {
        const winner = players.find((player) => {
          if (player.id !== state.round.winnerId) return false;
          const bestOther = players
            .filter((item) => item.id !== player.id)
            .reduce((max, item) => Math.max(max, Number(item.score) || 0), 0);
          return (
            Number(player.score) >= info.pointsToWin &&
            Number(player.score) - bestOther >= info.pointLead
          );
        });
        if (winner) winnerId = winner.id;
      } else {
        for (const team of TEAMS) {
          const other = team === "A" ? "B" : "A";
          const score = Number(state.teamScores && state.teamScores[team]) || 0;
          const otherScore = Number(state.teamScores && state.teamScores[other]) || 0;
          if (score >= info.pointsToWin && score - otherScore >= info.pointLead) {
            winnerTeam = team;
            break;
          }
        }
      }
    }
    if (!winnerId && !winnerTeam) return null;

    const teams = state.teamScores || { A: 0, B: 0 };
    if (winnerId) {
      const winner = players.find((player) => player.id === winnerId);
      const opponent = players.find((player) => player.id !== winnerId);
      const score = Number(winner && winner.score) || 0;
      const otherScore = Number(opponent && opponent.score) || 0;
      return {
        kind: "player",
        winnerId,
        winnerName: safeText((winner && winner.name) || state.round.winnerName, "玩家"),
        winnerLabel: safeText((winner && winner.name) || state.round.winnerName, "玩家"),
        setScoreText: `${score}:${otherScore}`,
        bigScoreText: `${Number(info.setWins[winnerId]) || 0}:${
          Number(info.setWins[opponent && opponent.id]) || 0
        }`,
        bigScore: info.bigScore,
      };
    }
    const winningScore = Number(teams[winnerTeam]) || 0;
    const losingScore = Number(teams[winnerTeam === "A" ? "B" : "A"]) || 0;
    return {
      kind: "team",
      winnerTeam,
      winnerName: `队伍 ${winnerTeam}`,
      winnerLabel: `队伍 ${winnerTeam}`,
      setScoreText: `${winningScore}:${losingScore}`,
      bigScoreText: `${Number(info.setWins[winnerTeam]) || 0}:${
        Number(info.setWins[winnerTeam === "A" ? "B" : "A"]) || 0
      }`,
      bigScore: info.bigScore,
    };
  }

  function forfeitText(state = room) {
    const match = (state && state.match) || {};
    if (!match.forfeitById && !match.forfeitTeam) return "";
    if (state.viewerRole === "spectator") {
      return "有玩家/队伍离开超时，比赛已判胜";
    }
    if (match.forfeitTeam) {
      const me = state.players.find((player) => player.id === state.viewerId);
      if (me && me.team === match.forfeitTeam) return "对方队伍离开超时，判胜";
      return "己方队伍离开超时，判负";
    }
    if (match.forfeitById) {
      if (match.forfeitById === state.viewerId) return "你离开超时，本场判负";
      return "对方离开超时，判胜";
    }
    return "";
  }

  function matchResultText(state) {
    const match = (state && state.match) || {};
    const winnerName = safeText(match.winnerName, "");
    if (modeUsesSets(state && state.mode)) {
      const info = setMatchInfo(state);
      if (match.isDraw) return `大比分 ${info.bigScore}，平局`;
      if (winnerName) return `大比分 ${info.bigScore}，${winnerName} 获胜`;
      if (match.winnerTeam) return `大比分 ${info.bigScore}，队伍 ${match.winnerTeam} 获胜`;
      return `大比分 ${info.bigScore}，比赛结束`;
    }
    if (match.isDraw) return "平局";
    if (winnerName) return `${winnerName} 获胜`;
    if (match.winnerTeam) return `队伍 ${match.winnerTeam} 获胜`;
    return "比赛结束";
  }

  function setResultLine(state = room) {
    const round = state && state.round;
    if (!round || round.status !== "ended") return "";
    if (round.result === "solved") {
      const winnerName = safeText(round.winnerName, "");
      return winnerName ? `${winnerName} 猜中` : "猜中";
    }
    if (round.result === "exhausted") {
      if (round.awardedTeam) return `第 6 行仍未猜中，队伍 ${round.awardedTeam} 得 1 分`;
      if (state.mode === "ffa3") return "第 6 行仍未猜中，其他玩家各得 1 分";
      return "第 6 行仍未猜中，对方得 1 分";
    }
    if (round.result === "timeout") {
      return `${Math.round(IDLE_ROUND_TIMEOUT_MS / 1000)} 秒内无人作答，本轮流局`;
    }
    return "";
  }

  function ratingDeltaOf(player) {
    const deltas = room && room.match && room.match.ratingDeltas;
    if (!deltas || typeof deltas !== "object" || !player) return null;
    if (!Object.prototype.hasOwnProperty.call(deltas, player.id)) return null;
    const raw = deltas[player.id];
    if (raw === null || raw === undefined || raw === "") return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  }

  function ratingDeltaNode(player) {
    const value = ratingDeltaOf(player);
    if (value === null) {
      return h("span", { class: "match-end-rating is-empty", text: "未计分" });
    }
    return h("span", {
      class: `match-end-rating ${value > 0 ? "up" : value < 0 ? "down" : "flat"}`,
      text: `天梯 ${value > 0 ? "+" : ""}${value}`,
    });
  }

  function ownHighlights(me) {
    const all = room && room.match && room.match.highlights;
    if (!me || !all || typeof all !== "object") return [];
    const players = Array.isArray(room.players) ? room.players : [];
    const pool = [];
    const add = (playerId) => {
      const list = Array.isArray(all[playerId]) ? all[playerId] : [];
      for (const item of list) {
        if (item && typeof item.word === "string") {
          pool.push({ word: safeText(item.word, ""), guesses: Number(item.guesses) || 999 });
        }
      }
    };
    add(me.id);
    if (room.mode === "team2v2" && me.team) {
      for (const player of players) {
        if (player.team === me.team && player.id !== me.id) add(player.id);
      }
    }
    const seen = new Set();
    return pool
      .filter((item) => item.word && !seen.has(item.word) && seen.add(item.word))
      .sort((left, right) => left.guesses - right.guesses)
      .slice(0, 3);
  }

  function matchShareText(me) {
    const players = Array.isArray(room.players) ? room.players : [];
    const names = players.map((player) => safeText(player.name, "未知玩家")).join("、");
    let score = "";
    if (isSetMode()) {
      score = setMatchInfo().bigScore;
    } else if (room.mode === "ffa3") {
      score = players
        .slice()
        .sort((left, right) => (Number(right.score) || 0) - (Number(left.score) || 0))
        .map((player) => `${safeText(player.name, "玩家")} ${Number(player.score) || 0} 分`)
        .join("，");
    }
    const highlights = ownHighlights(me);
    const lines = [
      "🎮 词影竞技场 对局战报",
      `模式：${modeLabel(room.mode)}`,
      `玩家：${names}`,
    ];
    if (score) lines.push(`最终比分：${score}`);
    const setHistory = Array.isArray(room.match && room.match.setHistory)
      ? room.match.setHistory
      : [];
    const setScores = setHistory
      .map((entry) => {
        if (!entry) return "";
        if (room.mode === "team2v2") {
          const teamScores = entry.teamScores || {};
          return `A${Number(teamScores.A) || 0}:${Number(teamScores.B) || 0}B`;
        }
        const scores = entry.scores || {};
        return Object.values(scores)
          .map((value) => Number(value) || 0)
          .join(":");
      })
      .filter((item) => item && item !== "0:0");
    if (setScores.length > 0) lines.push(`小局：${setScores.join("、")}`);
    if (highlights.length > 0) {
      lines.push(
        `高光成语：${highlights
          .map((item) => `${item.word}（${item.guesses} 次）`)
          .join(" ")}`,
      );
    }
    lines.push("来词影竞技场和我再战一局：");
    lines.push(`${location.origin}/`);
    return lines.join("\n");
  }

  async function shareMatch(me) {
    const ok = await copyText(matchShareText(me));
    toast(ok ? "对局战绩已复制" : "复制失败，请手动选择文本", ok ? "success" : "warn");
  }

  /* ------------------------------------------------------------------ */
  /* 骨架                                                                */
  /* ------------------------------------------------------------------ */

  const backButton = h(
    "button",
    {
      class: "btn btn-ghost btn-sm room-back",
      type: "button",
      onclick: () => ctx.leaveRoom(),
    },
    icon("arrowLeft", 17),
    "离开",
  );

  const modeSlot = h("div", { class: "room-mode-slot" });
  const codeSlot = h("div", { class: "room-code-slot" });
  const statusSlot = h("div", { class: "room-status-slot" });
  const guessModeSlot = h("div", { class: "room-guessmode-slot" });
  const connSlot = h("div", { class: "header-conn" }, connectionBadge(store.connection));
  const roomHelpButton = h(
    "button",
    { class: "btn btn-ghost btn-sm", type: "button", onclick: () => ctx.goHelp() },
    icon("help", 16),
    h("span", { class: "btn-label", text: "帮助" }),
  );
  const roomChangelogButton = h(
    "button",
    { class: "btn btn-ghost btn-sm", type: "button", onclick: () => ctx.goChangelog() },
    icon("clock", 16),
    h("span", { class: "btn-label", text: "更新日志" }),
  );
  const roomInviteFriendsButton = h(
    "button",
    {
      class: "btn btn-ghost btn-sm",
      type: "button",
      onclick: () => openInviteFriends(),
    },
    icon("users", 16),
    h("span", { class: "btn-label", text: "邀请好友" }),
  );
  const netBanner = h("div", { class: "net-banner", role: "status" });
  const netBannerText = h("span", {});
  const netRetry = h(
    "button",
    { class: "btn btn-ghost btn-sm", type: "button", onclick: () => ws.forceReconnect() },
    "立即重试",
  );
  netBanner.append(netBannerText, netRetry);

  const header = h(
    "header",
    { class: "room-header" },
    h(
      "div",
      { class: "room-header-left" },
      backButton,
      modeSlot,
      codeSlot,
      statusSlot,
      guessModeSlot,
    ),
    h("div", { class: "room-header-right" }, roomInviteFriendsButton, roomChangelogButton, roomHelpButton, connSlot),
  );

  /* 计分板 */
  const roundKicker = h("p", { class: "scoreboard-kicker", text: "等待开始" });
  const roundTitle = h("h2", { class: "scoreboard-title", text: "房间" });
  const rulesLine = h("p", { class: "scoreboard-rules", text: "" });
  const scoresSlot = h("div", { class: "scoreboard-scores" });
  const timerValue = h("div", { class: "timer-value", text: EMPTY_TIME });
  const timerLabel = h("div", { class: "timer-label", text: "倒计时" });
  const timerBox = h("div", { class: "timer-box" }, timerLabel, timerValue);
  const scoreboard = h(
    "section",
    { class: "panel room-scoreboard" },
    h("div", { class: "scoreboard-round" }, roundKicker, roundTitle, rulesLine),
    scoresSlot,
    timerBox,
  );

  /* 当前小局比分条：所有非练习模式可见 */
  const scoreBar = h("div", {
    class: "score-bar",
    role: "group",
    "aria-label": "当前小局比分",
  });
  const matchPointBadge = h("span", {
    class: "match-point-badge is-hidden",
    text: "赛点",
  });
  const scoreBarShell = h(
    "div",
    { class: "score-bar-shell" },
    scoreBar,
    matchPointBadge,
  );

  /* 操作栏 */
  const actionHint = h("p", { class: "action-hint", text: "" });
  const actionButtons = h("div", { class: "action-buttons" });
  const actionBar = h("div", { class: "room-actionbar panel" }, actionHint, actionButtons);

  /* 玩家列表 */
  const playersTitle = h("h3", { class: "panel-title", text: "玩家" });
  const playersList = h("div", { class: "players-list" });
  const spectatorsLine = h("div", { class: "spectators-line" });
  const recentRoundsList = h("div", { class: "recent-rounds-list" });
  const recentRoundsPanel = h(
    "section",
    { class: "recent-rounds-panel is-hidden" },
    h("div", { class: "recent-rounds-head" }, h("span", { class: "recent-rounds-title", text: "最近 5 轮" })),
    recentRoundsList,
  );
  const playersPanel = h(
    "aside",
    { class: "panel players-panel", "aria-label": "玩家列表" },
    h("div", { class: "panel-head" }, playersTitle),
    playersList,
    spectatorsLine,
    recentRoundsPanel,
  );

  /* 棋盘 */
  const boardTitle = h("h3", { class: "panel-title", text: "棋盘" });
  const boardHint = h("p", {
    class: "panel-sub board-sub",
    text: "猜错消耗一行；第 6 行仍未猜中对方得分；1 分钟内无人作答本轮结束。",
  });
  const boardEl = h("div", { class: "board", role: "table", "aria-label": "猜测棋盘" });
  const answerSlot = h("div", { class: "answer-slot" });
  const guessInput = h("input", {
    class: "input guess-input",
    type: "text",
    inputmode: "text",
    autocomplete: "off",
    spellcheck: "false",
    placeholder: "输入四字成语",
    "aria-label": "输入四字成语",
  });
  const guessButton = h("button", { class: "btn btn-primary guess-submit", type: "submit" }, "提交");
  const cooldownBar = h("span", { class: "cooldown-bar" });
  const cooldownTrack = h("div", { class: "cooldown-track", "aria-hidden": "true" }, cooldownBar);
  const guessHint = h("p", { class: "guess-hint", text: "回车提交，提交间隔 1 秒" });
  const guessSuggestion = h("button", {
    class: "guess-suggestion is-hidden",
    type: "button",
    text: "",
  });
  guessSuggestion.addEventListener("click", () => {
    if (!suggestionText) return;
    guessInput.value = suggestionText;
    guessInput.focus();
    guessSuggestion.classList.add("is-hidden");
  });
  const guessForm = h(
    "form",
    { class: "guess-form", novalidate: true },
    h("div", { class: "guess-row" }, guessInput, guessButton),
    cooldownTrack,
    guessHint,
    guessSuggestion,
  );
  const guessArea = h("div", { class: "guess-area" }, guessForm);
  const spectatorNote = h(
    "p",
    { class: "spectator-note" },
    icon("eye", 16),
    "你正在观战，无法提交猜测。",
  );

  const practiceTimerEl = h("span", { class: "practice-bar-timer", text: EMPTY_TIME });
  const practiceBar = h(
    "div",
    { class: "practice-bar is-hidden" },
    h("span", { class: "practice-bar-label", text: "个人练习" }),
    h("span", { class: "practice-bar-hint", text: "猜中或 6 行用完即结束" }),
    practiceTimerEl,
  );
  const practiceResult = h("div", { class: "practice-result is-hidden" });

  const boardPanel = h(
    "section",
    { class: "panel board-panel" },
    practiceBar,
    h("div", { class: "panel-head board-head" }, h("div", {}, boardTitle, boardHint)),
    practiceResult,
    answerSlot,
    boardEl,
    guessArea,
    spectatorNote,
  );

  /* 聊天 */
  const chatTabs = h("div", { class: "chat-tabs" });
  const roomTab = h(
    "button",
    { class: "chat-tab is-active", type: "button", onclick: () => switchChatScope("room") },
    "房间",
  );
  const teamTab = h(
    "button",
    { class: "chat-tab", type: "button", onclick: () => switchChatScope("team") },
    "队伍",
  );
  chatTabs.append(roomTab, teamTab);

  const chatList = h("div", { class: "chat-list", role: "log", "aria-live": "polite" });
  const chatEmpty = h("p", { class: "chat-empty", text: "还没有消息，打个招呼吧。" });
  const chatInput = h("input", {
    class: "input chat-input",
    type: "text",
    maxlength: String(CHAT_MAX),
    autocomplete: "off",
    placeholder: "发送消息…",
    "aria-label": "聊天消息",
  });
  const chatForm = h(
    "form",
    { class: "chat-form", novalidate: true },
    chatInput,
    h(
      "button",
      { class: "btn btn-primary btn-icon", type: "submit", "aria-label": "发送" },
      icon("send", 16),
    ),
  );
  const chatSpectatorNote = h("p", { class: "chat-readonly", text: "观战中，聊天为只读。" });
  const chatPanel = h(
    "aside",
    { class: "panel chat-panel", "aria-label": "聊天" },
    h("div", { class: "panel-head chat-head" }, h("h3", { class: "panel-title", text: "聊天" })),
    chatTabs,
    chatList,
    chatEmpty,
    chatForm,
    chatSpectatorNote,
  );

  const roomLayout = h("div", { class: "room-layout" }, playersPanel, boardPanel, chatPanel);

  const loadingSlot = h("div", { class: "room-loading" });
  const content = h(
    "div",
    { class: "room-content" },
    netBanner,
    scoreBarShell,
    scoreboard,
    actionBar,
    roomLayout,
  );

  /* 小局结算遮罩 */
  const setSummaryBody = h("div", { class: "set-summary-body" });
  const setSummaryOverlay = h(
    "div",
    { class: "set-summary-overlay is-hidden", role: "dialog", "aria-label": "小局结算" },
    h(
      "div",
      { class: "set-summary-panel" },
      h("p", { class: "set-summary-kicker", text: "小局结算" }),
      setSummaryBody,
      h(
        "button",
        {
          class: "btn btn-ghost btn-sm set-summary-leave",
          type: "button",
          onclick: () => ctx.leaveRoom(),
        },
        "离开房间",
      ),
    ),
  );

  /* 比赛结束页 */
  const matchOverlayBody = h("div", { class: "match-overlay-body" });
  const matchOverlay = h(
    "div",
    { class: "match-overlay is-hidden", role: "dialog", "aria-label": "比赛结束" },
    h("div", { class: "match-overlay-panel" }, matchOverlayBody),
  );

  /* 规则协商弹框 */
  const rulesOverlayBody = h("div", { class: "rules-overlay-body" });
  const rulesOverlay = h(
    "div",
    { class: "rules-overlay is-hidden", role: "dialog", "aria-label": "规则协商" },
    h(
      "div",
      { class: "rules-panel panel" },
      h(
        "div",
        { class: "rules-panel-head" },
        h("h2", { class: "rules-panel-title", text: "规则协商" }),
        h(
          "button",
          {
            class: "icon-btn",
            type: "button",
            "aria-label": "关闭规则协商",
            onclick: () => {
              rulesOverlayOpen = false;
              rulesOverlay.classList.add("is-hidden");
            },
          },
          icon("x", 18),
        ),
      ),
      rulesOverlayBody,
    ),
  );

  const updateRulesBody = h("div", { class: "rules-overlay-body" });
  const updateRulesOverlay = h(
    "div",
    { class: "rules-overlay is-hidden", role: "dialog", "aria-label": "修改房间规则" },
    h(
      "div",
      { class: "rules-panel panel" },
      h(
        "div",
        { class: "rules-panel-head" },
        h("h2", { class: "rules-panel-title", text: "修改规则" }),
        h(
          "button",
          {
            class: "icon-btn",
            type: "button",
            "aria-label": "关闭修改规则",
            onclick: () => updateRulesOverlay.classList.add("is-hidden"),
          },
          icon("x", 18),
        ),
      ),
      updateRulesBody,
    ),
  );

  const el = h(
    "div",
    { class: "view room-view" },
    header,
    content,
    loadingSlot,
    setSummaryOverlay,
    matchOverlay,
    rulesOverlay,
    updateRulesOverlay,
  );

  /* ------------------------------------------------------------------ */
  /* 规则协商                                                            */
  /* ------------------------------------------------------------------ */

  function roomRules() {
    const match = room && room.match ? room.match : {};
    const source =
      room && room.rules
        ? room.rules
        : {
            bestOf: match.bestOf,
            guessMode: room && room.guessMode,
            dictionary: room && room.dictionary,
            pointsToWin: match.pointsToWin,
          };
    return normalizeRoomRules(source, room ? room.mode : "duel");
  }

  function rulesEditor(initialRules, compact = false, allowBestOf = false) {
    const state = normalizeRoomRules(initialRules, room.mode);
    const guessPicker = h("div", { class: "bestof-picker rules-choice-row" });
    const guessButtons = new Map();
    for (const value of GUESS_MODES) {
      const button = h(
        "button",
        {
          class: "bestof-option",
          type: "button",
          onclick: () => {
            state.guessMode = value;
            sync();
          },
        },
        guessModeLabel(value),
      );
      guessButtons.set(value, button);
      guessPicker.appendChild(button);
    }
    const dictionaryPicker = h("div", { class: "bestof-picker rules-choice-row" });
    const dictionaryButtons = new Map();
    for (const value of DICTIONARY_MODES) {
      const button = h(
        "button",
        {
          class: "bestof-option",
          type: "button",
          onclick: () => {
            state.dictionary = value;
            sync();
          },
        },
        dictionaryLabel(value),
      );
      dictionaryButtons.set(value, button);
      dictionaryPicker.appendChild(button);
    }
    const pointsPicker = h("div", { class: "bestof-picker rules-choice-row" });
    const pointButtons = new Map();
    const bestOfPicker = h("div", { class: "bestof-picker rules-choice-row" });
    const bestOfButtons = new Map();
    if (allowBestOf && modeUsesSets(room.mode)) {
      for (const value of DUEL_BEST_OF_OPTIONS) {
        const button = h(
          "button",
          {
            class: "bestof-option",
            type: "button",
            onclick: () => {
              state.bestOf = value;
              sync();
            },
          },
          String(value),
        );
        bestOfButtons.set(value, button);
        bestOfPicker.appendChild(button);
      }
    }
    for (const value of POINTS_TO_WIN_OPTIONS) {
      const button = h(
        "button",
        {
          class: "bestof-option",
          type: "button",
          onclick: () => {
            state.pointsToWin = value;
            pointsInput.value = String(value);
            sync();
          },
        },
        String(value),
      );
      pointButtons.set(value, button);
      pointsPicker.appendChild(button);
    }
    const pointsInput = h("input", {
      class: "input rules-points-input",
      type: "number",
      min: String(MIN_POINTS_TO_WIN),
      max: String(MAX_POINTS_TO_WIN),
      value: String(state.pointsToWin),
      "aria-label": "自定义目标分",
    });
    pointsInput.addEventListener("input", () => {
      const value = Number(pointsInput.value);
      if (isPointsToWin(value)) {
        state.pointsToWin = value;
        sync();
      }
    });
    const summary = h("p", { class: "rules-editor-summary", text: "" });
    const hint = h("p", { class: "rules-editor-hint", text: dictionaryHint(state.dictionary) });
    const bestOfText = modeUsesSets(room.mode) ? bestOfLabel(1) : "本模式无小局";
    const el = h(
      "div",
      { class: `rules-editor${compact ? " is-compact" : ""}` },
      h(
        "div",
        { class: "rules-field" },
        h("span", { class: "rules-field-label", text: "猜词模式" }),
        guessPicker,
      ),
      h(
        "div",
        { class: "rules-field" },
        h("span", { class: "rules-field-label", text: "词库" }),
        dictionaryPicker,
      ),
      allowBestOf && modeUsesSets(room.mode)
        ? h(
            "div",
            { class: "rules-field" },
            h("span", { class: "rules-field-label", text: "大比分" }),
            bestOfPicker,
          )
        : null,
      h(
        "div",
        { class: "rules-field" },
        h("span", { class: "rules-field-label", text: "每小局目标分" }),
        pointsPicker,
        pointsInput,
      ),
      allowBestOf ? null : h("p", { class: "rules-editor-fixed", text: `快速匹配固定 ${bestOfText}` }),
      hint,
      summary,
    );

    function sync() {
      for (const [value, button] of guessButtons) {
        button.classList.toggle("is-active", state.guessMode === value);
      }
      for (const [value, button] of dictionaryButtons) {
        button.classList.toggle("is-active", state.dictionary === value);
      }
      for (const [value, button] of pointButtons) {
        button.classList.toggle("is-active", state.pointsToWin === value);
      }
      for (const [value, button] of bestOfButtons) {
        button.classList.toggle("is-active", state.bestOf === value);
      }
      hint.textContent = dictionaryHint(state.dictionary);
      summary.textContent = rulesSummary(state, room.mode);
    }
    sync();

    return {
      el,
      getRules() {
        if (!isPointsToWin(pointsInput.value)) {
          toast(`目标分需要在 ${MIN_POINTS_TO_WIN} 到 ${MAX_POINTS_TO_WIN} 之间`, "warn");
          pointsInput.focus();
          return null;
        }
        state.pointsToWin = Number(pointsInput.value);
        return normalizeRoomRules(state, room.mode);
      },
    };
  }

  function renderRulesOverlay() {
    if (!room || isPractice() || !room.requiresAgreement || room.viewerRole !== "player") {
      rulesOverlay.classList.add("is-hidden");
      rulesOverlayOpen = false;
      return;
    }
    if (room.rulesAgreed) {
      rulesOverlay.classList.add("is-hidden");
      rulesOverlayOpen = false;
      rulesAutoProposalId = "";
      return;
    }
    const me = room.players.find((player) => player.id === room.viewerId);
    const isHost = Boolean(me && me.isHost);
    const proposal = room.proposal;
    const autoKey = proposal ? `${room.code}:${proposal.id}` : isHost ? `${room.code}:host` : "";
    if (!rulesOverlayOpen && autoKey && autoKey !== rulesAutoProposalId) {
      rulesOverlayOpen = true;
      rulesAutoProposalId = autoKey;
    }
    if (!rulesOverlayOpen) {
      rulesOverlay.classList.add("is-hidden");
      return;
    }
    rulesOverlay.classList.remove("is-hidden");
    const currentRules = proposal ? proposal.rules : room.rules || roomRules();
    const editor = rulesEditor(currentRules, true);
    const actions = [];
    const isProposer = Boolean(proposal && proposal.proposerId === room.viewerId);
    if (proposal && !isProposer) {
      actions.push(
        h(
          "button",
          {
            class: "btn btn-primary btn-sm",
            type: "button",
            onclick: () => ws.acceptRules(proposal.id),
          },
          "同意此规则",
        ),
      );
      actions.push(
        h(
          "button",
          {
            class: "btn btn-ghost btn-sm",
            type: "button",
            onclick: () => {
              const rules = editor.getRules();
              if (rules) ws.counterRules(rules);
            },
          },
          "修改并重新提案",
        ),
      );
    } else if (!proposal && isHost) {
      actions.push(
        h(
          "button",
          {
            class: "btn btn-primary btn-sm",
            type: "button",
            onclick: () => {
              const rules = editor.getRules();
              if (rules) ws.proposeRules(rules);
            },
          },
          "提交规则提案",
        ),
      );
    }
    let statusText = "等待房主发起规则协商。";
    if (proposal) {
      statusText =
        proposal.proposerId === room.viewerId
          ? "你已提交规则提案，等待其他玩家确认。"
          : `${safeText(proposal.proposerName, "对方")} 提交了规则提案，请确认或修改。`;
    }
    const showEditor = Boolean((!proposal && isHost) || (proposal && !isProposer));
    const rulesBody = [
      h("p", { class: "rules-status", text: statusText }),
      h(
        "div",
        { class: "rules-current" },
        h("span", { class: "rules-current-label", text: "当前规则" }),
        h("strong", { class: "rules-current-value", text: rulesSummary(currentRules, room.mode) }),
      ),
    ];
    if (showEditor) {
      rulesBody.push(editor.el);
      if (actions.length > 0) rulesBody.push(h("div", { class: "rules-actions" }, ...actions));
    }
    rulesBody.push(
      h("p", {
        class: "rules-note",
        text: "所有玩家确认后，房主才能开始比赛。快速匹配固定一局定胜负。",
      }),
    );
    rulesOverlayBody.replaceChildren(...rulesBody.filter(Boolean));
  }

  function openRulesOverlay() {
    rulesOverlayOpen = true;
    renderRulesOverlay();
  }

  function openUpdateRules() {
    if (!room || isPractice() || room.viewerRole !== "player") return;
    const me = room.players.find((player) => player.id === room.viewerId);
    if (!me || !me.isHost || room.status !== "waiting" || room.requiresAgreement) return;
    const editor = rulesEditor(roomRules(), true, true);
    updateRulesBody.replaceChildren(
      h("p", {
        class: "rules-status",
        text: "修改仅影响尚未开始的房间，保存后所有玩家实时同步。",
      }),
      editor.el,
      h(
        "div",
        { class: "rules-actions" },
        h(
          "button",
          { class: "btn btn-ghost btn-sm", type: "button", onclick: () => updateRulesOverlay.classList.add("is-hidden") },
          "取消",
        ),
        h(
          "button",
          {
            class: "btn btn-primary btn-sm",
            type: "button",
            onclick: () => {
              const rules = editor.getRules();
              if (!rules) return;
              ws.updateRules(rules);
              updateRulesOverlay.classList.add("is-hidden");
              toast("房间规则已更新", "success");
            },
          },
          "保存规则",
        ),
      ),
    );
    updateRulesOverlay.classList.remove("is-hidden");
  }

  function renderRecentRounds() {
    const rounds = Array.isArray(room && room.recentRounds) ? room.recentRounds.slice(-5) : [];
    if (rounds.length === 0) {
      recentRoundsPanel.classList.add("is-hidden");
      recentRoundsList.replaceChildren();
      return;
    }
    recentRoundsPanel.classList.remove("is-hidden");
    recentRoundsList.replaceChildren(
      ...rounds
        .slice()
        .reverse()
        .map((entry) => {
          entry = entry || {};
          let resultText = "未结束";
          if (entry.result === "solved") {
            resultText = `${safeText(entry.winnerName, "玩家")} 猜中`;
          } else if (entry.result === "exhausted") {
            resultText = entry.awardedTeam
              ? `${safeText(entry.awardedTeam, "对方")} 队得分`
              : entry.awardedTo && entry.awardedTo.length > 0
                ? "对方得分"
                : "流局";
          } else if (entry.result === "timeout") resultText = "无人作答";
          if (entry.setWinnerTeam) resultText += `，${safeText(entry.setWinnerTeam, "?")} 队拿下小局`;
          else if (entry.setWinnerId) resultText += "，小局结束";
          const explanation = safeText(entry.explanation, "");
          const explanationNode = explanation
            ? Array.from(explanation).length > 32
              ? (() => {
                  const textNode = h("span", {
                    class: "recent-round-explanation-text",
                    text: explanation,
                  });
                  const labelNode = h("span", {
                    class: "recent-round-expand-label",
                    text: "展开",
                  });
                  const node = h(
                    "button",
                    {
                      class: "recent-round-explanation",
                      type: "button",
                      title: "点击展开释义",
                      "aria-expanded": "false",
                      onclick: () => {
                        const expanded = node.classList.toggle("is-expanded");
                        node.setAttribute("aria-expanded", String(expanded));
                        node.title = expanded ? "点击收起释义" : "点击展开释义";
                        labelNode.textContent = expanded ? "收起" : "展开";
                      },
                    },
                    textNode,
                    labelNode,
                  );
                  return node;
                })()
              : h("span", { class: "recent-round-explanation", text: explanation })
            : null;
          return h(
            "div",
            { class: "recent-round" },
            h("span", {
              class: "recent-round-no",
              text:
                entry.index === null || entry.index === undefined || entry.index === ""
                  ? "第 ? 轮"
                  : `第 ${
                      Number.isFinite(Number(entry.index)) ? Number(entry.index) : "?"
                    } 轮`,
            }),
            h("strong", {
              class: "recent-round-answer",
              text: safeText(entry.answer, "未公布"),
            }),
            explanationNode,
            h("span", { class: "recent-round-result", text: resultText }),
          );
        }),
    );
  }

  /* ------------------------------------------------------------------ */
  /* 渲染：顶部 / 计分板                                                 */
  /* ------------------------------------------------------------------ */

  function render() {
    if (destroyed) return;
    if (!room) {
      content.classList.add("is-hidden");
      loadingSlot.classList.remove("is-hidden");
      loadingSlot.replaceChildren(
        loadingBlock("正在进入房间…"),
        h(
          "button",
          { class: "btn btn-ghost", type: "button", onclick: () => ctx.goLobby() },
          "返回大厅",
        ),
      );
      backButton.lastChild.textContent = "离开";
      setSummaryOverlay.classList.add("is-hidden");
      matchOverlay.classList.add("is-hidden");
      scoreBarShell.classList.add("is-hidden");
      el.classList.remove("is-match-point");
      return;
    }
    content.classList.remove("is-hidden");
    loadingSlot.classList.add("is-hidden");
    clearTimeout(loadingHintTimer);

    const isSpectator = room.viewerRole === "spectator";
    const me = room.players.find((player) => player.id === room.viewerId) || null;
    const setMode = isSetMode();
    const practice = isPractice();
    el.classList.toggle("is-practice", practice);
    backButton.lastChild.textContent = isSpectator ? "退出观战" : "离开";

    /* 顶部 */
    modeSlot.replaceChildren(modeBadge(room.mode));
    const codeButton = h(
      "button",
      {
        class: "room-code-chip",
        type: "button",
        title: "复制房号",
        onclick: async () => {
          const ok = await copyText(room.code);
          toast(ok ? `房号 ${room.code} 已复制` : "复制失败，请手动选择房号", ok ? "success" : "warn");
        },
      },
      h("span", { class: "room-code-label", text: "房号" }),
      h("span", { class: "room-code-value", text: room.code }),
      icon("copy", 14),
    );
    const shareButton = h(
      "button",
      {
        class: "icon-btn",
        type: "button",
        title: "复制观战链接",
        "aria-label": "复制观战链接",
        onclick: async () => {
          const url = `${location.origin}${location.pathname}?room=${encodeURIComponent(room.code)}`;
          const ok = await copyText(url);
          toast(ok ? "观战链接已复制" : "复制失败", ok ? "success" : "warn");
        },
      },
      icon("link", 16),
    );
    const inviteButton = h(
      "button",
      {
        class: "btn btn-ghost btn-sm room-invite-btn",
        type: "button",
        title: "复制邀请",
        "aria-label": "复制邀请",
        onclick: async () => {
          const code = safeText(room.code, "");
          const text = `来词影竞技场开一局：房间码 ${code}\n${location.origin}/?room=${encodeURIComponent(code)}`;
          const ok = await copyText(text);
          toast(ok ? "邀请已复制" : "复制失败，请手动选择房号", ok ? "success" : "warn");
        },
      },
      icon("users", 16),
      h("span", { class: "btn-label", text: "邀请" }),
    );
    codeSlot.replaceChildren(codeButton, shareButton, inviteButton);
    statusSlot.replaceChildren(
      h("span", { class: `status-pill status-${room.status}`, text: statusLabel(room.status) }),
    );
    guessModeSlot.replaceChildren(
      h(
        "span",
        {
          class: "guessmode-pill",
          title: guessModeHint(room.guessMode),
        },
        guessModeLabel(room.guessMode),
      ),
    );

    /* 计分板 */
    const match = room.match || {};
    const roundIndex = room.round ? room.round.index : 0;
    if (setMode) {
      const info = setMatchInfo();
      const targetText = `目标 ${info.pointsToWin} 分（领先 ${info.pointLead} 分）`;
      const baseText = `第 ${info.setNumber} 小局，大比分 ${info.bigScore}，${targetText}`;
      const setEnd = setEndInfo();
      if (room.status === "waiting") {
        roundKicker.textContent = `${baseText}，${bestOfLabel(info.bestOf)}`;
        roundTitle.textContent = "等待玩家准备";
      } else if (room.status === "countdown") {
        roundKicker.textContent = `${baseText}，${bestOfLabel(info.bestOf)}`;
        roundTitle.textContent = "即将开始";
      } else if (room.status === "matchEnd") {
        roundKicker.textContent = `大比分 ${info.bigScore}，${bestOfLabel(info.bestOf)}`;
        roundTitle.textContent = matchResultText(room);
      } else {
        roundKicker.textContent = baseText;
        if (room.round && room.round.status === "ended") {
          roundTitle.textContent = setEnd
            ? `${setEnd.winnerLabel} 拿下本小局！`
            : roundResultTitle(room);
        } else {
          roundTitle.textContent = `第 ${Math.max(roundIndex, 1)} 轮`;
        }
      }
    } else if (practice) {
      roundKicker.textContent = "个人练习";
      roundTitle.textContent =
        room.status === "matchEnd" || (room.round && room.round.status === "ended")
          ? "练习完成"
          : "练习中";
    } else {
      const target = targetScoreFor(room.mode, match);
      if (room.status === "waiting") {
        roundKicker.textContent = `先到 ${target} 分，无小局`;
        roundTitle.textContent = "等待玩家准备";
      } else if (room.status === "countdown") {
        roundKicker.textContent = `先到 ${target} 分，无小局`;
        roundTitle.textContent = "即将开始";
      } else if (room.status === "matchEnd") {
        roundKicker.textContent = `共 ${match.roundNumber || Math.max(roundIndex, 1)} 轮`;
        roundTitle.textContent = matchResultText(room);
      } else {
        roundKicker.textContent = `第 ${Math.max(roundIndex, 1)} 轮，先到 ${target} 分`;
        roundTitle.textContent =
          room.round && room.round.status === "ended"
            ? roundResultTitle(room)
            : `第 ${Math.max(roundIndex, 1)} 轮进行中`;
      }
    }

    if (!practice) {
      const rules = room.requiresAgreement
        ? room.proposal
          ? room.proposal.rules
          : room.rules || roomRules()
        : room.rules || roomRules();
      if (room.requiresAgreement) {
        rulesLine.textContent = room.rulesAgreed
          ? `规则已确认：${rulesSummary(rules, room.mode)}`
          : room.proposal
            ? `规则协商中，提案者 ${room.proposal.proposerName}：${rulesSummary(rules, room.mode)}`
            : "等待房主发起规则协商";
      } else {
        rulesLine.textContent = `规则：${rulesSummary(rules, room.mode)}`;
      }
    } else {
      rulesLine.textContent = "";
    }
    renderRulesOverlay();

    renderScores();
    renderScoreBar();
    syncMatchPoint();
    syncGuessControls();
    renderPlayers(me, isSpectator);
    renderRecentRounds();
    renderActions(me, isSpectator);
    if (practice) {
      answerSlot.replaceChildren();
      answerSlot.classList.remove("has-content");
    } else {
      renderAnswer();
    }
    renderBoard(boardEl, room.round);
    renderPractice(me, isSpectator);
    guessArea.classList.toggle(
      "is-hidden",
      isSpectator || (practice && practiceCompleted()),
    );
    spectatorNote.classList.toggle("is-hidden", !isSpectator);
    renderChat(isSpectator);
    updateTeamTab(isSpectator);
    renderSetSummary();
    renderMatchOverlay(me, isSpectator);
    document.title = `${modeLabel(room.mode)} ${room.code} 词影竞技场`;
  }

  function renderScores() {
    // 新的横向比分条承担“本局比分”的主要展示，原计分板不再重复小比分卡片。
    scoresSlot.classList.add("is-hidden");
    scoresSlot.replaceChildren();
  }

  function scoreBarSegments() {
    const players = Array.isArray(room.players) ? room.players : [];
    const info = isSetMode() ? setMatchInfo() : null;
    if (room.mode === "team2v2") {
      return TEAMS.map((team) => ({
        key: team,
        name: `${team} 队`,
        score: Number(room.teamScores && room.teamScores[team]) || 0,
        setWins: Number(info && info.setWins[team]) || 0,
        color: team === "A" ? "red" : "blue",
        empty: false,
      }));
    }
    if (room.mode === "ffa3") {
      const segments = players.slice(0, 3).map((player, index) => ({
        key: player.id,
        name: safeText(player.name, "未知玩家"),
        score: Number(player.score) || 0,
        setWins: null,
        color: ["red", "green", "blue"][index],
        empty: false,
      }));
      while (segments.length < 3) {
        segments.push({
          key: `empty-${segments.length}`,
          name: "等待玩家",
          score: 0,
          setWins: null,
          color: ["red", "green", "blue"][segments.length],
          empty: true,
        });
      }
      return segments;
    }
    const duel = [players[0], players[1]].map((player, index) => ({
      key: player ? player.id : `empty-${index}`,
      name: player ? safeText(player.name, "未知玩家") : "等待玩家",
      score: player ? Number(player.score) || 0 : 0,
      setWins: player && info ? Number(info.setWins[player.id]) || 0 : 0,
      color: index === 0 ? "red" : "blue",
      empty: !player,
    }));
    return duel;
  }

  function renderScoreBar() {
    if (!room || isPractice()) {
      scoreBarShell.classList.add("is-hidden");
      scoreBar.replaceChildren();
      return;
    }
    scoreBarShell.classList.remove("is-hidden");
    const segments = scoreBarSegments();
    // 加 0.5 的基础权重：0:0 时等分，8:1 时更悬殊，8:6 时接近但不相等。
    const weighted = segments.map((segment) => ({
      ...segment,
      weight: Math.max(0, Number(segment.score) || 0) + 0.5,
    }));
    const total = weighted.reduce((sum, segment) => sum + segment.weight, 0) || 1;
    scoreBar.replaceChildren(
      ...weighted.map((segment) => {
        const share = (segment.weight / total) * 100;
        const scoreEl = h("strong", {
          class: "score-bar-score",
          text: String(segment.score),
        });
        const label = h(
          "span",
          { class: "score-bar-label" },
          h("span", { class: "score-bar-name", text: segment.name }),
          isSetMode()
            ? h("span", { class: "score-bar-setwins", text: `大比分 ${segment.setWins || 0}` })
            : null,
        );
        return h(
          "div",
          {
            class: `score-bar-seg score-bar-${segment.color}${segment.empty ? " is-empty" : ""}`,
            style: { flex: `0 0 ${share.toFixed(2)}%` },
            "data-share": share.toFixed(2),
            "data-score": String(segment.score),
            "data-team": segment.key,
            "aria-label": `${segment.name} ${segment.score} 分`,
          },
          label,
          scoreEl,
        );
      }),
    );
    scoreBar.setAttribute(
      "aria-label",
      `当前小局比分 ${weighted.map((segment) => `${segment.name} ${segment.score}`).join("，")}`,
    );
  }

  function matchPointInfo() {
    if (!room || isPractice() || room.status === "matchEnd") return null;
    if (room.round && (room.round.setWinnerId || room.round.setWinnerTeam)) return null;
    if (room.mode === "ffa3") {
      const players = Array.isArray(room.players) ? room.players : [];
      const player = players.find(
        (item) => (Number(item.score) || 0) >= FFA_TARGET_SCORE - 1,
      );
      return player ? { label: safeText(player.name, "玩家"), badge: "赛点" } : null;
    }
    if (!isSetMode()) return null;
    const info = setMatchInfo();
    const pointsToWin = Number(info.pointsToWin) || 11;
    const setsToWin = Number(info.setsToWin) || 1;
    let sides;
    if (info.team) {
      sides = [
        {
          key: "A",
          label: "A 队",
          setWins: Number(info.setWins.A) || 0,
          score: Number(room.teamScores && room.teamScores.A) || 0,
        },
        {
          key: "B",
          label: "B 队",
          setWins: Number(info.setWins.B) || 0,
          score: Number(room.teamScores && room.teamScores.B) || 0,
        },
      ];
    } else {
      const players = Array.isArray(room.players) ? room.players : [];
      sides = [players[0], players[1]]
        .filter(Boolean)
        .map((player) => ({
          key: player.id,
          label: safeText(player.name, "玩家"),
          setWins: Number(info.setWins[player.id]) || 0,
          score: Number(player.score) || 0,
        }));
    }
    for (const side of sides) {
      const other = sides.find((item) => item.key !== side.key);
      if (!other) continue;
      // “局点”：再得 1 分就赢下当前小局；“赛点”：同时只差 1 个小局就赢下整场。
      const atSetPoint =
        side.score >= pointsToWin - 1 && side.score - other.score >= 1;
      if (!atSetPoint) continue;
      const isMatchPoint = side.setWins >= setsToWin - 1;
      return {
        label: side.label,
        badge: isMatchPoint ? "赛点" : "局点",
      };
    }
    return null;
  }

  function syncMatchPoint() {
    const info = matchPointInfo();
    const active = Boolean(info);
    el.classList.toggle("is-match-point", active);
    scoreBarShell.classList.toggle("is-match-point", active);
    scoreboard.classList.toggle("is-match-point", active);
    matchPointBadge.classList.toggle("is-hidden", !active);
    if (active) {
      matchPointBadge.textContent = info.badge || "赛点";
      matchPointBadge.title = `${info.label} ${info.badge || "赛点"}`;
    }
    return info;
  }
  function renderPlayers(me, isSpectator) {
    const players = Array.isArray(room.players) ? room.players : [];
    rejoinCountdownEls.clear();
    playersTitle.textContent = isSetMode()
      ? `玩家 ${players.length} 人`
      : `玩家 ${players.length}/${MODE_META[room.mode].capacity} 人`;
    const setMode = isSetMode();
    const fragment = document.createDocumentFragment();

    function appendPlayer(player) {
      const isMe = player.id === room.viewerId;
      const team = player.team;
      const classes = ["player-card"];
      if (isMe) classes.push("is-me");
      if (!player.connected) classes.push("is-offline");
      if (team) classes.push(`team-${team}`);
      const badges = [];
      if (player.isHost) {
        badges.push(h("span", { class: "badge badge-host", title: "房主" }, icon("crown", 12), "房主"));
      }
      if (isMe) badges.push(h("span", { class: "badge badge-me", text: "你" }));
      if (team) {
        badges.push(h("span", { class: `badge badge-team team-badge-${team}`, text: `${team} 队` }));
      }
      if (player.isGuest) badges.push(h("span", { class: "badge badge-guest", text: "游客" }));

      const statusBits = [];
      if (!player.connected) {
        const rejoin = h("span", { class: "player-rejoin", text: "掉线中" });
        rejoinCountdownEls.set(player.id, rejoin);
        statusBits.push(rejoin);
      } else {
        statusBits.push(h("span", { class: "online-dot is-online" }));
        statusBits.push(h("span", { text: "在线" }));
      }
      statusBits.push(h("span", { class: "meta-sep", text: "，" }));
      statusBits.push(
        h("span", {
          text:
            room.status === "waiting"
              ? player.isHost
                ? "房主无需准备"
                : player.ready
                  ? "已准备"
                  : "未准备"
              : `猜 ${player.guesses || 0} 次`,
        }),
      );

      const viewer = players.find((item) => item.id === room.viewerId) || null;
      const canSwitchTeam =
        room.mode === "team2v2" &&
        room.status === "waiting" &&
        room.viewerRole === "player" &&
        viewer &&
        (viewer.isHost || player.id === viewer.id);
      const teamSwitch = canSwitchTeam
        ? h(
            "div",
            { class: "team-switch", role: "group", "aria-label": `${safeText(player.name, "未知玩家")} 的队伍` },
            ...TEAMS.map((teamOption) =>
              h(
                "button",
                {
                  class: `team-switch-btn team-switch-${teamOption}${
                    player.team === teamOption ? " is-active" : ""
                  }`,
                  type: "button",
                  disabled: player.team === teamOption,
                  onclick: () =>
                    ws.setTeam(
                      teamOption,
                      viewer.isHost ? player.id : undefined,
                    ),
                },
                `加入 ${teamOption} 队`,
              ),
            ),
          )
        : null;

      let scoreBox = null;
      if (setMode) {
        scoreBox = h(
          "div",
          { class: "player-score-box" },
          h(
            "span",
            { class: "player-bigbox" },
            h("span", { class: "score-big-label", text: "大比分" }),
            h("strong", { class: "score-big-value", text: String(bigScoreForPlayer(player)) }),
          ),
        );
      }

      let friendAction = null;
      if (
        store.user &&
        !store.user.isGuest &&
        player.id !== room.viewerId &&
        !player.isGuest
      ) {
        if (friendIds.has(player.id)) {
          friendAction = h("span", { class: "player-friend-action is-friend", text: "已是好友" });
        } else if (incomingFriendIds.has(player.id)) {
          friendAction = h("span", { class: "player-friend-action", text: "待处理申请" });
        } else if (outgoingFriendIds.has(player.id)) {
          friendAction = h("span", { class: "player-friend-action", text: "已申请" });
        } else {
          friendAction = h(
            "button",
            {
              class: "btn btn-ghost btn-sm player-friend-action",
              type: "button",
              onclick: async () => {
                try {
                  await api.sendFriendRequest(player.id);
                  outgoingFriendIds.add(player.id);
                  render();
                  toast("好友申请已发送", "success");
                } catch (error) {
                  toast(error && error.message ? error.message : "添加好友失败", "error");
                }
              },
            },
            "加好友",
          );
        }
      }

      return h(
        "div",
        { class: classes.join(" ") },
        avatarNode(safeText(player.name, "未知玩家"), player.avatar),
        h(
          "div",
          { class: "player-main" },
          h(
            "div",
            { class: "player-name-row" },
            h("span", { class: "player-name", text: safeText(player.name, "未知玩家") }),
            badges,
          ),
          h("div", { class: "player-sub" }, ...statusBits),
          teamSwitch,
          friendAction,
        ),
        scoreBox,
      );
    }

    if (room.mode === "team2v2") {
      for (const team of TEAMS) {
        const members = players.filter((player) => player.team === team);
        fragment.appendChild(
          h(
            "div",
            { class: `team-group team-group-${team}` },
            h(
              "div",
              { class: "team-group-head" },
              h("span", { class: "team-group-name", text: `队伍 ${team}` }),
              h("span", { class: "team-group-count", text: `${members.length} 人` }),
            ),
            ...members.map(appendPlayer),
            members.length === 0
              ? h("p", { class: "players-empty", text: "等待玩家加入…" })
              : null,
          ),
        );
      }
    } else {
      for (const player of players) fragment.appendChild(appendPlayer(player));
      if (players.length === 0) {
        fragment.appendChild(h("p", { class: "players-empty", text: "等待玩家加入…" }));
      }
    }
    playersList.replaceChildren(fragment);

    const spectators = Array.isArray(room.spectators) ? room.spectators : [];
    spectatorsLine.replaceChildren(
      h("span", { class: "spectators-count", text: `观战 ${spectators.length} 人` }),
      spectators.length
        ? h("span", { class: "spectators-names", text: spectators.map((item) => item.name).join("、") })
        : h("span", { class: "spectators-names", text: isSpectator ? "你是第一位观众" : "" }),
    );
  }

  function teamCounts() {
    const players = Array.isArray(room.players) ? room.players : [];
    return {
      A: players.filter((player) => player.team === "A").length,
      B: players.filter((player) => player.team === "B").length,
    };
  }

  function canHostStart(me) {
    if (!room || room.status !== "waiting" || !me || !me.isHost) return false;
    if (room.requiresAgreement && !room.rulesAgreed) return false;
    const others = room.players.filter((player) => player.id !== room.hostId);
    if (others.some((player) => !player.ready)) return false;
    if (room.mode === "team2v2") {
      const counts = teamCounts();
      return counts.A >= 1 && counts.B >= 1;
    }
    const capacity = MODE_META[room.mode].capacity;
    return room.players.length >= capacity;
  }

  function renderActions(me, isSpectator) {
    actionButtons.replaceChildren();
    const drawOffer = room.status === "matchEnd" ? null : room.drawOffer || null;
    actionBar.classList.toggle("is-draw-offer", Boolean(drawOffer));
    if (isSpectator) {
      const capacity = MODE_META[room.mode].capacity;
      const joinable =
        room.status === "waiting" && Array.isArray(room.players) && room.players.length < capacity;
      actionHint.textContent = drawOffer
        ? `${safeText(drawOffer.proposerName, "玩家")} 请求平局，等待玩家处理。`
        : joinable
          ? "房间尚未开始，可以加入对局。"
          : "观战模式：可查看对局并在房间聊天。";
      if (joinable) {
        actionButtons.appendChild(
          h(
            "button",
            {
              class: "btn btn-primary btn-sm",
              type: "button",
              onclick: () => ws.joinRoom(room.code),
            },
            icon("play", 16),
            "加入对局",
          ),
        );
      }
      actionButtons.appendChild(
        h(
          "button",
          { class: "btn btn-ghost btn-sm", type: "button", onclick: () => ctx.leaveRoom() },
          icon("eye", 16),
          "退出观战",
        ),
      );
      return;
    }

    const capacity = MODE_META[room.mode].capacity;
    const team = room.mode === "team2v2";
    const counts = team ? teamCounts() : null;

    if (room.status === "waiting") {
      const needsRules = Boolean(room.requiresAgreement && !room.rulesAgreed);
      if (needsRules) {
        actionButtons.appendChild(
          h(
            "button",
            {
              class: "btn btn-ghost btn-sm",
              type: "button",
              onclick: () => openRulesOverlay(),
            },
            icon("refresh", 16),
            "协商规则",
          ),
        );
      }
      if (me && me.isHost && !room.requiresAgreement) {
        actionButtons.appendChild(
          h(
            "button",
            {
              class: "btn btn-ghost btn-sm",
              type: "button",
              onclick: () => openUpdateRules(),
            },
            icon("refresh", 16),
            "修改规则",
          ),
        );
      }
      if (me && me.isHost) {
        const startable = canHostStart(me);
        actionButtons.appendChild(
          h(
            "button",
            {
              class: "btn btn-primary btn-sm",
              type: "button",
              disabled: !startable,
              onclick: () => ws.startMatch(),
            },
            icon("play", 16),
            "开始比赛",
          ),
        );
        if (team) {
          actionHint.textContent =
            `房主无需准备，A 队 ${counts.A} 人 / B 队 ${counts.B} 人` +
            (needsRules
              ? "，请先完成规则协商"
              : startable
                ? "，可以开始"
                : "，双方各需至少 1 人且其他玩家全部准备");
        } else {
          const others = room.players.filter((player) => player.id !== room.hostId);
          const allOthersReady = others.every((player) => player.ready);
          actionHint.textContent =
            `房主无需准备，玩家 ${room.players.length}/${capacity}` +
            (needsRules
              ? "，请先完成规则协商"
              : !allOthersReady
                ? "，等待其他玩家准备"
                : startable
                  ? "，可以开始"
                  : "，等待玩家加入");
        }
      } else if (me) {
        actionButtons.appendChild(
          h(
            "button",
            {
              class: `btn btn-sm ${me.ready ? "btn-ghost" : "btn-primary"}`,
              type: "button",
              onclick: () => ws.setReady(!me.ready),
            },
            icon("check", 16),
            me.ready ? "取消准备" : "准备",
          ),
        );
        actionHint.textContent = needsRules
          ? "等待规则协商完成"
          : me.ready
            ? "已准备，等待房主开始"
            : "点击准备，等待房主开始";
      } else {
        actionHint.textContent = "你不在该房间的玩家列表中";
      }
    } else if (room.status === "countdown") {
      actionHint.textContent = "倒计时结束自动开始…";
    } else if (room.status === "matchEnd") {
      actionHint.textContent = `${matchResultText(room)}。`;
    } else if (room.round && room.round.status === "ended") {
      actionHint.textContent = setEndInfo()
        ? "本小局结束，结算页展示中…"
        : "本轮结束，即将进入下一轮…";
    } else if (isSetMode()) {
      const info = setMatchInfo();
      actionHint.textContent = `抢答中：猜中得 1 分，小局先到 ${info.pointsToWin} 分且领先 ${info.pointLead} 分。`;
    } else {
      actionHint.textContent = `抢答中：先到 ${targetScoreFor(room.mode, room.match)} 分获胜；第 6 行未猜中其他玩家各得 1 分。`;
    }

    if (drawOffer) {
      const acceptedBy = Array.isArray(drawOffer.acceptedBy) ? drawOffer.acceptedBy : [];
      const isProposer = drawOffer.proposerId === room.viewerId;
      const accepted = acceptedBy.includes(room.viewerId);
      if (isProposer) {
        actionHint.textContent = "已请求平局，等待对方同意。";
      } else if (accepted) {
        actionHint.textContent = "已同意平局，等待其他玩家确认。";
      } else {
        actionHint.textContent = `${safeText(
          drawOffer.proposerName,
          "对方",
        )} 请求平局，请选择同意或拒绝。`;
        actionButtons.appendChild(
          h(
            "button",
            {
              class: "btn btn-primary btn-sm",
              type: "button",
              onclick: () => ws.respondDraw(true),
            },
            "同意平局",
          ),
        );
        actionButtons.appendChild(
          h(
            "button",
            {
              class: "btn btn-ghost btn-sm",
              type: "button",
              onclick: () => ws.respondDraw(false),
            },
            "拒绝",
          ),
        );
      }
    } else if (
      me &&
      !isPractice() &&
      (room.status === "playing" || room.status === "roundEnd")
    ) {
      actionButtons.appendChild(
        h(
          "button",
          {
            class: "btn btn-ghost btn-sm",
            type: "button",
            onclick: () => ws.offerDraw(),
          },
          "求和",
        ),
      );
    }

    if (room.status !== "matchEnd" && !drawOffer) {
      actionButtons.appendChild(
        h(
          "button",
          { class: "btn btn-ghost btn-sm", type: "button", onclick: () => ctx.leaveRoom() },
          "离开房间",
        ),
      );
    }
  }

  function roundResultTitle(state) {
    const round = state.round;
    switch (round.result) {
      case "solved":
        return `${safeText(round.winnerName, "玩家")} 猜中！`;
      case "exhausted":
        return round.awardedTo && round.awardedTo.length > 0
          ? "第 6 行仍未猜中，对方得分"
          : "无人猜中，本轮流局";
      case "timeout":
        return "无人作答，本轮流局";
      default:
        return "本轮结束";
    }
  }

  /* ------------------------------------------------------------------ */
  /* 个人练习                                                            */
  /* ------------------------------------------------------------------ */

  function practiceCompleted() {
    if (!isPractice()) return false;
    if (room.status === "matchEnd") return true;
    return Boolean(room.round && room.round.status === "ended");
  }

  function practiceResultInfo() {
    if (!practiceCompleted()) return null;
    const round = room.round || {};
    const me = room.players.find((player) => player.id === room.viewerId) || room.players[0];
    const guesses = Number(me && me.guesses) || 0;
    const timeMs =
      round.startedAt && round.endedAt && round.endedAt > round.startedAt
        ? round.endedAt - round.startedAt
        : 0;
    let title = "练习完成";
    if (round.result === "solved") title = "猜中了";
    else if (round.result === "exhausted") title = "6 行用完";
    else if (round.result === "timeout") title = "无人作答，练习结束";
    return {
      answer: safeText(round.answer, ""),
      guesses,
      timeMs,
      title,
    };
  }

  function practiceTimerText() {
    if (!isPractice()) return EMPTY_TIME;
    if (practiceCompleted()) return "结束";
    if (room.status === "playing" && room.round && room.round.status === "playing") {
      if (room.round.endsAt) {
        return formatDuration(Math.max(0, room.round.endsAt - serverNow()));
      }
      return "不限时";
    }
    if (room.status === "countdown" && room.countdownEndsAt) {
      return formatDuration(Math.max(0, room.countdownEndsAt - serverNow()));
    }
    return EMPTY_TIME;
  }

  function renderPractice(me, isSpectator) {
    const practice = isPractice();
    practiceBar.classList.toggle("is-hidden", !practice);
    practiceResult.classList.toggle("is-hidden", !practice);
    if (!practice) {
      practiceResult.replaceChildren();
      return;
    }
    boardTitle.textContent = "个人练习";
    boardHint.textContent = "猜中或 6 行用完即结束。练习不计天梯与总统计。";
    practiceTimerEl.textContent = practiceTimerText();
    const info = practiceResultInfo();
    if (!info) {
      practiceResult.classList.add("is-hidden");
      practiceResult.replaceChildren();
      return;
    }
    practiceResult.classList.remove("is-hidden");
    const answerChars = Array.from(info.answer);
    const canRematch = room.status === "matchEnd";
    practiceResult.replaceChildren(
      h(
        "div",
        { class: "practice-result-inner" },
        h("p", { class: "practice-result-kicker", text: "练习结果" }),
        h("h3", { class: "practice-result-title", text: info.title }),
        answerChars.length > 0
          ? h(
              "div",
              { class: "practice-answer" },
              h("span", { class: "practice-answer-label", text: "答案" }),
              h(
                "span",
                { class: "answer-chars" },
                ...answerChars.map((char) => h("span", { class: "answer-char", text: char })),
              ),
            )
          : null,
        h(
          "div",
          { class: "practice-stats" },
          h(
            "span",
            { class: "practice-stat" },
            h("span", { class: "practice-stat-label", text: "用时" }),
            h("strong", { class: "practice-stat-value", text: formatDurationMs(info.timeMs) }),
          ),
          h(
            "span",
            { class: "practice-stat" },
            h("span", { class: "practice-stat-label", text: "猜测次数" }),
            h("strong", { class: "practice-stat-value", text: String(info.guesses) }),
          ),
        ),
        canRematch
          ? h(
              "div",
              { class: "practice-actions" },
              h(
                "button",
                { class: "btn btn-primary btn-sm", type: "button", onclick: () => ws.rematch() },
                "再练一局",
              ),
              h(
                "button",
                { class: "btn btn-ghost btn-sm", type: "button", onclick: () => ctx.leaveRoom() },
                "返回大厅",
              ),
            )
          : h("p", { class: "practice-pending", text: "结算中，稍后可再练一局" }),
      ),
    );
  }

  function renderAnswer() {
    const round = room.round;
    const parts = [];
    const setMode = isSetMode();
    const setEnd = setEndInfo();
    const answerText = safeText(round && round.answer, "");
    if (answerText) {
      const answerChars = Array.from(answerText);
      parts.push(
        h(
          "div",
          { class: "answer-banner" },
          h(
            "div",
            { class: "answer-head" },
            h("span", { class: "answer-label", text: "答案" }),
            h("span", {
              class: `answer-result answer-${round.result || "ended"}`,
              text: roundResultLabel(round.result) || "本轮结束",
            }),
          ),
          h(
            "div",
            { class: "answer-chars" },
            ...answerChars.map((char) => h("span", { class: "answer-char", text: char })),
          ),
          h("p", { class: "answer-line", text: setResultLine(room) }),
          setEnd
            ? h("p", {
                class: "answer-setwin",
                text: `${setEnd.winnerLabel} 拿下本小局，大比分 ${setEnd.bigScoreText}`,
              })
            : null,
        ),
      );
    }
    if (!setMode && room.status === "matchEnd") {
      parts.push(
        h(
          "div",
          { class: "match-banner" },
          h("span", { class: "match-crown" }, icon("trophy", 20)),
          h(
            "div",
            {},
            h("p", { class: "match-title", text: matchResultText(room) }),
            h("p", { class: "match-sub", text: forfeitText(room) || "比赛已结束" }),
          ),
        ),
      );
    }
    answerSlot.replaceChildren(...parts);
    answerSlot.classList.toggle("has-content", parts.length > 0);
  }

  /* ------------------------------------------------------------------ */
  /* 小局结算 / 比赛结束页                                               */
  /* ------------------------------------------------------------------ */

  function renderSetSummary() {
    const setEnd = setEndInfo();
    const visible = Boolean(room && room.status === "roundEnd" && setEnd);
    if (!visible) {
      setSummaryOverlay.classList.add("is-hidden");
      setSummaryCountdownEl = null;
      setSummarySignature = "";
      return;
    }
    setSummaryOverlay.classList.remove("is-hidden");
    const signature = `${setEnd.winnerLabel}|${setEnd.setScoreText}|${setEnd.bigScoreText}|${room.round.index}`;
    if (signature === setSummarySignature) return;
    setSummarySignature = signature;
    const remainingSetMs = Math.max(
      0,
      (room.round.endedAt || 0) + SET_END_DELAY_MS - serverNow(),
    );
    const countdown = h("strong", {
      class: "set-summary-countdown",
      text: `${Math.max(0, Math.ceil(remainingSetMs / 1000))}s`,
    });
    setSummaryCountdownEl = countdown;
    const info = setMatchInfo();
    setSummaryBody.replaceChildren(
      h("h3", { class: "set-summary-winner", text: `${setEnd.winnerLabel} 拿下本小局！` }),
      h(
        "div",
        { class: "set-summary-row" },
        h("span", { class: "set-summary-label", text: "本局比分" }),
        h("strong", { class: "set-summary-value", text: setEnd.setScoreText }),
      ),
      h(
        "div",
        { class: "set-summary-row" },
        h("span", { class: "set-summary-label", text: "当前大比分" }),
        h("strong", { class: "set-summary-value gold", text: setEnd.bigScoreText }),
      ),
      h(
        "div",
        { class: "set-summary-row" },
        h("span", { class: "set-summary-label", text: "下一小局" }),
        countdown,
      ),
      h("p", {
        class: "set-summary-note",
        text: `目标 ${info.pointsToWin} 分且领先 ${info.pointLead} 分，${bestOfLabel(info.bestOf)}`,
      }),
    );
  }

  function renderMatchOverlay(me, isSpectator) {
    if (!room || room.status !== "matchEnd" || isPractice()) {
      matchOverlay.classList.add("is-hidden");
      matchOverlaySignature = "";
      return;
    }
    matchOverlay.classList.remove("is-hidden");
    const setMode = isSetMode();
    const info = setMode ? setMatchInfo() : null;
    const forfeit = forfeitText(room);
    const forfeitFlag = Boolean(
      (room.match && room.match.forfeitById) || (room.match && room.match.forfeitTeam),
    );
    const isDraw = Boolean(room.match && room.match.isDraw);
    const players = room.players || [];
    const setHistory = Array.isArray(room.match && room.match.setHistory)
      ? room.match.setHistory
      : [];
    const ratingDeltas =
      room.match && room.match.ratingDeltas && typeof room.match.ratingDeltas === "object"
        ? room.match.ratingDeltas
        : {};
    const signature = `${room.match && room.match.winnerId}|${room.match && room.match.winnerTeam}|${
      room.match && room.match.isDraw
    }|${room.match && room.match.forfeitById}|${room.match && room.match.forfeitTeam}|${players
      .map((player) => `${player.id}:${player.score}:${player.connected}`)
      .join(",")}|${JSON.stringify(setHistory)}|${JSON.stringify(ratingDeltas)}`;
    if (signature === matchOverlaySignature) return;
    matchOverlaySignature = signature;
    matchOverlay.classList.toggle("is-forfeit", forfeitFlag);
    matchOverlay.classList.toggle("is-draw", isDraw);
    matchOverlay.querySelector(".match-overlay-panel")?.classList.toggle("is-forfeit", forfeitFlag);
    matchOverlay.querySelector(".match-overlay-panel")?.classList.toggle("is-draw", isDraw);

    const winnerLine = h("h2", { class: "match-end-title", text: matchResultText(room) });
    const scoreCards = [];
    if (setMode) {
      scoreCards.push(
        h(
          "div",
          { class: "match-end-bigscore" },
          h("span", { class: "score-big-label", text: "最终大比分" }),
          h("strong", { class: "match-end-bigvalue", text: info.bigScore }),
          h("span", { class: "match-end-bestof", text: bestOfLabel(info.bestOf) }),
        ),
      );
    }

    const rows = [];
    if (room.mode === "team2v2") {
      for (const team of TEAMS) {
        const members = players.filter((player) => player.team === team);
        if (members.length === 0) continue;
        rows.push(
          h(
            "div",
            { class: `match-end-team team-${team}` },
            h(
              "div",
              { class: "match-end-team-head" },
              h("span", { class: "match-end-team-name", text: `队伍 ${team}` }),
              h(
                "span",
                { class: "match-end-team-score" },
                setMode
                  ? h("strong", { class: "gold", text: `大比分 ${Number(info.setWins[team]) || 0}` })
                  : h("strong", { text: `得分 ${members.reduce((sum, p) => sum + (Number(p.score) || 0), 0)}` }),
              ),
            ),
            ...members.map((player) =>
              h(
                "div",
                { class: "match-end-player" },
                avatarNode(safeText(player.name, "未知玩家"), player.avatar, "avatar-xs"),
                h("span", { class: "match-end-player-name", text: safeText(player.name, "未知玩家") }),
                h("span", {
                  class: "match-end-player-stat",
                  text: `本局 ${player.score} 分，猜 ${player.guesses || 0} 次`,
                }),
                ratingDeltaNode(player),
              ),
            ),
          ),
        );
      }
    } else {
      const sorted = [...players].sort((a, b) =>
        setMode ? playerSetWins(b.id) - playerSetWins(a.id) : (Number(b.score) || 0) - (Number(a.score) || 0),
      );
      for (const player of sorted) {
        rows.push(
          h(
            "div",
            { class: `match-end-player${player.id === room.viewerId ? " is-me" : ""}` },
            avatarNode(safeText(player.name, "未知玩家"), player.avatar, "avatar-xs"),
            h("span", { class: "match-end-player-name", text: safeText(player.name, "未知玩家") }),
            setMode
              ? h("span", {
                  class: "match-end-player-stat gold",
                  text: `大比分 ${playerSetWins(player.id)}`,
                })
              : null,
            h("span", {
              class: "match-end-player-stat",
              text: `本局 ${player.score} 分，猜 ${player.guesses || 0} 次`,
            }),
            ratingDeltaNode(player),
          ),
        );
      }
    }

    const buttons = [];
    if (!isSpectator && me && me.isHost) {
      buttons.push(
        h(
          "button",
          {
            class: "btn btn-primary btn-sm",
            type: "button",
            onclick: () => ws.rematch(),
          },
          icon("refresh", 16),
          "再来一局",
        ),
      );
    }
    buttons.push(
      h(
        "button",
        {
          class: "btn btn-ghost btn-sm",
          type: "button",
          onclick: () => shareMatch(me),
        },
        icon("copy", 16),
        "分享对局",
      ),
    );
    buttons.push(
      h(
        "button",
        {
          class: "btn btn-ghost btn-sm",
          type: "button",
          onclick: () => ctx.leaveRoom(),
        },
        icon("door", 16),
        isSpectator ? "退出观战" : "返回大厅",
      ),
    );

    const setHistoryBlock =
      setMode && setHistory.length > 0
        ? h(
            "div",
            { class: "set-history" },
            h("p", { class: "set-history-title", text: "各小局比分" }),
            ...setHistory.map((entry) => {
              entry = entry || {};
              const teamScores = entry.teamScores || {};
              const scores = entry.scores || {};
              const scoreText = entry.winnerTeam
                ? `A ${Number(teamScores.A) || 0} 比 ${Number(teamScores.B) || 0} B`
                : Object.values(scores)
                    .map((value) => Number(value) || 0)
                    .join(":");
              const winner = entry.winnerTeam
                ? `${safeText(entry.winnerTeam, "?")} 队胜`
                : (safeText(players.find((player) => player.id === entry.winnerId)?.name, "玩家") + " 胜");
              return h(
                "div",
                { class: "set-history-row" },
                h("span", {
                  class: "set-history-no",
                  text:
                    entry.setNumber === null ||
                    entry.setNumber === undefined ||
                    entry.setNumber === ""
                      ? "第 1 小局"
                      : `第 ${
                          Number.isFinite(Number(entry.setNumber))
                            ? Number(entry.setNumber)
                            : 1
                        } 小局`,
                }),
                h("strong", { class: "set-history-score", text: scoreText || "—" }),
                h("span", { class: "set-history-winner", text: winner }),
              );
            }),
          )
        : null;

    const overlayChildren = [
      h(
        "p",
        { class: "match-end-kicker" },
        icon(isDraw ? "check" : forfeitFlag ? "wifiOff" : "trophy", 16),
        isDraw ? "平局" : forfeitFlag ? "断线判胜" : "比赛结束",
      ),
      winnerLine,
      forfeit ? h("p", { class: "match-end-forfeit", text: forfeit }) : null,
      ...scoreCards,
      setHistoryBlock,
      h("div", { class: "match-end-players" }, ...rows),
      h(
        "p",
        {
          class: "match-end-note",
          text: isSpectator
            ? "观战结束。"
            : me && me.isHost
              ? "房主可以直接再来一局，或返回大厅。"
              : "等待房主再来一局，或返回大厅。",
        },
      ),
      h("div", { class: "match-end-actions" }, ...buttons),
    ];
    matchOverlayBody.replaceChildren(...overlayChildren.filter(Boolean));
  }

  /* ------------------------------------------------------------------ */
  /* 聊天                                                                */
  /* ------------------------------------------------------------------ */

  function updateTeamTab(isSpectator) {
    const canTeamChat = room.mode === "team2v2" && !isSpectator;
    teamTab.classList.toggle("is-hidden", !canTeamChat);
    if (!canTeamChat && chatScope === "team") chatScope = "room";
    roomTab.classList.toggle("is-active", chatScope === "room");
    teamTab.classList.toggle("is-active", chatScope === "team");
  }

  function switchChatScope(scope) {
    if (scope === "team" && teamTab.classList.contains("is-hidden")) return;
    if (chatScope === scope) return;
    chatScope = scope;
    lastChatSignature = "";
    renderChat(room.viewerRole === "spectator");
  }

  function renderChat(isSpectator) {
    const messages = Array.isArray(room.chat) ? room.chat : [];
    const filtered = messages.filter((message) => message.scope === chatScope);
    chatForm.classList.remove("is-hidden");
    chatSpectatorNote.classList.add("is-hidden");
    const signature = `${room.code}:${chatScope}:${filtered.length}:${
      filtered.length ? filtered[filtered.length - 1].id : ""
    }`;
    if (signature === lastChatSignature) return;

    const nearBottom = chatList.scrollHeight - chatList.scrollTop - chatList.clientHeight < 32;
    lastChatSignature = signature;
    chatEmpty.classList.toggle("is-hidden", filtered.length > 0);
    const fragment = document.createDocumentFragment();
    for (const message of filtered) {
      const speaker = (room.players || []).find((player) => player.id === message.userId);
      fragment.appendChild(
        h(
          "div",
          { class: `chat-msg${message.userId === room.viewerId ? " is-me" : ""}` },
          h(
            "div",
            { class: "chat-msg-head" },
            avatarNode(safeText(message.name, "未知玩家"), speaker ? speaker.avatar : "", "avatar-xs"),
            h("span", { class: "chat-name", text: safeText(message.name, "未知玩家") }),
            h("span", { class: "chat-time", text: formatClock(message.ts) }),
          ),
          h("p", { class: "chat-text", text: message.text }),
        ),
      );
    }
    chatList.replaceChildren(fragment);
    if (nearBottom || filtered.length <= 1) {
      chatList.scrollTop = chatList.scrollHeight;
    }
  }

  /* ------------------------------------------------------------------ */
  /* 计时 / 冷却                                                         */
  /* ------------------------------------------------------------------ */

  function timerTarget() {
    if (!room) return null;
    if (room.status === "countdown" && room.countdownEndsAt) {
      return { target: room.countdownEndsAt, label: "开局倒计时" };
    }
    if (room.status === "playing" && room.round && room.round.status === "playing" && room.round.endsAt) {
      return { target: room.round.endsAt, label: "无人作答倒计时" };
    }
    if (room.status === "roundEnd" && room.round && room.round.endedAt) {
      const setEnd = setEndInfo();
      return {
        target: room.round.endedAt + (setEnd ? SET_END_DELAY_MS : ROUND_END_DELAY_MS),
        label: setEnd ? "下一小局倒计时" : "下一轮倒计时",
      };
    }
    return null;
  }

  function tick() {
    if (destroyed || !room) return;
    timerBox.title = `${Math.round(IDLE_ROUND_TIMEOUT_MS / 1000)} 秒内无人作答本轮结束；每次有效猜测会重置倒计时`;
    const target = timerTarget();
    timerLabel.textContent = target ? target.label : "倒计时";
    if (target && target.target) {
      const remaining = Math.max(0, target.target - serverNow());
      timerValue.textContent = formatDuration(remaining);
      timerBox.classList.toggle("is-urgent", remaining <= 10000 && remaining > 0);
    } else if (room.status === "matchEnd") {
      timerValue.textContent = "结束";
      timerBox.classList.remove("is-urgent");
    } else {
      timerValue.textContent = EMPTY_TIME;
      timerBox.classList.remove("is-urgent");
    }

    if (setSummaryCountdownEl && room.round && room.round.endedAt) {
      const remaining = Math.max(0, room.round.endedAt + SET_END_DELAY_MS - serverNow());
      setSummaryCountdownEl.textContent = `${Math.max(0, Math.ceil(remaining / 1000))}s`;
    }

    for (const [playerId, element] of rejoinCountdownEls) {
      const player = room.players.find((item) => item.id === playerId);
      if (!player || player.connected) continue;
      const remaining = player.rejoinDeadline ? player.rejoinDeadline - serverNow() : 0;
      element.textContent = remaining > 0 ? `重连 ${formatDuration(remaining)}` : "已超时";
    }

    if (isPractice()) {
      practiceTimerEl.textContent = practiceTimerText();
    }

    syncGuessControls();
  }

  function cooldownRemaining() {
    return Math.max(0, cooldownUntil - Date.now());
  }

  function canSubmitGuess() {
    if (!room || room.viewerRole !== "player") return false;
    if (room.status !== "playing") return false;
    if (!room.round || room.round.status !== "playing") return false;
    return true;
  }

  function syncGuessControls() {
    if (!room) return;
    const remaining = cooldownRemaining();
    const canSubmitBase = canSubmitGuess();
    const ratio = Math.min(1, Math.max(0, remaining / GUESS_COOLDOWN_MS));
    cooldownBar.style.width = `${(ratio * 100).toFixed(1)}%`;
    cooldownTrack.classList.toggle("is-cooling", remaining > 0);

    const player = room.players.find((item) => item.id === room.viewerId);
    let placeholder =
      room.guessMode === "free" ? "任意 4 个汉字" : "输入四字成语";
    if (room.viewerRole !== "player") placeholder = "观战中";
    else if (isPractice() && practiceCompleted()) placeholder = "练习结束";
    else if (isPractice() && room.status === "waiting") placeholder = "练习准备中…";
    else if (room.status === "waiting") placeholder = "等待房主开始…";
    else if (room.status === "countdown") placeholder = "即将开始…";
    else if (room.status === "roundEnd") placeholder = "本轮已结束…";
    else if (room.status === "matchEnd") placeholder = "比赛已结束";
    else if (!player) placeholder = "你不在玩家列表中";
    guessInput.placeholder = placeholder;
    guessInput.disabled = !canSubmitBase;
    guessButton.disabled = !canSubmitBase || remaining > 0;
    guessButton.textContent = remaining > 0 ? `${(remaining / 1000).toFixed(1)}s` : "提交";
    guessHint.textContent =
      remaining > 0
        ? "冷却中，请稍候再试"
        : `${room.guessMode === "free" ? "任意 4 个汉字" : "标准模式：可输入全词库成语"}，回车提交，间隔 1 秒`;
    guessForm.classList.toggle("is-disabled", !canSubmitBase);
  }

  function submitGuess(event) {
    event.preventDefault();
    if (!room) return;
    if (room.viewerRole !== "player") {
      toast("观战中不能提交猜测", "warn");
      return;
    }
    if (!canSubmitGuess()) {
      toast("当前不能提交猜测", "warn");
      return;
    }
    if (cooldownRemaining() > 0) {
      toast("冷却中，请稍候", "warn");
      return;
    }
    const word = guessInput.value.trim();
    if (!word) {
      toast("请输入猜测内容", "warn");
      guessInput.focus();
      return;
    }
    suggestionText = "";
    guessSuggestion.classList.add("is-hidden");
    // 非法字符 / 字数 / 是否在词库中，都交给服务端校验并返回 error toast。
    // 先写入 pending，保证同步 mock 推送 state 时也能正确判断并清空。
    pendingGuess = word;
    if (ws.submitGuess(word)) {
      cooldownUntil = Date.now() + GUESS_COOLDOWN_MS;
      syncGuessControls();
    } else {
      pendingGuess = "";
    }
  }

  function clearGuessDraft() {
    guessInput.value = "";
    pendingGuess = "";
    suggestionText = "";
    guessSuggestion.textContent = "";
    guessSuggestion.classList.add("is-hidden");
  }

  function clearGuessAfterSuccess(state) {
    if (!pendingGuess || !state) return;
    const viewerId = state.viewerId;
    const rows = Array.isArray(state.round && state.round.rows) ? state.round.rows : [];
    const succeeded = rows.some(
      (row) => row && row.playerId === viewerId && row.word === pendingGuess,
    );
    if (!succeeded) return;
    if (guessInput.value.trim() === pendingGuess) guessInput.value = "";
    pendingGuess = "";
    suggestionText = "";
    guessSuggestion.classList.add("is-hidden");
  }

  /* ------------------------------------------------------------------ */
  /* 事件绑定                                                            */
  /* ------------------------------------------------------------------ */

  guessForm.addEventListener("submit", submitGuess);

  chatForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!room) return;
    if (room.viewerRole === "spectator" && chatScope === "team") return;
    const text = chatInput.value.trim();
    if (!text) return;
    if (ws.sendChat(chatScope, text)) chatInput.value = "";
  });

  document.addEventListener("keydown", onGlobalKeyDown);
  function onGlobalKeyDown(event) {
    if (!room || room.viewerRole !== "player") return;
    if (!(event.ctrlKey || event.metaKey) || event.key !== "Enter") return;
    if (document.activeElement === chatInput) return;
    guessInput.focus();
    syncGuessControls();
  }

  unsubscribe.push(
    on("room", (next) => {
      if (!next) return;
      room = next;
      const token = roundTokenOf(next);
      if (token !== lastRoundToken) {
        lastRoundToken = token;
        clearGuessDraft();
      }
      clearGuessAfterSuccess(next);
      render();
    }),
    on("serverError", (message) => {
      const text = String(message || "");
      const match = /「([^」]+)」/.exec(text);
      suggestionText = "";
      guessSuggestion.classList.add("is-hidden");
      if (match && /是否要输入/.test(text)) {
        suggestionText = match[1];
        guessSuggestion.textContent = `你是否要输入「${suggestionText}」？`;
        guessSuggestion.classList.remove("is-hidden");
        guessInput.focus();
      }
      render();
    }),
    on("connection", (connection) => {
      connSlot.replaceChildren(connectionBadge(connection));
      updateNetBanner(connection);
    }),
  );

  function updateNetBanner(connection) {
    if (connection === "open") {
      netBanner.classList.add("is-hidden");
      return;
    }
    if (connection === "closed") {
      netBannerText.textContent = "连接已断开。";
      netBanner.classList.remove("is-hidden");
      return;
    }
    netBannerText.textContent = "网络连接中断，正在自动重连…";
    netBanner.classList.remove("is-hidden");
  }

  async function openInviteFriends() {
    if (!store.user || store.user.isGuest) {
      toast("注册用户才能邀请好友", "warn");
      return;
    }
    const list = h("div", { class: "friend-chat-list", text: "正在加载好友…" });
    const modal = openModal({
      title: "邀请好友",
      content: h(
        "div",
        { class: "friend-profile" },
        h("p", { class: "friends-sub", text: "邀请在线好友加入当前房间。" }),
        list,
      ),
    });
    try {
      const data = await api.fetchFriends();
      const friends = Array.isArray(data && data.friends) ? data.friends : [];
      if (friends.length === 0) {
        list.replaceChildren(h("p", { class: "friends-sub", text: "还没有好友，先去好友页添加吧。" }));
        return;
      }
      list.replaceChildren(
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
              {
                class: "btn btn-primary btn-sm",
                type: "button",
                onclick: async () => {
                  try {
                    const result = await api.inviteFriend(friend.id);
                    toast(`已邀请 ${safeText(friend.name, "好友")} 加入房间 ${result.roomCode}`, "success");
                    if (modal) modal.close();
                  } catch (error) {
                    toast(error && error.message ? error.message : "邀请失败", "error");
                  }
                },
              },
              "邀请",
            ),
          ),
        ),
      );
    } catch (error) {
      list.replaceChildren(h("p", { class: "friends-sub", text: error && error.message ? error.message : "加载好友失败" }));
    }
  }

  async function loadFriendRelations() {
    if (!store.user || store.user.isGuest) return;
    try {
      const data = await api.fetchFriends();
      friendIds.clear();
      outgoingFriendIds.clear();
      incomingFriendIds.clear();
      for (const friend of data && Array.isArray(data.friends) ? data.friends : []) {
        friendIds.add(friend.id);
      }
      for (const request of data && Array.isArray(data.outgoing) ? data.outgoing : []) {
        if (request.user) outgoingFriendIds.add(request.user.id);
      }
      for (const request of data && Array.isArray(data.incoming) ? data.incoming : []) {
        if (request.user) incomingFriendIds.add(request.user.id);
      }
      render();
    } catch {
      /* 好友关系加载失败不影响对局 */
    }
  }

  const ticker = setInterval(tick, 200);
  unsubscribe.push(() => clearInterval(ticker));

  updateNetBanner(store.connection);
  render();
  loadFriendRelations();
  tick();

  return {
    el,
    destroy() {
      destroyed = true;
      for (const off of unsubscribe) off();
      document.removeEventListener("keydown", onGlobalKeyDown);
      clearInterval(ticker);
      clearTimeout(loadingHintTimer);
      document.title = "词影竞技场 Ciying Arena";
    },
  };
}
