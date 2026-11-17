/**
 * 更新日志页（#/changelog）。按日期分组，再按新增、优化、修复归类。
 */

import { h, icon, currentTheme, toggleTheme } from "../ui.js";

const GROUP_LABELS = { added: "新增", optimized: "优化", fixed: "修复" };

const LOG = [
  {
    title: "2026-11-15",
    added: [
      "连胜挑战新增答题用时统计，展示平均用时与最快用时。",
      "连胜挑战改为随机抽题，答对后休息 1 秒进入下一题。",
    ],
    optimized: ["连胜挑战断线 60 秒后自动结束当前挑战；房间离席保留仍为 180 秒。"],
    fixed: [],
  },
  {
    title: "2026-11-14",
    added: [
      "每日挑战升级为首页优先模块，新增玩法说明弹窗与手动查看入口。",
      "每日题支持自由猜词提示、连续成功天数与用时榜。",
      "新增连胜挑战，支持标准、自由、进阶三种变体及独立排行榜。",
      "个人统计新增连胜挑战数据，精简练习模式统计指标。",
      "首页改为快速匹配、创建房间、个人模式三栏布局。",
      "私有房等待阶段支持房主修改目标分、猜词模式、词库与大比分。",
      "新增好友系统，支持搜索、申请、私信、资料与对局邀请。",
      "新增通知中心，汇总更新公告、好友申请、私信与对局邀请。",
      "新增对好友展示数据开关。",
      "新增账号注销，支持三步确认并清除账号数据。",
    ],
    optimized: [
      "对局分享补充每小局比分，分享链接返回主页。",
      "每日页面与棋盘优化夜间模式对比度，格子与排行榜字号保持可读。",
      "三人天梯排行榜展示第一名、第二名、第三名与和。",
      "观战者可在未满等待房加入对局，并参与房间聊天。",
    ],
    fixed: ["统一更新日志为日期分组结构，合并同日重复内容。"],
  },
  {
    title: "2026-11-12",
    added: [
      "新增每日一题与全服排行榜，支持复制战绩卡。",
      "帮助页新增联系我们 QQ 群入口与可复制群号。",
      "结算页新增分享对局，包含比分、玩家与高光成语。",
      "房间头部新增复制邀请，包含房间码与邀请链接。",
    ],
    optimized: [
      "大厅未登录入口改为注册登录优先，游客入口折叠。",
      "新手玩法提示改为注册用户每次进入大厅时显示。",
      "观战者聊天输入启用，房间聊天不再只读。",
    ],
    fixed: ["修复每日格子字号、黄色判定、猜对字显示与分享链接。"],
  },
  {
    title: "2026-11-11",
    added: [
      "帮助页改为原作者致谢、词影玩法、对战规则与操作说明结构，并加入玩法图。",
      "新增最近成语页与房间最近轮次成语解释。",
      "三人天梯排行榜改为第一名、第二名、第三名与和。",
    ],
    optimized: [
      "移动端断线重连改为心跳检测，回到前台或恢复网络时强制检查。",
      "单人大厅房间在玩家离线后保留 3 分钟，并在进入新房间时释放。",
    ],
    fixed: ["修复战绩胜负判断与断线判胜比分显示，改名后仍能正确显示胜利。"],
  },
  {
    title: "2026-11-10",
    added: [
      "快速匹配加入房主规则协商，支持猜词模式、词库与目标分。",
      "建房支持目标分 7/11/15/21 与自定义分数。",
      "新增我的战绩页、头像上传与站点统计。",
      "新增更新日志页与全局页脚。",
    ],
    optimized: [
      "猜词输入解除 4 字限制，非法提交保留输入并提供差一字建议。",
      "房间侧栏展示最近 5 轮，比赛结束保留每小局比分。",
      "移动端输入框固定底部，头像显示扩展到玩家卡、聊天与排行榜。",
      "统一小圆角与分隔符规范。",
    ],
    fixed: ["修复分享链接说明残留与若干展示空值。"],
  },
];

export const CHANGELOG_LOG = LOG;

export function createChangelogView(ctx) {
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
        h("h1", { class: "brand-title", text: "更新日志" }),
        h("p", { class: "brand-sub", text: "Ciying Arena Changelog" }),
      ),
    ),
    h("div", { class: "header-actions" }, helpButton, themeButton),
  );

  const sections = LOG.map((entry) => {
    const groups = [];
    for (const key of ["added", "optimized", "fixed"]) {
      const items = Array.isArray(entry[key]) ? entry[key] : [];
      if (items.length === 0) continue;
      groups.push(
        h(
          "div",
          { class: "changelog-group" },
          h("h3", { class: "changelog-group-title", text: GROUP_LABELS[key] }),
          h(
            "ul",
            { class: "help-list" },
            ...items.map((item) =>
              h(
                "li",
                { class: "changelog-item" },
                icon("check", 14),
                h("span", { text: item }),
              ),
            ),
          ),
        ),
      );
    }
    return h(
      "section",
      { class: "panel help-section changelog-section" },
      h(
        "div",
        { class: "changelog-head" },
        h("h2", { class: "page-title changelog-date", text: entry.title }),
      ),
      ...groups,
    );
  });

  const el = h(
    "div",
    { class: "view changelog-view" },
    header,
    h("main", { class: "changelog-main" }, ...sections),
  );

  return {
    el,
    destroy() {},
  };
}
