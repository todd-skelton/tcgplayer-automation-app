import GridViewIcon from "@mui/icons-material/GridView";
import ViewModuleIcon from "@mui/icons-material/ViewModule";
import {
  Alert,
  Box,
  Button,
  Chip,
  LinearProgress,
  Paper,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { useState } from "react";
import { PullSheetGrid } from "~/features/pull-sheet/components/PullSheetGrid";
import { PullSheetTable } from "~/features/pull-sheet/components/PullSheetTable";
import type { PullSheetItem } from "~/features/pull-sheet/types/pullSheetTypes";
import type {
  EasyPostShipment,
  TcgPlayerShippingOrder,
} from "../../types/shippingExport";

interface PullSheetStepProps {
  sourceOrders: TcgPlayerShippingOrder[];
  shipments: EasyPostShipment[];
  pullSheetItems: PullSheetItem[];
  pullSheetOrderIds: string[];
  isLoadingPullSheet: boolean;
  pullSheetError: string | null;
  onBack: () => void;
  onContinue: () => void;
}

type ViewMode = "card" | "grid";

export function PullSheetStep({
  sourceOrders,
  shipments,
  pullSheetItems,
  pullSheetOrderIds,
  isLoadingPullSheet,
  pullSheetError,
  onBack,
  onContinue,
}: PullSheetStepProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("card");
  const [filterText, setFilterText] = useState("");
  const hasProductData = sourceOrders.some(
    (order) => (order.products?.length ?? 0) > 0,
  );

  const letterCount = shipments.filter(
    (shipment) => shipment.parcel.predefined_package === "Letter",
  ).length;
  const flatCount = shipments.filter(
    (shipment) => shipment.parcel.predefined_package === "Flat",
  ).length;
  const parcelCount = shipments.filter(
    (shipment) => shipment.parcel.predefined_package === "Parcel",
  ).length;
  const totalItems = sourceOrders.reduce(
    (sum, order) => sum + order["Item Count"],
    0,
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

  return (
    <Stack spacing={3}>
      <Stack direction="row" spacing={1} flexWrap="wrap">
        <Chip label={`${sourceOrders.length} orders`} size="small" />
        <Chip
          label={`${totalItems} total items`}
          size="small"
          variant="outlined"
        />
        <Chip
          label={`${pullSheetItems.length} pull-sheet rows`}
          size="small"
          variant="outlined"
        />
        <Chip
          label={`${totalPullSheetQuantity} cards to pull`}
          size="small"
          variant="outlined"
        />
        {pullSheetOrderIds.length > 0 && (
          <Chip
            label={`${pullSheetOrderIds.length} order refs in pull sheet`}
            size="small"
            variant="outlined"
          />
        )}
        {letterCount > 0 && (
          <Chip label={`${letterCount} Letter`} size="small" variant="outlined" />
        )}
        {flatCount > 0 && (
          <Chip label={`${flatCount} Flat`} size="small" variant="outlined" />
        )}
        {parcelCount > 0 && (
          <Chip label={`${parcelCount} Parcel`} size="small" variant="outlined" />
        )}
      </Stack>

      <Paper variant="outlined" sx={{ p: 2.5 }}>
        <Stack spacing={2}>
          <Box>
            <Typography variant="subtitle1" gutterBottom>
              Pull Sheet Workspace
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Review the generated pull sheet directly in the workflow. Card
              view is the default, and grid view is available when you want a
              denser scan.
            </Typography>
          </Box>

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
              These orders did not include line items locally, so this step is
              showing the generated TCGPlayer pull sheet directly instead of a
              locally assembled list.
            </Alert>
          )}

          {pullSheetError && (
            <Alert severity="warning">{pullSheetError}</Alert>
          )}

          {pullSheetItems.length > 0 && (
            <>
              <Stack
                direction={{ xs: "column", md: "row" }}
                spacing={2}
                alignItems={{ md: "center" }}
                justifyContent="space-between"
              >
                <Stack direction="row" spacing={1} flexWrap="wrap">
                  <Chip
                    label={`${filteredItems.length} visible rows`}
                    size="small"
                    color="primary"
                    variant="outlined"
                  />
                  <Chip
                    label={`${filteredQuantity} visible cards`}
                    size="small"
                    variant="outlined"
                  />
                  {missingDatabaseMatches > 0 && (
                    <Chip
                      label={`${missingDatabaseMatches} not in database`}
                      size="small"
                      color="warning"
                      variant="outlined"
                    />
                  )}
                </Stack>

                <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
                  <TextField
                    size="small"
                    placeholder="Filter cards..."
                    value={filterText}
                    onChange={(event) => setFilterText(event.target.value)}
                    sx={{ minWidth: { xs: "100%", sm: 260 } }}
                  />
                  <ToggleButtonGroup
                    value={viewMode}
                    exclusive
                    onChange={(_, value: ViewMode | null) =>
                      value && setViewMode(value)
                    }
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
                </Stack>
              </Stack>

              {viewMode === "card" ? (
                <PullSheetGrid items={filteredItems} />
              ) : (
                <PullSheetTable items={filteredItems} />
              )}
            </>
          )}

          {!isLoadingPullSheet &&
            !pullSheetError &&
            pullSheetItems.length === 0 &&
            sourceOrders.length > 0 && (
              <Alert severity="info">
                No pull sheet rows were generated for the current orders.
              </Alert>
            )}
        </Stack>
      </Paper>

      {!hasProductData && pullSheetItems.length === 0 && !isLoadingPullSheet && (
        <Alert severity="info">
          Packing slips are still available in the next step if you need a PDF
          reference while this pull sheet is unavailable.
        </Alert>
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
