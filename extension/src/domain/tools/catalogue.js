// SPDX-License-Identifier: GPL-3.0-or-later
// Renders MCP tool descriptors as the text the model reads from `list_commands`.

export function formatToolForModel(t) {
  const props = (t.inputSchema && t.inputSchema.properties) || {};
  const req = new Set((t.inputSchema && t.inputSchema.required) || []);
  // Two buckets: simple scalar params get packed onto ONE compact line;
  // params that need real explanation (array-of-object shape, or a long
  // description) keep their own line so nothing structurally important
  // gets flattened away.
  const compact = [];
  const detailed = [];
  for (const [k, v] of Object.entries(props)) {
    const items = v.items && typeof v.items === "object" ? v.items : null;
    const itemProps = items && items.properties;
    const mark = req.has(k) ? "" : "?";
    if (v.type === "array" && itemProps) {
      const itemReq = new Set(items.required || []);
      const fields = Object.entries(itemProps).map(([ik, iv]) => {
        const en = Array.isArray(iv.enum) && iv.enum.length <= 12 ? `(${iv.enum.join("|")})` : (iv.type || "any");
        return `${ik}${itemReq.has(ik) ? "" : "?"}:${en}`;
      });
      detailed.push(`    ${k}${mark}: array [each item: {${fields.join(", ")}}]${v.description ? " - " + v.description : ""}`);
    } else if (v.description && v.description.length > 45) {
      detailed.push(`    ${k}${mark}: ${v.type || "any"} - ${v.description}`);
    } else {
      const ty = Array.isArray(v.enum) && v.enum.length <= 8 ? `(${v.enum.join("|")})` : (v.type || "any");
      compact.push(`${k}${mark}:${ty}${v.description ? ` "${v.description}"` : ""}`);
    }
  }
  const paramLines = [compact.length ? `    ${compact.join(", ")}` : "", ...detailed].filter(Boolean).join("\n");
  return `${t.name}: ${(t.description || "").split("\n")[0]}${paramLines ? "\n" + paramLines : ""}`;
}

export function formatCatalogue(tools) {
  return tools.map(formatToolForModel).join("\n\n");
}
