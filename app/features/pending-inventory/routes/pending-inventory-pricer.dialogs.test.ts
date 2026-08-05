import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("./pending-inventory-pricer.tsx", import.meta.url),
  "utf8",
);

const publishDialog = source.indexOf("open={publishDialogOpen}");
const publishDialogClose = source.indexOf("</Dialog>", publishDialog);
const deleteDialog = source.indexOf("open={deleteDialogOpen}");

assert.ok(publishDialog >= 0, "The publish dialog must be rendered.");
assert.ok(
  publishDialogClose > publishDialog,
  "The publish dialog must have its own closing boundary.",
);
assert.ok(
  deleteDialog > publishDialogClose,
  "The delete dialog must be a sibling after the publish dialog, not its parent.",
);

console.log("PASS publish and delete confirmations render as sibling dialogs");
