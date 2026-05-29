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
import { appName, cloudServerUrl, serverAppId, mailTemplate, getSecureUrl } from '../Utils.js';
import axios from 'axios';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import fs from 'node:fs';
import { parseUploadFile } from '../utils/fileUtils.js';

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

    // Set CLPs: master key only for all operations (cloud code reads/writes only)
    const masterOnly = {};
    const clp = {
      get: masterOnly,
      find: masterOnly,
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

// ─── A2. getResolutionProgress — public progress endpoint ────────────────────

Parse.Cloud.define('getResolutionProgress', async req => {
  const { documentId } = req.params;
  if (!documentId) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'documentId is required');
  }
  if (!req.user && !req.master) {
    throw new Parse.Error(Parse.Error.INVALID_SESSION_TOKEN, 'Authentication required.');
  }

  const docPtr = { __type: 'Pointer', className: 'contracts_Document', objectId: documentId };

  const tQuery = new Parse.Query('resolutions_Threshold');
  tQuery.equalTo('document', docPtr);
  const threshold = await tQuery.first({ useMasterKey: true });
  if (!threshold) return null;

  const thresholdA = threshold.get('thresholdA') ?? 0.75;
  const thresholdB = threshold.get('thresholdB') ?? 0.50;
  const status = threshold.get('status') || 'DRAFT';

  const swQuery = new Parse.Query('resolutions_SignerWeight');
  swQuery.equalTo('document', docPtr);
  swQuery.limit(1000);
  const signerWeights = await swQuery.find({ useMasterKey: true });

  // Resolve signed emails using AuditTrail objectId → Signers → email
  const docQuery = new Parse.Query('contracts_Document');
  docQuery.include('Signers');
  const doc = await docQuery.get(documentId, { useMasterKey: true });
  const auditTrail = doc.get('AuditTrail') || [];
  const completionActivities = ['Signed', 'Approved'];

  const signedSignerObjectIds = new Set(
    auditTrail
      .filter(entry => completionActivities.includes(entry?.Activity))
      .map(entry => entry?.UserPtr?.objectId)
      .filter(Boolean)
  );

  const docSigners = doc.get('Signers') || [];
  const signedEmails = new Set();
  for (const signer of docSigners) {
    const signerId = signer?.objectId || signer?.id;
    if (signerId && signedSignerObjectIds.has(signerId)) {
      const email = signer?.get?.('Email') || signer?.Email;
      if (email) signedEmails.add(email.toLowerCase());
    }
  }

  if (signedEmails.size === 0 && signedSignerObjectIds.size > 0) {
    for (const objId of signedSignerObjectIds) {
      try {
        const contact = await new Parse.Query('contracts_Contactbook').get(objId, { useMasterKey: true });
        const email = contact?.get('Email');
        if (email) signedEmails.add(email.toLowerCase());
      } catch { /* not found — skip */ }
    }
  }

  let totalA = 0, signedA = 0, totalB = 0, signedB = 0;
  for (const sw of signerWeights) {
    const email = (sw.get('signerEmail') || '').toLowerCase();
    const wA = sw.get('weightGroupA') ?? 0;
    const wB = sw.get('weightGroupB') ?? 0;
    const excluded = sw.get('excludedFromB') ?? false;
    const hasSigned = signedEmails.has(email);
    totalA += wA;
    if (hasSigned) signedA += wA;
    if (!excluded) {
      totalB += wB;
      if (hasSigned) signedB += wB;
    }
  }

  return {
    threshold: { thresholdA, thresholdB, status },
    groupAPercent: totalA > 0 ? (signedA / totalA) * 100 : 0,
    groupBPercent: totalB > 0 ? (signedB / totalB) * 100 : 0,
  };
});

// ─── A3. getResolutionConfig — admin config read endpoint ───────────────────

Parse.Cloud.define('getResolutionConfig', async req => {
  await requireAdmin(req);
  const { documentId } = req.params;
  if (!documentId) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'documentId is required');
  }

  const docPtr = { __type: 'Pointer', className: 'contracts_Document', objectId: documentId };

  const tQuery = new Parse.Query('resolutions_Threshold');
  tQuery.equalTo('document', docPtr);
  const threshold = await tQuery.first({ useMasterKey: true });

  const swQuery = new Parse.Query('resolutions_SignerWeight');
  swQuery.equalTo('document', docPtr);
  swQuery.limit(1000);
  const weights = await swQuery.find({ useMasterKey: true });

  return {
    thresholdA: threshold ? Math.round((threshold.get('thresholdA') ?? 0.75) * 100) : 75,
    thresholdB: threshold ? Math.round((threshold.get('thresholdB') ?? 0.50) * 100) : 50,
    signerWeights: weights.map(sw => ({
      email: sw.get('signerEmail') || '',
      weightGroupA: sw.get('weightGroupA') ?? 1,
      weightGroupB: sw.get('weightGroupB') ?? 1,
      excludedFromB: sw.get('excludedFromB') ?? false,
    })),
  };
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
 * Coordinate transform: converts a widget's stored pixel position (top-left
 * origin, viewport-relative) into pdf-lib coordinates (bottom-left origin,
 * PDF-point units) for a given page.
 *
 * The stored format mirrors the frontend (Utils.js / widgetUtils.js):
 *   pos.xPosition  — pixels from left of the rendered container
 *   pos.yPosition  — pixels from top of the rendered container
 *   pos.Width      — widget width in rendered pixels
 *   pos.Height     — widget height in rendered pixels
 *   pos.vpWidth    — container pixel width at the time the widget was placed
 *                    (used as the scaling reference; defaults to pageWidth if absent)
 *
 * This is the same algebra used in the frontend getWidgetPosition() function.
 */
function widgetToPdfCoords(pos, page) {
  const { y: cropY, width: cropW, height: cropH } = page.getCropBox();
  const pageWidth = cropW;
  const pageHeight = cropH + cropY; // total height including any cropY offset

  const vpWidth = pos.vpWidth || pageWidth;
  const pageRatio = pageWidth / vpWidth;

  const scaledX = (pos.xPosition || 0) * pageRatio;
  const scaledY = (pos.yPosition || 0) * pageRatio;
  const scaledW = (pos.Width || 100) * pageRatio;
  const scaledH = (pos.Height || 40) * pageRatio;

  // Convert from "y from top" (browser) to "y from bottom" (pdf-lib)
  const pdfX = scaledX;
  const pdfY = pageHeight - scaledY - scaledH;

  return { x: pdfX, y: pdfY, width: scaledW, height: scaledH };
}

/**
 * Builds a map of { signerObjectId → { email, signatureBase64, placeholder } }
 * by combining:
 *   - AuditTrail entries (activity=Signed, contain Signature base64)
 *   - Signers array (contracts_Contactbook pointers, for email lookup)
 *   - Placeholders array (per-signer field positions with options.response = value)
 */
function buildSignerDataMap(doc) {
  const _doc = typeof doc.toJSON === 'function' ? doc.toJSON() : doc;

  const auditTrail = _doc.AuditTrail || [];
  const signers = _doc.Signers || [];
  const placeholders = _doc.Placeholders || [];

  // AuditTrail entry: { UserPtr: { objectId }, Activity, Signature, SignedUrl, SignedOn }
  const signedEntries = auditTrail.filter(e => e?.Activity === 'Signed' && e?.UserPtr?.objectId);

  const signerMap = {};

  for (const entry of signedEntries) {
    const objId = entry.UserPtr.objectId;

    // Resolve email from the Signers array (contracts_Contactbook)
    const signerContact = signers.find(s => (s.objectId || s.id) === objId);
    const email = (signerContact?.Email || '').toLowerCase();

    // Find this signer's placeholder entry to get field positions + responses
    const placeholder = placeholders.find(
      p => (p?.signerObjId || p?.signerPtr?.objectId) === objId
    );

    signerMap[objId] = {
      email,
      signatureBase64: entry.Signature || null, // base64 PNG of the signature drawn on the pad
      signedUrl: entry.SignedUrl || null,
      placeholder,
    };
  }

  return signerMap;
}

/**
 * Overlays one signer's signed fields onto the pdfDoc.
 *
 * Fields come from the placeholder.placeHolder array:
 *   [ { pageNumber, pos: [ { type, xPosition, yPosition, Width, Height, vpWidth, options: { response } } ] } ]
 *
 * For image types (signature, initials, stamp) the value is a base64 PNG in options.response.
 * For text types (name, job title, date, email, "weight factor", text, etc.) the value is a
 * string in options.response.
 *
 * If options.response is absent for a signature field, falls back to the AuditTrail Signature
 * base64 so legacy documents without per-field response still get rendered.
 */
async function overlaySignerFields(pdfDoc, placeholder, signerData, font) {
  if (!placeholder?.placeHolder) return;

  const pages = pdfDoc.getPages();
  const imgTypeWidgets = ['signature', 'stamp', 'initials', 'image', 'draw'];

  for (const phPage of placeholder.placeHolder) {
    // placeHolder entries use `pageNumber` (frontend convention).
    // Older server-side data may use `pageNo` — handle both.
    const rawPageNo = phPage.pageNumber ?? phPage.pageNo ?? 1;
    const page = pages[rawPageNo - 1];
    if (!page) continue;

    for (const pos of phPage.pos || []) {
      const response = pos?.options?.response;
      const type = pos.type || 'signature';

      // Skip fields with no value and no fallback
      if (!response && !(imgTypeWidgets.includes(type) && signerData.signatureBase64)) continue;

      const coords = widgetToPdfCoords(pos, page);

      try {
        if (imgTypeWidgets.includes(type)) {
          // Prefer per-field response; fall back to AuditTrail Signature for legacy
          const imgBase64 = response || signerData.signatureBase64;
          if (!imgBase64) continue;

          // Strip data-URI prefix if present
          const raw = imgBase64.replace(/^data:[^;]+;base64,/, '');
          const imgBytes = Buffer.from(raw, 'base64');

          // Detect PNG vs JPEG by magic bytes (0x89 0x50 = PNG header)
          const isPng = imgBytes[0] === 0x89 && imgBytes[1] === 0x50;
          const embeddedImg = isPng
            ? await pdfDoc.embedPng(imgBytes)
            : await pdfDoc.embedJpg(imgBytes);

          page.drawImage(embeddedImg, {
            x: coords.x,
            y: coords.y,
            width: coords.width,
            height: coords.height,
          });
        } else {
          // Text widget: name, job title, date, email, weight factor, text input, etc.
          const textValue = String(response ?? '');
          if (!textValue) continue;

          const fontSize = parseInt(pos?.options?.fontSize || 12, 10);
          const pdfColor = parseFontColor(pos?.options?.fontColor);

          page.drawText(textValue, {
            x: coords.x,
            // Vertically centre the text within the field box
            y: coords.y + coords.height / 2 - fontSize / 2,
            size: fontSize,
            font,
            color: pdfColor,
            maxWidth: coords.width,
          });
        }
      } catch (fieldErr) {
        console.error(
          `[resolutions] overlay field error type=${type} page=${rawPageNo}:`,
          fieldErr?.message || fieldErr
        );
        // Continue with remaining fields — one bad field must not abort the whole PDF
      }
    }
  }
}

/**
 * Parse a CSS-style colour string (hex #rrggbb / #rgb, or rgb(r,g,b)) into
 * pdf-lib's rgb().  Falls back to black on any parse failure.
 */
function parseFontColor(color) {
  if (!color) return rgb(0, 0, 0);
  try {
    if (color.startsWith('#')) {
      const hex = color.slice(1);
      const full = hex.length === 3
        ? hex.split('').map(c => c + c).join('')
        : hex;
      return rgb(
        parseInt(full.slice(0, 2), 16) / 255,
        parseInt(full.slice(2, 4), 16) / 255,
        parseInt(full.slice(4, 6), 16) / 255
      );
    }
    if (color.startsWith('rgb')) {
      const nums = color.match(/[\d.]+/g) || [];
      return rgb(
        parseFloat(nums[0] || 0) / 255,
        parseFloat(nums[1] || 0) / 255,
        parseFloat(nums[2] || 0) / 255
      );
    }
  } catch {
    // fall through to default
  }
  return rgb(0, 0, 0);
}

/**
 * Stamps a small "EXECUTED <date>" label in the top-right corner of every page.
 */
function stampExecutedBanner(pdfDoc, font, executedAt) {
  const dateStr = executedAt.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const label = `EXECUTED ${dateStr}`;
  const fontSize = 10;

  for (const page of pdfDoc.getPages()) {
    const { width, height } = page.getSize();
    const textWidth = font.widthOfTextAtSize(label, fontSize);
    const margin = 10;

    page.drawText(label, {
      x: width - textWidth - margin,
      y: height - fontSize - margin,
      size: fontSize,
      font,
      color: rgb(0.18, 0.55, 0.34), // dark green
    });
  }
}

/**
 * Marks the resolution as EXECUTED:
 *  1. Generates the executed PDF overlay (fatal — execution aborts if this fails)
 *  2. Updates resolutions_Threshold status → EXECUTED, stamps executedAt, and stores
 *     ExecutedFileUrl + SignedUrl on the document (fatal)
 *  3. Sends execution confirmation emails to all signers and the document owner (non-fatal)
 */
async function executeDocument(documentId) {
  const executedAt = new Date();
  const docPtr = { __type: 'Pointer', className: 'contracts_Document', objectId: documentId };

  // ── Step 1: generate the executed PDF (fatal — execution aborts if this fails) ──
  let executedFileUrl = null;

  // Fetch the document with all related signer and placeholder data
  const docQuery = new Parse.Query('contracts_Document');
  docQuery.include('ExtUserPtr');
  docQuery.include('Signers');
  const doc = await docQuery.get(documentId, { useMasterKey: true });

  const _doc = doc.toJSON();

  // Use the most recent signed PDF, falling back to the original upload
  const pdfUrl = _doc.SignedUrl || _doc.URL;
  if (!pdfUrl) {
    throw new Error('Document has no PDF URL (SignedUrl or URL)');
  }
  if (!pdfUrl.startsWith('https://')) {
    throw new Error('PDF URL must use HTTPS');
  }

  // Download the PDF bytes
  const pdfResponse = await axios.get(pdfUrl, {
    responseType: 'arraybuffer',
    maxContentLength: 50 * 1024 * 1024,
    maxBodyLength: 50 * 1024 * 1024,
    timeout: 30000,
  });
  const pdfBytes = Buffer.from(pdfResponse.data);

  // Load the document
  const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });

  // Embed a font for text overlays.  Use the same Times New Roman TTF used
  // elsewhere in the codebase (GenerateCertificate.js).
  pdfDoc.registerFontkit(fontkit);
  let font;
  const localFontPath = './font/times.ttf';
  if (fs.existsSync(localFontPath)) {
    const fontBytesData = fs.readFileSync(localFontPath);
    font = await pdfDoc.embedFont(fontBytesData, { subset: true });
  } else {
    // Fall back to the standard Times-Roman Type-1 font if the TTF is absent
    const { StandardFonts } = await import('pdf-lib');
    font = await pdfDoc.embedFont(StandardFonts.TimesRoman);
  }

  // Build the signer data map and overlay each signer's fields
  const signerMap = buildSignerDataMap(_doc);
  for (const signerData of Object.values(signerMap)) {
    if (signerData.placeholder) {
      await overlaySignerFields(pdfDoc, signerData.placeholder, signerData, font);
    }
  }

  // Stamp the EXECUTED banner on every page
  stampExecutedBanner(pdfDoc, font, executedAt);

  // Serialise to bytes
  const executedPdfBytes = await pdfDoc.save({ useObjectStreams: false });

  // Upload via the Parse file API (same pattern as PDF.js / generateCertificatebydocId.js)
  const docName = (_doc.Name || 'resolution')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .toLowerCase()
    .slice(0, 80);
  const uploadFilename = `executed_${docName}_${documentId}.pdf`;

  const fileRes = await parseUploadFile(
    uploadFilename,
    Buffer.from(executedPdfBytes),
    'application/pdf'
  );
  executedFileUrl = getSecureUrl(fileRes?.url)?.url || fileRes?.url;

  if (!executedFileUrl) {
    throw new Error('Failed to upload executed PDF');
  }
  console.log(`[resolutions] Executed PDF stored: ${executedFileUrl}`);

  // ── Step 2: mark EXECUTED + persist executedFileUrl (fatal) ──────────────────
  try {
    const tQuery = new Parse.Query('resolutions_Threshold');
    tQuery.equalTo('document', docPtr);
    const threshold = await tQuery.first({ useMasterKey: true });
    if (threshold) {
      threshold.set('status', 'EXECUTED');
      await threshold.save(null, { useMasterKey: true });
    }

    const docObj = new Parse.Object('contracts_Document');
    docObj.id = documentId;
    docObj.set('executedAt', executedAt);
    docObj.set('ExecutedFileUrl', executedFileUrl);
    docObj.set('SignedUrl', executedFileUrl); // update so existing download paths work
    await docObj.save(null, { useMasterKey: true });
  } catch (err) {
    console.error('[resolutions] executeDocument — failed to mark EXECUTED:', err);
    throw err;
  }

  // ── Step 3: send notification emails (non-fatal) ─────────────────────────────
  await sendExecutionNotification(documentId);

  console.log(`[resolutions] Document ${documentId} executed`);
}

/**
 * Sends a "resolution executed" notification email to all signers on the document
 * and to the document owner.
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

  // ── Validate required params ─────────────────────────────────────────────────
  if (!documentId) {
    throw new Parse.Error(Parse.Error.INVALID_QUERY, 'Missing required parameter: documentId');
  }
  if (typeof thresholdA !== 'number' || thresholdA < 0 || thresholdA > 1) {
    throw new Parse.Error(
      Parse.Error.INVALID_QUERY,
      'thresholdA must be a number between 0 and 1'
    );
  }
  if (typeof thresholdB !== 'number' || thresholdB < 0 || thresholdB > 1) {
    throw new Parse.Error(
      Parse.Error.INVALID_QUERY,
      'thresholdB must be a number between 0 and 1'
    );
  }
  if (!Array.isArray(signers) || signers.length === 0) {
    throw new Parse.Error(
      Parse.Error.INVALID_QUERY,
      'signers[] must be a non-empty array'
    );
  }

  // Validate each signer entry
  const signerEmailSet = new Set();
  for (let i = 0; i < signers.length; i++) {
    const s = signers[i];
    if (!s?.email) {
      throw new Parse.Error(
        Parse.Error.INVALID_QUERY,
        `signers[${i}].email is required`
      );
    }
    const emailNorm = s.email.toLowerCase();
    if (signerEmailSet.has(emailNorm)) {
      throw new Parse.Error(
        Parse.Error.INVALID_QUERY,
        `Duplicate signer email: ${s.email}`
      );
    }
    signerEmailSet.add(emailNorm);
    if (typeof s.weightGroupA !== 'number' || s.weightGroupA < 0) {
      throw new Parse.Error(
        Parse.Error.INVALID_QUERY,
        `signers[${i}].weightGroupA must be a non-negative number`
      );
    }
    if (typeof s.weightGroupB !== 'number' || s.weightGroupB < 0) {
      throw new Parse.Error(
        Parse.Error.INVALID_QUERY,
        `signers[${i}].weightGroupB must be a non-negative number`
      );
    }
  }

  // Validate each field entry
  const validFieldTypes = [
    'signature', 'initials', 'stamp', 'image', 'draw',
    'name', 'job title', 'company', 'date', 'email',
    'weight factor', 'text', 'textarea', 'number', 'checkbox', 'radio', 'dropdown',
  ];
  if (Array.isArray(fields)) {
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      if (!f?.signerEmail) {
        throw new Parse.Error(
          Parse.Error.INVALID_QUERY,
          `fields[${i}].signerEmail is required`
        );
      }
      // Validate signerEmail exists in signers[]
      const emailNorm = (f.signerEmail || '').toLowerCase();
      if (!signerEmailSet.has(emailNorm)) {
        throw new Parse.Error(
          Parse.Error.INVALID_QUERY,
          `fields[${i}].signerEmail "${f.signerEmail}" is not in signers[]`
        );
      }
      if (f.type && !validFieldTypes.includes(f.type)) {
        throw new Parse.Error(
          Parse.Error.INVALID_QUERY,
          `fields[${i}].type "${f.type}" is not a recognised field type`
        );
      }
      if (typeof f.page !== 'number' || f.page < 1) {
        throw new Parse.Error(
          Parse.Error.INVALID_QUERY,
          `fields[${i}].page must be a positive integer (1-indexed)`
        );
      }
      for (const dim of ['x', 'y', 'width', 'height']) {
        if (f[dim] !== undefined && typeof f[dim] !== 'number') {
          throw new Parse.Error(
            Parse.Error.INVALID_QUERY,
            `fields[${i}].${dim} must be a number`
          );
        }
      }
    }
  }

  try {
    const docPtr = { __type: 'Pointer', className: 'contracts_Document', objectId: documentId };

    // Verify the document exists before writing anything
    await new Parse.Query('contracts_Document').get(documentId, { useMasterKey: true });

    // ── Upsert resolutions_Threshold ──────────────────────────────────────────
    const tQuery = new Parse.Query('resolutions_Threshold');
    tQuery.equalTo('document', docPtr);
    const existing = await tQuery.first({ useMasterKey: true });

    const thresholdObj = existing || new Parse.Object('resolutions_Threshold');
    thresholdObj.set('document', Parse.Object.fromJSON({ ...docPtr, className: 'contracts_Document' }));
    thresholdObj.set('thresholdA', thresholdA);
    thresholdObj.set('thresholdB', thresholdB);
    // Preserve existing status on update; only set DRAFT on first creation.
    if (!existing) {
      thresholdObj.set('status', 'DRAFT');
    }
    const savedThreshold = await thresholdObj.save(null, { useMasterKey: true });
    const thresholdId = savedThreshold.id;

    // ── Upsert resolutions_SignerWeight records ───────────────────────────────
    // Destroy all existing weight records for this document and recreate them.
    // This is a hard cutover: if the signers list changes, the old records are
    // removed unconditionally rather than attempting a per-email upsert.
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
      sw.set('signerEmail', signer.email.toLowerCase());
      sw.set('weightGroupA', signer.weightGroupA);
      sw.set('weightGroupB', signer.weightGroupB);
      sw.set('excludedFromB', signer.excludedFromB ?? false);
      const savedSw = await sw.save(null, { useMasterKey: true });
      signerWeightIds.push(savedSw.id);
    }

    // ── Upsert field positions on contracts_Document.Placeholders ─────────────
    //
    // The OpenSign Placeholders format (one entry per signer):
    //   {
    //     signerObjId: string,       // objectId of contracts_Contactbook (empty for email-only)
    //     signerPtr: { objectId },   // pointer (empty for email-only)
    //     email: string,             // lowercase signer email
    //     Role: 'signer'|'prefill',
    //     placeHolder: [             // one entry per page that has fields
    //       {
    //         pageNumber: number,    // 1-indexed (matches frontend convention)
    //         pos: [                 // fields on this page
    //           {
    //             type: string,      // 'signature'|'name'|'date'|'weight factor'|etc.
    //             xPosition: number, // pixels from left of rendered container
    //             yPosition: number, // pixels from top of rendered container
    //             Width: number,     // widget width in rendered pixels
    //             Height: number,    // widget height in rendered pixels
    //             // vpWidth is intentionally absent at import time; executeDocument
    //             // defaults to page width which gives correct 1:1 pixel mapping.
    //             label: string,
    //             options: { response: '' },
    //           }
    //         ]
    //       }
    //     ]
    //   }
    //
    // Incoming fields use { page, x, y, width, height } as pixel values in the
    // rendered viewport; we store them under the frontend key names so the
    // overlay coordinate transform in executeDocument works without translation.
    let fieldCount = 0;

    if (Array.isArray(fields) && fields.length > 0) {
      // Group fields by signerEmail (normalised to lowercase)
      const fieldsByEmail = {};
      for (const f of fields) {
        const email = (f.signerEmail || '').toLowerCase();
        if (!fieldsByEmail[email]) fieldsByEmail[email] = [];
        fieldsByEmail[email].push(f);
        fieldCount++;
      }

      // Fetch the current document to read existing Placeholders
      const docFetch = await new Parse.Query('contracts_Document').get(documentId, {
        useMasterKey: true,
      });
      const existingPlaceholders = docFetch.get('Placeholders') || [];

      const updatedPlaceholders = [...existingPlaceholders];

      for (const [email, emailFields] of Object.entries(fieldsByEmail)) {
        // Find existing placeholder entry for this signer
        const existingIdx = updatedPlaceholders.findIndex(
          p => (p?.email || '').toLowerCase() === email
        );

        // Group fields by page number (1-indexed)
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
            // vpWidth omitted intentionally: executeDocument defaults to page width
            label: f.label || '',
            options: { response: '' },
          });
        }

        const placeHolderPages = Object.entries(pageMap).map(([pageNumber, pos]) => ({
          pageNumber: Number(pageNumber),
          pos,
        }));

        if (existingIdx >= 0) {
          // Upsert: replace placeHolder pages for this signer, preserve meta fields
          updatedPlaceholders[existingIdx] = {
            ...updatedPlaceholders[existingIdx],
            placeHolder: placeHolderPages,
          };
        } else {
          // New placeholder entry for a signer not yet in the document
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

    return {
      success: true,
      thresholdId,
      signerWeightCount: signerWeightIds.length,
      fieldCount,
    };
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
