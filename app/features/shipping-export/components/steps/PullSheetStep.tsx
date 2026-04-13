import OpenInNewIcon from "@mui/icons-material/OpenInNew";
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
  EasyPostShipment,
  ShipmentToOrderMap,
  TcgPlayerShippingOrder,
} from "../../types/shippingExport";

interface PullSheetStepProps {
  sourceOrders: TcgPlayerShippingOrder[];
  orders: TcgPlayerShippingOrder[];
  shipments: EasyPostShipment[];
  shipmentToOrderMap: ShipmentToOrderMap;
  isGeneratingPullSheet: boolean;
  onOpenPullSheet: () => void;
  onBack: () => void;
  onContinue: () => void;
}

interface AggregateLineItem {
  name: string;
  quantity: number;
}

function buildAggregatePullSheet(orders: TcgPlayerShippingOrder[]): AggregateLineItem[] {
  const totals = new Map<string, number>();

  for (const order of orders) {
    if (!order.products) continue;
    for (const product of order.products) {
      totals.set(product.name, (totals.get(product.name) ?? 0) + product.quantity);
    }
  }

  return [...totals.entries()]
    .map(([name, quantity]) => ({ name, quantity }))
    .sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name));
}

export function PullSheetStep({
  sourceOrders,
  orders,
  shipments,
  isGeneratingPullSheet,
  onOpenPullSheet,
  onBack,
  onContinue,
}: PullSheetStepProps) {
  const aggregatePullSheet = buildAggregatePullSheet(sourceOrders);
  const hasProductData = sourceOrders.some((o) => o.products && o.products.length > 0);

  const letterCount = shipments.filter((s) => s.parcel.predefined_package === "Letter").length;
  const flatCount = shipments.filter((s) => s.parcel.predefined_package === "Flat").length;
  const parcelCount = shipments.filter((s) => s.parcel.predefined_package === "Parcel").length;
  const totalItems = sourceOrders.reduce((sum, o) => sum + o["Item Count"], 0);

  return (
    <Stack spacing={3}>
      <Stack direction="row" spacing={1} flexWrap="wrap">
        <Chip label={`${sourceOrders.length} orders`} size="small" />
        <Chip label={`${totalItems} total items`} size="small" variant="outlined" />
        {letterCount > 0 && <Chip label={`${letterCount} Letter`} size="small" variant="outlined" />}
        {flatCount > 0 && <Chip label={`${flatCount} Flat`} size="small" variant="outlined" />}
        {parcelCount > 0 && <Chip label={`${parcelCount} Parcel`} size="small" variant="outlined" />}
      </Stack>

      <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap">
        <Button
          variant="outlined"
          startIcon={
            isGeneratingPullSheet ? (
              <CircularProgress color="inherit" size={18} />
            ) : (
              <OpenInNewIcon />
            )
          }
          onClick={onOpenPullSheet}
          disabled={sourceOrders.length === 0 || isGeneratingPullSheet}
        >
          {isGeneratingPullSheet ? "Opening Pull Sheet..." : "Open Pull Sheet (TCGPlayer)"}
        </Button>
      </Stack>

      {!hasProductData && (
        <Alert severity="info">
          Line item details are not available for CSV-loaded orders. The TCGPlayer Pull Sheet button
          above will open the authoritative formatted sheet.
        </Alert>
      )}

      {hasProductData && aggregatePullSheet.length > 0 && (
        <Box>
          <Typography variant="subtitle1" gutterBottom>
            Aggregate Pull Sheet — {aggregatePullSheet.reduce((s, i) => s + i.quantity, 0)} cards across {sourceOrders.length} orders
          </Typography>
          <TableContainer sx={{ maxHeight: 480 }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell>Card Name</TableCell>
                  <TableCell align="right">Total Qty</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {aggregatePullSheet.map((item) => (
                  <TableRow key={item.name}>
                    <TableCell>{item.name}</TableCell>
                    <TableCell align="right">{item.quantity}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Box>
      )}

      <Stack direction="row" spacing={2}>
        <Button variant="outlined" onClick={onBack}>
          Back
        </Button>
        <Button variant="contained" onClick={onContinue}>
          Continue to Buy Postage
        </Button>
      </Stack>
    </Stack>
  );
}
