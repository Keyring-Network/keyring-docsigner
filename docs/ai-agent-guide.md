# AI Agent / Programmatic Integration Guide

This guide covers how to set up a shareholder resolution document end-to-end without using the UI — suitable for AI agents, scripts, or automated pipelines.

## Prerequisites

- Parse server URL and Application ID
- A session token or master key with admin privileges
- A PDF file accessible via URL or as a base64-encoded buffer

## Step 1: Upload a PDF

Use the OpenSign document creation API to create a `contracts_Document` record. This is the existing OpenSign endpoint — no changes are needed.

```js
const Parse = require('parse/node');
Parse.initialize(APP_ID);
Parse.serverURL = SERVER_URL;

// Authenticate (or set masterKey if using master key auth)
await Parse.User.logIn(adminEmail, adminPassword);

// Create the document record
const Doc = Parse.Object.extend('contracts_Document');
const doc = new Doc();
doc.set('Name', 'Board Resolution — Q2 2025');
doc.set('URL', 'https://your-storage-bucket.example.com/resolution-q2.pdf');
doc.set('TimeToCompleteDays', 30);
// Set ExtUserPtr to the owner user pointer if required by your schema

await doc.save();
const documentId = doc.id;
console.log('Document created:', documentId);
```

If your deployment requires the PDF to be uploaded to Parse file storage first:

```js
const fs = require('fs');
const pdfBuffer = fs.readFileSync('./resolution.pdf');
const file = new Parse.File('resolution.pdf', { base64: pdfBuffer.toString('base64') });
await file.save();
doc.set('URL', file.url());
```

## Step 2: Call `importResolutionSchema`

Configure signers, weights, thresholds, and field positions in a single call.

```js
const result = await Parse.Cloud.run('importResolutionSchema', {
  documentId,
  thresholdA: 0.75,  // 75% of total weighted votes
  thresholdB: 0.50,  // 50% of non-excluded signers' weighted votes
  signers: [
    {
      email: 'alice@example.com',
      weightGroupA: 350000,   // shares held — absolute values, ratios are what count
      weightGroupB: 350000,
      excludedFromB: false
    },
    {
      email: 'bob@example.com',
      weightGroupA: 400000,
      weightGroupB: 400000,
      excludedFromB: false
    },
    {
      email: 'carol@example.com',   // majority shareholder, excluded from Group B
      weightGroupA: 250000,
      weightGroupB: 0,
      excludedFromB: true
    }
  ],
  fields: [
    // Alice — page 3 (0-indexed: page 2)
    {
      signerEmail: 'alice@example.com',
      type: 'signature',
      page: 2,
      x: 0.10, y: 0.78,
      width: 0.25, height: 0.06
    },
    {
      signerEmail: 'alice@example.com',
      type: 'weight factor',
      label: 'Shares Held',
      page: 2,
      x: 0.40, y: 0.78,
      width: 0.15, height: 0.04
    },
    {
      signerEmail: 'alice@example.com',
      type: 'date',
      page: 2,
      x: 0.60, y: 0.78,
      width: 0.15, height: 0.04
    },
    // Bob — same page
    {
      signerEmail: 'bob@example.com',
      type: 'signature',
      page: 2,
      x: 0.10, y: 0.86,
      width: 0.25, height: 0.06
    },
    {
      signerEmail: 'bob@example.com',
      type: 'weight factor',
      label: 'Shares Held',
      page: 2,
      x: 0.40, y: 0.86,
      width: 0.15, height: 0.04
    },
    // Carol — excluded from Group B but still signs for Group A
    {
      signerEmail: 'carol@example.com',
      type: 'signature',
      page: 2,
      x: 0.10, y: 0.94,
      width: 0.25, height: 0.06
    }
  ]
});

console.log('Schema imported:', result);
// { success: true, thresholdId: 'Thr0ldXXX', signerWeightIds: [...] }
```

The document is now in `DRAFT` status. Signers have not been contacted.

## Step 3: Call `approveForSigning`

When you are ready to send invite emails to signers:

```js
await Parse.Cloud.run('approveForSigning', { documentId });
console.log('Document approved and invites sent');
```

This requires the caller to be authenticated as an admin user (or using the master key). The function:
- Sets `resolutions_Threshold.status` to `ACTIVE`
- Sends a signing-invite email to each signer with a unique URL

## Step 4: Poll document status

To check whether the document has been executed:

```js
async function getDocumentStatus(documentId) {
  const tQuery = new Parse.Query('resolutions_Threshold');
  tQuery.equalTo('document', {
    __type: 'Pointer',
    className: 'contracts_Document',
    objectId: documentId
  });
  const threshold = await tQuery.first({ useMasterKey: true });

  if (!threshold) return { status: 'NO_THRESHOLD', executed: false };

  const status = threshold.get('status');
  const executed = status === 'EXECUTED';

  // If executed, fetch executedAt from the document
  let executedAt = null;
  if (executed) {
    const docQuery = new Parse.Query('contracts_Document');
    const doc = await docQuery.get(documentId, { useMasterKey: true });
    executedAt = doc.get('executedAt');
  }

  return { status, executed, executedAt };
}

// Poll every 60 seconds
const interval = setInterval(async () => {
  const { status, executed, executedAt } = await getDocumentStatus(documentId);
  console.log(`Status: ${status}`);
  if (executed) {
    console.log('Executed at:', executedAt);
    clearInterval(interval);
  }
}, 60_000);
```

To get per-group signing progress without polling:

```js
const swQuery = new Parse.Query('resolutions_SignerWeight');
swQuery.equalTo('document', {
  __type: 'Pointer',
  className: 'contracts_Document',
  objectId: documentId
});
const weights = await swQuery.find({ useMasterKey: true });

const docQuery = new Parse.Query('contracts_Document');
const doc = await docQuery.get(documentId, { useMasterKey: true });
const auditTrail = doc.get('AuditTrail') || [];

const signedEmails = new Set(
  auditTrail
    .filter(e => ['Signed', 'Approved'].includes(e?.Activity))
    .map(e => (e?.UserPtr?.Email || '').toLowerCase())
    .filter(Boolean)
);

let totalA = 0, signedA = 0, totalB = 0, signedB = 0;
for (const sw of weights) {
  const email = (sw.get('signerEmail') || '').toLowerCase();
  const hasSigned = signedEmails.has(email);
  totalA += sw.get('weightGroupA') || 0;
  if (hasSigned) signedA += sw.get('weightGroupA') || 0;
  if (!sw.get('excludedFromB')) {
    totalB += sw.get('weightGroupB') || 0;
    if (hasSigned) signedB += sw.get('weightGroupB') || 0;
  }
}

console.log(`Group A: ${(signedA/totalA*100).toFixed(1)}%`);
console.log(`Group B: ${(signedB/totalB*100).toFixed(1)}%`);
```

## Full end-to-end example

```js
const Parse = require('parse/node');

async function setupResolution({
  serverURL,
  appId,
  adminEmail,
  adminPassword,
  pdfUrl,
  documentName,
  signers,        // [{ email, weightA, weightB, excludedFromB }]
  thresholdA,
  thresholdB,
  fields          // [{ signerEmail, type, label?, page, x, y, width, height }]
}) {
  Parse.initialize(appId);
  Parse.serverURL = serverURL;

  // Authenticate
  await Parse.User.logIn(adminEmail, adminPassword);

  // Create the document
  const Doc = Parse.Object.extend('contracts_Document');
  const doc = new Doc();
  doc.set('Name', documentName);
  doc.set('URL', pdfUrl);
  doc.set('TimeToCompleteDays', 30);
  await doc.save();
  const documentId = doc.id;
  console.log('[1] Document created:', documentId);

  // Import resolution schema
  const schemaResult = await Parse.Cloud.run('importResolutionSchema', {
    documentId,
    thresholdA,
    thresholdB,
    signers: signers.map(s => ({
      email: s.email,
      weightGroupA: s.weightA,
      weightGroupB: s.weightB,
      excludedFromB: s.excludedFromB || false
    })),
    fields
  });
  console.log('[2] Schema imported:', schemaResult);

  // Approve and send
  await Parse.Cloud.run('approveForSigning', { documentId });
  console.log('[3] Approved — invite emails sent to signers');

  return documentId;
}

// Usage
const documentId = await setupResolution({
  serverURL: 'https://parse.yourapp.example.com/parse',
  appId: 'your-app-id',
  adminEmail: 'admin@yourcompany.example.com',
  adminPassword: process.env.ADMIN_PASSWORD,
  pdfUrl: 'https://storage.example.com/board-resolution-q2-2025.pdf',
  documentName: 'Board Resolution Q2 2025',
  thresholdA: 0.75,
  thresholdB: 0.50,
  signers: [
    { email: 'alice@example.com', weightA: 350000, weightB: 350000, excludedFromB: false },
    { email: 'bob@example.com',   weightA: 400000, weightB: 400000, excludedFromB: false },
    { email: 'carol@example.com', weightA: 250000, weightB: 0,      excludedFromB: true  }
  ],
  fields: [
    { signerEmail: 'alice@example.com', type: 'signature',     page: 2, x: 0.10, y: 0.78, width: 0.25, height: 0.06 },
    { signerEmail: 'alice@example.com', type: 'weight factor', label: 'Shares Held', page: 2, x: 0.40, y: 0.78, width: 0.15, height: 0.04 },
    { signerEmail: 'bob@example.com',   type: 'signature',     page: 2, x: 0.10, y: 0.86, width: 0.25, height: 0.06 },
    { signerEmail: 'bob@example.com',   type: 'weight factor', label: 'Shares Held', page: 2, x: 0.40, y: 0.86, width: 0.15, height: 0.04 },
    { signerEmail: 'carol@example.com', type: 'signature',     page: 2, x: 0.10, y: 0.94, width: 0.25, height: 0.06 }
  ]
});
```

## Notes on coordinate system

Field positions use fractional coordinates relative to the PDF page dimensions:
- `x: 0.10` = 10% from the left edge of the page
- `y: 0.78` = 78% from the top of the page
- `width: 0.25` = 25% of the page width
- `height: 0.06` = 6% of the page height

The `page` parameter is 0-indexed (page 0 = first page of the PDF).

## Re-importing

Calling `importResolutionSchema` again on the same document replaces all `resolutions_SignerWeight` records and updates the threshold values. The field positions in `Placeholders` are also updated. If a `resolutions_Threshold` record already exists with status `ACTIVE` or higher, the status is not downgraded to `DRAFT` — only new records start as `DRAFT`.
