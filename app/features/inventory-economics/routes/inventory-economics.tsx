import { useEffect, useState } from "react";
import {
  Alert, Box, Button, CircularProgress, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography,
} from "@mui/material";
import type { InventoryEconomicsWorkspace, PurchaseCostSummary } from "../types/inventoryEconomics";

type ApiResponse = { workspace?: InventoryEconomicsWorkspace; error?: string };
const errorMessage = (value: unknown) => value instanceof Error ? value.message : String(value);
const money = (cents: number | undefined, currency = "USD") => cents === undefined
  ? "Unknown" : new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
const purchaseDetails = (record:PurchaseCostSummary) => [
  record.source.replaceAll("_"," "),record.provenance,record.allocationRule.replaceAll("_"," "),
  `batches ${record.batchNumbers.join(", ")}`,record.purchasedAt ?? "purchase date unknown",
].join("; ");

export default function InventoryEconomicsRoute() {
  const [workspace, setWorkspace] = useState<InventoryEconomicsWorkspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const response = await fetch("/api/inventory-economics");
      const payload = await response.json() as ApiResponse;
      if (!response.ok || !payload.workspace) throw new Error(payload.error ?? "Failed to load inventory economics.");
      setWorkspace(payload.workspace);
    } catch (value) { setError(errorMessage(value)); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);

  if (loading) return <InventoryEconomicsStatus loading />;
  if (!workspace) return <InventoryEconomicsStatus error={error ?? "Inventory economics are unavailable."} onRetry={() => void load()} />;

  return <Box sx={{ maxWidth:1400,mx:"auto",p:3 }}>
    <Typography variant="h4" component="h1" gutterBottom>Inventory Economics</Typography>
    <Typography color="text.secondary" sx={{ mb:3 }}>Estimated acquisition cost, reusable sale proceeds, and realized profit for {workspace.sellerKey}.</Typography>
    <PurchaseCostRecords records={workspace.purchaseCosts.filter(record=>record.isCurrent)} />
    <InventoryEconomicsOrderTable workspace={workspace} />
  </Box>;
}

export function InventoryEconomicsStatus({ loading,error,onRetry }:{ loading?:boolean;error?:string;onRetry?:()=>void }) {
  return loading ? <Box sx={{ p:4,textAlign:"center" }}><CircularProgress aria-label="Loading inventory economics" /></Box>
    : <Box sx={{ p:3 }}><Alert severity="error" action={onRetry ? <Button onClick={onRetry}>Retry</Button> : undefined}>{error}</Alert></Box>;
}

export function PurchaseCostRecords({ records }:{ records:PurchaseCostSummary[] }) {
  return <Paper sx={{ p:2,mb:3 }}><Typography variant="h6">Purchase costs</Typography>{records.length === 0
    ? <Typography color="text.secondary" sx={{ mt:1 }}>No purchase cost records.</Typography>
    : <Stack spacing={1} sx={{ mt:1 }}>{records.map(record=><Box key={record.id} sx={{ borderBottom:1,borderColor:"divider",pb:1 }}>
      <Typography variant="body2">{record.purchaseReference}: {money(record.totalAmountCents,record.currency)}</Typography>
      <Typography variant="caption" color="text.secondary">{purchaseDetails(record)}</Typography>
    </Box>)}</Stack>}</Paper>;
}

export function InventoryEconomicsOrderTable({ workspace }:{ workspace:InventoryEconomicsWorkspace }) {
  return <Paper sx={{ overflowX:"auto" }}><Table size="small"><TableHead><TableRow><TableCell>Order</TableCell><TableCell>Gross</TableCell><TableCell>Provider net</TableCell><TableCell>Postage</TableCell><TableCell>Cost</TableCell><TableCell>Reusable cash</TableCell><TableCell>Realized profit</TableCell><TableCell>Coverage</TableCell></TableRow></TableHead>
    <TableBody>{workspace.orders.length === 0 ? <TableRow><TableCell colSpan={8}>No captured seller orders yet.</TableCell></TableRow> : workspace.orders.map(order=><TableRow key={order.orderNumber}><TableCell>{order.orderNumber}</TableCell><TableCell>{money(order.grossOrderCents,order.currency)}</TableCell><TableCell>{money(order.providerNetCents,order.currency)}</TableCell><TableCell>{money(order.postageCents,order.currency)}</TableCell><TableCell>{money(order.acquisitionCostCents,order.currency)}</TableCell><TableCell>{money(order.reusableCashCents,order.currency)}</TableCell><TableCell>{money(order.realizedProfitCents,order.currency)}</TableCell><TableCell>{`${order.proceedsCoverage} proceeds; ${order.expenseCoverage} expenses; ${order.costCoverage} cost. Quantities: ${order.orderedQuantity} ordered, ${order.settledQuantity} settled, ${order.costKnownQuantity} cost known.${order.missing.length ? ` Missing: ${order.missing.join(", ")}.` : ""}`}</TableCell></TableRow>)}</TableBody></Table></Paper>;
}
