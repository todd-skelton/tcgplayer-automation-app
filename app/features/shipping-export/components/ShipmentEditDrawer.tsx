import {
  Button,
  Container,
  Divider,
  Drawer,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type {
  EasyPostService,
  EasyPostShipment,
  LabelFormat,
  LabelSize,
} from "../types/shippingExport";

export function ShipmentEditDrawer({
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
            <InputLabel id="shipment-label-format-label">
              Label Format
            </InputLabel>
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
