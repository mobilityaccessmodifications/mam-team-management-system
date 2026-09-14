import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const component = readFileSync("src/components/organisation-tree.tsx", "utf8");
const styles = readFileSync("src/components/organisation-tree.module.css", "utf8");

test("editable organisation connectors use a wide invisible pointer target", () => {
  assert.match(
    component,
    /className=\{styles\.connectorTarget\}[\s\S]*?d=\{connectorPath\}[\s\S]*?role="button"[\s\S]*?tabIndex=\{0\}/,
  );
  assert.match(
    component,
    /aria-hidden=\{canUseRelationshipEditor \? "true" : undefined\}[\s\S]*?className=\{styles\.connector\}[\s\S]*?d=\{connectorPath\}/,
  );
  assert.match(
    styles,
    /\.connectorTarget\s*\{[\s\S]*?stroke: transparent;[\s\S]*?stroke-width: 24;[\s\S]*?vector-effect: non-scaling-stroke;[\s\S]*?pointer-events: stroke;/,
  );
  assert.match(
    styles,
    /\.connectorTarget:hover \+ \.connector,[\s\S]*?\.connectorTarget:focus \+ \.connector\s*\{[\s\S]*?stroke-width: 4;/,
  );
});
