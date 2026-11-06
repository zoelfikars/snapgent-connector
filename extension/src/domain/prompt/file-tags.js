// SPDX-License-Identifier: GPL-3.0-or-later
// Tagging files (and folders, `@src/`) in a message: `@src/a.js`. A name with spaces is quoted, `@"docs/My Notes.md"` (single quotes and backticks are read
// too). Reading is forgiving: an unquoted tag that runs on into spaces still counts when the whole thing names a file. Pure.

const QUOTES = ['"', "'", "`"];
const TRAILING_PUNCTUATION = /[.,;:!?)\]}"'`]+$/;
const MAX_WORDS_IN_NAME = 8;

/** How a file is written in the message, ready to continue typing after it. */
export function tagText(path) {
  if (!/\s/.test(path)) return `@${path} `;
  const quote = QUOTES.find((q) => !path.includes(q));
  return quote ? `@${quote}${path}${quote} ` : `@${path} `;
}

/**
 * The tag being typed at the END of the text, if any: an `@` at the start or after whitespace, then what has been typed of the
 * name. Inside quotes the name may hold spaces until the closing quote. Otherwise it ends at the first space, so a finished tag
 * followed by more words is not "being typed".
 * @returns {{ start: number, query: string } | null} `start` is where the `@` is
 */
export function trailingTag(text) {
  for (let at = text.lastIndexOf("@"); at >= 0; at = text.lastIndexOf("@", at - 1)) {
    if (at > 0 && !/\s/.test(text[at - 1])) continue; // an address, not a tag
    const rest = text.slice(at + 1);
    if (QUOTES.includes(rest[0])) return rest.indexOf(rest[0], 1) === -1 ? { start: at, query: rest.slice(1) } : null;
    return /\s/.test(rest) ? null : { start: at, query: rest };
  }
  return null;
}

/** A folder is written with a closing slash, `src/page/`; the same word without it still names it. */
export const isFolder = (path) => path.endsWith("/");

/** The folders that hold these files (every level), each with its closing slash. */
export function foldersOf(paths) {
  const folders = new Set();
  for (const path of paths) {
    for (let at = path.indexOf("/"); at >= 0; at = path.indexOf("/", at + 1)) folders.add(path.slice(0, at + 1));
  }
  return [...folders];
}

const BINARY = /\.(png|jpe?g|gif|webp|bmp|ico|icns|svgz|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|exe|dll|so|dylib|a|o|obj|class|pyc|wasm|bin|dat|db|sqlite3?|woff2?|ttf|otf|eot|mp[34]|mov|avi|mkv|webm|wav|ogg|flac|psd|ai|lock|sum)$/i;

/** Builds a nested tree from a flat list of file and folder paths. */
export function buildFileTree(paths) {
  const root = { name: "", children: {}, isFolder: true, expanded: true, path: "" };
  for (const path of paths) {
    const isFolder = path.endsWith("/");
    const clean = isFolder ? path.slice(0, -1) : path;
    const parts = clean.split("/");
    let current = root;
    let currentPath = "";
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      currentPath += (currentPath ? "/" : "") + part;
      if (!current.children[part]) {
        current.children[part] = {
          name: part,
          children: {},
          isFolder: (i < parts.length - 1) || isFolder,
          expanded: true,
          path: currentPath + ((i < parts.length - 1) || isFolder ? "/" : "")
        };
      }
      current = current.children[part];
    }
  }
  return root;
}

/** Worth reading as text when a whole folder is attached (images, archives, binaries and lock files are not). */
export const isTextFile = (path) => !BINARY.test(path);

/** The files whose path holds every word of `query` (any case), the ones whose NAME does first. */
export function matchPaths(paths, query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return paths;
  const hits = paths.filter((path) => words.every((word) => path.toLowerCase().includes(word)));
  const nameOf = (path) => path.replace(/\/$/, "").slice(path.replace(/\/$/, "").lastIndexOf("/") + 1);
  const inName = (path) => words.every((word) => nameOf(path).toLowerCase().includes(word));
  return [...hits.filter(inName), ...hits.filter((path) => !inName(path))];
}

/**
 * Every file the text tags, in order and once each.
 * @param {string} text
 * @param {(path: string) => boolean} isFile
 */
export function findTags(text, isFile) {
  const found = [];
  const add = (path) => { if (path && !found.includes(path)) found.push(path); };
  const words = [...text.matchAll(/\S+/g)];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const at = word.index;
    if (word[0][0] !== "@" || (at > 0 && !/\s/.test(text[at - 1]))) continue;
    const quote = QUOTES.find((q) => word[0][1] === q);
    if (quote) {
      const close = text.indexOf(quote, at + 2);
      if (close > 0 && isFile(text.slice(at + 2, close))) add(text.slice(at + 2, close));
      continue;
    }
    // The longest run of words that names a file wins, so `@docs/My Notes.md` is one file, not `@docs/My`.
    let match = null;
    for (let n = 0; n < Math.min(MAX_WORDS_IN_NAME, words.length - i); n++) {
      const end = words[i + n].index + words[i + n][0].length;
      for (const candidate of [text.slice(at + 1, end), text.slice(at + 1, end).replace(TRAILING_PUNCTUATION, "")]) {
        if (candidate && isFile(candidate)) match = candidate;
      }
    }
    add(match);
  }
  return found;
}
