/**
 * Parse Cloud Code for shareholder resolution threshold signing.
 *
 * Schema note:
 *   `contracts_Signature` is a user's saved-signature-image store (fields:
 *   ImageURL, Initials, Stamp, SignatureName, UserId).  It is NOT a
 *   per-signing event record.  Signing events are tracked through
 *   contracts_Document.AuditTrail (each entry: {UserPtr, Activity:'Signed',
 *   SignedUrl, ipAddress, SignedOn}).  Section F therefore hooks
 *   afterSave("contracts_Document") and inspects the updated AuditTrail,
 *   which is the correct interception point for "a signer just signed".
 */

import sendSystemMail from './parsefunction/sendSystemMail.js';
import { appName, cloudServerUrl, serverAppId, mailTemplate } from '../Utils.js';
import axios from 'axios';

const serverUrl = cloudServerUrl;
const appId = serverAppId;

// ─── Auth helper ─────────────────────────────────────────────────────────────

async function requireAdmin(req) {
  if (req.master) return;
  if (!req.user) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'Authentication required.');
  }
  const email = req.user.get('email') || req.user.get('username');
  const extUserQuery = new Parse.Query('contracts_Users');
  extUserQuery.equalTo('Email', email);
  const extUser = await extUserQuery.first({ useMasterKey: true });
  const role = extUser?.get('UserRole');
  if (role !== 'contracts_Admin' && role !== 'contracts_OrgAdmin') {
    throw new Parse.Error(Parse.Error.OPERATION_FORBIDDEN, 'Admin role required.');
  }
}

// ─── A. Schema initialisation ────────────────────────────────────────────────

Parse.Cloud.define('initResolutionsSchema', async req => {
  await requireAdmin(req);
  try {
    // resolutions_Threshold
    const thresholdSchema = new Parse.Schema('resolutions_Threshold');
    thresholdSchema
      .addPointer('document', 'contracts_Document')
      .addNumber('thresholdA')
      .addNumber('thresholdB')
      .addString('status'); // DRAFT | PENDING_APPROVAL | ACTIVE | EXECUTED | CANCELLED
    try {
      await thresholdSchema.save(null, { useMasterKey: true });
      console.log('[resolutions] resolutions_Threshold schema created');
    } catch (err) {
      // Schema already exists — update is a no-op but safe to call
      if (err.message && err.message.includes('already exists')) {
        console.log('[resolutions] resolutions_Threshold schema already exists');
      } else {
        throw err;
      }
    }

    // resolutions_SignerWeight
    const signerWeightSchema = new Parse.Schema('resolutions_SignerWeight');
    signerWeightSchema
      .addPointer('document', 'contracts_Document')
      .addString('signerEmail')
      .addNumber('weightGroupA')
      .addNumber('weightGroupB')
      .addBoolean('excludedFromB');
    try {
      await signerWeightSchema.save(null, { useMasterKey: true });
      console.log('[resolutions] resolutions_SignerWeight schema created');
    } catch (err) {
      if (err.message && err.message.includes('already exists')) {
        console.log('[resolutions] resolutions_SignerWeight schema already exists');
      } else {
        throw err;
      }
    }

    // Set CLPs: cloud code (master key) can write; authenticated users can read
    const readAuthOnly = { requiresAuthentication: true };
    const masterOnly = {};
    const clp = {
      get: readAuthOnly,
      find: readAuthOnly,
      create: masterOnly,
      update: masterOnly,
      delete: masterOnly,
      addField: masterOnly,
      protectedFields: { '*': [] },
    };
    try {
      await new Parse.Schema('resolutions_Threshold').setCLP(clp).update({ useMasterKey: true });
      await new Parse.Schema('resolutions_SignerWeight').setCLP(clp).update({ useMasterKey: true });
    } catch (clpErr) {
      console.warn('[resolutions] CLP update failed (non-fatal):', clpErr?.message);
    }

    return { success: true };
  } catch (err) {
    console.error('[resolutions] initResolutionsSchema error:', err);
    throw err;
  }
});

// ─── B. checkThresholds(documentId) ──────────────────────────────────────────

/**
 * Returns true if both Group A and Group B thresholds are met for the given
 * document, false if thresholds are not met, and null if no ACTIVE threshold
 * record exists for the document.
 *
 * Signed signers are identified from contracts_Document.AuditTrail entries
 * where Activity is 'Signed' or 'Approved' (matching the existing
 * COMPLETION_ACTIVITIES pattern used in PDF.js / workflowUtils.js).
 */
async function checkThresholds(documentId) {
  try {
    const docPtr = { __type: 'Pointer', className: 'contracts_Document', objectId: documentId };

    // 1. Fetch the threshold record
    const tQuery = new Parse.Query('resolutions_Threshold');
    tQuery.equalTo('document', docPtr);
    const threshold = await tQuery.first({ useMasterKey: true });

    if (!threshold) return null;
    if (threshold.get('status') !== 'ACTIVE') return null;

    const thresholdA = threshold.get('thresholdA') ?? 0.75;
    const thresholdB = threshold.get('thresholdB') ?? 0.50;

    // 2. Fetch all signer weight records for the document
    const swQuery = new Parse.Query('resolutions_SignerWeight');
    swQuery.equalTo('document', docPtr);
    swQuery.limit(1000);
    const signerWeights = await swQuery.find({ useMasterKey: true });

    if (signerWeights.length === 0) return false;

    // 3. Collect signed signer emails from AuditTrail
    const docQuery = new Parse.Query('contracts_Document');
    docQuery.include('Signers');
    const doc = await docQuery.get(documentId, { useMasterKey: true });
    if (!doc) return false;

    const auditTrail = doc.get('AuditTrail') || [];
    const completionActivities = ['Signed', 'Approved'];

    // Build a set of objectIds that have signed
    const signedSignerObjectIds = new Set(
      auditTrail
        .filter(entry => completionActivities.includes(entry?.Activity))
        .map(entry => entry?.UserPtr?.objectId)
        .filter(Boolean)
    );

    // Map signer objectId → email from the Signers array (contracts_Contactbook pointers)
    // AuditTrail UserPtr points to contracts_Contactbook for external signers.
    // We match by objectId to get the email from Signers.
    const signers = doc.get('Signers') || [];
    const signedEmails = new Set();
    for (const signer of signers) {
      const signerId = signer?.objectId || signer?.id;
      if (signerId && signedSignerObjectIds.has(signerId)) {
        const email = signer?.get?.('Email') || signer?.Email;
        if (email) signedEmails.add(email.toLowerCase());
      }
    }

    // Fallback: also check the AuditTrail's Placeholders/email fields
    // For external signers without a full Signers include, match by fetching contacts
    if (signedEmails.size === 0 && signedSignerObjectIds.size > 0) {
      for (const objId of signedSignerObjectIds) {
        try {
          const contactQuery = new Parse.Query('contracts_Contactbook');
          const contact = await contactQuery.get(objId, { useMasterKey: true });
          const email = contact?.get('Email');
          if (email) signedEmails.add(email.toLowerCase());
        } catch {
          // contact not found — skip
        }
      }
    }

    // 4. Compute Group A totals
    let totalA = 0;
    let signedA = 0;

    // 5. Compute Group B totals (excludedFromB == false only)
    let totalB = 0;
    let signedB = 0;

    for (const sw of signerWeights) {
      const email = (sw.get('signerEmail') || '').toLowerCase();
      const wA = sw.get('weightGroupA') ?? 0;
      const wB = sw.get('weightGroupB') ?? 0;
      const excludedFromB = sw.get('excludedFromB') ?? false;
      const hasSigned = signedEmails.has(email);

      totalA += wA;
      if (hasSigned) signedA += wA;

      if (!excludedFromB) {
        totalB += wB;
        if (hasSigned) signedB += wB;
      }
    }

    // Guard against zero-weight configs
    const ratioA = totalA > 0 ? signedA / totalA : 0;
    const ratioB = totalB > 0 ? signedB / totalB : 0;

    console.log(
      `[resolutions] checkThresholds doc=${documentId} ratioA=${ratioA.toFixed(3)}/${thresholdA} ratioB=${ratioB.toFixed(3)}/${thresholdB}`
    );

    // Spec requires strict greater-than (>75%, >50%), not >=
    return ratioA > thresholdA && ratioB > thresholdB;
  } catch (err) {
    console.error('[resolutions] checkThresholds error:', err);
    return false;
  }
}

// ─── C. executeDocument(documentId) ──────────────────────────────────────────

/**
 * Marks the resolution as EXECUTED and stamps executedAt on the document.
 * Full PDF overlay with pdf-lib goes here in M6.
 */
async function executeDocument(documentId) {
  try {
    const docPtr = { __type: 'Pointer', className: 'contracts_Document', objectId: documentId };

    // Update resolutions_Threshold status to EXECUTED
    const tQuery = new Parse.Query('resolutions_Threshold');
    tQuery.equalTo('document', docPtr);
    const threshold = await tQuery.first({ useMasterKey: true });
    if (threshold) {
      threshold.set('status', 'EXECUTED');
      await threshold.save(null, { useMasterKey: true });
    }

    // Stamp executedAt on the contracts_Document
    const docObj = new Parse.Object('contracts_Document');
    docObj.id = documentId;
    docObj.set('executedAt', new Date());
    await docObj.save(null, { useMasterKey: true });

    console.log(`[resolutions] Document ${documentId} executed — PDF generation pending M6`);

    // TODO (M6): PDF overlay with pdf-lib goes here.
    // Generate a completed/executed PDF combining all signer annotations,
    // stamp an "EXECUTED" watermark, and store the final URL on the document.

    // Send notification emails to all signers
    await sendExecutionNotification(documentId);
  } catch (err) {
    console.error('[resolutions] executeDocument error:', err);
    throw err;
  }
}

/**
 * Sends a "resolution executed" notification email to all signers on the document.
 */
async function sendExecutionNotification(documentId) {
  try {
    const docQuery = new Parse.Query('contracts_Document');
    docQuery.include('ExtUserPtr');
    docQuery.include('Signers');
    const doc = await docQuery.get(documentId, { useMasterKey: true });
    if (!doc) return;

    const _doc = doc.toJSON();
    const pdfName = _doc.Name || 'Resolution Document';
    const sender = _doc.ExtUserPtr;
    const TenantAppName = appName;

    const subject = `Resolution "${pdfName}" has been executed`;
    const body =
      "<html><head><meta http-equiv='Content-Type' content='text/html; charset=UTF-8'/></head>" +
      "<body><div style='background-color:#f5f5f5;padding:20px'><div style='background-color:white'>" +
      "<div style='padding:2px;font-family:system-ui;background-color:#47a3ad'>" +
      `<p style='font-size:20px;font-weight:400;color:white;padding-left:20px'>Resolution Executed</p>` +
      `</div><div style='padding:20px;font-family:system-ui;font-size:14px'>` +
      `<p>The shareholder resolution <strong>"${pdfName}"</strong> has been fully executed as all required signature thresholds have been met.</p>` +
      `</div></div><div><p>This is an automated email from ${TenantAppName}.</p></div></div></body></html>`;

    // Collect all signer emails
    const signerEmails = [];
    if (Array.isArray(_doc.Signers)) {
      for (const signer of _doc.Signers) {
        if (signer.Email) signerEmails.push(signer.Email);
      }
    }
    // Include document owner if not already in signers
    if (sender?.Email && !signerEmails.includes(sender.Email)) {
      signerEmails.push(sender.Email);
    }

    if (signerEmails.length === 0) return;

    const recipient = signerEmails.join(',');
    const params = {
      extUserId: sender?.objectId || '',
      from: TenantAppName,
      recipient,
      subject,
      html: body,
    };

    await sendSystemMail({ params });
  } catch (err) {
    console.error('[resolutions] sendExecutionNotification error:', err);
    // Non-fatal — do not rethrow; execution marking already succeeded
  }
}

// ─── D. approveForSigning ─────────────────────────────────────────────────────

Parse.Cloud.define('approveForSigning', async req => {
  const { documentId } = req.params;
  if (!documentId) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'Missing required parameter: documentId');
  }

  await requireAdmin(req);

  try {
    const docPtr = { __type: 'Pointer', className: 'contracts_Document', objectId: documentId };

    // Set resolutions_Threshold.status = ACTIVE
    const tQuery = new Parse.Query('resolutions_Threshold');
    tQuery.equalTo('document', docPtr);
    const threshold = await tQuery.first({ useMasterKey: true });
    if (!threshold) {
      throw new Parse.Error(
        Parse.Error.OBJECT_NOT_FOUND,
        `No resolutions_Threshold found for document ${documentId}`
      );
    }
    threshold.set('status', 'ACTIVE');
    await threshold.save(null, { useMasterKey: true });

    // Stamp adminApprovedAt on the document
    const docObj = new Parse.Object('contracts_Document');
    docObj.id = documentId;
    docObj.set('adminApprovedAt', new Date());
    await docObj.save(null, { useMasterKey: true });

    // Send invite emails to all signers
    await sendInviteEmails(documentId);

    return { success: true };
  } catch (err) {
    console.error('[resolutions] approveForSigning error:', err);
    throw err;
  }
});

/**
 * Sends signing-invite emails to all non-prefill placeholder signers on the document,
 * matching the pattern used in createBatchDocs.js.
 *
 * Note: signing URLs require a public_url header in the original flow. We use
 * process.env.PUBLIC_URL (or a fallback) since we're invoked server-side without
 * a client request context.
 */
async function sendInviteEmails(documentId) {
  try {
    const docQuery = new Parse.Query('contracts_Document');
    docQuery.include('ExtUserPtr');
    docQuery.include('ExtUserPtr.TenantId');
    docQuery.include('Signers');
    const doc = await docQuery.get(documentId, { useMasterKey: true });
    if (!doc) return;

    const _doc = doc.toJSON();

    const publicUrl = process.env.PUBLIC_URL || 'https://app.opensignlabs.com';
    const baseUrl = new URL(publicUrl);

    const timeToCompleteDays = _doc?.TimeToCompleteDays || 15;
    const ExpireDate = new Date(_doc.createdAt || new Date());
    ExpireDate.setDate(ExpireDate.getDate() + timeToCompleteDays);
    const localExpireDate = ExpireDate.toLocaleDateString('en-US', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });

    const senderName = _doc?.SenderName || _doc?.ExtUserPtr?.Name || '';
    const senderEmail = _doc?.SenderMail || _doc?.ExtUserPtr?.Email || '';
    const orgName = _doc?.ExtUserPtr?.Company || '';
    const from =
      _doc?.SenderName || _doc?.ExtUserPtr?.UseNameAsSender === true ? senderName : senderEmail;

    // Placeholders minus prefill entries
    const signerPlaceholders = (_doc.Placeholders || []).filter(p => p?.Role !== 'prefill');

    for (const placeholder of signerPlaceholders) {
      try {
        const objectId = placeholder?.signerObjId || placeholder?.signerPtr?.objectId;
        const placeholderEmail = placeholder?.email || placeholder?.signerPtr?.Email || '';

        let recipientEmail = placeholderEmail;
        let encodeBase64;

        if (objectId) {
          const existSigner = (_doc.Signers || []).find(s => s.objectId === objectId);
          recipientEmail = existSigner?.Email || placeholderEmail;
          encodeBase64 = Buffer.from(
            `${documentId}/${recipientEmail}/${objectId}`
          ).toString('base64');
        } else {
          encodeBase64 = Buffer.from(`${documentId}/${recipientEmail}`).toString('base64');
        }

        if (!recipientEmail) continue;

        const signingUrl = `${baseUrl.origin}/login/${encodeBase64}`;

        const mailparam = {
          note: _doc?.Note || '',
          senderName,
          senderMail: senderEmail,
          title: _doc.Name || 'Resolution Document',
          organization: orgName,
          localExpireDate,
          signingUrl,
        };

        const mailHeaders = {
          'Content-Type': 'application/json',
          'X-Parse-Application-Id': appId,
        };

        const mailParams = {
          extUserId: _doc.ExtUserPtr?.objectId || '',
          recipient: recipientEmail,
          subject: mailTemplate(mailparam).subject,
          from,
          replyto: senderEmail,
          html: mailTemplate(mailparam).body,
        };

        await axios.post(`${serverUrl}/functions/sendmailv3`, mailParams, {
          headers: mailHeaders,
        });
      } catch (err) {
        console.error('[resolutions] sendInviteEmails — failed for signer:', err?.message || err);
      }
    }
  } catch (err) {
    console.error('[resolutions] sendInviteEmails error:', err);
    // Non-fatal — approval already recorded
  }
}

// ─── E. importResolutionSchema ────────────────────────────────────────────────

Parse.Cloud.define('importResolutionSchema', async req => {
  await requireAdmin(req);

  const {
    documentId,
    thresholdA = 0.75,
    thresholdB = 0.50,
    signers = [],
    fields = [],
  } = req.params;

  if (!documentId) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'Missing required parameter: documentId');
  }

  try {
    const docPtr = { __type: 'Pointer', className: 'contracts_Document', objectId: documentId };

    // ── Create/replace resolutions_Threshold ──
    const tQuery = new Parse.Query('resolutions_Threshold');
    tQuery.equalTo('document', docPtr);
    const existing = await tQuery.first({ useMasterKey: true });

    const thresholdObj = existing || new Parse.Object('resolutions_Threshold');
    thresholdObj.set('document', Parse.Object.fromJSON({ ...docPtr, className: 'contracts_Document' }));
    thresholdObj.set('thresholdA', thresholdA);
    thresholdObj.set('thresholdB', thresholdB);
    // Only set status to DRAFT if this is a new record
    if (!existing) {
      thresholdObj.set('status', 'DRAFT');
    }
    const savedThreshold = await thresholdObj.save(null, { useMasterKey: true });
    const thresholdId = savedThreshold.id;

    // ── Create/replace resolutions_SignerWeight records ──
    // Delete existing weight records for this document first
    const swQuery = new Parse.Query('resolutions_SignerWeight');
    swQuery.equalTo('document', docPtr);
    swQuery.limit(1000);
    const existingWeights = await swQuery.find({ useMasterKey: true });
    if (existingWeights.length > 0) {
      await Parse.Object.destroyAll(existingWeights, { useMasterKey: true });
    }

    const signerWeightIds = [];
    for (const signer of signers) {
      const sw = new Parse.Object('resolutions_SignerWeight');
      sw.set('document', Parse.Object.fromJSON({ ...docPtr, className: 'contracts_Document' }));
      sw.set('signerEmail', signer.email || '');
      sw.set('weightGroupA', signer.weightGroupA ?? 0);
      sw.set('weightGroupB', signer.weightGroupB ?? 0);
      sw.set('excludedFromB', signer.excludedFromB ?? false);
      const savedSw = await sw.save(null, { useMasterKey: true });
      signerWeightIds.push(savedSw.id);
    }

    // ── Store field positions on contracts_Document.Placeholders ──
    // Placeholders use the same structure as the rest of OpenSign:
    //   [{signerPtr, signerObjId, email, Role, placeHolder: [{pageNo, pos: [{type, x, y, width, height, label}]}]}]
    //
    // We merge incoming fields (grouped by signerEmail) into the existing
    // Placeholders array, adding position data without disturbing ACL or other
    // document fields.
    if (Array.isArray(fields) && fields.length > 0) {
      // Group fields by signerEmail
      const fieldsByEmail = {};
      for (const f of fields) {
        const email = (f.signerEmail || '').toLowerCase();
        if (!fieldsByEmail[email]) fieldsByEmail[email] = [];
        fieldsByEmail[email].push(f);
      }

      // Fetch the current document to read existing Placeholders
      const docFetch = await new Parse.Query('contracts_Document').get(documentId, {
        useMasterKey: true,
      });
      const existingPlaceholders = docFetch.get('Placeholders') || [];

      // Build updated Placeholders: one entry per signer with pos arrays
      const updatedPlaceholders = [...existingPlaceholders];

      for (const [email, emailFields] of Object.entries(fieldsByEmail)) {
        // Find existing placeholder for this signer (match by email field)
        const existingIdx = updatedPlaceholders.findIndex(
          p => (p?.email || '').toLowerCase() === email
        );

        // Group positions by page number
        const pageMap = {};
        for (const f of emailFields) {
          const pageNumber = f.page ?? 1;
          if (!pageMap[pageNumber]) pageMap[pageNumber] = [];
          pageMap[pageNumber].push({
            type: f.type || 'signature',
            xPosition: f.x ?? 0,
            yPosition: f.y ?? 0,
            Width: f.width ?? 100,
            Height: f.height ?? 50,
            label: f.label || '',
            options: { response: '' },
          });
        }

        const placeHolderPages = Object.entries(pageMap).map(([pageNumber, pos]) => ({
          pageNumber: Number(pageNumber),
          pos,
        }));

        if (existingIdx >= 0) {
          // Merge: replace placeHolder positions for this signer
          updatedPlaceholders[existingIdx] = {
            ...updatedPlaceholders[existingIdx],
            placeHolder: placeHolderPages,
          };
        } else {
          // Append a new placeholder entry for this email-only signer
          updatedPlaceholders.push({
            email,
            signerObjId: '',
            signerPtr: {},
            Role: 'signer',
            placeHolder: placeHolderPages,
          });
        }
      }

      docFetch.set('Placeholders', updatedPlaceholders);
      await docFetch.save(null, { useMasterKey: true });
    }

    return { success: true, thresholdId, signerWeightIds };
  } catch (err) {
    console.error('[resolutions] importResolutionSchema error:', err);
    throw err;
  }
});

// ─── F. afterSave("contracts_Document") — threshold check ────────────────────
//
// DESIGN NOTE: The spec requests afterSave("contracts_Signature") but
// contracts_Signature is a user's saved-signature-image store, not a
// per-signing event. Signing events are recorded in
// contracts_Document.AuditTrail (Activity:'Signed'). We therefore hook
// afterSave("contracts_Document") and compare old vs new AuditTrail to detect
// a newly added Signed entry. This is the correct interception point and is
// consistent with how PDF.js and workflowUtils.js track completion.

Parse.Cloud.afterSave('contracts_Document', async req => {
  try {
    const docObj = req.object;
    const docId = docObj.id;
    const newAuditTrail = docObj.get('AuditTrail') || [];

    // Early exits for performance
    if (newAuditTrail.length === 0) return;

    // Only proceed if a new Signed/Approved entry appeared
    const oldAuditTrail = req.original ? req.original.get('AuditTrail') || [] : [];
    const completionActivities = ['Signed', 'Approved'];
    const newSignedCount = newAuditTrail.filter(e =>
      completionActivities.includes(e?.Activity)
    ).length;
    const oldSignedCount = oldAuditTrail.filter(e =>
      completionActivities.includes(e?.Activity)
    ).length;

    if (newSignedCount <= oldSignedCount) return; // No new signing event

    // Guard: only act if this document has an associated resolutions_Threshold
    const docPtr = { __type: 'Pointer', className: 'contracts_Document', objectId: docId };
    const guardQuery = new Parse.Query('resolutions_Threshold');
    guardQuery.equalTo('document', docPtr);
    guardQuery.equalTo('status', 'ACTIVE');
    const activeThreshold = await guardQuery.first({ useMasterKey: true });

    if (!activeThreshold) return; // Normal OpenSign document — do nothing

    // Check whether all thresholds are now met
    const thresholdsMet = await checkThresholds(docId);
    if (thresholdsMet === true) {
      console.log(`[resolutions] Thresholds met for document ${docId} — executing`);
      await executeDocument(docId);
    }
  } catch (err) {
    console.error('[resolutions] afterSave contracts_Document error:', err);
    // afterSave errors must not propagate to the client
  }
});
