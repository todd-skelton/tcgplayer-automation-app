import {
  Accordion, AccordionDetails, AccordionSummary, Alert, Box, Chip, LinearProgress, Paper, Stack,
  Table, TableBody, TableCell, TableHead, TableRow, Typography,
  TablePagination,
} from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import { useState } from "react";
import type { ReinvestmentTurnaroundReport } from "../types/reinvestmentTurnaround";

function money(cents:number,currency:string):string {
  return new Intl.NumberFormat("en-US",{style:"currency",currency}).format(cents/100);
}
function days(value:number|null):string { return value===null?"Unavailable":`${value.toFixed(1)} days`; }
function percent(value:number|null):string { return value===null?"Unavailable":`${value.toFixed(1)}%`; }

export function ReinvestmentTurnaround({report,error,loading=false}:{
  report:ReinvestmentTurnaroundReport|null;error?:string|null;loading?:boolean;
}) {
  const [page,setPage]=useState(0);
  const rowsPerPage=50;
  const displayPage=report?Math.min(page,Math.max(0,Math.ceil(report.samples.length/rowsPerPage)-1)):0;
  const visibleSamples=report?.samples.slice(displayPage*rowsPerPage,(displayPage+1)*rowsPerPage)??[];
  return <Box component="section" aria-labelledby="reinvestment-turnaround-title" sx={{mb:3}}>
    <Typography id="reinvestment-turnaround-title" variant="h5" gutterBottom>Sale-to-publication reinvestment</Typography>
    <Typography color="text.secondary" sx={{mb:2}}>
      Estimated pooled financial attribution from reusable sale proceeds to newly published replacement inventory.
      It does not identify physical FIFO replacements or confirm bank cash availability.
    </Typography>
    {loading?<LinearProgress aria-label="Loading reinvestment turnaround" sx={{mb:2}}/>:null}
    {error?<Alert severity="error" sx={{mb:2}}>{error}</Alert>:null}
    {!report?<Alert severity="info">No reinvestment report is available.</Alert>:
      report.currencies.length===0?<Alert severity="info">No complete reusable proceeds or costed replacement purchases are available yet.
        Unknown evidence remains listed below when present.</Alert>:<>
        <Stack direction={{xs:"column",lg:"row"}} spacing={2} sx={{mb:2}}>
          {report.currencies.map((summary)=><Paper variant="outlined" key={summary.currency} sx={{p:2,flex:1}}>
            <Typography variant="h6">{summary.currency}</Typography>
            <Stack direction="row" useFlexGap flexWrap="wrap" spacing={1} sx={{my:1}}>
              <Chip label={`Completed ${money(summary.completedCents,summary.currency)}`}/>
              <Chip label={`Waiting ${money(summary.waitingCents,summary.currency)}`} color={summary.waitingCents?"warning":"default"}/>
              <Chip label={`Unallocated ${money(summary.unallocatedProceedsCents,summary.currency)}`}/>
            </Stack>
            <Typography>Completed dollar-weighted mean: {days(summary.completedDollarWeightedMeanDays)}</Typography>
            <Typography>Completed weighted median / p90: {days(summary.completedWeightedMedianDays)} / {days(summary.completedWeightedP90Days)}</Typography>
            <Typography>Completion coverage: {percent(summary.completionCoveragePercent)}</Typography>
            <Typography>Percentage reinvested: {percent(summary.reinvestedPercent)}</Typography>
            <Typography>Waiting dollar-weighted age / oldest: {days(summary.waitingDollarWeightedAgeDays)} / {days(summary.oldestWaitingDays)}</Typography>
            <Typography>Unallocated dollar-weighted age / oldest: {days(summary.unallocatedDollarWeightedAgeDays)} / {days(summary.oldestUnallocatedDays)}</Typography>
            <Typography color="text.secondary" variant="body2" sx={{mt:1}}>
              Denominator: {money(summary.eligibleProceedsCents,summary.currency)} positive eligible proceeds, including
              reserved, withdrawn, and negatively offset money. Negative effects {money(summary.negativeProceedsCents,summary.currency)};
              reserved/withdrawn {money(summary.reservedOrWithdrawnCents,summary.currency)}; outside funding used {money(summary.outsideFundingUsedCents,summary.currency)};
              unresolved purchase cost {money(summary.unresolvedPurchaseCostCents,summary.currency)}.
            </Typography>
          </Paper>)}
        </Stack>
        <Paper variant="outlined" sx={{overflowX:"auto",mb:2}}>
          <Table size="small" aria-label="Reinvestment attribution samples">
            <TableHead><TableRow><TableCell>Sale → purchase</TableCell><TableCell>Amount</TableCell><TableCell>State</TableCell>
              <TableCell>Timing</TableCell><TableCell>Days</TableCell><TableCell>Provenance</TableCell></TableRow></TableHead>
            <TableBody>{report.samples.length===0?<TableRow><TableCell colSpan={6}>No sale proceeds are attributed to current purchase costs.</TableCell></TableRow>:
              visibleSamples.map((sample)=><TableRow key={sample.sampleKey}><TableCell>{sample.orderNumber} → {sample.purchaseReference}</TableCell>
                <TableCell>{money(sample.amountCents,sample.currency)}</TableCell><TableCell>{sample.state}</TableCell>
                <TableCell>{sample.timingBasis.replaceAll("_"," ")}</TableCell>
                <TableCell>{days(sample.turnaroundDays??sample.waitingAgeDays??null)}</TableCell>
                <TableCell>{sample.proceedsProvenance} proceeds; {sample.costProvenance} cost; {sample.fundingProvenance} funding</TableCell></TableRow>)}</TableBody>
          </Table>
          <TablePagination component="div" count={report.samples.length} page={displayPage} rowsPerPage={rowsPerPage}
            rowsPerPageOptions={[rowsPerPage]} onPageChange={(_event,nextPage)=>setPage(nextPage)}/>
        </Paper>
      </>}
    {report?<>
      {report.excluded.length?<Alert severity="warning" sx={{mb:2}}>{report.excluded.map((item)=>`${item.reason}: ${item.count}${item.amountCents!==undefined
        ?` (${item.currency?money(item.amountCents,item.currency):`${item.amountCents.toLocaleString()} cents`})`:""}`).join(" · ")}</Alert>:null}
      <Accordion><AccordionSummary expandIcon={<ExpandMoreIcon/>}><Typography>Method, freshness, and sample explanations</Typography></AccordionSummary>
        <AccordionDetails><Typography variant="body2" sx={{mb:1}}>Effective as of {new Date(report.asOf).toLocaleString()} · rule {report.ruleVersion} · source {report.sourceFingerprint.slice(0,12)}.
          This is a current-corrected view; recorded-at history is not presented as historical knowledge.</Typography>
          {report.convention.map((line)=><Typography variant="body2" key={line}>• {line}</Typography>)}
          {visibleSamples.map((sample)=><Typography variant="body2" key={`explain-${sample.sampleKey}`} sx={{mt:1}}>{sample.explanation}</Typography>)}
        </AccordionDetails></Accordion>
    </>:null}
  </Box>;
}
