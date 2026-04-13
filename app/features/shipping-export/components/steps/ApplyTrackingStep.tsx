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
  trackingApplyResults: ShippingTrackingApplyResult[];
  isApplyingTracking: boolean;
  onApplyTracking: () => void;
  onBack: () => void;
  onContinue: () => void;
}

export function ApplyTrackingStep({
  trackingApplyItems,
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
          {trackingApplyItems.length === 0
            ? "No orders have production postage ready for tracking. Buy postage in production mode first."
            : `${trackingApplyItems.length} order${trackingApplyItems.length === 1 ? "" : "s"} ready to mark as shipped in TCGPlayer.`}
        </Typography>

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
        <Button
          variant="contained"
          onClick={onContinue}
          disabled={!hasResults && trackingApplyItems.length > 0}
        >
          Continue to Notify
        </Button>
        {!hasResults && trackingApplyItems.length > 0 && (
          <Button variant="text" onClick={onContinue} size="small" color="inherit">
            Skip (proceed anyway)
          </Button>
        )}
        {trackingApplyItems.length === 0 && (
          <Button variant="contained" onClick={onContinue}>
            Continue to Notify
          </Button>
        )}
      </Stack>
    </Stack>
  );
}
