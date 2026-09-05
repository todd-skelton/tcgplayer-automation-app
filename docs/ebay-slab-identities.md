# Slab identities

The identity slice distinguishes a physical slab (`grader` + `certificateNumber`), a provider's card/variant asset, and a valuation group. eBay listing IDs and seller SKUs belong to the later inventory slice; they are not certificate or card IDs. Migration 025 adds one table with a unique physical-item key and versioned identity decisions.

Alt's `Cert` operation supplies a candidate, never a confirmed inventory identity. The included market-only fixture for certificate `110185364` resolves PSA 1 and asset `20c46c8c-4290-4953-b76f-5892bb442f87`. Its separate research page selection of PSA 10 does not enter this path. A live read through the configured host transport reproduced that result on September 5, 2026.

Known fields are preserved; unknown language, edition and stamp stay null. Alt's variety is assigned to edition/finish only for exact known values, without title guessing. The original provider title, asset ID, certificate grade encoding and candidate remain stored when a user confirms or corrects an identity. Numeric PSA grades follow the [PSA scale](https://www.psacard.com/gradingstandards), excluding 9.5. CGC/BGS provider encodings are not converted to numeric grades automatically. In particular, CGC 0.0/10.5 remain unresolved, and [CGC's distinct Gem Mint and Pristine 10 labels](https://www.cgccards.com/card-grading/grading-scale/) require an explicit label decision. A manual numeric grade and exact label can be recorded without rewriting the original candidate.

## Use-case contract

`slabIdentityService.lookup({ grader, certificateNumber }, { expected?, refresh?, signal? })` returns `{ record, reviewReasons }`. First lookup stores the candidate (including not-found); repeated lookup reads PostgreSQL. Explicit refresh retries an unconfirmed candidate. Confirmed decisions are never silently refreshed from a provider. Inventory expectations can include card fields plus gradeNumber, gradeLabel, qualifier and autograph. A mismatch is returned even when the stored identity is confirmed; callers must check `reviewReasons` before using it for that inventory row.

`slabIdentityService.confirm(certificate, revision, identity, note)` records explicit confirmation or correction. It requires the known grader, an exact grade label and a decision note. Unknown card fields can remain null. Confirmation is not proof that enough evidence exists to price the group. A stale revision produces a conflict rather than overwriting another decision.

Both operations are exposed by same-origin `POST /api/slab-identities`, using JSON with `intent: "lookup"` or `intent: "confirm"`, `grader`, `certificateNumber`, and the operation's remaining fields. Lookup takes `expected` and `refresh`; confirmation takes `revision`, `identity`, and `note`. The review UI is tracked separately in #28.

Valuation groups hash ordered card fields, provider asset reference, grader, resolved grade/label, qualifiers and autograph. Certificates are excluded so identical slabs share evidence. Unknown fields remain distinct from specified fields. Every decision advances `revision`; later recommendations must store `{ slabId, revision, valuationGroupKey }` and use `isCurrentIdentity` before displaying them as current or publishing. Corrections therefore invalidate older references, including a correction that later returns to the original group. No unused recommendation table is introduced here.

## Verification

`npm test` covers the certificate fixture, unsupported grade encodings, label distinctions, inventory mismatches, manual fallback, confirmed-cache reuse, stale decisions, API validation and correction invalidation.

Run the optional PostgreSQL test with:

```sh
npx tsx app/features/ebay-slab-pricing/identity/slabIdentity.integration.test.ts
```

It uses a disposable schema in the local development database and verifies concurrent duplicate imports, grader collisions, competing corrections, confirmed mapping reuse, original provenance retention and stale-provider fencing. It makes no network requests and uses no real session credentials.
