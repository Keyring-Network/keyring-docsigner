# Shareholder Resolution Signing — Overview

## What it does and why

Standard electronic signature tools (including vanilla OpenSign) model a document as "complete when every named signer has signed". That model is insufficient for shareholder resolutions, which are governed by corporate bylaws and securities regulations that require **weighted voting thresholds**:

- A resolution may pass only when shareholders holding a minimum percentage of total votes have signed.
- Governance rules often require a second, separate majority: a quorum of independent shareholders, excluding any dominant controlling shareholder, must also approve.

This system extends OpenSign to support exactly those semantics. Instead of "all signed", execution fires when two configurable weighted thresholds — Group A (total vote weight) and Group B (independent-shareholder vote weight) — are both met.

## How it differs from standard OpenSign

| Aspect | Standard OpenSign | Resolution signing |
|--------|------------------|--------------------|
| Completion trigger | All signers have signed | Both Group A and Group B weighted thresholds met |
| Signer roles | Named recipients, equal standing | Each signer carries a numeric weight; one may be excluded from Group B |
| Configuration | None beyond signers and field positions | Per-document threshold percentages and per-signer weight records |
| Execution | Document marked complete, PDF emailed | `executeDocument()` stamps the PDF, sets `executedAt`, emails all parties |
| Dashboard | Basic status | Group A / Group B progress bars + status badge (DRAFT / ACTIVE / EXECUTED) |
| Field types | signature, name, date, etc. | All existing types plus the new `weight factor` labelled text field |

The signing page itself (where signers click to sign) is unchanged. The extensions are entirely in the admin configuration panel, the backend threshold logic, and the dashboard progress display.

## Architecture

```
Admin
  |
  v
[1] Upload PDF
       | (existing OpenSign upload)
  v
[2] Place field boxes on PDF pages
       | drag-and-drop editor; add "weight factor" fields alongside signatures
  v
[3] Configure thresholds (ResolutionThresholdConfig panel)
       | importResolutionSchema Cloud Function
       | writes resolutions_Threshold (DRAFT) + resolutions_SignerWeight records
  v
[4] Admin approves
       | approveForSigning Cloud Function
       | sets threshold status -> ACTIVE
       | sends invite emails to all signers
  v
[5] Signers receive email links and sign
       | existing OpenSign signing page
       | each signing event appended to contracts_Document.AuditTrail
  v
[6] afterSave hook fires on contracts_Document
       | detects new AuditTrail entry with Activity: 'Signed'
       | calls checkThresholds(documentId)
       |
       +--[thresholds not yet met]--> wait for next signature
       |
       +--[both thresholds met]----> executeDocument(documentId)
  v
[7] executeDocument
       | sets threshold status -> EXECUTED
       | stamps executedAt on contracts_Document
       | emails all signers and document owner
  v
[8] Dashboard shows EXECUTED badge; progress bars at 100%
```

## Data model

Two Parse classes are added alongside the existing `contracts_Document`:

**`resolutions_Threshold`**

| Field | Type | Description |
|-------|------|-------------|
| `document` | Pointer → `contracts_Document` | The document this config belongs to |
| `thresholdA` | Number | Fraction required for Group A (e.g. `0.75`) |
| `thresholdB` | Number | Fraction required for Group B (e.g. `0.50`) |
| `status` | String | `DRAFT` \| `PENDING_APPROVAL` \| `ACTIVE` \| `EXECUTED` \| `CANCELLED` |

**`resolutions_SignerWeight`**

| Field | Type | Description |
|-------|------|-------------|
| `document` | Pointer → `contracts_Document` | Parent document |
| `signerEmail` | String | Signer's email address (lowercase) |
| `weightGroupA` | Number | Numeric weight in the Group A calculation |
| `weightGroupB` | Number | Numeric weight in the Group B calculation |
| `excludedFromB` | Boolean | If true, this signer does not count towards Group B totals |
