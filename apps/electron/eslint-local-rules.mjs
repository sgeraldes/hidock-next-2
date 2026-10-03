// Four checks from eslint-plugin-react's recommended set that
// @eslint-react/eslint-plugin does not ship and TypeScript does not catch.
// eslint-plugin-react was dropped because its last release only supports
// ESLint up to 9.7; these rules keep the gate as strict as it was before.

const UNESCAPED = {
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
  "}": "&#125;",
};

const noUnescapedEntities = {
  meta: {
    type: "problem",
    docs: { description: "Disallow >, \", ' and } as raw text inside JSX" },
    schema: [],
    messages: {
      unescaped: "`{{char}}` can be escaped with `{{escape}}` or written as {{expression}}.",
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;
    return {
      JSXText(node) {
        const raw = sourceCode.getText(node);
        for (let i = 0; i < raw.length; i++) {
          const char = raw[i];
          if (!(char in UNESCAPED)) continue;
          const start = sourceCode.getLocFromIndex(node.range[0] + i);
          const end = sourceCode.getLocFromIndex(node.range[0] + i + 1);
          context.report({
            node,
            loc: { start, end },
            messageId: "unescaped",
            data: { char, escape: UNESCAPED[char], expression: char === "'" ? `{"'"}` : `{'${char}'}` },
          });
        }
      },
    };
  },
};

const isStringLiteral = (node) => node?.type === "Literal" && typeof node.value === "string";

const noStringRefs = {
  meta: {
    type: "problem",
    docs: { description: "Disallow string refs and this.refs (removed in React 19)" },
    schema: [],
    messages: {
      stringRef: "String refs are deprecated. Use useRef or createRef and pass the ref object.",
      thisRefs: "this.refs belongs to string refs, which are deprecated. Use a ref object.",
    },
  },
  create(context) {
    return {
      JSXAttribute(node) {
        if (node.name.type !== "JSXIdentifier" || node.name.name !== "ref" || !node.value) return;
        const value = node.value.type === "JSXExpressionContainer" ? node.value.expression : node.value;
        if (isStringLiteral(value)) context.report({ node, messageId: "stringRef" });
      },
      MemberExpression(node) {
        if (
          node.object.type === "ThisExpression" &&
          !node.computed &&
          node.property.type === "Identifier" &&
          node.property.name === "refs"
        ) {
          context.report({ node, messageId: "thisRefs" });
        }
      },
    };
  },
};

// react-dom APIs deprecated in React 18 that @eslint-react has no rule for.
// ReactDOM.render, hydrate, findDOMNode and the componentWill* lifecycles are
// covered by @eslint-react rules of their own.
const DEPRECATED_REACT_DOM = new Set(["unmountComponentAtNode", "renderToNodeStream"]);

const noDeprecatedReactDom = {
  meta: {
    type: "problem",
    docs: { description: "Disallow react-dom APIs deprecated in React 18" },
    schema: [],
    messages: {
      deprecated: "{{name}} is deprecated in React 18 and removed in React 19.",
    },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        if (node.source.value !== "react-dom" && node.source.value !== "react-dom/server") return;
        for (const spec of node.specifiers) {
          if (spec.type !== "ImportSpecifier") continue;
          const name = spec.imported.type === "Identifier" ? spec.imported.name : spec.imported.value;
          if (DEPRECATED_REACT_DOM.has(name)) context.report({ node: spec, messageId: "deprecated", data: { name } });
        }
      },
      MemberExpression(node) {
        if (node.computed || node.property.type !== "Identifier") return;
        if (DEPRECATED_REACT_DOM.has(node.property.name)) {
          context.report({ node, messageId: "deprecated", data: { name: node.property.name } });
        }
      },
    };
  },
};

// tsc does not catch this one: ReactNode includes undefined, so a render() that
// falls off the end on some path, or ends in a bare `return;`, still compiles.
// Built on code path analysis the way the core getter-return rule is, so every
// if/else, switch and try path is followed.
const COMPONENT_BASES = new Set(["Component", "PureComponent"]);

const extendsReactComponent = (classNode) => {
  const base = classNode?.superClass;
  if (!base) return false;
  if (base.type === "Identifier") return COMPONENT_BASES.has(base.name);
  return (
    base.type === "MemberExpression" &&
    !base.computed &&
    base.object.type === "Identifier" &&
    base.object.name === "React" &&
    base.property.type === "Identifier" &&
    COMPONENT_BASES.has(base.property.name)
  );
};

// The function node is the body of a component's instance render: a `render()`
// method, or a `render = () => {}` / `render = function () {}` class field.
const isComponentRender = (node) => {
  if (node.type !== "FunctionExpression" && node.type !== "ArrowFunctionExpression") return false;
  if (node.body.type !== "BlockStatement") return false; // an expression body always returns
  const member = node.parent;
  const isMethod = member?.type === "MethodDefinition" && member.kind === "method";
  const isField = member?.type === "PropertyDefinition" && member.value === node;
  if (!isMethod && !isField) return false;
  if (member.static || member.computed) return false;
  if (member.key.type !== "Identifier" || member.key.name !== "render") return false;
  return extendsReactComponent(member.parent?.parent);
};

const requireRenderReturn = {
  meta: {
    type: "problem",
    docs: { description: "Require a class component's render to return a value on every path" },
    schema: [],
    messages: {
      missingReturn: "render() must return a value on every path (return null to render nothing).",
      bareReturn: "render() must return a value; use `return null` to render nothing.",
    },
  },
  create(context) {
    let funcInfo = null;
    const check = (node) => {
      if (!funcInfo.shouldCheck) return;
      const reachable = [...funcInfo.currentSegments].some((segment) => segment.reachable);
      if (reachable) context.report({ node: node.parent.key, messageId: "missingReturn" });
    };
    return {
      onCodePathStart(codePath, node) {
        funcInfo = { upper: funcInfo, shouldCheck: isComponentRender(node), currentSegments: new Set() };
      },
      onCodePathEnd() {
        funcInfo = funcInfo.upper;
      },
      onCodePathSegmentStart(segment) {
        funcInfo.currentSegments.add(segment);
      },
      onCodePathSegmentEnd(segment) {
        funcInfo.currentSegments.delete(segment);
      },
      onUnreachableCodePathSegmentStart(segment) {
        funcInfo.currentSegments.add(segment);
      },
      onUnreachableCodePathSegmentEnd(segment) {
        funcInfo.currentSegments.delete(segment);
      },
      ReturnStatement(node) {
        if (funcInfo.shouldCheck && !node.argument) context.report({ node, messageId: "bareReturn" });
      },
      "FunctionExpression:exit": check,
      "ArrowFunctionExpression:exit": check,
    };
  },
};

export default {
  meta: { name: "hidock-local" },
  rules: {
    "require-render-return": requireRenderReturn,
    "no-unescaped-entities": noUnescapedEntities,
    "no-string-refs": noStringRefs,
    "no-deprecated-react-dom": noDeprecatedReactDom,
  },
};
