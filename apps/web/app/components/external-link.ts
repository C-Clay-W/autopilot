/** 回答链接的浏览器展示边界：只把无凭据的绝对 HTTP(S) 地址变成可交互链接。 */

/** 规范化待打开地址，拒绝脚本协议、控制字符及容易掩盖真实目标的 userinfo。 */
export function normalizeExternalLink(value: string): string | null {
  if (value.length > 8_192 || /[\u0000-\u0020\u007f\u202a-\u202e\u2066-\u2069]/u.test(value) || !/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    return url.username || url.password ? null : url.href;
  } catch {
    return null;
  }
}

/** 去掉裸链接后面的行文标点，保留 URL 内配对的括号。 */
export function trimLinkPunctuation(value: string): string {
  let result = value.replace(/[.,!?;:，。！？；：、”’》]+$/u, "");
  for (const [opening, closing] of [["(", ")"], ["[", "]"], ["{", "}"], ["（", "）"]]) {
    while (result.endsWith(closing) && result.split(closing).length > result.split(opening).length) result = result.slice(0, -1);
  }
  return result;
}
