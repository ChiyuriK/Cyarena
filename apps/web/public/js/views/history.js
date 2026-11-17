/**
 * 我的战绩（#/history）。练习模式不返回。
 */

import * as api from "../api.js";
import { store, on } from "../store.js";
import {
  h,
  icon,
  modeBadge,
  modeLabel,
  loadingBlock,
  currentTheme,
  toggleTheme,
  avatarNode,
  formatDateTime,
  safeText,
} from "../ui.js";

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function playersOf(row) {
  return Array.isArray(row && row.players) ? row.players.filter(Boolean) : [];
}

function meOf(row) {
  const userId = store.user && store.user.id;
  return playersOf(row).find((player) => player.id === userId) || null;
}

function opponentsOf(row, me) {
  const players = playersOf(row);
  if (me && me.team) {
    return players.filter((player) => player !== me && player.team !== me.team);
  }
  return players.filter((player) => player !== me);
}

function playerName(player, fallback = "未知玩家") {
  return safeText(player && player.name, fallback);
}

function rowOpponentNames(row, me) {
  const fromPlayers = opponentsOf(row, me).map((player) => playerName(player));
  if (fromPlayers.length > 0) return fromPlayers;
  const names = Array.isArray(row && row.opponentNames)
    ? row.opponentNames.map((name) => safeText(name, "")).filter(Boolean)
    : [];
  return names.length > 0 ? names : ["未知玩家"];
}

function rowOpponentAvatars(row, me) {
  const map = new Map();
  for (const player of opponentsOf(row, me)) {
    map.set(playerName(player), safeText(player && player.avatar, ""));
  }
  if (Array.isArray(row && row.opponents)) {
    for (const opponent of row.opponents) {
      if (!opponent) continue;
      const name = safeText(opponent.name, "");
      if (name && !map.has(name)) map.set(name, safeText(opponent.avatar, ""));
    }
  }
  return map;
}

function winnerIsMe(row, me) {
  if (!me || row.isDraw) return false;
  if (row.mode === "team2v2" && row.winnerTeam && me.team) {
    return me.team === row.winnerTeam;
  }
  if (row.winnerId) return row.winnerId === me.id;
  if (row.winnerTeam && me.team) return me.team === row.winnerTeam;
  if (row.mode === "team2v2" && me.team) {
    const { a, b } = teamSetWins(row);
    return me.team === "A" ? a > b : b > a;
  }
  if (row.mode === "ffa3") {
    const others = playersOf(row).filter((player) => player.id !== me.id);
    const myScore = finite(me.score);
    return others.length > 0 && others.every((player) => myScore > finite(player.score));
  }
  const opponent = opponentsOf(row, me)[0] || null;
  const myWins = finite(me.setWins);
  const otherWins = finite(opponent && opponent.setWins);
  if (myWins !== otherWins) return myWins > otherWins;
  const myScore = finite(me.score);
  const otherScore = finite(opponent && opponent.score);
  if (myScore !== otherScore) return myScore > otherScore;
  if (row.forfeit && row.ratingDelta !== null && row.ratingDelta !== undefined) {
    return finite(row.ratingDelta) > 0;
  }
  return false;
}

function resultMeta(row, me) {
  if (row.isDraw) return { label: "平局", tone: "draw" };
  const hasKnownWinner = Boolean(row.winnerId || row.winnerTeam);
  if (!me && !hasKnownWinner) return { label: "结果未知", tone: "draw" };
  const win = winnerIsMe(row, me);
  if (row.forfeit) {
    return win
      ? { label: "断线判胜", tone: "win forfeit" }
      : { label: "断线判负", tone: "loss forfeit" };
  }
  return win ? { label: "胜利", tone: "win" } : { label: "失败", tone: "loss" };
}

function teamSetWins(row) {
  const history = Array.isArray(row.setHistory) ? row.setHistory : [];
  if (history.length > 0) {
    let a = 0;
    let b = 0;
    for (const entry of history) {
      if (entry && entry.winnerTeam === "A") a += 1;
      else if (entry && entry.winnerTeam === "B") b += 1;
    }
    return { a, b };
  }
  const players = playersOf(row);
  let a = 0;
  let b = 0;
  for (const player of players) {
    if (player.team === "A") a = Math.max(a, finite(player.setWins));
    else if (player.team === "B") b = Math.max(b, finite(player.setWins));
  }
  return { a, b };
}

function bigScoreText(row, me) {
  const players = playersOf(row);
  if (row.mode === "team2v2") {
    const { a, b } = teamSetWins(row);
    if (row.forfeit && !row.isDraw && a === 0 && b === 0) {
      return row.winnerTeam === "A" ? "A 1 比 0 B" : "A 0 比 1 B";
    }
    return `A ${a} 比 ${b} B`;
  }
  if (row.mode === "ffa3") {
    if (players.length > 0) {
      return players.map((player) => finite(player.score)).join(":");
    }
    const scores =
      row.smallScores && typeof row.smallScores === "object" ? Object.values(row.smallScores) : [];
    return scores.length > 0 ? scores.map((value) => finite(value)).join(":") : "—";
  }
  const opponent = opponentsOf(row, me)[0] || null;
  if (me || opponent) {
    const mine = finite(me && me.setWins);
    const other = finite(opponent && opponent.setWins);
    if (row.forfeit && !row.isDraw && mine === 0 && other === 0) {
      return winnerIsMe(row, me) ? "1:0" : "0:1";
    }
    return `${mine}:${other}`;
  }
  const userId = store.user && store.user.id;
  const setWins = row.setWins && typeof row.setWins === "object" ? row.setWins : {};
  if (userId && setWins[userId] !== undefined) {
    const mine = finite(setWins[userId]);
    const otherKey = Object.keys(setWins).find((key) => key !== userId);
    const other = finite(otherKey === undefined ? 0 : setWins[otherKey]);
    if (row.forfeit && !row.isDraw && mine === 0 && other === 0) {
      return winnerIsMe(row, me) ? "1:0" : "0:1";
    }
    return `${mine}:${other}`;
  }
  const smallScores =
    row.smallScores && typeof row.smallScores === "object" ? row.smallScores : {};
  if (userId && smallScores[userId] !== undefined) {
    const mine = finite(smallScores[userId]);
    const otherKey = Object.keys(smallScores).find((key) => key !== userId);
    return `${mine}:${finite(otherKey === undefined ? 0 : smallScores[otherKey])}`;
  }
  return "—";
}

function orderedScorePlayers(row, me) {
  const players = playersOf(row);
  if (row.mode === "ffa3") return players;
  return [me, ...opponentsOf(row, me)].filter(Boolean);
}

function setScoreText(row, me, entry) {
  if (row.mode === "team2v2") {
    const teamScores =
      entry.teamScores && typeof entry.teamScores === "object" ? entry.teamScores : {};
    return `A ${finite(teamScores.A)} 比 ${finite(teamScores.B)} B`;
  }
  const scores = entry.scores && typeof entry.scores === "object" ? entry.scores : {};
  const ordered = orderedScorePlayers(row, me);
  if (ordered.length > 0) {
    return ordered.map((player) => finite(scores[player.id])).join(":");
  }
  if (row.setWins && typeof row.setWins === "object") {
    const myId = store.user && store.user.id;
    if (myId && row.setWins[myId] !== undefined) {
      const otherKey = Object.keys(row.setWins).find((key) => key !== myId);
      return `${finite(row.setWins[myId])}:${finite(
        otherKey === undefined ? 0 : row.setWins[otherKey],
      )}`;
    }
  }
  return "—";
}

function setWinnerText(row, me, entry) {
  const players = playersOf(row);
  if (entry.winnerTeam) return `${entry.winnerTeam} 队胜`;
  const winnerId = safeText(entry.winnerId, "");
  if (!winnerId) return "未结束";
  if (me && winnerId === me.id) return "你胜";
  const winner = players.find((player) => player.id === winnerId);
  if (winner) {
    const name = playerName(winner);
    return me && name === playerName(me) ? "你胜" : `${name} 胜`;
  }
  return "对手胜";
}

function finalFallbackSetText(row, me) {
  if (row.mode === "team2v2") {
    const players = playersOf(row);
    const scores =
      row.smallScores && typeof row.smallScores === "object" ? row.smallScores : {};
    const sumFor = (team) =>
      players
        .filter((player) => player.team === team)
        .reduce((sum, player) => sum + finite(scores[player.id] ?? player.score), 0);
    return `A ${sumFor("A")} 比 ${sumFor("B")} B`;
  }
  const ordered = orderedScorePlayers(row, me);
  const scores =
    row.smallScores && typeof row.smallScores === "object" ? row.smallScores : {};
  if (ordered.length > 0 && ordered.some((player) => scores[player.id] !== undefined)) {
    return ordered.map((player) => finite(scores[player.id] ?? player.score)).join(":");
  }
  if (row.mode === "ffa3") {
    const values = playersOf(row).map((player) => finite(player.score));
    if (values.length > 0) return values.join(":");
  }
  return bigScoreText(row, me);
}

export function createHistoryView(ctx) {
  let rows = null;
  let loading = false;
  let error = null;
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
  const changelogButton = h(
    "button",
    { class: "btn btn-ghost btn-sm", type: "button", onclick: () => ctx.goChangelog() },
    "更新日志",
  );
  const idiomsButton = h(
    "button",
    { class: "btn btn-ghost btn-sm", type: "button", onclick: () => ctx.goIdioms() },
    "最近成语",
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
        h("h1", { class: "brand-title", text: "我的战绩" }),
        h("p", { class: "brand-sub", text: "Ciying Arena History" }),
      ),
    ),
    h(
      "div",
      { class: "header-actions" },
      idiomsButton,
      changelogButton,
      helpButton,
      themeButton,
    ),
  );

  const body = h("div", { class: "history-body" });

  function renderRow(row) {
    const me = meOf(row);
    const meta = resultMeta(row, me);
    const opponents = rowOpponentNames(row, me);
    const opponentAvatars = rowOpponentAvatars(row, me);
    const setHistory = Array.isArray(row.setHistory) ? row.setHistory : [];
    const mode = safeText(row.mode, "duel");
    const delta = row.ratingDelta;
    return h(
      "article",
      { class: `history-card ${meta.tone}` },
      h(
        "div",
        { class: "history-card-head" },
        h(
          "div",
          { class: "history-head-main" },
          avatarNode(me ? playerName(me, "我") : "我", me ? me.avatar : "", "avatar-xs"),
          modeBadge(mode),
          h("span", { class: "history-mode", text: safeText(modeLabel(mode), "未知模式") }),
          h("span", { class: "history-date", text: formatDateTime(row.endedAt) }),
        ),
        h("span", { class: `history-result ${meta.tone}`, text: meta.label }),
      ),
      h(
        "div",
        { class: "history-opponents" },
        ...opponents.map((name) =>
          h(
            "span",
            { class: "history-opponent" },
            avatarNode(name, opponentAvatars.get(name) || "", "avatar-xs"),
            h("span", { text: safeText(name, "未知玩家") }),
          ),
        ),
      ),
      h(
        "div",
        { class: "history-scoreline" },
        h("span", { class: "history-score-label", text: "大比分" }),
        h("strong", { class: "history-bigscore", text: bigScoreText(row, me) }),
        delta !== null && delta !== undefined
          ? h(
              "span",
              {
                class: `history-rating ${
                  finite(delta) > 0 ? "up" : finite(delta) < 0 ? "down" : "flat"
                }`,
                text: `${finite(delta) > 0 ? "+" : ""}${finite(delta)} 分`,
              },
            )
          : null,
      ),
      setHistory.length > 0
        ? h(
            "div",
            { class: "history-sets" },
            ...setHistory.map((entry) =>
              h(
                "div",
                { class: "history-set" },
                h("span", {
                  class: "history-set-no",
                  text:
                    entry === null ||
                    entry === undefined ||
                    entry.setNumber === null ||
                    entry.setNumber === undefined ||
                    entry.setNumber === ""
                      ? "第 1 小局"
                      : `第 ${finite(entry.setNumber, 1)} 小局`,
                }),
                h("strong", {
                  class: "history-set-score",
                  text: setScoreText(row, me, entry || {}),
                }),
                h("span", {
                  class: "history-set-winner",
                  text: setWinnerText(row, me, entry || {}),
                }),
              ),
            ),
          )
        : h(
            "div",
            { class: "history-sets" },
            h(
              "div",
              { class: "history-set" },
              h("span", { class: "history-set-no", text: "本局最终比分" }),
              h("strong", {
                class: "history-set-score",
                text: finalFallbackSetText(row, me),
              }),
              h("span", {
                class: "history-set-winner",
                text: safeText(row.winnerName, "未知胜者"),
              }),
            ),
          ),
      row.forfeit
        ? h("p", { class: "history-note", text: "本局因离开或断线超时结束。" })
        : null,
    );
  }

  function renderBody() {
    refreshButton.classList.toggle("is-spinning", loading);
    if (!store.user || store.user.isGuest) {
      body.replaceChildren(
        h(
          "div",
          { class: "stats-gate" },
          h("span", { class: "stats-gate-icon" }, icon("lock", 26)),
          h("h3", { class: "guest-title", text: "登录后查看我的战绩" }),
          h("p", { class: "guest-desc", text: "游客对局不会写入战绩记录。" }),
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
          h("p", { class: "guest-desc", text: "请重新登录后查看战绩。" }),
          h(
            "button",
            { class: "btn btn-primary", type: "button", onclick: () => ctx.openAuth("login") },
            "重新登录",
          ),
        ),
      );
      return;
    }
    if (loading && !rows) {
      body.replaceChildren(loadingBlock("正在加载战绩…"));
      return;
    }
    if (error) {
      body.replaceChildren(
        h(
          "div",
          { class: "stats-error" },
          h("p", { class: "empty-title", text: "战绩加载失败" }),
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
          h("p", { class: "empty-title", text: "还没有战绩" }),
          h("p", {
            class: "empty-desc",
            text: "完成一场排位对局后再来看看吧。练习模式不计入战绩。",
          }),
        ),
      );
      return;
    }
    body.replaceChildren(
      h("div", { class: "history-list" }, ...rows.map((row) => renderRow(row))),
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
    if (force) rows = null;
    renderBody();
    try {
      const data = await api.fetchMyMatches(20);
      if (destroyed || currentRequest !== requestId) return;
      rows = Array.isArray(data) ? data : [];
    } catch (err) {
      if (destroyed || currentRequest !== requestId) return;
      if (err && err.status === 401) unauthorized = true;
      else error = err && err.message ? err.message : "网络异常";
    } finally {
      if (!destroyed && currentRequest === requestId) {
        loading = false;
        renderBody();
      }
    }
  }

  const el = h(
    "div",
    { class: "view history-view" },
    header,
    h(
      "main",
      { class: "history-main" },
      h(
        "section",
        { class: "panel history-panel" },
        h(
          "div",
          { class: "leaderboard-head" },
          h(
            "div",
            {},
            h("h2", { class: "page-title", text: "最近 20 场排位" }),
            h("p", { class: "page-sub", text: "练习模式不计入战绩。" }),
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

  renderBody();
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
