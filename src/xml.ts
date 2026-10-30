/**
 * Executes Babulus DSL code in the browser to generate CompositionSpec.
 *
 * This allows instant preview of DSL files without requiring server-side execution.
 *
 * Note: This uses a minimal browser-safe implementation of the DSL API.
 * The full DSL implementation in babulus/dsl includes Node.js dependencies (fs, crypto)
 * that cannot be used in the browser.
 */

/**
 * Executes .babulus.ts or .babulus.xml code in the browser.
 *
 * This approach strips the import statement and provides minimal DSL function
 * implementations directly in the execution context.
 *
 * @param code - The DSL code to execute
 * @returns Promise<any> - The result of executing the DSL (VideoFileSpec)
 * @throws Error if execution fails or module doesn't export default
 */
export async function executeDslFile(code: string): Promise<any> {
  try {
    const trimmed = code.trim();
    if (trimmed.startsWith("<")) {
      return loadVideoFileFromXml(trimmed);
    }
    // Remove import statements (we'll provide the functions directly)
    const codeWithoutImports = code.replace(/import\s+.*?from\s+['"].*?['"];?\s*/g, '');

    // Remove export default and capture the expression
    const codeWithoutExport = codeWithoutImports.replace(/export\s+default\s+/, 'return ');

    // Create a function that has access to DSL functions
    // We provide minimal browser-safe implementations
    const fn = new Function(
      'defineVideo',
      'defineDefaults',
      'defineEnv',
      'pause',
      codeWithoutExport
    );

    // Execute the function with minimal DSL function implementations
    const result = fn(
      createDefineVideo(),
      createDefineDefaults(),
      createDefineEnv(),
      createPause()
    );

    if (!result) {
      throw new Error('DSL file must export a default value');
    }

    // Handle async defineVideo (in case DSL has async setup)
    if (typeof result === 'object' && result !== null && 'then' in result) {
      return await result;
    }

    return result;
  } catch (error) {
    // Provide helpful error message
    if (error instanceof Error) {
      throw new Error(`Failed to execute DSL: ${error.message}`);
    }
    throw new Error('Failed to execute DSL: Unknown error');
  }
}

export type VomPatchInput =
  | { op: "appendNode"; parentId: string; nodeXml: string; index?: number }
  | { op: "removeNode"; nodeId: string }
  | { op: "setAttr"; nodeId: string; name: string; value: string | null }
  | { op: "setText"; nodeId: string; textContent: string }
  | { op: "replaceSubtree"; nodeId: string; nodeXml: string }
  | { op: "sealScene"; sceneId: string };

export function applyVomPatchesInBrowser(xml: string, patches: VomPatchInput[], enforceSealed = false): string {
  type NodeLike = {
    nodeType: number;
    parentNode: NodeLike | null;
    childNodes: ArrayLike<NodeLike> | null;
  };
  type ElementLike = NodeLike & {
    tagName: string;
    getAttribute: (name: string) => string | null;
    setAttribute: (name: string, value: string) => void;
    removeAttribute: (name: string) => void;
    appendChild: (child: NodeLike) => void;
    insertBefore: (child: NodeLike, ref: NodeLike | null) => void;
    replaceChild: (newChild: NodeLike, oldChild: NodeLike) => void;
    removeChild: (child: NodeLike) => void;
    textContent: string | null;
  };

  const parser = new DOMParser();
  const serializer = new XMLSerializer();
  const doc = parser.parseFromString(xml, "text/xml");
  const root = doc.documentElement as unknown as ElementLike;
  const rootTag = root?.tagName ?? "";
  const allowedRoots = new Set(["videoml", "video-ml", "vml"]);
  if (!allowedRoots.has(rootTag)) {
    throw new Error("XML root must be <vml>, <videoml>, or <video-ml>.");
  }

  const isElement = (node: NodeLike | null | undefined): node is ElementLike =>
    Boolean(node && node.nodeType === 1);
  const walk = (visit: (el: ElementLike) => void) => {
    const stack: ElementLike[] = [root];
    while (stack.length) {
      const node = stack.pop();
      if (!node) continue;
      visit(node);
      const children = Array.from(node.childNodes ?? []).filter(isElement) as ElementLike[];
      for (let i = children.length - 1; i >= 0; i -= 1) {
        stack.push(children[i]);
      }
    }
  };
  const findById = (id: string): ElementLike | null => {
    let found: ElementLike | null = null;
    walk((el) => {
      if (found) return;
      if (el.getAttribute("id") === id) {
        found = el;
      }
    });
    return found;
  };
  const findSceneAncestor = (node: ElementLike): ElementLike | null => {
    let current: NodeLike | null = node;
    while (current) {
      if (isElement(current) && current.tagName === "scene") {
        return current;
      }
      current = current.parentNode;
    }
    return null;
  };
  const assertNotSealed = (node: ElementLike) => {
    if (!enforceSealed) return;
    const scene = findSceneAncestor(node);
    if (!scene) return;
    const sealed = scene.getAttribute("sealed") ?? scene.getAttribute("data-sealed");
    if (sealed === "true") {
      const sceneId = scene.getAttribute("id") ?? "unknown";
      throw new Error(`Cannot patch sealed scene "${sceneId}".`);
    }
  };
  const parseFragment = (nodeXml: string): ElementLike => {
    const fragDoc = parser.parseFromString(`<root>${nodeXml}</root>`, "text/xml");
    const fragRoot = fragDoc.documentElement as unknown as ElementLike;
    const first = Array.from(fragRoot.childNodes ?? []).find(isElement);
    if (!first) {
      throw new Error("nodeXml must contain a single root element.");
    }
    return first as ElementLike;
  };

  for (const patch of patches) {
    switch (patch.op) {
      case "appendNode": {
        const parent = findById(patch.parentId);
        if (!parent) throw new Error(`appendNode: parent "${patch.parentId}" not found.`);
        assertNotSealed(parent);
        const newNode = parseFragment(patch.nodeXml);
        const imported = doc.importNode ? doc.importNode(newNode as any, true) : (newNode as any);
        const parentNode = parent as ElementLike;
        const children = Array.from(parentNode.childNodes ?? []).filter(isElement);
        if (patch.index == null || patch.index >= children.length) {
          parentNode.appendChild(imported);
        } else {
          parentNode.insertBefore(imported, children[patch.index]);
        }
        break;
      }
      case "removeNode": {
        const target = findById(patch.nodeId);
        if (!target || !target.parentNode) {
          throw new Error(`removeNode: node "${patch.nodeId}" not found.`);
        }
        assertNotSealed(target);
        const parentNode = target.parentNode as ElementLike;
        parentNode.removeChild(target);
        break;
      }
      case "setAttr": {
        const target = findById(patch.nodeId);
        if (!target) throw new Error(`setAttr: node "${patch.nodeId}" not found.`);
        assertNotSealed(target);
        if (patch.value == null) {
          target.removeAttribute(patch.name);
        } else {
          target.setAttribute(patch.name, patch.value);
        }
        break;
      }
      case "setText": {
        const target = findById(patch.nodeId);
        if (!target) throw new Error(`setText: node "${patch.nodeId}" not found.`);
        assertNotSealed(target);
        target.textContent = patch.textContent;
        break;
      }
      case "replaceSubtree": {
        const target = findById(patch.nodeId);
        if (!target || !target.parentNode) {
          throw new Error(`replaceSubtree: node "${patch.nodeId}" not found.`);
        }
        assertNotSealed(target);
        const newNode = parseFragment(patch.nodeXml);
        const imported = doc.importNode ? doc.importNode(newNode as any, true) : (newNode as any);
        const parentNode = target.parentNode as ElementLike;
        parentNode.replaceChild(imported, target);
        break;
      }
      case "sealScene": {
        const scene = findById(patch.sceneId);
        if (!scene || scene.tagName !== "scene") {
          throw new Error(`sealScene: scene "${patch.sceneId}" not found.`);
        }
        scene.setAttribute("sealed", "true");
        break;
      }
    }
  }

  return serializer.serializeToString(doc);
}

export function executeVomXml(xml: string, patches?: VomPatchInput[], enforceSealed = false): any {
  const source = patches && patches.length
    ? applyVomPatchesInBrowser(xml, patches, enforceSealed)
    : xml;
  return loadVideoFileFromXml(source);
}

function loadVideoFileFromXml(xml: string): any {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, "text/xml");
  const root = doc.documentElement;
  const rootTag = root?.tagName ?? "";
  const allowedRoots = new Set(["videoml", "video-ml", "vml"]);
  if (!allowedRoots.has(rootTag)) {
    throw new Error("XML root must be <vml>, <videoml>, or <video-ml>.");
  }
  const getAttr = (el: Element, name: string) => el.getAttribute(name);
  const parseNumber = (value: string | null) => {
    if (!value) return null;
    if (!/^[-+]?\d+(\.\d+)?$/.test(value)) return null;
    return Number.parseFloat(value);
  };
  class MissingTimeReferenceError extends Error {}

  type TimeEvalContext = {
    fps: number;
    getSceneStart: (id: string) => number | null;
    getSceneEnd: (id: string) => number | null;
    getCueStart: (id: string) => number | null;
    getPrevStart: () => number | null;
    getPrevEnd: () => number | null;
    getNextStart: () => number | null;
  };

  type Token =
    | { type: "number"; value: number; unit?: "f" | "s" | "ms" }
    | { type: "identifier"; value: string }
    | { type: "operator"; value: "+" | "-" | "*" | "/" }
    | { type: "paren"; value: "(" | ")" }
    | { type: "dot"; value: "." }
    | { type: "comma"; value: "," };

  type AstNode =
    | { kind: "number"; value: number; unit?: "f" | "s" | "ms" }
    | { kind: "identifier"; value: string }
    | { kind: "binary"; op: "+" | "-" | "*" | "/"; left: AstNode; right: AstNode }
    | { kind: "unary"; op: "+" | "-"; value: AstNode }
    | { kind: "call"; name: string; args: AstNode[] }
    | { kind: "property"; target: AstNode; prop: string };

  const tokenizeTime = (input: string): Token[] => {
    const tokens: Token[] = [];
    let i = 0;
    while (i < input.length) {
      const ch = input[i];
      if (ch === " " || ch === "\t" || ch === "\n") {
        i += 1;
        continue;
      }
      if (ch === "+" || ch === "-" || ch === "*" || ch === "/") {
        tokens.push({ type: "operator", value: ch });
        i += 1;
        continue;
      }
      if (ch === "(" || ch === ")") {
        tokens.push({ type: "paren", value: ch });
        i += 1;
        continue;
      }
      if (ch === ".") {
        tokens.push({ type: "dot", value: "." });
        i += 1;
        continue;
      }
      if (ch === ",") {
        tokens.push({ type: "comma", value: "," });
        i += 1;
        continue;
      }
      if (/\d/.test(ch) || (ch === "." && /\d/.test(input[i + 1] ?? ""))) {
        let j = i + 1;
        while (j < input.length && /[\d.]/.test(input[j] ?? "")) j += 1;
        const raw = input.slice(i, j);
        let unit: "f" | "s" | "ms" | undefined;
        if (input.slice(j, j + 2) === "ms") {
          unit = "ms";
          j += 2;
        } else if (input[j] === "f" || input[j] === "s") {
          unit = input[j] as "f" | "s";
          j += 1;
        }
        tokens.push({ type: "number", value: Number.parseFloat(raw), unit });
        i = j;
        continue;
      }
      if (/[A-Za-z_]/.test(ch)) {
        let j = i + 1;
        while (j < input.length && /[A-Za-z0-9_-]/.test(input[j] ?? "")) j += 1;
        tokens.push({ type: "identifier", value: input.slice(i, j) });
        i = j;
        continue;
      }
      throw new Error(`Unexpected character "${ch}" in time expression.`);
    }
    return tokens;
  };

  const parseTimeExpression = (input: string): AstNode => {
    const tokens = tokenizeTime(input);
    let idx = 0;
    const peek = () => tokens[idx];
    const consume = () => tokens[idx++];

    const parsePrimary = (): AstNode => {
      const token = consume();
      if (!token) throw new Error("Unexpected end of time expression.");
      if (token.type === "number") {
        return { kind: "number", value: token.value, unit: token.unit };
      }
      if (token.type === "identifier") {
        let node: AstNode = { kind: "identifier", value: token.value };
        if (peek()?.type === "paren" && peek()?.value === "(") {
          consume();
          const args: AstNode[] = [];
          if (!(peek()?.type === "paren" && peek()?.value === ")")) {
            while (true) {
              args.push(parseExpression());
              if (peek()?.type === "comma") {
                consume();
                continue;
              }
              break;
            }
          }
          const closing = consume();
          if (!closing || closing.type !== "paren" || closing.value !== ")") {
            throw new Error("Expected closing ')' in time expression.");
          }
          node = { kind: "call", name: token.value, args };
        }
        while (peek()?.type === "dot") {
          consume();
          const prop = consume();
          if (!prop || prop.type !== "identifier") {
            throw new Error("Expected property name after '.'.");
          }
          node = { kind: "property", target: node, prop: prop.value };
        }
        return node;
      }
      if (token.type === "paren" && token.value === "(") {
        const expr = parseExpression();
        const closing = consume();
        if (!closing || closing.type !== "paren" || closing.value !== ")") {
          throw new Error("Expected closing ')' in time expression.");
        }
        return expr;
      }
      throw new Error("Invalid time expression.");
    };

    const parseUnary = (): AstNode => {
      const token = peek();
      if (token && token.type === "operator" && (token.value === "+" || token.value === "-")) {
        consume();
        return { kind: "unary", op: token.value, value: parseUnary() };
      }
      return parsePrimary();
    };

    const parseTerm = (): AstNode => {
      let node = parseUnary();
      while (peek()?.type === "operator" && (peek()?.value === "*" || peek()?.value === "/")) {
        const op = consume() as Token & { type: "operator" };
        node = { kind: "binary", op: op.value, left: node, right: parseUnary() };
      }
      return node;
    };

    const parseExpression = (): AstNode => {
      let node = parseTerm();
      while (peek()?.type === "operator" && (peek()?.value === "+" || peek()?.value === "-")) {
        const op = consume() as Token & { type: "operator" };
        node = { kind: "binary", op: op.value, left: node, right: parseTerm() };
      }
      return node;
    };

    const expr = parseExpression();
    if (idx < tokens.length) {
      throw new Error("Unexpected token in time expression.");
    }
    return expr;
  };

  const evalTimeAst = (node: AstNode, ctx: TimeEvalContext): number => {
    switch (node.kind) {
      case "number": {
        if (!node.unit) return node.value;
        if (node.unit === "f") return node.value / ctx.fps;
        if (node.unit === "ms") return node.value / 1000;
        return node.value;
      }
      case "identifier": {
        if (node.value === "timeline") {
          throw new Error("timeline requires a property (e.g. timeline.start).");
        }
        throw new Error(`Unknown identifier "${node.value}" in time expression.`);
      }
      case "unary": {
        const val = evalTimeAst(node.value, ctx);
        return node.op === "-" ? -val : val;
      }
      case "binary": {
        const left = evalTimeAst(node.left, ctx);
        const right = evalTimeAst(node.right, ctx);
        switch (node.op) {
          case "+":
            return left + right;
          case "-":
            return left - right;
          case "*":
            return left * right;
          case "/":
            return left / right;
        }
      }
      case "call": {
        const name = node.name;
        if (name === "min" || name === "max") {
          if (node.args.length < 2) {
            throw new Error(`${name} requires at least 2 arguments.`);
          }
          const values = node.args.map((arg) => evalTimeAst(arg, ctx));
          return name === "min" ? Math.min(...values) : Math.max(...values);
        }
        if (name === "clamp") {
          if (node.args.length !== 3) {
            throw new Error("clamp requires 3 arguments.");
          }
          const value = evalTimeAst(node.args[0], ctx);
          const min = evalTimeAst(node.args[1], ctx);
          const max = evalTimeAst(node.args[2], ctx);
          return Math.min(max, Math.max(min, value));
        }
        if (name === "snap") {
          if (node.args.length !== 2) {
            throw new Error("snap requires 2 arguments.");
          }
          const value = evalTimeAst(node.args[0], ctx);
          const grid = evalTimeAst(node.args[1], ctx);
          return grid === 0 ? value : Math.round(value / grid) * grid;
        }
        if (name === "scene") {
          const arg = node.args[0];
          if (!arg || arg.kind !== "identifier") {
            throw new Error("scene() requires an identifier argument.");
          }
          const value = ctx.getSceneStart(arg.value);
          if (value == null) throw new MissingTimeReferenceError(`scene(${arg.value})`);
          return value;
        }
        if (name === "cue") {
          const arg = node.args[0];
          if (!arg || arg.kind !== "identifier") {
            throw new Error("cue() requires an identifier argument.");
          }
          const value = ctx.getCueStart(arg.value);
          if (value == null) throw new MissingTimeReferenceError(`cue(${arg.value})`);
          return value;
        }
        throw new Error(`Unknown function "${name}".`);
      }
      case "property": {
        if (node.target.kind === "identifier" && node.target.value === "prev") {
          if (node.prop === "start") {
            const value = ctx.getPrevStart();
            if (value == null) throw new MissingTimeReferenceError("prev.start");
            return value;
          }
          if (node.prop === "end") {
            const value = ctx.getPrevEnd();
            if (value == null) throw new MissingTimeReferenceError("prev.end");
            return value;
          }
        }
        if (node.target.kind === "identifier" && node.target.value === "next") {
          if (node.prop === "start") {
            const value = ctx.getNextStart();
            if (value == null) throw new MissingTimeReferenceError("next.start");
            return value;
          }
        }
        if (node.target.kind === "identifier" && node.target.value === "timeline" && node.prop === "start") {
          return 0;
        }
        if (node.target.kind === "call" && node.target.name === "scene") {
          const arg = node.target.args[0];
          if (!arg || arg.kind !== "identifier") {
            throw new Error("scene() requires an identifier argument.");
          }
          if (node.prop === "start") {
            const value = ctx.getSceneStart(arg.value);
            if (value == null) throw new MissingTimeReferenceError(`scene(${arg.value}).start`);
            return value;
          }
          if (node.prop === "end") {
            const value = ctx.getSceneEnd(arg.value);
            if (value == null) throw new MissingTimeReferenceError(`scene(${arg.value}).end`);
            return value;
          }
        }
        throw new Error(`Unsupported property access ".${node.prop}".`);
      }
    }
  };

  const parseTimeValue = (value: string, ctx: TimeEvalContext) => {
    const expr = parseTimeExpression(value.trim());
    return evalTimeAst(expr, ctx);
  };
  const toCamelCase = (value: string) => value.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
  const toPascalCase = (value: string) =>
    value
      .split("-")
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join("");
  const parseProps = (el: Element, reserved: Set<string>) => {
    const props: Record<string, unknown> = {};
    const attrs = Array.from(el.attributes);
    const propsAttr = el.getAttribute("props");
    if (propsAttr) {
      Object.assign(props, JSON.parse(propsAttr));
    }
    for (const attr of attrs) {
      if (attr.name === "props" || reserved.has(attr.name)) continue;
      const key = toCamelCase(attr.name);
      if (attr.value === "true") {
        props[key] = true;
        continue;
      }
      if (attr.value === "false") {
        props[key] = false;
        continue;
      }
      const num = parseNumber(attr.value);
      if (num != null) {
        props[key] = num;
        continue;
      }
      props[key] = attr.value;
    }
    return props;
  };
  const DEFAULT_SEQUENCE_CHILD_SECONDS = 1;
  const parseContainerTiming = (el: Element, ctx: TimeEvalContext) => {
    const startRaw = getAttr(el, "start");
    const endRaw = getAttr(el, "end");
    const durationRaw = getAttr(el, "duration");
    if (!startRaw && !endRaw && !durationRaw) return { startSec: 0, endSec: undefined as number | undefined };
    const start = startRaw ? parseTimeValue(startRaw, ctx) : 0;
    const end = endRaw ? parseTimeValue(endRaw, ctx) : undefined;
    if (durationRaw && end == null) {
      const duration = parseTimeValue(durationRaw, ctx);
      return { startSec: start, endSec: start + duration };
    }
    return { startSec: start, endSec: end };
  };
  const parseComponentElement = (
    el: Element,
    ctx: TimeEvalContext,
    componentIndex: number,
    timingOverride?: { startSec?: number; endSec?: number },
  ) => {
    const reserved = new Set(["id", "visible", "z", "start", "end", "duration", "styles", "markup", "props"]);
    const props = parseProps(el, reserved);
    const timing = timingOverride ?? parseTiming(el, ctx);
    const compId = getAttr(el, "id") ?? `${el.tagName}-${componentIndex}`;
    const compType = toPascalCase(el.tagName);
    const compVisibleRaw = getAttr(el, "visible");
    const compZRaw = getAttr(el, "z");
    const compStylesRaw = getAttr(el, "styles");
    const compMarkupRaw = getAttr(el, "markup");
    return {
      id: compId,
      type: compType,
      props,
      timing,
      visible: compVisibleRaw ? compVisibleRaw === "true" : undefined,
      zIndex: compZRaw ? parseNumber(compZRaw) ?? undefined : undefined,
      styles: compStylesRaw ? JSON.parse(compStylesRaw) : undefined,
      markup: compMarkupRaw ? JSON.parse(compMarkupRaw) : undefined,
    };
  };
  const mergeCascaded = <T extends Record<string, unknown> | undefined>(parent: T, child: T): T => {
    if (!parent) return child;
    if (!child) return parent;
    return { ...parent, ...child } as T;
  };
  const parseContainerChildren = (
    el: Element,
    ctx: TimeEvalContext,
    componentIndex: number,
    containerStart: number,
    flow: "sequence" | "stack",
    inheritedStyles?: Record<string, unknown>,
    inheritedMarkup?: Record<string, unknown>,
  ): { components: any[]; componentIndex: number; maxEnd?: number } => {
    const components: any[] = [];
    let cursor = containerStart;
    let maxEnd: number | undefined = undefined;
    const containerStylesRaw = getAttr(el, "styles");
    const containerMarkupRaw = getAttr(el, "markup");
    const containerStyles = containerStylesRaw ? JSON.parse(containerStylesRaw) : undefined;
    const containerMarkup = containerMarkupRaw ? JSON.parse(containerMarkupRaw) : undefined;
    const cascadedStyles = mergeCascaded(inheritedStyles, containerStyles);
    const cascadedMarkup = mergeCascaded(inheritedMarkup, containerMarkup);
    for (const child of Array.from(el.children)) {
      if (["scene", "cue", "layer", "pause", "voice", "bullet", "voiceover"].includes(child.tagName)) {
        continue;
      }
      if (child.tagName === "sequence" || child.tagName === "stack") {
        const childTiming = parseContainerTiming(child, ctx);
        const childStart = containerStart + (childTiming.startSec ?? 0);
        const nested = parseContainerChildren(
          child,
          ctx,
          componentIndex,
          flow === "sequence" ? cursor : childStart,
          child.tagName as "sequence" | "stack",
          cascadedStyles,
          cascadedMarkup,
        );
        components.push(...nested.components);
        componentIndex = nested.componentIndex;
        if (flow === "sequence") {
          cursor = nested.maxEnd ?? cursor;
        } else if (nested.maxEnd != null) {
          maxEnd = maxEnd == null ? nested.maxEnd : Math.max(maxEnd, nested.maxEnd);
        }
        continue;
      }

      const startOffset = getAttr(child, "start") ? parseTimeValue(getAttr(child, "start") as string, ctx) : undefined;
      const endOffset = getAttr(child, "end") ? parseTimeValue(getAttr(child, "end") as string, ctx) : undefined;
      const durationValue = getAttr(child, "duration")
        ? parseTimeValue(getAttr(child, "duration") as string, ctx)
        : undefined;

      const baseStart = flow === "sequence" ? cursor : containerStart;
      const childStart = baseStart + (startOffset ?? 0);
      let childEnd: number | undefined;
      if (durationValue != null) {
        childEnd = childStart + durationValue;
      } else if (endOffset != null) {
        childEnd = containerStart + endOffset;
      } else if (flow === "sequence") {
        childEnd = childStart + DEFAULT_SEQUENCE_CHILD_SECONDS;
      }

      const timingOverride =
        childStart != null || childEnd != null ? { startSec: childStart, endSec: childEnd } : undefined;
      const parsedComponent = parseComponentElement(child, ctx, componentIndex, timingOverride);
      parsedComponent.styles = mergeCascaded(cascadedStyles, parsedComponent.styles);
      parsedComponent.markup = mergeCascaded(cascadedMarkup, parsedComponent.markup);
      components.push(parsedComponent);
      componentIndex += 1;

      if (flow === "sequence") {
        cursor = childEnd ?? cursor;
      } else if (childEnd != null) {
        maxEnd = maxEnd == null ? childEnd : Math.max(maxEnd, childEnd);
      }
    }

    if (flow === "sequence") {
      maxEnd = cursor;
    }
    return { components, componentIndex, maxEnd };
  };
  const parseTimeRange = (el: Element, ctx: TimeEvalContext, label: string) => {
    const startRaw = getAttr(el, "start");
    const endRaw = getAttr(el, "end");
    const durationRaw = getAttr(el, "duration");
    if (!startRaw && !endRaw && !durationRaw) return undefined;
    if (!startRaw && (endRaw || durationRaw)) {
      throw new Error(`${label} timing requires start when end or duration is provided.`);
    }
    const start = startRaw ? parseTimeValue(startRaw, ctx) : undefined;
    const endExplicit = endRaw ? parseTimeValue(endRaw, ctx) : undefined;
    if (start != null && durationRaw && endExplicit == null) {
      const duration = parseTimeValue(durationRaw, ctx);
      return { start, end: start + duration };
    }
    if (start != null && endExplicit != null) {
      return { start, end: endExplicit };
    }
    if (start != null) {
      return { start };
    }
    return undefined;
  };
  const parseTiming = (el: Element, ctx: TimeEvalContext) => {
    const startRaw = getAttr(el, "start");
    const endRaw = getAttr(el, "end");
    const durationRaw = getAttr(el, "duration");
    if (!startRaw && !endRaw && !durationRaw) return undefined;
    const start = startRaw ? parseTimeValue(startRaw, ctx) : durationRaw ? 0 : undefined;
    const end = endRaw ? parseTimeValue(endRaw, ctx) : undefined;
    if (start != null && durationRaw && end == null) {
      const duration = parseTimeValue(durationRaw, ctx);
      return { startSec: start, endSec: start + duration };
    }
    return { startSec: start, endSec: end };
  };
  const parsePause = (el: Element, ctx: TimeEvalContext) => {
    const seconds = getAttr(el, "seconds");
    if (seconds) {
      return { kind: "pause", mode: "fixed", seconds: parseTimeValue(seconds, ctx) };
    }
    const mean = getAttr(el, "mean");
    const std = getAttr(el, "std");
    if (mean && std) {
      const pause: any = {
        kind: "pause",
        mode: "gaussian",
        mean: parseTimeValue(mean, ctx),
        std: parseTimeValue(std, ctx),
      };
      const min = getAttr(el, "min");
      const max = getAttr(el, "max");
      if (min) pause.min = parseTimeValue(min, ctx);
      if (max) pause.max = parseTimeValue(max, ctx);
      return pause;
    }
    throw new Error("pause requires seconds or mean+std.");
  };
  const parseCue = (el: Element, ctx: TimeEvalContext) => {
    const id = getAttr(el, "id");
    if (!id) throw new Error("cue requires id.");
    const label = getAttr(el, "label") ?? id;
    const provider = getAttr(el, "provider");
    const segments: any[] = [];
    const time = parseTimeRange(el, ctx, `cue \"${id}\"`);
    const bullets: string[] = [];
    for (const child of Array.from(el.children)) {
      if (child.tagName === "voice") {
        const text = (child.textContent ?? "").replace(/\s+/g, " ").trim();
        if (!text) continue;
        const trimEnd = getAttr(child, "trim-end");
        segments.push({
          kind: "text",
          text,
          trimEndSec: trimEnd ? parseTimeValue(trimEnd, ctx) : undefined,
        });
      } else if (child.tagName === "pause") {
        segments.push({ kind: "pause", pause: parsePause(child, ctx) });
      } else if (child.tagName === "bullet") {
        const bullet = (child.textContent ?? "").replace(/\s+/g, " ").trim();
        if (bullet) bullets.push(bullet);
      }
    }
    return { kind: "cue", id, label, segments, bullets, provider: provider ?? null, time };
  };

  const fps = parseNumber(getAttr(root, "fps") ?? "") ?? 30;
  const width = parseNumber(getAttr(root, "width") ?? "") ?? 1280;
  const height = parseNumber(getAttr(root, "height") ?? "") ?? 720;
  const id = getAttr(root, "id");
  if (!id) throw new Error("vml requires id.");
  const title = getAttr(root, "title");
  const baseCtx: TimeEvalContext = {
    fps,
    getSceneStart: () => null,
    getSceneEnd: () => null,
    getCueStart: () => null,
    getPrevStart: () => null,
    getPrevEnd: () => null,
    getNextStart: () => null,
  };
  const durationRaw = getAttr(root, "duration");
  const posterRaw = getAttr(root, "poster");
  const durationSeconds = durationRaw ? parseTimeValue(durationRaw, baseCtx) : undefined;
  const posterTime = posterRaw ? parseTimeValue(posterRaw, baseCtx) : undefined;

  const scenes: any[] = [];
  let voiceover: any = undefined;
  const cueIds = new Set<string>();
  const sceneStartIndex = new Map<string, number>();
  const sceneEndIndex = new Map<string, number>();
  const cueStartIndex = new Map<string, number>();
  const sceneElements = Array.from(root.children).filter((child) => child.tagName === "scene");
  const pending = new Set(sceneElements.keys());
  let passes = 0;

  while (pending.size > 0) {
    let progressed = false;
    for (const index of Array.from(pending)) {
      const sceneEl = sceneElements[index];
      const prev = index > 0 ? scenes[index - 1] : null;
      const next = index + 1 < sceneElements.length ? sceneElements[index + 1] : null;
      const ctx: TimeEvalContext = {
        fps,
        getSceneStart: (sceneId) => sceneStartIndex.get(sceneId) ?? null,
        getSceneEnd: (sceneId) => sceneEndIndex.get(sceneId) ?? null,
        getCueStart: (cueId) => cueStartIndex.get(cueId) ?? null,
        getPrevStart: () => (prev ? sceneStartIndex.get(prev.id) ?? null : null),
        getPrevEnd: () => (prev ? sceneEndIndex.get(prev.id) ?? null : null),
        getNextStart: () => {
          if (!next) return null;
          const nextId = getAttr(next, "id");
          return nextId ? sceneStartIndex.get(nextId) ?? null : null;
        },
      };

      try {
        const sceneId = getAttr(sceneEl, "id");
        if (!sceneId) throw new Error("scene requires id.");
        const sceneTitle = getAttr(sceneEl, "title") ?? sceneId;
        const sceneTiming = parseTiming(sceneEl, ctx);
        const sceneStylesRaw = getAttr(sceneEl, "styles");
        const sceneMarkupRaw = getAttr(sceneEl, "markup");
        const items: any[] = [];
        const layers: any[] = [];
        const components: any[] = [];
        let componentIndex = 0;
        for (const child of Array.from(sceneEl.children)) {
          if (child.tagName === "cue") {
            const cue = parseCue(child, ctx);
            if (cueIds.has(cue.id)) {
              throw new Error(`Duplicate cue id across scenes: \"${cue.id}\".`);
            }
            cueIds.add(cue.id);
            if (cue.time?.start != null) {
              cueStartIndex.set(cue.id, cue.time.start);
            }
            items.push(cue);
          } else if (child.tagName === "pause") {
            items.push(parsePause(child, ctx));
          } else if (child.tagName === "layer") {
            const layerId = getAttr(child, "id");
            if (!layerId) throw new Error("layer requires id.");
            const layerTiming = parseTiming(child, ctx);
            const layerVisible = getAttr(child, "visible");
            const layerZ = getAttr(child, "z");
            const layerStylesRaw = getAttr(child, "styles");
            const layerMarkupRaw = getAttr(child, "markup");
            const layerComponents: any[] = [];
            let layerComponentIndex = 0;
            for (const layerChild of Array.from(child.children)) {
              if (["scene", "cue", "layer", "pause", "voice", "bullet", "voiceover"].includes(layerChild.tagName)) {
                continue;
              }
              if (layerChild.tagName === "sequence" || layerChild.tagName === "stack") {
                const containerTiming = parseContainerTiming(layerChild, ctx);
                const containerStart = containerTiming.startSec ?? 0;
                const parsed = parseContainerChildren(
                  layerChild,
                  ctx,
                  layerComponentIndex,
                  containerStart,
                  layerChild.tagName as "sequence" | "stack",
                  undefined,
                  undefined,
                );
                layerComponents.push(...parsed.components);
                layerComponentIndex = parsed.componentIndex;
                continue;
              }
              layerComponents.push(parseComponentElement(layerChild, ctx, layerComponentIndex));
              layerComponentIndex += 1;
            }
            layers.push({
              id: layerId,
              timing: layerTiming,
              visible: layerVisible ? layerVisible === "true" : undefined,
              zIndex: layerZ ? parseNumber(layerZ) ?? undefined : undefined,
              styles: layerStylesRaw ? JSON.parse(layerStylesRaw) : undefined,
              markup: layerMarkupRaw ? JSON.parse(layerMarkupRaw) : undefined,
              components: layerComponents,
            });
          } else {
            if (child.tagName === "sequence" || child.tagName === "stack") {
              const containerTiming = parseContainerTiming(child, ctx);
              const containerStart = containerTiming.startSec ?? 0;
              const parsed = parseContainerChildren(
                child,
                ctx,
                componentIndex,
                containerStart,
                child.tagName as "sequence" | "stack",
                undefined,
                undefined,
              );
              components.push(...parsed.components);
              componentIndex = parsed.componentIndex;
              continue;
            }
            components.push(parseComponentElement(child, ctx, componentIndex));
            componentIndex += 1;
          }
        }
        // Cues are optional in V3 (visual-only scenes are allowed).
        const sceneData = {
          id: sceneId,
          title: sceneTitle,
          time: sceneTiming ? { start: sceneTiming.startSec, end: sceneTiming.endSec } : undefined,
          styles: sceneStylesRaw ? JSON.parse(sceneStylesRaw) : undefined,
          markup: sceneMarkupRaw ? JSON.parse(sceneMarkupRaw) : undefined,
          items,
          layers: layers.length ? layers : undefined,
          components: components.length ? components : undefined,
        };
        scenes[index] = sceneData;
        if (sceneData.time?.start != null) sceneStartIndex.set(sceneData.id, sceneData.time.start);
        if (sceneData.time?.end != null) sceneEndIndex.set(sceneData.id, sceneData.time.end);
        pending.delete(index);
        progressed = true;
      } catch (err) {
        if (!(err instanceof MissingTimeReferenceError)) {
          throw err;
        }
      }
    }
    passes += 1;
    if (!progressed) {
      const unresolved = Array.from(pending)
        .map((idx) => getAttr(sceneElements[idx], "id") ?? `scene#${idx}`)
        .join(", ");
      throw new Error(`Unresolved time references for scenes: ${unresolved}`);
    }
    if (passes > sceneElements.length + 2) {
      throw new Error("Time resolution did not converge.");
    }
  }

  for (const sceneEl of Array.from(root.children)) {
    if (sceneEl.tagName === "voiceover") {
      voiceover = {
        provider: getAttr(sceneEl, "provider") ?? undefined,
        voice: getAttr(sceneEl, "voice") ?? undefined,
        model: getAttr(sceneEl, "model") ?? undefined,
        format: getAttr(sceneEl, "format") ?? undefined,
        sampleRateHz: parseNumber(getAttr(sceneEl, "sampleRateHz")) ?? undefined,
        seed: parseNumber(getAttr(sceneEl, "seed")) ?? undefined,
        leadInSeconds: getAttr(sceneEl, "leadInSeconds")
          ? parseTimeValue(getAttr(sceneEl, "leadInSeconds") as string, baseCtx)
          : undefined,
        trimEndSeconds: getAttr(sceneEl, "trimEndSeconds")
          ? parseTimeValue(getAttr(sceneEl, "trimEndSeconds") as string, baseCtx)
          : undefined,
      };
    }
  }

  if (!scenes.length) {
    throw new Error("vml requires at least one scene.");
  }

  return {
    compositions: [
      {
        id,
        title: title ?? null,
        meta: { fps, width, height, durationSeconds },
        posterTime,
        voiceover,
        scenes,
      },
    ],
  };
}

/**
 * Browser-safe implementation of defineVideo.
 * Simplified version that captures the builder calls.
 */
function createDefineVideo() {
  return function defineVideo(
    titleOrFn: string | Function,
    configOrFn?: any | Function,
    fnMaybe?: Function
  ): any {
    // Determine which signature was used
    let title: string;
    let config: any = {};
    let fn: Function;

    if (typeof titleOrFn === 'string' && typeof configOrFn === 'object' && fnMaybe) {
      // defineVideo(title, config, fn)
      title = titleOrFn;
      config = configOrFn;
      fn = fnMaybe;
    } else if (typeof titleOrFn === 'string' && typeof configOrFn === 'function') {
      // defineVideo(title, fn)
      title = titleOrFn;
      fn = configOrFn;
    } else {
      throw new Error('defineVideo requires at least a title and function: defineVideo(title, fn) or defineVideo(title, config, fn)');
    }

    const builder = createCompositionBuilder(title, config);
    const result = fn(builder);

    // Handle async
    if (result && typeof result.then === 'function') {
      return result.then(() => ({
        compositions: [builder._getSpec()]
      }));
    }

    return {
      compositions: [builder._getSpec()]
    };
  };
}

/**
 * Browser-safe implementation of defineDefaults.
 */
function createDefineDefaults() {
  return function defineDefaults(defaults: any) {
    return defaults;
  };
}

/**
 * Browser-safe implementation of defineEnv.
 */
function createDefineEnv() {
  return function defineEnv(config: any) {
    return config;
  };
}

/**
 * Browser-safe implementation of pause helper.
 */
function createPause() {
  return function pause(seconds: number) {
    return { kind: 'pause' as const, seconds };
  };
}

/**
 * Minimal CompositionBuilder for browser execution.
 * Captures the scene/cue structure without full validation.
 */
function createCompositionBuilder(name: string, opts: any) {
  const scenes: any[] = [];
  let voiceoverConfig: any = null;

  const builder = {
    voiceover(config: any) {
      voiceoverConfig = config;
    },

    scene(title: string, fn: Function) {
      const sceneBuilder = createSceneBuilder(title);
      fn(sceneBuilder);
      scenes.push(sceneBuilder._getSpec());
    },

    _getSpec() {
      return {
        id: name.toLowerCase().replace(/[^a-z0-9]/g, '-'),
        name,
        title: name,
        scenes,
        meta: opts.meta || opts,
        voiceoverConfig,
        items: []
      };
    }
  };

  return builder;
}

/**
 * Minimal SceneBuilder for browser execution.
 */
function createSceneBuilder(title: string) {
  const items: any[] = [];
  const cues: any[] = [];
  const layers: any[] = [];
  let sceneStyles: any = {};

  const builder = {
    styles(styles: any) {
      sceneStyles = styles;
    },

    layer(name: string, configOrFn: any, fnMaybe?: Function) {
      let config: any = {};
      let fn: Function;

      if (typeof configOrFn === 'function') {
        fn = configOrFn;
      } else {
        config = configOrFn;
        fn = fnMaybe!;
      }

      const layerBuilder = createLayerBuilder(name, config);
      fn(layerBuilder);
      layers.push(layerBuilder._getSpec());
    },

    cue(id: string, fn: Function) {
      const cueBuilder = createCueBuilder(id);
      fn(cueBuilder);
      const cueSpec = cueBuilder._getSpec();
      items.push(cueSpec);
      cues.push(cueSpec);
    },

    pause(seconds: number) {
      items.push({ kind: 'pause', seconds });
    },

    _getSpec() {
      return {
        id: title.toLowerCase().replace(/[^a-z0-9]/g, '-'),
        title,
        items,
        cues,
        layers,
        styles: sceneStyles
      };
    }
  };

  return builder;
}

/**
 * Minimal LayerBuilder for browser execution.
 */
function createLayerBuilder(name: string, config: any) {
  const components: any[] = [];

  const builder = {
    rectangle(props: any) {
      components.push({
        id: `rectangle-${components.length}`,
        type: 'Rectangle',
        props
      });
    },

    title(props: any) {
      components.push({
        id: `title-${components.length}`,
        type: 'Title',
        props
      });
    },

    subtitle(props: any) {
      components.push({
        id: `subtitle-${components.length}`,
        type: 'Subtitle',
        props
      });
    },

    progressBar(props: any) {
      components.push({
        id: `progressBar-${components.length}`,
        type: 'ProgressBar',
        props
      });
    },

    _getSpec() {
      return {
        id: `layer-${name}`,
        name,
        zIndex: config.zIndex || 0,
        styles: config.styles || {},
        components
      };
    }
  };

  return builder;
}

/**
 * Minimal CueBuilder for browser execution.
 */
function createCueBuilder(id: string) {
  const segments: any[] = [];

  const builder = {
    voice(fn: Function) {
      const voiceBuilder = createVoiceBuilder();
      fn(voiceBuilder);
      segments.push(...voiceBuilder._getSegments());
    },

    _getSpec() {
      return {
        kind: 'cue' as const,
        id,
        label: id,
        segments
      };
    }
  };

  return builder;
}

/**
 * Minimal VoiceBuilder for browser execution.
 */
function createVoiceBuilder() {
  const segments: any[] = [];

  const builder = {
    say(text: string) {
      segments.push({
        kind: 'text' as const,
        text
      });
    },

    pause(seconds: number) {
      segments.push({
        kind: 'pause' as const,
        seconds
      });
    },

    _getSegments() {
      return segments;
    }
  };

  return builder;
}
