/**
 * 新手玩法弹窗状态：按注册用户 id 记录 pending / never。
 * 关闭弹窗不写状态，下次登录仍会提示；选择不再提示才写入 never。
 */

const KEY_PREFIX = "ciying.onboarding.";

function keyFor(userId) {
  return `${KEY_PREFIX}${String(userId || "")}`;
}

export function onboardingState(userId) {
  if (!userId) return "";
  try {
    return localStorage.getItem(keyFor(userId)) || "";
  } catch {
    return "";
  }
}

export function markOnboardingPending(userId) {
  if (!userId) return;
  try {
    localStorage.setItem(keyFor(userId), "pending");
  } catch {
    /* ignore */
  }
}

export function markOnboardingNever(userId) {
  if (!userId) return;
  try {
    localStorage.setItem(keyFor(userId), "never");
  } catch {
    /* ignore */
  }
}

export function shouldShowOnboarding(user) {
  if (!user || user.isGuest) return false;
  return onboardingState(user.id) !== "never";
}
