# Admin Guide

This guide covers the end-to-end admin workflow for creating, configuring, and approving a shareholder resolution document.

## Prerequisites

- An admin account (member of the `admin` Parse role, or access to the master key for programmatic use).
- A PDF of the resolution document, ready to upload.
- The signer list with email addresses and their respective share counts or voting weights.

---

## Step 1: Upload the PDF

1. Log into the OpenSign application.
2. Navigate to **Documents** and click **New Document**.
3. Upload the resolution PDF using the file picker.
4. Set the document name, expiry period, and any other standard metadata.

This creates a `contracts_Document` record in Draft state. The document is not yet sent to any signers.

---

## Step 2: Place field boxes on the PDF

1. After upload, the field placement editor opens automatically.
2. For each signer, drag the required fields from the left panel onto the appropriate pages of the PDF:

   - **signature** — the signer's drawn or typed signature
   - **date** — auto-filled with the signing date
   - **name** — auto-filled from the signer's profile
   - **weight factor** — a labelled text box the signer fills in (e.g., "Shares Held: 1,500,000")

3. For `weight factor` fields, set a descriptive label (e.g., "Shares Held") that will appear above the input box on the signing page.

4. Place fields for all signers before saving. The field positions are stored on `contracts_Document.Placeholders`.

See [field-types.md](./field-types.md) for a full description of each field type.

---

## Step 3: Configure signers and thresholds

After placing fields, open the **Resolution Thresholds** collapsible panel in the document configuration sidebar.

### Set threshold percentages

| Field | Default | Description |
|-------|---------|-------------|
| Group A threshold (%) | 75 | Minimum percentage of total weighted votes required |
| Group B threshold (%) | 50 | Minimum percentage of independent signers' weighted votes required |

Enter integer values (e.g., `75` for 75%). The UI converts these to fractions (0.75) before storing.

### Configure per-signer weights

The panel displays a table with one row per signer. For each signer:

| Column | Description |
|--------|-------------|
| Signer | Name and email (read-only, populated from the signer list) |
| Group A weight | Numeric weight used in the Group A calculation |
| Group B weight | Numeric weight used in the Group B calculation |
| Exclude from B | Check to exclude this signer from the Group B calculation entirely |

The `Exclude from B` checkbox behaves like a radio button — only one signer should be excluded. If a signer is excluded from Group B, their Group B weight input is disabled and ignored.

Typical values:
- **Share-weighted**: enter share counts (e.g., 350000, 400000, 250000). The system uses ratios, so absolute values are what matter.
- **Equal voting**: enter `1` for all signers.

### Save

Click **Save Thresholds**. This calls `importResolutionSchema` and writes:
- A `resolutions_Threshold` record with status `DRAFT`
- One `resolutions_SignerWeight` record per signer

The document remains in DRAFT. Signers have not been notified yet.

---

## Step 4: Approve and send

When the configuration is correct and ready to send to signers:

**Via the UI**: Click the **Approve for Signing** button (available to admin users only).

**Via API or script**: Call `approveForSigning` with the `documentId`. See [api-reference.md](./api-reference.md).

What happens on approval:
1. `resolutions_Threshold.status` is set to `ACTIVE`.
2. `contracts_Document.adminApprovedAt` is stamped with the current timestamp.
3. Invite emails are sent to all signers with unique signing links.

Once approved, the threshold check is live: every signing event will trigger a check.

---

## Step 5: Monitor progress on the dashboard

The document dashboard card shows the **ResolutionProgress** widget for any document with an active threshold record. It displays:

- A status badge: `DRAFT`, `ACTIVE`, or `EXECUTED`
- **Group A** progress bar: current signed weight / total weight vs. the required threshold. The bar turns green when the threshold is met.
- **Group B** progress bar: same for the independent-signer subset.

A vertical marker on each bar shows where the threshold falls, so the gap is visible at a glance.

The progress data is fetched client-side from `resolutions_Threshold`, `resolutions_SignerWeight`, and `contracts_Document.AuditTrail` via the `useResolutionThreshold` hook.

---

## Step 6: Execution

Execution is automatic. After each signing event, the `afterSave` hook on `contracts_Document` runs `checkThresholds`. When both Group A and Group B thresholds are met:

1. `resolutions_Threshold.status` is set to `EXECUTED`.
2. `contracts_Document.executedAt` is stamped.
3. An "executed" notification email is sent to all signers and the document owner.
4. The dashboard badge updates to `EXECUTED`.

No admin action is required to trigger execution.

### If execution does not trigger

Check:
- The document's `resolutions_Threshold` record has `status = ACTIVE`. If it is `DRAFT`, `approveForSigning` has not been called.
- All `resolutions_SignerWeight` records are present and weights are non-zero.
- Signing events are appearing in `contracts_Document.AuditTrail` with `Activity: 'Signed'`.
- The signer email in AuditTrail matches the email stored in `resolutions_SignerWeight` (case-insensitive).
