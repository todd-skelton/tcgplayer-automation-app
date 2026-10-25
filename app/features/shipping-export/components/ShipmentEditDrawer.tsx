import {
  Button,
  Container,
  Divider,
  Drawer,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type { EasyPostShipment } from "../types/shippingExport";
import { ShipmentAddressFields, ShipmentPackageFields } from "./ShipmentFields";

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
          <ShipmentAddressFields
            address={shipment.to_address}
            onChange={(to_address) => onChange({ to_address })}
          />

          <Divider />
          <Typography variant="subtitle2">Shipment Details</Typography>
          <TextField
            label="Reference"
            value={shipment.reference}
            onChange={(event) => onChange({ reference: event.target.value })}
          />
          <ShipmentPackageFields
            shipment={shipment}
            onChange={onChange}
            onServiceChange={(service) => onChange({ service })}
          />
          <Button variant="contained" onClick={onSave}>
            Save Shipment Changes
          </Button>
        </Stack>
      </Container>
    </Drawer>
  );
}
