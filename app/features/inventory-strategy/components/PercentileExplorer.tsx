import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Typography,
} from "@mui/material";
import { useEffect, useMemo, useState } from "react";
import type { InventoryStrategyDashboard } from "../types/inventoryStrategy";
import { PercentileMatrix } from "./PercentileMatrix";
import { ScenarioBuilder } from "./ScenarioBuilder";
import {
  defaultSelection,
  findScenario,
  formatKneeEstimate,
} from "./scenarioSelection";

/**
 * The percentile policy's scenario builder and matrix, collapsed by default
 * with each product line's knee estimate as the summary.
 */
export function PercentileExplorer({
  dashboard,
}: {
  dashboard: InventoryStrategyDashboard;
}) {
  const [expanded, setExpanded] = useState(false);
  const [selections, setSelections] = useState<Record<string, number>>({});

  useEffect(() => {
    setSelections(
      Object.fromEntries(
        dashboard.productLines.map((productLine) => [
          productLine.key,
          defaultSelection(productLine),
        ]),
      ),
    );
  }, [dashboard.generatedAt, dashboard.productLines]);

  const selectedProductLines = useMemo(
    () =>
      dashboard.productLines.map((productLine) => {
        const percentile =
          selections[productLine.key] ?? defaultSelection(productLine);
        return {
          productLine,
          percentile,
          scenario: findScenario(productLine, percentile),
        };
      }),
    [dashboard.productLines, selections],
  );
  const kneeSummary = dashboard.productLines
    .map(
      (productLine) =>
        `${productLine.productLine} ${formatKneeEstimate(productLine).replace("Estimated ", "")}`,
    )
    .join(" · ");

  return (
    <Accordion
      variant="outlined"
      expanded={expanded}
      onChange={(_, isExpanded) => setExpanded(isExpanded)}
      slotProps={{ transition: { unmountOnExit: true } }}
      disableGutters
    >
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Box>
          <Typography variant="h6">Percentile explorer</Typography>
          <Typography variant="body2" color="text.secondary">
            {kneeSummary
              ? `Knee estimates: ${kneeSummary}`
              : "Scenarios and the full matrix for the percentile policy"}
          </Typography>
        </Box>
      </AccordionSummary>
      <AccordionDetails sx={{ p: 2, pt: 0 }}>
        <ScenarioBuilder
          selections={selectedProductLines}
          onSelect={(key, percentile) =>
            setSelections((current) => ({ ...current, [key]: percentile }))
          }
        />
        <PercentileMatrix
          productLines={[dashboard.overall, ...dashboard.productLines]}
        />
      </AccordionDetails>
    </Accordion>
  );
}
