// SPDX-License-Identifier: GPL-3.0-or-later
// A skill is a SKILL.md file with `name` and `description` frontmatter, stored in the
// workspace under .snapgent/skills/<name>/. Pure parsing and validation.

export const SKILLS_DIR = ".snapgent/skills";
export const SKILL_MAX_BYTES = 20 * 1024;
export const MAX_SKILLS_LOADED = 30;
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LOADED_DESCRIPTION_MAX = 200;

export const skillPath = (name) => `${SKILLS_DIR}/${name}/SKILL.md`;

const clean = (value) => (value || "").trim().replace(/^["']|["']$/g, "").replace(/\s+/g, " ");

/** @returns {{ name: string, description: string } | null} null when there is no frontmatter block */
export function parseFrontmatter(text) {
  const block = String(text).match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!block) return null;
  const field = (key) => clean((block[1].match(new RegExp(`^${key}:[ \\t]*(.+)$`, "m")) || [])[1]);
  return { name: field("name"), description: field("description") };
}

/**
 * Header of a skill file found on disk: lenient (any non-empty name), description trimmed to fit
 * the prompt. @returns {{ name: string, description: string } | null}
 */
export function parseSkillHeader(text) {
  const header = parseFrontmatter(text);
  if (!header || !header.name || !header.description) return null;
  return { name: header.name, description: header.description.slice(0, LOADED_DESCRIPTION_MAX) };
}

/** Strict validation of pasted SKILL.md text. @returns {{ok:true,name:string,description:string}|{ok:false,error:string}} */
export function validateSkillText(text) {
  if (typeof text !== "string" || !text.trim()) return { ok: false, error: "Empty content." };
  if (new TextEncoder().encode(text).length > SKILL_MAX_BYTES) return { ok: false, error: "Too large (max 20 KB)." };
  const header = parseFrontmatter(text);
  if (!header) return { ok: false, error: "Missing frontmatter (--- name / description ---)." };
  if (!NAME_RE.test(header.name) || header.name.length > 64) {
    return { ok: false, error: "name must be lowercase letters, digits and hyphens only (max 64)." };
  }
  if (!header.description) return { ok: false, error: "description is required." };
  if (header.description.length > LOADED_DESCRIPTION_MAX) {
    return { ok: false, error: "description is too long (max 200 characters)." };
  }
  return { ok: true, name: header.name, description: header.description };
}
