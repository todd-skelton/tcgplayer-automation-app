import {
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
} from "@mui/material";
import type {
  EasyPostAddress,
  EasyPostParcel,
  EasyPostService,
  EasyPostShipment,
  LabelFormat,
  LabelSize,
} from "../types/shippingExport";

export function ShipmentAddressFields({
  address,
  onChange,
}: {
  address: EasyPostAddress;
  onChange: (address: EasyPostAddress) => void;
}) {
  const change = (changes: Partial<EasyPostAddress>) => onChange({ ...address, ...changes });

  return (
    <>
      <TextField
        label="Name"
        value={address.name}
        onChange={(event) => change({ name: event.target.value })}
      />
      <TextField
        label="Street 1"
        value={address.street1}
        onChange={(event) => change({ street1: event.target.value })}
      />
      <TextField
        label="Street 2"
        value={address.street2 ?? ""}
        onChange={(event) => change({ street2: event.target.value || undefined })}
      />
      <TextField
        label="City"
        value={address.city}
        onChange={(event) => change({ city: event.target.value })}
      />
      <Stack direction="row" spacing={2}>
        <TextField
          label="State"
          value={address.state}
          onChange={(event) => change({ state: event.target.value })}
          fullWidth
        />
        <TextField
          label="Zip"
          value={address.zip}
          onChange={(event) => change({ zip: event.target.value })}
          fullWidth
        />
      </Stack>
    </>
  );
}

/** Service, parcel size and weight, and label options of a shipment. */
export function ShipmentPackageFields({
  shipment,
  onChange,
  onServiceChange,
}: {
  shipment: EasyPostShipment;
  onChange: (changes: Partial<EasyPostShipment>) => void;
  onServiceChange: (service: EasyPostService) => void;
}) {
  const changeParcel = (changes: Partial<EasyPostParcel>) =>
    onChange({ parcel: { ...shipment.parcel, ...changes } });
  const changeOptions = (changes: Partial<EasyPostShipment["options"]>) =>
    onChange({ options: { ...shipment.options, ...changes } });

  return (
    <>
      <FormControl fullWidth>
        <InputLabel id="shipment-service-label">Service</InputLabel>
        <Select
          labelId="shipment-service-label"
          label="Service"
          value={shipment.service}
          onChange={(event) => onServiceChange(event.target.value as EasyPostService)}
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
          onChange={(event) => changeParcel({ length: Number(event.target.value) })}
          fullWidth
        />
        <TextField
          label="Width (in)"
          type="number"
          value={shipment.parcel.width}
          onChange={(event) => changeParcel({ width: Number(event.target.value) })}
          fullWidth
        />
      </Stack>
      <Stack direction="row" spacing={2}>
        <TextField
          label="Height (in)"
          type="number"
          value={shipment.parcel.height}
          onChange={(event) => changeParcel({ height: Number(event.target.value) })}
          fullWidth
        />
        <TextField
          label="Weight (oz)"
          type="number"
          value={shipment.parcel.weight}
          onChange={(event) => changeParcel({ weight: Number(event.target.value) })}
          fullWidth
        />
      </Stack>
      <FormControl fullWidth>
        <InputLabel id="shipment-label-format-label">Label Format</InputLabel>
        <Select
          labelId="shipment-label-format-label"
          label="Label Format"
          value={shipment.options.label_format}
          onChange={(event) => changeOptions({ label_format: event.target.value as LabelFormat })}
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
          onChange={(event) => changeOptions({ label_size: event.target.value as LabelSize })}
        >
          <MenuItem value="4x6">4x6</MenuItem>
          <MenuItem value="7x3">7x3</MenuItem>
          <MenuItem value="6x4">6x4</MenuItem>
        </Select>
      </FormControl>
    </>
  );
}
