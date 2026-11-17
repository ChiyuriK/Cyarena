/**
 * 帮助页（#/help）：原作者致谢、词影玩法、对战规则、操作说明。
 *
 * 页面文案不使用中点或竖线作为分隔符。
 */

import { h, icon, currentTheme, toggleTheme, copyText, toast } from "../ui.js";

export function createHelpView(ctx) {
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

  const statsButton = h(
    "button",
    { class: "btn btn-ghost btn-sm", type: "button", onclick: () => ctx.goStats() },
    icon("chart", 16),
    "个人统计",
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
        h("h1", { class: "brand-title", text: "帮助与规则" }),
        h("p", { class: "brand-sub", text: "Ciying Arena Help" }),
      ),
    ),
    h("div", { class: "header-actions" }, changelogButton, statsButton, themeButton),
  );

  function ruleItem(title, text) {
    return h(
      "li",
      { class: "help-item" },
      h("strong", { class: "help-item-title", text: title }),
      h("span", { class: "help-item-text", text: text }),
    );
  }

  const credits = h(
    "section",
    { class: "panel help-section help-credits" },
    h("h2", { class: "page-title", text: "原作者致谢" }),
    h(
      "p",
      { class: "help-paragraph" },
      "词影原游戏与玩法概念来自 Surprising Studio。感谢原作者带来这样一款以笔画为线索的猜词游戏。",
    ),
    h(
      "p",
      { class: "help-links" },
      h(
        "a",
        { href: "https://cy.surprising.studio/", target: "_blank", rel: "noreferrer noopener" },
        "词影官方网站",
      ),
      h(
        "a",
        {
          href: "https://store.steampowered.com/app/2331660/",
          target: "_blank",
          rel: "noreferrer noopener",
        },
        "Steam 商店页面",
      ),
    ),
    h(
      "p",
      { class: "help-paragraph" },
      "同时感谢 Koishi 插件 koishi-plugin-wordle-game 与汉兜词库，以及其笔画数据的作者与维护者。",
    ),
  );

  const gameplay = h(
    "section",
    { class: "panel help-section help-gameplay" },
    h("h2", { class: "page-title", text: "词影游戏的玩法" }),
    h(
      "p",
      { class: "help-paragraph" },
      "每轮从一个四字成语开始，所有玩家面对同一张棋盘，各自提交自己的四字猜测。",
    ),
    h(
      "div",
      { class: "help-figures" },
      h(
        "figure",
        { class: "help-figure help-figure-shot" },
        h("img", {
          src: "/assets/ciying-gameplay.png",
          alt: "词影游戏界面，展示四字猜测与逐位比较的笔画线索",
          width: "448",
          height: "253",
          loading: "lazy",
          decoding: "async",
        }),
        h(
          "figcaption",
          { class: "help-figcaption" },
          "实际界面示例：绿色表示笔画或整字命中，黑色与灰色表示相似程度不同的笔画线索。",
        ),
      ),
    ),
    h(
      "ul",
      { class: "help-list help-gameplay-list" },
      ruleItem("四字成语", "每轮答案是一个四字成语，每次提交四个汉字。"),
      ruleItem(
        "逐位比较",
        "按位置比较猜测与答案的笔画。正确笔画显示绿色，相似笔画显示黑色或灰色，完全正确时整格绿底。",
      ),
      ruleItem("六行机会", "每轮最多 6 行猜测机会。"),
      ruleItem("自由猜词", "自由猜词不要求来自词库，四个汉字就能猜。"),
      ruleItem("保留线索", "前面猜过的笔画线索会保留在棋盘上，帮助你逐步缩小范围。"),
    ),
  );

  const rules = h(
    "section",
    { class: "panel help-section" },
    h("h2", { class: "page-title", text: "对战规则" }),
    h(
      "ul",
      { class: "help-list" },
      ruleItem(
        "得分",
        "每轮先猜中者得 1 分。6 行仍未猜中时对方得分，三人战其他玩家各得 1 分。",
      ),
      ruleItem(
        "目标分",
        "1v1 与团队战先到目标分且领先 2 分获胜，目标分可设为 7、11、15、21 或自定义；三人战先到目标分。",
      ),
      ruleItem("模式", "支持 1v1 单挑、团队战与三人混战。团队战按 A 队和 B 队共享小局分，人数不限。快速匹配固定一局定胜负。"),
      ruleItem("节奏", "同一玩家两次提交至少间隔 1 秒。每轮 60 秒无人作答则本轮结束。"),
    ),
  );

  const operations = h(
    "section",
    { class: "panel help-section" },
    h("h2", { class: "page-title", text: "操作说明" }),
    h(
      "ul",
      { class: "help-list" },
      ruleItem("进入对局", "在大厅创建房间、快速匹配或输入 5 位房号加入，也可以先进入个人练习。"),
      ruleItem("准备与规则", "团队战可手动选队。快速匹配先协商规则，全部玩家确认后房主开始比赛。"),
      ruleItem("猜词", "在房间输入框输入四个汉字并提交，留意 1 秒冷却与 60 秒无人作答倒计时。"),
      ruleItem("对局信息", "比分条显示当前比分，房间侧栏显示最近 5 轮答案与解释。"),
      ruleItem("战绩与资料", "注册用户可查看我的战绩、最近成语，并修改昵称与头像。练习模式不计入天梯。"),
    ),
  );

  const contact = h(
    "section",
    { class: "panel help-section help-contact" },
    h("h2", { class: "page-title", text: "联系我们" }),
    h(
      "p",
      { class: "help-paragraph" },
      "遇到问题、想反馈建议或找人一起玩，欢迎加入词影竞技场 QQ 群。",
    ),
    h(
      "div",
      { class: "help-contact-row" },
      h(
        "a",
        {
          class: "btn btn-primary",
          href: "https://qun.qq.com/join.html?gc=1108954252",
          target: "_blank",
          rel: "noreferrer noopener",
        },
        "加入 QQ 群",
      ),
      h("span", { class: "help-contact-number", text: "群号 1108954252" }),
      h(
        "button",
        {
          class: "btn btn-ghost btn-sm",
          type: "button",
          onclick: async () => {
            const ok = await copyText("1108954252");
            toast(ok ? "群号已复制" : "复制失败，请手动选择群号", ok ? "success" : "warn");
          },
        },
        icon("copy", 15),
        "复制群号",
      ),
    ),
  );

  const el = h(
    "div",
    { class: "view help-view" },
    header,
    h("main", { class: "help-main" }, credits, gameplay, rules, operations, contact),
  );

  return {
    el,
    destroy() {},
  };
}
