// SPDX-License-Identifier: GPL-3.0-or-later
// The advertised command a mistyped name most likely meant ("read_file" for "read_files"), so the error can say so.

const bare = (name) => String(name || "").split("/").pop();

function distance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

/** The nearest of `valid` within two edits, or null when nothing is close enough to be a guess worth giving. */
export function closestName(valid, name) {
  const wanted = bare(name).toLowerCase();
  if (wanted.length < 3) return null;
  let best = null;
  let bestDistance = 3;
  for (const candidate of valid) {
    const d = distance(wanted, bare(candidate).toLowerCase());
    if (d < bestDistance) { best = bare(candidate); bestDistance = d; }
  }
  return best;
}
