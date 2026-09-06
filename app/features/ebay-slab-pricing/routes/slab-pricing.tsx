import { useState } from "react";
import {
  Alert,
  Button,
  Container,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type { StoredSlabIdentity } from "../identity/slabIdentity";
import { SlabIdentityEditor } from "../components/SlabIdentityEditor";
import {
  SlabInventoryPanel,
  type SlabListing,
} from "../components/SlabInventoryPanel";
import { SlabResearchPanel } from "../components/SlabResearchPanel";
import {
  slabRequest,
  useSlabAction,
  type Json,
} from "../components/slabClient";
export default function SlabPricing() {
  const [grader, setGrader] = useState("PSA");
  const [cert, setCert] = useState("");
  const [record, setRecord] = useState<Json<StoredSlabIdentity> | null>(null);
  const [listing, setListing] = useState<SlabListing | null>(null);
  const [assignmentNote, setAssignmentNote] = useState("");
  const action = useSlabAction();
  return (
    <Container maxWidth="xl" sx={{ py: 3 }}>
      <Stack spacing={3}>
        <div>
          <Typography variant="h4">Slab Pricing</Typography>
          <Typography color="text.secondary">
            Review sold evidence and set a considered ask for your graded cards.
          </Typography>
        </div>
        <Paper variant="outlined" sx={{ p: 2 }}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action.run(async () => {
                const result = await slabRequest<{
                  record: StoredSlabIdentity;
                }>("/api/slab-identities", {
                  intent: "lookup",
                  grader,
                  certificateNumber: cert,
                });
                setRecord(result.record);
              });
            }}
          >
            <Stack direction="row" useFlexGap flexWrap="wrap" gap={2}>
              <TextField
                label="Grader"
                required
                size="small"
                value={grader}
                inputProps={{ maxLength: 40 }}
                onChange={(e) => setGrader(e.target.value)}
              />
              <TextField
                label="Certificate number"
                required
                size="small"
                value={cert}
                inputProps={{ maxLength: 80 }}
                onChange={(e) => setCert(e.target.value)}
              />
              <Button type="submit" variant="contained" disabled={action.busy}>
                Look up certificate
              </Button>
            </Stack>
          </form>
          {action.error && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {action.error}
            </Alert>
          )}
        </Paper>
        {listing && (
          <Paper variant="outlined" sx={{ p: 2 }}>
            <Stack spacing={2}>
              <Typography>
                Selected listing: {listing.snapshot.title}
              </Typography>
              <Typography variant="body2">
                {listing.reviewReasons.join("; ")}. Look up and confirm a
                certificate to correct this listing's identity.
              </Typography>
              <Stack direction="row" gap={2}>
                <Button onClick={() => setListing(null)}>
                  Research certificate separately
                </Button>
                {record?.status === "confirmed" &&
                  listing.identityId !== record.id && (
                    <>
                      <TextField
                        label="Listing identity correction reason"
                        size="small"
                        value={assignmentNote}
                        inputProps={{ maxLength: 1000 }}
                        onChange={(e) => setAssignmentNote(e.target.value)}
                      />
                      <Button
                        disabled={action.busy || !assignmentNote.trim()}
                        onClick={() =>
                          void action.run(async () => {
                            await slabRequest("/api/slab-inventory", {
                              intent: "assign-identity",
                              seller: listing.seller,
                              id: listing.id,
                              revision: listing.revision,
                              identityId: record.id,
                              note: assignmentNote,
                            });
                            setListing((current) =>
                              current?.id === listing.id &&
                              current.revision === listing.revision
                                ? {
                                    ...listing,
                                    revision: listing.revision + 1,
                                    identityId: record.id,
                                    identity: record,
                                    identitySource: "manual",
                                    identityNote: assignmentNote,
                                  }
                                : current,
                            );
                            setAssignmentNote("");
                          })
                        }
                      >
                        Assign confirmed identity
                      </Button>
                    </>
                  )}
              </Stack>
            </Stack>
          </Paper>
        )}
        {record && (
          <>
            <SlabIdentityEditor
              key={`${record.id}:${record.revision}`}
              record={record}
              onSaved={(saved) =>
                setRecord((current) =>
                  current?.id === saved.id ? saved : current,
                )
              }
            />
            {(record.identity ?? record.candidate?.identity) && (
              <SlabResearchPanel
                key={`${record.id}:${listing?.id ?? "certificate"}`}
                record={record}
                listing={listing}
              />
            )}
          </>
        )}
        <SlabInventoryPanel
          onOpen={(record, listing) => {
            setRecord(record);
            setListing(listing);
          }}
        />
      </Stack>
    </Container>
  );
}
