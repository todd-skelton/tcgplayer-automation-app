import SaveIcon from "@mui/icons-material/Save";
import {
  Box,
  Button,
  Divider,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import type {
  EasyPostService,
  LabelFormat,
  LabelSize,
  ShippingExportConfig,
  ShippingPackageSettings,
} from "../types/shippingExport";

function PackageSettingsEditor({
  sectionKey,
  settings,
  onChange,
  showThresholdFields = false,
}: {
  sectionKey: string;
  settings: ShippingPackageSettings;
  onChange: (settings: ShippingPackageSettings) => void;
  showThresholdFields?: boolean;
}) {
  const idPrefix = `${sectionKey}-settings`;

  return (
    <Stack spacing={2}>
      <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
        <FormControl fullWidth>
          <InputLabel id={`${idPrefix}-label-size-label`}>Label Size</InputLabel>
          <Select
            labelId={`${idPrefix}-label-size-label`}
            label="Label Size"
            value={settings.labelSize}
            onChange={(event) =>
              onChange({
                ...settings,
                labelSize: event.target.value as LabelSize,
              })
            }
          >
            <MenuItem value="4x6">4x6</MenuItem>
            <MenuItem value="7x3">7x3</MenuItem>
            <MenuItem value="6x4">6x4</MenuItem>
          </Select>
        </FormControl>
        <TextField
          label="Base Weight (oz)"
          type="number"
          value={settings.baseWeightOz}
          onChange={(event) =>
            onChange({
              ...settings,
              baseWeightOz: Number(event.target.value),
            })
          }
          fullWidth
        />
        <TextField
          label="Per Item Weight (oz)"
          type="number"
          value={settings.perItemWeightOz}
          onChange={(event) =>
            onChange({
              ...settings,
              perItemWeightOz: Number(event.target.value),
            })
          }
          fullWidth
        />
      </Stack>

      {showThresholdFields && (
        <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
          <TextField
            label="Max Item Count"
            type="number"
            value={settings.maxItemCount ?? 0}
            onChange={(event) =>
              onChange({
                ...settings,
                maxItemCount: Number(event.target.value),
              })
            }
            fullWidth
          />
          <TextField
            label="Max Value (USD)"
            type="number"
            value={settings.maxValueUsd ?? 0}
            onChange={(event) =>
              onChange({
                ...settings,
                maxValueUsd: Number(event.target.value),
              })
            }
            fullWidth
          />
        </Stack>
      )}

      <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
        <TextField
          label="Length (in)"
          type="number"
          value={settings.lengthIn}
          onChange={(event) =>
            onChange({
              ...settings,
              lengthIn: Number(event.target.value),
            })
          }
          fullWidth
        />
        <TextField
          label="Width (in)"
          type="number"
          value={settings.widthIn}
          onChange={(event) =>
            onChange({
              ...settings,
              widthIn: Number(event.target.value),
            })
          }
          fullWidth
        />
        <TextField
          label="Height (in)"
          type="number"
          value={settings.heightIn}
          onChange={(event) =>
            onChange({
              ...settings,
              heightIn: Number(event.target.value),
            })
          }
          fullWidth
        />
      </Stack>
    </Stack>
  );
}

export function ShippingExportSettingsEditor({
  config,
  onChange,
  onSave,
  onReset,
  isSubmitting = false,
}: {
  config: ShippingExportConfig;
  onChange: (config: ShippingExportConfig) => void;
  onSave: () => void;
  onReset: () => void;
  isSubmitting?: boolean;
}) {
  const setConfigValue = <
    TKey extends keyof ShippingExportConfig,
    TValue extends ShippingExportConfig[TKey],
  >(
    key: TKey,
    value: TValue,
  ) => {
    onChange({
      ...config,
      [key]: value,
    });
  };

  return (
    <Paper sx={{ p: 3 }} elevation={3}>
      <Stack spacing={3}>
        <Stack
          direction={{ xs: "column", md: "row" }}
          spacing={2}
          justifyContent="space-between"
          alignItems={{ md: "center" }}
        >
          <Box>
            <Typography variant="h6">Shipping Configuration</Typography>
            <Typography variant="body2" color="text.secondary">
              Sender details, package thresholds, and label defaults used to
              build EasyPost shipment rows.
            </Typography>
          </Box>
          <Stack direction="row" spacing={1}>
            <Button
              variant="outlined"
              color="secondary"
              onClick={onReset}
              disabled={isSubmitting}
            >
              Reset Defaults
            </Button>
            <Button
              variant="contained"
              startIcon={<SaveIcon />}
              onClick={onSave}
              disabled={isSubmitting}
            >
              Save Settings
            </Button>
          </Stack>
        </Stack>

        <Divider />
        <Typography variant="subtitle1">From Address</Typography>
        <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
          <TextField
            label="Sender"
            value={config.fromAddress.name}
            onChange={(event) =>
              setConfigValue("fromAddress", {
                ...config.fromAddress,
                name: event.target.value,
              })
            }
            fullWidth
          />
          <TextField
            label="Company"
            value={config.fromAddress.company ?? ""}
            onChange={(event) =>
              setConfigValue("fromAddress", {
                ...config.fromAddress,
                company: event.target.value || undefined,
              })
            }
            fullWidth
          />
        </Stack>
        <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
          <TextField
            label="Phone"
            value={config.fromAddress.phone ?? ""}
            onChange={(event) =>
              setConfigValue("fromAddress", {
                ...config.fromAddress,
                phone: event.target.value || undefined,
              })
            }
            fullWidth
          />
          <TextField
            label="Email"
            value={config.fromAddress.email ?? ""}
            onChange={(event) =>
              setConfigValue("fromAddress", {
                ...config.fromAddress,
                email: event.target.value || undefined,
              })
            }
            fullWidth
          />
        </Stack>
        <TextField
          label="Street 1"
          value={config.fromAddress.street1}
          onChange={(event) =>
            setConfigValue("fromAddress", {
              ...config.fromAddress,
              street1: event.target.value,
            })
          }
          fullWidth
        />
        <TextField
          label="Street 2"
          value={config.fromAddress.street2 ?? ""}
          onChange={(event) =>
            setConfigValue("fromAddress", {
              ...config.fromAddress,
              street2: event.target.value || undefined,
            })
          }
          fullWidth
        />
        <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
          <TextField
            label="City"
            value={config.fromAddress.city}
            onChange={(event) =>
              setConfigValue("fromAddress", {
                ...config.fromAddress,
                city: event.target.value,
              })
            }
            fullWidth
          />
          <TextField
            label="State"
            value={config.fromAddress.state}
            onChange={(event) =>
              setConfigValue("fromAddress", {
                ...config.fromAddress,
                state: event.target.value,
              })
            }
            fullWidth
          />
          <TextField
            label="Zip"
            value={config.fromAddress.zip}
            onChange={(event) =>
              setConfigValue("fromAddress", {
                ...config.fromAddress,
                zip: event.target.value,
              })
            }
            fullWidth
          />
          <TextField
            label="Country"
            value={config.fromAddress.country}
            onChange={(event) =>
              setConfigValue("fromAddress", {
                ...config.fromAddress,
                country: event.target.value,
              })
            }
            fullWidth
          />
        </Stack>

        <Divider />
        <Typography variant="subtitle1">Letter Settings</Typography>
        <PackageSettingsEditor
          sectionKey="letter"
          settings={config.letter}
          onChange={(nextSettings) => setConfigValue("letter", nextSettings)}
          showThresholdFields
        />

        <Typography variant="subtitle1">Flat Settings</Typography>
        <PackageSettingsEditor
          sectionKey="flat"
          settings={config.flat}
          onChange={(nextSettings) => setConfigValue("flat", nextSettings)}
          showThresholdFields
        />

        <Typography variant="subtitle1">Parcel Settings</Typography>
        <PackageSettingsEditor
          sectionKey="parcel"
          settings={config.parcel}
          onChange={(nextSettings) => setConfigValue("parcel", nextSettings)}
        />

        <Divider />
        <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
          <FormControl fullWidth>
            <InputLabel id="label-format-label">Label Format</InputLabel>
            <Select
              labelId="label-format-label"
              label="Label Format"
              value={config.labelFormat}
              onChange={(event) =>
                setConfigValue("labelFormat", event.target.value as LabelFormat)
              }
            >
              <MenuItem value="PDF">PDF</MenuItem>
              <MenuItem value="PNG">PNG</MenuItem>
            </Select>
          </FormControl>
          <FormControl fullWidth>
            <InputLabel id="expedited-service-label">
              Expedited Service
            </InputLabel>
            <Select
              labelId="expedited-service-label"
              label="Expedited Service"
              value={config.expeditedService}
              onChange={(event) =>
                setConfigValue(
                  "expeditedService",
                  event.target.value as EasyPostService,
                )
              }
            >
              <MenuItem value="GroundAdvantage">Ground Advantage</MenuItem>
              <MenuItem value="Priority">Priority</MenuItem>
              <MenuItem value="Express">Express</MenuItem>
            </Select>
          </FormControl>
        </Stack>
        <FormControlLabel
          control={
            <Switch
              checked={config.combineOrders}
              onChange={(event) =>
                setConfigValue("combineOrders", event.target.checked)
              }
            />
          }
          label="Combine same-address orders into one shipment"
        />
      </Stack>
    </Paper>
  );
}
