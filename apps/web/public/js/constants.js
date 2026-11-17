/**
 * 前端常量。
 *
 * 这些值与 `packages/shared/src/index.ts` 保持一致，但浏览器无法直接 import
 * TypeScript，因此这里保留一份纯 JS 镜像。若共享类型中的数值调整，需要同步修改这里。
 */

export const MODES = ["duel", "ffa3", "team2v2", "practice"];
/** 参与天梯/排行榜的模式，练习模式不计入。 */
export const RANKED_MODES = ["duel", "ffa3", "team2v2"];

export const STREAK_VARIANTS = ["standard", "free", "advanced"];
export const STREAK_META = {
  standard: { label: "标准", hint: "标准词库，连续答对四字成语。" },
  free: { label: "自由", hint: "四个汉字就能猜，不要求来自词库。" },
  advanced: { label: "进阶", hint: "更难词库，挑战更高连胜。" },
};
export function isStreakVariant(value) {
  return STREAK_VARIANTS.includes(value);
}

/** 团队战使用该哨兵表示“人数不限”。 */
export const TEAM_UNLIMITED_CAPACITY = 99;

export const MODE_META = {
  duel: {
    mode: "duel",
    label: "1v1 单挑",
    shortLabel: "1v1",
    capacity: 2,
    teams: false,
    description:
      "两名玩家抢答同一张棋盘，每轮先猜中者得 1 分；小局先到 11 分且领先 2 分获胜，大比分由房主选择 1/3/5/7 局。",
  },
  ffa3: {
    mode: "ffa3",
    label: "3 人混战",
    shortLabel: "3 人",
    capacity: 3,
    teams: false,
    description: "三名玩家各自计分，先到 7 分获胜；第 6 行仍未猜中时其他玩家各得 1 分。",
  },
  team2v2: {
    mode: "team2v2",
    label: "团队战",
    shortLabel: "团队",
    capacity: TEAM_UNLIMITED_CAPACITY,
    teams: true,
    unlimited: true,
    description:
      "分 A/B 两队，每队人数不限；队伍共享小局分。赛制同 1v1：小局先到 11 分且领先 2 分，大比分由房主选择 1/3/5/7 局。",
  },
  practice: {
    mode: "practice",
    label: "个人练习",
    shortLabel: "练习",
    capacity: 1,
    teams: false,
    description: "单人练习一张 6 行棋盘，猜中或 6 行用完即结束；不计天梯与总统计。",
  },
};

/** 非 1v1 / 团队战的旧字段。 */
export const TARGET_SCORE = 3;
export const MAX_ROUNDS = 7;
export const ROWS_PER_ROUND = 6;
/** 每次抢答后的个人冷却（服务端强制）。 */
export const GUESS_COOLDOWN_MS = 1000;
/** 本轮无人作答的倒计时；每次有效猜测会重置。 */
export const IDLE_ROUND_TIMEOUT_MS = 60000;
/** 兼容旧字段名。 */
export const ROUND_DURATION_MS = IDLE_ROUND_TIMEOUT_MS;
export const ROUND_END_DELAY_MS = 2500;
/** 小局结束后结算页展示时间。 */
export const SET_END_DELAY_MS = 5000;
export const COUNTDOWN_MS = 3000;
/** 离开/断线后保留座位的时间。 */
export const LEAVE_GRACE_MS = 180000;
/** 三人混战目标分。 */
export const FFA_TARGET_SCORE = 7;

export const NAME_MAX = 16;
export const CHAT_MAX = 200;
export const GUESS_LENGTH = 4;

/** 1v1 / 团队战小局规则。 */
export const DUEL_POINTS_TO_WIN = 11;
export const DUEL_POINT_LEAD = 2;
export const DUEL_DEFAULT_BEST_OF = 3;
export const DUEL_BEST_OF_OPTIONS = [1, 3, 5, 7];

export function setsToWinForBestOf(bestOf) {
  return Math.floor((Number(bestOf) + 1) / 2);
}

export function isDuelBestOf(value) {
  return typeof value === "number" && DUEL_BEST_OF_OPTIONS.includes(value);
}

/** 例：1 -> “1 局定胜负”，3 -> “3 局 2 胜”，7 -> “7 局 4 胜”。 */
export function bestOfLabel(bestOf) {
  const value = isDuelBestOf(bestOf) ? bestOf : DUEL_DEFAULT_BEST_OF;
  const setsToWin = setsToWinForBestOf(value);
  return value === 1 ? "1 局定胜负" : `${value} 局 ${setsToWin} 胜`;
}

/** 哪些模式使用“小局 + 大比分”。 */
export function modeUsesSets(mode) {
  return mode === "duel" || mode === "team2v2";
}

export function isPracticeMode(mode) {
  return mode === "practice";
}

export function isRankedMode(mode) {
  return RANKED_MODES.includes(mode);
}

export function targetScoreFor(mode, match) {
  if (mode === "ffa3") return Number(match && match.targetScore) || FFA_TARGET_SCORE;
  if (mode === "practice") return 0;
  return Number(match && match.targetScore) || TARGET_SCORE;
}

export function capacityLabel(mode) {
  const meta = modeMeta(mode);
  return meta.unlimited ? "人数不限" : `${meta.capacity} 人`;
}

/** 猜测模式。 */
export const GUESS_MODES = ["standard", "free"];
export const DEFAULT_GUESS_MODE = "standard";

export function isGuessMode(value) {
  return value === "standard" || value === "free";
}

export function guessModeLabel(mode) {
  return mode === "free" ? "自由猜词" : "标准猜词";
}

export function guessModeHint(mode) {
  return mode === "free"
    ? "任意 4 个汉字都可以提交（需在笔画字库中）。"
    : "只能猜词库中的成语。";
}

/** 标准模式词库范围。 */
export const DICTIONARY_MODES = ["common", "all"];
export const DEFAULT_DICTIONARY = "common";

export function isDictionaryMode(value) {
  return value === "common" || value === "all";
}

export function dictionaryLabel(value) {
  return value === "all" ? "全部成语" : "常见成语";
}

export function dictionaryHint(value) {
  return value === "all"
    ? "标准模式可猜全部 29406 条可用成语。"
    : "标准模式只猜 7208 条常见成语。";
}

/** 每小局目标分。 */
export const POINTS_TO_WIN_OPTIONS = [7, 11, 15, 21];
export const DEFAULT_POINTS_TO_WIN = 11;
export const MIN_POINTS_TO_WIN = 1;
export const MAX_POINTS_TO_WIN = 99;

export function isPointsToWin(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= MIN_POINTS_TO_WIN && number <= MAX_POINTS_TO_WIN;
}

export function defaultPointsForMode(mode) {
  return mode === "ffa3" ? FFA_TARGET_SCORE : DEFAULT_POINTS_TO_WIN;
}

/** 快速匹配规则：一局定胜负，默认自由猜词与常见词库。 */
export function quickMatchRules(mode) {
  return {
    bestOf: 1,
    guessMode: "free",
    dictionary: DEFAULT_DICTIONARY,
    pointsToWin: defaultPointsForMode(mode),
  };
}

/** 私有房建房默认规则；大比分仍默认 3 局两胜。 */
export function defaultRoomRules(mode) {
  return {
    bestOf: modeUsesSets(mode) ? DUEL_DEFAULT_BEST_OF : 1,
    guessMode: DEFAULT_GUESS_MODE,
    dictionary: DEFAULT_DICTIONARY,
    pointsToWin: defaultPointsForMode(mode),
  };
}

export function normalizeRoomRules(input, mode = "duel") {
  const source = input && typeof input === "object" ? input : {};
  const fallback = defaultRoomRules(mode);
  return {
    bestOf: modeUsesSets(mode)
      ? isDuelBestOf(source.bestOf)
        ? source.bestOf
        : fallback.bestOf
      : 1,
    guessMode: isGuessMode(source.guessMode) ? source.guessMode : fallback.guessMode,
    dictionary: isDictionaryMode(source.dictionary) ? source.dictionary : fallback.dictionary,
    pointsToWin: isPointsToWin(source.pointsToWin)
      ? Number(source.pointsToWin)
      : fallback.pointsToWin,
  };
}

/** 房间规则摘要，用于大厅/房间提示。 */
export function rulesSummary(rules, mode = "duel") {
  const normalized = normalizeRoomRules(rules, mode);
  const parts = [
    guessModeLabel(normalized.guessMode),
    dictionaryLabel(normalized.dictionary),
    `${normalized.pointsToWin} 分`,
  ];
  if (modeUsesSets(mode)) parts.push(bestOfLabel(normalized.bestOf));
  return parts.join("，");
}

export const ROOM_STATUS_LABELS = {
  waiting: "等待中",
  countdown: "准备开始",
  playing: "对局中",
  roundEnd: "本轮结束",
  matchEnd: "比赛结束",
};

export const ROUND_RESULT_LABELS = {
  solved: "猜中",
  exhausted: "流局",
  timeout: "超时",
};

export const TEAMS = ["A", "B"];

export function isMode(value) {
  return typeof value === "string" && MODES.includes(value);
}

export function modeMeta(mode) {
  return MODE_META[mode] || MODE_META.duel;
}
