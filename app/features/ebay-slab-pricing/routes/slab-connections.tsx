import { useEffect, useRef } from "react";
import {
  Alert,
  Box,
  Button,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { data, useFetcher, useLoaderData } from "react-router";
import { getProviderConnections } from "../connections/providerConnections.server";
import { createProviderConnectionsAction } from "../connections/providerConnectionsAction.server";
import {
  CONNECTION_MESSAGES,
  type ProviderConnectionStatus,
} from "../connections/providerConnection";

export async function loader() {
  return data(
    { connections: await getProviderConnections() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
export const action = createProviderConnectionsAction();

function ConnectionForm({
  connection,
}: {
  connection: ProviderConnectionStatus;
}) {
  const fetcher = useFetcher<typeof action>();
  const form = useRef<HTMLFormElement>(null);
  const isAlt = connection.provider === "alt";
  const pending = fetcher.state !== "idle";
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) form.current?.reset();
  }, [fetcher.state, fetcher.data]);
  return (
    <Paper sx={{ p: 3 }}>
      <Stack spacing={2}>
        <Typography variant="h6">
          {isAlt ? "Alt" : "eBay Product Research"}
        </Typography>
        <Typography>
          {connection.configured
            ? CONNECTION_MESSAGES[connection.status]
            : CONNECTION_MESSAGES["not-configured"]}
        </Typography>
        {connection.checkedAt && (
          <Typography variant="body2" color="text.secondary">
            Last check: {new Date(connection.checkedAt).toISOString()}
          </Typography>
        )}
        <Typography variant="body2" color="text.secondary">
          {isAlt
            ? "Use the authorization token from your signed-in Alt session."
            : "Use the Cookie header and User-Agent from your signed-in eBay Research session. Developer API keys do not grant this access."}{" "}
          Saved credentials are never displayed. Replace them after signing in
          again if access expires.
        </Typography>
        <fetcher.Form method="post" ref={form} autoComplete="off">
          <input type="hidden" name="provider" value={connection.provider} />
          <Stack spacing={2}>
            <TextField
              name="credential"
              type="password"
              label={
                isAlt
                  ? "Alt authorization token"
                  : "eBay research Cookie header"
              }
              autoComplete="new-password"
              fullWidth
              inputProps={{ maxLength: 32768 }}
            />
            {!isAlt && (
              <TextField
                name="userAgent"
                label="Browser User-Agent"
                fullWidth
                inputProps={{ maxLength: 512 }}
              />
            )}
            <Stack direction="row" spacing={1}>
              <Button
                type="submit"
                name="intent"
                value="save"
                variant="contained"
                disabled={pending}
              >
                Save connection
              </Button>
              <Button
                type="submit"
                name="intent"
                value="check"
                disabled={pending || !connection.configured}
              >
                Check access
              </Button>
              <Button
                type="submit"
                name="intent"
                value="clear"
                disabled={pending || !connection.configured}
              >
                Remove
              </Button>
            </Stack>
          </Stack>
        </fetcher.Form>
        {fetcher.data && (
          <Alert severity={fetcher.data.ok ? "success" : "warning"}>
            {fetcher.data.message}
          </Alert>
        )}
      </Stack>
    </Paper>
  );
}

export default function SlabConnections() {
  const { connections } = useLoaderData<typeof loader>();
  return (
    <Box sx={{ maxWidth: 850, mx: "auto", p: 3 }}>
      <Stack spacing={3}>
        <Typography variant="h4">Slab data connections</Typography>
        <Typography>
          Connect the sources used to research graded cards. Checking access
          only reads data.
        </Typography>
        {connections.map((connection) => (
          <ConnectionForm key={connection.provider} connection={connection} />
        ))}
      </Stack>
    </Box>
  );
}
