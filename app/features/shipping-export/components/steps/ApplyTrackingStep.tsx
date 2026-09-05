import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import type {
  ShippingTrackingApplyRequestItem,
  ShippingTrackingApplyResult,
} from "../../types/shippingExport";

interface ApplyTrackingStepProps {
  trackingApplyItems: ShippingTrackingApplyRequestItem[];
  /** How many orders already carry the purchased tracking number and will be skipped. */
  alreadyTrackedCount: number;
  trackingApplyResults: ShippingTrackingApplyResult[];
  isApplyingTracking: boolean;
  onApplyTracking: () => void;
  onBack: () => void;
  onContinue: () => void;
}

function describeReadiness(readyCount: number, alreadyTrackedCount: number): string {
  if (readyCount > 0) {
    return `${readyCount} order${readyCount === 1 ? "" : "s"} ready to mark as shipped in TCGPlayer.`;
  }

  if (alreadyTrackedCount > 0) {
    return "Tracking is already applied to every order with production postage.";
  }

  return "No orders have production postage ready for tracking. Buy postage in production mode first.";
}

export function ApplyTrackingStep({
  trackingApplyItems,
  alreadyTrackedCount,
  trackingApplyResults,
  isApplyingTracking,
  onApplyTracking,
  onBack,
  onContinue,
}: ApplyTrackingStepProps) {
  const appliedCount = trackingApplyResults.filter((r) => r.status === "applied").length;
  const failedResults = trackingApplyResults.filter((r) => r.status === "failed");
  const hasResults = trackingApplyResults.length > 0;

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="body1" gutterBottom>
          {describeReadiness(trackingApplyItems.length, alreadyTrackedCount)}
        </Typography>

        {alreadyTrackedCount > 0 && trackingApplyItems.length > 0 && (
          <Typography variant="body2" color="text.secondary">
            {alreadyTrackedCount} order{alreadyTrackedCount === 1 ? "" : "s"} already tracked in
            TCGPlayer will be skipped.
          </Typography>
        )}

        {trackingApplyItems.length > 0 && (
          <Stack direction="row" spacing={1} sx={{ mt: 1 }} flexWrap="wrap">
            {trackingApplyItems.map((item) => (
              <Chip key={item.orderNumber} label={item.orderNumber} size="small" variant="outlined" />
            ))}
          </Stack>
        )}
      </Box>

      <Box>
        <Button
          variant="contained"
          onClick={onApplyTracking}
          disabled={trackingApplyItems.length === 0 || isApplyingTracking}
          startIcon={isApplyingTracking ? <CircularProgress color="inherit" size={18} /> : undefined}
        >
          {isApplyingTracking ? "Applying Tracking..." : "Apply Tracking to TCGPlayer"}
        </Button>
      </Box>

      {hasResults && (
        <>
          <Alert severity={failedResults.length > 0 ? "warning" : "success"}>
            <Stack spacing={0.5}>
              <Typography variant="body2" fontWeight={600}>
                Applied tracking to {appliedCount} order{appliedCount === 1 ? "" : "s"}.
              </Typography>
              {failedResults.length > 0 && (
                <Typography variant="body2">
                  {failedResults.length} order{failedResults.length === 1 ? "" : "s"} could not be updated.
                </Typography>
              )}
            </Stack>
          </Alert>

          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Order</TableCell>
                  <TableCell>Tracking</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Error</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {trackingApplyResults.map((result) => (
                  <TableRow key={result.orderNumber}>
                    <TableCell>{result.orderNumber}</TableCell>
                    <TableCell>{result.trackingNumber}</TableCell>
                    <TableCell>
                      <Chip
                        label={result.status}
                        size="small"
                        color={result.status === "applied" ? "success" : "error"}
                      />
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" color="error">
                        {result.error ?? ""}
                      </Typography>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </>
      )}

      <Stack direction="row" spacing={2}>
        <Button variant="outlined" onClick={onBack}>
          Back
        </Button>
        <Button variant="contained" onClick={onContinue} disabled={trackingApplyItems.length > 0}>
          Continue to Notify
        </Button>
        {trackingApplyItems.length > 0 && (
          <Button variant="text" onClick={onContinue} size="small" color="inherit">
            Skip (proceed anyway)
          </Button>
        )}
      </Stack>
    </Stack>
  );
}
