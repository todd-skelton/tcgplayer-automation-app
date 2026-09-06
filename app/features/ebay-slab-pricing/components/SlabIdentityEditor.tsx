import { useState } from "react";
import {
  Alert,
  Button,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import {
  CARD_FIELDS,
  type SlabIdentity,
  type StoredSlabIdentity,
} from "../identity/slabIdentity";
import { slabRequest, useSlabAction, words, type Json } from "./slabClient";

export function SlabIdentityEditor({
  record,
  onSaved,
}: {
  record: Json<StoredSlabIdentity>;
  onSaved: (record: Json<StoredSlabIdentity>) => void;
}) {
  const source = record.identity ?? record.candidate?.identity;
  const [draft, setDraft] = useState<SlabIdentity>(
    () =>
      source ?? {
        card: Object.fromEntries(
          CARD_FIELDS.map((k) => [k, null]),
        ) as SlabIdentity["card"],
        grading: {
          grader: record.grader,
          encoding: "",
          number: null,
          label: null,
          qualifier: null,
          autograph: null,
        },
        providerAsset: null,
      },
  );
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState(false);
  const action = useSlabAction();
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={2}>
        <Typography variant="h6">
          {source?.card.name ?? "Card identity"} · Owned {record.grader}{" "}
          {source?.grading.encoding ?? "grade unknown"}
        </Typography>
        <Typography variant="body2">
          Certificate {record.certificateNumber} · {words(record.status)} ·
          Revision {record.revision}
        </Typography>
        <Typography variant="body2">
          {source &&
            [
              source.card.year,
              source.card.set,
              source.card.cardNumber,
              source.card.finish,
              source.card.language,
            ]
              .filter(Boolean)
              .join(" · ")}
        </Typography>
        {record.reviewReasons.length > 0 && (
          <Alert severity="warning">
            {record.reviewReasons.map(words).join("; ")}
          </Alert>
        )}
        {!editing ? (
          <Button sx={{ alignSelf: "start" }} onClick={() => setEditing(true)}>
            Confirm or correct identity
          </Button>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void action.run(async () => {
                const result = await slabRequest<{
                  record: StoredSlabIdentity;
                }>("/api/slab-identities", {
                  intent: "confirm",
                  grader: record.grader,
                  certificateNumber: record.certificateNumber,
                  revision: record.revision,
                  identity: draft,
                  note,
                });
                onSaved(result.record);
              });
            }}
          >
            <Stack spacing={2}>
              <Typography variant="body2">
                Confirm the physical slab’s card and grade. Blank fields remain
                unknown.
              </Typography>
              <Stack direction="row" useFlexGap flexWrap="wrap" gap={2}>
                {CARD_FIELDS.map((field) => (
                  <TextField
                    key={field}
                    label={words(
                      field === "cardNumber" ? "card number" : field,
                    )}
                    size="small"
                    value={draft.card[field] ?? ""}
                    required={field === "name"}
                    inputProps={{ maxLength: 200 }}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        card: {
                          ...draft.card,
                          [field]: event.target.value || null,
                        },
                      })
                    }
                  />
                ))}
              </Stack>
              <Stack direction="row" useFlexGap flexWrap="wrap" gap={2}>
                <TextField
                  label="Original grade encoding"
                  size="small"
                  required
                  value={draft.grading.encoding}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      grading: { ...draft.grading, encoding: e.target.value },
                    })
                  }
                />
                <TextField
                  label="Numeric grade"
                  size="small"
                  select
                  value={draft.grading.number ?? ""}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      grading: {
                        ...draft.grading,
                        number:
                          e.target.value === "" ? null : Number(e.target.value),
                      },
                    })
                  }
                >
                  <MenuItem value="">Unmapped</MenuItem>
                  {Array.from({ length: 19 }, (_, i) => 1 + i / 2).map((n) => (
                    <MenuItem key={n} value={n}>
                      {n}
                    </MenuItem>
                  ))}
                </TextField>
                {(["label", "qualifier", "autograph"] as const).map((field) => (
                  <TextField
                    key={field}
                    label={words(field)}
                    size="small"
                    value={draft.grading[field] ?? ""}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        grading: {
                          ...draft.grading,
                          [field]: e.target.value || null,
                        },
                      })
                    }
                  />
                ))}
              </Stack>
              <TextField
                label="Reason for confirmation or correction"
                required
                value={note}
                inputProps={{ maxLength: 1000 }}
                onChange={(e) => setNote(e.target.value)}
              />
              {action.error && <Alert severity="error">{action.error}</Alert>}
              <Button
                variant="contained"
                type="submit"
                disabled={action.busy || !note.trim()}
                sx={{ alignSelf: "start" }}
              >
                Confirm owned identity
              </Button>
            </Stack>
          </form>
        )}
      </Stack>
    </Paper>
  );
}
