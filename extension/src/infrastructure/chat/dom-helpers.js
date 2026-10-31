// SPDX-License-Identifier: GPL-3.0-or-later
// Small DOM utilities that several chat adapters need identically.

/** Click the element returned by `find()` if there is one. Never throws. */
export function clickIfPresent(find) {
  const el = find();
  if (!el) return false;
  try { el.click(); } catch { return false; }
  return true;
}

/**
 * Set an input/textarea value the way frameworks (React etc.) notice: through the
 * prototype's native setter, then dispatch a bubbling `input` event.
 */
export function setNativeValue(el, value, win = window) {
  const ctor = el.tagName === "INPUT" ? win.HTMLInputElement : win.HTMLTextAreaElement;
  const setter = ctor && Object.getOwnPropertyDescriptor(ctor.prototype, "value");
  if (setter && setter.set) setter.set.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

const IMAGE_EXTENSIONS = [["png", "png"], ["webp", "webp"], ["gif", "gif"]];

/** Build a File from a `{ data: base64, mimeType }` tool image. */
export function fileFromImage(img, index) {
  const mime = img.mimeType || "image/jpeg";
  const bytes = Uint8Array.from(atob(img.data), (c) => c.charCodeAt(0));
  const ext = (IMAGE_EXTENSIONS.find(([needle]) => mime.includes(needle)) || [, "jpg"])[1];
  return new File([bytes], `snapgentV3_${Date.now()}_${index}.${ext}`, { type: mime });
}
