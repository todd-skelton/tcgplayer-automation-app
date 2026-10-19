import GridViewIcon from "@mui/icons-material/GridView";
import ViewModuleIcon from "@mui/icons-material/ViewModule";
import {
  Alert,
  Chip,
  LinearProgress,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { useMemo, useState } from "react";
import { PullSheetGrid } from "~/features/pull-sheet/components/PullSheetGrid";
import { PullSheetTable } from "~/features/pull-sheet/components/PullSheetTable";
import type { PullSheetItem } from "~/features/pull-sheet/types/pullSheetTypes";
import { saleValuesBySku } from "../../services/saleValue";
import type {
  EasyPostShipment,
  TcgPlayerShippingOrder,
} from "../../types/shippingExport";
import { SaleValueFigures } from "../SaleValueFigures";

interface PullSheetStepProps {
  sourceOrders: TcgPlayerShippingOrder[];
  shipments: EasyPostShipment[];
  pullSheetItems: PullSheetItem[];
  isLoadingPullSheet: boolean;
  pullSheetError: string | null;
}

type ViewMode = "card" | "grid";

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function PullSheetStep({
  sourceOrders,
  shipments,
  pullSheetItems,
  isLoadingPullSheet,
  pullSheetError,
}: PullSheetStepProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("card");
  const [filterText, setFilterText] = useState("");
  const hasProductData = sourceOrders.some(
    (order) => (order.products?.length ?? 0) > 0,
  );

  const normalizedFilter = filterText.trim().toLowerCase();
  const filteredItems = normalizedFilter
    ? pullSheetItems.filter(
        (item) =>
          item.productName.toLowerCase().includes(normalizedFilter) ||
          item.set.toLowerCase().includes(normalizedFilter) ||
          item.number.toLowerCase().includes(normalizedFilter) ||
          item.productLine.toLowerCase().includes(normalizedFilter),
      )
    : pullSheetItems;
  const totalPullSheetQuantity = pullSheetItems.reduce(
    (sum, item) => sum + item.quantity,
    0,
  );
  const filteredQuantity = filteredItems.reduce(
    (sum, item) => sum + item.quantity,
    0,
  );
  const missingDatabaseMatches = pullSheetItems.filter(
    (item) => !item.found,
  ).length;
  const cardValues = useMemo(() => saleValuesBySku(sourceOrders), [sourceOrders]);
  const renderCardValue = (item: PullSheetItem, onImage: boolean) => {
    const value = cardValues.get(item.skuId);
    return value ? <SaleValueFigures value={value} variant="caption" onImage={onImage} /> : null;
  };

  const packageCounts = (["Letter", "Flat", "Parcel"] as const)
    .map((pkg) => [pkg, shipments.filter((shipment) => shipment.parcel.predefined_package === pkg).length] as const)
    .filter(([, packageCount]) => packageCount > 0)
    .map(([pkg, packageCount]) => `${packageCount} ${pkg}`);
  const countSummary = [
    normalizedFilter
      ? `${filteredQuantity} of ${plural(totalPullSheetQuantity, "card")}`
      : plural(totalPullSheetQuantity, "card"),
    plural(filteredItems.length, "row"),
    ...packageCounts,
  ].join(" · ");

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1.5} alignItems="center" useFlexGap flexWrap="wrap">
        <TextField
          size="small"
          placeholder="Filter cards..."
          value={filterText}
          onChange={(event) => setFilterText(event.target.value)}
          sx={{ width: 260 }}
        />
        <ToggleButtonGroup
          value={viewMode}
          exclusive
          onChange={(_, value: ViewMode | null) => value && setViewMode(value)}
          size="small"
        >
          <ToggleButton value="card" aria-label="card view">
            <ViewModuleIcon sx={{ mr: 0.75 }} fontSize="small" />
            Card View
          </ToggleButton>
          <ToggleButton value="grid" aria-label="grid view">
            <GridViewIcon sx={{ mr: 0.75 }} fontSize="small" />
            Grid View
          </ToggleButton>
        </ToggleButtonGroup>
        <Typography variant="body2" color="text.secondary">
          {countSummary}
        </Typography>
        {missingDatabaseMatches > 0 && (
          <Chip label={`${missingDatabaseMatches} not in database`} size="small" color="warning" variant="outlined" />
        )}
      </Stack>

      {isLoadingPullSheet && (
        <Stack spacing={1}>
          <LinearProgress />
          <Typography variant="body2" color="text.secondary">
            Loading the embedded pull sheet from the current order set.
          </Typography>
        </Stack>
      )}

      {!hasProductData && !isLoadingPullSheet && !pullSheetError && (
        <Alert severity="info">
          These orders did not include line items locally, so this step is showing the generated TCGPlayer pull sheet
          directly instead of a locally assembled list.
        </Alert>
      )}

      {pullSheetError && <Alert severity="warning">{pullSheetError}</Alert>}

      {pullSheetItems.length > 0 &&
        (viewMode === "card" ? (
          <PullSheetGrid items={filteredItems} renderItemDetail={(item) => renderCardValue(item, true)} />
        ) : (
          <PullSheetTable items={filteredItems} renderItemDetail={(item) => renderCardValue(item, false)} />
        ))}

      {!isLoadingPullSheet && !pullSheetError && pullSheetItems.length === 0 && sourceOrders.length > 0 && (
        <Alert severity="info">
          No pull sheet rows were generated for the current orders. Packing slips are available on Print.
        </Alert>
      )}
    </Stack>
  );
}
