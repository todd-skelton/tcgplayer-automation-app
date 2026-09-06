import { useState } from "react";
import {
  Alert,
  Button,
  Link,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type { GridColDef } from "@mui/x-data-grid";
import { ClientOnlyDataGrid } from "~/features/file-upload/components/ClientOnlyDataGrid";
import type { getInventory } from "../inventory/slabInventory.server";
import type { StoredSlabIdentity } from "../identity/slabIdentity";
import {
  amount,
  slabRequest,
  useSlabAction,
  words,
  type Json,
} from "./slabClient";
export type SlabListing = Json<
  Awaited<ReturnType<typeof getInventory>>
>["items"][number];
export function SlabInventoryPanel({
  onOpen,
}: {
  onOpen: (
    record: Json<StoredSlabIdentity> | null,
    listing: SlabListing,
  ) => void;
}) {
  const [seller, setSeller] = useState("pokebash");
  const [loadedSeller, setLoadedSeller] = useState("");
  const [page, setPage] = useState<Json<
    Awaited<ReturnType<typeof getInventory>>
  > | null>(null);
  const [cursors, setCursors] = useState([""]);
  const [csv, setCsv] = useState("");
  const [importing, setImporting] = useState(false);
  const action = useSlabAction();
  const load = async (name: string, after = "") => {
    const result = await slabRequest<Awaited<ReturnType<typeof getInventory>>>(
      `/api/slab-inventory?${new URLSearchParams({ seller: name, after, limit: "25" })}`,
    );
    setPage(result);
    setLoadedSeller(name);
    return result;
  };
  const open = (row: SlabListing) =>
    void action.run(async () => {
      if (!row.identity && !row.snapshot.certificate) {
        onOpen(null, row);
        return;
      }
      const result = row.identity
        ? await slabRequest<{ record: StoredSlabIdentity }>(
            "/api/slab-identities",
            {
              intent: "lookup",
              grader: row.identity.grader,
              certificateNumber: row.identity.certificateNumber,
            },
          )
        : await slabRequest<{ record: StoredSlabIdentity }>(
            "/api/slab-inventory",
            {
              intent: "resolve-identity",
              seller: loadedSeller,
              id: row.id,
              revision: row.revision,
            },
          );
      const refreshed = await load(loadedSeller, cursors.at(-1));
      onOpen(
        result.record,
        refreshed.items.find((item) => item.id === row.id) ?? row,
      );
    });
  const columns: GridColDef<SlabListing>[] = [
    {
      field: "review",
      headerName: "Review",
      width: 115,
      sortable: false,
      renderCell: ({ row }) => (
        <Button size="small" disabled={action.busy} onClick={() => open(row)}>
          Open slab
        </Button>
      ),
    },
    {
      field: "title",
      headerName: "Listing",
      flex: 1,
      minWidth: 250,
      valueGetter: (_, row) => row.snapshot.title,
      renderCell: ({ row }) => (
        <Link href={row.url} target="_blank" rel="noreferrer">
          {row.snapshot.title}
        </Link>
      ),
    },
    {
      field: "price",
      headerName: "Current ask",
      width: 130,
      valueGetter: (_, row) =>
        amount(row.snapshot.price.amount, row.snapshot.price.currency),
    },
    {
      field: "grade",
      headerName: "Owned grade",
      width: 120,
      valueGetter: (_, row) => {
        const g = (row.identity?.identity ?? row.identity?.candidate?.identity)
          ?.grading;
        return g ? `${g.grader} ${g.encoding}` : "Unresolved";
      },
    },
    { field: "state", headerName: "State", width: 95 },
    {
      field: "reviewReasons",
      headerName: "Needs attention",
      minWidth: 220,
      flex: 1,
      valueGetter: (_, row) => row.reviewReasons.map(words).join("; "),
    },
  ];
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={2}>
        <Typography variant="h6">eBay inventory</Typography>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              await load(seller);
              setCursors([""]);
            });
          }}
        >
          <Stack direction="row" gap={2}>
            <TextField
              label="Seller username"
              size="small"
              required
              value={seller}
              onChange={(e) => setSeller(e.target.value)}
            />
            <Button type="submit" disabled={action.busy}>
              Open inventory
            </Button>
            <Button
              disabled={!page || action.busy}
              onClick={() => setImporting(!importing)}
            >
              Import CSV
            </Button>
          </Stack>
        </form>
        {action.error && <Alert severity="error">{action.error}</Alert>}
        {importing && (
          <Stack spacing={2}>
            <Typography variant="body2">
              Import a partial inventory snapshot for {loadedSeller}. Required
              columns: item_id, title, price, currency, quantity, state, format.
              Add grader and certificate_number for certificate lookup. Existing
              rows are matched by item_id and variation_key.
            </Typography>
            <Button component="label">
              Choose CSV
              <input
                hidden
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file)
                    void action.run(async () => {
                      if (file.size > 2 * 1024 * 1024)
                        throw new Error("CSV must be at most 2 MiB.");
                      setCsv(await file.text());
                    });
                }}
              />
            </Button>
            <TextField
              multiline
              minRows={3}
              maxRows={8}
              label="Inventory CSV"
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
            />
            <Button
              disabled={action.busy || !csv.trim()}
              onClick={() =>
                void action.run(async () => {
                  await slabRequest("/api/slab-inventory", {
                    intent: "import-csv",
                    seller: loadedSeller,
                    revision: page?.revision,
                    csv,
                  });
                  await load(loadedSeller);
                  setCursors([""]);
                  setImporting(false);
                  setCsv("");
                })
              }
            >
              Import into {loadedSeller}
            </Button>
          </Stack>
        )}
        {page && (
          <>
            <Typography variant="body2">
              {loadedSeller} · Saved inventory · Page {cursors.length}. Open a
              slab to review or assign its certificate.
            </Typography>
            <div style={{ height: 440 }}>
              <ClientOnlyDataGrid
                rows={page.items}
                columns={columns}
                loading={action.busy}
                hideFooter
                disableRowSelectionOnClick
              />
            </div>
            <Stack direction="row" spacing={2}>
              <Button
                disabled={action.busy || cursors.length < 2}
                onClick={() =>
                  void action.run(async () => {
                    const next = cursors.slice(0, -1);
                    await load(loadedSeller, next.at(-1));
                    setCursors(next);
                  })
                }
              >
                Previous page
              </Button>
              <Button
                disabled={action.busy || !page.next}
                onClick={() =>
                  void action.run(async () => {
                    const next = page.next!;
                    await load(loadedSeller, next);
                    setCursors([...cursors, next]);
                  })
                }
              >
                Next page
              </Button>
            </Stack>
          </>
        )}
      </Stack>
    </Paper>
  );
}
