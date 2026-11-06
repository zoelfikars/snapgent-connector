// SPDX-License-Identifier: GPL-3.0-or-later
// Accounts: a name the user gives a login, the cookies that login lives in, and the exact shape a cookie must be written
// back in. Pure: no chrome.*, no storage, and no page. A cookie is data about a session, so nothing here ever reads text.

export const NAME_MAX = 40;

const stripDot = (domain) => String(domain || "").replace(/^\./, "").toLowerCase();

/** A name the user typed -> the id an account is kept under (`Work`, `work 2` -> `work`, `work-2`). */
export function accountId(name) {
  const slug = String(name ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.slice(0, NAME_MAX);
}

/** Why this name cannot be used, or null. Two names that slug alike are one account, so the popup says so as well. */
export function nameProblem(name) {
  const text = String(name ?? "").trim();
  if (!text) return "Give the account a name.";
  if (text.length > NAME_MAX) return `Keep the name under ${NAME_MAX} characters.`;
  if (!accountId(text)) return "Use at least one letter or digit.";
  return null;
}

/** Does this cookie belong to one of `hosts`? A cookie for `.claude.ai` covers `claude.ai` and its subdomains. */
export function cookieBelongsTo(cookie, hosts) {
  const domain = stripDot(cookie && cookie.domain);
  if (!domain) return false;
  return hosts.some((host) => {
    const name = stripDot(host);
    return !!name && (domain === name || domain.endsWith(`.${name}`) || name.endsWith(`.${domain}`));
  });
}

/** The cookies of a session: those whose domain is one of the site's hosts. */
export const cookiesFor = (cookies, hosts) => (cookies || []).filter((cookie) => cookieBelongsTo(cookie, hosts));

const prefixOf = (name) => (name.startsWith("__Host-") ? "__Host-" : name.startsWith("__Secure-") ? "__Secure-" : "");

/**
 * What `cookies.set` must be given to write `cookie` back, or null when it cannot be written.
 * `__Host-` cookies are only accepted secure, host-only and on `/`: anything else is refused, which would lose the session
 * silently. A session cookie has no expiry, and only the fields a set accepts are passed on (never `storeId`, `session` or
 * `partitionKey`).
 */
export function cookieWriteSpec(cookie) {
  if (!cookie || typeof cookie.name !== "string" || !cookie.name || typeof cookie.value !== "string") return null;
  const domain = stripDot(cookie.domain);
  if (!domain) return null;
  const prefix = prefixOf(cookie.name);
  const secure = prefix ? true : !!cookie.secure;
  const path = prefix === "__Host-" ? "/" : cookie.path || "/";
  const spec = { url: `http${secure ? "s" : ""}://${domain}${path}`, name: cookie.name, value: cookie.value, path, secure };
  if (!cookie.hostOnly && String(cookie.domain).startsWith(".")) spec.domain = domain;
  if (!cookie.session && Number.isFinite(cookie.expirationDate)) spec.expirationDate = cookie.expirationDate;
  if (cookie.httpOnly) spec.httpOnly = true;
  if (cookie.sameSite && cookie.sameSite !== "unspecified") spec.sameSite = cookie.sameSite;
  return spec;
}

/** What the popup shows for one saved account, never the cookies themselves. */
export const accountSummary = (account) => ({
  id: account.id, name: account.name, savedAt: account.savedAt || null, cookies: (account.cookies || []).length,
});
