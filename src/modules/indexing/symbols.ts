import { createHash } from "node:crypto";
import type Parser from "tree-sitter";
import { symbolId } from "../../core/ids.js";
import { lines, walk } from "./parser.js";

export type SymbolKind = "function" | "class" | "method" | "const" | "component" | "hook";

export interface SymbolFact {
  id: string;
  kind: SymbolKind;
  name: string;
  qualifiedName: string;
  lineStart: number;
  lineEnd: number;
  startIndex: number;
  endIndex: number;
  exported: boolean;
  isDefault: boolean;
  bodyHash: string;
  exportHash: string;
  /** Type names for injected / declared fields (class symbols only). */
  fieldTypes?: Record<string, string>;
}

type Node = Parser.SyntaxNode;

const FUNCTION_VALUES = new Set(["arrow_function", "function_expression", "function", "generator_function"]);
const FUNCTION_DECLS = new Set(["function_declaration", "generator_function_declaration"]);
const CLASS_NODES = new Set(["class_declaration", "abstract_class_declaration", "class"]);
const VAR_DECLS = new Set(["lexical_declaration", "variable_declaration"]);
const FIELD_NODES = new Set(["field_definition", "public_field_definition"]);
const JSX = new Set(["jsx_element", "jsx_self_closing_element", "jsx_fragment"]);
const PASCAL = /^[A-Z][A-Za-z0-9]*$/;
const HOOK = /^use[A-Z0-9]/;

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

function containsJsx(fn: Node): boolean {
  let found = false;
  walk(fn, (n) => {
    if (found) return false;
    if (JSX.has(n.type)) {
      found = true;
      return false;
    }
    return true;
  });
  return found;
}

function classifyFunction(name: string, fn: Node): SymbolKind {
  if (HOOK.test(name)) return "hook";
  if (PASCAL.test(name) && containsJsx(fn)) return "component";
  return "function";
}

function typeNameFrom(node: Node | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "type_annotation") {
    return typeNameFrom(
      node.childForFieldName("type") ??
        node.namedChildren.find((c) => c.type === "type_identifier" || c.type === "nested_type_identifier"),
    );
  }
  if (node.type === "type_identifier" || node.type === "identifier") return node.text;
  if (node.type === "nested_type_identifier") return node.text;
  if (node.type === "generic_type") return typeNameFrom(node.childForFieldName("type") ?? node.namedChildren[0]);
  if (node.type === "predefined_type") return node.text;
  return null;
}

function hasParameterProperty(param: Node): boolean {
	return param.children.some((c) => c.type === "accessibility_modifier");
}

function collectClassFieldTypes(cls: Node): Record<string, string> {
  const fieldTypes: Record<string, string> = {};
  const body = cls.childForFieldName("body");
  if (!body) return fieldTypes;

  const memberLabel = (member: Node): string | null =>
    member.childForFieldName("name")?.text ??
    member.childForFieldName("property")?.text ??
    member.namedChildren.find((c) => c.type === "property_identifier")?.text ??
    null;

  for (const member of body.namedChildren) {
    if (member.type === "method_definition" && memberLabel(member) === "constructor") {
      const params = member.childForFieldName("parameters");
      if (!params) continue;
      for (const param of params.namedChildren) {
        if (param.type !== "required_parameter" && param.type !== "optional_parameter") continue;
        const isPropertyParam = param.children.some((c) => c.type === "accessibility_modifier");
        if (!isPropertyParam) continue;
        const nameNode =
          param.childForFieldName("pattern") ?? param.namedChildren.find((c) => c.type === "identifier");
        const fieldName = nameNode?.text ?? null;
        const typeNode =
          param.childForFieldName("type") ?? param.namedChildren.find((c) => c.type === "type_annotation");
        const tn = typeNameFrom(typeNode);
        if (fieldName && tn) fieldTypes[fieldName] = tn;
      }
      continue;
    }
    if (!FIELD_NODES.has(member.type)) continue;
    const fieldName = memberLabel(member);
    const tn = typeNameFrom(member.childForFieldName("type"));
    if (fieldName && tn) fieldTypes[fieldName] = tn;
  }
  return fieldTypes;
}

export function extractSymbols(root: Node, path: string): SymbolFact[] {
  const out: SymbolFact[] = [];
  const seen = new Map<string, number>();

  const add = (kind: SymbolKind, name: string, node: Node, exported: boolean, isDefault: boolean, signature: string) => {
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    const qualifiedName = count > 1 ? `${name}~${count}` : name;
    const { start, end } = lines(node);
    out.push({
      id: symbolId(path, qualifiedName),
      kind,
      name,
      qualifiedName,
      lineStart: start,
      lineEnd: end,
      startIndex: node.startIndex,
      endIndex: node.endIndex,
      exported,
      isDefault,
      bodyHash: hash(node.text),
      exportHash: hash(`${kind}|${qualifiedName}|${exported}|${isDefault}|${signature}`),
    });
  };

  const params = (fn: Node) => fn.childForFieldName("parameters")?.text ?? fn.childForFieldName("parameter")?.text ?? "";

  const visitClass = (cls: Node, exported: boolean, isDefault: boolean) => {
    const className = cls.childForFieldName("name")?.text ?? "default";
    const body = cls.childForFieldName("body");
    const methods = body ? body.namedChildren : [];
    const fieldTypes = collectClassFieldTypes(cls);
    add(
      "class",
      className,
      cls,
      exported,
      isDefault,
      methods
        .map((m) => m.childForFieldName("name")?.text ?? m.childForFieldName("property")?.text ?? "")
        .join(","),
    );
    const classSym = out[out.length - 1]!;
    if (Object.keys(fieldTypes).length > 0) classSym.fieldTypes = fieldTypes;
    for (const member of methods) {
      const memberName = member.childForFieldName("name")?.text ?? member.childForFieldName("property")?.text;
      if (!memberName) continue;
      if (member.type === "method_definition") {
        add("method", `${className}.${memberName}`, member, exported, false, params(member));
      } else if (FIELD_NODES.has(member.type)) {
        const value = member.childForFieldName("value");
        if (value && FUNCTION_VALUES.has(value.type)) {
          add("method", `${className}.${memberName}`, member, exported, false, params(value));
        }
      }
    }
  };

  const visit = (node: Node, exported: boolean, isDefault: boolean): void => {
    if (node.type === "export_statement") {
      const isDef = node.children.some((c) => c.type === "default");
      const decl = node.childForFieldName("declaration") ?? node.childForFieldName("value");
      if (decl) visit(decl, true, isDef);
      return;
    }

    if (FUNCTION_DECLS.has(node.type) || (isDefault && FUNCTION_VALUES.has(node.type))) {
      const name = node.childForFieldName("name")?.text ?? "default";
      add(classifyFunction(name, node), name, node, exported, isDefault, params(node));
      return;
    }

    if (CLASS_NODES.has(node.type)) {
      visitClass(node, exported, isDefault);
      return;
    }

    if (VAR_DECLS.has(node.type)) {
      for (const d of node.namedChildren) {
        if (d.type !== "variable_declarator") continue;
        const nameNode = d.childForFieldName("name");
        if (!nameNode || nameNode.type !== "identifier") continue; // destructuring: known gap
        const name = nameNode.text;
        const value = d.childForFieldName("value");
        if (value && FUNCTION_VALUES.has(value.type)) {
          add(classifyFunction(name, value), name, d, exported, false, params(value));
        } else if (value && CLASS_NODES.has(value.type)) {
          visitClass(value, exported, false);
        } else {
          add("const", name, d, exported, false, "");
        }
      }
    }
    // interfaces, type aliases, enums, expressions: not symbols in this version
  };

  for (const stmt of root.namedChildren) visit(stmt, false, false);
  return out;
}