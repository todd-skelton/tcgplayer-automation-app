import { Alert, Box, Button, Chip, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography } from "@mui/material";
import type { ForecastCorrection } from "~/core/types/pricingPolicy";
import type { ForecastEvaluationReport } from "~/features/pricing/domain/forecastEvaluation";
import { percentFormatter } from "./format";

export function ForecastGrading({
  report,
  activeCorrection,
  busy = false,
  onActivate,
  onRollback,
}: {
  report: ForecastEvaluationReport | null;
  activeCorrection?: ForecastCorrection | null;
  busy?: boolean;
  onActivate?: (evaluationId: string) => void;
  onRollback?: (correctionVersion: string) => void;
}) {
  if (!report) return null;
  const exclusions = Object.entries(report.coverage.exclusions).sort(([left], [right]) => left.localeCompare(right));
  return (
    <Paper variant="outlined" sx={{ mb: 3 }}>
      <Box sx={{ p: 2 }}>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <Typography variant="h6">Forecast validation</Typography>
          <Chip size="small" color={report.status === "eligible" ? "success" : "default"}
            label={report.status === "eligible" ? "Correction eligible" : "No correction activated"} />
          <Chip size="small" variant="outlined" label={`${report.policy.horizonDays}-day next sale`} />
          {activeCorrection ? (
            <Chip size="small" color="success" label={`Active ${activeCorrection.version}`} />
          ) : null}
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          One confirmed publication predicts the next verified seller/SKU sale transaction. A multi-unit
          publication or order remains one observation. Repricing closes the previous forecast; inventory
          disappearance never counts as a sale. Unsold observations require complete order history and
          continuous marketplace exposure through the horizon.
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          Frozen at {new Date(report.evaluatedAt).toLocaleString()} · training through {new Date(report.fitCutoff).toLocaleDateString()}
          {" · "}held-out validation through {new Date(report.validationCutoff).toLocaleDateString()}
          {" · "}newest {report.policy.reservedDays} days reserved.
        </Typography>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
          <Chip size="small" variant="outlined" label={`${report.coverage.includedSpells.toLocaleString()} included spells`} />
          <Chip size="small" variant="outlined" label={`${report.coverage.includedQuantity.toLocaleString()} represented units`} />
          <Chip size="small" variant="outlined" label={`${percentFormatter.format(report.coverage.coverage)} overall coverage`} />
          <Chip size="small" variant="outlined" label={`${report.coverage.excludedSpells.toLocaleString()} excluded spells`} />
        </Stack>
        {report.status === "abstained" ? (
          <Alert severity="info" sx={{ mt: 1.5 }}>
            The active forecast remains unchanged: {report.statusReasons.join(", ").replaceAll("_", " ")}.
          </Alert>
        ) : null}
        <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
          {activeCorrection ? (
            <Button size="small" variant="outlined" disabled={busy || !onRollback}
              onClick={() => onRollback?.(activeCorrection.version)}>
              Roll back correction
            </Button>
          ) : (
            <Button size="small" variant="outlined"
              disabled={busy || report.status !== "eligible" || !report.evaluationId || !onActivate}
              onClick={() => report.evaluationId && onActivate?.(report.evaluationId)}>
              Activate eligible correction
            </Button>
          )}
        </Stack>
      </Box>
      <TableContainer>
        <Table size="small" aria-label="Frozen forecast model validation">
          <TableHead><TableRow>
            <TableCell>Forecast and version</TableCell><TableCell align="right">Training</TableCell>
            <TableCell align="right">Validation</TableCell><TableCell align="right">Held-out Brier</TableCell>
            <TableCell align="right">Held-out sold / expected</TableCell><TableCell align="right">Reserved</TableCell>
          </TableRow></TableHead>
          <TableBody>
            {report.models.length === 0 ? (
              <TableRow><TableCell colSpan={6}>No mature compatible forecast outcomes are available yet.</TableCell></TableRow>
            ) : report.models.map((model) => (
              <TableRow key={`${model.family}:${model.version}`}>
                <TableCell>{model.family} · {model.version}</TableCell>
                <TableCell align="right">{model.training.count.toLocaleString()}</TableCell>
                <TableCell align="right">{model.validation.count.toLocaleString()}</TableCell>
                <TableCell align="right">{model.validation.count ? model.validation.brier.toFixed(4) : "—"}</TableCell>
                <TableCell align="right">{model.validation.count ? `${percentFormatter.format(model.validation.soldShare)} / ${percentFormatter.format(model.validation.expectedShare)}` : "—"}</TableCell>
                <TableCell align="right">{model.reservedCount.toLocaleString()}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      <Box sx={{ p: 2 }}>
        <Typography variant="subtitle2">Paired model comparisons</Typography>
        {report.pairedComparisons.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No compatible held-out model pairs are available.
          </Typography>
        ) : (
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
            {report.pairedComparisons.map((comparison) => {
              const supported = comparison.validationCount >= report.policy.minimumPairedValidationCount &&
                comparison.leftBrier !== null && comparison.rightBrier !== null;
              return <Chip key={`${comparison.left}:${comparison.right}`} size="small"
                color={supported ? "success" : "default"} variant="outlined"
                label={supported
                  ? `${comparison.left} Brier ${comparison.leftBrier!.toFixed(4)} · ${comparison.right} Brier ${comparison.rightBrier!.toFixed(4)} · ${comparison.validationCount} paired`
                  : `${comparison.left} vs ${comparison.right}: ${comparison.validationCount} paired · need ${report.policy.minimumPairedValidationCount}`} />;
            })}
          </Stack>
        )}
        <Typography variant="subtitle2" sx={{ mt: 2 }}>Coverage and censoring</Typography>
        {exclusions.length === 0 ? <Typography variant="body2" color="text.secondary">No spells were excluded.</Typography> : (
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
            {exclusions.map(([reason, value]) => <Chip key={reason} size="small" variant="outlined"
              label={`${reason.replaceAll("_", " ")}: ${value.spells} spells / ${value.quantity} units`} />)}
          </Stack>
        )}
        {report.correction ? <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          Candidate {report.correction.version}: held-out Brier improvement {report.correction.validationBrierImprovement.toFixed(4)};
          {" "}held-out coverage {percentFormatter.format(report.correction.validationCoverage)}. Product-line adjustments qualify
          independently; {report.correction.productLines.filter((line) => line.eligible).length} of {report.correction.productLines.length}
          {" "}lines meet the same predeclared sample, coverage, and improvement gates.
        </Typography> : null}
      </Box>
    </Paper>
  );
}
