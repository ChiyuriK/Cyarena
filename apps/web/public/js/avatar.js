/**
 * 头像图片处理：校验类型/大小，居中裁剪并压缩为 96x96 JPEG data URL。
 */

export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
export const AVATAR_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"];
const AVATAR_DATA_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/i;

export function isAvatarDataUrl(value) {
  return typeof value === "string" && AVATAR_DATA_RE.test(value);
}

export function validateAvatarFile(file) {
  if (!file) return "请选择一张图片";
  if (!AVATAR_MIME_TYPES.includes(file.type)) {
    return "头像只支持 PNG、JPEG 或 WebP 图片";
  }
  if (Number(file.size) > AVATAR_MAX_BYTES) {
    return "头像原图不能超过 5MB";
  }
  return "";
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

function loadImage(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("无法解析这张图片"));
    image.src = source;
  });
}

export async function avatarFileToDataUrl(file) {
  const error = validateAvatarFile(file);
  if (error) throw new Error(error);
  const source = await readFileAsDataUrl(file);
  const image = await loadImage(source);
  const width = Number(image.naturalWidth || image.width) || 0;
  const height = Number(image.naturalHeight || image.height) || 0;
  if (!width || !height) throw new Error("无法解析这张图片");
  const side = Math.min(width, height);
  const sx = Math.max(0, Math.floor((width - side) / 2));
  const sy = Math.max(0, Math.floor((height - side) / 2));
  const canvas = document.createElement("canvas");
  canvas.width = 96;
  canvas.height = 96;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前浏览器不支持头像处理");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, 96, 96);
  context.drawImage(image, sx, sy, side, side, 0, 0, 96, 96);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
  if (!isAvatarDataUrl(dataUrl)) throw new Error("头像处理失败");
  return dataUrl;
}
