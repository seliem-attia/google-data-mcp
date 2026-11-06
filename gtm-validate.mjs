// Pre-check of GTM entities before they are saved.
// On compiler errors GTM only reports "there is an error", not where. So here:
//   • check JavaScript in Custom HTML tags (type "html") and Custom JS variables (type "jsm")
//     with an ES5 parser in strict mode (this is how GTM compiles),
//   • also find function declarations inside blocks (try/if/for …) — forbidden in ES5 strict,
//     but acorn lets them through with ecmaVersion 5,
//   • check every {{Variable}} against the variables + built-in variables in the workspace.

import { parse } from "acorn";

const VAR_REF = /\{\{\s*([^{}]+?)\s*\}\}/g;
// Internal GTM names that do not show up as variables in the workspace (e.g. custom event triggers).
const INTERNAL_VARS = new Set(["_event", "_triggers", "_html_id"]);
const STRICT = '"use strict";\n'; // own line → line numbers shifted by 1

// All string values of a GTM parameter tree (template, list, map …).
function collectStrings(params, out = []) {
  for (const p of params || []) {
    if (typeof p.value === "string") out.push(p.value);
    collectStrings(p.list, out);
    collectStrings(p.map, out);
  }
  return out;
}

const param = (entity, key) => (entity.parameter || []).find((p) => p.key === key)?.value;

// Function declarations that are not directly in the program or a function body.
function blockFunctions(ast) {
  const hits = [];
  const fnBodies = new WeakSet();
  const visit = (node, parent) => {
    if (!node || typeof node.type !== "string") return;
    if (node.type === "FunctionDeclaration" && !(parent?.type === "Program" || fnBodies.has(parent))) hits.push(node);
    if (/^Function/.test(node.type) && node.body) fnBodies.add(node.body);
    for (const v of Object.values(node)) {
      if (Array.isArray(v)) v.forEach((c) => visit(c, node));
      else if (v && typeof v === "object" && typeof v.type === "string") visit(v, node);
    }
  };
  visit(ast, null);
  return hits;
}

// Parses code as ES5 strict; {{Var}} is replaced by an identifier beforehand.
function checkJs(code, where, { expression = false } = {}) {
  const src = code.replace(VAR_REF, "__gtm_var");
  const body = expression ? `(${src}\n)` : src;
  // Line 1 = STRICT prefix; in expression mode the first code line additionally has a leading "(".
  const at = (loc) => `${where}, line ${loc.line - 1}, column ${loc.column + 1 - (expression && loc.line === 2 ? 1 : 0)}`;
  let ast;
  try {
    ast = parse(STRICT + body, { ecmaVersion: 5, locations: true });
  } catch (e) {
    const m = e.message.replace(/\s*\(\d+:\d+\)$/, "");
    return [e.loc ? `${at(e.loc)}: ${m}` : `${where}: ${m}`];
  }
  const errors = blockFunctions(ast).map(
    (n) =>
      `${at(n.loc.start)}: Function declaration "${n.id?.name}" inside a block (try/if/for …) — invalid in ES5 strict. ` +
      `Use "var ${n.id?.name} = function () { … };" instead, or declare the function outside the block.`,
  );
  if (expression) {
    const stmt = ast.body[1];
    if (ast.body.length !== 2 || stmt?.expression?.type !== "FunctionExpression") {
      errors.push(`${where}: Custom JS variable must be exactly one anonymous function: function () { … return …; }`);
    }
  }
  return errors;
}

// <script> blocks with JavaScript from Custom HTML (without src, without a foreign type such as ld+json).
function scripts(html) {
  const out = [];
  for (const m of String(html).matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const type = m[1].match(/\btype\s*=\s*["']?([^"'\s>]+)/i)?.[1]?.toLowerCase();
    if (type && !/^(text|application)\/(javascript|ecmascript)$/.test(type)) continue;
    if (m[2].trim()) out.push(m[2]);
  }
  return out;
}

/** Check the JS syntax of an entity. Returns error messages (empty = ok). */
export function validateEntityCode(entity) {
  const name = `"${entity.name || "unnamed"}"`;
  if (entity.type === "html") {
    return scripts(param(entity, "html") || "").flatMap((code, i) => checkJs(code, `Tag ${name}, <script> #${i + 1}`));
  }
  if (entity.type === "jsm") {
    return checkJs(param(entity, "javascript") || "", `Variable ${name}`, { expression: true });
  }
  return [];
}

/** All {{Variable}} names an entity references. */
export function referencedVariables(entity) {
  const names = new Set();
  const strings = collectStrings(entity.parameter);
  // Trigger conditions live in filter/autoEventFilter/customEventFilter.
  for (const f of [...(entity.filter || []), ...(entity.autoEventFilter || []), ...(entity.customEventFilter || [])]) {
    collectStrings(f.parameter, strings);
  }
  for (const s of strings) for (const m of s.matchAll(VAR_REF)) names.add(m[1]);
  return [...names];
}

/** Check references against known names (workspace variables + enabled built-in variables). */
export function unknownVariables(entity, knownNames) {
  const known = new Set(knownNames);
  return referencedVariables(entity).filter((n) => !known.has(n) && !INTERNAL_VARS.has(n));
}
