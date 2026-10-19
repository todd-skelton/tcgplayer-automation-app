import assert from "node:assert/strict";
import { packShortcutFor, type PackKeyPress, type PackKeyTarget } from "./packShortcut";

const element = (tagName: string, overrides: Partial<PackKeyTarget> = {}): PackKeyTarget => ({
  tagName,
  role: null,
  isContentEditable: false,
  ...overrides,
});

const press = (overrides: Partial<PackKeyPress>): PackKeyPress => ({
  key: " ",
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  defaultPrevented: false,
  target: null,
  ...overrides,
});

const testCases: { name: string; run: () => void }[] = [
  {
    name: "packShortcutFor maps Space and the arrows on the page",
    run: () => {
      assert.equal(packShortcutFor(press({ key: " " })), "toggle-packed");
      assert.equal(packShortcutFor(press({ key: " ", target: element("DIV") })), "toggle-packed");
      assert.equal(packShortcutFor(press({ key: "ArrowLeft", target: element("DIV") })), "previous");
      assert.equal(packShortcutFor(press({ key: "ArrowRight", target: element("BUTTON") })), "next");
    },
  },
  {
    name: "packShortcutFor keeps the arrows after the packed checkbox is clicked",
    run: () => {
      const checkbox = element("INPUT", { type: "checkbox" });
      assert.equal(packShortcutFor(press({ key: "ArrowRight", target: checkbox })), "next");
      assert.equal(packShortcutFor(press({ key: " ", target: checkbox })), null, "Space toggles the checkbox itself");
    },
  },
  {
    name: "packShortcutFor leaves Space to a focused control",
    run: () => {
      assert.equal(packShortcutFor(press({ target: element("BUTTON") })), null);
      assert.equal(packShortcutFor(press({ target: element("LI", { role: "menuitem" }) })), null);
    },
  },
  {
    name: "packShortcutFor ignores typing, modifiers, and handled keys",
    run: () => {
      assert.equal(packShortcutFor(press({ key: "ArrowLeft", target: element("INPUT") })), null);
      assert.equal(packShortcutFor(press({ key: "ArrowLeft", target: element("INPUT", { type: "search" }) })), null);
      assert.equal(packShortcutFor(press({ target: element("DIV", { isContentEditable: true }) })), null);
      assert.equal(packShortcutFor(press({ key: "ArrowRight", ctrlKey: true })), null);
      assert.equal(packShortcutFor(press({ defaultPrevented: true })), null);
      assert.equal(packShortcutFor(press({ key: "p" })), null);
    },
  },
];

let failures = 0;
for (const testCase of testCases) {
  try {
    testCase.run();
    console.log(`PASS ${testCase.name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${testCase.name}`);
    console.error(error);
  }
}
if (failures > 0) {
  process.exitCode = 1;
}
