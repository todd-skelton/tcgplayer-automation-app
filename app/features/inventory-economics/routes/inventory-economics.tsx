import { useEffect, useState } from "react";
import {
  Alert, Box, Button, Card, CardContent, CircularProgress, FormControl, InputLabel,
  MenuItem, Paper, Select, Stack, Table, TableBody, TableCell, TableHead, TableRow,
  TextField, Typography,
} from "@mui/material";
import type {
  FundingAdjustmentSummary, InventoryEconomicsWorkspace, OrderExpenseSummary, PurchaseAllocationTarget,
  PurchaseCostSummary,
} from "../types/inventoryEconomics";

type ApiResponse = { workspace?: InventoryEconomicsWorkspace; error?: string;
  purchaseAllocationTargets?: PurchaseAllocationTarget[]; purchaseAllocationTargetsComplete?: boolean };
const today = () => new Date().toISOString().slice(0, 10);
const errorMessage = (value: unknown) => value instanceof Error ? value.message : String(value);
const money = (cents: number | undefined, currency = "USD") => cents === undefined
  ? "Unknown" : new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
const priorVersion = <T extends {id:string;version:number}>(entry: {correctsEntryId?:string}, entries: T[]) =>
  entry.correctsEntryId ? entries.find(value=>value.id===entry.correctsEntryId)?.version ?? "prior" : undefined;
const purchaseDetails = (record:PurchaseCostSummary,entries:PurchaseCostSummary[]) => [
  `version ${record.version} (${record.isCurrent ? "current" : "superseded"})`,
  record.source.replaceAll("_"," "),record.provenance,record.allocationRule.replaceAll("_"," "),
  `batches ${record.batchNumbers.join(", ")}`,record.purchasedAt ?? "purchase date unknown",
  record.correctsEntryId ? `corrects version ${priorVersion(record,entries)}` : "",
  record.correctionReason ? `reason: ${record.correctionReason}` : "",
  `evidence check ${record.evidenceIdentity.slice(0,10)}`,
].filter(Boolean).join("; ");
const fundingDetails = (record:FundingAdjustmentSummary,entries:FundingAdjustmentSummary[]) => [
  `version ${record.version} (${record.isCurrent ? "current" : "superseded"})`,
  "manual entry",record.adjustmentType.replaceAll("_"," "),record.provenance,record.effectiveAt,
  record.purchaseReference ? `purchase ${record.purchaseReference}` : "",
  record.correctsEntryId ? `corrects version ${priorVersion(record,entries)}` : "",
  record.correctionReason ? `reason: ${record.correctionReason}` : "",
  `evidence check ${record.evidenceIdentity.slice(0,10)}`,
].filter(Boolean).join("; ");
const expenseDetails = (record:OrderExpenseSummary,entries:OrderExpenseSummary[]) => [
  `version ${record.version} (${record.isCurrent ? "current" : "superseded"})`,
  "manual entry",record.expenseType.replaceAll("_"," "),record.provenance,
  `orders ${record.orderNumbers.join(", ")}`,record.expenseAt,
  record.correctsEntryId ? `corrects version ${priorVersion(record,entries)}` : "",
  record.correctionReason ? `reason: ${record.correctionReason}` : "",
  `evidence check ${record.evidenceIdentity.slice(0,10)}`,
].filter(Boolean).join("; ");

export default function InventoryEconomicsRoute() {
  const [workspace, setWorkspace] = useState<InventoryEconomicsWorkspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [purchase, setPurchase] = useState({ purchaseReference:"",batchNumbers:"",totalAmount:"",provenance:"actual",allocationRule:"quantity",purchasedAt:"",marketObservedAt:"",correctsEntryId:"",correctionReason:"" });
  const [explicitAmounts, setExplicitAmounts] = useState<Record<number,string>>({});
  const [explicitTargets, setExplicitTargets] = useState<PurchaseAllocationTarget[] | null>(null);
  const [explicitTargetsComplete, setExplicitTargetsComplete] = useState(true);
  const [funding, setFunding] = useState({ adjustmentReference:"",adjustmentType:"external_contribution",amount:"",provenance:"actual",effectiveAt:today(),purchaseReference:"",correctsEntryId:"",correctionReason:"" });
  const [expense, setExpense] = useState({ expenseReference:"",expenseType:"fulfillment",amount:"",provenance:"actual",orderNumbers:"",expenseAt:today(),basis:"additional_expense",correctsEntryId:"",correctionReason:"" });
  const [csvText, setCsvText] = useState("");

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

  const submit = async (body: Record<string, unknown>, message: string) => {
    setSaving(true); setError(null); setSuccess(null);
    try {
      const response = await fetch("/api/inventory-economics", { method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({ ...body,requestId:crypto.randomUUID(),currency:"USD" }) });
      const payload = await response.json() as ApiResponse;
      if (!response.ok || !payload.workspace) throw new Error(payload.error ?? "Inventory economics could not be saved.");
      setWorkspace(payload.workspace); setSuccess(message);
      if (body.action === "record_purchase_cost") {
        setPurchase((value) => ({...value,correctsEntryId:"",correctionReason:""}));
        setExplicitAmounts({});
        setExplicitTargets(null);
      }
      if (body.action === "record_funding") setFunding((value) => ({...value,correctsEntryId:"",correctionReason:""}));
      if (body.action === "record_expense") setExpense((value) => ({...value,correctsEntryId:"",correctionReason:""}));
    } catch (value) { setError(errorMessage(value)); }
    finally { setSaving(false); }
  };
  const loadExplicitTargets = async () => {
    setSaving(true); setError(null); setSuccess(null);
    try {
      const response = await fetch("/api/inventory-economics", { method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({ action:"find_purchase_allocation_targets",requestId:crypto.randomUUID(),
          currency:"USD",batchNumbers:purchase.batchNumbers }) });
      const payload = await response.json() as ApiResponse;
      if (!response.ok || !Array.isArray(payload.purchaseAllocationTargets)) {
        throw new Error(payload.error ?? "Receipt allocations could not be loaded.");
      }
      setExplicitTargets(payload.purchaseAllocationTargets);
      setExplicitTargetsComplete(payload.purchaseAllocationTargetsComplete === true);
      setExplicitAmounts({});
    } catch (value) { setError(errorMessage(value)); }
    finally { setSaving(false); }
  };

  if (loading) return <InventoryEconomicsStatus loading />;
  if (!workspace) return <InventoryEconomicsStatus error={error ?? "Inventory economics are unavailable."} onRetry={() => void load()} />;
  const explicitReady = purchase.allocationRule !== "explicit" ||
    Boolean(explicitTargets?.length && explicitTargetsComplete &&
      explicitTargets.every(target=>explicitAmounts[target.receiptId]?.trim()));

  return <Box sx={{ maxWidth:1400,mx:"auto",p:3 }}>
    <Typography variant="h4" component="h1" gutterBottom>Inventory Economics</Typography>
    <Typography color="text.secondary" sx={{ mb:3 }}>Actual and estimated acquisition cost, reusable sale proceeds, and external funding for {workspace.sellerKey}.</Typography>
    {error && <Alert severity="error" sx={{ mb:2 }}>{error}</Alert>}
    {success && <Alert severity="success" sx={{ mb:2 }}>{success}</Alert>}

    <Stack direction={{ xs:"column",lg:"row" }} spacing={2} sx={{ mb:3 }}>
      <Card sx={{ flex:1 }}><CardContent><Typography variant="h6">Purchase cost</Typography>
        <Stack spacing={2} sx={{ mt:2 }}>
          <TextField label="Purchase reference" value={purchase.purchaseReference} onChange={e=>setPurchase({...purchase,purchaseReference:e.target.value})} />
          <TextField label="Batch numbers" helperText="Comma-separated existing inventory batches" value={purchase.batchNumbers} onChange={e=>{
            setPurchase({...purchase,batchNumbers:e.target.value}); setExplicitTargets(null); setExplicitAmounts({});
          }} />
          <TextField label="Total amount (USD)" value={purchase.totalAmount} onChange={e=>setPurchase({...purchase,totalAmount:e.target.value})} />
          <Stack direction="row" spacing={2}><Select fullWidth inputProps={{"aria-label":"Purchase cost provenance"}} value={purchase.provenance} onChange={e=>setPurchase({...purchase,provenance:e.target.value})}><MenuItem value="actual">Actual</MenuItem><MenuItem value="estimated">Estimated</MenuItem></Select>
            <Select fullWidth inputProps={{"aria-label":"Purchase cost allocation rule"}} value={purchase.allocationRule} onChange={e=>{
              setPurchase({...purchase,allocationRule:e.target.value}); setExplicitTargets(null); setExplicitAmounts({});
            }}><MenuItem value="quantity">By quantity</MenuItem><MenuItem value="frozen_market">Frozen market weights</MenuItem><MenuItem value="explicit">Set each item amount</MenuItem></Select></Stack>
          <TextField label="Purchase date" type="date" slotProps={{inputLabel:{shrink:true}}} value={purchase.purchasedAt} onChange={e=>setPurchase({...purchase,purchasedAt:e.target.value})} />
          {purchase.allocationRule === "frozen_market" && <TextField label="Market evidence instant" type="datetime-local" slotProps={{inputLabel:{shrink:true}}} value={purchase.marketObservedAt.slice(0,16)} onChange={e=>setPurchase({...purchase,marketObservedAt:e.target.value ? new Date(e.target.value).toISOString() : ""})} />}
          {purchase.allocationRule === "explicit" && <Paper variant="outlined" sx={{p:1.5}}>
            <Typography variant="subtitle2">Amount for each acquired item</Typography>
            <Button size="small" sx={{mt:1}} disabled={saving || !purchase.batchNumbers.trim()}
              onClick={()=>void loadExplicitTargets()}>Load items for these batches</Button>
            {!explicitTargetsComplete && <Alert severity="warning" sx={{my:1}}>This selection is too large for manual allocation. Use quantity allocation or fewer batches.</Alert>}
            {explicitTargets === null ? <Typography variant="body2" color="text.secondary" sx={{mt:1}}>Load the selected batches, then enter one amount for each item lot.</Typography>
              : explicitTargets.length === 0 ? <Typography variant="body2" color="text.secondary" sx={{mt:1}}>No receipt lots were found for these batches.</Typography>
              : <Stack spacing={1.5} sx={{mt:1}}>{explicitTargets.map(target=><Box key={target.receiptId}>
                <Typography variant="body2">{target.itemLabel}</Typography>
                <Typography variant="caption" color="text.secondary">SKU {target.sku} · {target.originalQuantity} acquired · intake {target.intakeAt ? new Date(target.intakeAt).toLocaleDateString() : "date unknown"}</Typography>
                <TextField fullWidth size="small" sx={{mt:.5}} label="Allocated amount (USD)"
                  inputProps={{"aria-label":`Allocated amount for ${target.itemLabel}, SKU ${target.sku}`}}
                  value={explicitAmounts[target.receiptId] ?? ""}
                  onChange={event=>setExplicitAmounts({...explicitAmounts,[target.receiptId]:event.target.value})} />
              </Box>)}</Stack>}
          </Paper>}
          {purchase.correctsEntryId && <TextField label="Correction reason" required value={purchase.correctionReason} onChange={e=>setPurchase({...purchase,correctionReason:e.target.value})} />}
          {purchase.correctsEntryId && <Button onClick={()=>setPurchase({...purchase,correctsEntryId:"",correctionReason:""})}>Cancel correction</Button>}
          <Button variant="contained" disabled={saving || !explicitReady} onClick={() => void submit({action:"record_purchase_cost",...purchase,
            ...(purchase.allocationRule === "explicit" ? { explicitAllocations:(explicitTargets ?? []).map(target=>({
              receiptId:target.receiptId,amount:explicitAmounts[target.receiptId] ?? "",
            })) } : {})},"Purchase cost recorded.")}>Record purchase cost</Button>
        </Stack></CardContent></Card>

      <Card sx={{ flex:1 }}><CardContent><Typography variant="h6">Funding adjustment</Typography>
        <Stack spacing={2} sx={{ mt:2 }}>
          <TextField label="Adjustment reference" value={funding.adjustmentReference} onChange={e=>setFunding({...funding,adjustmentReference:e.target.value})} />
          <FormControl><InputLabel>Type</InputLabel><Select label="Type" value={funding.adjustmentType} onChange={e=>setFunding({...funding,adjustmentType:e.target.value})}>{["opening_cash","external_contribution","withdrawal","reserve","reserve_release","purchase_funding"].map(value=><MenuItem key={value} value={value}>{value.replaceAll("_"," ")}</MenuItem>)}</Select></FormControl>
          <TextField label="Amount (USD)" value={funding.amount} onChange={e=>setFunding({...funding,amount:e.target.value})} />
          <Select inputProps={{"aria-label":"Funding provenance"}} value={funding.provenance} onChange={e=>setFunding({...funding,provenance:e.target.value})}><MenuItem value="actual">Actual</MenuItem><MenuItem value="estimated">Estimated</MenuItem></Select>
          {funding.adjustmentType === "purchase_funding" && <TextField label="Purchase reference" value={funding.purchaseReference} onChange={e=>setFunding({...funding,purchaseReference:e.target.value})} />}
          <TextField label="Effective date" type="date" slotProps={{inputLabel:{shrink:true}}} value={funding.effectiveAt} onChange={e=>setFunding({...funding,effectiveAt:e.target.value})} />
          {funding.correctsEntryId && <TextField label="Correction reason" required value={funding.correctionReason} onChange={e=>setFunding({...funding,correctionReason:e.target.value})} />}
          {funding.correctsEntryId && <Button onClick={()=>setFunding({...funding,correctsEntryId:"",correctionReason:""})}>Cancel correction</Button>}
          <Button variant="contained" disabled={saving} onClick={() => void submit({action:"record_funding",...funding},"Funding adjustment recorded.")}>Record funding</Button>
        </Stack></CardContent></Card>

      <Card sx={{ flex:1 }}><CardContent><Typography variant="h6">Order expense or refund settlement</Typography>
        <Stack spacing={2} sx={{ mt:2 }}>
          <TextField label="Expense reference" value={expense.expenseReference} onChange={e=>setExpense({...expense,expenseReference:e.target.value})} />
          <FormControl><InputLabel>Type</InputLabel><Select label="Type" value={expense.expenseType} onChange={e=>setExpense({...expense,expenseType:e.target.value,basis:e.target.value === "refund_settlement" ? "original_net_refund_adjustment" : "additional_expense"})}><MenuItem value="fulfillment">Fulfillment</MenuItem><MenuItem value="refund_settlement">Refund settlement</MenuItem><MenuItem value="other">Other</MenuItem></Select></FormControl>
          <TextField label="Order numbers" helperText="Comma-separated; refund settlement requires one order" value={expense.orderNumbers} onChange={e=>setExpense({...expense,orderNumbers:e.target.value})} />
          <TextField label={expense.basis === "already_adjusted_net" ? "Verified final net (USD)" : "Amount (USD)"} value={expense.amount} onChange={e=>setExpense({...expense,amount:e.target.value})} />
          <Select inputProps={{"aria-label":"Expense provenance"}} value={expense.provenance} onChange={e=>setExpense({...expense,provenance:e.target.value})}><MenuItem value="actual">Actual</MenuItem><MenuItem value="estimated">Estimated</MenuItem></Select>
          {expense.expenseType === "refund_settlement" && <FormControl><InputLabel>Settlement basis</InputLabel><Select label="Settlement basis" value={expense.basis} onChange={e=>setExpense({...expense,basis:e.target.value})}><MenuItem value="original_net_refund_adjustment">Deduct from original provider net</MenuItem><MenuItem value="already_adjusted_net">Verified final net already includes refund</MenuItem></Select></FormControl>}
          <TextField label="Expense date" type="date" slotProps={{inputLabel:{shrink:true}}} value={expense.expenseAt} onChange={e=>setExpense({...expense,expenseAt:e.target.value})} />
          {expense.correctsEntryId && <TextField label="Correction reason" required value={expense.correctionReason} onChange={e=>setExpense({...expense,correctionReason:e.target.value})} />}
          {expense.correctsEntryId && <Button onClick={()=>setExpense({...expense,correctsEntryId:"",correctionReason:""})}>Cancel correction</Button>}
          <Button variant="contained" disabled={saving} onClick={() => void submit({action:"record_expense",...expense,orderNumbers:expense.orderNumbers.split(",").map(v=>v.trim()).filter(Boolean)},"Order expense recorded.")}>Record expense</Button>
        </Stack></CardContent></Card>
    </Stack>

    <Paper sx={{ p:2,mb:3 }}><Typography variant="h6">Purchase cost file import</Typography><Typography variant="body2" color="text.secondary">Up to 25 rows. Header: Purchase Reference,Batch Numbers,Total Amount,Provenance,Allocation Rule,Purchased At,Currency</Typography>
      <Stack direction={{xs:"column",md:"row"}} spacing={2} sx={{mt:2}}><TextField fullWidth multiline minRows={2} label="CSV contents" value={csvText} onChange={e=>setCsvText(e.target.value)} /><Button disabled={saving||!csvText.trim()} onClick={() => void submit({action:"import_purchase_costs",csvText},"Purchase cost file imported.")}>Import</Button></Stack></Paper>

    <Stack direction={{xs:"column",lg:"row"}} spacing={2} sx={{mb:3}}>
      <RecentRecords title="Purchase costs" empty="No purchase cost records." rows={workspace.purchaseCosts.filter(record=>record.isCurrent).map(record=>({
        key:record.id,primary:`${record.purchaseReference}: ${money(record.totalAmountCents,record.currency)}`,
        secondary:purchaseDetails(record,workspace.purchaseCosts),
        history:workspace.purchaseCosts.filter(value=>!value.isCurrent && value.purchaseReference===record.purchaseReference &&
          value.currency===record.currency).map(value=>({key:value.id,primary:money(value.totalAmountCents,value.currency),
            secondary:purchaseDetails(value,workspace.purchaseCosts)})),
        historyCount:record.historyCount,historyComplete:record.historyComplete,
        correct:()=>{ setExplicitAmounts({}); setPurchase({ purchaseReference:record.purchaseReference,batchNumbers:record.batchNumbers.join(","),
          totalAmount:(record.totalAmountCents/100).toFixed(2),provenance:record.provenance,allocationRule:record.allocationRule,
          purchasedAt:record.purchasedAt ?? "",marketObservedAt:"",correctsEntryId:record.id,correctionReason:"" }); },
      }))} />
      <RecentRecords title="Funding adjustments" empty="No funding adjustments." rows={workspace.fundingAdjustments.filter(record=>record.isCurrent).map(record=>({
        key:record.id,primary:`${record.adjustmentReference}: ${money(record.amountCents,record.currency)}`,
        secondary:fundingDetails(record,workspace.fundingAdjustments),
        history:workspace.fundingAdjustments.filter(value=>!value.isCurrent && value.adjustmentReference===record.adjustmentReference &&
          value.currency===record.currency).map(value=>({key:value.id,primary:money(value.amountCents,value.currency),
            secondary:fundingDetails(value,workspace.fundingAdjustments)})),
        historyCount:record.historyCount,historyComplete:record.historyComplete,
        correct:()=>setFunding({ adjustmentReference:record.adjustmentReference,adjustmentType:record.adjustmentType,
          amount:(record.amountCents/100).toFixed(2),provenance:record.provenance,effectiveAt:record.effectiveAt,
          purchaseReference:record.purchaseReference ?? "",correctsEntryId:record.id,correctionReason:"" }),
      }))} />
      <RecentRecords title="Order expenses" empty="No manual order expenses." rows={workspace.orderExpenses.filter(record=>record.isCurrent).map(record=>({
        key:record.id,primary:`${record.expenseReference}: ${money(record.amountCents,record.currency)}`,
        secondary:expenseDetails(record,workspace.orderExpenses),
        history:workspace.orderExpenses.filter(value=>!value.isCurrent && value.expenseReference===record.expenseReference &&
          value.currency===record.currency).map(value=>({key:value.id,primary:money(value.amountCents,value.currency),
            secondary:expenseDetails(value,workspace.orderExpenses)})),
        historyCount:record.historyCount,historyComplete:record.historyComplete,
        correct:()=>setExpense({ expenseReference:record.expenseReference,expenseType:record.expenseType,
          amount:(record.amountCents/100).toFixed(2),provenance:record.provenance,orderNumbers:record.orderNumbers.join(","),
          expenseAt:record.expenseAt,basis:record.basis,correctsEntryId:record.id,correctionReason:"" }),
      }))} />
    </Stack>

    {workspace.uncostedBatches.length > 0 && <Alert severity="info" sx={{ mb:3 }}>{workspace.uncostedBatches.length} recent batch(es) have unknown acquisition cost. Unknown cost is not zero.</Alert>}
    <InventoryEconomicsOrderTable workspace={workspace} />
  </Box>;
}

export function InventoryEconomicsStatus({ loading,error,onRetry }:{ loading?:boolean;error?:string;onRetry?:()=>void }) {
  return loading ? <Box sx={{ p:4,textAlign:"center" }}><CircularProgress aria-label="Loading inventory economics" /></Box>
    : <Box sx={{ p:3 }}><Alert severity="error" action={onRetry ? <Button onClick={onRetry}>Retry</Button> : undefined}>{error}</Alert></Box>;
}

export function InventoryEconomicsOrderTable({ workspace }:{ workspace:InventoryEconomicsWorkspace }) {
  return <Paper sx={{ overflowX:"auto" }}><Table size="small"><TableHead><TableRow><TableCell>Order</TableCell><TableCell>Gross</TableCell><TableCell>Provider net</TableCell><TableCell>Postage</TableCell><TableCell>Cost</TableCell><TableCell>Reusable cash</TableCell><TableCell>Realized profit</TableCell><TableCell>Coverage</TableCell></TableRow></TableHead>
    <TableBody>{workspace.orders.length === 0 ? <TableRow><TableCell colSpan={8}>No captured seller orders yet. Purchase and funding records can still be entered.</TableCell></TableRow> : workspace.orders.map(order=><TableRow key={order.orderNumber}><TableCell>{order.orderNumber}</TableCell><TableCell>{money(order.grossOrderCents,order.currency)}</TableCell><TableCell>{money(order.providerNetCents,order.currency)}</TableCell><TableCell>{money(order.postageCents,order.currency)}</TableCell><TableCell>{money(order.acquisitionCostCents,order.currency)}</TableCell><TableCell>{money(order.reusableCashCents,order.currency)}</TableCell><TableCell>{money(order.realizedProfitCents,order.currency)}</TableCell><TableCell>{`${order.proceedsCoverage} proceeds; ${order.expenseCoverage} expenses; ${order.costCoverage} cost. Quantities: ${order.orderedQuantity} ordered, ${order.settledQuantity} settled, ${order.costKnownQuantity} cost known.${order.missing.length ? ` Missing: ${order.missing.join(", ")}.` : ""}`}</TableCell></TableRow>)}</TableBody></Table></Paper>;
}

interface RecentRecordRow {
  key:string;
  primary:string;
  secondary:string;
  correct?:()=>void;
  history?:Array<{key:string;primary:string;secondary:string}>;
  historyCount?:number;
  historyComplete?:boolean;
}
export function RecentRecords({ title,empty,rows }:{ title:string;empty:string;rows:RecentRecordRow[] }) {
  return <Paper sx={{p:2,flex:1}}><Typography variant="h6">{title}</Typography>{rows.length === 0
    ? <Typography color="text.secondary" sx={{mt:1}}>{empty}</Typography>
    : <Stack spacing={1} sx={{mt:1}}>{rows.slice(0,5).map(row=><Box key={row.key} sx={{borderBottom:1,borderColor:"divider",pb:1}}>
      <Stack direction="row" justifyContent="space-between" gap={1}><Typography variant="body2">{row.primary}</Typography>{row.correct && <Button size="small" onClick={row.correct}>Correct</Button>}</Stack>
      <Typography variant="caption" color="text.secondary">{row.secondary}</Typography>
      {!!row.history?.length && <Box component="details" sx={{mt:0.5}}>
        <Typography component="summary" variant="caption" sx={{cursor:"pointer"}}>
          View correction history ({row.historyCount ?? row.history.length + 1} versions)
        </Typography>
        <Stack spacing={0.75} sx={{mt:0.75,pl:1.5}}>
          {row.history.map(entry=><Box key={entry.key}><Typography variant="caption">{entry.primary}</Typography>
            <Typography display="block" variant="caption" color="text.secondary">{entry.secondary}</Typography></Box>)}
          {row.historyComplete === false && <Typography variant="caption" color="text.secondary">
            Showing the latest 25 versions. Older versions remain preserved.
          </Typography>}
        </Stack>
      </Box>}
    </Box>)}</Stack>}</Paper>;
}
