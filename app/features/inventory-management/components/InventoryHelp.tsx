import { useState } from "react";
import { Box, IconButton, Popover, Typography } from "@mui/material";
import HelpOutlineIcon from "@mui/icons-material/HelpOutline";

const SHORTCUTS: Array<[keys: string, action: string]> = [
  ["Ctrl+Up / Ctrl+Down (Cmd on Mac)", "Previous or next entry condition"],
  ["Page Up / Page Down", "Previous or next set"],
  ["Enter in search", "Run the search"],
  ["Up / Down in a quantity", "Move to the previous or next row"],
  ["+ / - in a quantity", "Add or remove one"],
  ["Enter in a quantity", "Save it and return to search; adds one if nothing was typed"],
];

/** Keyboard shortcuts and how queuing works, shown on request. */
export function InventoryHelp() {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <IconButton aria-label="Shortcuts and queuing help" aria-haspopup="dialog" onClick={(event) => setAnchor(event.currentTarget)}>
        <HelpOutlineIcon />
      </IconButton>
      <Popover
        open={Boolean(anchor)}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{ paper: { sx: { p: 2, maxWidth: 480 } } }}
      >
        <Typography variant="subtitle2" gutterBottom>
          Keyboard shortcuts
        </Typography>
        <Box component="dl" sx={{ display: "grid", gridTemplateColumns: "auto 1fr", columnGap: 2, rowGap: 0.5, m: 0, mb: 2 }}>
          {SHORTCUTS.map(([keys, action]) => (
            <Box key={keys} sx={{ display: "contents" }}>
              <Typography component="dt" variant="body2" sx={{ fontWeight: 500 }}>
                {keys}
              </Typography>
              <Typography component="dd" variant="body2" sx={{ m: 0 }}>
                {action}
              </Typography>
            </Box>
          ))}
        </Box>
        <Typography variant="subtitle2" gutterBottom>
          Queuing
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Queuing hands off the displayed quantities as one batch. If the shared queue changes, you must review it
          again. New additions go into the next batch, so you can keep entering while batches run in the background.
        </Typography>
      </Popover>
    </>
  );
}
