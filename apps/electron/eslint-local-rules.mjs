// Three checks from eslint-plugin-react's recommended set that
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

export default {
  meta: { name: "hidock-local" },
  rules: {
    "no-unescaped-entities": noUnescapedEntities,
    "no-string-refs": noStringRefs,
    "no-deprecated-react-dom": noDeprecatedReactDom,
  },
};
