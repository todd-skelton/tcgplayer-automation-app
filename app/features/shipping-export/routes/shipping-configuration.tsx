import { Alert, Box, Button, Stack, Typography } from "@mui/material";
import { Link, data, useFetcher, useLoaderData, type ActionFunctionArgs, type MetaFunction } from "react-router";
import { useEffect, useState } from "react";
import { ShippingExportSettingsEditor } from "../components/ShippingExportSettingsEditor";
import {
  getShippingExportConfig,
  resetShippingExportConfig,
  saveShippingExportConfig,
} from "../config/shippingExportConfig.server";
import {
  createShippingExportConfigFormData,
  parseShippingExportConfigFormData,
} from "../config/shippingExportConfigFormData";
import type { ShippingExportConfig } from "../types/shippingExport";

type ActionData = {
  success: boolean;
  message: string;
  config?: ShippingExportConfig;
};

export const meta: MetaFunction = () => {
  return [
    { title: "Shipping Configuration" },
    {
      name: "description",
      content:
        "Manage the saved sender, package, and label settings used by EasyPost shipping exports.",
    },
  ];
};

export async function loader() {
  const config = await getShippingExportConfig();
  return data({ config });
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const actionType = String(formData.get("actionType") ?? "");

  if (actionType === "save") {
    const config = parseShippingExportConfigFormData(formData);
    const savedConfig = await saveShippingExportConfig(config);
    return data<ActionData>({
      success: true,
      message: "Shipping configuration saved.",
      config: savedConfig,
    });
  }

  if (actionType === "reset") {
    const resetConfig = await resetShippingExportConfig();
    return data<ActionData>({
      success: true,
      message: "Shipping configuration reset to defaults.",
      config: resetConfig,
    });
  }

  return data<ActionData>(
    { success: false, message: "Unknown action." },
    { status: 400 },
  );
}

export default function ShippingConfigurationRoute() {
  const { config: initialConfig } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();
  const [config, setConfig] = useState(initialConfig);

  useEffect(() => {
    setConfig(initialConfig);
  }, [initialConfig]);

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data?.success || !fetcher.data.config) {
      return;
    }

    setConfig(fetcher.data.config);
  }, [fetcher.data, fetcher.state]);

  const handleSaveSettings = () => {
    fetcher.submit(createShippingExportConfigFormData(config), {
      method: "post",
    });
  };

  const handleResetSettings = () => {
    const formData = new FormData();
    formData.append("actionType", "reset");
    fetcher.submit(formData, { method: "post" });
  };

  return (
    <Box sx={{ maxWidth: 1000, mx: "auto", p: 3 }}>
      <Typography variant="h4" component="h1" gutterBottom>
        Shipping Configuration
      </Typography>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
        Manage the saved shipping settings used by the EasyPost shipping export
        workflow. Save changes here, then rebuild shipments from the export
        page after uploading a file.
      </Typography>

      <Alert severity="info" sx={{ mb: 3 }}>
        <Stack
          direction={{ xs: "column", md: "row" }}
          spacing={2}
          alignItems={{ md: "center" }}
          justifyContent="space-between"
        >
          <Typography variant="body2">
            These settings are stored on the server and used by the shipping
            export tool when it generates EasyPost shipment rows.
          </Typography>
          <Button component={Link} to="/shipping-export" variant="outlined">
            Open Shipping Export
          </Button>
        </Stack>
      </Alert>

      {fetcher.data?.message && (
        <Alert
          severity={fetcher.data.success ? "success" : "error"}
          sx={{ mb: 3 }}
        >
          {fetcher.data.message}
        </Alert>
      )}

      <ShippingExportSettingsEditor
        config={config}
        onChange={setConfig}
        onSave={handleSaveSettings}
        onReset={handleResetSettings}
        isSubmitting={fetcher.state === "submitting"}
      />
    </Box>
  );
}
