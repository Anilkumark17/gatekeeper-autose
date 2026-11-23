import type Parser from "tree-sitter";
import { lines } from "./parser.js";

type Node = Parser.SyntaxNode;

export type ExportKind = "local" | "reexport" | "reexport_all" | "reexport_namespace" | "commonjs";

export interface RawExport {
  kind: ExportKind;
  exported: string | null; // name other files import; null for `export *`
  local: string | null;    // symbol name in this file (local, commonjs)
  imported: string | null; // name in the source module (reexport)
  source: string | null;   // specifier for re-exports
  typeOnly: boolean;
  line: number;
}

const FUNCTION_DECLS = new Set(["function_declaration", "generator_function_declaration"]);
const CLASS_DECLS = new Set(["class_declaration", "abstract_class_declaration"]);
const TYPE_DECLS = new Set(["interface_declaration", "type_alias_declaration"]);

const str = (n: Node | null | undefined) => (n?.type === "string" ? n.text.slice(1, -1) : null);
const hasToken = (n: Node, t: string) => n.children.some((c) => c.type === t);

function declaredNames(decl: Node): string[] {
  if (FUNCTION_DECLS.has(decl.type) || CLASS_DECLS.has(decl.type) || TYPE_DECLS.has(decl.type) || decl.type === "enum_declaration") {
    const name = decl.childForFieldName("name")?.text;
    return name ? [name] : [];
  }
  if (decl.type === "lexical_declaration" || decl.type === "variable_declaration") {
    return decl.namedChildren
      .filter((d) => d.type === "variable_declarator")
      .map((d) => d.childForFieldName("name"))
      .filter((n): n is Node => n?.type === "identifier")
      .map((n) => n.text);
  }
  return [];
}

function fromExportStatement(stmt: Node): RawExport[] {
  const line = lines(stmt).start;
  const source = str(stmt.childForFieldName("source"));
  const typeOnly = hasToken(stmt, "type");
  const isDefault = hasToken(stmt, "default");
  const out: RawExport[] = [];
  const entry = (e: Partial<RawExport> & Pick<RawExport, "kind">): RawExport => ({
    exported: null, local: null, imported: null, source: null, typeOnly, line, ...e,
  });

  const decl = stmt.childForFieldName("declaration");
  const value = stmt.childForFieldName("value");

  if (isDefault) {
    const target = decl ?? value;
    const name = target?.type === "identifier" ? target.text : target?.childForFieldName("name")?.text ?? "default";
    out.push(entry({ kind: "local", exported: "default", local: name }));
    return out;
  }

  if (decl) {
    const declTypeOnly = TYPE_DECLS.has(decl.type);
    for (const name of declaredNames(decl)) {
      out.push(entry({ kind: "local", exported: name, local: name, typeOnly: declTypeOnly }));
    }
    return out;
  }

  const clause = stmt.namedChildren.find((c) => c.type === "export_clause");
  if (clause) {
    for (const spec of clause.namedChildren) {
      if (spec.type !== "export_specifier") continue;
      const inner = spec.childForFieldName("name")?.text;
      if (!inner) continue;
      const outer = spec.childForFieldName("alias")?.text ?? inner;
      const specType = typeOnly || hasToken(spec, "type");
      out.push(
        source
          ? entry({ kind: "reexport", exported: outer, imported: inner, source, typeOnly: specType })
          : entry({ kind: "local", exported: outer, local: inner, typeOnly: specType }),
      );
    }
    return out;
  }

  const ns = stmt.namedChildren.find((c) => c.type === "namespace_export");
  if (ns && source) {
    const name = ns.namedChildren.find((c) => c.type === "identifier" || c.type === "string");
    out.push(entry({ kind: "reexport_namespace", exported: name ? name.text.replace(/^["']|["']$/g, "") : null, source }));
    return out;
  }

  if (source && hasToken(stmt, "*")) {
    out.push(entry({ kind: "reexport_all", source }));
  }
  return out;
}

function fromCommonJs(stmt: Node): RawExport[] {
  const expr = stmt.namedChildren[0];
  if (expr?.type !== "assignment_expression") return [];
  const left = expr.childForFieldName("left");
  const right = expr.childForFieldName("right");
  if (!left || !right) return [];
  const line = lines(stmt).start;
  const target = left.text;
  const base = { kind: "commonjs" as const, imported: null, source: null, typeOnly: false, line };

  if (target === "module.exports") {
    if (right.type === "object") {
      const out: RawExport[] = [];
      for (const p of right.namedChildren) {
        if (p.type === "shorthand_property_identifier") {
          out.push({ ...base, exported: p.text, local: p.text });
        } else if (p.type === "pair") {
          const key = p.childForFieldName("key")?.text;
          const val = p.childForFieldName("value");
          if (key) out.push({ ...base, exported: key, local: val?.type === "identifier" ? val.text : null });
        }
      }
      return out;
    }
    return [{ ...base, exported: "default", local: right.type === "identifier" ? right.text : null }];
  }

  const m = /^(?:module\.)?exports\.([A-Za-z_$][\w$]*)$/.exec(target);
  if (m) return [{ ...base, exported: m[1]!, local: right.type === "identifier" ? right.text : null }];
  return [];
}

export function extractExports(root: Node): RawExport[] {
  const out: RawExport[] = [];
  for (const stmt of root.namedChildren) {
    if (stmt.type === "export_statement") out.push(...fromExportStatement(stmt));
    else if (stmt.type === "expression_statement") out.push(...fromCommonJs(stmt));
  }
  return out;
}