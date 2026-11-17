/**
 * UI 小工具：DOM 构造、图标、toast、modal、主题、格式化。
 *
 * 安全约定：本项目禁止使用 innerHTML 拼接用户输入。所有文本节点都通过
 * textContent / createTextNode 写入；这里的 h() 也只接受字符串子节点。
 */

import {
  MODE_META,
  MODES,
  ROOM_STATUS_LABELS,
  ROUND_RESULT_LABELS,
  modeMeta,
} from "./constants.js";
import { isAvatarDataUrl } from "./avatar.js";

const SVG_NS = "http://www.w3.org/2000/svg";

/* ------------------------------------------------------------------ */
/* DOM                                                                 */
/* ------------------------------------------------------------------ */

export function appendChildren(parent, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) {
      appendChildren(parent, child);
      continue;
    }
    if (typeof child === "string" || typeof child === "number") {
      parent.appendChild(document.createTextNode(String(child)));
      continue;
    }
    if (child instanceof Node) {
      parent.appendChild(child);
      continue;
    }
    parent.appendChild(document.createTextNode(String(child)));
  }
}

/**
 * 创建 HTML 元素。
 * @param {string} tag
 * @param {object} [props]
 * @param {...any} children
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === "class") {
        el.className = String(value);
      } else if (key === "text") {
        el.textContent = String(value);
      } else if (key === "dataset") {
        for (const [dataKey, dataValue] of Object.entries(value)) {
          if (dataValue !== null && dataValue !== undefined) {
            el.dataset[dataKey] = String(dataValue);
          }
        }
      } else if (key === "style" && typeof value === "object") {
        Object.assign(el.style, value);
      } else if (key === "on" && typeof value === "object") {
        for (const [eventName, handler] of Object.entries(value)) {
          if (typeof handler === "function") el.addEventListener(eventName, handler);
        }
      } else if (key.startsWith("on") && typeof value === "function") {
        el.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (key === "value" || key === "checked" || key === "disabled") {
        el[key] = value;
      } else if (key === "for") {
        el.setAttribute("for", String(value));
      } else if (key === "selected") {
        el.selected = Boolean(value);
      } else {
        el.setAttribute(key, value === true ? "" : String(value));
      }
    }
  }
  appendChildren(el, children);
  return el;
}

/** 创建 SVG 元素（namespace 必须显式指定）。 */
export function svgEl(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      el.setAttribute(key, String(value));
    }
  }
  appendChildren(el, children);
  return el;
}

/* ------------------------------------------------------------------ */
/* 图标（内联 SVG，无外部依赖）                                         */
/* ------------------------------------------------------------------ */

const ICON_PATHS = {
  copy: [
    "M10 8h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Z",
    "M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2",
  ],
  arrowLeft: ["M19 12H5", "m12 19-7-7 7-7"],
  refresh: ["M21 12a9 9 0 1 1-2.64-6.36", "M21 3v6h-6"],
  sun: [
    "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z",
    "M12 1v2",
    "M12 21v2",
    "M4.22 4.22l1.42 1.42",
    "M18.36 18.36l1.42 1.42",
    "M1 12h2",
    "M21 12h2",
    "M4.22 19.78l1.42-1.42",
    "M18.36 5.64l1.42-1.42",
  ],
  moon: ["M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z"],
  crown: ["M3 7l4 4 5-6 5 6 4-4v11H3Z"],
  eye: [
    "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z",
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  ],
  play: ["M7 4v16l13-8Z"],
  check: ["m20 6-11 11-5-5"],
  x: ["M18 6 6 18", "m6 6 12 12"],
  send: ["m22 2-7 20-4-9-9-4Z", "M22 2 11 13"],
  logout: [
    "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4",
    "m16 17 5-5-5-5",
    "M21 12H9",
  ],
  users: [
    "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2",
    "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z",
    "M23 21v-2a4 4 0 0 0-3-3.87",
    "M16 3.13a4 4 0 0 1 0 7.75",
  ],
  link: [
    "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71",
    "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
  ],
  trophy: [
    "M8 21h8",
    "M12 17v4",
    "M7 4h10v4a5 5 0 0 1-10 0Z",
    "M7 6H4a3 3 0 0 0 3 3",
    "M17 6h3a3 3 0 0 1-3 3",
  ],
  user: [
    "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2",
    "M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z",
  ],
  lock: [
    "M5 11h14v10H5Z",
    "M8 11V7a4 4 0 0 1 8 0v4",
  ],
  wifiOff: ["M2 2l20 20", "M8.5 16.5a5 5 0 0 1 7 0", "M5 12.5a10 10 0 0 1 2-1.2", "M12 20h.01"],
  bolt: ["M13 2 3 14h7l-1 8 10-12h-7Z"],
  chart: ["M3 21h18", "M7 21V10", "M12 21V4", "M17 21v-7"],
  clock: [
    "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z",
    "M12 6v6l4 2",
  ],
  help: [
    "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z",
    "M9.1 9a3 3 0 1 1 5.8 1c-.6 1.2-1.9 1.8-2.4 2.7",
    "M12 17h.01",
  ],
  image: [
    "M4 5h16v14H4Z",
    "M8 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
    "M4 17l5-5 4 4 3-3 4 4",
  ],
  calendar: ["M5 5h14v15H5Z", "M8 3v4", "M16 3v4", "M5 9h14"],
  arrowRight: ["M5 12h14", "M13 6l6 6-6 6"],
  bell: ["M6 9a6 6 0 1 1 12 0c0 5 2 6 2 7H4c0-1 2-2 2-7Z", "M10 20h4"],
  door: ["M13 4H5v16h8", "M17 8l4 4-4 4", "M21 12H9"],
};

export function icon(name, size = 18) {
  const svg = svgEl("svg", {
    viewBox: "0 0 24 24",
    width: size,
    height: size,
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    focusable: "false",
    class: "icon",
  });
  for (const d of ICON_PATHS[name] || []) svg.appendChild(svgEl("path", { d }));
  return svg;
}

/* ------------------------------------------------------------------ */
/* 格式化                                                              */
/* ------------------------------------------------------------------ */

export function formatDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0) / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = Math.floor(total % 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function formatClock(ts) {
  const date = new Date(Number(ts) || Date.now());
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** 统计页用：毫秒 -> 可读耗时。 */
export function formatDurationMs(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return "—";
  if (value < 1000) return `${Math.round(value)} 毫秒`;
  if (value < 60000) return `${(value / 1000).toFixed(1)} 秒`;
  const minutes = Math.floor(value / 60000);
  const seconds = Math.round((value % 60000) / 1000);
  return `${minutes} 分 ${seconds} 秒`;
}

/** 0..1 比例 -> 百分比文本。 */
export function formatPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return `${(number * 100).toFixed(1)}%`;
}

export function formatRelative(ts) {
  const diff = Date.now() - Number(ts || 0);
  if (!Number.isFinite(diff) || diff < 0) return "刚刚";
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

export function modeLabel(mode) {
  return modeMeta(mode).label;
}

export function statusLabel(status) {
  return ROOM_STATUS_LABELS[status] || status || "未知";
}

export function roundResultLabel(result) {
  return ROUND_RESULT_LABELS[result] || "";
}

export function modeClass(mode) {
  return MODES.includes(mode) ? `mode-${mode}` : "mode-duel";
}

export function initials(name) {
  const chars = Array.from(String(name || "?").trim());
  return chars.slice(0, 1).join("") || "?";
}

/** 展示兜底：空值以及字面量 null/undefined 字符串都替换成合理文案。 */
export function safeText(value, fallback = "—") {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  if (!text || /^(null|undefined)$/i.test(text)) return fallback;
  return text;
}

export function colorForName(name) {
  let hash = 0;
  for (const char of String(name || "?")) hash = (hash * 31 + char.codePointAt(0)) % 360;
  return `hsl(${hash} 62% 48%)`;
}

/** 头像：优先显示上传图片 data URL，其次 emoji/预设头像，最后回退到名字首字。 */
export function avatarNode(name, avatar, extraClass = "") {
  const value = String(avatar || "").trim();
  const displayName = safeText(name, "未知玩家");
  const classNames = ["avatar"];
  if (extraClass) classNames.push(extraClass);
  if (value) classNames.push("has-avatar");
  if (isAvatarDataUrl(value)) {
    return h(
      "span",
      { class: classNames.join(" "), title: displayName },
      h("img", {
        class: "avatar-img",
        src: value,
        alt: displayName,
        loading: "lazy",
      }),
    );
  }
  return h(
    "span",
    {
      class: classNames.join(" "),
      title: displayName,
      style: value ? undefined : { background: colorForName(displayName) },
    },
    value || initials(displayName),
  );
}

export function formatDateTime(timestamp) {
  const value = Number(timestamp);
  if (!value) return "时间未知";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return new Date(value).toLocaleString();
  }
}

export function connectionMeta(connection) {
  switch (connection) {
    case "open":
      return { label: "已连接", tone: "ok" };
    case "connecting":
      return { label: "连接中", tone: "warn" };
    case "reconnecting":
      return { label: "重连中", tone: "warn" };
    case "closed":
      return { label: "已断开", tone: "bad" };
    default:
      return { label: "未连接", tone: "muted" };
  }
}

export function isCjkWord(word) {
  const chars = Array.from(String(word || "").trim());
  return (
    chars.length === 4 && chars.every((char) => /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(char))
  );
}

/* ------------------------------------------------------------------ */
/* Toast                                                               */
/* ------------------------------------------------------------------ */

const TOAST_LIMIT = 4;

export function toast(message, type = "info", ttl = 3200) {
  const root = document.getElementById("toast-root");
  if (!root) return;
  const text = String(message === undefined || message === null ? "" : message).trim();
  if (!text) return;
  const tone = type === "error" ? "error" : type === "warn" ? "warn" : type === "success" ? "success" : "info";
  const item = h("div", { class: `toast toast-${tone}`, role: "status" }, text);
  root.appendChild(item);
  while (root.children.length > TOAST_LIMIT) root.removeChild(root.firstElementChild);
  requestAnimationFrame(() => item.classList.add("is-visible"));
  const remove = () => {
    item.classList.remove("is-visible");
    setTimeout(() => item.remove(), 220);
  };
  const timer = setTimeout(remove, Math.max(1200, ttl));
  item.addEventListener("click", () => {
    clearTimeout(timer);
    remove();
  });
}

/* ------------------------------------------------------------------ */
/* Modal                                                               */
/* ------------------------------------------------------------------ */

export function openModal({ title, content, onClose }) {
  const root = document.getElementById("modal-root");
  if (!root) return null;

  const closeButton = h(
    "button",
    { class: "icon-btn modal-close", type: "button", "aria-label": "关闭" },
    icon("x", 18),
  );
  const dialog = h(
    "div",
    { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": title || "对话框" },
    closeButton,
    h("div", { class: "modal-body" }, content),
  );
  const overlay = h("div", { class: "modal-overlay" }, dialog);

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKeyDown);
    overlay.classList.remove("is-open");
    setTimeout(() => overlay.remove(), 200);
    if (typeof onClose === "function") onClose();
  }
  function onKeyDown(event) {
    if (event.key === "Escape") close();
  }

  closeButton.addEventListener("click", close);
  overlay.addEventListener("pointerdown", (event) => {
    if (event.target === overlay) close();
  });
  document.addEventListener("keydown", onKeyDown);
  root.replaceChildren(overlay);
  requestAnimationFrame(() => overlay.classList.add("is-open"));
  setTimeout(() => {
    const target = dialog.querySelector("input, button:not(.modal-close)");
    if (target) target.focus();
  }, 40);

  return { close, dialog };
}

/* ------------------------------------------------------------------ */
/* 剪贴板                                                              */
/* ------------------------------------------------------------------ */

export async function copyText(text) {
  const value = String(text || "");
  if (!value) return false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* 回退到 execCommand */
  }
  try {
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 主题                                                                */
/* ------------------------------------------------------------------ */

const THEME_KEY = "ciying.theme";

export function applyTheme(theme) {
  const next = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* ignore */
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", next === "light" ? "#f1f5f9" : "#0b1220");
  return next;
}

export function currentTheme() {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function initTheme() {
  let saved = "";
  try {
    saved = localStorage.getItem(THEME_KEY) || "";
  } catch {
    saved = "";
  }
  if (saved === "light" || saved === "dark") {
    applyTheme(saved);
    return;
  }
  const prefersLight = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
  applyTheme(prefersLight ? "light" : "dark");
}

export function toggleTheme() {
  return applyTheme(currentTheme() === "dark" ? "light" : "dark");
}

/* ------------------------------------------------------------------ */
/* 通用组件                                                            */
/* ------------------------------------------------------------------ */

export function connectionBadge(connection) {
  const meta = connectionMeta(connection);
  return h(
    "span",
    { class: `conn-badge conn-${meta.tone}` },
    h("span", { class: "conn-dot" }),
    h("span", { text: meta.label }),
  );
}

export function modeBadge(mode, extraClass = "") {
  const meta = modeMeta(mode);
  return h(
    "span",
    { class: `mode-badge ${modeClass(mode)} ${extraClass}`.trim() },
    h("span", { class: "mode-badge-dot" }),
    h("span", { text: meta.shortLabel }),
  );
}

export function emptyState(title, description) {
  return h(
    "div",
    { class: "empty-state" },
    h("p", { class: "empty-title", text: title }),
    description ? h("p", { class: "empty-desc", text: description }) : null,
  );
}

export function loadingBlock(text = "加载中…") {
  return h(
    "div",
    { class: "loading-block" },
    h("span", { class: "spinner", "aria-hidden": "true" }),
    h("span", { text }),
  );
}
