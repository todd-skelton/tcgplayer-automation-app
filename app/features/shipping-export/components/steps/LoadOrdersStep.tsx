import { useRef, useState } from "react";
import ArrowDropDownIcon from "@mui/icons-material/ArrowDropDown";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  ListItemText,
  Menu,
  MenuItem,
  Popover,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type { ShippingExportConfig, TcgPlayerShippingOrder } from "../../types/shippingExport";
import type { SellerOrderCoverage } from "~/features/seller-order-history/types/sellerOrderHistory";

interface LoadOrdersStepProps {
  config: ShippingExportConfig;
  sellerKeyInput: string;
  singleOrderNumberInput: string;
  sourceOrders: TcgPlayerShippingOrder[];
  loadedSourceLabel: string;
  isLoadingLiveOrders: boolean;
  isLoadingSingleOrder: boolean;
  isLoadingExistingPostage: boolean;
  loadWarnings: string[];
  onSellerKeyChange: (value: string) => void;
  onSingleOrderNumberChange: (value: string) => void;
  onLoadLiveOrders: () => void;
  onLoadSingleOrder: () => void;
  historyCoverage?: SellerOrderCoverage;
  isUpdatingHistory?: boolean;
  onCatchUpHistory?: () => void;
  onImportHistoryFile?: (file: File) => void;
}

function describeHistoryCoverage(coverage: SellerOrderCoverage): string {
  const total = coverage.expectedTotal === undefined ? "" : ` of ${coverage.expectedTotal}`;
  return `API history ${coverage.status.replace("_", " ")}: ${coverage.ordersObserved}${total} orders observed, ${coverage.detailsRecorded} details refreshed in the last scan.${coverage.error ? ` ${coverage.error}` : ""}`;
}

/** Loads the Ready to Ship queue or one order, with the seller key and order history kept out of the way. */
export function LoadOrdersStep({
  config,
  sellerKeyInput,
  singleOrderNumberInput,
  sourceOrders,
  loadedSourceLabel,
  isLoadingLiveOrders,
  isLoadingSingleOrder,
  isLoadingExistingPostage,
  loadWarnings,
  onSellerKeyChange,
  onSingleOrderNumberChange,
  onLoadLiveOrders,
  onLoadSingleOrder,
  historyCoverage,
  isUpdatingHistory = false,
  onCatchUpHistory,
  onImportHistoryFile,
}: LoadOrdersStepProps) {
  const sellerButton = useRef<HTMLButtonElement>(null);
  const historyButton = useRef<HTMLButtonElement>(null);
  const [sellerOpen, setSellerOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const isLoading = isLoadingLiveOrders || isLoadingSingleOrder || isLoadingExistingPostage;
  const hasHistoryActions = Boolean(onCatchUpHistory || onImportHistoryFile);

  return (
    <Stack spacing={2}>
      {loadWarnings.length > 0 && (
        <Alert severity="warning">
          <Typography variant="body2" fontWeight={600}>
            Order load warnings
          </Typography>
          {loadWarnings.map((warning) => (
            <Typography key={warning} variant="body2">
              {warning}
            </Typography>
          ))}
        </Alert>
      )}

      <Stack direction="row" spacing={1.5} alignItems="center" useFlexGap flexWrap="wrap">
        <Button
          variant="contained"
          onClick={onLoadLiveOrders}
          disabled={isLoading}
          startIcon={isLoadingLiveOrders ? <CircularProgress color="inherit" size={18} /> : undefined}
        >
          {isLoadingLiveOrders ? "Loading Live Orders..." : "Load Live TCGPlayer Orders"}
        </Button>
        <Button
          ref={sellerButton}
          aria-haspopup="dialog"
          color={sellerKeyInput.trim() ? "primary" : "warning"}
          onClick={() => setSellerOpen(true)}
          sx={{ textTransform: "none" }}
        >
          Seller: {sellerKeyInput.trim() || "not set"}
        </Button>

        <Divider orientation="vertical" flexItem />

        <TextField
          size="small"
          label="Order Number"
          value={singleOrderNumberInput}
          onChange={(event) => onSingleOrderNumberChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !isLoading) onLoadSingleOrder();
          }}
          sx={{ width: 240 }}
        />
        <Button
          variant="outlined"
          onClick={onLoadSingleOrder}
          disabled={isLoading}
          startIcon={isLoadingSingleOrder ? <CircularProgress color="inherit" size={18} /> : undefined}
        >
          {isLoadingSingleOrder ? "Looking Up Order..." : "Lookup Single Order"}
        </Button>

        {hasHistoryActions && (
          <>
            <Box sx={{ flex: 1 }} />
            <Button
              ref={historyButton}
              aria-haspopup="menu"
              aria-expanded={historyOpen}
              disabled={isUpdatingHistory}
              endIcon={isUpdatingHistory ? <CircularProgress color="inherit" size={16} /> : <ArrowDropDownIcon />}
              onClick={() => setHistoryOpen(true)}
            >
              {isUpdatingHistory ? "Updating History..." : "Order History"}
            </Button>
          </>
        )}
      </Stack>

      {(loadedSourceLabel || isLoadingExistingPostage) && (
        <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
          {loadedSourceLabel && <Chip label={loadedSourceLabel} size="small" color="primary" variant="outlined" />}
          <Chip label={`${sourceOrders.length} orders loaded`} size="small" variant="outlined" />
          {isLoadingExistingPostage && (
            <Chip label="Loading saved labels..." size="small" color="info" variant="outlined" />
          )}
        </Stack>
      )}

      {historyCoverage?.error && <Alert severity="warning">{describeHistoryCoverage(historyCoverage)}</Alert>}

      <Popover
        open={sellerOpen}
        anchorEl={sellerButton.current}
        onClose={() => setSellerOpen(false)}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
        slotProps={{ paper: { sx: { p: 2, width: 360 } } }}
      >
        <TextField
          autoFocus
          fullWidth
          label="Seller Key"
          value={sellerKeyInput}
          onChange={(event) => onSellerKeyChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") setSellerOpen(false);
          }}
          placeholder={config.defaultSellerKey || "Enter seller key"}
          helperText={
            config.defaultSellerKey
              ? `Saved default: ${config.defaultSellerKey}. Used for loading, lookups, and returns.`
              : "Save a default seller key in Shipping Configuration or enter one here."
          }
        />
      </Popover>

      <Menu
        open={historyOpen}
        anchorEl={historyButton.current}
        onClose={() => setHistoryOpen(false)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{ paper: { sx: { maxWidth: 440 } } }}
      >
        {onCatchUpHistory && (
          <MenuItem
            onClick={() => {
              setHistoryOpen(false);
              onCatchUpHistory();
            }}
          >
            <ListItemText
              primary="Catch Up Order History"
              secondary={
                historyCoverage
                  ? describeHistoryCoverage(historyCoverage)
                  : "Advances a saved scan of TCGPlayer's last three months, so orders stay on record after they ship."
              }
              slotProps={{ secondary: { sx: { whiteSpace: "normal" } } }}
            />
          </MenuItem>
        )}
        {onImportHistoryFile && (
          <MenuItem component="label">
            <ListItemText
              primary="Import Older Order CSV"
              secondary="A USD order export for orders older than the three-month API window."
              slotProps={{ secondary: { sx: { whiteSpace: "normal" } } }}
            />
            <input
              hidden
              type="file"
              accept=".csv,text/csv"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                setHistoryOpen(false);
                if (file) onImportHistoryFile(file);
              }}
            />
          </MenuItem>
        )}
      </Menu>
    </Stack>
  );
}
