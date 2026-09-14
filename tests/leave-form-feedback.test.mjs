import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const source = readFileSync("src/components/leave-demo.tsx", "utf8");
const ast = ts.createSourceFile("leave-demo.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

test("editing a leave request clears stale custom validation feedback", () => {
  let requestForm;

  function visit(node) {
    if (ts.isJsxOpeningElement(node) && node.tagName.getText(ast) === "form") {
      const className = node.attributes.properties.find((attribute) => (
        ts.isJsxAttribute(attribute) && attribute.name.getText(ast) === "className"
      ));
      if (className?.initializer?.getText(ast).includes("styles.form")) requestForm = node;
    }
    ts.forEachChild(node, visit);
  }

  visit(ast);
  assert.ok(requestForm, "leave request form should render");
  const onChange = requestForm.attributes.properties.find((attribute) => (
    ts.isJsxAttribute(attribute) && attribute.name.getText(ast) === "onChange"
  ));
  assert.ok(onChange?.initializer, "leave request form should react to field changes");
  assert.match(onChange.initializer.getText(ast), /setFormError\(\s*["']{2}\s*\)/);
});
