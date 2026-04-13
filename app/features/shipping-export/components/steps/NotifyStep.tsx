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
  ShippingShippedMessageRequestItem,
  ShippingShippedMessageResult,
} from "../../types/shippingExport";

interface NotifyStepProps {
  shippedMessageItems: ShippingShippedMessageRequestItem[];
  shippedMessageResults: ShippingShippedMessageResult[];
  isSendingShippedMessages: boolean;
  onSendShippedMessages: () => void;
  onBack: () => void;
  onReset: () => void;
}

export function NotifyStep({
  shippedMessageItems,
  shippedMessageResults,
  isSendingShippedMessages,
  onSendShippedMessages,
  onBack,
  onReset,
}: NotifyStepProps) {
  const sentCount = shippedMessageResults.filter((r) => r.status === "sent").length;
  const failedResults = shippedMessageResults.filter((r) => r.status === "failed");
  const hasResults = shippedMessageResults.length > 0;

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="body1" gutterBottom>
          {shippedMessageItems.length === 0
            ? "No orders are ready for shipped notifications. Tracking must be applied in production mode first."
            : `${shippedMessageItems.length} order${shippedMessageItems.length === 1 ? "" : "s"} ready to receive shipped messages.`}
        </Typography>

        {shippedMessageItems.length > 0 && (
          <Stack direction="row" spacing={1} sx={{ mt: 1 }} flexWrap="wrap">
            {shippedMessageItems.map((item) => (
              <Chip key={item.orderNumber} label={item.orderNumber} size="small" variant="outlined" />
            ))}
          </Stack>
        )}
      </Box>

      <Box>
        <Button
          variant="contained"
          onClick={onSendShippedMessages}
          disabled={shippedMessageItems.length === 0 || isSendingShippedMessages}
          startIcon={isSendingShippedMessages ? <CircularProgress color="inherit" size={18} /> : undefined}
        >
          {isSendingShippedMessages ? "Sending Shipped Messages..." : "Send Shipped Messages"}
        </Button>
      </Box>

      {hasResults && (
        <>
          <Alert severity={failedResults.length > 0 ? "warning" : "success"}>
            <Stack spacing={0.5}>
              <Typography variant="body2" fontWeight={600}>
                Sent shipped messages to {sentCount} order{sentCount === 1 ? "" : "s"}.
              </Typography>
              {failedResults.length > 0 && (
                <Typography variant="body2">
                  {failedResults.length} order{failedResults.length === 1 ? "" : "s"} could not be messaged.
                </Typography>
              )}
            </Stack>
          </Alert>

          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Order</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Tracking URL</TableCell>
                  <TableCell>Error</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {shippedMessageResults.map((result) => (
                  <TableRow key={result.orderNumber}>
                    <TableCell>{result.orderNumber}</TableCell>
                    <TableCell>
                      <Chip
                        label={result.status}
                        size="small"
                        color={result.status === "sent" ? "success" : "error"}
                      />
                    </TableCell>
                    <TableCell>
                      {result.trackingUrl ? (
                        <Button
                          component="a"
                          href={result.trackingUrl}
                          target="_blank"
                          rel="noreferrer"
                          size="small"
                          variant="text"
                        >
                          Track
                        </Button>
                      ) : (
                        "—"
                      )}
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

      {hasResults && failedResults.length === 0 && (
        <Alert severity="success">
          Batch complete! All orders have been shipped and customers notified.
        </Alert>
      )}

      <Stack direction="row" spacing={2}>
        <Button variant="outlined" onClick={onBack}>
          Back
        </Button>
        <Button variant="contained" color="success" onClick={onReset}>
          Start New Batch
        </Button>
      </Stack>
    </Stack>
  );
}
