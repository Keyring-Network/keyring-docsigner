# API Reference — Resolution Cloud Functions

All functions are Parse Cloud Functions defined in `apps/OpenSignServer/cloud/resolutions.js`. Call them with `Parse.Cloud.run(name, params)` from the client SDK, or via HTTP POST to `/functions/<name>` with the `X-Parse-Application-Id` header.

---

## `initResolutionsSchema`

Creates the `resolutions_Threshold` and `resolutions_SignerWeight` Parse schema definitions if they do not already exist. Safe to call multiple times (idempotent).

### Authentication

Requires master key (`useMasterKey: true`) or an admin session. Intended for initial deployment setup only.

### Parameters

None.

### Returns

```json
{ "result": { "success": true } }
```

### Errors

| Code | Meaning |
|------|---------|
| Any non-schema-exists error | Re-thrown as-is; schema creation failed |

### Example

```js
await Parse.Cloud.run('initResolutionsSchema', {});
```

---

## `importResolutionSchema`

Configures a document's resolution thresholds, signer weights, and field positions. Creates or replaces the `resolutions_Threshold` and all `resolutions_SignerWeight` records for the given document. Also writes field positions into `contracts_Document.Placeholders`.

Call this before `approveForSigning`. The document status will be `DRAFT` after this call (or unchanged if the threshold record already existed at a higher status).

### Authentication

Requires either:
- A session belonging to a user with `contracts_Admin` or `contracts_OrgAdmin` in the `contracts_Users.UserRole` field, **or**
- The Parse master key.

Any other caller receives a `119` (OPERATION_FORBIDDEN) error.

### Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `documentId` | string | Yes | — | Parse objectId of the `contracts_Document` |
| `thresholdA` | number | No | `0.75` | Group A threshold as a fraction (0–1) |
| `thresholdB` | number | No | `0.50` | Group B threshold as a fraction (0–1) |
| `signers` | array | No | `[]` | Per-signer weight configuration (see below) |
| `fields` | array | No | `[]` | Field position definitions (see below) |

#### Signer object

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `email` | string | Yes | — | Signer's email address |
| `weightGroupA` | number | No | `0` | Numeric weight for Group A calculation |
| `weightGroupB` | number | No | `0` | Numeric weight for Group B calculation |
| `excludedFromB` | boolean | No | `false` | If true, signer is excluded from Group B entirely |

#### Field object

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `signerEmail` | string | Yes | — | Email of the signer this field belongs to; must match an email in `signers[]` |
| `type` | string | No | `"signature"` | Field type: `"signature"`, `"name"`, `"job title"`, `"date"`, `"weight factor"`, etc. |
| `label` | string | No | `""` | Display label for `weight factor` fields |
| `page` | number | No | `1` | 1-indexed page number (minimum 1) |
| `x` | number | No | `0` | X position in rendered-viewport pixels from left edge |
| `y` | number | No | `0` | Y position in rendered-viewport pixels from top edge |
| `width` | number | No | `100` | Field width in rendered-viewport pixels |
| `height` | number | No | `50` | Field height in rendered-viewport pixels |

### Returns

```json
{
  "result": {
    "success": true,
    "thresholdId": "<objectId of resolutions_Threshold>",
    "signerWeightIds": ["<id1>", "<id2>", "..."]
  }
}
```

### Errors

| Code | Message | Meaning |
|------|---------|---------|
| `101` (INVALID_QUERY) | `Missing required parameter: documentId` | `documentId` not provided |
| `101` or other | Parse error message | Schema save or query failure |

### Example payload

```json
{
  "documentId": "abc123",
  "thresholdA": 0.75,
  "thresholdB": 0.50,
  "signers": [
    {
      "email": "alice@example.com",
      "weightGroupA": 0.35,
      "weightGroupB": 0.45,
      "excludedFromB": false
    },
    {
      "email": "bob@example.com",
      "weightGroupA": 0.40,
      "weightGroupB": 0.55,
      "excludedFromB": false
    },
    {
      "email": "carol@example.com",
      "weightGroupA": 0.25,
      "weightGroupB": 0.00,
      "excludedFromB": true
    }
  ],
  "fields": [
    {
      "signerEmail": "alice@example.com",
      "type": "signature",
      "page": 2,
      "x": 102,
      "y": 780,
      "width": 250,
      "height": 60
    },
    {
      "signerEmail": "alice@example.com",
      "type": "weight factor",
      "label": "Shares Held",
      "page": 2,
      "x": 400,
      "y": 780,
      "width": 150,
      "height": 40
    }
  ]
}
```

### Example response

```json
{
  "result": {
    "success": true,
    "thresholdId": "Thr0ld1dABC",
    "signerWeightIds": ["SW001", "SW002", "SW003"]
  }
}
```

---

## `approveForSigning`

Transitions a document from `DRAFT` to `ACTIVE` and sends invite emails to all signers. Must be called after `importResolutionSchema`.

### Authentication

Requires either:
- A session belonging to a user with `contracts_Admin` or `contracts_OrgAdmin` in the `contracts_Users.UserRole` field, **or**
- The Parse master key.

Any other caller receives a `119` (OPERATION_FORBIDDEN) error.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `documentId` | string | Yes | Parse objectId of the `contracts_Document` to approve |

### Returns

```json
{ "result": { "success": true } }
```

### Side effects

1. `resolutions_Threshold.status` set to `ACTIVE`
2. `contracts_Document.adminApprovedAt` set to current UTC timestamp
3. Invite emails sent to all non-prefill placeholder signers with unique signing URLs

### Errors

| Code | Message | Meaning |
|------|---------|---------|
| `101` (INVALID_QUERY) | `Missing required parameter: documentId` | `documentId` not provided |
| `209` (INVALID_SESSION_TOKEN) | `Authentication required.` | No user session and no master key |
| `119` (OPERATION_FORBIDDEN) | `Admin role required.` | User does not have `contracts_Admin` or `contracts_OrgAdmin` in `contracts_Users.UserRole` |
| `101` (OBJECT_NOT_FOUND) | `No resolutions_Threshold found for document <id>` | `importResolutionSchema` has not been called for this document |

### Example

```js
await Parse.Cloud.run('approveForSigning', { documentId: 'abc123' });
```

---

## Internal functions (not callable via Cloud Function API)

These are internal helpers used by the above functions and the `afterSave` hook. They are not exposed as Cloud Functions.

### `checkThresholds(documentId)`

Returns `true` if both thresholds are met, `false` if not, `null` if no active threshold record exists. See [threshold-model.md](./threshold-model.md) for the full algorithm.

### `executeDocument(documentId)`

Sets status to `EXECUTED`, stamps `executedAt` on the document, and sends execution notification emails. Called automatically by the `afterSave` hook when `checkThresholds` returns `true`.

### `afterSave` hook on `contracts_Document`

Fires on every save of a `contracts_Document`. Guards against non-resolution documents. Detects new `Signed`/`Approved` entries in `AuditTrail` and calls `checkThresholds` when a new signing event is found.
