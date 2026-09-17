import { Paper, Stack, Typography } from "@mui/material";
import type { Lever } from "../domain/improvementLevers";

/** What to change next, with the numbers behind each suggestion. */
export function ImprovementLevers({ levers }: { levers: readonly Lever[] }) {
  return (
    <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
      <Typography variant="h6">How to improve</Typography>
      {levers.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          Nothing stands out: the configured hurdle is the best on the ladder and every product line is clearing it.
        </Typography>
      ) : (
        <Stack spacing={1.5} sx={{ mt: 1.5 }}>
          {levers.map((lever) => (
            <Stack key={lever.title} spacing={0.25}>
              <Typography variant="subtitle2">{lever.title}</Typography>
              <Typography variant="body2" color="text.secondary">{lever.detail}</Typography>
            </Stack>
          ))}
        </Stack>
      )}
    </Paper>
  );
}
