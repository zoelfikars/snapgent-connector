// SPDX-License-Identifier: GPL-3.0-or-later
// HTML escaping for strings that end up inside innerHTML templates.

const ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ENTITIES[char]);
