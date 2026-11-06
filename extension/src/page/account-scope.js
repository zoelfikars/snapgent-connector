// SPDX-License-Identifier: GPL-3.0-or-later
// Which login this page is using, as far as Snapgent knows (the account last switched to). The page never reads cookies: it only
// needs the id to keep the folders of one chat apart from another login's, and to say which account is in use.

import { KEY } from "../application/account-store.js";

/** @param {{ storage: object, site: string }} deps */
export function createAccountScope({ storage, site }) {
  let active = null;
  const adopt = (all) => { active = (all && all[site] && all[site].active) || null; };
  storage.get(KEY).then(adopt);
  storage.watch(KEY, adopt);
  return {
    /** The id of the account in use, or "" when there is none (or this site has no accounts). */
    id: () => active || "",
    site,
  };
}
