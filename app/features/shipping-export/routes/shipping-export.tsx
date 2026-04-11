import DownloadIcon from "@mui/icons-material/Download";
import EditIcon from "@mui/icons-material/Edit";
import ReplyIcon from "@mui/icons-material/Reply";
import {
  Alert,
  Box,
  Button,
  Container,
  Divider,
  Drawer,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  data,
  useLoaderData,
  Link,
  type MetaFunction,
} from "react-router";
import Papa from "papaparse";
import { useState } from "react";
import { getShippingExportConfig } from "../config/shippingExportConfig.server";
import {
  buildTimestampedFileName,
  createReturnShipment,
  getAllLabelSizes,
  getShipmentCsvRows,
  getShipmentsForLabelSize,
  mapOrdersToShipments,
  mergeOrdersByAddress,
  parseShippingOrdersCsv,
} from "../services/shippingExportUtils";
import {
  type EasyPostAddress,
  type EasyPostService,
  type EasyPostShipment,
  type LabelFormat,
  type LabelSize,
  type ShipmentToOrderMap,
  type ShippingExportConfig,
  type TcgPlayerShippingOrder,
} from "../types/shippingExport";

function updateOrderDerivedState(
  sourceOrders: TcgPlayerShippingOrder[],
  config: ShippingExportConfig,
): {
  orders: TcgPlayerShippingOrder[];
  shipments: EasyPostShipment[];
  shipmentToOrderMap: ShipmentToOrderMap;
} {
  const mergedOrders = mergeOrdersByAddress(sourceOrders, config.combineOrders);

  return {
    orders: mergedOrders.orders,
    shipments: mapOrdersToShipments(mergedOrders.orders, config),
    shipmentToOrderMap: mergedOrders.shipmentToOrderMap,
  };
}

function downloadCsvFile(
  filenamePrefix: string,
  shipments: EasyPostShipment[],
): void {
  const csvOutput = Papa.unparse(getShipmentCsvRows(shipments));
  const blob = new Blob([csvOutput], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = buildTimestampedFileName(filenamePrefix);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function AddressBlock({ address }: { address: EasyPostAddress }) {
  const lines = [
    address.name,
    address.company,
    address.street1,
    address.street2,
    `${address.city}, ${address.state} ${address.zip}`.trim(),
    address.country,
  ].filter(Boolean);

  return <Typography component="pre">{lines.join("\n")}</Typography>;
}

function ShipmentEditDrawer({
  shipment,
  open,
  onClose,
  onSave,
  onChange,
}: {
  shipment: EasyPostShipment | null;
  open: boolean;
  onClose: () => void;
  onSave: () => void;
  onChange: (changes: Partial<EasyPostShipment>) => void;
}) {
  if (!shipment) {
    return null;
  }

  return (
    <Drawer anchor="right" open={open} onClose={onClose}>
      <Container sx={{ width: 420, p: 3 }}>
        <Stack spacing={2}>
          <Typography variant="h6">Edit Shipment</Typography>

          <Typography variant="subtitle2">To Address</Typography>
          <TextField
            label="Name"
            value={shipment.to_address.name}
            onChange={(event) =>
              onChange({
                to_address: {
                  ...shipment.to_address,
                  name: event.target.value,
                },
              })
            }
          />
          <TextField
            label="Street 1"
            value={shipment.to_address.street1}
            onChange={(event) =>
              onChange({
                to_address: {
                  ...shipment.to_address,
                  street1: event.target.value,
                },
              })
            }
          />
          <TextField
            label="Street 2"
            value={shipment.to_address.street2 ?? ""}
            onChange={(event) =>
              onChange({
                to_address: {
                  ...shipment.to_address,
                  street2: event.target.value || undefined,
                },
              })
            }
          />
          <TextField
            label="City"
            value={shipment.to_address.city}
            onChange={(event) =>
              onChange({
                to_address: {
                  ...shipment.to_address,
                  city: event.target.value,
                },
              })
            }
          />
          <Stack direction="row" spacing={2}>
            <TextField
              label="State"
              value={shipment.to_address.state}
              onChange={(event) =>
                onChange({
                  to_address: {
                    ...shipment.to_address,
                    state: event.target.value,
                  },
                })
              }
              fullWidth
            />
            <TextField
              label="Zip"
              value={shipment.to_address.zip}
              onChange={(event) =>
                onChange({
                  to_address: {
                    ...shipment.to_address,
                    zip: event.target.value,
                  },
                })
              }
              fullWidth
            />
          </Stack>

          <Divider />
          <Typography variant="subtitle2">Shipment Details</Typography>
          <TextField
            label="Reference"
            value={shipment.reference}
            onChange={(event) => onChange({ reference: event.target.value })}
          />
          <FormControl fullWidth>
            <InputLabel id="shipment-service-label">Service</InputLabel>
            <Select
              labelId="shipment-service-label"
              label="Service"
              value={shipment.service}
              onChange={(event) =>
                onChange({ service: event.target.value as EasyPostService })
              }
            >
              <MenuItem value="First">First</MenuItem>
              <MenuItem value="GroundAdvantage">Ground Advantage</MenuItem>
              <MenuItem value="Priority">Priority</MenuItem>
              <MenuItem value="Express">Express</MenuItem>
            </Select>
          </FormControl>
          <Stack direction="row" spacing={2}>
            <TextField
              label="Length (in)"
              type="number"
              value={shipment.parcel.length}
              onChange={(event) =>
                onChange({
                  parcel: {
                    ...shipment.parcel,
                    length: Number(event.target.value),
                  },
                })
              }
              fullWidth
            />
            <TextField
              label="Width (in)"
              type="number"
              value={shipment.parcel.width}
              onChange={(event) =>
                onChange({
                  parcel: {
                    ...shipment.parcel,
                    width: Number(event.target.value),
                  },
                })
              }
              fullWidth
            />
          </Stack>
          <Stack direction="row" spacing={2}>
            <TextField
              label="Height (in)"
              type="number"
              value={shipment.parcel.height}
              onChange={(event) =>
                onChange({
                  parcel: {
                    ...shipment.parcel,
                    height: Number(event.target.value),
                  },
                })
              }
              fullWidth
            />
            <TextField
              label="Weight (oz)"
              type="number"
              value={shipment.parcel.weight}
              onChange={(event) =>
                onChange({
                  parcel: {
                    ...shipment.parcel,
                    weight: Number(event.target.value),
                  },
                })
              }
              fullWidth
            />
          </Stack>
          <FormControl fullWidth>
            <InputLabel id="shipment-label-format-label">Label Format</InputLabel>
            <Select
              labelId="shipment-label-format-label"
              label="Label Format"
              value={shipment.options.label_format}
              onChange={(event) =>
                onChange({
                  options: {
                    ...shipment.options,
                    label_format: event.target.value as LabelFormat,
                  },
                })
              }
            >
              <MenuItem value="PDF">PDF</MenuItem>
              <MenuItem value="PNG">PNG</MenuItem>
            </Select>
          </FormControl>
          <FormControl fullWidth>
            <InputLabel id="shipment-label-size-label">Label Size</InputLabel>
            <Select
              labelId="shipment-label-size-label"
              label="Label Size"
              value={shipment.options.label_size}
              onChange={(event) =>
                onChange({
                  options: {
                    ...shipment.options,
                    label_size: event.target.value as LabelSize,
                  },
                })
              }
            >
              <MenuItem value="4x6">4x6</MenuItem>
              <MenuItem value="7x3">7x3</MenuItem>
              <MenuItem value="6x4">6x4</MenuItem>
            </Select>
          </FormControl>
          <Button variant="contained" onClick={onSave}>
            Save Shipment Changes
          </Button>
        </Stack>
      </Container>
    </Drawer>
  );
}

export const meta: MetaFunction = () => {
  return [
    { title: "EasyPost Shipping Export" },
    {
      name: "description",
      content:
        "Convert TCGPlayer shipping export CSV files into EasyPost shipment CSV batches.",
    },
  ];
};

export async function loader() {
  const config = await getShippingExportConfig();
  return data({ config });
}

export default function ShippingExportRoute() {
  const { config } = useLoaderData<typeof loader>();
  const [sourceOrders, setSourceOrders] = useState<TcgPlayerShippingOrder[]>([]);
  const [orders, setOrders] = useState<TcgPlayerShippingOrder[]>([]);
  const [shipments, setShipments] = useState<EasyPostShipment[]>([]);
  const [shipmentToOrderMap, setShipmentToOrderMap] =
    useState<ShipmentToOrderMap>({});
  const [uploadedFileName, setUploadedFileName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [selectedShipment, setSelectedShipment] =
    useState<EasyPostShipment | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const handleFileInput = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    try {
      const csvText = await file.text();
      const parsedOrders = parseShippingOrdersCsv(csvText);

      if (parsedOrders.length === 0) {
        throw new Error("No valid order rows were found in the uploaded CSV.");
      }

      const nextState = updateOrderDerivedState(parsedOrders, config);

      setUploadedFileName(file.name);
      setSourceOrders(parsedOrders);
      setOrders(nextState.orders);
      setShipments(nextState.shipments);
      setShipmentToOrderMap(nextState.shipmentToOrderMap);
      setError(null);
    } catch (uploadError) {
      setError(String(uploadError));
    }
  };

  const handleRebuildShipments = () => {
    if (sourceOrders.length === 0) {
      return;
    }

    const nextState = updateOrderDerivedState(sourceOrders, config);
    setOrders(nextState.orders);
    setShipments(nextState.shipments);
    setShipmentToOrderMap(nextState.shipmentToOrderMap);
    setError(null);
  };

  const handleDownloadAll = () => {
    for (const labelSize of getAllLabelSizes()) {
      const labelShipments = getShipmentsForLabelSize(shipments, labelSize);

      if (labelShipments.length > 0) {
        downloadCsvFile(`EasyPost_Shipments_${labelSize}`, labelShipments);
      }
    }
  };

  const handleDownloadShipment = (shipment: EasyPostShipment) => {
    downloadCsvFile(
      `EasyPost_Shipments_${shipment.options.label_size}`,
      [shipment],
    );
  };

  const handleDownloadReturnShipment = (shipment: EasyPostShipment) => {
    const returnShipment = createReturnShipment(shipment);
    downloadCsvFile(
      `EasyPost_Returns_${returnShipment.options.label_size}`,
      [returnShipment],
    );
  };

  const handleOpenEditDrawer = (shipment: EasyPostShipment) => {
    setSelectedShipment(shipment);
    setDrawerOpen(true);
  };

  const handleSaveShipmentChanges = () => {
    if (!selectedShipment) {
      return;
    }

    setShipments((previousShipments) =>
      previousShipments.map((shipment) =>
        shipment.reference === selectedShipment.reference ? selectedShipment : shipment,
      ),
    );
    setDrawerOpen(false);
  };

  return (
    <Box sx={{ maxWidth: 1400, mx: "auto", p: 3 }}>
      <Typography variant="h4" component="h1" gutterBottom>
        EasyPost Shipping Export
      </Typography>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
        Upload a TCGPlayer shipping export CSV, generate EasyPost-ready shipment
        rows, review each shipment, and download one or more batch files by
        label size.
      </Typography>

      <Alert severity="info" sx={{ mb: 3 }}>
        Shipping settings now live in <strong>Shipping Configuration</strong>
        under the Settings menu. If you change package or address settings
        after uploading a file, use <strong>Rebuild Shipments</strong> to
        regenerate the shipment rows from the uploaded orders.
      </Alert>

      {error && (
        <Alert severity="error" sx={{ mb: 3 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <Paper sx={{ p: 3, mb: 3 }} elevation={3}>
        <Stack spacing={3}>
          <Box>
            <Typography variant="h6">Shipping Settings</Typography>
            <Typography variant="body2" color="text.secondary">
              Manage sender details, package thresholds, and label defaults from
              the Settings menu before generating shipment rows here.
            </Typography>
          </Box>
          <Divider />
          <Stack
            direction={{ xs: "column", md: "row" }}
            spacing={2}
            justifyContent="space-between"
            alignItems={{ md: "center" }}
          >
            <Typography variant="body2" color="text.secondary">
              Save shipping configuration separately, then upload a CSV and use
              Rebuild Shipments to apply those settings to the current file.
            </Typography>
            <Button
              component={Link}
              to="/shipping-configuration"
              variant="contained"
            >
              Open Shipping Configuration
            </Button>
          </Stack>
        </Stack>
      </Paper>

      <Paper sx={{ p: 3, mb: 3 }} elevation={3}>
        <Stack
          direction={{ xs: "column", md: "row" }}
          spacing={2}
          alignItems={{ md: "center" }}
          flexWrap="wrap"
        >
          <Button variant="contained" component="label">
            Upload TCGPlayer Shipping Export CSV
            <input
              type="file"
              hidden
              accept=".csv"
              onChange={handleFileInput}
              onClick={(event) => {
                (event.target as HTMLInputElement).value = "";
              }}
            />
          </Button>
          <Button
            variant="outlined"
            onClick={handleRebuildShipments}
            disabled={sourceOrders.length === 0}
          >
            Rebuild Shipments
          </Button>
          <Button
            variant="contained"
            startIcon={<DownloadIcon />}
            onClick={handleDownloadAll}
            disabled={shipments.length === 0}
          >
            Download EasyPost Batch File(s)
          </Button>
          {uploadedFileName && (
            <Typography variant="body2" color="text.secondary">
              {uploadedFileName}
            </Typography>
          )}
        </Stack>
      </Paper>

      {shipments.length > 0 ? (
        <TableContainer component={Paper} elevation={3}>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Orders</TableCell>
                <TableCell>To Address</TableCell>
                <TableCell>From Address</TableCell>
                <TableCell>Parcel Details</TableCell>
                <TableCell>Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {shipments.map((shipment) => {
                const order = orders.find(
                  (candidate) => candidate["Order #"] === shipment.reference,
                );

                return (
                  <TableRow key={shipment.reference}>
                    <TableCell>
                      <Typography component="pre">
                        {(shipmentToOrderMap[shipment.reference] ?? [
                          shipment.reference,
                        ]).join("\n")}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <AddressBlock address={shipment.to_address} />
                    </TableCell>
                    <TableCell>
                      <AddressBlock address={shipment.from_address} />
                    </TableCell>
                    <TableCell>
                      <Typography component="pre">
                        {[
                          `Order Total: ${order?.["Value Of Products"] ?? 0}`,
                          `Item Count: ${order?.["Item Count"] ?? 0}`,
                          `Size (in): ${shipment.parcel.length} x ${shipment.parcel.width} x ${shipment.parcel.height}`,
                          `Weight (oz): ${shipment.parcel.weight}`,
                          `Package: ${shipment.parcel.predefined_package}`,
                          shipment.options.delivery_confirmation === "SIGNATURE"
                            ? "Signature Required"
                            : "No Signature Required",
                        ].join("\n")}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Tooltip title="Edit Shipment" arrow>
                        <IconButton
                          onClick={() => handleOpenEditDrawer(shipment)}
                          color="primary"
                        >
                          <EditIcon />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Download Shipment CSV" arrow>
                        <IconButton
                          onClick={() => handleDownloadShipment(shipment)}
                          color="primary"
                        >
                          <DownloadIcon />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Download Return CSV" arrow>
                        <IconButton
                          onClick={() => handleDownloadReturnShipment(shipment)}
                          color="primary"
                        >
                          <ReplyIcon />
                        </IconButton>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      ) : (
        <Paper
          sx={{ p: 6, textAlign: "center", backgroundColor: "action.hover" }}
          elevation={0}
        >
          <Typography variant="h6" color="text.secondary">
            Upload a TCGPlayer shipping export CSV to generate EasyPost shipment
            rows.
          </Typography>
          <Typography variant="body2" color="text.disabled" sx={{ mt: 1 }}>
            Uploaded orders stay in the browser. Saved shipping settings are
            managed from Shipping Configuration in the Settings menu.
          </Typography>
        </Paper>
      )}

      <ShipmentEditDrawer
        shipment={selectedShipment}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onSave={handleSaveShipmentChanges}
        onChange={(changes) =>
          setSelectedShipment((previousShipment) =>
            previousShipment ? { ...previousShipment, ...changes } : previousShipment,
          )
        }
      />
    </Box>
  );
}

