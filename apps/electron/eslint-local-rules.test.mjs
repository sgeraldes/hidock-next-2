import { createRequire } from "module";
import { describe, it } from "vitest";
import { RuleTester } from "eslint";
import localRules from "./eslint-local-rules.mjs";

const require = createRequire(import.meta.url);
const { parser: tsParser } = require("@electron-toolkit/eslint-config-ts");

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

const rule = localRules.rules["require-render-return"];

ruleTester.run("require-render-return", rule, {
  valid: [
    // Returns on every path.
    `class A extends Component { render() { if (this.props.x) { return <div /> } else { return <span /> } } }`,
    `class A extends React.Component {
      render() {
        switch (this.props.kind) {
          case 'a': return <div />
          default: return <span />
        }
      }
    }`,
    // Returning null is a real return value.
    `class A extends PureComponent { render() { return null } }`,
    `class A extends React.PureComponent { render() { if (this.props.x) return null; return <div /> } }`,
    // A throw ends the path too.
    `class A extends Component { render() { if (!this.props.x) throw new Error('x'); return <div /> } }`,
    // Arrow-property render with an expression body always returns.
    `class A extends Component { render = () => <div /> }`,
    `class A extends Component { render = () => { return <div /> } }`,
    // A nested function's missing return is not render's problem.
    `class A extends Component { render() { const f = () => { this.x = 1 }; f(); return <div /> } }`,
    // Not a React component: out of scope.
    `class A extends Base { render() { this.draw() } }`,
    `class A { render() {} }`,
    // Static render is not the component's render.
    `class A extends Component { static render() {} render() { return null } }`,
    // TypeScript parser, as the app lints .tsx.
    {
      code: `class A extends Component<Props, State> { render(): React.ReactNode { if (this.props.x) { return <div /> } return null } }`,
      languageOptions: { parser: tsParser },
    },
  ],
  invalid: [
    {
      code: `class A extends Component { render() { this.x = 1 } }`,
      errors: [{ messageId: "missingReturn" }],
    },
    {
      code: `class A extends React.Component { render() { if (this.props.x) { return <div /> } } }`,
      errors: [{ messageId: "missingReturn" }],
    },
    {
      code: `class A extends PureComponent { render() { if (this.props.x) return <div />; return; } }`,
      errors: [{ messageId: "bareReturn" }],
    },
    {
      code: `class A extends React.PureComponent {
        render() {
          switch (this.props.kind) {
            case 'a': return <div />
          }
        }
      }`,
      errors: [{ messageId: "missingReturn" }],
    },
    {
      code: `class A extends Component { render = () => { this.x = 1 } }`,
      errors: [{ messageId: "missingReturn" }],
    },
    {
      code: `class A extends Component<Props> { render() { if (this.props.x) { return <div /> } } }`,
      languageOptions: { parser: tsParser },
      errors: [{ messageId: "missingReturn" }],
    },
  ],
});
