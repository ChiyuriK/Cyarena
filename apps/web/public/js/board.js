/**
 * 棋盘渲染（SVG）。
 *
 * 协议字段来自 shared 的 TileFeedback：
 *   { bg: "correct" | "none", char, description, paths: [{ d, fill, opacity, dx, dy }] }
 *
 * 每个格子：viewBox="0 0 1024 1024"，笔画坐标来自 1024 网格，渲染时 y 轴翻转
 * `scale(1,-1) translate(0,-900)`（等价于 y' = 900 - y）。
 * fill：
 *   correct -> #0d9488（青绿）
 *   shadow  -> #0f172a（深色，浅色格子背景上可见）
 *   white   -> #ffffff（绿底上的完整答案笔画）
 */

import { h, svgEl } from "./ui.js";

const FILL_COLORS = {
  correct: "#0d9488",
  shadow: "#0f172a",
  white: "#ffffff",
};

const MAX_COLUMNS = 4;

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1;
  return Math.min(1, Math.max(0, number));
}

function createTile(tile, index) {  const paths = tile && Array.isArray(tile.paths) ? tile.paths : [];
  const svg = svgEl("svg", {
    viewBox: "0 0 1024 1024",
    class: "tile-svg",
    role: "img",
    "aria-label": `第 ${index + 1} 格`,
    focusable: "false",
  });
  const group = svgEl("g", { transform: "scale(1,-1) translate(0,-900)" });
  for (const path of paths) {
    if (!path || typeof path.d !== "string" || !path.d) continue;
    const attrs = {
      d: path.d,
      fill: FILL_COLORS[path.fill] || FILL_COLORS.shadow,
      opacity: clamp01(path.opacity),
    };
    if (Number(path.dx) || Number(path.dy)) {
      attrs.transform = `translate(${Number(path.dx) || 0} ${Number(path.dy) || 0})`;
    }
    group.appendChild(svgEl("path", attrs));
  }
  svg.appendChild(group);

  const classes = ["tile", tile && tile.bg === "correct" ? "is-correct" : "is-plain"];
  return h("div", { class: classes.join(" "), "aria-hidden": "true" }, svg);
}

export function feedbackTileNode(tile, index = 0) {
  return createTile(tile, index);
}

function createEmptyTile() {
  return h("div", { class: "tile is-empty", "aria-hidden": "true" });
}

function createRowHead(row, index) {
  return h(
    "div",
    { class: "board-row-head" },
    h("span", { class: "row-index", text: String(index + 1).padStart(2, "0") }),
    h("span", { class: "row-player", title: row.playerName || "", text: row.playerName || "未知玩家" }),
    h("span", { class: "row-word", title: row.word || "", text: row.word || "" }),
  );
}

function createFilledRow(row, index, columns) {
  const tiles = [];
  const sourceTiles = Array.isArray(row.tiles) ? row.tiles : [];
  for (let column = 0; column < columns; column += 1) {
    tiles.push(sourceTiles[column] ? createTile(sourceTiles[column], column) : createEmptyTile());
  }
  return h(
    "div",
    { class: `board-row${row.correct ? " is-correct" : ""}` },
    createRowHead(row, index),
    h("div", { class: "tiles", style: { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } }, tiles),
  );
}

function createEmptyRow(index, columns) {
  const tiles = [];
  for (let column = 0; column < columns; column += 1) tiles.push(createEmptyTile());
  return h(
    "div",
    { class: "board-row is-empty-row" },
    h(
      "div",
      { class: "board-row-head" },
      h("span", { class: "row-index", text: String(index + 1).padStart(2, "0") }),
      h("span", { class: "row-player", text: "待猜测" }),
      h("span", { class: "row-word", text: "" }),
    ),
    h("div", { class: "tiles", style: { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } }, tiles),
  );
}

function roundSignature(round) {
  if (!round) return "none";
  const rows = Array.isArray(round.rows) ? round.rows : [];
  const parts = rows.map((row) => {
    const tiles = Array.isArray(row.tiles) ? row.tiles : [];
    return [
      row.id,
      row.playerName,
      row.word,
      row.correct ? 1 : 0,
      tiles
        .map((tile) => `${tile.bg}:${tile.char}:${Array.isArray(tile.paths) ? tile.paths.length : 0}`)
        .join(","),
    ].join("|");
  });
  return `${round.index}:${round.maxRows}:${round.answer || ""}:${parts.join(";")}`;
}

/**
 * 渲染整张棋盘。若与上次内容相同则跳过 DOM 重建。
 * @param {HTMLElement} container
 * @param {object|null} round RoomState.round
 */
export function renderBoard(container, round) {
  if (!container) return;
  const signature = roundSignature(round);
  if (container.dataset.signature === signature) return;
  container.dataset.signature = signature;

  const maxRows = Math.max(1, Number(round && round.maxRows) || 6);
  const rows = round && Array.isArray(round.rows) ? round.rows : [];
  const columns = MAX_COLUMNS;
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < maxRows; index += 1) {
    if (rows[index]) fragment.appendChild(createFilledRow(rows[index], index, columns));
    else fragment.appendChild(createEmptyRow(index, columns));
  }
  container.replaceChildren(fragment);
  container.setAttribute("aria-label", `棋盘，已猜测 ${rows.length} 行，共 ${maxRows} 行`);
}

export function boardIsComplete(round) {
  if (!round) return false;
  const rows = Array.isArray(round.rows) ? round.rows : [];
  return rows.length >= (Number(round.maxRows) || 6);
}
