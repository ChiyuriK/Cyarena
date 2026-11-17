/**
 * 登录 / 注册弹窗。
 */

import * as api from "../api.js";
import { store, emit } from "../store.js";
import { h, openModal, toast } from "../ui.js";
import { markOnboardingPending } from "../onboarding.js";

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

export function openAuthModal(ctx, initialTab = "login") {
  let tab = initialTab === "register" ? "register" : "login";

  const errorBox = h("div", { class: "form-error", role: "alert" });
  const tabsBar = h("div", { class: "segmented auth-tabs", role: "tablist" });
  const loginTab = h("button", { class: "segmented-btn", type: "button", role: "tab" }, "登录");
  const registerTab = h(
    "button",
    { class: "segmented-btn", type: "button", role: "tab" },
    "注册",
  );
  tabsBar.append(loginTab, registerTab);

  const formArea = h("div", { class: "auth-form-area" });
  const content = h(
    "div",
    { class: "auth" },
    h("p", { class: "auth-kicker", text: "账号" }),
    h("h2", { class: "modal-title", text: "登录 / 注册" }),
    h("p", { class: "modal-sub", text: "登录后可参与天梯排行；以游客身份也可以直接游玩。" }),
    tabsBar,
    formArea,
    errorBox,
  );

  const modal = openModal({ title: "登录或注册", content });

  function setTab(next) {
    tab = next;
    loginTab.classList.toggle("is-active", tab === "login");
    registerTab.classList.toggle("is-active", tab === "register");
    loginTab.setAttribute("aria-selected", String(tab === "login"));
    registerTab.setAttribute("aria-selected", String(tab === "register"));
    errorBox.textContent = "";
    formArea.replaceChildren(tab === "login" ? buildLoginForm() : buildRegisterForm());
    const focus = formArea.querySelector("input");
    if (focus) focus.focus();
  }

  loginTab.addEventListener("click", () => setTab("login"));
  registerTab.addEventListener("click", () => setTab("register"));

  function makeField(label, input) {
    return h("label", { class: "field" }, h("span", { class: "field-label", text: label }), input);
  }

  function buildLoginForm() {
    const username = h("input", {
      class: "input",
      name: "username",
      autocomplete: "username",
      maxlength: "20",
      placeholder: "用户名",
      required: true,
    });
    const password = h("input", {
      class: "input",
      name: "password",
      type: "password",
      autocomplete: "current-password",
      maxlength: "128",
      placeholder: "密码",
      required: true,
    });
    const submit = h("button", { class: "btn btn-primary btn-block", type: "submit" }, "登录");
    const form = h(
      "form",
      { class: "form", novalidate: true },
      makeField("用户名", username),
      makeField("密码", password),
      submit,
      h(
        "p",
        { class: "form-hint" },
        "还没有账号？",
        h(
          "button",
          { class: "link-btn", type: "button", onclick: () => setTab("register") },
          "立即注册",
        ),
      ),
    );
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const name = username.value.trim();
      if (!name || !password.value) {
        errorBox.textContent = "请输入用户名和密码";
        return;
      }
      await submitAuth(() => api.login(name, password.value), form, "login");
    });
    return form;
  }

  function buildRegisterForm() {
    const username = h("input", {
      class: "input",
      name: "username",
      autocomplete: "username",
      maxlength: "20",
      placeholder: "3-20 位字母 / 数字 / 下划线",
      required: true,
    });
    const password = h("input", {
      class: "input",
      name: "password",
      type: "password",
      autocomplete: "new-password",
      maxlength: "128",
      placeholder: "至少 6 位",
      required: true,
    });
    const nickname = h("input", {
      class: "input",
      name: "nickname",
      maxlength: "16",
      placeholder: "昵称（可选）",
    });
    const submit = h("button", { class: "btn btn-primary btn-block", type: "submit" }, "注册并进入");
    const form = h(
      "form",
      { class: "form", novalidate: true },
      makeField("用户名", username),
      makeField("密码", password),
      makeField("昵称", nickname),
      submit,
      h(
        "p",
        { class: "form-hint" },
        "已有账号？",
        h("button", { class: "link-btn", type: "button", onclick: () => setTab("login") }, "去登录"),
      ),
    );
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const name = username.value.trim();
      const passwordValue = password.value;
      if (!USERNAME_RE.test(name)) {
        errorBox.textContent = "用户名需为 3-20 位字母、数字或下划线";
        return;
      }
      if (passwordValue.length < 6) {
        errorBox.textContent = "密码至少需要 6 位";
        return;
      }
      const nicknameValue = nickname.value.trim();
      if (nicknameValue && Array.from(nicknameValue).length > 16) {
        errorBox.textContent = "昵称最多 16 个字符";
        return;
      }
      await submitAuth(() => api.register(name, passwordValue, nicknameValue || undefined), form, "register");
    });
    return form;
  }

  async function submitAuth(action, form, mode) {
    if (form.dataset.busy === "1") return;
    form.dataset.busy = "1";
    errorBox.textContent = "";
    const submit = form.querySelector('button[type="submit"]');
    if (submit) {
      submit.disabled = true;
      submit.dataset.label = submit.textContent || "";
      submit.textContent = "请稍候…";
    }
    try {
      const session = await action();
      if (mode === "register") markOnboardingPending(session.user.id);
      api.saveSession(session.token, session.user);
      store.token = session.token;
      store.user = session.user;
      emit("user", session.user);
      toast(`欢迎，${session.user.name}`, "success");
      if (modal) modal.close();
      if (typeof ctx.onAuthSuccess === "function") ctx.onAuthSuccess(session.user);
    } catch (error) {
      errorBox.textContent = error && error.message ? error.message : "操作失败，请稍后再试";
    } finally {
      form.dataset.busy = "0";
      if (submit) {
        submit.disabled = false;
        submit.textContent = submit.dataset.label || "提交";
      }
    }
  }

  setTab(tab);
  return modal;
}
