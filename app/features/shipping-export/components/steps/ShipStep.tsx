import {
  Alert,
  Button,
  Chip,
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
  ShippingShippedMessageResult,
  ShippingTrackingApplyResult,
} from "../../types/shippingExport";

interface ShipStepProps {
  /** Orders that still need tracking applied or a shipped message sent. */
  pendingOrderNumbers: string[];
  /** Orders with production postage whose tracking is applied and buyer messaged. */
  shippedOrderCount: number;
  trackingApplyResults: ShippingTrackingApplyResult[];
  shippedMessageResults: ShippingShippedMessageResult[];
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function describeReadiness(pendingCount: number, shippedOrderCount: number): string {
  if (pendingCount > 0) {
    return `${plural(pendingCount, "order")} ready to mark as shipped in TCGPlayer and notify the buyer.`;
  }
  if (shippedOrderCount > 0) {
    return "Every order with production postage is marked shipped and its buyer notified.";
  }
  return "No orders have production postage. Buy postage in production mode first.";
}

interface OrderOutcome {
  orderNumber: string;
  tracking?: ShippingTrackingApplyResult;
  message?: ShippingShippedMessageResult;
}

function outcomesByOrder(
  trackingResults: ShippingTrackingApplyResult[],
  messageResults: ShippingShippedMessageResult[],
): OrderOutcome[] {
  const outcomes = new Map<string, OrderOutcome>();
  for (const tracking of trackingResults) {
    outcomes.set(tracking.orderNumber, { orderNumber: tracking.orderNumber, tracking });
  }
  for (const message of messageResults) {
    const outcome = outcomes.get(message.orderNumber) ?? { orderNumber: message.orderNumber };
    outcomes.set(message.orderNumber, { ...outcome, message });
  }
  return [...outcomes.values()];
}

function StatusChip({ label, succeeded }: { label: string | undefined; succeeded: boolean }) {
  return label ? <Chip label={label} size="small" color={succeeded ? "success" : "error"} /> : <>-</>;
}

/** Marks orders shipped in TCGPlayer with their tracking, then sends each buyer a shipped message. */
export function ShipStep({
  pendingOrderNumbers,
  shippedOrderCount,
  trackingApplyResults,
  shippedMessageResults,
}: ShipStepProps) {
  const outcomes = outcomesByOrder(trackingApplyResults, shippedMessageResults);
  const failedCount = outcomes.filter(
    (outcome) => outcome.tracking?.status === "failed" || outcome.message?.status === "failed",
  ).length;

  return (
    <Stack spacing={2}>
      <Typography variant="body1">
        {describeReadiness(pendingOrderNumbers.length, shippedOrderCount)}
      </Typography>

      {pendingOrderNumbers.length > 0 && (
        <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
          {pendingOrderNumbers.map((orderNumber) => (
            <Chip key={orderNumber} label={orderNumber} size="small" variant="outlined" />
          ))}
        </Stack>
      )}

      {failedCount > 0 && (
        <Alert severity="warning">
          {plural(failedCount, "order")} could not be completed. Shipping again retries only those orders; an order
          whose tracking failed is not messaged.
        </Alert>
      )}

      {pendingOrderNumbers.length === 0 && shippedOrderCount > 0 && failedCount === 0 && (
        <Alert severity="success">Batch complete. Every order is shipped and its buyer notified.</Alert>
      )}

      {outcomes.length > 0 && (
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Order</TableCell>
                <TableCell>Tracking</TableCell>
                <TableCell>Tracking number</TableCell>
                <TableCell>Shipped message</TableCell>
                <TableCell>Error</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {outcomes.map(({ orderNumber, tracking, message }) => (
                <TableRow key={orderNumber}>
                  <TableCell>{orderNumber}</TableCell>
                  <TableCell>
                    <StatusChip label={tracking?.status} succeeded={tracking?.status === "applied"} />
                  </TableCell>
                  <TableCell>{tracking?.trackingNumber ?? "-"}</TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <StatusChip label={message?.status} succeeded={message?.status === "sent"} />
                      {message?.trackingUrl && (
                        <Button component="a" href={message.trackingUrl} target="_blank" rel="noreferrer" size="small">
                          Track
                        </Button>
                      )}
                    </Stack>
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" color="error">
                      {[tracking?.error, message?.error].filter(Boolean).join(" ")}
                    </Typography>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Stack>
  );
}
