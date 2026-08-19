import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { createServer, type Server } from "http";
import path from "path";
import fs from "fs";
import { randomUUID, scryptSync, randomBytes, timingSafeEqual, createHmac } from "crypto";
import multer from "multer";
import PDFDocument from "pdfkit";
import archiver from "archiver";
import { storage } from "./storage";
import { ghlService } from "./services/gohighlevel";
import { plaidService } from "./services/plaid";
import { chirpService, ChirpApiError } from "./services/chirp";
import { normalizeChirpTransactions, computeUnderwritingMetrics, detectMcaPatterns, type NormalizedTxn } from "./services/chirpInsights";
import { repConsoleService } from "./services/repConsole";
import { ObjectStorageService, ObjectNotFoundError } from "./objectStorage";
import { analyzeBankStatements, isOpenAIConfigured, parseApprovalEmail, parseContactSearchQuery, parseRepConsoleCommand, extractPositionTerms, extractPositionTermsFromPdfBuffer, generateUnderwritingSnapshot } from "./services/openai";
import { gmailService, type EmailMessage } from "./services/gmail";
import { googleSheetsService, type ApprovalRow } from "./services/googleSheets";
import { notifyMerchantNewMessage } from "./services/twilio";
import { fireSmsStageEvent } from "./sms-middleware";
import { triggerAppAbandoned, triggerApprovalCongratulations, triggerFundedCongratulations } from "./messaging-triggers";
import { createRequire } from "module";
import { pool, neonPool, db } from "./db";
import { loanApplications, pageVisits, serviceInterests, merchants } from "@shared/schema";
import { ilike, or, desc, sql, sql as drizzleSql } from "drizzle-orm";
const require = createRequire(import.meta.url);
const pdfParseModule = require("pdf-parse");
const PDFParse = pdfParseModule.PDFParse;
import { AGENTS, isRestrictedAgent } from "../shared/agents";
import { submitToGigFi, isGigFiConfigured, type GigFiLeadData } from "./services/gigfi";
import { sendMarketingNotification, buildAdsInquiryEmail, buildServicesInterestEmail, buildLeadPortalSignupEmail, buildAdminAlertEmail, sendPipelineReportEmail } from "./services/email";
import { evaluateLeadQualification } from "./services/leadQualification";
import { startLeadNurtureScheduler } from "./services/leadNurture";
import { syncApplicationToSalesforce, syncDecisionToSalesforce, syncUwSubmissionToSalesforce, syncAiSnapshotToSalesforce, promoteOpportunityToUnderwriting, recordEmailClickInSalesforce, syncRepAssignmentToSalesforce } from "./services/salesforce";
import { syncApplicationToDialer, syncDecisionToDialer } from "./services/dialerSync";
import { pollSalesforceChanges } from "./services/salesforcePoll";

// ─── SALESFORCE SYNC KILL-SWITCH ──────────────────────────────────────────────
// SF_APP_SYNC_ENABLED  — syncs new/updated applications to Salesforce on submit
// SF_SYNC_ENABLED      — syncs underwriting decisions + scheduled retry batch
const SF_APP_SYNC_ENABLED = true;
const SF_SYNC_ENABLED = false;
// ─────────────────────────────────────────────────────────────────────────────

import { z } from "zod";
import type { LoanApplication, MerchantBankSnapshot, RepCallStat } from "@shared/schema";

// Initialize Object Storage service for persistent file storage
const objectStorage = new ObjectStorageService();

// ── Ads Leads GHL sync state (in-memory, reset on restart) ──────────────────
const adsSyncState = {
  running: false,
  lastRunAt: null as string | null,
  lastAddedCount: 0,
  lastTotalFound: 0,
  lastError: null as string | null,
  nextRunAt: null as string | null,
  active: false,      // true while the timed job is scheduled for today
};

const GHL_LOCATION_ID_SYNC = "n778xwOps9t8Q34eRPfM";
const GHL_PRIVATE_TOKEN = process.env.GHL_PRIVATE_TOKEN;

async function ghlGetContactsByTag(tag: string): Promise<any[]> {
  const token = GHL_PRIVATE_TOKEN;
  if (!token) throw new Error("GHL_PRIVATE_TOKEN not set");
  const all: any[] = [];
  let page = 1;
  const pageLimit = 100;
  while (true) {
    const resp = await fetch("https://services.leadconnectorhq.com/contacts/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Version: "2021-07-28" },
      body: JSON.stringify({
        locationId: GHL_LOCATION_ID_SYNC,
        filters: [{ field: "tags", operator: "contains", value: tag }],
        pageLimit,
        page,
      }),
    });
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`GHL ${resp.status}: ${txt.slice(0, 200)}`);
    }
    const data = await resp.json();
    const contacts = data.contacts || [];
    all.push(...contacts);
    if (contacts.length < pageLimit) break;
    page++;
  }
  return all;
}

async function runAdsLeadsSync() {
  if (adsSyncState.running) return;
  adsSyncState.running = true;
  adsSyncState.lastError = null;
  try {
    const TAG = "clicked ads";
    const contacts = await ghlGetContactsByTag(TAG);
    adsSyncState.lastTotalFound = contacts.length;
    let added = 0;
    for (const c of contacts) {
      const email = (c.email || "").toLowerCase().trim();
      if (!email) continue;
      const firstName = c.firstName || c.first_name || "";
      const lastName = c.lastName || c.last_name || "";
      const phone = c.phone || "";
      const businessName = c.companyName || c.company_name || "";
      const result = await db.execute(sql`
        INSERT INTO ads_leads (email, first_name, last_name, phone, business_name, lead_type, last_activity, created_at)
        VALUES (${email}, ${firstName}, ${lastName}, ${phone || null}, ${businessName || null},
                'Clicked through Email', NOW(), NOW())
        ON CONFLICT (email) DO NOTHING
      `);
      if (String(result.rowCount) === "1") added++;
    }
    adsSyncState.lastAddedCount = added;
    adsSyncState.lastRunAt = new Date().toISOString();
    console.log(`[ADS-SYNC] GHL tag sync complete: found=${contacts.length} added=${added}`);
  } catch (err: any) {
    adsSyncState.lastError = err?.message || "Unknown error";
    console.error("[ADS-SYNC] GHL tag sync error:", err?.message);
  } finally {
    adsSyncState.running = false;
  }
}

// Log Object Storage status on startup
if (objectStorage.isConfigured()) {
  console.log("[OBJECT STORAGE] ✓ Configured and ready for bank statement uploads");
} else {
  console.warn("[OBJECT STORAGE] ⚠ NOT CONFIGURED - Files will be saved to local disk (ephemeral - will be lost on restart!)");
}

// Configure multer for bank statement uploads
const UPLOAD_DIR = path.join(process.cwd(), "server/uploads/bank-statements");
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB

// Ensure upload directory exists (fallback for when Object Storage is not configured)
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Use memory storage to handle files in memory, then upload to Object Storage or disk
const bankStatementUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "application/pdf") {
      cb(null, true);
    } else {
      cb(new Error("Only PDF files are allowed"));
    }
  },
});

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Tcg1!tcg";
const RECAPTCHA_SECRET_KEY = process.env.RECAPTCHA_SECRET_KEY;

// Helper to escape HTML to prevent XSS
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Helper to generate combined view token for an email
function generateCombinedViewToken(email: string): string {
  const crypto = require('crypto');
  const secret = process.env.COMBINED_VIEW_SECRET || process.env.SESSION_SECRET || 'bank-statement-view-secret';
  const encodedEmail = Buffer.from(email).toString('base64url');
  const signature = crypto
    .createHmac('sha256', secret)
    .update(email)
    .digest('hex')
    .substring(0, 32);
  return `${encodedEmail}.${signature}`;
}

// Helper to get the base URL for generating absolute URLs
function getBaseUrl(req: Request): string {
  // Check for environment variable first (for production deployments)
  if (process.env.APP_URL) {
    return process.env.APP_URL.replace(/\/$/, ''); // Remove trailing slash
  }
  
  // Check for Replit domains (production deployment)
  if (process.env.REPLIT_DOMAINS) {
    return `https://${process.env.REPLIT_DOMAINS.split(',')[0]}`;
  }
  
  // Construct from request headers
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  // Handle array case for x-forwarded-proto
  const protocolStr = Array.isArray(protocol) ? protocol[0] : protocol;
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:5000';
  const hostStr = Array.isArray(host) ? host[0] : host;
  return `${protocolStr}://${hostStr}`;
}

// Generate full application URL for GHL
function generateApplicationUrl(req: Request, applicationId: number | string): string {
  const baseUrl = getBaseUrl(req);
  return `${baseUrl}/agent/application/${applicationId}`;
}

const loginSchema = z.object({
  credential: z.string().min(1, "Credential is required"),
});

async function verifyRecaptcha(token: string): Promise<{ success: boolean; score?: number; error?: string }> {
  // Fail closed: if secret key is not configured, reject submission
  if (!RECAPTCHA_SECRET_KEY) {
    console.error("[RECAPTCHA] Secret key not configured - rejecting submission for security");
    return { success: false, error: "reCAPTCHA configuration error" };
  }

  try {
    const response = await fetch("https://www.google.com/recaptcha/api/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        secret: RECAPTCHA_SECRET_KEY,
        response: token,
      }),
    });

    const data = await response.json();
    console.log("[RECAPTCHA] Verification response:", data);

    if (data.success) {
      const score = data.score || 0;
      if (score >= 0.5) {
        console.log(`[RECAPTCHA] Verified successfully, score: ${score}`);
        return { success: true, score };
      } else {
        return { success: false, score, error: "Low reCAPTCHA score - possible bot" };
      }
    } else {
      const errorCodes: string[] = data["error-codes"] || [];
      // browser-error means reCAPTCHA couldn't execute in the user's browser
      // (ad blocker, privacy mode, network issue) — not a bot signal, allow through
      if (errorCodes.includes("browser-error") || errorCodes.includes("invalid-input-response")) {
        console.warn("[RECAPTCHA] browser-error — reCAPTCHA could not run in client browser, allowing submission");
        return { success: true, score: undefined };
      }
      return { success: false, error: errorCodes.join(", ") || "Verification failed" };
    }
  } catch (error) {
    // Fail open on network/API issues so legitimate users aren't blocked
    console.warn("[RECAPTCHA] Verification service unreachable — allowing submission:", error);
    return { success: true, score: undefined };
  }
}

// Validation schema for Plaid token exchange
const plaidExchangeSchema = z.object({
  publicToken: z.string().min(1, "Public token is required"),
  metadata: z.object({
    institution: z.object({
      name: z.string().optional(),
      institution_id: z.string().optional()
    }).optional()
  }).optional(),
  businessName: z.string().min(1, "Business name is required"),
  email: z.string().email("Valid email is required"),
  useAIAnalysis: z.boolean().optional().default(true)
});

// Helper function to generate funding report URL from application data
function generateFundingReportUrl(application: Partial<LoanApplication>): string {
  const params = new URLSearchParams();

  // Map application data to report URL parameters
  if (application.fullName) params.set('name', application.fullName);
  if (application.businessName) params.set('businessName', application.businessName);
  if (application.industry) params.set('industry', application.industry);

  // Convert time in business to months for the report
  if (application.timeInBusiness) {
    const timeMapping: Record<string, string> = {
      'Less than 3 months': '2',
      '3-5 months': '4',
      '6-12 months': '9',
      '1-2 years': '18',
      '2-5 years': '42',
      'More than 5 years': '72',
    };
    params.set('timeInBusiness', timeMapping[application.timeInBusiness] || '12');
  }

  // Monthly revenue (already numeric in database)
  if (application.monthlyRevenue) {
    params.set('monthlyRevenue', application.monthlyRevenue.toString());
  } else if (application.averageMonthlyRevenue) {
    params.set('monthlyRevenue', application.averageMonthlyRevenue.toString());
  }

  // Credit score - extract middle value from range if needed
  if (application.personalCreditScoreRange || application.creditScore) {
    const creditRange = application.personalCreditScoreRange || application.creditScore || '';
    const creditMapping: Record<string, string> = {
      '500 and below': '480',
      '500-549': '525',
      '550-599': '575',
      '600-649': '625',
      '650-719': '685',
      '720 or above': '750',
      'Not sure': '650',
    };
    params.set('creditScore', creditMapping[creditRange] || '650');
  }

  // Requested loan amount
  if (application.requestedAmount) {
    params.set('loanAmount', application.requestedAmount.toString());
  }

  return `/report?${params.toString()}`;
}

// Helper function to sanitize application data for database storage
// Parse combined City, State Zip string into components
function parseCityStateZip(csz: string | undefined | null): { city?: string; state?: string; zip?: string } {
  if (!csz || typeof csz !== 'string') return {};
  
  // Try pattern: "City, ST 12345" or "City, State 12345"
  const match = csz.match(/^(.+?),\s*([A-Za-z]{2,})\s+(\d{5}(?:-\d{4})?)$/);
  if (match) {
    return { city: match[1].trim(), state: match[2].trim(), zip: match[3].trim() };
  }
  
  // Try pattern without comma: "City ST 12345"
  const match2 = csz.match(/^(.+?)\s+([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/);
  if (match2) {
    return { city: match2[1].trim(), state: match2[2].trim(), zip: match2[3].trim() };
  }
  
  return {};
}

// Filter out empty/undefined/null values to prevent overwriting existing data
function filterEmptyValues(data: Record<string, any>): Record<string, any> {
  const filtered: Record<string, any> = {};
  for (const [key, value] of Object.entries(data)) {
    // Keep the value if it's not undefined or empty string.
    // null IS allowed through — it means "explicitly clear this field" (e.g. admin
    // edits a field back to blank). Filtering null here would prevent any field from
    // ever being cleared via the dashboard edit form.
    if (value !== undefined && value !== '') {
      filtered[key] = value;
    }
  }
  return filtered;
}

/**
 * Returns true if an application/update came from Guide Funding Group.
 * Checks agentName, referrerUrl, referralSource, trackingSource, and sourcePage
 * so that forms "beamed in" from guidefundinggroup.com are always caught.
 */
function isGFGSubmission(data: any): boolean {
  if (!data) return false;
  const GFG_DOMAIN = "guidefundinggroup.com";
  const GFG_NAME = "guide funding group";
  const check = (v: any) => typeof v === "string" && (
    v.toLowerCase().includes(GFG_DOMAIN) || v.toLowerCase().includes(GFG_NAME)
  );
  return (
    check(data.agentName) ||
    check(data.referrerUrl) ||
    check(data.referralSource) ||
    check(data.trackingSource) ||
    check(data.sourcePage) ||
    check(data.referrerUrl)
  );
}

/**
 * Returns true when an application/update came from inertiafunding.com.
 * The current external intake identifies itself as "Inertia Funding" in
 * agentName, but also check the source/referrer fields so future payload
 * mapping changes do not silently bypass CRM syncing.
 */
function isInertiaSubmission(data: any): boolean {
  if (!data) return false;
  const INERTIA_DOMAIN = "inertiafunding.com";
  const INERTIA_NAME = "inertia funding";
  const check = (v: any) => typeof v === "string" && (
    v.toLowerCase().includes(INERTIA_DOMAIN) || v.toLowerCase().includes(INERTIA_NAME)
  );
  return (
    check(data.agentName) ||
    check(data.referrerUrl) ||
    check(data.referralSource) ||
    check(data.trackingSource) ||
    check(data.sourcePage) ||
    check(data.utmSource)
  );
}

/**
 * Generic partner-site detection: every sub-brand intake site (Guide Funding
 * Group, Inertia, Equip Capital, Consolidate Capital Group, Expansion Capital
 * Partners, Apex Working Capital, and any future clone of the template) stamps
 * sourcePage with its slug. Any submission carrying sourcePage came from a
 * partner site and must fire the intake pipeline even without completion
 * flags — brand-by-brand string matching is what left the newer brands silent.
 */
function isPartnerSiteSubmission(data: any): boolean {
  if (!data) return false;
  return !!(data.sourcePage || data.source_page) || isGFGSubmission(data) || isInertiaSubmission(data);
}

/**
 * Sync an application to Salesforce and persist the result on the dashboard
 * record. This is intentionally fire-and-forget at call sites so an external
 * CRM outage never blocks an intake form or statement upload.
 */
async function syncApplicationToSalesforceAndPersist(app: LoanApplication): Promise<void> {
  if (!SF_APP_SYNC_ENABLED || !app?.id) return;

  try {
    const result = await syncApplicationToSalesforce(app);
    const syncUpdates: Record<string, any> = {
      sfSyncedAt: new Date(),
      sfSyncMessage: result.synced
        ? (result.action || "ok")
        : (result.error || result.reason || "sync-failed"),
    };
    if (result.accountId) syncUpdates.sfAccountId = result.accountId;
    if (result.contactId) syncUpdates.sfContactId = result.contactId;
    if (result.oppId) syncUpdates.sfOpportunityId = result.oppId;
    await storage.updateLoanApplication(app.id, syncUpdates as any);

    if (result.synced) {
      await syncApplicationToDialer(app, {
        accountId: result.accountId,
        contactId: result.contactId,
        oppId: result.oppId,
      }).catch(err => console.error("[Dialer Sync] Error:", err.message));
    } else {
      console.warn(`[SF Sync] Application sync failed for ${app.email}: ${result.error || result.reason}`);
    }
  } catch (err: any) {
    console.error(`[SF Sync] Background error for ${app.email}:`, err?.message || err);
    await storage.updateLoanApplication(app.id, {
      sfSyncedAt: new Date(),
      sfSyncMessage: err?.message || "sync-error",
    } as any).catch(() => {});
  }
}

/**
 * 5-minute delayed GHL owner lookup.
 * After intake webhook fires, wait 5 min, then find the GHL contact by phone/email,
 * read the assignedTo user, and write them as agentName on the application so
 * the rep can see the file in their dashboard.
 */
function scheduleGhlOwnerSync(appId: string | number, phone?: string | null, email?: string | null) {
  setTimeout(async () => {
    try {
      const result = await ghlService.resolveOwnerRepName(phone, email);
      if (!result) {
        console.log(`[GHL Owner Sync] No assigned owner found for app ${appId} (phone=${phone}, email=${email})`);
        return;
      }
      await storage.updateLoanApplication(appId as any, { agentName: result.repName, agentGhlId: result.userId } as any);
      console.log(`[GHL Owner Sync] Assigned rep "${result.repName}" to web lead app ${appId}`);
    } catch (err: any) {
      console.error(`[GHL Owner Sync] Error syncing owner for app ${appId}:`, err.message);
    }
  }, 5 * 60 * 1000);
  console.log(`[GHL Owner Sync] Scheduled owner lookup in 5 min for app ${appId}`);
}

// Recurring reconciler: the one-shot 5-minute lookup above dies with every
// server restart (each republish) and misses owners GHL assigns later than
// 5 minutes (round-robin workflows, manual claiming). Every 15 minutes,
// sweep the last 14 days of completed intakes still missing a rep and pull
// the current GHL owner onto the file.
let ghlOwnerReconcilerRunning = false;
async function reconcileGhlOwners() {
  if (ghlOwnerReconcilerRunning) return;
  ghlOwnerReconcilerRunning = true;
  try {
    const { neonPool } = await import("./db");
    if (!neonPool) return;
    const rows = await neonPool.query(
      `SELECT id, email, phone FROM loan_applications
       WHERE is_completed = true AND agent_name IS NULL AND agent_email IS NULL
         AND created_at >= NOW() - INTERVAL '14 days'
       ORDER BY created_at DESC LIMIT 60`
    );
    let assigned = 0;
    for (const app of rows.rows) {
      try {
        const result = await ghlService.resolveOwnerRepName(app.phone, app.email);
        if (result?.repName) {
          await storage.updateLoanApplication(app.id, { agentName: result.repName, agentGhlId: result.userId } as any);
          assigned++;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 300));
    }
    if (rows.rows.length > 0) {
      console.log(`[GHL Owner Reconciler] Checked ${rows.rows.length} rep-less intakes, assigned ${assigned}`);
    }
  } catch (err: any) {
    console.error(`[GHL Owner Reconciler] Error: ${err.message}`);
  } finally {
    ghlOwnerReconcilerRunning = false;
  }
}
setInterval(reconcileGhlOwners, 15 * 60 * 1000);
setTimeout(reconcileGhlOwners, 90 * 1000); // first pass shortly after each boot

function sanitizeApplicationData(data: any): { sanitized: any; recaptchaToken?: string; faxNumber?: string } {
  const { recaptchaToken, faxNumber, ...rest } = data;
  const sanitized = { ...rest };
  
  // Parse ownerCsz into separate fields if not already present
  if (sanitized.ownerCsz && (!sanitized.ownerCity || !sanitized.ownerState || !sanitized.ownerZip)) {
    const parsed = parseCityStateZip(sanitized.ownerCsz);
    if (parsed.city && !sanitized.ownerCity) sanitized.ownerCity = parsed.city;
    if (parsed.state && !sanitized.ownerState) sanitized.ownerState = parsed.state;
    if (parsed.zip && !sanitized.ownerZip) sanitized.ownerZip = parsed.zip;
    console.log(`[SANITIZE] Parsed ownerCsz "${sanitized.ownerCsz}" → city=${sanitized.ownerCity}, state=${sanitized.ownerState}, zip=${sanitized.ownerZip}`);
  }
  
  // Keep ownership columns in sync on creation / full-app submission
  if (sanitized.ownerPercentage !== undefined && sanitized.ownership === undefined) {
    sanitized.ownership = sanitized.ownerPercentage;
  } else if (sanitized.ownership !== undefined && sanitized.ownerPercentage === undefined) {
    sanitized.ownerPercentage = sanitized.ownership;
  }

  // Parse businessCsz into separate fields if not already present
  if (sanitized.businessCsz && (!sanitized.city || !sanitized.state || !sanitized.zipCode)) {
    const parsed = parseCityStateZip(sanitized.businessCsz);
    if (parsed.city && !sanitized.city) sanitized.city = parsed.city;
    if (parsed.state && !sanitized.state) sanitized.state = parsed.state;
    if (parsed.zip && !sanitized.zipCode) sanitized.zipCode = parsed.zip;
    console.log(`[SANITIZE] Parsed businessCsz "${sanitized.businessCsz}" → city=${sanitized.city}, state=${sanitized.state}, zip=${sanitized.zipCode}`);
  }
  
  console.log('[SANITIZE] timeInBusiness raw:', sanitized.timeInBusiness);
  console.log('[SANITIZE] monthlyRevenue raw:', sanitized.monthlyRevenue);
  
  // Convert string numeric fields to proper numbers or null
  const numericFields = [
    'monthlyRevenue',
    'averageMonthlyRevenue',
    'requestedAmount',
    'outstandingLoansAmount',
    'mcaBalanceAmount' // Add new field
  ];
  
  numericFields.forEach(field => {
    console.log(`[SANITIZE] Processing ${field}:`, sanitized[field], `(type: ${typeof sanitized[field]})`);
    
    if (sanitized[field] === '' || sanitized[field] === undefined || sanitized[field] === null) {
      sanitized[field] = null;
      console.log(`[SANITIZE] ${field} → NULL (empty/undefined)`);
    } else if (typeof sanitized[field] === 'string') {
      // Strip non-digit characters EXCEPT decimal point (like $ and ,) before parsing
      const cleanedValue = sanitized[field].replace(/[^0-9.]/g, '');
      const num = parseFloat(cleanedValue);
      sanitized[field] = (cleanedValue && !isNaN(num)) ? num : null;
      console.log(`[SANITIZE] ${field}: "${sanitized[field]}" → cleaned: "${cleanedValue}" → num: ${num} → final: ${sanitized[field]}`);
    }
  });
  
  // Handle currentStep specifically as an integer
  if (sanitized.currentStep !== undefined) {
    if (sanitized.currentStep === '' || sanitized.currentStep === null) {
      sanitized.currentStep = null;
    } else if (typeof sanitized.currentStep === 'string') {
      const num = parseInt(sanitized.currentStep, 10);
      sanitized.currentStep = isNaN(num) ? null : num;
    }
  }
  
  return { sanitized, recaptchaToken, faxNumber };
}

export async function registerRoutes(app: Express): Promise<Server> {
  // ── INDUSTRY PAGE REDIRECTS ────────────────────────────────────────────
  const industryRedirects = [
    "construction",
    "restaurant",
    "trucking",
    "auto-repair",
  ];
  for (const slug of industryRedirects) {
    app.get(`/industries/${slug}`, (_req: Request, res: Response) => {
      res.redirect(301, `https://fund.todaycapitalgroup.com/industries/${slug}`);
    });
  }

  // ── ADMIN PORTAL PREVIEW TOKENS (in-memory cache over portal_preview_tokens
  //    DB table, so tokens survive restarts; 30-min TTL) ──────────
  const adminPreviewTokens = new Map<string, { email: string; name: string; businessName: string; expiresAt: number }>();
  setInterval(() => {
    const now = Date.now();
    for (const [token, data] of adminPreviewTokens.entries()) {
      if (data.expiresAt <= now) adminPreviewTokens.delete(token);
    }
    db.execute(sql`DELETE FROM portal_preview_tokens WHERE expires_at < NOW()`).catch(() => {});
  }, 10 * 60 * 1000);

  async function getMerchantEmailFromRequest(req: any): Promise<string | null> {
    if (req.session.user?.isAuthenticated && req.session.user.role === 'merchant' && req.session.user.merchantEmail) {
      return req.session.user.merchantEmail;
    }
    const previewToken = req.headers['x-admin-preview-token'] as string | undefined;
    if (previewToken) {
      const preview = adminPreviewTokens.get(previewToken);
      if (preview && preview.expiresAt > Date.now()) return preview.email;
      // Cache miss (e.g. server restarted since the token was issued) — check the DB
      try {
        const r = await db.execute(sql`SELECT email, expires_at FROM portal_preview_tokens WHERE token = ${previewToken} AND expires_at > NOW()`);
        const row = r.rows[0] as any;
        if (row?.email) {
          adminPreviewTokens.set(previewToken, { email: row.email, name: "", businessName: "", expiresAt: new Date(row.expires_at).getTime() });
          return row.email;
        }
      } catch {}
    }
    return null;
  }

  // ── PORTAL ENGAGEMENT: fire-and-forget event log (portal_events table) ──
  const logPortalEvent = (portal: 'merchant' | 'lead', email: string, event: string, detail?: string) => {
    db.execute(sql`INSERT INTO portal_events (portal, email, event, detail) VALUES (${portal}, ${email.toLowerCase()}, ${event}, ${detail || null})`)
      .catch((err: any) => console.error('[PORTAL EVENT] insert failed:', err?.message || err));
  };
  const recordMerchantLogin = (email: string, method: string) => {
    logPortalEvent('merchant', email, 'login', method);
    db.execute(sql`UPDATE merchant_portal_accounts SET last_login_at = NOW(), login_count = COALESCE(login_count, 0) + 1 WHERE LOWER(email) = ${email.toLowerCase()}`)
      .catch(() => {});
  };

  // When a /track lead's business gets funded, carry them into the merchant
  // portal: mark the lead account converted and pre-create a portal account
  // (token only — staff still sends the invite from the Funded page).
  const autoProvisionPortalForFundedLead = async (businessEmail: string, businessName?: string | null) => {
    try {
      const email = (businessEmail || '').toLowerCase().trim();
      if (!email) return;
      const leadRes = await db.execute(sql`SELECT email, status, business_name FROM lead_portal_accounts WHERE email = ${email}`);
      const lead = leadRes.rows[0] as any;
      if (!lead) return;
      if (lead.status !== 'converted') {
        await db.execute(sql`UPDATE lead_portal_accounts SET status = 'converted' WHERE email = ${email}`);
      }
      const existing = await storage.getMerchantPortalAccountByEmail(email);
      if (!existing) {
        const token = randomBytes(32).toString('hex');
        await storage.createMerchantPortalAccount({
          email,
          businessName: businessName || lead.business_name || null,
          portalToken: token,
        } as any);
        logPortalEvent('merchant', email, 'portal_auto_provisioned', 'from /track lead');
        sendAdminMerchantAlert({
          title: "Track Lead Funded — Portal Ready to Invite",
          event: "lead_converted_portal_created",
          merchantEmail: email,
          businessName: businessName || lead.business_name || undefined,
          details: { note: "Lead account marked converted and a merchant portal was pre-created (no invite sent). Send the invite from the Funded page." },
        }).catch(() => {});
        console.log(`[PORTAL] Auto-provisioned merchant portal for funded /track lead ${email}`);
      }
    } catch (err: any) {
      console.error('[PORTAL] auto-provision for funded lead failed:', err?.message || err);
    }
  };

  // ========================================
  // HEALTH CHECK ENDPOINT (for deployment)
  // ========================================
  app.get("/api/health", (_req, res) => {
    res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
  });


  // ═══════════════════════════════════════════════════════════════
  // CLAUDE ADMIN DATA API — remote Claude instance access
  // Auth: X-Claude-API-Key header (value from CLAUDE_API_KEY env var)
  // ═══════════════════════════════════════════════════════════════

  function claudeAuth(req: Request, res: Response, next: NextFunction) {
    const key = req.headers['x-claude-api-key'] || req.query.apiKey;
    if (!process.env.CLAUDE_API_KEY || key !== process.env.CLAUDE_API_KEY) {
      return res.status(401).json({ error: "Invalid or missing X-Claude-API-Key header" });
    }
    next();
  }

  // Allowed tables for read/write (excludes sessions and raw auth tokens)
  const CLAUDE_READABLE_TABLES = [
    'loan_applications', 'business_underwriting_decisions', 'bank_statement_uploads',
    'lender_approvals', 'lenders', 'partners', 'merchant_messages', 'merchant_portal_accounts',
    'merchant_financial_insights', 'merchant_plaid_connections', 'plaid_items',
    'plaid_statements', 'funding_analyses', 'congratulations_uploads', 'visit_logs',
    'bot_attempts', 'system_settings', 'users',
  ];

  const CLAUDE_WRITABLE_TABLES = [
    'loan_applications', 'business_underwriting_decisions', 'bank_statement_uploads',
    'lender_approvals', 'lenders', 'partners', 'merchant_messages',
    'merchant_financial_insights', 'system_settings',
  ];

  // GET /api/admin/claude/ping — auth test
  // ---------------------------------------------------------------------------
  // Batch retry: re-sync all failed decisions to Salesforce
  // ---------------------------------------------------------------------------
  app.post("/api/admin/sf-retry-failed", async (req, res) => {
    const apiKey = req.headers["x-claude-api-key"] as string;
    const isAuthed = apiKey === process.env.CLAUDE_API_KEY || req.session?.user;
    if (!isAuthed) return res.status(401).json({ error: "Unauthorized" });

    try {
      // Get all decisions that failed or were never attempted
      const failed = await storage.getAllBusinessUnderwritingDecisions();
      const toRetry = failed.filter(d =>
        d.sfSynced === false || d.sfSyncedAt === null
      );

      let retried = 0, succeeded = 0, stillFailed = 0;

      for (const decision of toRetry) {
        try {
          const result = await syncDecisionToSalesforce(decision);
          retried++;

          await storage.updateBusinessUnderwritingDecision(decision.id, {
            sfSynced: result.synced,
            sfSyncedAt: new Date(),
            sfSyncMessage: result.error || (result.action || "ok"),
            sfOpportunityId: result.oppId || null,
          });

          if (result.synced) succeeded++;
          else stillFailed++;

          // Rate limit: small delay between API calls
          await new Promise(r => setTimeout(r, 200));
        } catch (err: any) {
          stillFailed++;
          console.error(`[SF Retry] Error for ${decision.businessName}:`, err.message);
        }
      }

      console.log(`[SF Retry] Done: retried=${retried}, succeeded=${succeeded}, failed=${stillFailed}`);
      return res.json({ ok: true, retried, succeeded, stillFailed, total: toRetry.length });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------------------
  // Manually sync a single application to Salesforce by ID or email
  // Body: { id?: string, email?: string }
  // ---------------------------------------------------------------------------
  app.post("/api/admin/sf-sync-application", async (req, res) => {
    const apiKey = req.headers["x-claude-api-key"] as string;
    const isAuthed = apiKey === process.env.CLAUDE_API_KEY || req.session?.user;
    if (!isAuthed) return res.status(401).json({ error: "Unauthorized" });

    const { id, email } = req.body;
    if (!id && !email) return res.status(400).json({ error: "body.id or body.email is required" });

    try {
      let application: any = null;
      if (id) {
        application = await storage.getLoanApplication(id);
      } else {
        application = await storage.getLoanApplicationByEmailOrPhone(email);
      }
      if (!application) return res.status(404).json({ error: "Application not found" });

      const sfResult = await syncApplicationToSalesforce(application);

      if (sfResult.synced && (sfResult.contactId || sfResult.oppId || sfResult.accountId)) {
        // Persist ALL returned IDs — this endpoint used to store only the
        // contact ID, leaving sf_opportunity_id null and re-exposing callers
        // to the re-match duplicate class (found 2026-08-12, needs-quiz E2E).
        await storage.updateLoanApplication(application.id, {
          ...(sfResult.contactId ? { sfContactId: sfResult.contactId } : {}),
          ...(sfResult.accountId ? { sfAccountId: sfResult.accountId } : {}),
          ...(sfResult.oppId ? { sfOpportunityId: sfResult.oppId } : {}),
          sfSyncedAt: new Date(),
          sfSyncMessage: sfResult.action || "manual-sync",
        } as any);
      } else if (!sfResult.synced) {
        await storage.updateLoanApplication(application.id, {
          sfSyncedAt: new Date(),
          sfSyncMessage: sfResult.error || sfResult.reason || "manual-sync-failed",
        } as any);
      }

      return res.json({ ok: true, applicationId: application.id, ...sfResult });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------------------
  // Re-sync UW submissions to Salesforce (find-or-create Opp per submission)
  // Body: { emails?: string[] }  — omit to sync all of today's submissions
  // ---------------------------------------------------------------------------
  app.post("/api/admin/sf-sync-uw", async (req, res) => {
    const apiKey = req.headers["x-claude-api-key"] as string;
    const isAuthed = apiKey === process.env.CLAUDE_API_KEY || req.session?.user;
    if (!isAuthed) return res.status(401).json({ error: "Unauthorized" });

    try {
      let emails: string[] = req.body?.emails || [];

      // Default: all applications submitted to UW today
      if (!emails.length) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const rows = await db.execute(sql`
          SELECT email FROM loan_applications
          WHERE uw_submitted_at >= ${today.toISOString()}
          ORDER BY uw_submitted_at DESC
        `);
        emails = (rows.rows as any[]).map((r: any) => r.email).filter(Boolean);
      }

      const results: Array<{ email: string; status: string; detail?: string }> = [];

      for (const rawEmail of emails) {
        const email = rawEmail.toLowerCase().trim();
        try {
          // Load application record
          const appRows = await db.execute(sql`
            SELECT * FROM loan_applications WHERE LOWER(email) = ${email} LIMIT 1
          `);
          const application = (appRows.rows?.[0] as any) ?? null;

          // Load saved AI snapshot if present
          const snapRows = await db.execute(sql`
            SELECT snapshot FROM underwriting_snapshots WHERE LOWER(email) = ${email} LIMIT 1
          `);
          const snapshot = (snapRows.rows?.[0] as any)?.snapshot ?? null;

          await syncUwSubmissionToSalesforce(email, application, { snapshot });
          results.push({ email, status: "ok" });
        } catch (err: any) {
          results.push({ email, status: "error", detail: err.message });
        }
        // Small delay to avoid SF rate limits
        await new Promise(r => setTimeout(r, 300));
      }

      console.log(`[SF UW Re-sync] Done: ${results.length} processed`);
      return res.json({ ok: true, processed: results.length, results });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------------------
  // Salesforce inbound poll — call periodically or via cron to sync SF → dashboard
  // ---------------------------------------------------------------------------
  app.post("/api/admin/sf-poll", async (req, res) => {
    // Auth: require Claude API key or admin session
    const apiKey = req.headers["x-claude-api-key"] as string;
    const isAuthed = apiKey === process.env.CLAUDE_API_KEY || req.session?.user;
    if (!isAuthed) return res.status(401).json({ error: "Unauthorized" });

    try {
      const result = await pollSalesforceChanges();
      return res.json({ ok: true, ...result });
    } catch (err: any) {
      console.error("[SF Poll] Endpoint error:", err.message);
      return res.status(500).json({ error: err.message });
    }
  });

  // POST /api/ghl-pipeline-reports — save a per-rep GHL pipeline analysis report
  app.post("/api/ghl-pipeline-reports", claudeAuth, async (req: Request, res: Response) => {
    try {
      const {
        repName, repEmail, reportDate, reportType, pipelineName,
        htmlContent, dealCount, staleCount, highCount, totalValue,
        avgDays, healthRating, dealsData
      } = req.body;

      if (!repName || !htmlContent) {
        return res.status(400).json({ error: "repName and htmlContent are required" });
      }

      const result = await db.execute(sql`
        INSERT INTO ghl_pipeline_reports
          (rep_name, rep_email, report_date, report_type, pipeline_name,
           html_content, deal_count, stale_count, high_count, total_value,
           avg_days, health_rating, deals_data)
        VALUES (${repName}, ${repEmail || null}, ${reportDate || new Date().toISOString().split('T')[0]},
                ${reportType || 'daily'}, ${pipelineName || '1. App Sent'},
                ${htmlContent}, ${dealCount || 0}, ${staleCount || 0}, ${highCount || 0},
                ${totalValue || 0}, ${avgDays || 0}, ${healthRating || null},
                ${JSON.stringify(dealsData || [])})
        RETURNING id
      `);
      const id = (result as any).rows?.[0]?.id;
      res.json({ success: true, id });
    } catch (err: any) {
      console.error("[GHL Pipeline Reports] Save error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/ghl-pipeline-snapshots — save the overarching company-wide pipeline snapshot
  app.post("/api/ghl-pipeline-snapshots", claudeAuth, async (req: Request, res: Response) => {
    try {
      const {
        reportDate, reportType, pipelineName, totalOpps, totalValue,
        totalStale30Plus, totalFresh7OrLess, totalUnassigned,
        oppsWithValue, avgDaysInStage, reportHtml, repSummary
      } = req.body;

      const result = await db.execute(sql`
        INSERT INTO ghl_pipeline_snapshots
          (report_date, pipeline_name, report_type, total_opps, total_value,
           total_stale_30_plus, total_fresh_7_or_less, total_unassigned,
           opps_with_value, avg_days_in_stage, report_html, rep_summary)
        VALUES (${reportDate || new Date().toISOString().split('T')[0]},
                ${pipelineName || '1. App Sent'}, ${reportType || 'daily'},
                ${totalOpps || 0}, ${totalValue || 0}, ${totalStale30Plus || 0},
                ${totalFresh7OrLess || 0}, ${totalUnassigned || 0},
                ${oppsWithValue || 0}, ${avgDaysInStage || 0},
                ${reportHtml || ''}, ${JSON.stringify(repSummary || [])})
        RETURNING id
      `);
      const id = (result as any).rows?.[0]?.id;
      res.json({ success: true, id });
    } catch (err: any) {
      console.error("[GHL Pipeline Snapshots] Save error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/ghl-pipeline-reports — retrieve saved reports (latest per rep, or by date)
  // Accepts either Claude API key OR authenticated session
  app.get("/api/ghl-pipeline-reports", async (req: Request, res: Response) => {
    const apiKey = req.headers['x-claude-api-key'] as string;
    const hasApiKey = apiKey && apiKey === process.env.CLAUDE_API_KEY;
    const hasSession = req.session?.user?.isAuthenticated;
    if (!hasApiKey && !hasSession) return res.status(401).json({ error: "Authentication required" });
    try {
      const repName = req.query.rep as string;
      const reportDate = req.query.date as string;
      const pipelineName = (req.query.pipeline as string) || '1. App Sent';

      if (repName) {
        // Get latest report for a specific rep
        const result = await db.execute(sql`
          SELECT * FROM ghl_pipeline_reports
          WHERE rep_name = ${repName} AND pipeline_name = ${pipelineName}
          ORDER BY created_at DESC LIMIT 1
        `);
        return res.json((result as any).rows?.[0] || null);
      }

      if (reportDate) {
        // Get all reports for a specific date
        const result = await db.execute(sql`
          SELECT id, rep_name, rep_email, report_date, report_type, pipeline_name,
                 deal_count, stale_count, high_count, total_value, avg_days,
                 health_rating, deals_data, created_at
          FROM ghl_pipeline_reports
          WHERE report_date = ${reportDate} AND pipeline_name = ${pipelineName}
          ORDER BY rep_name
        `);
        return res.json((result as any).rows);
      }

      // Default: latest report per rep
      const result = await db.execute(sql`
        SELECT DISTINCT ON (rep_name) id, rep_name, rep_email, report_date, report_type,
               pipeline_name, deal_count, stale_count, high_count, total_value, avg_days,
               health_rating, deals_data, created_at
        FROM ghl_pipeline_reports
        WHERE pipeline_name = ${pipelineName}
        ORDER BY rep_name, created_at DESC
      `);
      res.json((result as any).rows);
    } catch (err: any) {
      console.error("[GHL Pipeline Reports] Read error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/ghl-pipeline-reports/:id — retrieve a single report with HTML content
  app.get("/api/ghl-pipeline-reports/:id", async (req: Request, res: Response) => {
    const apiKey = req.headers['x-claude-api-key'] as string;
    const hasApiKey = apiKey && apiKey === process.env.CLAUDE_API_KEY;
    const hasSession = req.session?.user?.isAuthenticated;
    if (!hasApiKey && !hasSession) return res.status(401).json({ error: "Authentication required" });
    try {
      const result = await db.execute(sql`SELECT * FROM ghl_pipeline_reports WHERE id = ${parseInt(req.params.id)} LIMIT 1`);
      const row = (result as any).rows?.[0];
      if (!row) return res.status(404).json({ error: "Report not found" });
      res.json(row);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/ghl-pipeline-snapshots — retrieve saved snapshots
  app.get("/api/ghl-pipeline-snapshots", async (req: Request, res: Response) => {
    const apiKey = req.headers['x-claude-api-key'] as string;
    const hasApiKey = apiKey && apiKey === process.env.CLAUDE_API_KEY;
    const hasSession = req.session?.user?.isAuthenticated;
    if (!hasApiKey && !hasSession) return res.status(401).json({ error: "Authentication required" });
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 30, 100);
      const pipelineName = (req.query.pipeline as string) || '1. App Sent';

      const result = await db.execute(sql`
        SELECT id, report_date, pipeline_name, report_type, total_opps, total_value,
               total_stale_30_plus, total_fresh_7_or_less, total_unassigned,
               opps_with_value, avg_days_in_stage, rep_summary, created_at
        FROM ghl_pipeline_snapshots
        WHERE pipeline_name = ${pipelineName}
        ORDER BY report_date DESC
        LIMIT ${limit}
      `);
      res.json((result as any).rows);
    } catch (err: any) {
      console.error("[GHL Pipeline Snapshots] Read error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/claude/sf-query — run a read-only SOQL query against Salesforce
  app.post("/api/admin/claude/sf-query", claudeAuth, async (req, res) => {
    try {
      const { query: soql } = req.body;
      if (!soql || typeof soql !== "string") {
        return res.status(400).json({ error: "Body must include { query: 'SELECT ...' }" });
      }
      // Only allow SELECT / DESCRIBE
      const trimmed = soql.trim().toUpperCase();
      if (!trimmed.startsWith("SELECT") && !trimmed.startsWith("DESCRIBE")) {
        return res.status(400).json({ error: "Only SELECT and DESCRIBE queries are allowed" });
      }
      const { getAccessToken } = await import("./services/salesforce");
      const token = await getAccessToken();
      const SF_INSTANCE_URL = process.env.SF_INSTANCE_URL;
      if (!SF_INSTANCE_URL || !token) {
        return res.status(503).json({ error: "Salesforce not configured" });
      }
      // DESCRIBE uses a different endpoint pattern
      if (trimmed.startsWith("DESCRIBE")) {
        const objectName = soql.trim().split(/\s+/)[1];
        if (!objectName) return res.status(400).json({ error: "Usage: DESCRIBE ObjectName" });
        const sfRes = await fetch(`${SF_INSTANCE_URL}/services/data/v66.0/sobjects/${objectName}/describe`, {
          headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        });
        const data = await sfRes.json();
        if (!sfRes.ok) return res.status(sfRes.status).json(data);
        // Return just the fields array for readability
        const fields = (data as any).fields?.map((f: any) => ({
          name: f.name,
          label: f.label,
          type: f.type,
          length: f.length,
          custom: f.custom,
          updateable: f.updateable,
          picklistValues: f.picklistValues?.length > 0 ? f.picklistValues.map((p: any) => p.value) : undefined,
        })) || [];
        return res.json({ object: objectName, fieldCount: fields.length, fields });
      }
      // SELECT query
      const sfRes = await fetch(
        `${SF_INSTANCE_URL}/services/data/v66.0/query?q=${encodeURIComponent(soql)}`,
        { headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" } }
      );
      const data = await sfRes.json() as any;
      if (!sfRes.ok) return res.status(sfRes.status).json(data);
      res.json({ totalSize: data.totalSize, records: data.records });
    } catch (err: any) {
      console.error("[SF Query] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/admin/claude/ping", claudeAuth, (_req, res) => {
    res.json({ ok: true, message: "Claude API authenticated", timestamp: new Date().toISOString() });
  });

  // GET /api/admin/claude/context — full system context for Claude
  app.get("/api/admin/claude/context", claudeAuth, async (_req, res) => {
    try {
      const counts: Record<string, number> = {};
      for (const t of CLAUDE_READABLE_TABLES) {
        try {
          const r = await pool.query(`SELECT COUNT(*)::int AS n FROM ${t}`);
          counts[t] = r.rows[0]?.n ?? 0;
        } catch { counts[t] = -1; }
      }

      res.json({
        app: {
          name: "Today Capital Group — MCA Loan Platform",
          description: "Full-stack MCA (Merchant Cash Advance) loan management platform. Merchants apply for business funding, reps review/underwrite deals, and funded merchants get a portal to track their positions.",
          stack: "Node.js + Express backend, React + Vite frontend, PostgreSQL via Neon/Drizzle ORM, hosted on Replit",
          adminLogin: { url: "/", credential: "Tcg1!tcg", note: "Single credential field — not username/password" },
          merchantPortal: { url: "/merchant/portal", auth: "email + password or one-time token link" },
        },
        endpoints: {
          ping: "GET /api/admin/claude/ping — auth test",
          context: "GET /api/admin/claude/context — this document",
          readTable: "GET /api/admin/claude/table/:tableName?limit=50&offset=0&orderBy=created_at&order=DESC — read any table",
          sql: "POST /api/admin/claude/sql — body: { query: 'SELECT ...' } — read-only SQL",
          mutate: "POST /api/admin/claude/mutate — body: { sql: 'UPDATE ...', params: [] } — write SQL",
          upsert: "POST /api/admin/claude/upsert/:tableName — body: { where: {col: val}, set: {col: val} } — update matching rows",
          auth: "All requests need header: X-Claude-API-Key: <key>",
        },
        schema: {
          loan_applications: "Intake + full application form submissions. Key fields: id, email, businessName, status fields, isCompleted, isFullApplicationCompleted, agentEmail, createdAt",
          business_underwriting_decisions: "Underwriting outcomes per business. status: 'approved'|'declined'|'funded'. Funded deals have: advanceAmount, factorRate, totalPayback, lender, fundedDate, merchantEmail, merchantPortalToken. additionalFundings JSONB = array of stacked deals",
          bank_statement_uploads: "PDF bank statements uploaded by merchants or staff. viewToken = public share token",
          lender_approvals: "Approval offers parsed from lender emails. status: 'pending'|'accepted'|'declined'|'expired'",
          lenders: "Lender directory. tier A-D. isActive",
          partners: "Referral partners (CPAs, realtors etc). inviteCode used in referral URLs",
          merchant_messages: "In-portal messages between merchants and reps. senderRole: 'merchant'|'rep'",
          merchant_portal_accounts: "Portal login accounts. passwordHash set after first login. portalToken = one-time magic link",
          merchant_financial_insights: "Cached Plaid analysis results per merchant email",
          merchant_plaid_connections: "Links merchantEmail to Plaid item IDs",
          plaid_items: "Plaid access tokens + item IDs for bank connections",
          plaid_statements: "Plaid statement metadata (month/year/account)",
          funding_analyses: "AI-generated funding analysis from Plaid data",
          congratulations_uploads: "Voided check + driver's license uploads from the congratulations page",
          visit_logs: "Page visit tracking for contacts who click tracked links",
          bot_attempts: "Honeypot trigger logs (spam/bot detection)",
          system_settings: "Key-value feature flags. trigger.* keys control automated messaging",
          users: "Admin user accounts (rarely used — main auth is session-based with single credential)",
        },
        tableCounts: counts,
        keyBusinessLogic: [
          "Application flow: intake form → bank statements → full application → underwriting decision",
          "Funded flow: decision status='funded' → 'Setup Portal' button → portal created → 'Send Portal Invite' emails merchant → merchant logs in",
          "Automated triggers: system_settings keys like trigger.app_abandoned (all default false — must be enabled in /triggers admin page)",
          "Approval letters: generated at /approval/:slug — shareable public page",
          "GHL (GoHighLevel CRM) sync: ghlSynced/ghlOpportunityId on decisions and lender_approvals",
          "Admin roles: 'admin' and 'underwriting' can access all features; session stored in user_sessions table",
        ],
      });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // GET /api/admin/claude/table/:name — read any allowed table
  app.get("/api/admin/claude/table/:name", claudeAuth, async (req, res) => {
    const tableName = req.params.name;
    if (!CLAUDE_READABLE_TABLES.includes(tableName)) {
      return res.status(403).json({ error: `Table '${tableName}' not in allowed list`, allowed: CLAUDE_READABLE_TABLES });
    }
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 500);
    const offset = parseInt(req.query.offset as string) || 0;
    const orderBy = (req.query.orderBy as string) || 'created_at';
    const order = (req.query.order as string)?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    const search = req.query.search as string | undefined;

    try {
      // Get column names first
      const colRes = await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND table_schema = 'public' ORDER BY ordinal_position`,
        [tableName]
      );
      const columns = colRes.rows.map(r => r.column_name as string);

      // Check if orderBy column exists
      const safeOrderBy = columns.includes(orderBy) ? orderBy : (columns.includes('created_at') ? 'created_at' : columns[0]);

      let whereClause = '';
      const params: any[] = [limit, offset];

      if (search) {
        // Search across text columns
        const textCols = columns.filter(c => !['id'].includes(c)).slice(0, 6).map(c => `${c}::text ILIKE $3`).join(' OR ');
        if (textCols) {
          whereClause = `WHERE ${textCols}`;
          params.push(`%${search}%`);
        }
      }

      const q = `SELECT * FROM ${tableName} ${whereClause} ORDER BY ${safeOrderBy} ${order} LIMIT $1 OFFSET $2`;
      const result = await pool.query(q, params);

      const countRes = await pool.query(`SELECT COUNT(*)::int AS n FROM ${tableName} ${whereClause}`, search ? [`%${search}%`] : []);

      res.json({
        table: tableName,
        total: countRes.rows[0]?.n ?? 0,
        limit,
        offset,
        columns,
        rows: result.rows,
      });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // POST /api/admin/claude/sql — read-only SQL (SELECT only)
  app.post("/api/admin/claude/sql", claudeAuth, async (req, res) => {
    const { query, params = [] } = req.body;
    if (!query || typeof query !== 'string') {
      return res.status(400).json({ error: "body.query is required" });
    }
    const trimmed = query.trim().toUpperCase();
    if (!trimmed.startsWith('SELECT') && !trimmed.startsWith('WITH') && !trimmed.startsWith('EXPLAIN')) {
      return res.status(403).json({ error: "Only SELECT/WITH/EXPLAIN queries allowed. Use /mutate for writes." });
    }
    try {
      const result = await pool.query(query, params);
      res.json({ rows: result.rows, rowCount: result.rowCount });
    } catch (error: any) {
      // If table not found in main DB, try Neon dialer database
      if (neonPool && error?.message?.includes("does not exist")) {
        try {
          const neonResult = await neonPool.query(query, params);
          return res.json({ rows: neonResult.rows, rowCount: neonResult.rowCount, source: "neon" });
        } catch (neonError) {
          return res.status(500).json({ error: String(neonError) });
        }
      }
      res.status(500).json({ error: String(error) });
    }
  });

  // POST /api/admin/claude/dialer-sql
  app.post("/api/admin/claude/dialer-sql", claudeAuth, async (req: Request, res: Response) => {
    if (!neonPool) {
      return res.status(500).json({ error: "Neon database not configured" });
    }
    const { query: q, params: p = [] } = req.body;
    if (!q || typeof q !== "string") {
      return res.status(400).json({ error: "body.query is required" });
    }
    const trimmed = q.trim().toUpperCase();
    if (!trimmed.startsWith("SELECT") && !trimmed.startsWith("WITH") && !trimmed.startsWith("EXPLAIN")) {
      return res.status(403).json({ error: "Only SELECT/WITH/EXPLAIN queries allowed" });
    }
    try {
      const result = await neonPool.query(q, p);
      res.json({ rows: result.rows, rowCount: result.rowCount });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // POST /api/admin/claude/mutate — write SQL (UPDATE/INSERT/DELETE)
  app.post("/api/admin/claude/mutate", claudeAuth, async (req, res) => {
    const { sql: sqlStr, params = [] } = req.body;
    if (!sqlStr || typeof sqlStr !== 'string') {
      return res.status(400).json({ error: "body.sql is required" });
    }
    const upper = sqlStr.trim().toUpperCase();
    if (upper.startsWith('DROP') || upper.startsWith('TRUNCATE') || upper.startsWith('ALTER') || upper.startsWith('CREATE')) {
      return res.status(403).json({ error: "DDL statements (DROP/TRUNCATE/ALTER/CREATE) are not allowed" });
    }
    try {
      const result = await pool.query(sqlStr, params);
      res.json({ rowCount: result.rowCount, rows: result.rows });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // POST /api/admin/claude/ghl-add-tags — add tags to a GHL contact
  app.post("/api/admin/claude/ghl-add-tags", claudeAuth, async (req, res) => {
    const { contactId, tags } = req.body;
    if (!contactId || !Array.isArray(tags) || tags.length === 0) {
      return res.status(400).json({ error: "body.contactId and body.tags[] required" });
    }
    try {
      const result = await ghlService.addTagsToContact(contactId, tags);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // POST /api/admin/claude/upsert/:table — convenience: update rows matching a where clause
  // SAFETY: `where` with at least one key is REQUIRED — a missing or empty where would
  // otherwise run an unguarded UPDATE with no WHERE clause and overwrite every row.
  app.post("/api/admin/claude/upsert/:name", claudeAuth, async (req, res) => {
    const tableName = req.params.name;
    if (!CLAUDE_WRITABLE_TABLES.includes(tableName)) {
      return res.status(403).json({ error: `Table '${tableName}' not in writable list`, allowed: CLAUDE_WRITABLE_TABLES });
    }
    const { where, set } = req.body as { where: Record<string, any>; set: Record<string, any> };
    if (!set || Object.keys(set).length === 0) {
      return res.status(400).json({ error: "body.set is required" });
    }
    // Require at least one WHERE condition — without it the UPDATE would hit every row
    if (!where || Object.keys(where).length === 0) {
      return res.status(400).json({
        error: "body.where is required and must contain at least one condition. An empty where clause would update every row in the table.",
      });
    }
    try {
      const params: any[] = [];
      const setClauses = Object.entries(set).map(([k, v]) => { params.push(v); return `${k} = $${params.length}`; });
      const whereParts = Object.entries(where).map(([k, v]) => { params.push(v); return `${k} = $${params.length}`; });
      const q = `UPDATE ${tableName} SET ${setClauses.join(', ')} WHERE ${whereParts.join(' AND ')} RETURNING *`;
      const result = await pool.query(q, params);
      res.json({ rowCount: result.rowCount, rows: result.rows });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  // ═══════════════════════════════════════════════════════════════

  // ========================================
  // PAGE VISIT TRACKER (email-link click-throughs)
  // ========================================

  app.post("/api/analytics/track-visit", async (req: Request, res: Response) => {
    try {
      const { email, phone, interest, pagePath, fullUrl, referrer, utmSource, utmCampaign, utmMedium } = req.body;

      // Must have at least email or phone to be worth tracking
      if (!email && !phone) {
        return res.status(400).json({ error: "email or phone required" });
      }

      await db.insert(pageVisits).values({
        email: email?.toLowerCase()?.trim() || null,
        phone: phone?.trim() || null,
        interest: interest?.trim() || null,
        pagePath: pagePath || null,
        fullUrl: fullUrl || null,
        referrer: referrer || null,
        utmSource: utmSource || null,
        utmCampaign: utmCampaign || null,
        utmMedium: utmMedium || null,
      });

      console.log(`[VISIT] Tracked: ${email || phone} → ${pagePath}${interest ? ` (interest: ${interest})` : ""}`);
      return res.json({ ok: true });
    } catch (err: any) {
      console.error("[VISIT] Error tracking visit:", err.message);
      return res.status(500).json({ error: "Failed to track visit" });
    }
  });

  // GET /api/analytics/page-visits — admin view of tracked visits
  app.get("/api/analytics/page-visits", async (req: Request, res: Response) => {
    try {
      if (!req.session.user?.isAuthenticated || req.session.user.role !== "admin") {
        return res.status(401).json({ error: "Admin access required" });
      }
      const visits = await db.select().from(pageVisits).orderBy(sql`created_at DESC`).limit(500);
      return res.json({ visits });
    } catch (err: any) {
      console.error("[VISIT] Error fetching visits:", err.message);
      return res.status(500).json({ error: "Failed to fetch visits" });
    }
  });

  // POST /api/ads/inquiry — saves /ads page form submissions to the database
  app.post("/api/ads/inquiry", async (req: Request, res: Response) => {
    try {
      const { email, website, adSpend, interest, utmSource, utmCampaign } = req.body;
      if (!email) return res.status(400).json({ error: "Email is required" });

      await db.insert(serviceInterests).values({
        email: email.toLowerCase().trim(),
        service: "ads-consultation",
        otherDetails: JSON.stringify({ website: website || null, adSpend: adSpend || null, interest: interest || null }),
        source: utmSource || "direct",
        utmSource: utmSource || null,
        utmCampaign: utmCampaign || null,
      });

      console.log(`[ADS] Inquiry saved: ${email} | adSpend=${adSpend} | website=${website}`);
      const { subject: adsSub, html: adsHtml } = buildAdsInquiryEmail({ email, website, adSpend, interest, utmSource, utmCampaign });
      sendMarketingNotification(adsSub, adsHtml).catch(() => {});
      return res.json({ ok: true });
    } catch (err: any) {
      console.error("[ADS] Error saving inquiry:", err.message);
      return res.status(500).json({ error: "Failed to save inquiry" });
    }
  });

  // GET /api/ads/inquiries — admin view of all /ads form submissions
  app.get("/api/ads/inquiries", async (req: Request, res: Response) => {
    try {
      if (!req.session.user?.isAuthenticated || req.session.user.role === "merchant" || req.session.user.role === "lead") {
        return res.status(401).json({ error: "Admin access required" });
      }
      const rows = await db
        .select()
        .from(serviceInterests)
        .where(sql`service = 'ads-consultation'`)
        .orderBy(desc(serviceInterests.createdAt));
      return res.json({ inquiries: rows });
    } catch (err: any) {
      console.error("[ADS] Error fetching inquiries:", err.message);
      return res.status(500).json({ error: "Failed to fetch inquiries" });
    }
  });

  // GET /api/ads-leads — contacts from ads_leads table (seeded from CSV + form submissions)
  app.get("/api/ads-leads", async (req: Request, res: Response) => {
    try {
      if (!req.session.user?.isAuthenticated || req.session.user.role === "merchant" || req.session.user.role === "lead") {
        return res.status(401).json({ error: "Admin access required" });
      }
      const result = await db.execute(sql`SELECT * FROM ads_leads ORDER BY created_at DESC`);
      const toIso = (val: any) => {
        if (!val) return '';
        if (val instanceof Date) return val.toISOString();
        if (typeof val === 'string') return val;
        return String(val);
      };
      const contacts = result.rows.map((r: any) => ({
        id: String(r.id),
        name: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email || 'Unknown',
        businessName: r.business_name || '',
        email: r.email || '',
        phone: r.phone || '',
        city: r.city || '',
        state: r.state || '',
        monthlyRevenue: r.monthly_revenue || null,
        source: r.source || '',
        leadBatch: r.lead_batch || '',
        tags: [],
        leadType: r.lead_type || 'Clicked through Email',
        lastActivity: toIso(r.last_activity) || toIso(r.created_at),
        notes: r.notes || '',
      }));
      return res.json({ contacts, total: contacts.length });
    } catch (err: any) {
      console.error("[ADS-LEADS] Error fetching ads leads:", err.message);
      return res.status(500).json({ error: "Failed to fetch ads leads" });
    }
  });

  // GET /api/ads-leads/sync-status — returns last sync info
  app.get("/api/ads-leads/sync-status", (req: Request, res: Response) => {
    if (!req.session.user?.isAuthenticated || req.session.user.role === "merchant" || req.session.user.role === "lead") {
      return res.status(401).json({ error: "Admin access required" });
    }
    return res.json(adsSyncState);
  });

  // POST /api/ads-leads/sync — manually trigger a GHL tag sync
  app.post("/api/ads-leads/sync", async (req: Request, res: Response) => {
    if (!req.session.user?.isAuthenticated || req.session.user.role === "merchant" || req.session.user.role === "lead") {
      return res.status(401).json({ error: "Admin access required" });
    }
    if (adsSyncState.running) {
      return res.json({ ...adsSyncState, message: "Sync already in progress" });
    }
    runAdsLeadsSync();
    return res.json({ ...adsSyncState, message: "Sync started" });
  });

  // POST /api/ads-consultation/submit — /ads page form submission, adds to ads_leads
  app.post("/api/ads-consultation/submit", async (req: Request, res: Response) => {
    try {
      const { email, website, monthlySpend, intent } = req.body;
      if (!email) return res.status(400).json({ error: "Email is required" });
      const normalizedEmail = email.toLowerCase().trim();
      const notes = [website && `Website: ${website}`, monthlySpend && `Ad Spend: ${monthlySpend}`, intent && `Intent: ${intent}`].filter(Boolean).join(' | ');
      await db.execute(sql`
        INSERT INTO ads_leads (email, notes, lead_type, last_activity)
        VALUES (${normalizedEmail}, ${notes || null}, 'Form Submission', NOW())
        ON CONFLICT (email) DO UPDATE SET
          notes = EXCLUDED.notes,
          lead_type = CASE WHEN ads_leads.lead_type = 'Form Submission' THEN 'Form Submission' ELSE ads_leads.lead_type END,
          last_activity = NOW()
      `);
      console.log(`[ADS-LEADS] Form submission saved: ${normalizedEmail}`);
      return res.json({ ok: true });
    } catch (err: any) {
      console.error("[ADS-LEADS] Form submit error:", err.message);
      return res.status(500).json({ error: "Failed to save submission" });
    }
  });

  // ========================================
  // LEAD SOURCE ANALYTICS ENDPOINT
  // ========================================
  
  app.get("/api/analytics/lead-sources", async (req, res) => {
    try {
      // Only allow admin access
      if (!req.session.user?.isAuthenticated || req.session.user.role !== 'admin') {
        return res.status(401).json({ error: "Admin access required" });
      }
      
      // Get all applications with UTM data
      const applications = await storage.getAllLoanApplications();
      
      // Parse source patterns from referrer URLs
      const SOURCE_PATTERNS = [
        { pattern: /facebook\.com|fb\.com|fb\.me/i, source: "Facebook", medium: "social" },
        { pattern: /instagram\.com/i, source: "Instagram", medium: "social" },
        { pattern: /linkedin\.com|lnkd\.in/i, source: "LinkedIn", medium: "social" },
        { pattern: /twitter\.com|t\.co|x\.com/i, source: "Twitter/X", medium: "social" },
        { pattern: /tiktok\.com/i, source: "TikTok", medium: "social" },
        { pattern: /reddit\.com/i, source: "Reddit", medium: "social" },
        { pattern: /youtube\.com|youtu\.be/i, source: "YouTube", medium: "video" },
        { pattern: /google\.(com|co\.\w{2})/i, source: "Google", medium: "organic" },
        { pattern: /bing\.com/i, source: "Bing", medium: "organic" },
        { pattern: /yahoo\.com/i, source: "Yahoo", medium: "organic" },
        { pattern: /mail\.google\.com|gmail\.com/i, source: "Gmail", medium: "email" },
        { pattern: /outlook\.(com|live\.com)|hotmail\.com/i, source: "Outlook", medium: "email" },
        { pattern: /mailchimp\.com|list-manage\.com/i, source: "Mailchimp", medium: "email" },
        { pattern: /gohighlevel\.com|leadconnectorhq\.com|msgsndr\.com/i, source: "GoHighLevel", medium: "email" },
        { pattern: /replit\.com/i, source: "Replit", medium: "direct" },
      ];
      
      const detectSource = (referrer: string | null, utmSource: string | null): string => {
        // First check explicit UTM source
        if (utmSource) {
          return utmSource.charAt(0).toUpperCase() + utmSource.slice(1).toLowerCase();
        }
        
        // Then check referrer URL
        if (referrer) {
          for (const { pattern, source } of SOURCE_PATTERNS) {
            if (pattern.test(referrer)) {
              return source;
            }
          }
          // Try to extract domain
          try {
            const url = new URL(referrer);
            const domain = url.hostname.replace(/^www\./, '').split('.')[0];
            if (domain) return domain.charAt(0).toUpperCase() + domain.slice(1);
          } catch {}
        }
        
        return "Direct/Unknown";
      };
      
      // Build analytics
      const sourceBreakdown: Record<string, { count: number; completed: number; started: number; statements: number; leads: any[] }> = {};
      const formTypeBreakdown: Record<string, number> = {};
      const progressionBreakdown = { started: 0, completed: 0, statements: 0 };
      const timeline: { date: string; count: number }[] = [];
      const dateMap: Record<string, number> = {};
      
      applications.forEach(app => {
        const source = detectSource(app.referrerUrl || null, app.utmSource || null);
        
        // Initialize source if not exists
        if (!sourceBreakdown[source]) {
          sourceBreakdown[source] = { count: 0, completed: 0, started: 0, statements: 0, leads: [] };
        }
        
        // Check if statements exist using plaidItemId
        const hasStatements = !!app.plaidItemId;
        
        sourceBreakdown[source].count++;
        sourceBreakdown[source].leads.push({
          id: app.id,
          email: app.email,
          businessName: app.businessName,
          utmSource: app.utmSource,
          utmMedium: app.utmMedium,
          utmCampaign: app.utmCampaign,
          referrerUrl: app.referrerUrl,
          isCompleted: app.isFullApplicationCompleted,
          hasStatements,
          createdAt: app.createdAt,
        });
        
        // Track progression
        if (app.currentStep && app.currentStep >= 1) {
          sourceBreakdown[source].started++;
          progressionBreakdown.started++;
        }
        if (app.isFullApplicationCompleted) {
          sourceBreakdown[source].completed++;
          progressionBreakdown.completed++;
        }
        if (hasStatements) {
          sourceBreakdown[source].statements++;
          progressionBreakdown.statements++;
        }
        
        // Form type tracking - use formType field or infer from agentEmail
        const formTypeValue = (app as any).formType || (app.agentEmail ? 'Agent Application' : 'Full Application');
        formTypeBreakdown[formTypeValue] = (formTypeBreakdown[formTypeValue] || 0) + 1;
        
        // Timeline
        if (app.createdAt) {
          const date = new Date(app.createdAt).toISOString().split('T')[0];
          dateMap[date] = (dateMap[date] || 0) + 1;
        }
      });
      
      // Convert dateMap to sorted timeline array
      Object.entries(dateMap)
        .sort(([a], [b]) => a.localeCompare(b))
        .forEach(([date, count]) => timeline.push({ date, count }));
      
      // Convert source breakdown to array and sort by count
      const sourceStats = Object.entries(sourceBreakdown)
        .map(([source, data]) => ({
          source,
          count: data.count,
          completed: data.completed,
          started: data.started,
          statements: data.statements,
          conversionRate: data.count > 0 ? ((data.completed / data.count) * 100).toFixed(1) : '0',
          leads: data.leads.slice(0, 20), // Limit leads to 20 per source
        }))
        .sort((a, b) => b.count - a.count);
      
      res.json({
        totalLeads: applications.length,
        sourceStats,
        formTypeBreakdown,
        progressionBreakdown,
        timeline,
        utmCoverage: {
          withUtmSource: applications.filter(a => a.utmSource).length,
          withReferrer: applications.filter(a => a.referrerUrl).length,
          withAny: applications.filter(a => a.utmSource || a.referrerUrl).length,
        }
      });
    } catch (error) {
      console.error("Error fetching lead source analytics:", error);
      res.status(500).json({ error: "Failed to fetch analytics" });
    }
  });

  // ========================================
  // AUTHENTICATION ROUTES
  // ========================================
  
  // Login endpoint
  app.post("/api/auth/login", async (req, res) => {
    try {
      const validationResult = loginSchema.safeParse(req.body);
      if (!validationResult.success) {
        return res.status(400).json({ error: "Credential is required" });
      }
      
      // Trim whitespace from credential (handles copy/paste issues)
      const credential = validationResult.data.credential.trim();
      
      // Check admin password
      if (credential === ADMIN_PASSWORD) {
        req.session.user = {
          isAuthenticated: true,
          role: 'admin',
        };
        return res.json({ 
          success: true, 
          role: 'admin',
          message: 'Logged in as admin'
        });
      }
      
      // Check underwriting login
      const UNDERWRITING_EMAIL = 'underwriting@todaycapitalgroup.com';
      const UNDERWRITING_PASSWORD = 'Uwrite3!3uwrite';
      if (credential === UNDERWRITING_PASSWORD || credential.toLowerCase() === UNDERWRITING_EMAIL.toLowerCase()) {
        req.session.user = {
          isAuthenticated: true,
          role: 'underwriting',
          agentEmail: UNDERWRITING_EMAIL,
          agentName: 'Underwriting Team',
        };
        return res.json({ 
          success: true, 
          role: 'underwriting',
          agentName: 'Underwriting Team',
          agentEmail: UNDERWRITING_EMAIL,
          message: 'Logged in as Underwriting'
        });
      }
      
      // Check agent password (format: Tcg[initials], e.g., "Tcgdl" for Dillon LeBlanc)
      const agentPasswordMatch = credential.toLowerCase().match(/^tcg([a-z]{2})$/);
      if (agentPasswordMatch) {
        const initials = agentPasswordMatch[1];
        const agent = AGENTS.find(
          (a) => a.initials.toLowerCase() === initials
        );
        
        if (agent) {
          // Check if this agent should have restricted "user" role
          const role = isRestrictedAgent(agent.email) ? 'user' : 'agent';
          req.session.user = {
            isAuthenticated: true,
            role,
            agentEmail: agent.email,
            agentName: agent.name,
          };
          return res.json({ 
            success: true, 
            role,
            agentName: agent.name,
            agentEmail: agent.email,
            message: `Logged in as ${agent.name}`
          });
        }
      }
      
      // Legacy: Also check agent email for backwards compatibility
      const agent = AGENTS.find(
        (a) => a.email.toLowerCase() === credential.toLowerCase()
      );
      
      if (agent) {
        // Check if this agent should have restricted "user" role
        const role = isRestrictedAgent(agent.email) ? 'user' : 'agent';
        req.session.user = {
          isAuthenticated: true,
          role,
          agentEmail: agent.email,
          agentName: agent.name,
        };
        return res.json({ 
          success: true, 
          role,
          agentName: agent.name,
          agentEmail: agent.email,
          message: `Logged in as ${agent.name}`
        });
      }
      
      return res.status(401).json({ error: "Invalid credentials" });
    } catch (error) {
      console.error("Login error:", error);
      res.status(500).json({ error: "Login failed" });
    }
  });
  
  // Logout endpoint
  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy((err) => {
      if (err) {
        return res.status(500).json({ error: "Logout failed" });
      }
      res.json({ success: true, message: "Logged out" });
    });
  });
  
  // Check auth status
  app.get("/api/auth/check", (req, res) => {
    if (req.session.user?.isAuthenticated) {
      const response: any = {
        isAuthenticated: true,
        role: req.session.user.role,
      };

      // Include role-specific fields
      if (req.session.user.role === 'agent') {
        response.agentEmail = req.session.user.agentEmail;
        response.agentName = req.session.user.agentName;
      } else if (req.session.user.role === 'partner') {
        response.partnerId = req.session.user.partnerId;
        response.partnerEmail = req.session.user.partnerEmail;
        response.partnerName = req.session.user.partnerName;
        response.companyName = req.session.user.companyName;
      } else if (req.session.user.role === 'merchant') {
        response.merchantEmail = req.session.user.merchantEmail;
        response.merchantName = req.session.user.merchantName;
      }

      return res.json(response);
    }
    res.json({ isAuthenticated: false });
  });

  app.get("/api/agents", (req, res) => {
    if (!req.session.user?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }
    const agentList = AGENTS.map(a => ({ name: a.name, email: a.email }));
    res.json(agentList);
  });

  // Lookup application progress by email or phone
  app.post("/api/applications/progress", async (req, res) => {
    try {
      const { emailOrPhone } = req.body;
      
      if (!emailOrPhone || typeof emailOrPhone !== 'string' || emailOrPhone.trim().length < 3) {
        return res.status(400).json({ error: "Please provide a valid email address or phone number" });
      }
      
      const input = emailOrPhone.trim();
      
      // Find the most recent application by email or phone
      const application = await storage.getLoanApplicationByEmailOrPhone(input);
      
      if (!application) {
        return res.status(404).json({ error: "No application found with that email or phone number" });
      }
      
      // Get bank statement uploads for this email
      const bankStatements = await storage.getBankStatementUploadsByEmail(application.email);
      
      // Get Plaid connection status
      let hasPlaidConnection = false;
      if (application.plaidItemId) {
        const plaidItem = await storage.getPlaidItemById(application.plaidItemId);
        hasPlaidConnection = !!plaidItem;
      }
      
      // Determine progress status
      const progress = {
        intakeCompleted: application.isCompleted || false,
        applicationCompleted: application.isFullApplicationCompleted || false,
        bankStatementsUploaded: bankStatements.length > 0 || hasPlaidConnection,
        bankStatementCount: bankStatements.length,
        hasPlaidConnection,
        applicationId: application.id,
        businessName: application.businessName || application.legalBusinessName || '',
        email: application.email,
      };
      
      res.json(progress);
    } catch (error) {
      console.error("Error looking up application progress:", error);
      res.status(500).json({ error: "Failed to lookup progress" });
    }
  });

  // Get loan application by ID (for intake/application forms - no auth required for own app)
  app.get("/api/applications/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const application = await storage.getLoanApplication(id);
      
      if (!application) {
        return res.status(404).json({ error: "Application not found" });
      }
      
      res.json(application);
    } catch (error) {
      console.error("Error fetching application:", error);
      res.status(500).json({ error: "Failed to fetch application" });
    }
  });

  // Ensure submission-history table exists (one row per completed intake/full-app
  // submission — keeps a single file per business while tracking re-submissions)
  try {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS application_submissions (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      loan_application_id VARCHAR NOT NULL,
      email TEXT,
      submission_type TEXT NOT NULL,
      requested_amount DECIMAL(12,2),
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_application_submissions_app_id ON application_submissions (loan_application_id)`);
    await db.execute(sql`ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS last_submission_at TIMESTAMP`);
    // Backfill once: original submission row + last_submission_at for existing completed apps
    await db.execute(sql`INSERT INTO application_submissions (loan_application_id, email, submission_type, requested_amount, created_at)
      SELECT id, email,
             CASE WHEN is_full_application_completed THEN 'full_application' ELSE 'intake' END,
             requested_amount, created_at
      FROM loan_applications
      WHERE (is_completed = true OR is_full_application_completed = true)
        AND NOT EXISTS (SELECT 1 FROM application_submissions s WHERE s.loan_application_id = loan_applications.id)`);
    await db.execute(sql`UPDATE loan_applications SET last_submission_at = created_at WHERE last_submission_at IS NULL`);
  } catch (err) {
    console.error("[SUBMISSIONS] Failed to ensure application_submissions table:", err);
  }

  // Record a completed submission on a file and bump it to the top of the
  // dashboard. Dedupes within 1 hour per (application, type) so autosaves and
  // double-clicks don't create noise. Never throws.
  async function recordApplicationSubmission(
    loanApplicationId: string,
    email: string | null | undefined,
    submissionType: 'intake' | 'full_application',
    requestedAmount?: string | number | null,
  ): Promise<void> {
    try {
      const recent = await db.execute(
        sql`SELECT id FROM application_submissions
            WHERE loan_application_id = ${loanApplicationId}
              AND submission_type = ${submissionType}
              AND created_at >= NOW() - INTERVAL '1 hour'
            LIMIT 1`,
      );
      if (recent.rows.length === 0) {
        const amount = requestedAmount !== undefined && requestedAmount !== null && String(requestedAmount).trim() !== ''
          ? String(requestedAmount) : null;
        await db.execute(
          sql`INSERT INTO application_submissions (loan_application_id, email, submission_type, requested_amount)
              VALUES (${loanApplicationId}, ${email ? email.toLowerCase() : null}, ${submissionType}, ${amount})`,
        );
        console.log(`[SUBMISSIONS] Recorded ${submissionType} submission for app ${loanApplicationId}`);
      }
      // Always bump recency so the file surfaces at the top of the dashboard
      await db.execute(
        sql`UPDATE loan_applications SET last_submission_at = NOW() WHERE id = ${loanApplicationId}`,
      );
    } catch (err: any) {
      console.error(`[SUBMISSIONS] Failed to record submission for ${loanApplicationId}:`, err?.message || err);
    }
  }

  // --- Merchant find-or-create helper ---
  async function findOrCreateMerchant(
    email: string | null | undefined,
    phone: string | null | undefined,
    businessName: string | null | undefined,
  ): Promise<string | null> {
    const normEmail = email?.toLowerCase().trim() || null;
    const normPhone = phone?.replace(/\D/g, '') || null;
    const normBiz = businessName?.toLowerCase().trim() || null;
    if (!normEmail && !normPhone && !normBiz) return null;
    try {
      if (normEmail) {
        const r = await db.execute(sql`SELECT id FROM merchants WHERE LOWER(primary_email) = ${normEmail} LIMIT 1`);
        if (r.rows.length) return (r.rows[0] as any).id as string;
      }
      if (normPhone && normPhone.length >= 10) {
        const r = await db.execute(sql`
          SELECT id FROM merchants
          WHERE LENGTH(REGEXP_REPLACE(COALESCE(primary_phone,''),'[^0-9]','','g')) >= 10
            AND REGEXP_REPLACE(COALESCE(primary_phone,''),'[^0-9]','','g') = ${normPhone}
          LIMIT 1`);
        if (r.rows.length) return (r.rows[0] as any).id as string;
      }
      if (normBiz && normBiz.length > 2) {
        const r = await db.execute(sql`
          SELECT id FROM merchants
          WHERE LOWER(TRIM(COALESCE(business_name,''))) = ${normBiz}
          LIMIT 1`);
        if (r.rows.length) return (r.rows[0] as any).id as string;
      }
      const r = await db.execute(sql`
        INSERT INTO merchants (id, business_name, primary_email, primary_phone, created_at)
        VALUES (gen_random_uuid(), ${businessName || null}, ${normEmail},
                ${normPhone && normPhone.length >= 10 ? normPhone : null}, NOW())
        RETURNING id`);
      return (r.rows[0] as any).id as string;
    } catch (err: any) {
      console.error('[MERCHANT] find-or-create error:', err?.message);
      return null;
    }
  }

  // Create new loan application
  app.post("/api/applications", async (req, res) => {
    try {
      console.log(`[APP CREATE] Incoming businessName: "${req.body.businessName}", legalBusinessName: "${req.body.legalBusinessName}"`);
      const { sanitized: applicationData, recaptchaToken, faxNumber } = sanitizeApplicationData(req.body);
      console.log(`[APP CREATE] After sanitize businessName: "${applicationData.businessName}", legalBusinessName: "${applicationData.legalBusinessName}"`);

      // Honeypot detection - if faxNumber is filled, it's likely a bot
      if (faxNumber && faxNumber.trim() !== "") {
        console.warn("[HONEYPOT] Bot detected! Fax field was filled with:", faxNumber);

        // Log the bot attempt
        try {
          await storage.createBotAttempt({
            email: applicationData.email || null,
            ipAddress: req.ip || req.headers['x-forwarded-for']?.toString() || null,
            userAgent: req.headers['user-agent'] || null,
            honeypotValue: faxNumber,
            formType: 'application',
            additionalData: { businessName: applicationData.businessName, phone: applicationData.phone }
          });
        } catch (botLogError) {
          console.error("[HONEYPOT] Failed to log bot attempt:", botLogError);
        }

        // Return a fake success response to not alert the bot
        return res.json({
          id: "bot-detected-" + Date.now(),
          email: applicationData.email,
          isBotAttempt: true
        });
      }

      // Verify reCAPTCHA if token provided (for final submissions)
      if (recaptchaToken) {
        const recaptchaResult = await verifyRecaptcha(recaptchaToken);
        if (!recaptchaResult.success) {
          console.error("[RECAPTCHA] Verification failed:", recaptchaResult.error);
          return res.status(400).json({ error: "Security verification failed. Please try again." });
        }
        console.log("[RECAPTCHA] Verified successfully, score:", recaptchaResult.score);
      }

      // Validate required email field - only for final submissions or when no currentStep provided
      // When saving step-by-step, email may not be available yet (collected in later steps)
      // quizDraft:true means a background autosave from the fundability quiz before the contact form is filled
      if (!applicationData.email && !applicationData.currentStep && !applicationData.quizDraft) {
        return res.status(400).json({ error: "Email is required" });
      }

      // Step-based server-side validation for new applications - validate but ALWAYS save data
      // This ensures data is preserved even if validation fails
      let postStepValidationErrors: string[] = [];
      let postRequestedStep: number | undefined = undefined;
      
      if (applicationData.currentStep !== undefined && applicationData.currentStep !== null) {
        postRequestedStep = applicationData.currentStep;
        const currentStep = applicationData.currentStep;
        const isAgentFlow = !!(applicationData.agentName || applicationData.agentEmail);
        
        // AgentApplication has 2 steps with different field groupings than FullApplication
        const agentStepValidationRules: Record<number, { fields: { key: string; label: string; format?: 'ein' | 'ssn' | 'phone' | 'email' }[] }> = {
          1: {
            fields: [
              { key: 'legalBusinessName', label: 'Legal Business Name' },
              { key: 'companyEmail', label: 'Company Email', format: 'email' },
              { key: 'businessStartDate', label: 'Business Start Date' },
              { key: 'ein', label: 'EIN (Tax ID)', format: 'ein' },
              { key: 'industry', label: 'Industry' },
              { key: 'stateOfIncorporation', label: 'State of Incorporation' },
              { key: 'doYouProcessCreditCards', label: 'Credit Card Processing' },
              { key: 'businessStreetAddress', label: 'Business Address' },
              { key: 'city', label: 'Business City' },
              { key: 'state', label: 'Business State' },
              { key: 'zipCode', label: 'Business Zip Code' },
              { key: 'requestedAmount', label: 'Requested Amount' },
              { key: 'monthlyRevenue', label: 'Monthly Revenue' }
            ]
          }
        };
        
        // FullApplication has 11 steps with fields spread across steps
        const fullAppStepValidationRules: Record<number, { fields: { key: string; label: string; format?: 'ein' | 'ssn' | 'phone' | 'email' }[] }> = {
          1: { fields: [{ key: 'legalBusinessName', label: 'Legal Business Name' }] },
          2: { fields: [{ key: 'companyEmail', label: 'Company Email', format: 'email' }] },
          3: { fields: [{ key: 'businessStartDate', label: 'Business Start Date' }, { key: 'stateOfIncorporation', label: 'State of Incorporation' }] },
          4: { fields: [{ key: 'ein', label: 'EIN (Tax ID)', format: 'ein' }, { key: 'doYouProcessCreditCards', label: 'Credit Card Processing' }] },
          5: { fields: [{ key: 'industry', label: 'Industry' }] },
          6: { fields: [{ key: 'businessStreetAddress', label: 'Business Street Address' }] },
          7: { fields: [{ key: 'requestedAmount', label: 'Requested Amount' }] },
          8: { fields: [{ key: 'fullName', label: 'Full Name' }, { key: 'email', label: 'Email', format: 'email' }, { key: 'phone', label: 'Phone', format: 'phone' }, { key: 'ownership', label: 'Ownership Percentage' }] },
          9: { fields: [{ key: 'socialSecurityNumber', label: 'Social Security Number', format: 'ssn' }, { key: 'dateOfBirth', label: 'Date of Birth' }] },
          10: { fields: [{ key: 'ownerAddress1', label: 'Home Address' }, { key: 'ownerCity', label: 'City' }, { key: 'ownerState', label: 'State' }, { key: 'ownerZip', label: 'Zip Code' }] }
        };
        
        const stepValidationRules = isAgentFlow ? agentStepValidationRules : fullAppStepValidationRules;
        
        const stepRules = stepValidationRules[currentStep];
        if (stepRules) {
          for (const field of stepRules.fields) {
            const value = (applicationData as any)[field.key];
            
            if (!value || value.toString().trim() === '') {
              postStepValidationErrors.push(field.label);
              continue;
            }
            
            if (field.format === 'ein') {
              const digits = value.toString().replace(/\D/g, '');
              if (digits.length !== 9) {
                postStepValidationErrors.push(`${field.label} (must be 9 digits)`);
              }
            }
            if (field.format === 'ssn') {
              const digits = value.toString().replace(/\D/g, '');
              if (digits.length !== 9) {
                postStepValidationErrors.push(`${field.label} (must be 9 digits)`);
              }
            }
            if (field.format === 'phone') {
              const digits = value.toString().replace(/\D/g, '');
              if (digits.length < 10) {
                postStepValidationErrors.push(`${field.label} (must be at least 10 digits)`);
              }
            }
            if (field.format === 'email') {
              if (!value.includes('@') || !value.includes('.')) {
                postStepValidationErrors.push(`${field.label} (invalid format)`);
              }
            }
          }
          
          if (postStepValidationErrors.length > 0) {
            console.log(`[STEP VALIDATION] Step ${currentStep} has validation issues for new application`);
            console.log(`[STEP VALIDATION] Issues: ${postStepValidationErrors.join(', ')}`);
            // Don't update currentStep if validation fails - but still save data
            delete applicationData.currentStep;
          } else {
            console.log(`[STEP VALIDATION] Step ${currentStep} PASSED for new application`);
          }
        }
      }

      // Check if user already has any application (incomplete first, then any completed)
      const existingIncomplete = await storage.getLoanApplicationByEmail(applicationData.email);
      const existingApp = existingIncomplete || await storage.getAnyLoanApplicationByEmail(applicationData.email);
      if (existingApp) {
        // Always ensure agent view URL exists for all applications (use full URL for GHL)
        if (!existingApp.agentViewUrl || existingApp.agentViewUrl.startsWith('/')) {
          applicationData.agentViewUrl = generateApplicationUrl(req, existingApp.id);
        }

        // Generate funding report URL if intake is being completed
        if (applicationData.isCompleted && !existingApp.fundingReportUrl) {
          const mergedData = { ...existingApp, ...applicationData };
          applicationData.fundingReportUrl = generateFundingReportUrl(mergedData);
          console.log('[FUNDING REPORT] Generated URL for existing app:', applicationData.fundingReportUrl);
        }

        // Update existing application with new data instead of just returning old data
        // Filter out empty values to preserve previously entered data
        const filteredApplicationData = filterEmptyValues(applicationData);
        // A real drawn signature on file always beats a checkbox/typed consent from a
        // resubmission — keep the image (and its date) so the app stays wet-signed.
        if (
          String(existingApp.applicantSignature || '').startsWith('data:image') &&
          filteredApplicationData.applicantSignature &&
          !String(filteredApplicationData.applicantSignature).startsWith('data:image')
        ) {
          delete (filteredApplicationData as any).applicantSignature;
          delete (filteredApplicationData as any).signatureDate;
        }
        // Ensure merchant linkage if not yet set
        if (!existingApp.merchantId) {
          const mId = await findOrCreateMerchant(
            applicationData.email || existingApp.email,
            (applicationData.phone as string | undefined) || existingApp.phone,
            (applicationData.businessName as string | undefined) || (applicationData as any).legalBusinessName || existingApp.businessName,
          );
          if (mId) (filteredApplicationData as any).merchantId = mId;
        }
        const updatedApp = await storage.updateLoanApplication(existingApp.id, filteredApplicationData);

        // A completed intake on an existing file = a new submission. Record it
        // (instead of creating a duplicate record) and bump the file to the top.
        if (applicationData.isCompleted) {
          await recordApplicationSubmission(
            existingApp.id,
            applicationData.email || existingApp.email,
            'intake',
            applicationData.requestedAmount ?? existingApp.requestedAmount,
          );
        }

        const updatedOrExistingApp = updatedApp || existingApp;
        const isInertia = isInertiaSubmission(updatedOrExistingApp) || isInertiaSubmission(applicationData);

        // Inertia sends step-by-step records that may not be marked complete.
        // Keep Salesforce current for every pushed entry, not only final
        // submissions. ALSO sync any completed (re)submission on an existing
        // row — a returning lead who re-fills the intake months later was
        // previously invisible to Salesforce (found 2026-08-12 via a missed
        // $151k re-submission). syncApplicationToSalesforce self-dedupes: it
        // finds the existing Opp (stored id -> email -> phone) and updates it
        // in place with stage-promotion gating, so re-fires cannot duplicate.
        if ((isInertia || applicationData.isCompleted || applicationData.isFullApplicationCompleted) && updatedOrExistingApp) {
          syncApplicationToSalesforceAndPersist(updatedOrExistingApp).catch(() => {});
        }

        // Send webhook only (GHL API sync disabled for now)
        // Fire on first completion OR if it's been more than 7 days since the last intake submission
        // (allows a returning lead to re-enter the GHL workflow after a cooldown period)
        if (applicationData.isCompleted && updatedApp) {
          const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
          const lastSent = (existingApp as any).lastSubmissionAt
            ? new Date((existingApp as any).lastSubmissionAt)
            : null;
          const isFirstCompletion = !existingApp.isCompleted;
          const isCooledDown = !lastSent || lastSent < sevenDaysAgo;
          if (isFirstCompletion || isCooledDown) {
            ghlService.sendIntakeWebhook(updatedApp).catch(err =>
              console.error("Intake webhook error (non-blocking):", err)
            );
            // Always flag as web lead when intake completes (covers existing merchants too)
            if (applicationData.isCompleted) {
              storage.updateLoanApplication(updatedApp.id, { isWebLead: true } as any).catch(() => {});
            }
            // Schedule GHL owner sync only on first completion with no agent attribution
            if (isFirstCompletion && !existingApp.agentEmail && !existingApp.agentName) {
              scheduleGhlOwnerSync(updatedApp.id, updatedApp.phone, updatedApp.email);
            }
          }
        }

        // Incomplete Inertia submissions are still useful leads. Forward each
        // pushed form entry through the existing GHL partial-application
        // webhook instead of waiting for a completion flag.
        if (isInertia && !applicationData.isCompleted && updatedOrExistingApp) {
          ghlService.sendPartialApplicationWebhook(updatedOrExistingApp).catch(err =>
            console.error("[INERTIA] Partial application webhook error:", err)
          );
        }

        // Guide Funding Group: fire webhooks on update if GFG submission
        // Detected via agentName, referrerUrl (guidefundinggroup.com), referralSource, trackingSource, or sourcePage
        const updatedOrExisting = updatedApp || existingApp;
        const isGFGUpdate = isGFGSubmission(updatedOrExisting) || isGFGSubmission(applicationData);
        const isPartnerUpdate = isPartnerSiteSubmission(updatedOrExisting) || isPartnerSiteSubmission(applicationData);
        if (isPartnerUpdate && !isInertia && !applicationData.isCompleted && updatedApp) {
          console.log(`[GFG] Guide Funding Group update detected — firing intake webhook for ${updatedApp.email}`);
          ghlService.sendIntakeWebhook(updatedApp, "https://guidefundinggroup.com/").catch(err =>
            console.error("[GFG] Intake webhook error (non-blocking):", err)
          );

          // Also create/update via GHL API to get and store the contact ID
          // (webhook is fire-and-forget; API gives us back the ID for future syncs)
          if (!updatedApp.ghlContactId) {
            ghlService.createOrUpdateContact(updatedApp as any).then(contactId => {
              if (contactId && updatedApp.id) {
                storage.updateLoanApplication(updatedApp.id, { ghlContactId: contactId } as any);
                console.log(`[GFG] Stored GHL contact ID ${contactId} for ${updatedApp.email}`);
              }
            }).catch(err => console.error("[GFG] GHL API contact creation error (non-blocking):", err));
          }

          const hasFullAppData = !!(updatedApp as any).socialSecurityNumber && !!(updatedApp as any).dateOfBirth;
          if (hasFullAppData) {
            console.log(`[GFG] Full application data detected on update — firing full application webhook for ${updatedApp.email}`);
            ghlService.sendWebhook(updatedApp).catch(err =>
              console.error("[GFG] Full application webhook error (non-blocking):", err)
            );
          }
        }

        // Return with validation errors if any (data was still saved)
        if (postStepValidationErrors.length > 0) {
          return res.json({
            ...(updatedApp || existingApp),
            validationFailed: true,
            validationErrors: postStepValidationErrors,
            requestedStep: postRequestedStep
          });
        }
        return res.json(updatedApp || existingApp);
      }

      // Create new application
      const application = await storage.createLoanApplication(applicationData);

      // Always generate agent view URL for all applications (use full URL for GHL)
      const agentViewUrl = generateApplicationUrl(req, application.id);

      // Generate funding report URL if intake is being completed
      let fundingReportUrl: string | undefined;
      if (applicationData.isCompleted) {
        fundingReportUrl = generateFundingReportUrl(application);
        console.log('[FUNDING REPORT] Generated URL for new app:', fundingReportUrl);
      }

      // Assign merchant (find existing or create new)
      const newMerchantId = await findOrCreateMerchant(
        applicationData.email,
        applicationData.phone as string | undefined,
        (applicationData.businessName as string | undefined) || (applicationData as any).legalBusinessName,
      );

      // Flag web leads: anyone who submits the intake/quiz form
      const isWebLead = !!applicationData.isCompleted;

      // Update with agentViewUrl, fundingReportUrl, and merchantId
      const updatedApp = await storage.updateLoanApplication(application.id, {
        agentViewUrl,
        ...(fundingReportUrl && { fundingReportUrl }),
        ...(newMerchantId && { merchantId: newMerchantId }),
        ...(isWebLead && { isWebLead: true }),
      });

      // Record the first submission when the intake completes in one shot
      if (applicationData.isCompleted) {
        await recordApplicationSubmission(application.id, applicationData.email, 'intake', applicationData.requestedAmount);
      }

      // Sync every new dashboard application to Salesforce and persist the
      // returned IDs/status. This includes external Inertia submissions.
      syncApplicationToSalesforceAndPersist(updatedApp || application).catch(() => {});

      // Also sync to dialer even without SF (for business field updates)
      syncApplicationToDialer(updatedApp || application).catch(err =>
        console.error("[Dialer Sync] Error:", err.message)
      );
      
      // Only send intake webhook when explicitly completed
      if (applicationData.isCompleted) {
        try {
          await ghlService.sendIntakeWebhook(updatedApp || application);
        } catch (webhookError) {
          console.error("Intake webhook error (non-blocking):", webhookError);
        }
        // Schedule 5-min delayed GHL owner lookup only when no agent was attributed
        if (isWebLead && !applicationData.agentEmail && !applicationData.agentName) {
          const _app = updatedApp || application;
          scheduleGhlOwnerSync(_app.id, _app.phone, _app.email);
        }
        // SMS: app_submitted
        const _smsApp = updatedApp || application;
        if (_smsApp?.phone) {
          const _smsParts = (_smsApp.fullName || '').trim().split(' ');
          fireSmsStageEvent({
            stage: 'app_submitted',
            phone: _smsApp.phone,
            email: _smsApp.email || undefined,
            first_name: _smsParts[0] || undefined,
            last_name: _smsParts.slice(1).join(' ') || undefined,
            business_name: _smsApp.businessName || (_smsApp as any).legalBusinessName || undefined,
            deal_id: _smsApp.id,
          });
        }

        // Auto-create portal account after intake form completion
        if (_smsApp?.email) {
          autoCreatePortalAccount({
            email: _smsApp.email,
            name: _smsApp.fullName || undefined,
            phone: _smsApp.phone || undefined,
            businessName: _smsApp.businessName || (_smsApp as any).legalBusinessName || undefined,
            applicationId: _smsApp.id,
            triggerKey: 'trigger.portal_after_intake',
            sendLink: true,
          });
        }
      }

      const finalApp = updatedApp || application;
      const isInertia = isInertiaSubmission(finalApp) || isInertiaSubmission(applicationData);
      if (isInertia && !applicationData.isCompleted) {
        ghlService.sendPartialApplicationWebhook(finalApp).catch(err =>
          console.error("[INERTIA] Partial application webhook error:", err)
        );
      }

      // Guide Funding Group: always fire intake webhook when a GFG submission arrives,
      // even if isCompleted isn't set (GFG sends data without completion flags).
      // Detected via agentName, referrerUrl (guidefundinggroup.com), referralSource, trackingSource, or sourcePage.
      const isGFG = isGFGSubmission(finalApp) || isGFGSubmission(applicationData);
      const isPartnerSite = isPartnerSiteSubmission(finalApp) || isPartnerSiteSubmission(applicationData);
      if (isPartnerSite && !isInertia && !applicationData.isCompleted) {
        console.log(`[GFG] Guide Funding Group submission detected — firing intake webhook for ${finalApp.email}`);
        ghlService.sendIntakeWebhook(finalApp, "https://guidefundinggroup.com/").catch(err =>
          console.error("[GFG] Intake webhook error (non-blocking):", err)
        );

        // Also create/update via GHL API to get and store the contact ID
        // (webhook is fire-and-forget; API gives us back the ID for future syncs)
        if (!finalApp.ghlContactId) {
          ghlService.createOrUpdateContact(finalApp as any).then(contactId => {
            if (contactId && finalApp.id) {
              storage.updateLoanApplication(finalApp.id, { ghlContactId: contactId } as any);
              console.log(`[GFG] Stored GHL contact ID ${contactId} for ${finalApp.email}`);
            }
          }).catch(err => console.error("[GFG] GHL API contact creation error (non-blocking):", err));
        }

        // If GFG submission has full application data (SSN, DOB, address present), also fire the full application webhook
        const hasFullAppData = !!(finalApp as any).socialSecurityNumber && !!(finalApp as any).dateOfBirth;
        if (hasFullAppData) {
          console.log(`[GFG] Full application data detected — firing full application webhook for ${finalApp.email}`);
          ghlService.sendWebhook(finalApp).catch(err =>
            console.error("[GFG] Full application webhook error (non-blocking):", err)
          );
        }
      }

      // Return with validation errors if any (data was still saved)
      if (postStepValidationErrors.length > 0) {
        return res.json({
          ...(updatedApp || application),
          validationFailed: true,
          validationErrors: postStepValidationErrors,
          requestedStep: postRequestedStep
        });
      }
      res.json(updatedApp || application);
    } catch (error) {
      console.error("Error creating application:", error);
      res.status(500).json({ error: "Failed to create application" });
    }
  });

  // Update loan application
  app.patch("/api/applications/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const { sanitized: updates, recaptchaToken } = sanitizeApplicationData(req.body);

      // Authorization check for dashboard edits (when user is authenticated)
      // Agents can only edit their own applications, admins can edit any
      if (req.session.user?.isAuthenticated) {
        if (req.session.user.role === 'agent' && req.session.user.agentEmail) {
          const existingApp = await storage.getLoanApplication(id);
          if (existingApp && existingApp.agentEmail &&
              existingApp.agentEmail.toLowerCase() !== req.session.user.agentEmail.toLowerCase()) {
            return res.status(403).json({ error: "You can only edit applications assigned to you" });
          }
        }
      }

      // Step-based server-side validation - validate but ALWAYS save data first
      // This ensures data is preserved even if validation fails
      let stepValidationErrors: string[] = [];
      let requestedStep: number | undefined = undefined;
      
      if (updates.currentStep !== undefined && updates.currentStep !== null) {
        requestedStep = updates.currentStep;
        const existingApp = await storage.getLoanApplication(id);
        const mergedData = { ...existingApp, ...updates };
        const currentStep = updates.currentStep;
        // Sales-rep attribution is not enough to identify the two-step agent
        // flow: a full application can also be opened from a rep link. Prefer
        // the explicit client marker and retain the old attribution fallback
        // for applications created before the marker was introduced.
        const isAgentFlow = updates.formType === 'agent_application'
          || (updates.formType !== 'full_application' && existingApp?.formType !== 'full_application'
            && !!(updates.agentName || updates.agentEmail || existingApp?.agentEmail));
        
        // AgentApplication has 2 steps with different field groupings than FullApplication
        const agentStepValidationRules: Record<number, { fields: { key: string; label: string; format?: 'ein' | 'ssn' | 'phone' | 'email' }[] }> = {
          1: {
            fields: [
              { key: 'legalBusinessName', label: 'Legal Business Name' },
              { key: 'companyEmail', label: 'Company Email', format: 'email' },
              { key: 'businessStartDate', label: 'Business Start Date' },
              { key: 'ein', label: 'EIN (Tax ID)', format: 'ein' },
              { key: 'industry', label: 'Industry' },
              { key: 'stateOfIncorporation', label: 'State of Incorporation' },
              { key: 'doYouProcessCreditCards', label: 'Credit Card Processing' },
              { key: 'businessStreetAddress', label: 'Business Address' },
              { key: 'city', label: 'Business City' },
              { key: 'state', label: 'Business State' },
              { key: 'zipCode', label: 'Business Zip Code' },
              { key: 'requestedAmount', label: 'Requested Amount' },
              { key: 'monthlyRevenue', label: 'Monthly Revenue' }
            ]
          }
        };
        
        // FullApplication has 11 steps with fields spread across steps
        const fullAppStepValidationRules: Record<number, { fields: { key: string; label: string; format?: 'ein' | 'ssn' | 'phone' | 'email' }[] }> = {
          1: { fields: [{ key: 'legalBusinessName', label: 'Legal Business Name' }] },
          2: { fields: [{ key: 'companyEmail', label: 'Company Email', format: 'email' }] },
          3: { fields: [{ key: 'businessStartDate', label: 'Business Start Date' }, { key: 'stateOfIncorporation', label: 'State of Incorporation' }] },
          4: { fields: [{ key: 'ein', label: 'EIN (Tax ID)', format: 'ein' }, { key: 'doYouProcessCreditCards', label: 'Credit Card Processing' }] },
          5: { fields: [{ key: 'industry', label: 'Industry' }] },
          6: { fields: [{ key: 'businessStreetAddress', label: 'Business Street Address' }] },
          7: { fields: [{ key: 'requestedAmount', label: 'Requested Amount' }] },
          8: { fields: [{ key: 'fullName', label: 'Full Name' }, { key: 'email', label: 'Email', format: 'email' }, { key: 'phone', label: 'Phone', format: 'phone' }, { key: 'ownership', label: 'Ownership Percentage' }] },
          9: { fields: [{ key: 'socialSecurityNumber', label: 'Social Security Number', format: 'ssn' }, { key: 'dateOfBirth', label: 'Date of Birth' }] },
          10: { fields: [{ key: 'ownerAddress1', label: 'Home Address' }, { key: 'ownerCity', label: 'City' }, { key: 'ownerState', label: 'State' }, { key: 'ownerZip', label: 'Zip Code' }] }
        };
        
        const stepValidationRules = isAgentFlow ? agentStepValidationRules : fullAppStepValidationRules;
        
        const stepRules = stepValidationRules[currentStep];
        if (stepRules) {
          for (const field of stepRules.fields) {
            const value = (mergedData as any)[field.key];
            
            // Check if field has a value (only check for presence, not format)
            if (!value || value.toString().trim() === '') {
              stepValidationErrors.push(field.label);
              continue;
            }
            
            // Format-specific validation - only for required formats
            if (field.format === 'ein') {
              const digits = value.toString().replace(/\D/g, '');
              if (digits.length !== 9) {
                stepValidationErrors.push(`${field.label} (must be 9 digits)`);
              }
            }
            if (field.format === 'ssn') {
              const digits = value.toString().replace(/\D/g, '');
              if (digits.length !== 9) {
                stepValidationErrors.push(`${field.label} (must be 9 digits)`);
              }
            }
            if (field.format === 'phone') {
              const digits = value.toString().replace(/\D/g, '');
              if (digits.length < 10) {
                stepValidationErrors.push(`${field.label} (must be at least 10 digits)`);
              }
            }
            if (field.format === 'email') {
              if (!value.includes('@') || !value.includes('.')) {
                stepValidationErrors.push(`${field.label} (invalid format)`);
              }
            }
          }
          
          if (stepValidationErrors.length > 0) {
            console.log(`[STEP VALIDATION] Step ${currentStep} has validation issues for application ${id}`);
            console.log(`[STEP VALIDATION] Issues: ${stepValidationErrors.join(', ')}`);
            // Don't update currentStep if validation fails - keep them on current step
            // But still save all other data
            delete updates.currentStep;
          } else {
            console.log(`[STEP VALIDATION] Step ${currentStep} PASSED for application ${id}`);
          }
        }
      }

      // Verify reCAPTCHA if token provided (for final submissions)
      if (recaptchaToken) {
        const recaptchaResult = await verifyRecaptcha(recaptchaToken);
        if (!recaptchaResult.success) {
          console.error("[RECAPTCHA] Verification failed:", recaptchaResult.error);
          return res.status(400).json({ error: "Security verification failed. Please try again." });
        }
        console.log("[RECAPTCHA] Verified successfully, score:", recaptchaResult.score);
      }

      // Server-side validation for full application completion
      // Reject submissions with missing required fields when marking as complete
      if (updates.isFullApplicationCompleted) {
        // Get existing application to merge with updates for validation
        const existingApp = await storage.getLoanApplication(id);
        const mergedData = { ...existingApp, ...updates };
        
        // Define required fields for full application completion
        const requiredFields: { field: string; label: string }[] = [
          { field: 'fullName', label: 'Full Name' },
          { field: 'email', label: 'Email' },
          { field: 'phone', label: 'Phone' },
          { field: 'dateOfBirth', label: 'Date of Birth' },
          { field: 'socialSecurityNumber', label: 'Social Security Number' },
          { field: 'legalBusinessName', label: 'Legal Business Name' },
          { field: 'ein', label: 'EIN' },
          { field: 'businessStartDate', label: 'Business Start Date' },
          { field: 'stateOfIncorporation', label: 'State of Incorporation' },
          { field: 'ownership', label: 'Ownership Percentage' },
        ];
        
        // Check for business address (could be in businessStreetAddress or businessAddress)
        const hasBusinessAddress = mergedData.businessStreetAddress || mergedData.businessAddress;
        const hasBusinessCity = mergedData.city;
        const hasBusinessState = mergedData.state;
        const hasBusinessZip = mergedData.zipCode;
        
        // Check for owner address
        const hasOwnerAddress = mergedData.ownerAddress1;
        const hasOwnerCity = mergedData.ownerCity;
        const hasOwnerState = mergedData.ownerState;
        const hasOwnerZip = mergedData.ownerZip;
        
        const missingFields: string[] = [];
        
        // Check required text fields
        for (const { field, label } of requiredFields) {
          const value = (mergedData as any)[field];
          if (!value || value.toString().trim() === '') {
            missingFields.push(label);
          }
        }
        
        // Check SSN format (should be XXX-XX-XXXX with 9 digits)
        if (mergedData.socialSecurityNumber) {
          const ssnDigits = mergedData.socialSecurityNumber.replace(/\D/g, '');
          if (ssnDigits.length !== 9) {
            missingFields.push('Valid SSN (9 digits required)');
          }
        }
        
        // Check business address completeness
        if (!hasBusinessAddress) missingFields.push('Business Street Address');
        if (!hasBusinessCity) missingFields.push('Business City');
        if (!hasBusinessState) missingFields.push('Business State');
        if (!hasBusinessZip) missingFields.push('Business Zip Code');
        
        // Check owner address completeness
        if (!hasOwnerAddress) missingFields.push('Owner Street Address');
        if (!hasOwnerCity) missingFields.push('Owner City');
        if (!hasOwnerState) missingFields.push('Owner State');
        if (!hasOwnerZip) missingFields.push('Owner Zip Code');
        
        if (missingFields.length > 0) {
          console.log(`[VALIDATION] Full application REJECTED for ${mergedData.email || id}`);
          console.log(`[VALIDATION] Missing fields: ${missingFields.join(', ')}`);
          console.log(`[VALIDATION] Data snapshot: SSN=${mergedData.socialSecurityNumber ? 'SET' : 'MISSING'}, ownership=${mergedData.ownership}, ownerAddress=${hasOwnerAddress ? 'SET' : 'MISSING'}`);
          return res.status(400).json({ 
            error: "Application incomplete. Please fill out all required fields.",
            missingFields 
          });
        }
        
        console.log(`[VALIDATION] Full application APPROVED for ${mergedData.email || id}`);
      }

      // Always ensure agent view URL exists for all applications (use full URL for GHL)
      if (!updates.agentViewUrl || updates.agentViewUrl.startsWith('/')) {
        updates.agentViewUrl = generateApplicationUrl(req, id);
      }

      // Keep ownerCsz and businessCsz in sync whenever individual address fields are
      // updated — the display reads the combined CSZ field first, so it must stay current.
      const needsAddressSync = updates.ownerCity || updates.ownerState || updates.ownerZip
                            || updates.city || updates.state || updates.zipCode;
      if (needsAddressSync) {
        const existingApp2 = await storage.getLoanApplication(id);

        if (updates.ownerCity || updates.ownerState || updates.ownerZip) {
          const city  = updates.ownerCity  ?? existingApp2?.ownerCity  ?? '';
          const state = updates.ownerState ?? existingApp2?.ownerState ?? '';
          const zip   = updates.ownerZip   ?? existingApp2?.ownerZip   ?? '';
          if (city || state || zip) {
            updates.ownerCsz = `${city}, ${state} ${zip}`.trim();
          }
        }

        if (updates.city || updates.state || updates.zipCode) {
          const city  = updates.city     ?? existingApp2?.city     ?? '';
          const state = updates.state    ?? existingApp2?.state    ?? '';
          const zip   = updates.zipCode  ?? existingApp2?.zipCode  ?? '';
          if (city || state || zip) {
            updates.businessCsz = `${city}, ${state} ${zip}`.trim();
          }
        }
      }

      // Keep businessAddress and businessStreetAddress in sync — both columns store
      // the same value but different parts of the codebase read different fields.
      // Whichever is updated, mirror it to the other so edits are always visible.
      if (updates.businessAddress && !updates.businessStreetAddress) {
        updates.businessStreetAddress = updates.businessAddress;
      } else if (updates.businessStreetAddress && !updates.businessAddress) {
        updates.businessAddress = updates.businessStreetAddress;
      }

      // Keep ficoScoreExact and personalCreditScoreRange in sync — the edit form
      // writes ficoScoreExact but many display areas read personalCreditScoreRange.
      if (updates.ficoScoreExact && !updates.personalCreditScoreRange) {
        updates.personalCreditScoreRange = updates.ficoScoreExact;
      } else if (updates.personalCreditScoreRange && !updates.ficoScoreExact) {
        updates.ficoScoreExact = updates.personalCreditScoreRange;
      }

      // Keep legalBusinessName and businessName in sync — the admin edit form saves
      // legalBusinessName but some downstream endpoints (merchant portal, GHL, etc.)
      // read businessName directly.
      if (updates.legalBusinessName && !updates.businessName) {
        updates.businessName = updates.legalBusinessName;
      } else if (updates.businessName && !updates.legalBusinessName) {
        updates.legalBusinessName = updates.businessName;
      }

      // Keep ownership and ownerPercentage in sync — the dashboard edit form writes
      // ownership, but the list view reads ownerPercentage (which is returned by the
      // lightweight summary query). Without this mirror rule, editing ownership via the
      // dashboard leaves ownerPercentage stale, so the list still shows the old value.
      if (updates.ownership !== undefined && !updates.ownerPercentage) {
        updates.ownerPercentage = updates.ownership;
      } else if (updates.ownerPercentage !== undefined && !updates.ownership) {
        updates.ownership = updates.ownerPercentage;
      }

      // Check if application was already completed BEFORE applying updates
      const appBeforeUpdate = await storage.getLoanApplication(id);
      const wasAlreadyCompleted = appBeforeUpdate?.isFullApplicationCompleted === true;

      // Filter out empty values to preserve previously entered data
      const filteredUpdates = filterEmptyValues(updates);
      const updatedApp = await storage.updateLoanApplication(id, filteredUpdates);
      
      if (!updatedApp) {
        return res.status(404).json({ error: "Application not found" });
      }

      const isInertia = isInertiaSubmission(updatedApp);

      // External Inertia updates can arrive before the final completion flag.
      // Keep both CRMs current for those pushed entries as well.
      if (isInertia && !updates.isFullApplicationCompleted) {
        syncApplicationToSalesforceAndPersist(updatedApp).catch(() => {});
        ghlService.sendPartialApplicationWebhook(updatedApp).catch(err =>
          console.error("[INERTIA] Partial application webhook error:", err)
        );
      }

      // Send webhook only when full application is NEWLY completed in this request
      // (not on every subsequent auto-save after it was already completed)
      // Record full-application submissions: first completion, plus re-signed
      // re-submissions (signatureDate is only sent on the final signing step)
      if (updates.isFullApplicationCompleted && updatedApp.isFullApplicationCompleted && (!wasAlreadyCompleted || updates.signatureDate)) {
        await recordApplicationSubmission(id, updatedApp.email, 'full_application', updatedApp.requestedAmount);
      }

      // Re-signed re-submissions (signatureDate present) re-sync too — the
      // sync updates the existing Opp in place, never duplicates.
      if (updates.isFullApplicationCompleted && updatedApp.isFullApplicationCompleted && (!wasAlreadyCompleted || updates.signatureDate)) {
        if (!wasAlreadyCompleted) {
          ghlService.sendWebhook(updatedApp).catch(err =>
            console.error("Webhook error (non-blocking):", err)
          );
        }

        // Sync to Salesforce on full application completion (fire-and-forget)
        syncApplicationToSalesforceAndPersist(updatedApp).catch(() => {});

        // SMS: app_submitted (full 11-step application)
        if (updatedApp.phone) {
          const _parts = (updatedApp.fullName || '').trim().split(' ');
          fireSmsStageEvent({
            stage: 'app_submitted',
            phone: updatedApp.phone,
            email: updatedApp.email || undefined,
            first_name: _parts[0] || undefined,
            last_name: _parts.slice(1).join(' ') || undefined,
            business_name: updatedApp.businessName || undefined,
            deal_id: updatedApp.id,
          });
        }

        // Auto-create portal account after full application completion
        if (updatedApp.email) {
          autoCreatePortalAccount({
            email: updatedApp.email,
            name: updatedApp.fullName || undefined,
            phone: updatedApp.phone || undefined,
            businessName: updatedApp.businessName || updatedApp.legalBusinessName || undefined,
            applicationId: updatedApp.id,
            triggerKey: 'trigger.portal_after_application',
            sendLink: true,
          });
        }
      }

      // Return with validation errors if any (data was still saved)
      if (stepValidationErrors.length > 0) {
        return res.json({
          ...updatedApp,
          validationFailed: true,
          validationErrors: stepValidationErrors,
          requestedStep: requestedStep
        });
      }
      res.json(updatedApp);
    } catch (error) {
      console.error("Error updating application:", error);
      res.status(500).json({ error: "Failed to update application" });
    }
  });

  // Mark application as abandoned (called when user leaves page without completing)
  app.post("/api/applications/:id/abandon", async (req, res) => {
    try {
      const { id } = req.params;
      
      // Get the application
      const application = await storage.getLoanApplication(id);
      
      if (!application) {
        return res.status(404).json({ error: "Application not found" });
      }
      
      // Only send abandoned webhook if application was NOT completed
      if (!application.isFullApplicationCompleted && !application.isCompleted) {
        console.log(`[ABANDON] Sending abandoned webhook for application ${id}`);

        // Send the partial application webhook with "App Started" tag
        ghlService.sendPartialApplicationWebhook(application).catch(err =>
          console.error("Abandoned application webhook error (non-blocking):", err)
        );

        // Auto-trigger: send SMS/email nudge to complete application & upload bank statements
        const { abandonedPage, lastStep } = req.body || {};
        const _abandonParts = (application.fullName || '').trim().split(' ');
        triggerAppAbandoned({
          applicationId: id,
          phone: application.phone || undefined,
          email: application.email || undefined,
          firstName: _abandonParts[0] || undefined,
          lastName: _abandonParts.slice(1).join(' ') || undefined,
          businessName: application.businessName || undefined,
          lastStep: lastStep || application.currentStep || undefined,
          abandonedPage: abandonedPage || 'application',
        });

        // If they completed intake but abandoned during full app, send portal link
        // (so they can finish their app from the portal)
        if (application.isCompleted && application.email) {
          autoCreatePortalAccount({
            email: application.email,
            name: application.fullName || undefined,
            phone: application.phone || undefined,
            businessName: application.businessName || undefined,
            applicationId: application.id,
            triggerKey: 'trigger.portal_after_intake',
            sendLink: true,
          });
        }

        return res.json({ success: true, message: "Abandoned webhook sent" });
      }
      
      // Application was already completed, no need to send abandoned webhook
      return res.json({ success: true, message: "Application already completed, no abandoned webhook needed" });
    } catch (error) {
      console.error("Error marking application as abandoned:", error);
      res.status(500).json({ error: "Failed to process abandonment" });
    }
  });

  // Get funding report URL by email (for /see-report page)
  app.post("/api/applications/funding-report", async (req, res) => {
    try {
      const { email } = req.body;

      if (!email) {
        return res.status(400).json({ error: "Email is required" });
      }

      // Find application by email
      const application = await storage.getLoanApplicationByEmail(email);

      if (!application) {
        return res.status(404).json({ error: "No application found for this email" });
      }

      if (!application.fundingReportUrl) {
        // Generate the URL if it doesn't exist yet (for older applications)
        const fundingReportUrl = generateFundingReportUrl(application);
        await storage.updateLoanApplication(application.id, { fundingReportUrl });
        return res.json({
          fundingReportUrl,
          name: application.fullName,
          businessName: application.businessName,
        });
      }

      return res.json({
        fundingReportUrl: application.fundingReportUrl,
        name: application.fullName,
        businessName: application.businessName,
      });
    } catch (error) {
      console.error("Error fetching funding report:", error);
      res.status(500).json({ error: "Failed to fetch funding report" });
    }
  });

  // Get all applications (requires authentication)
  app.get("/api/applications", async (req, res) => {
    try {
      // Check authentication
      if (!req.session.user?.isAuthenticated) {
        return res.status(401).json({ error: "Authentication required" });
      }

      const search  = (req.query.search  as string) || undefined;
      const offset  = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;
      // Admin default: 100 most recent records per page when not searching (prevents 3-5 MB payloads)
      const ADMIN_LIMIT = 100;

      // Build partner name lookup map (lightweight — partners table is tiny)
      const allPartners = await storage.getAllPartners();
      const partnerNameMap = new Map(allPartners.map(p => [p.id, p.contactName]));

      const enrich = async (apps: any[]) => {
        // Attach submission history so the dashboard can show all intake/full-app
        // submissions on a file (one record per business, many submissions)
        const subsByApp = new Map<string, { id: string; submissionType: string; requestedAmount: string | null; createdAt: Date | null }[]>();
        try {
          const subs = await storage.getSubmissionsForApplicationIds(apps.map(a => a.id));
          for (const s of subs) {
            const list = subsByApp.get(s.loanApplicationId) || [];
            list.push({ id: s.id, submissionType: s.submissionType, requestedAmount: s.requestedAmount, createdAt: s.createdAt });
            subsByApp.set(s.loanApplicationId, list);
          }
        } catch (err: any) {
          console.error("[DASHBOARD] Failed to load submissions:", err?.message || err);
        }
        return apps.map(app => ({
          ...app,
          referralPartnerName: app.referralPartnerId ? (partnerNameMap.get(app.referralPartnerId) ?? null) : null,
          submissions: subsByApp.get(app.id) || [],
        }));
      };

      const role = req.session.user.role;
      console.log(`[DASHBOARD] User role: ${role}, search: "${search || ''}", email: ${req.session.user.agentEmail || 'N/A'}`);

      if (role === 'admin' || role === 'underwriting') {
        // Paginate: 100 records per page when not searching; searching returns all matches
        const limit = search ? undefined : ADMIN_LIMIT;
        const pageOffset = search ? 0 : offset;
        const [apps, total] = await Promise.all([
          storage.getApplicationsSummaryFiltered({ search, limit, offset: pageOffset }),
          storage.getApplicationsCount({ search }),
        ]);
        const enriched = await enrich(apps);
        console.log(`[DASHBOARD] Returning ${enriched.length} (offset ${pageOffset}) of ${total} for ${role}`);
        res.setHeader('X-Total-Count', String(total));
        return res.json(enriched);

      } else if ((role === 'agent' || role === 'user') && req.session.user.agentEmail) {
        const agentEmail = req.session.user.agentEmail.toLowerCase();
        const apps = await storage.getApplicationsSummaryFiltered({ search, agentEmail });
        console.log(`[DASHBOARD] Returning ${apps.length} applications for ${role} ${agentEmail}`);
        res.setHeader('X-Total-Count', String(apps.length));
        return res.json(await enrich(apps));
      }

      return res.status(403).json({ error: "Access denied" });
    } catch (error) {
      console.error("Error fetching applications:", error);
      res.status(500).json({ error: "Failed to fetch applications" });
    }
  });

  // GET /api/merchants — merchant-level view with nested rounds (auth-scoped, search/status/agent filtered)
  app.get("/api/merchants", async (req, res) => {
    try {
      if (!req.session.user?.isAuthenticated) {
        return res.status(401).json({ error: "Authentication required" });
      }
      const role = req.session.user.role;
      const agentEmail = req.session.user.agentEmail?.toLowerCase();
      const search   = (req.query.search  as string) || undefined;
      const status   = (req.query.status  as string) || "all";
      const agent    = (req.query.agent   as string) || "all";
      const offset   = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;
      const MERCHANT_PAGE = 100; // merchants per page

      // Convert snake_case DB row → camelCase for frontend compatibility
      const toCamel = (s: string) => s.replace(/_([a-z0-9])/g, (_: string, c: string) => c.toUpperCase());
      const rowToApp = (row: any) => {
        const app: any = {};
        for (const [k, v] of Object.entries(row)) {
          if (!k.startsWith('m_')) app[toCamel(k)] = v;
        }
        return app;
      };

      // Step 1: rank merchants by latest activity, apply all filters
      const cteParams: any[] = [];
      let cteIdx = 1;

      // Mirror /api/applications auth scoping: agent + user both restricted to their own files
      let cteWhere = `WHERE 1=1`;
      if ((role === "agent" || role === "user") && agentEmail) {
        cteWhere += ` AND LOWER(la.agent_email) = $${cteIdx++}`;
        cteParams.push(agentEmail);
      } else if ((role === "agent" || role === "user") && !agentEmail) {
        // No agentEmail on file → return nothing rather than everything
        return res.status(403).json({ error: "Agent email required for scoped access" });
      }
      if (agent !== "all" && role !== "agent" && role !== "user") {
        if (agent === "unassigned") {
          cteWhere += ` AND la.agent_name IS NULL`;
        } else if (agent === "web-leads") {
          cteWhere += ` AND la.is_web_lead = true`;
        } else {
          cteWhere += ` AND la.agent_name = $${cteIdx++}`;
          cteParams.push(agent);
        }
      }
      if (search) {
        const pat = `%${search}%`;
        cteWhere += ` AND (la.full_name ILIKE $${cteIdx} OR la.email ILIKE $${cteIdx} OR la.business_name ILIKE $${cteIdx} OR la.legal_business_name ILIKE $${cteIdx} OR la.phone ILIKE $${cteIdx})`;
        cteParams.push(pat); cteIdx++;
      }

      // Revenue threshold for low-revenue filter
      let statusHaving = '';
      // Helper expression: parse revenue string (may contain "$", ",") to numeric
      const revExpr = `MAX(CASE
        WHEN REGEXP_REPLACE(COALESCE(la.monthly_revenue, la.average_monthly_revenue, '0'), '[^0-9.]', '', 'g') ~ '^[0-9]+(\\.[0-9]+)?$'
        THEN CAST(REGEXP_REPLACE(COALESCE(la.monthly_revenue, la.average_monthly_revenue, '0'), '[^0-9.]', '', 'g') AS NUMERIC)
        ELSE 0 END)`;
      if (status === 'intake')        statusHaving = `HAVING BOOL_OR(la.is_completed AND NOT la.is_full_application_completed) = true`;
      else if (status === 'full')     statusHaving = `HAVING BOOL_OR(la.is_full_application_completed) = true`;
      else if (status === 'partial')  statusHaving = `HAVING BOOL_OR(NOT la.is_completed AND NOT la.is_full_application_completed) = true`;
      else if (status === 'low-revenue') statusHaving = `HAVING ${revExpr} > 0 AND ${revExpr} < 10000`;

      cteParams.push(MERCHANT_PAGE, offset);
      const limitIdx = cteIdx; cteIdx++;
      const offsetIdx = cteIdx; cteIdx++;

      const rankedQuery = `
        WITH ranked AS (
          SELECT
            COALESCE(la.merchant_id, 'solo_' || la.id)          AS merchant_key,
            MAX(COALESCE(la.last_submission_at, la.created_at))  AS latest_activity
          FROM loan_applications la
          ${cteWhere}
          GROUP BY COALESCE(la.merchant_id, 'solo_' || la.id)
          ${statusHaving}
          ORDER BY latest_activity DESC
          LIMIT $${limitIdx} OFFSET $${offsetIdx}
        )
        SELECT la.*, m.business_name AS m_business_name, m.primary_email AS m_primary_email,
               m.primary_phone AS m_primary_phone,
               COALESCE(la.merchant_id, 'solo_' || la.id) AS merchant_key,
               r.latest_activity
        FROM ranked r
        JOIN loan_applications la ON COALESCE(la.merchant_id, 'solo_' || la.id) = r.merchant_key
        LEFT JOIN merchants m ON la.merchant_id = m.id
        ORDER BY r.latest_activity DESC, COALESCE(la.last_submission_at, la.created_at) DESC
      `;

      const rawResult = await pool.query(rankedQuery, cteParams);

      // Group rows by merchant_key; apps already ordered newest-first per merchant
      const groupMap = new Map<string, { key: string; merchantId: string | null; businessName: string | null; primaryEmail: string | null; primaryPhone: string | null; apps: any[]; latestActivity: any }>();
      for (const row of rawResult.rows) {
        const key = row.merchant_key as string;
        if (!groupMap.has(key)) {
          groupMap.set(key, {
            key,
            merchantId: row.merchant_id || null,
            businessName: row.m_business_name || row.legal_business_name || row.business_name || null,
            primaryEmail: row.m_primary_email || row.email || null,
            primaryPhone: row.m_primary_phone || row.phone || null,
            apps: [],
            latestActivity: row.latest_activity || null,
          });
        }
        groupMap.get(key)!.apps.push(rowToApp(row));
      }

      const groups = Array.from(groupMap.values());

      res.json(groups);
    } catch (err: any) {
      console.error("[MERCHANTS] Failed:", err?.message);
      res.status(500).json({ error: "Failed to fetch merchants" });
    }
  });

  // Agent view endpoints
  // Serve the HTML page for agent view
  app.get("/agent/application/:id", async (req, res) => {
    try {
      const htmlPath = path.join(process.cwd(), "client", "public", "ApplicationView.html");
      res.sendFile(htmlPath);
    } catch (error) {
      console.error("Error serving agent view:", error);
      res.status(500).send("Failed to load application view");
    }
  });

  // API endpoint to fetch application data for agent view (no auth required)
  app.get("/api/applications/:id/view", async (req, res) => {
    try {
      const { id } = req.params;
      const application = await storage.getLoanApplication(id);
      
      if (!application) {
        return res.status(404).json({ error: "Application not found" });
      }
      
      // Prevent browser/CDN caching so edits are always reflected immediately
      res.set({
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
      });

      // ─── Normalize: resolve all combined-vs-individual field conflicts ───────
      // Individual fields are ALWAYS authoritative when present. Combined/CSZ
      // fields (businessCsz, ownerCsz) are only used as a fallback when the
      // individual fields are completely absent. This ensures that admin edits
      // to individual fields are always reflected immediately in the view.
      const normalized: Record<string, any> = { ...application };

      // Helper: parse "City, ST 12345" → { city, state, zip }
      function parseCsz(csz: string): { city: string; state: string; zip: string } {
        const parts = (csz || '').split(',').map(p => p.trim());
        if (parts.length >= 2) {
          const stateZip = parts[1].split(' ').filter(Boolean);
          return { city: parts[0], state: stateZip[0] || '', zip: stateZip[1] || '' };
        }
        return { city: '', state: '', zip: '' };
      }

      // Business address — prefer individual fields; fall back to businessCsz
      if (!normalized.city && !normalized.state && !normalized.zipCode && normalized.businessCsz) {
        const parsed = parseCsz(normalized.businessCsz);
        normalized.city      = parsed.city;
        normalized.state     = parsed.state;
        normalized.zipCode   = parsed.zip;
      }

      // Owner address — prefer individual fields; fall back to ownerCsz
      if (!normalized.ownerCity && !normalized.ownerState && !normalized.ownerZip && normalized.ownerCsz) {
        const parsed = parseCsz(normalized.ownerCsz);
        normalized.ownerCity  = parsed.city;
        normalized.ownerState = parsed.state;
        normalized.ownerZip   = parsed.zip;
      }

      // Return normalized data — the view reads individual fields only
      res.json(normalized);
    } catch (error) {
      console.error("Error fetching application for view:", error);
      res.status(500).json({ error: "Failed to fetch application" });
    }
  });

  // Save hand-drawn signature from agent application view (no auth — secured by UUID obscurity)
  app.post("/api/applications/:id/signature", async (req, res) => {
    try {
      const { id } = req.params;
      const { signature, signedAt } = req.body;
      if (!signature || !String(signature).startsWith('data:image')) {
        return res.status(400).json({ error: "Invalid signature data" });
      }
      const application = await storage.getLoanApplication(id);
      if (!application) return res.status(404).json({ error: "Application not found" });
      await storage.updateLoanApplication(id, {
        applicantSignature: signature,
        signatureDate: signedAt || new Date().toISOString(),
      });
      res.json({ success: true });
    } catch (error) {
      console.error("Error saving signature:", error);
      res.status(500).json({ error: "Failed to save signature" });
    }
  });

  // ========================================
  // PLAID INTEGRATION ROUTES
  // ========================================

  // 1. Generate Link Token for Plaid Link widget
  app.post("/api/plaid/create-link-token", async (req, res) => {
    try {
      const tokenData = await plaidService.createLinkToken("user-session-id");
      res.json(tokenData);
    } catch (error: any) {
      const plaidError = error?.response?.data;
      console.error("Plaid Create Token Error:", plaidError || error?.message || error);
      res.status(500).json({ error: "Failed to initialize Plaid", detail: plaidError });
    }
  });

  // 1b. Generate Update Link Token for existing Plaid item (to add new products)
  app.post("/api/plaid/create-update-link-token/:plaidItemId", async (req, res) => {
    if (!req.session.user?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }
    try {
      const { plaidItemId } = req.params;
      const plaidItem = await storage.getPlaidItem(plaidItemId);
      if (!plaidItem) {
        return res.status(404).json({ error: "Bank connection not found" });
      }
      const tokenData = await plaidService.createUpdateLinkToken("user-session-id", plaidItem.accessToken);
      res.json(tokenData);
    } catch (error: any) {
      const plaidBody = error?.response?.data;
      console.error("Plaid Update Link Token Error:", plaidBody ? JSON.stringify(plaidBody) : error?.message);
      res.status(500).json({ error: "Failed to create update link token" });
    }
  });

  // 2. Handle Successful Link & Analyze (with Asset Report + AI Analysis)
  app.post("/api/plaid/exchange-token", async (req, res) => {
    try {
      // Validate request body
      const validationResult = plaidExchangeSchema.safeParse(req.body);
      if (!validationResult.success) {
        return res.status(400).json({ 
          error: "Invalid request data",
          details: validationResult.error.errors 
        });
      }
      
      const { publicToken, metadata, businessName, email } = validationResult.data;
      // Plaid connections currently request Assets only. The Asset Report
      // created below is the source for the underwriting analysis; do not
      // fall back to the Transactions product.
      const useAIAnalysis = true;

      // A. Exchange Token
      const tokenResponse = await plaidService.exchangePublicToken(publicToken);
      const institutionName = metadata?.institution?.name || 'Unknown Bank';
      
      // B. Save Access Token using storage layer
      await storage.createPlaidItem({
        itemId: tokenResponse.item_id,
        accessToken: tokenResponse.access_token,
        institutionName,
      });

      // C. Auto-link to existing application if email matches
      const applications = await storage.getAllLoanApplications();
      const matchingApp = applications.find((app: LoanApplication) => app.email === email);
      if (matchingApp && !matchingApp.plaidItemId) {
        await storage.updateLoanApplication(matchingApp.id, { 
          plaidItemId: tokenResponse.item_id 
        });
        console.log(`Linked Plaid item ${tokenResponse.item_id} to application ${matchingApp.id}`);
      }
      if (email && shouldSendMerchantAlert(`plaid_connected:${email.toLowerCase()}`, 6 * 60 * 60 * 1000)) {
        sendAdminMerchantAlert({
          title: "Bank Connected via Plaid",
          event: "plaid_bank_connected",
          merchantEmail: email.toLowerCase(),
          merchantName: matchingApp?.fullName || undefined,
          businessName: businessName || matchingApp?.businessName || undefined,
          details: { institution: institutionName, plaidItemId: tokenResponse.item_id },
        }).catch(() => {});
      }

      // D. Create and analyze the Asset Report. This is the only Plaid
      // financial-data path for this flow; do not fall back to Transactions.
      if (useAIAnalysis) {
        console.log(`[PLAID EXCHANGE] Running AI-powered Asset Report analysis for ${email}...`);
        
        try {
          // Generate Asset Report for comprehensive financial data
          const assetReport = await plaidService.createAndGetAssetReport(tokenResponse.access_token, 90);
          
          // Format Asset Report data for OpenAI analysis
          let analysisText = "=== PLAID ASSET REPORT ===\n";
          analysisText += `Report Generated: ${assetReport.report?.date_generated || 'N/A'}\n`;
          analysisText += `Days Requested: ${assetReport.report?.days_requested || 90}\n\n`;
          
          // Extract metrics from asset report
          let totalDeposits = 0;
          let totalCurrentBalance = 0;
          let negativeDays = 0;
          
          // Process each item in the report
          if (assetReport.report?.items) {
            for (const item of assetReport.report.items) {
              analysisText += `=== INSTITUTION: ${item.institution_name || 'Unknown'} ===\n\n`;
              
              if (item.accounts) {
                for (const account of item.accounts) {
                  analysisText += `--- ACCOUNT: ${account.name} (${account.subtype || account.type}) ---\n`;
                  analysisText += `Current Balance: $${account.balances?.current?.toFixed(2) || 'N/A'}\n`;
                  analysisText += `Available Balance: $${account.balances?.available?.toFixed(2) || 'N/A'}\n`;
                  
                  totalCurrentBalance += account.balances?.current || 0;
                  
                  // Historical balances
                  if (account.historical_balances && account.historical_balances.length > 0) {
                    analysisText += `\nHistorical Daily Balances (${account.historical_balances.length} days):\n`;
                    const balances = account.historical_balances.slice(0, 90);
                    let totalBalance = 0;
                    let minBalance = Infinity;
                    let maxBalance = -Infinity;
                    
                    for (const bal of balances) {
                      const current = bal.current || 0;
                      totalBalance += current;
                      minBalance = Math.min(minBalance, current);
                      maxBalance = Math.max(maxBalance, current);
                      if (current < 0) negativeDays++;
                    }
                    
                    const avgBalance = balances.length > 0 ? totalBalance / balances.length : 0;
                    analysisText += `  Average Daily Balance: $${avgBalance.toFixed(2)}\n`;
                    analysisText += `  Min/Max Balance: $${minBalance === Infinity ? 'N/A' : minBalance.toFixed(2)} / $${maxBalance === -Infinity ? 'N/A' : maxBalance.toFixed(2)}\n`;
                    analysisText += `  Days with Negative Balance: ${negativeDays}\n`;
                    
                    // Sample recent balances
                    analysisText += `\n  Recent Balance History:\n`;
                    for (const bal of balances.slice(0, 30)) {
                      analysisText += `    ${bal.date}: $${bal.current?.toFixed(2) || '0.00'}\n`;
                    }
                  }
                  
                  // Transactions from asset report
                  if (account.transactions && account.transactions.length > 0) {
                    analysisText += `\nTransactions (${account.transactions.length} total):\n`;
                    
                    let accountDeposits = 0;
                    let accountWithdrawals = 0;
                    let depositCount = 0;
                    let withdrawalCount = 0;
                    
                    for (const txn of account.transactions) {
                      const amount = txn.amount || 0;
                      if (amount < 0) {
                        accountDeposits += Math.abs(amount);
                        depositCount++;
                      } else {
                        accountWithdrawals += amount;
                        withdrawalCount++;
                      }
                    }
                    
                    totalDeposits += accountDeposits;
                    
                    analysisText += `  Total Deposits: $${accountDeposits.toFixed(2)} (${depositCount} transactions)\n`;
                    analysisText += `  Total Withdrawals: $${accountWithdrawals.toFixed(2)} (${withdrawalCount} transactions)\n`;
                    analysisText += `  Estimated Monthly Revenue: $${(accountDeposits / 3).toFixed(2)}\n`;
                    
                    // Recent transactions
                    analysisText += `\n  Recent Transactions:\n`;
                    for (const txn of account.transactions.slice(0, 50)) {
                      const amount = txn.amount < 0 ? `+$${Math.abs(txn.amount).toFixed(2)}` : `-$${txn.amount.toFixed(2)}`;
                      analysisText += `    ${txn.date} | ${amount} | ${txn.original_description || txn.name || 'N/A'}\n`;
                    }
                  }
                  
                  analysisText += `\n`;
                }
              }
            }
          }

          console.log(`[PLAID EXCHANGE] Analyzing ${analysisText.length} chars of Asset Report data with AI...`);

          // Run AI analysis
          const aiAnalysis = await analyzeBankStatements(analysisText, {});
          
          // Calculate metrics for legacy compatibility
          const monthlyRevenue = totalDeposits / 3;
          const avgBalance = totalCurrentBalance;
          
          // Save results with AI analysis
          await storage.createFundingAnalysis({
            businessName,
            email,
            calculatedMonthlyRevenue: monthlyRevenue.toString(),
            calculatedAvgBalance: avgBalance.toString(),
            negativeDaysCount: negativeDays,
            analysisResult: {
              sba: { status: aiAnalysis.overallScore >= 70 ? 'High' : aiAnalysis.overallScore >= 40 ? 'Medium' : 'Low', reason: aiAnalysis.fundingRecommendation?.message || '' },
              loc: { status: aiAnalysis.overallScore >= 60 ? 'High' : aiAnalysis.overallScore >= 35 ? 'Medium' : 'Low', reason: 'Based on balance history and revenue patterns' },
              mca: { status: aiAnalysis.overallScore >= 30 ? 'High' : aiAnalysis.overallScore >= 15 ? 'Medium' : 'Low', reason: 'Working capital based on deposit flow' }
            },
            plaidItemId: tokenResponse.item_id
          });

          // Return comprehensive AI analysis
          res.json({
            type: 'ai_analysis',
            metrics: {
              monthlyRevenue: Math.round(monthlyRevenue),
              avgBalance: Math.round(avgBalance),
              negativeDays
            },
            recommendations: {
              sba: { status: aiAnalysis.overallScore >= 70 ? 'High' : aiAnalysis.overallScore >= 40 ? 'Medium' : 'Low', reason: aiAnalysis.fundingRecommendation?.message || 'Based on financial analysis' },
              loc: { status: aiAnalysis.overallScore >= 60 ? 'High' : aiAnalysis.overallScore >= 35 ? 'Medium' : 'Low', reason: 'Based on balance history' },
              mca: { status: aiAnalysis.overallScore >= 30 ? 'High' : aiAnalysis.overallScore >= 15 ? 'Medium' : 'Low', reason: 'Based on cash flow' }
            },
            aiAnalysis: {
              overallScore: aiAnalysis.overallScore,
              qualificationTier: aiAnalysis.qualificationTier,
              estimatedMonthlyRevenue: aiAnalysis.estimatedMonthlyRevenue,
              averageDailyBalance: aiAnalysis.averageDailyBalance,
              redFlags: aiAnalysis.redFlags,
              positiveIndicators: aiAnalysis.positiveIndicators,
              fundingRecommendation: aiAnalysis.fundingRecommendation,
              improvementSuggestions: aiAnalysis.improvementSuggestions,
              summary: aiAnalysis.summary
            },
            assetReportToken: assetReport.assetReportToken,
            assetReport: assetReport.report,
            institutionName
          });
          
        } catch (aiError) {
          console.error("[PLAID EXCHANGE] AI analysis failed, falling back to basic analysis:", aiError);
          // Do not call analyzeFinancials here: that path requires the
          // Transactions product, which is intentionally not requested.
          console.error("[PLAID EXCHANGE] Asset Report analysis failed:", aiError);
          return res.status(502).json({
            error: "Asset Report analysis failed",
            detail: "The bank connection succeeded, but Plaid could not finish the Asset Report analysis.",
          });
        }
      }

    } catch (error) {
      console.error("Plaid Exchange Error:", error);
      res.status(500).json({ error: "Failed to analyze bank data" });
    }
  });

  // 3. Get existing funding analysis by email
  app.get("/api/plaid/analysis/:email", async (req, res) => {
    try {
      const { email } = req.params;
      const analysis = await storage.getFundingAnalysisByEmail(email);
      
      if (!analysis) {
        return res.status(404).json({ error: "No analysis found for this email" });
      }
      
      res.json(analysis);
    } catch (error) {
      console.error("Error fetching analysis:", error);
      res.status(500).json({ error: "Failed to fetch analysis" });
    }
  });

  // 4. Get bank statements for an application (requires dashboard auth)
  app.get("/api/plaid/statements/:applicationId", async (req, res) => {
    const session = req.session as any;
    if (!session?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }

    try {
      const { applicationId } = req.params;
      const months = parseInt(req.query.months as string) || 3;
      
      const application = await storage.getLoanApplication(applicationId);
      if (!application) {
        return res.status(404).json({ error: "Application not found" });
      }

      if (!application.plaidItemId) {
        return res.status(404).json({ error: "No bank connection found for this application" });
      }

      const plaidItem = await storage.getPlaidItem(application.plaidItemId);
      if (!plaidItem) {
        return res.status(404).json({ error: "Bank connection data not found" });
      }

      const statements = await plaidService.getBankStatements(plaidItem.accessToken, months);
      res.json(statements);
    } catch (error) {
      console.error("Error fetching bank statements:", error);
      res.status(500).json({ error: "Failed to fetch bank statements" });
    }
  });

  // 5. Get all bank connections (for dashboard Bank Statements tab)
  app.get("/api/plaid/all", async (req, res) => {
    if (!req.session.user?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }

    try {
      const [plaidItems, fundingAnalyses] = await Promise.all([
        storage.getAllPlaidItems(),
        storage.getAllFundingAnalyses()
      ]);

      const bankConnections = fundingAnalyses.map(analysis => {
        const plaidItem = plaidItems.find(item => item.itemId === analysis.plaidItemId);
        return {
          id: analysis.id,
          businessName: analysis.businessName,
          email: analysis.email,
          institutionName: plaidItem?.institutionName || 'Unknown Bank',
          monthlyRevenue: analysis.calculatedMonthlyRevenue,
          avgBalance: analysis.calculatedAvgBalance,
          negativeDays: analysis.negativeDaysCount,
          analysisResult: analysis.analysisResult,
          plaidItemId: analysis.plaidItemId,
          createdAt: analysis.createdAt
        };
      });

      res.json(bankConnections);
    } catch (error) {
      console.error("Error fetching bank connections:", error);
      res.status(500).json({ error: "Failed to fetch bank connections" });
    }
  });

  // Admin: Edit a Plaid bank connection (funding analysis)
  app.patch("/api/plaid/connections/:id", async (req, res) => {
    if (!req.session.user?.isAuthenticated) return res.status(401).json({ error: "Authentication required" });
    if (req.session.user.role !== 'admin') return res.status(403).json({ error: "Admin access required" });
    const { id } = req.params;
    const { businessName, email } = req.body as { businessName?: string; email?: string };
    try {
      const updated = await storage.updateFundingAnalysis(id, { businessName, email });
      if (!updated) return res.status(404).json({ error: "Connection not found" });
      res.json(updated);
    } catch (error) {
      console.error("Error updating plaid connection:", error);
      res.status(500).json({ error: "Failed to update connection" });
    }
  });

  // Admin: Delete a Plaid bank connection (funding analysis + plaid item)
  app.delete("/api/plaid/connections/:id", async (req, res) => {
    if (!req.session.user?.isAuthenticated) return res.status(401).json({ error: "Authentication required" });
    if (req.session.user.role !== 'admin') return res.status(403).json({ error: "Admin access required" });
    const { id } = req.params;
    try {
      await storage.deleteFundingAnalysis(id);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting plaid connection:", error);
      res.status(500).json({ error: "Failed to delete connection" });
    }
  });

  // 6. Get bank statements by Plaid item ID (for bank statements tab)
  app.get("/api/plaid/statements-by-item/:plaidItemId", async (req, res) => {
    if (!req.session.user?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }

    try {
      const { plaidItemId } = req.params;
      const months = parseInt(req.query.months as string) || 3;
      
      const plaidItem = await storage.getPlaidItem(plaidItemId);
      if (!plaidItem) {
        return res.status(404).json({ error: "Bank connection not found" });
      }

      const statements = await plaidService.getBankStatements(plaidItem.accessToken, months);
      res.json(statements);
    } catch (error) {
      console.error("Error fetching bank statements:", error);
      res.status(500).json({ error: "Failed to fetch bank statements" });
    }
  });

  // 6b. Get Asset Report by Plaid item ID (comprehensive financial report)
  app.get("/api/plaid/asset-report/:plaidItemId", async (req, res) => {
    if (!req.session.user?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }

    try {
      const { plaidItemId } = req.params;
      const days = parseInt(req.query.days as string) || 90;
      
      const plaidItem = await storage.getPlaidItem(plaidItemId);
      if (!plaidItem) {
        return res.status(404).json({ error: "Bank connection not found" });
      }

      // Look up the funding analysis to get the email, then find the application
      let userInfo: any = undefined;
      const fundingAnalysis = await storage.getFundingAnalysisByPlaidItemId(plaidItemId);
      if (fundingAnalysis?.email) {
        const application = await storage.getApplicationByEmail(fundingAnalysis.email);
        if (application) {
          // Format SSN with dashes if provided (ddd-dd-dddd format required by Plaid)
          let formattedSSN: string | undefined;
          if (application.socialSecurityNumber) {
            const ssnDigits = application.socialSecurityNumber.replace(/\D/g, '');
            if (ssnDigits.length === 9) {
              formattedSSN = `${ssnDigits.slice(0,3)}-${ssnDigits.slice(3,5)}-${ssnDigits.slice(5)}`;
            }
          }
          
          // Format phone number to E.164 if possible
          let formattedPhone: string | undefined;
          if (application.phone) {
            const phoneDigits = application.phone.replace(/\D/g, '');
            if (phoneDigits.length === 10) {
              formattedPhone = `+1${phoneDigits}`;
            } else if (phoneDigits.length === 11 && phoneDigits.startsWith('1')) {
              formattedPhone = `+${phoneDigits}`;
            }
          }

          // Parse full name into first and last name
          let firstName: string | undefined;
          let lastName: string | undefined;
          if (application.fullName) {
            const nameParts = application.fullName.trim().split(/\s+/);
            firstName = nameParts[0];
            lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : undefined;
          }

          userInfo = {
            firstName,
            lastName,
            email: application.email,
            ssn: formattedSSN,
            phoneNumber: formattedPhone,
          };
          console.log(`[ASSET REPORT] Found application for ${application.email}, including borrower info`);
        }
      }

      console.log(`Creating asset report for Plaid item ${plaidItemId} (${days} days)...`);
      const assetReport = await plaidService.createAndGetAssetReport(plaidItem.accessToken, days, userInfo);
      
      res.json(assetReport);
    } catch (error: any) {
      const plaidBody = error?.response?.data;
      console.error("Error fetching asset report:", plaidBody ? JSON.stringify(plaidBody) : error?.message || error);
      
      // Handle specific Plaid errors
      if (plaidBody?.error_code) {
        return res.status(400).json({ 
          error: "Plaid error", 
          errorCode: plaidBody.error_code,
          message: plaidBody.error_message || "Failed to generate asset report",
          displayMessage: plaidBody.display_message
        });
      }
      
      res.status(500).json({ error: "Failed to generate asset report" });
    }
  });

  // 6c. Get Asset Report PDF by Plaid item ID
  app.get("/api/plaid/asset-report-pdf/:plaidItemId", async (req, res) => {
    if (!req.session.user?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }

    try {
      const { plaidItemId } = req.params;
      const days = parseInt(req.query.days as string) || 90;
      
      const plaidItem = await storage.getPlaidItem(plaidItemId);
      if (!plaidItem) {
        return res.status(404).json({ error: "Bank connection not found" });
      }

      // Look up the funding analysis to get the email, then find the application
      let userInfo: any = undefined;
      const fundingAnalysis = await storage.getFundingAnalysisByPlaidItemId(plaidItemId);
      if (fundingAnalysis?.email) {
        const application = await storage.getApplicationByEmail(fundingAnalysis.email);
        if (application) {
          // Format SSN with dashes if provided (ddd-dd-dddd format required by Plaid)
          let formattedSSN: string | undefined;
          if (application.socialSecurityNumber) {
            const ssnDigits = application.socialSecurityNumber.replace(/\D/g, '');
            if (ssnDigits.length === 9) {
              formattedSSN = `${ssnDigits.slice(0,3)}-${ssnDigits.slice(3,5)}-${ssnDigits.slice(5)}`;
            }
          }
          
          // Format phone number to E.164 if possible
          let formattedPhone: string | undefined;
          if (application.phone) {
            const phoneDigits = application.phone.replace(/\D/g, '');
            if (phoneDigits.length === 10) {
              formattedPhone = `+1${phoneDigits}`;
            } else if (phoneDigits.length === 11 && phoneDigits.startsWith('1')) {
              formattedPhone = `+${phoneDigits}`;
            }
          }

          // Parse full name into first and last name
          let firstName: string | undefined;
          let lastName: string | undefined;
          if (application.fullName) {
            const nameParts = application.fullName.trim().split(/\s+/);
            firstName = nameParts[0];
            lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : undefined;
          }

          userInfo = {
            firstName,
            lastName,
            email: application.email,
            ssn: formattedSSN,
            phoneNumber: formattedPhone,
          };
          console.log(`[ASSET REPORT PDF] Found application for ${application.email}, including borrower info`);
        }
      }

      // First create the asset report to get the token
      console.log(`Creating asset report for PDF download...`);
      const { assetReportToken } = await plaidService.createAssetReport(plaidItem.accessToken, days, userInfo);
      
      // Wait for the report to be ready
      await plaidService.getAssetReport(assetReportToken);
      
      // Get the PDF
      console.log(`Downloading asset report PDF...`);
      const pdfBuffer = await plaidService.getAssetReportPdf(assetReportToken);
      
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="asset_report_${plaidItemId}.pdf"`);
      res.send(pdfBuffer);
    } catch (error: any) {
      console.error("Error generating asset report PDF:", error);
      
      if (error?.response?.data?.error_code) {
        const plaidError = error.response.data;
        return res.status(400).json({ 
          error: "Plaid error", 
          errorCode: plaidError.error_code,
          message: plaidError.error_message || "Failed to generate asset report PDF"
        });
      }
      
      res.status(500).json({ error: "Failed to generate asset report PDF" });
    }
  });

  // 8. Download a specific Plaid Statement PDF
  app.get("/api/plaid/statements/:plaidItemId/download/:statementId", async (req, res) => {
    if (!req.session.user?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }

    try {
      const { plaidItemId, statementId } = req.params;
      
      const plaidItem = await storage.getPlaidItem(plaidItemId);
      if (!plaidItem) {
        return res.status(404).json({ error: "Bank connection not found" });
      }

      const pdfBuffer = await plaidService.downloadStatement(plaidItem.accessToken, statementId);
      
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="bank-statement-${statementId}.pdf"`);
      res.send(pdfBuffer);
    } catch (error: any) {
      console.error("Error downloading statement:", error);
      
      if (error?.response?.data?.error_code) {
        const plaidError = error.response.data;
        return res.status(400).json({ 
          error: "Plaid error", 
          errorCode: plaidError.error_code,
          message: plaidError.error_message || "Failed to download statement"
        });
      }
      
      res.status(500).json({ error: "Failed to download statement" });
    }
  });

  // 9. Refresh Plaid Statements (request fresh statements)
  app.post("/api/plaid/statements/:plaidItemId/refresh", async (req, res) => {
    if (!req.session.user?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }

    try {
      const { plaidItemId } = req.params;
      const { startDate, endDate } = req.body;
      
      const plaidItem = await storage.getPlaidItem(plaidItemId);
      if (!plaidItem) {
        return res.status(404).json({ error: "Bank connection not found" });
      }

      await plaidService.refreshStatements(plaidItem.accessToken, startDate, endDate);
      res.json({ success: true, message: "Statement refresh requested. New statements may take a few minutes to appear." });
    } catch (error: any) {
      console.error("Error refreshing statements:", error);
      
      if (error?.response?.data?.error_code) {
        const plaidError = error.response.data;
        return res.status(400).json({ 
          error: "Plaid error", 
          errorCode: plaidError.error_code,
          message: plaidError.error_message || "Failed to refresh statements"
        });
      }
      
      res.status(500).json({ error: "Failed to refresh statements" });
    }
  });

  // 10. Get stored Plaid statements from database for a plaid item
  app.get("/api/plaid/stored-statements/:plaidItemId", async (req, res) => {
    if (!req.session.user?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }

    try {
      const { plaidItemId } = req.params;
      
      const statements = await storage.getPlaidStatementsByItemId(plaidItemId);
      res.json({ statements });
    } catch (error: any) {
      console.error("Error fetching stored statements:", error);
      res.status(500).json({ error: "Failed to fetch stored statements" });
    }
  });

  // 11. Link Plaid data to an existing application by email
  app.post("/api/plaid/link-to-application", async (req, res) => {
    try {
      const { email, plaidItemId } = req.body;
      
      if (!email || !plaidItemId) {
        return res.status(400).json({ error: "Email and plaidItemId are required" });
      }

      const applications = await storage.getAllLoanApplications();
      const matchingApp = applications.find((app: LoanApplication) => app.email === email);
      
      if (!matchingApp) {
        return res.status(404).json({ error: "No application found with this email" });
      }

      await storage.updateLoanApplication(matchingApp.id, { plaidItemId });
      res.json({ success: true, applicationId: matchingApp.id });
    } catch (error) {
      console.error("Error linking Plaid to application:", error);
      res.status(500).json({ error: "Failed to link bank data to application" });
    }
  });

  // 8. Analyze Plaid connection for fundability insights (using Asset Report)
  app.post("/api/plaid/analyze/:plaidItemId", async (req, res) => {
    if (!req.session.user?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }

    try {
      if (!isOpenAIConfigured()) {
        return res.status(503).json({
          error: "Analysis service not available",
          message: "OpenAI API is not configured.",
        });
      }

      const { plaidItemId } = req.params;
      const { creditScoreRange, timeInBusiness, industry } = req.body;

      // Get the Plaid item using the correct method
      const plaidItem = await storage.getPlaidItem(plaidItemId);
      if (!plaidItem) {
        return res.status(404).json({ error: "Plaid connection not found" });
      }

      console.log(`[PLAID ANALYZE] Generating Asset Report for analysis...`);
      
      // Generate Asset Report for comprehensive financial data
      const assetReport = await plaidService.createAndGetAssetReport(plaidItem.accessToken, 90);
      
      // Format Asset Report data for OpenAI analysis
      let analysisText = "=== PLAID ASSET REPORT ===\n";
      analysisText += `Report Generated: ${assetReport.report?.date_generated || 'N/A'}\n`;
      analysisText += `Days Requested: ${assetReport.report?.days_requested || 90}\n\n`;
      
      // Process each item in the report
      if (assetReport.report?.items) {
        for (const item of assetReport.report.items) {
          analysisText += `=== INSTITUTION: ${item.institution_name || 'Unknown'} ===\n\n`;
          
          // Process each account
          if (item.accounts) {
            for (const account of item.accounts) {
              analysisText += `--- ACCOUNT: ${account.name} (${account.subtype || account.type}) ---\n`;
              analysisText += `Account Mask: ****${account.mask || 'N/A'}\n`;
              analysisText += `Current Balance: $${account.balances?.current?.toFixed(2) || 'N/A'}\n`;
              analysisText += `Available Balance: $${account.balances?.available?.toFixed(2) || 'N/A'}\n`;
              
              // Historical balances (very valuable for analysis)
              if (account.historical_balances && account.historical_balances.length > 0) {
                analysisText += `\nHistorical Daily Balances (${account.historical_balances.length} days):\n`;
                const balances = account.historical_balances.slice(0, 90); // Last 90 days
                let totalBalance = 0;
                let minBalance = Infinity;
                let maxBalance = -Infinity;
                let negativeDays = 0;
                
                for (const bal of balances) {
                  const current = bal.current || 0;
                  totalBalance += current;
                  minBalance = Math.min(minBalance, current);
                  maxBalance = Math.max(maxBalance, current);
                  if (current < 0) negativeDays++;
                }
                
                const avgBalance = balances.length > 0 ? totalBalance / balances.length : 0;
                analysisText += `  Average Daily Balance: $${avgBalance.toFixed(2)}\n`;
                analysisText += `  Minimum Balance: $${minBalance === Infinity ? 'N/A' : minBalance.toFixed(2)}\n`;
                analysisText += `  Maximum Balance: $${maxBalance === -Infinity ? 'N/A' : maxBalance.toFixed(2)}\n`;
                analysisText += `  Days with Negative Balance: ${negativeDays}\n`;
                
                // Show sample of recent balances
                analysisText += `\n  Recent Balance History:\n`;
                for (const bal of balances.slice(0, 30)) {
                  analysisText += `    ${bal.date}: $${bal.current?.toFixed(2) || '0.00'}\n`;
                }
              }
              
              // Transactions from asset report
              if (account.transactions && account.transactions.length > 0) {
                analysisText += `\nTransactions (${account.transactions.length} total):\n`;
                
                // Calculate deposits and withdrawals
                let totalDeposits = 0;
                let totalWithdrawals = 0;
                let depositCount = 0;
                let withdrawalCount = 0;
                
                for (const txn of account.transactions) {
                  const amount = txn.amount || 0;
                  if (amount < 0) {
                    totalDeposits += Math.abs(amount);
                    depositCount++;
                  } else {
                    totalWithdrawals += amount;
                    withdrawalCount++;
                  }
                }
                
                analysisText += `  Total Deposits: $${totalDeposits.toFixed(2)} (${depositCount} transactions)\n`;
                analysisText += `  Total Withdrawals: $${totalWithdrawals.toFixed(2)} (${withdrawalCount} transactions)\n`;
                analysisText += `  Estimated Monthly Revenue: $${(totalDeposits / 3).toFixed(2)}\n`;
                
                // Show recent transactions
                analysisText += `\n  Recent Transactions:\n`;
                for (const txn of account.transactions.slice(0, 50)) {
                  const amount = txn.amount < 0 ? `+$${Math.abs(txn.amount).toFixed(2)}` : `-$${txn.amount.toFixed(2)}`;
                  analysisText += `    ${txn.date} | ${amount} | ${txn.original_description || txn.name || 'N/A'}\n`;
                }
              }
              
              // Days available (how long account has been open)
              if (account.days_available !== undefined) {
                analysisText += `\nAccount History: ${account.days_available} days of data available\n`;
              }
              
              // Ownership info if available
              if (account.owners && account.owners.length > 0) {
                analysisText += `\nAccount Owners:\n`;
                for (const owner of account.owners) {
                  if (owner.names) {
                    analysisText += `  Name: ${owner.names.join(', ')}\n`;
                  }
                }
              }
              
              analysisText += `\n`;
            }
          }
        }
      }

      console.log(`[PLAID ANALYZE] Analyzing ${analysisText.length} chars of Asset Report data`);

      // Analyze with OpenAI
      const analysis = await analyzeBankStatements(analysisText, {
        creditScoreRange,
        timeInBusiness,
        industry,
      });

      // Get institution name from report
      const institutionName = assetReport.report?.items?.[0]?.institution_name || 'Unknown Bank';

      res.json({
        success: true,
        analysis,
        source: "plaid_asset_report",
        institutionName,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error("[PLAID ANALYZE] Error:", error);
      res.status(500).json({
        error: "Analysis failed",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  // ========================================
  // CHIRP INTEGRATION ROUTES
  // ========================================

  // POST /api/chirp/request — create a verification request for a customer
  // Server-side proxy to Chirp API. chirpAxios sends Origin/Referer headers
  // that match chirp.digital's own interface to satisfy Cloudflare WAF.
  app.post("/api/chirp/request", async (req: Request, res: Response) => {
    try {
      const { firstName, lastName, email, phone, applicationId, customerId } = req.body;
      if (!firstName || !lastName || !email || !phone) {
        return res.status(400).json({ error: "firstName, lastName, email, and phone are required" });
      }
      const result = await chirpService.createVerificationRequest({
        cusFirstName: firstName,
        cusLastName: lastName,
        cusEmail: email,
        cusPhone: phone,
        customerId: customerId || applicationId,
        leadId: applicationId,
        leadProvider: "TodayCapital",
      });
      console.log(`[CHIRP] Created request ${result.requestCode} for ${firstName} ${lastName}`);
      // Fire-and-forget: store requestCode against the matching loan application
      if (result.requestCode) {
        storage.saveChirpRequestCode(email, phone, result.requestCode).catch(e =>
          console.warn("[CHIRP] Failed to persist requestCode:", e)
        );
      }
      // Sanitize URLs — Chirp sandbox sometimes returns "NA" as a placeholder
      const sanitizeUrl = (u?: string) =>
        u && /^https?:\/\//i.test(u.trim()) ? u.trim() : undefined;
      const safeWidget = sanitizeUrl(result.widgetUrl)
        || `https://chirp.digital/api/widget?requestCode=${result.requestCode}`;
      const safeVerification = sanitizeUrl(result.verificationUrl) || safeWidget;
      res.json({ success: true, ...result, widgetUrl: safeWidget, verificationUrl: safeVerification });
    } catch (err: any) {
      console.error("[CHIRP] createVerificationRequest error:", err);
      res.status(err instanceof ChirpApiError ? err.status : 500).json({ error: err.message });
    }
  });

  // GET /api/chirp/connections — list all applications with a stored Chirp request code
  app.get("/api/chirp/connections", async (req: Request, res: Response) => {
    if (!req.session.user?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }
    try {
      const apps = await storage.getApplicationsWithChirpCode();
      const connections = apps.map(a => ({
        id: a.id,
        fullName: a.fullName,
        email: a.email,
        phone: a.phone,
        businessName: a.businessName,
        requestedAmount: a.requestedAmount,
        chirpRequestCode: (a as any).chirpRequestCode,
        createdAt: a.createdAt,
      }));
      res.json(connections);
    } catch (err: any) {
      console.error("[CHIRP] getApplicationsWithChirpCode error:", err);
      res.status(500).json({ error: "Failed to fetch Chirp connections" });
    }
  });

  // GET /api/admin/underwriter-snapshot/:email — quick-glance banking data for underwriters
  app.get("/api/admin/underwriter-snapshot/:email", async (req: Request, res: Response) => {
    if (!req.session.user?.isAuthenticated || req.session.user.role === 'merchant') {
      return res.status(401).json({ error: "Admin authentication required" });
    }
    try {
      const email = decodeURIComponent(req.params.email);
      const snapshot = await storage.getMerchantBankSnapshot(email);
      if (!snapshot) {
        return res.json({ hasData: false });
      }
      const accounts: any[] = Array.isArray(snapshot.accountsData) ? snapshot.accountsData : [];
      const metrics = (snapshot.metrics as any) || {};
      const summary = (snapshot.summaryData as any) || {};
      const activityByMonth: any[] = summary?.activityByMonth || [];

      res.json({
        hasData: true,
        merchantEmail: snapshot.merchantEmail,
        chirpRequestCode: snapshot.chirpRequestCode,
        institutionName: snapshot.institutionName,
        status: snapshot.status,
        isAccountConnected: Boolean(snapshot.isAccountConnected),
        connectedAt: snapshot.connectedAt,
        lastSyncedAt: snapshot.lastSyncedAt,
        accounts: accounts.map(a => ({
          name: a.accountName || "Account",
          type: a.type || "",
          balance: Number(a.balance) || 0,
          chirpAccountId: a.chirpAccountId || null,
        })),
        metrics: {
          monthlyRevenue: Number(metrics.monthlyRevenue) || 0,
          monthlyExpenses: Number(metrics.monthlyExpenses) || 0,
          netCashFlow: Number(metrics.netCashFlow) || 0,
          avgBalance: Number(metrics.avgBalance) || 0,
          currentBalance: Number(metrics.currentBalance) || 0,
          monthsAnalyzed: Number(metrics.monthsAnalyzed) || 0,
          revenueTrend: metrics.revenueTrend || null,
          healthScore: Number(metrics.healthScore) || 0,
        },
        // Monthly breakdown for underwriter review
        activityByMonth: activityByMonth
          .filter((m: any) => (m.month || "").toLowerCase() !== "all")
          .map((m: any) => ({
            month: m.month,
            totalCredit: m.totalCredit,
            totalDebit: m.totalDebit,
            averageDailyBalance: m.averageDailyBalance,
            net: m.net || m.totalNet,
          })),
      });
    } catch (err: any) {
      console.error("[ADMIN] underwriter-snapshot error:", err);
      res.status(500).json({ error: "Failed to load underwriter snapshot" });
    }
  });

  // GET /api/chirp/request/:code/pdf/download — stream PDF bank statement report
  app.get("/api/chirp/request/:code/pdf/download", async (req: Request, res: Response) => {
    if (!req.session.user?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }
    try {
      const { code } = req.params;
      const { accountNumber, chirpAccountId } = req.query as { accountNumber?: string; chirpAccountId?: string };

      let account: { accountNumber?: string; chirpAccountId?: string } = {};
      if (chirpAccountId) {
        account = { chirpAccountId };
      } else if (accountNumber) {
        account = { accountNumber };
      } else {
        // Attempt to find the first account from details
        try {
          const details = await chirpService.getRequestDetails(code, { numberOfDays: 90, sort: "DESCENDING" });
          const firstAccount = (details as any)?.accounts?.[0];
          if (firstAccount?.chirpAccountId) account = { chirpAccountId: firstAccount.chirpAccountId };
          else if (firstAccount?.accountNumber) account = { accountNumber: firstAccount.accountNumber };
        } catch (_) { /* fall through with empty account */ }
      }

      const pdfBuffer = await chirpService.downloadReportPdfBytes(code, account);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="chirp-report-${code}.pdf"`);
      res.send(pdfBuffer);
    } catch (err: any) {
      console.error("[CHIRP] PDF download error:", err);
      res.status(err instanceof ChirpApiError ? err.status : 500).json({ error: err.message });
    }
  });

  // POST /api/chirp/request/:code/token — generate ChirpLink widget token
  app.post("/api/chirp/request/:code/token", async (req: Request, res: Response) => {
    try {
      const { code } = req.params;
      const result = await chirpService.genAuthTokenForChirpLink(code);
      res.json(result);
    } catch (err: any) {
      console.error("[CHIRP] genAuthTokenForChirpLink error:", err);
      res.status(err instanceof ChirpApiError ? err.status : 500).json({ error: err.message });
    }
  });

  // GET /api/chirp/request/:code/status — poll verification status
  app.get("/api/chirp/request/:code/status", async (req: Request, res: Response) => {
    try {
      const { code } = req.params;
      const result = await chirpService.getRequestStatus(code);
      res.json(result);
    } catch (err: any) {
      console.error("[CHIRP] getRequestStatus error:", err);
      res.status(err instanceof ChirpApiError ? err.status : 500).json({ error: err.message });
    }
  });

  // GET /api/chirp/request/:code/details — get full verified data (accounts + transactions)
  app.get("/api/chirp/request/:code/details", async (req: Request, res: Response) => {
    try {
      const { code } = req.params;
      const days = req.query.days ? Number(req.query.days) : 90;
      const result = await chirpService.getRequestDetails(code, { numberOfDays: days, sort: "DESCENDING" });
      res.json(result);
    } catch (err: any) {
      console.error("[CHIRP] getRequestDetails error:", err);
      res.status(err instanceof ChirpApiError ? err.status : 500).json({ error: err.message });
    }
  });

  // GET /api/chirp/request/:code/summary — pre-computed financial summary
  app.get("/api/chirp/request/:code/summary", async (req: Request, res: Response) => {
    try {
      const { code } = req.params;
      const result = await chirpService.getSummaryInfoByRequestCode(code);
      res.json(result);
    } catch (err: any) {
      console.error("[CHIRP] getSummaryInfo error:", err);
      res.status(err instanceof ChirpApiError ? err.status : 500).json({ error: err.message });
    }
  });

  // POST /api/chirp/request/:code/pdf — generate PDF report
  app.post("/api/chirp/request/:code/pdf", async (req: Request, res: Response) => {
    try {
      const { code } = req.params;
      const { accountNumber, chirpAccountId } = req.body;
      const result = await chirpService.getRequestReportAsPDF(code, { accountNumber, chirpAccountId });
      res.json(result);
    } catch (err: any) {
      console.error("[CHIRP] getRequestReportAsPDF error:", err);
      res.status(err instanceof ChirpApiError ? err.status : 500).json({ error: err.message });
    }
  });

  // POST /api/chirp/request/:code/refresh — refresh a verified connection
  app.post("/api/chirp/request/:code/refresh", async (req: Request, res: Response) => {
    try {
      const { code } = req.params;
      const result = await chirpService.refreshRequest(code, req.body.metaInfo);
      res.json(result);
    } catch (err: any) {
      console.error("[CHIRP] refreshRequest error:", err);
      res.status(err instanceof ChirpApiError ? err.status : 500).json({ error: err.message });
    }
  });

  // GET /api/chirp/health — verify token is configured and environment
  app.get("/api/chirp/health", async (_req: Request, res: Response) => {
    const configured = !!process.env.CHIRP_API_TOKEN;
    res.json({
      configured,
      environment: process.env.CHIRP_ENV || "production",
      clientId: process.env.CHIRP_CLIENT_ID || null,
    });
  });

  // ========================================
  // MERCHANT-SCOPED CHIRP BANKING ROUTES
  //
  // These endpoints power the merchant portal's banking view. They never
  // expose raw request codes to the client; they resolve the merchant's
  // connection from the authenticated session and proxy through our cached
  // snapshot so we only hit Chirp on (a) initial connect, (b) an explicit
  // sync, or (c) a Chirp webhook push. Everything else is pure DB reads.
  // ========================================

  // Shared helper: build + persist merchant snapshot from Chirp responses
  // Helper: register a Chirp webhook for a given requestCode so Chirp pushes
  // status updates to us (inbound) rather than us polling (outbound GET blocked
  // by Cloudflare WAF on some server IPs).
  async function registerChirpWebhookForCode(requestCode: string): Promise<void> {
    const baseUrl = process.env.PUBLIC_BASE_URL;
    if (!baseUrl) return;
    const webhookUrl = `${baseUrl.replace(/\/$/, "")}/api/chirp/webhook`;
    try {
      await chirpService.createCustomerNotification({
        name: `merchant-portal-status-${requestCode}`,
        requestCode,
        type: "REQUEST_STATUS",
        rule: "GREATER_THAN",
        webhookUrl: [webhookUrl],
        notifyIf: ["ALL"],
        notifyViaWebhook: true,
      });
      console.log(`[CHIRP] Webhook registered for requestCode ${requestCode} → ${webhookUrl}`);
    } catch (e: any) {
      console.warn(`[CHIRP] Failed to register webhook for ${requestCode}:`, e?.message || e);
    }
  }

  // Download the Chirp bank report PDF for a connected snapshot and file it
  // into bank_statement_uploads (source='chirp') so the entire existing
  // underwriting pipeline — statements list, AI analysis, UW review — works
  // without the merchant ever uploading a statement. Deduped to one auto-filed
  // report per 25 days per merchant.
  async function fileChirpStatementForSnapshot(snapshot: MerchantBankSnapshot): Promise<boolean> {
    const email = snapshot.merchantEmail;
    if (!snapshot.chirpRequestCode) return false;
    if (snapshot.statementFiledAt && Date.now() - new Date(snapshot.statementFiledAt).getTime() < 25 * 24 * 60 * 60 * 1000) {
      return false;
    }

    const accounts: any[] = Array.isArray(snapshot.accountsData) ? (snapshot.accountsData as any[]) : [];
    const withIds = accounts.filter(a => a.chirpAccountId || a.accountNumber);
    const pick = withIds.find(a => /check/i.test(`${a.type || ""} ${a.subtype || ""} ${a.accountName || ""}`)) || withIds[0];

    let pdf: Buffer;
    try {
      pdf = await chirpService.downloadReportPdfBytes(snapshot.chirpRequestCode, {
        chirpAccountId: pick?.chirpAccountId || undefined,
        accountNumber: pick?.accountNumber || undefined,
      });
    } catch (e: any) {
      console.warn(`[CHIRP] report PDF fetch failed for ${email}:`, e?.message || e);
      return false;
    }
    if (!pdf || pdf.length < 1000) {
      console.warn(`[CHIRP] report PDF for ${email} too small (${pdf?.length || 0} bytes) — not filing`);
      return false;
    }

    const dateStamp = new Date().toISOString().slice(0, 10);
    const fileName = `Chirp Bank Report - ${(snapshot.institutionName || "Connected Bank").replace(/[^\w \-\.]/g, "")} - ${dateStamp}.pdf`;

    let storedFileName: string;
    if (objectStorage.isConfigured()) {
      storedFileName = await objectStorage.uploadFile(pdf, `bank-statements/${email}/${Date.now()}_${fileName}`, "application/pdf");
    } else {
      storedFileName = `${Date.now()}_${fileName}`;
      fs.writeFileSync(path.join(UPLOAD_DIR, storedFileName), pdf);
    }

    const decision = await storage.getBusinessUnderwritingDecisionByEmail(email).catch(() => null);
    await storage.createBankStatementUpload({
      email,
      businessName: decision?.businessName || null,
      originalFileName: fileName,
      storedFileName,
      fileSize: pdf.length,
      mimeType: "application/pdf",
      source: "chirp",
      viewToken: randomUUID(),
    });
    await storage.upsertMerchantBankSnapshot({
      merchantEmail: email,
      chirpRequestCode: snapshot.chirpRequestCode,
      statementFiledAt: new Date(),
    });

    logPortalEvent('merchant', email, 'chirp_statement_filed', fileName);
    if (shouldSendMerchantAlert(`chirp_statement:${email}`, 24 * 60 * 60 * 1000)) {
      sendAdminMerchantAlert({
        title: "Chirp Bank Report Filed as Statement",
        event: "chirp_statement_filed",
        merchantEmail: email,
        businessName: decision?.businessName || undefined,
        details: {
          institution: snapshot.institutionName || "Unknown",
          fileName,
          sizeKb: Math.round(pdf.length / 1024),
          note: "Auto-generated from the merchant's live bank connection — visible in Bank Statements.",
        },
      }).catch(() => {});
    }
    console.log(`[CHIRP] Filed bank report PDF as statement for ${email} (${Math.round(pdf.length / 1024)} KB)`);
    return true;
  }

  async function syncMerchantSnapshotFromChirp(merchantEmail: string, requestCode: string): Promise<MerchantBankSnapshot | null> {
    // Track whether ANY of the three read endpoints succeeded.
    let anySucceeded = false;
    let status: any = null;
    let details: any = null;
    let summary: any = null;

    try {
      [status, details, summary] = await Promise.all([
        chirpService.getRequestStatus(requestCode).catch((e) => { console.warn(`[CHIRP] getRequestStatus 403/err: ${e?.message}`); return null; }),
        chirpService.getRequestDetails(requestCode, { numberOfDays: 90, sort: "DESCENDING" }).catch((e) => { console.warn(`[CHIRP] getRequestDetails 403/err: ${e?.message}`); return null; }),
        chirpService.getSummaryInfoByRequestCode(requestCode).catch((e) => { console.warn(`[CHIRP] getSummaryInfo 403/err: ${e?.message}`); return null; }),
      ]);
      anySucceeded = status !== null || details !== null || summary !== null;
    } catch (err: any) {
      console.warn(`[CHIRP] sync parallel fetch error: ${err?.message}`);
    }

    // If ALL endpoints failed (likely WAF block), register a webhook so we get
    // notified when data becomes available, then return the current snapshot.
    if (!anySucceeded) {
      console.warn(`[CHIRP] All read endpoints blocked for ${requestCode}. Registering webhook for push delivery.`);
      registerChirpWebhookForCode(requestCode).catch(() => {});
      return (await storage.getMerchantBankSnapshotByRequestCode(requestCode)) ?? null;
    }

    try {
      const accounts: any[] = (details as any)?.Accounts || (details as any)?.accounts || [];
      const institutionName =
        (details as any)?.InstitutionName ||
        (details as any)?.institutionName ||
        status?.selectedBank ||
        null;

      // Derive merchant-friendly metrics from Chirp's pre-aggregated summary.
      const parseMoney = (v: unknown): number => {
        if (typeof v === "number") return v;
        if (typeof v !== "string") return 0;
        const n = Number.parseFloat(v.replace(/[^0-9.\-]/g, ""));
        return Number.isFinite(n) ? n : 0;
      };

      // Primary: use Chirp's pre-aggregated summary when available
      const activityByMonth: any[] = (summary as any)?.activityByMonth || [];
      const perMonth = activityByMonth.filter((m: any) => (m.month || "").toLowerCase() !== "all");
      let monthlyRevenue = 0;
      let monthlyExpenses = 0;
      let avgBalance = 0;
      let currentBalance = 0;
      let monthsAnalyzed = perMonth.length;

      if (perMonth.length > 0) {
        // Summary endpoint available — use pre-computed aggregates
        monthlyRevenue = perMonth.reduce((s, m) => s + parseMoney(m.totalCredit), 0) / perMonth.length;
        monthlyExpenses = perMonth.reduce((s, m) => s + parseMoney(m.totalDebit), 0) / perMonth.length;
        const overall = activityByMonth.find((m: any) => (m.month || "").toLowerCase() === "all") || activityByMonth[0];
        avgBalance = parseMoney(overall?.averageDailyBalance ?? overall?.averageMonthlyBalance);
        currentBalance = parseMoney((summary as any)?.currentBalance);
      } else if (details) {
        // Fallback: compute metrics from raw transaction data in details.
        // Chirp returns TransactionSummaries as a flat array where each item
        // IS a transaction (not a wrapper with a sub-array).
        console.log(`[CHIRP] Summary unavailable for ${requestCode}, computing from transaction details`);
        const allTxns: any[] = (details as any)?.TransactionSummaries || (details as any)?.transactionSummaries || [];

        // Group transactions by month, classifying as credit (deposit) or debit
        // Chirp transaction formats vary — try multiple signals:
        //   1. type field: "CREDIT"/"DEBIT" or "credit"/"debit"
        //   2. is_income / is_direct_deposit booleans
        //   3. category containing "deposit", "transfer-in", "payroll"
        //   4. Positive amount = credit (deposit), negative = debit (Chirp convention)
        //   5. description containing "deposit", "payment from", "transfer from"
        const byMonth = new Map<string, { credits: number; debits: number }>();
        for (const txn of allTxns) {
          const date = txn.date || txn.transacted_at || txn.posted_at || "";
          const monthKey = date.substring(0, 7); // YYYY-MM
          if (!monthKey) continue;
          const entry = byMonth.get(monthKey) || { credits: 0, debits: 0 };
          const rawAmt = parseMoney(txn.amount);
          const amt = Math.abs(rawAmt);
          if (amt === 0) continue;

          // Determine if this is a credit (income/deposit) or debit (expense/payment)
          const typeStr = (txn.type || txn.transaction_type || "").toUpperCase();
          const desc = (txn.description || txn.original_description || txn.name || "").toLowerCase();
          const cats = Array.isArray(txn.category) ? txn.category.join(" ").toLowerCase() : (txn.category || "").toLowerCase();

          const isCredit =
            typeStr === "CREDIT" ||
            txn.is_income === true ||
            txn.is_direct_deposit === true ||
            cats.includes("deposit") || cats.includes("payroll") || cats.includes("transfer-in") ||
            desc.includes("deposit") || desc.includes("payment from") || desc.includes("transfer from") || desc.includes("direct dep") ||
            (rawAmt > 0 && typeStr !== "DEBIT"); // Positive amount = credit (Chirp convention)

          if (isCredit) {
            entry.credits += amt;
          } else {
            entry.debits += amt;
          }
          byMonth.set(monthKey, entry);
        }

        monthsAnalyzed = byMonth.size;
        if (monthsAnalyzed > 0) {
          let totalCredits = 0, totalDebits = 0;
          for (const [, v] of byMonth) {
            totalCredits += v.credits;
            totalDebits += v.debits;
          }
          monthlyRevenue = totalCredits / monthsAnalyzed;
          monthlyExpenses = totalDebits / monthsAnalyzed;
        }

        // Current balance = sum of all account balances
        if (accounts.length > 0) {
          currentBalance = accounts.reduce((s: number, a: any) => s + parseMoney(a.balance ?? a.available_balance ?? 0), 0);
          avgBalance = currentBalance / accounts.length;
        }

        console.log(`[CHIRP] Computed from ${allTxns.length} txns over ${monthsAnalyzed} months: revenue=$${Math.round(monthlyRevenue)}, expenses=$${Math.round(monthlyExpenses)}, balance=$${Math.round(currentBalance)}`);
      }

      const netCashFlow = monthlyRevenue - monthlyExpenses;

      // Normalize + store raw transactions so downstream analysis (MCA
      // detection, NSF counts, statement replacement) works even when later
      // Chirp reads are WAF-blocked
      const rawTxns: any[] = (details as any)?.TransactionSummaries || (details as any)?.transactionSummaries || [];
      const normalizedTxns = normalizeChirpTransactions(rawTxns);
      const underwriting = normalizedTxns.length > 0 ? computeUnderwritingMetrics(normalizedTxns) : null;

      // Prefer transaction-derived revenue when the summary endpoint gave us
      // nothing (it excludes self-transfers and MCA funding credits)
      if (monthlyRevenue === 0 && underwriting && underwriting.avgMonthlyDeposits > 0) {
        monthlyRevenue = underwriting.avgMonthlyTrueRevenue || underwriting.avgMonthlyDeposits;
      }

      // Compute revenue trend from month-over-month data
      let revenueTrend: "growing" | "stable" | "declining" | null = null;
      if (perMonth.length >= 2) {
        // perMonth from summary is typically sorted newest-first; compare recent vs older half
        const half = Math.floor(perMonth.length / 2);
        const recentAvg = perMonth.slice(0, half).reduce((s, m) => s + parseMoney(m.totalCredit), 0) / half;
        const olderAvg = perMonth.slice(half).reduce((s, m) => s + parseMoney(m.totalCredit), 0) / (perMonth.length - half);
        const changePercent = olderAvg > 0 ? ((recentAvg - olderAvg) / olderAvg) * 100 : 0;
        revenueTrend = changePercent > 5 ? "growing" : changePercent < -5 ? "declining" : "stable";
      } else if (underwriting && underwriting.monthly.length >= 2) {
        // Fallback: derive trend from transaction-based monthly deposits (newest first)
        const months = underwriting.monthly;
        const half = Math.floor(months.length / 2);
        const recentAvg = months.slice(0, half).reduce((s, m) => s + m.trueRevenue, 0) / half;
        const olderAvg = months.slice(half).reduce((s, m) => s + m.trueRevenue, 0) / (months.length - half);
        const changePercent = olderAvg > 0 ? ((recentAvg - olderAvg) / olderAvg) * 100 : 0;
        revenueTrend = changePercent > 5 ? "growing" : changePercent < -5 ? "declining" : "stable";
      }

      // Compute financial health score (0-100)
      // Factors: positive cash flow, balance cushion, revenue consistency
      const cashFlowRatio = monthlyRevenue > 0 ? netCashFlow / monthlyRevenue : 0;
      const balanceCushion = monthlyExpenses > 0 ? currentBalance / monthlyExpenses : 0;
      const cashFlowScore = Math.min(40, Math.max(0, cashFlowRatio * 100)); // 0-40 pts
      const balanceScore = Math.min(30, Math.max(0, balanceCushion * 10));   // 0-30 pts
      const trendScore = revenueTrend === "growing" ? 30 : revenueTrend === "stable" ? 20 : 10; // 10-30 pts
      const healthScore = Math.round(Math.min(100, cashFlowScore + balanceScore + trendScore));

      // Connection state: trust the status endpoint when we have it; otherwise
      // infer from having real account/transaction data (webhook-only flows)
      const existingSnap = await storage.getMerchantBankSnapshotByRequestCode(requestCode);
      const inferredConnected = status
        ? Boolean(status.isAccountConnected)
        : (accounts.length > 0 || normalizedTxns.length > 0 || Boolean(existingSnap?.isAccountConnected));

      const snapshot = await storage.upsertMerchantBankSnapshot({
        merchantEmail,
        chirpRequestCode: requestCode,
        institutionName,
        status: status?.status || existingSnap?.status || null,
        isAccountConnected: inferredConnected,
        accountsData: accounts.length > 0 ? accounts.map((a: any) => ({
          accountName: a.name || a.accountName || "Account",
          type: a.type || a.accountType || "",
          subtype: a.subtype || "",
          balance: parseMoney(a.balance ?? a.available_balance ?? 0),
          chirpAccountId: a.chirpAccountId || a.guid || null,
          accountNumber: a.accountNumber || a.account_number || a.acctNumber || null,
        })) : undefined,
        summaryData: summary || undefined,
        transactionsData: normalizedTxns.length > 0 ? (normalizedTxns as any) : undefined,
        metrics: {
          monthlyRevenue: Math.round(monthlyRevenue * 100) / 100,
          monthlyExpenses: Math.round(monthlyExpenses * 100) / 100,
          netCashFlow: Math.round(netCashFlow * 100) / 100,
          avgBalance: Math.round(avgBalance * 100) / 100,
          currentBalance: Math.round(currentBalance * 100) / 100,
          monthsAnalyzed: monthsAnalyzed || underwriting?.monthly.length || 0,
          revenueTrend,
          healthScore,
          underwriting,
        },
        lastSyncedAt: new Date(),
      });

      // Once connected with real data, auto-file the Chirp bank report PDF as a
      // bank statement so underwriting can work from it (async, deduped inside)
      if (snapshot?.isAccountConnected) {
        fileChirpStatementForSnapshot(snapshot).catch(e =>
          console.warn(`[CHIRP] statement auto-filing failed for ${merchantEmail}:`, e?.message || e)
        );
      }

      return snapshot;
    } catch (err: any) {
      console.error(`[CHIRP] syncMerchantSnapshotFromChirp upsert failed for ${merchantEmail}:`, err?.message || err);
      return null;
    }
  }

  // POST /api/merchant/chirp/connect — create a verification request for the
  // authenticated merchant and stash a stub snapshot so we can look up the
  // request code later by merchant email.
  app.post("/api/merchant/chirp/connect", async (req: Request, res: Response) => {
    const merchantEmail = await getMerchantEmailFromRequest(req);
    if (!merchantEmail) {
      return res.status(401).json({ error: "Merchant authentication required" });
    }
    try {
      // Guard: don't clobber a live connection or spam Chirp with duplicate
      // requests. Re-serve the pending link when one is still fresh.
      const existingSnap = await storage.getMerchantBankSnapshot(merchantEmail);
      if (existingSnap && !req.body?.force) {
        if (existingSnap.isAccountConnected) {
          return res.json({
            success: true,
            alreadyConnected: true,
            institutionName: existingSnap.institutionName,
            lastSyncedAt: existingSnap.lastSyncedAt,
            message: "Your bank is already connected. Pass force=true to start a new connection.",
          });
        }
        const ageMs = existingSnap.createdAt ? Date.now() - new Date(existingSnap.createdAt).getTime() : Infinity;
        if (existingSnap.widgetUrl && ageMs < 24 * 60 * 60 * 1000) {
          return res.json({
            success: true,
            widgetUrl: existingSnap.widgetUrl,
            verificationUrl: existingSnap.verificationUrl || existingSnap.widgetUrl,
            requestCode: existingSnap.chirpRequestCode,
            resumed: true,
          });
        }
      }

      // Pull contact info from the business underwriting decision so the merchant doesn't re-enter it.
      const decisions = await storage.getBusinessUnderwritingDecisionsByMerchantEmail(merchantEmail);
      const primary = decisions[0];
      const fullName = (req.session.user as any).merchantName || primary?.businessName || "";
      const [firstGuess, ...restGuess] = fullName.trim().split(/\s+/);
      const firstName = (req.body?.firstName || firstGuess || "Merchant").toString();
      const lastName = (req.body?.lastName || restGuess.join(" ") || "Owner").toString();
      const phone = (req.body?.phone || primary?.businessPhone || "").toString();

      if (!phone) {
        return res.status(400).json({ error: "We need a phone number on file to connect your bank. Please update your profile or contact your rep." });
      }

      const result = await chirpService.createVerificationRequest({
        cusFirstName: firstName,
        cusLastName: lastName,
        cusEmail: merchantEmail,
        cusPhone: phone,
        customerId: primary?.id,
        leadId: primary?.id,
        leadProvider: "TodayCapitalMerchantPortal",
      });
      sendAdminMerchantAlert({
        title: "Bank Connection Started via Chirp",
        event: "chirp_connection_started",
        merchantEmail,
        merchantName: fullName || undefined,
        businessName: primary?.businessName || undefined,
        details: { requestCode: result.requestCode },
      }).catch(() => {});

      // Sanitize URLs — Chirp sandbox sometimes returns "NA" as a placeholder
      const sanitizeUrl = (u?: string) =>
        u && /^https?:\/\//i.test(u.trim()) ? u.trim() : undefined;
      const safeWidget = sanitizeUrl(result.widgetUrl)
        || `https://chirp.digital/api/widget?requestCode=${result.requestCode}`;
      const safeVerification = sanitizeUrl(result.verificationUrl) || safeWidget;

      // Persist a stub snapshot tied to merchant email so we can look up the
      // request code later without trusting the client. Explicit nulls reset
      // any data from a previous connection (this is a NEW request).
      await storage.upsertMerchantBankSnapshot({
        merchantEmail,
        chirpRequestCode: result.requestCode,
        status: "Unverified",
        isAccountConnected: false,
        institutionName: null,
        accountsData: null,
        summaryData: null,
        metrics: null,
        transactionsData: null,
        widgetUrl: safeWidget,
        verificationUrl: safeVerification,
        statementFiledAt: null,
        lastSyncedAt: null,
      });

      // Also persist on the loan application for cross-compat with existing admin views.
      storage.saveChirpRequestCode(merchantEmail, phone, result.requestCode).catch(e =>
        console.warn("[CHIRP] Failed to mirror requestCode on loan_applications:", e)
      );

      // Best-effort: register a webhook notification so Chirp pushes us status/refresh updates.
      if (process.env.PUBLIC_BASE_URL) {
        const webhookUrl = `${process.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/api/chirp/webhook`;
        chirpService.createCustomerNotification({
          name: `merchant-portal-${result.requestCode}`,
          requestCode: result.requestCode,
          type: "REQUEST_STATUS",
          rule: "GREATER_THAN",
          webhookUrl: [webhookUrl],
          notifyViaWebhook: true,
          notifyViaEmail: false,
          active: true,
        }).catch(e => console.warn("[CHIRP] Failed to register REQUEST_STATUS webhook:", e?.message || e));
        chirpService.createCustomerNotification({
          name: `merchant-portal-refresh-${result.requestCode}`,
          requestCode: result.requestCode,
          type: "REFRESH",
          rule: "GREATER_THAN",
          webhookUrl: [webhookUrl],
          notifyViaWebhook: true,
          notifyViaEmail: false,
          active: true,
        }).catch(e => console.warn("[CHIRP] Failed to register REFRESH webhook:", e?.message || e));
      }

      res.json({
        success: true,
        widgetUrl: safeWidget,
        verificationUrl: safeVerification,
        requestCode: result.requestCode,
      });
    } catch (err: any) {
      console.error("[CHIRP] merchant connect error:", err);
      res.status(err instanceof ChirpApiError ? err.status : 500).json({ error: err.message || "Failed to start bank connection" });
    }
  });

  // GET /api/merchant/banking/insights — pure DB read, called on every portal
  // view. Returns our cached snapshot; never hits Chirp.
  app.get("/api/merchant/banking/insights", async (req: Request, res: Response) => {
    const merchantEmail = await getMerchantEmailFromRequest(req);
    if (!merchantEmail) {
      return res.status(401).json({ error: "Merchant authentication required" });
    }
    try {
      const snapshot = await storage.getMerchantBankSnapshot(merchantEmail);
      if (!snapshot) {
        return res.json({ connected: false, hasPendingConnection: false });
      }
      const accounts: any[] = Array.isArray(snapshot.accountsData) ? snapshot.accountsData : [];
      const metrics = (snapshot.metrics as any) || {};
      // hasPendingConnection = we have a requestCode but bank isn't confirmed connected yet
      const hasPendingConnection = Boolean(snapshot.chirpRequestCode) && !snapshot.isAccountConnected;
      res.json({
        connected: Boolean(snapshot.isAccountConnected),
        hasPendingConnection,
        status: snapshot.status,
        institutionName: snapshot.institutionName,
        connectedAt: snapshot.connectedAt,
        lastSyncedAt: snapshot.lastSyncedAt,
        accounts: accounts.map(a => ({
          name: a.accountName || "Account",
          type: a.type || "",
          balance: Number(a.balance) || 0,
        })),
        metrics: {
          monthlyRevenue: Number(metrics.monthlyRevenue) || 0,
          monthlyExpenses: Number(metrics.monthlyExpenses) || 0,
          netCashFlow: Number(metrics.netCashFlow) || 0,
          avgBalance: Number(metrics.avgBalance) || 0,
          currentBalance: Number(metrics.currentBalance) || 0,
          monthsAnalyzed: Number(metrics.monthsAnalyzed) || 0,
          revenueTrend: metrics.revenueTrend || null,
          healthScore: Number(metrics.healthScore) || 0,
        },
      });
    } catch (err: any) {
      console.error("[CHIRP] banking insights error:", err);
      res.status(500).json({ error: "Failed to load banking insights" });
    }
  });

  // POST /api/merchant/chirp/sync — explicit sync. Reads from Chirp's own
  // cache (getRequestDetails + getSummaryInfoByRequestCode) and does NOT call
  // /refresh (which would bill a bank sync). Server-side cooldown prevents
  // back-to-back calls from racing.
  app.post("/api/merchant/chirp/sync", async (req: Request, res: Response) => {
    const merchantEmail = await getMerchantEmailFromRequest(req);
    if (!merchantEmail) {
      return res.status(401).json({ error: "Merchant authentication required" });
    }
    try {
      const existing = await storage.getMerchantBankSnapshot(merchantEmail);
      if (!existing?.chirpRequestCode) {
        return res.status(400).json({ error: "No bank connection found. Connect your bank first." });
      }
      // Cooldown: once every 10 minutes for already-connected accounts.
      // Skip cooldown when account is still pending (not yet confirmed connected).
      const COOLDOWN_MS = 10 * 60 * 1000;
      const isPending = !existing.isAccountConnected;
      if (!isPending && existing.lastSyncedAt && Date.now() - new Date(existing.lastSyncedAt).getTime() < COOLDOWN_MS) {
        return res.status(429).json({ error: "Recently synced — try again in a few minutes." });
      }
      const snapshot = await syncMerchantSnapshotFromChirp(merchantEmail, existing.chirpRequestCode);
      if (!snapshot) {
        // Sync returned null — could mean WAF block; webhook is already registered.
        // Return a non-error 200 so the merchant portal doesn't show an error toast.
        return res.json({ success: true, pending: true, message: "Your bank status will update automatically when Chirp sends us the data." });
      }
      res.json({ success: true, lastSyncedAt: snapshot.lastSyncedAt });
    } catch (err: any) {
      console.error("[CHIRP] merchant sync error:", err);
      res.status(500).json({ error: err.message || "Sync failed" });
    }
  });

  // POST /api/merchant/chirp/register-webhook — re-registers the Chirp webhook
  // for the merchant's existing requestCode. Useful when PUBLIC_BASE_URL was not
  // set at the time the request was created, or after server restart.
  app.post("/api/merchant/chirp/register-webhook", async (req: Request, res: Response) => {
    const merchantEmail = await getMerchantEmailFromRequest(req);
    if (!merchantEmail) {
      return res.status(401).json({ error: "Merchant authentication required" });
    }
    try {
      const snapshot = await storage.getMerchantBankSnapshot(merchantEmail);
      if (!snapshot?.chirpRequestCode) {
        return res.status(400).json({ error: "No bank connection found." });
      }
      await registerChirpWebhookForCode(snapshot.chirpRequestCode);
      res.json({ success: true, requestCode: snapshot.chirpRequestCode });
    } catch (err: any) {
      console.error("[CHIRP] register-webhook error:", err);
      res.status(500).json({ error: err.message || "Failed to register webhook" });
    }
  });

  // DELETE /api/merchant/chirp/connection — disconnect (removes our cached
  // snapshot; Chirp side remains subscribed until we call unsubscribeRequest
  // from an admin flow — keeping this scope tight on purpose).
  app.delete("/api/merchant/chirp/connection", async (req: Request, res: Response) => {
    const merchantEmail = await getMerchantEmailFromRequest(req);
    if (!merchantEmail) {
      return res.status(401).json({ error: "Merchant authentication required" });
    }
    try {
      await storage.deleteMerchantBankSnapshot(merchantEmail);
      res.json({ success: true });
    } catch (err: any) {
      console.error("[CHIRP] disconnect error:", err);
      res.status(500).json({ error: "Failed to disconnect" });
    }
  });

  // POST /api/chirp/webhook — Chirp pushes REQUEST_STATUS / REFRESH events
  // here. We extract status from the payload itself so we don't need to
  // make outbound API calls (which Cloudflare may block on some server IPs).
  app.post("/api/chirp/webhook", async (req: Request, res: Response) => {
    try {
      const secret = process.env.CHIRP_WEBHOOK_SECRET;
      if (secret) {
        const header = (req.headers["x-chirp-secret"] || req.headers["authorization"]) as string | undefined;
        if (!header || !header.includes(secret)) {
          return res.status(401).json({ error: "Unauthorized webhook" });
        }
      }
      const body = req.body || {};
      console.log("[CHIRP] webhook received:", JSON.stringify(body).slice(0, 500));

      // Chirp payload shapes vary; flatten nested data/payload wrapper if present
      const data = body?.data || body?.payload || body;
      const requestCode: string | undefined =
        data.requestCode || data.RequestCode || data.request_code ||
        body?.data?.requestCode || body?.payload?.requestCode;
      if (!requestCode) {
        console.warn("[CHIRP] webhook received without requestCode", body);
        return res.status(400).json({ error: "Missing requestCode" });
      }

      const snapshot = await storage.getMerchantBankSnapshotByRequestCode(requestCode);
      if (!snapshot) {
        console.log(`[CHIRP] webhook for unknown requestCode ${requestCode} — ignoring`);
        return res.json({ success: true, ignored: true });
      }

      // --- Extract status info directly from webhook payload ---
      // Chirp sends various field names depending on notification type.
      const statusStr: string =
        data.status || data.Status || data.requestStatus || data.RequestStatus || "";
      const isVerified = /verif/i.test(statusStr) || statusStr === "1";
      const isConnected: boolean =
        data.isAccountConnected ?? data.IsAccountConnected ?? data.accountConnected ?? isVerified;
      const institutionName: string =
        data.institutionName || data.InstitutionName || data.selectedBank || data.bank || snapshot.institutionName || "";
      const accounts: any[] = data.accounts || data.Accounts || [];

      // Persist what we know from the webhook payload immediately so the
      // merchant portal reflects the new status without waiting for a sync.
      await storage.upsertMerchantBankSnapshot({
        merchantEmail: snapshot.merchantEmail,
        chirpRequestCode: requestCode,
        status: statusStr || snapshot.status,
        isAccountConnected: Boolean(isConnected),
        institutionName: institutionName || snapshot.institutionName,
        connectedAt: isConnected && !snapshot.connectedAt ? new Date() : snapshot.connectedAt,
        accountsData: accounts.length > 0 ? accounts : (snapshot.accountsData as any[]),
        // Preserve existing metrics if the webhook doesn't include them
        metrics: snapshot.metrics as any,
        lastSyncedAt: new Date(),
      });
      console.log(`[CHIRP] webhook updated snapshot for ${snapshot.merchantEmail}: connected=${isConnected}, status="${statusStr}"`);
      if (isConnected && shouldSendMerchantAlert(`chirp_connected:${snapshot.merchantEmail}`, 24 * 60 * 60 * 1000)) {
        sendAdminMerchantAlert({
          title: "Bank Connected via Chirp",
          event: "chirp_bank_connected",
          merchantEmail: snapshot.merchantEmail,
          businessName: undefined,
          details: { requestCode, status: statusStr || "connected", institution: institutionName || "Unknown" },
        }).catch(() => {});
      }

      // Also attempt a full data sync (gets financial metrics if API is reachable).
      // Fire-and-forget — don't let API errors block the webhook 200 response.
      syncMerchantSnapshotFromChirp(snapshot.merchantEmail, requestCode).catch(e =>
        console.warn("[CHIRP] webhook-triggered full sync failed (may be WAF block):", e?.message || e)
      );

      res.json({ success: true });
    } catch (err: any) {
      console.error("[CHIRP] webhook error:", err);
      res.status(500).json({ error: "Webhook handler failed" });
    }
  });

  // ── CHIRP BACKGROUND POLLER ────────────────────────────────────────────
  // Two jobs, every 10 minutes:
  //  1. Pending connections (<72h old): poll Chirp status so merchants who
  //     verified while our webhook wasn't registered still resolve.
  //  2. Connected snapshots stale >24h: re-sync from Chirp's cache so metrics
  //     and auto-filed statements stay fresh (cache reads — no billed refresh).
  if (process.env.CHIRP_POLLER_DISABLED !== "true") {
    const CHIRP_POLL_INTERVAL_MS = 10 * 60 * 1000;
    setInterval(async () => {
      try {
        const pending = await db.execute(sql`
          SELECT merchant_email, chirp_request_code FROM merchant_bank_snapshots
          WHERE is_account_connected = false
            AND created_at > NOW() - INTERVAL '72 hours'
            AND (last_synced_at IS NULL OR last_synced_at < NOW() - INTERVAL '9 minutes')
          LIMIT 10
        `);
        for (const row of pending.rows as any[]) {
          try {
            const status = await chirpService.getRequestStatus(row.chirp_request_code);
            if (status?.isAccountConnected || /verified/i.test(status?.status || "")) {
              console.log(`[CHIRP POLL] ${row.merchant_email} verified — running full sync`);
              await syncMerchantSnapshotFromChirp(row.merchant_email, row.chirp_request_code);
            } else {
              // Stamp so we don't re-poll the same pending code every tick
              await db.execute(sql`UPDATE merchant_bank_snapshots SET last_synced_at = NOW() WHERE chirp_request_code = ${row.chirp_request_code}`);
            }
          } catch (e: any) {
            console.warn(`[CHIRP POLL] status check failed for ${row.merchant_email}: ${e?.message}`);
          }
        }

        const stale = await db.execute(sql`
          SELECT merchant_email, chirp_request_code FROM merchant_bank_snapshots
          WHERE is_account_connected = true
            AND (last_synced_at IS NULL OR last_synced_at < NOW() - INTERVAL '24 hours')
          LIMIT 5
        `);
        for (const row of stale.rows as any[]) {
          try {
            await syncMerchantSnapshotFromChirp(row.merchant_email, row.chirp_request_code);
          } catch (e: any) {
            console.warn(`[CHIRP POLL] stale re-sync failed for ${row.merchant_email}: ${e?.message}`);
          }
        }
      } catch (err: any) {
        console.error("[CHIRP POLL] tick error:", err?.message || err);
      }
    }, CHIRP_POLL_INTERVAL_MS);
    console.log("[CHIRP] Background poller started (10-min interval)");
  }

  // ── CHIRP ADMIN + DIAGNOSTICS ──────────────────────────────────────────
  // Staff session OR Claude API key — lets us inspect/test the pipeline
  // without a merchant login.
  function isStaffOrClaude(req: Request): boolean {
    if (req.session.user?.isAuthenticated && req.session.user.role !== 'merchant' && req.session.user.role !== 'lead') return true;
    const key = req.headers['x-claude-api-key'] || req.query.apiKey;
    return !!process.env.CLAUDE_API_KEY && key === process.env.CLAUDE_API_KEY;
  }

  // All bank connections with underwriting-relevant rollups
  app.get("/api/admin/chirp/connections", async (req: Request, res: Response) => {
    if (!isStaffOrClaude(req)) return res.status(401).json({ error: "Staff access required" });
    try {
      const rows = await db.execute(sql`
        SELECT merchant_email, chirp_request_code, institution_name, status,
          is_account_connected, statement_filed_at, last_synced_at, created_at,
          CASE WHEN jsonb_typeof(transactions_data) = 'array' THEN jsonb_array_length(transactions_data) ELSE 0 END AS txn_count,
          metrics->'underwriting'->>'avgMonthlyTrueRevenue' AS avg_true_revenue,
          metrics->'underwriting'->>'totalNsfCount' AS nsf_count,
          metrics->'underwriting'->>'totalMcaMonthlyLoad' AS mca_monthly_load,
          metrics->>'healthScore' AS health_score
        FROM merchant_bank_snapshots
        ORDER BY updated_at DESC
      `);
      res.json(rows.rows);
    } catch (err: any) {
      console.error("[CHIRP ADMIN] connections error:", err);
      res.status(500).json({ error: "Failed to list connections" });
    }
  });

  // Force a full sync for one merchant/lead email (bypasses portal cooldown)
  app.post("/api/admin/chirp/sync", async (req: Request, res: Response) => {
    if (!isStaffOrClaude(req)) return res.status(401).json({ error: "Staff access required" });
    try {
      const email = String(req.body?.email || "").toLowerCase().trim();
      if (!email) return res.status(400).json({ error: "email is required" });
      const snap = await storage.getMerchantBankSnapshot(email);
      if (!snap?.chirpRequestCode) return res.status(404).json({ error: "No bank connection found for that email" });
      const updated = await syncMerchantSnapshotFromChirp(email, snap.chirpRequestCode);
      if (!updated) return res.json({ success: false, message: "All Chirp read endpoints failed (likely WAF) — webhook re-registered." });
      const m = (updated.metrics as any) || {};
      res.json({
        success: true,
        status: updated.status,
        isAccountConnected: updated.isAccountConnected,
        institutionName: updated.institutionName,
        txnCount: Array.isArray(updated.transactionsData) ? (updated.transactionsData as any[]).length : 0,
        metrics: { monthlyRevenue: m.monthlyRevenue, healthScore: m.healthScore },
        underwriting: m.underwriting ? {
          avgMonthlyTrueRevenue: m.underwriting.avgMonthlyTrueRevenue,
          totalNsfCount: m.underwriting.totalNsfCount,
          mcaPositions: (m.underwriting.mcaPositions || []).length,
          totalMcaMonthlyLoad: m.underwriting.totalMcaMonthlyLoad,
          months: (m.underwriting.monthly || []).length,
        } : null,
        statementFiledAt: updated.statementFiledAt,
      });
    } catch (err: any) {
      console.error("[CHIRP ADMIN] sync error:", err);
      res.status(500).json({ error: err.message || "Sync failed" });
    }
  });

  // Force-file the Chirp bank report PDF as a statement (force=true bypasses the 25-day dedupe)
  app.post("/api/admin/chirp/file-statement", async (req: Request, res: Response) => {
    if (!isStaffOrClaude(req)) return res.status(401).json({ error: "Staff access required" });
    try {
      const email = String(req.body?.email || "").toLowerCase().trim();
      if (!email) return res.status(400).json({ error: "email is required" });
      let snap = await storage.getMerchantBankSnapshot(email);
      if (!snap?.chirpRequestCode) return res.status(404).json({ error: "No bank connection found for that email" });
      if (req.body?.force && snap.statementFiledAt) {
        snap = await storage.upsertMerchantBankSnapshot({
          merchantEmail: email,
          chirpRequestCode: snap.chirpRequestCode,
          statementFiledAt: null,
        });
      }
      const filed = await fileChirpStatementForSnapshot(snap!);
      res.json({ success: filed, message: filed ? "Bank report filed into Bank Statements." : "Not filed — check logs (already filed recently, no accounts, or PDF fetch failed)." });
    } catch (err: any) {
      console.error("[CHIRP ADMIN] file-statement error:", err);
      res.status(500).json({ error: err.message || "Filing failed" });
    }
  });

  // Raw Chirp passthrough for live testing: status | details | summary | report-link | track | config
  app.post("/api/admin/chirp/diag", async (req: Request, res: Response) => {
    if (!isStaffOrClaude(req)) return res.status(401).json({ error: "Staff access required" });
    const { action, requestCode, accountNumber, chirpAccountId } = req.body || {};
    try {
      let result: any;
      switch (action) {
        case "config":
          result = {
            middlewareConfigured: !!(process.env.CHIRP_MIDDLEWARE_URL && process.env.CHIRP_MIDDLEWARE_KEY),
            directTokenConfigured: !!process.env.CHIRP_API_TOKEN,
            publicBaseUrl: process.env.PUBLIC_BASE_URL || null,
            webhookSecretConfigured: !!process.env.CHIRP_WEBHOOK_SECRET,
            pollerEnabled: process.env.CHIRP_POLLER_DISABLED !== "true",
          };
          break;
        case "status":
          if (!requestCode) return res.status(400).json({ error: "requestCode is required" });
          result = await chirpService.getRequestStatus(requestCode);
          break;
        case "details": {
          if (!requestCode) return res.status(400).json({ error: "requestCode is required" });
          const details = await chirpService.getRequestDetails(requestCode, { numberOfDays: Number(req.body?.days) || 90, sort: "DESCENDING" });
          const txns = (details as any)?.TransactionSummaries || (details as any)?.transactionSummaries || [];
          result = {
            ...details,
            TransactionSummaries: Array.isArray(txns) ? txns.slice(0, 25) : txns,
            _txnCountTotal: Array.isArray(txns) ? txns.length : 0,
            _note: Array.isArray(txns) && txns.length > 25 ? "Transactions truncated to 25 for readability" : undefined,
          };
          break;
        }
        case "summary":
          if (!requestCode) return res.status(400).json({ error: "requestCode is required" });
          result = await chirpService.getSummaryInfoByRequestCode(requestCode, accountNumber, chirpAccountId);
          break;
        case "report-link":
          if (!requestCode) return res.status(400).json({ error: "requestCode is required" });
          result = await chirpService.getRequestReportAsPDF(requestCode, { accountNumber, chirpAccountId });
          break;
        case "track":
          if (!requestCode) return res.status(400).json({ error: "requestCode is required" });
          result = await chirpService.getRequestTrackInfo([requestCode]);
          break;
        default:
          return res.status(400).json({ error: "Unknown action. Use config|status|details|summary|report-link|track" });
      }
      res.json({ success: true, result });
    } catch (err: any) {
      res.status(err instanceof ChirpApiError ? err.status : 500).json({ error: err.message, body: (err as any)?.body });
    }
  });

  // ========================================
  // LENDERS API
  // ========================================
  
  // Get all active lenders
  app.get("/api/lenders", async (req, res) => {
    try {
      const lenders = await storage.getAllLenders();
      res.json(lenders);
    } catch (error) {
      console.error("Error fetching lenders:", error);
      res.status(500).json({ error: "Failed to fetch lenders" });
    }
  });

  // ========================================
  // BANK STATEMENT UPLOAD ROUTES
  // ========================================

  // ── Per-email underwriting email debounce (fires 60s after the LAST upload) ──
  // Each new upload resets the timer so all files in a session are included.
  const _uwTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const _uwCooldown = new Map<string, number>(); // tracks last manual submit time (not currently enforced)
  const _UW_DEBOUNCE_MS = 60 * 1000; // 60 seconds after last upload

  // Shared helper: build & send underwriting submission email
  async function doSendUnderwritingEmail({
    email,
    businessName,
    baseUrl: emailBaseUrl,
  }: {
    email: string;
    businessName?: string;
    baseUrl: string;
  }) {
    const normalizedEmail = email.toLowerCase().trim();
    const [uploads, application] = await Promise.all([
      storage.getBankStatementUploadsByEmail(normalizedEmail),
      storage.getAnyLoanApplicationByEmail(normalizedEmail),
    ]);

    const appName = businessName || application?.legalBusinessName || application?.businessName || normalizedEmail;
    const agentEmail: string | null = (application as any)?.agentEmail || null;

    // ── PDF attachments ──────────────────────────────────────────────────────
    const attachments: Array<{ filename: string; content: Buffer; mimeType: string }> = [];

    // Attach the same redacted PDF the agent view produces via "Download Redacted PDF"
    // (email and phone omitted — matches client/public/ApplicationView.html downloadPDF(true))
    const appPdfBuffer = await generateAgentViewRedactedPdfBuffer(application);
    if (appPdfBuffer) {
      attachments.push({ filename: `Application - ${appName}.pdf`, content: appPdfBuffer, mimeType: "application/pdf" });
    }

    // Build download links + attach PDFs (deduplicate by filename to prevent duplicates)
    const downloadLinks: Array<{ name: string; url: string }> = [];
    const attachedFileNames = new Set<string>();
    for (const u of uploads) {
      try {
        const fname = u.originalFileName || `Statement-${u.id}.pdf`;
        // Skip if we already attached a file with the same name
        if (attachedFileNames.has(fname)) {
          console.log(`[SUBMIT-UW] Skipping duplicate: ${fname}`);
          continue;
        }
        let fileBuffer: Buffer;
        if (u.storedFileName?.includes("bank-statements/")) {
          fileBuffer = await objectStorage.getFileBuffer(u.storedFileName);
        } else {
          const filePath = path.join(UPLOAD_DIR, u.storedFileName);
          if (fs.existsSync(filePath)) {
            fileBuffer = fs.readFileSync(filePath);
          } else {
            console.warn(`[SUBMIT-UW] File not found: ${u.storedFileName}`);
            continue;
          }
        }
        attachments.push({ filename: fname, content: fileBuffer, mimeType: "application/pdf" });
        attachedFileNames.add(fname);
        downloadLinks.push({
          name: fname,
          url: u.viewToken ? `${emailBaseUrl}/api/bank-statements/public/download/${u.viewToken}` : '',
        });
      } catch (stmtErr) {
        console.error(`[SUBMIT-UW] Error loading statement ${u.id}:`, stmtErr);
      }
    }

    // ── Build email HTML ─────────────────────────────────────────────────────
    const portalUrl = `${emailBaseUrl}/underwriting`;

    const appRows = application ? `
      <tr><td style="padding:6px 12px;font-weight:bold;color:#555;width:200px;">Business Name</td><td style="padding:6px 12px;">${application.legalBusinessName || application.businessName || '—'}</td></tr>
      <tr style="background:#f8faff;"><td style="padding:6px 12px;font-weight:bold;color:#555;">Contact Name</td><td style="padding:6px 12px;">${application.fullName || '—'}</td></tr>
      <tr><td style="padding:6px 12px;font-weight:bold;color:#555;">Email</td><td style="padding:6px 12px;">${application.email || '—'}</td></tr>
      <tr style="background:#f8faff;"><td style="padding:6px 12px;font-weight:bold;color:#555;">Phone</td><td style="padding:6px 12px;">${application.phone || '—'}</td></tr>
      <tr><td style="padding:6px 12px;font-weight:bold;color:#555;">Monthly Revenue</td><td style="padding:6px 12px;">${(application.monthlyRevenue || (application as any).averageMonthlyRevenue) ? '$' + Number(application.monthlyRevenue || (application as any).averageMonthlyRevenue).toLocaleString() : '—'}</td></tr>
      <tr style="background:#f8faff;"><td style="padding:6px 12px;font-weight:bold;color:#555;">Requested Amount</td><td style="padding:6px 12px;">${application.requestedAmount ? '$' + Number(application.requestedAmount).toLocaleString() : '—'}</td></tr>
      <tr><td style="padding:6px 12px;font-weight:bold;color:#555;">Time in Business</td><td style="padding:6px 12px;">${(application as any).timeInBusiness || '—'}</td></tr>
      <tr style="background:#f8faff;"><td style="padding:6px 12px;font-weight:bold;color:#555;">Business Address</td><td style="padding:6px 12px;">${[application.businessAddress, (application as any).businessCity, (application as any).businessState].filter(Boolean).join(', ') || '—'}</td></tr>
      <tr><td style="padding:6px 12px;font-weight:bold;color:#555;">Agent</td><td style="padding:6px 12px;">${(application as any).agentName || '—'}${agentEmail ? ' (' + agentEmail + ')' : ''}</td></tr>
    ` : `<tr><td colspan="2" style="padding:6px 12px;color:#888;">No application record found for this email</td></tr>`;

    const statementsSection = downloadLinks.length > 0 ? `
      <h3 style="color:#1a1a1a;margin-bottom:8px;border-bottom:1px solid #e0e0e0;padding-bottom:6px;">Bank Statements (${downloadLinks.length} file${downloadLinks.length !== 1 ? 's' : ''} attached — click to download)</h3>
      <ul style="font-family:sans-serif;font-size:14px;margin:0 0 24px;padding-left:20px;">
        ${downloadLinks.map(l => l.url
          ? `<li style="padding:4px 0;"><a href="${l.url}" style="color:#1e40af;font-weight:600;text-decoration:underline;">${l.name}</a></li>`
          : `<li style="padding:4px 0;">${l.name}</li>`
        ).join('')}
      </ul>
    ` : `<p style="color:#888;font-size:14px;margin-bottom:24px;">No bank statements on file for this email.</p>`;

    const subject = `NEW SUBMISSION: ${appName}`;
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:680px;">
        <h2 style="color:#1e40af;margin-bottom:8px;">File Submitted for Underwriting Review</h2>
        <p style="color:#555;font-size:14px;margin-bottom:16px;">Bank statements are attached to this email and available as click-to-download links below.</p>

        <p style="margin-bottom:24px;">
          <a href="${portalUrl}" style="display:inline-block;background:#1e40af;color:#fff;padding:10px 20px;border-radius:5px;text-decoration:none;font-size:14px;font-weight:bold;">
            Open Underwriting Portal
          </a>
          <span style="font-size:12px;color:#888;margin-left:12px;">Search for: ${normalizedEmail}</span>
        </p>

        <h3 style="color:#1a1a1a;margin-bottom:8px;border-bottom:1px solid #e0e0e0;padding-bottom:6px;">Application Details</h3>
        <table style="border-collapse:collapse;width:100%;font-family:sans-serif;font-size:14px;margin-bottom:24px;">
          ${appRows}
        </table>

        ${statementsSection}

        <p style="font-size:12px;color:#aaa;">Submitted automatically via Today Capital Group file management system</p>
      </div>
    `;

    const ccAddresses = ['marketing@todaycapitalgroup.com', agentEmail].filter(Boolean).join(', ');
    await gmailService.sendEmailWithAttachments(
      'underwriting@todaycapitalgroup.com',
      subject,
      html,
      attachments,
      ccAddresses || undefined,
    );
    console.log(`[SUBMIT-UW] Email sent for: ${normalizedEmail} (${attachments.length} attachments, CC: ${ccAddresses || 'none'})`);

    // Stamp the submission timestamp on the matching loan application
    try {
      await db.execute(sql`
        UPDATE loan_applications
        SET uw_submitted_at = NOW()
        WHERE LOWER(email) = ${normalizedEmail}
      `);
    } catch (stampErr) {
      console.warn('[SUBMIT-UW] Failed to stamp uw_submitted_at (non-fatal):', stampErr);
    }

    // Move the SF Opportunity to the Underwriting stage (forward-only, non-fatal)
    promoteOpportunityToUnderwriting(normalizedEmail).catch(err =>
      console.warn('[SUBMIT-UW] SF stage promotion error (non-fatal):', err.message));

    // Push Deal Qualification fields to Salesforce (non-fatal)
    try {
      const snapResult = await db.execute(sql`
        SELECT snapshot FROM underwriting_snapshots WHERE LOWER(email) = ${normalizedEmail} LIMIT 1
      `);
      const savedSnapshot = (snapResult.rows?.[0] as any)?.snapshot ?? null;
      syncUwSubmissionToSalesforce(normalizedEmail, application ?? null, { snapshot: savedSnapshot }).catch(err =>
        console.warn('[SUBMIT-UW] SF Deal Qual sync error (non-fatal):', err.message)
      );
    } catch (sfErr: any) {
      console.warn('[SUBMIT-UW] SF Deal Qual sync error (non-fatal):', sfErr.message);
    }

    return { uploadCount: uploads.length };
  }

  // 1. Upload bank statement PDF
  app.post("/api/bank-statements/upload", (req, res, next) => {
    console.log(`[UPLOAD DIAGNOSTIC] POST /api/bank-statements/upload reached Express. content-type: ${req.headers['content-type']}, content-length: ${req.headers['content-length']}`);
    bankStatementUpload.single("file")(req, res, (err: any) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: "File size exceeds 25MB limit" });
        }
        if (err.message === 'Only PDF files are allowed') {
          return res.status(400).json({ error: err.message });
        }
        return res.status(400).json({ error: "File upload error: " + err.message });
      }
      next();
    });
  }, async (req, res) => {
    try {
      const file = req.file;
      if (!file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      const { 
        applicationId, receivedAt, approvalStatus, approvalNotes, 
        lenderId, lenderName,
        // Approval form fields
        advanceAmount, term, paymentFrequency, factorRate, buyRate, sellRate, totalPayback, netAfterFees, approvalDate,
        // Internal upload flag (skips GHL webhook)
        isInternal
      } = req.body;

      // If the request comes from an authenticated lead session, always use the session
      // email (overrides body) and tag the upload as "lead-portal" to keep it identifiable
      // for the team. Skip the GHL webhook — leads are internal, not public intake forms.
      const leadSessionEmail = (req.session.user?.isAuthenticated && req.session.user.role === 'lead' && req.session.user.merchantEmail)
        ? req.session.user.merchantEmail as string
        : null;
      const isLeadPortalUpload = Boolean(leadSessionEmail);

      let email: string = (leadSessionEmail || req.body.email || "").toLowerCase().trim();
      let businessName: string = req.body.businessName;

      if (!email) {
        return res.status(400).json({ error: "Email is required" });
      }

      // For lead portal uploads, look up business name from their account if not supplied
      if (isLeadPortalUpload && !businessName) {
        try {
          const acct = await db.execute(sql`SELECT business_name FROM lead_portal_accounts WHERE email = ${email} LIMIT 1`);
          businessName = (acct.rows[0] as any)?.business_name || businessName;
        } catch (_) {}
      }
      
      // Parse receivedAt date if provided (for internal uploads with custom date)
      let receivedAtDate: Date | null = null;
      if (receivedAt) {
        receivedAtDate = new Date(receivedAt);
        if (isNaN(receivedAtDate.getTime())) {
          receivedAtDate = null;
        }
      }
      
      // Get reviewer info from session if available (for internal uploads with approval)
      const reviewerEmail = (req.session as any)?.user?.email || 'internal-upload';

      // Check if application exists (for linking purposes, but don't block upload)
      const existingApp = await storage.getLoanApplicationByEmail(email);
      if (existingApp) {
        console.log(`[BANK UPLOAD] Found existing application ${existingApp.id} for email: ${email}`);
      } else {
        console.log(`[BANK UPLOAD] No application found for email: ${email}, will create orphan upload`);
      }

      let storedFileName: string;
      let storageType: string = "local";

      // ALWAYS use Object Storage for persistent file storage
      // Files saved to local disk are EPHEMERAL and will be lost on restart!
      if (objectStorage.isConfigured()) {
        try {
          storedFileName = await objectStorage.uploadFile(
            file.buffer,
            file.originalname,
            file.mimetype
          );
          storageType = "object-storage";
          console.log(`[UPLOAD] ✓ Bank statement uploaded to Object Storage: ${storedFileName}`);
        } catch (objError) {
          // FAIL the upload rather than silently falling back to ephemeral local storage
          console.error("[UPLOAD] ✗ Object Storage upload FAILED:", objError);
          return res.status(500).json({ 
            error: "Failed to save file to permanent storage. Please try again or contact support." 
          });
        }
      } else {
        // Object Storage not configured - FAIL the upload rather than using ephemeral storage
        console.error("[UPLOAD] ✗ Object Storage not configured - cannot accept uploads");
        return res.status(500).json({ 
          error: "File storage is not configured. Please contact support." 
        });
      }

      // Generate a unique view token for public access (e.g., for GoHighLevel webhook links)
      const viewToken = randomBytes(32).toString('hex');

      // Save upload record to database
      const upload = await storage.createBankStatementUpload({
        email,
        businessName: businessName || null,
        loanApplicationId: applicationId || null,
        originalFileName: file.originalname,
        storedFileName: storedFileName,
        mimeType: file.mimetype,
        fileSize: file.size,
        source: isLeadPortalUpload ? "lead-portal" : undefined,
        viewToken,
        receivedAt: receivedAtDate,
        approvalStatus: approvalStatus || null,
        approvalNotes: approvalNotes || null,
        reviewedBy: approvalStatus ? reviewerEmail : null,
        reviewedAt: approvalStatus ? new Date() : null,
        lenderId: lenderId || null,
        lenderName: lenderName || null,
      });

      // Check if there's a matching application by email
      let linkedApplicationId = applicationId;
      let matchingApp: LoanApplication | undefined = applicationId
        ? await storage.getLoanApplication(applicationId)
        : existingApp;
      if (!linkedApplicationId) {
        const applications = await storage.getAllLoanApplications();
        matchingApp = applications.find((app: LoanApplication) => app.email === email);
        if (matchingApp) {
          linkedApplicationId = matchingApp.id;
          console.log(`Auto-linked bank statement upload ${upload.id} to application ${matchingApp.id}`);
        }
      }

      // Build the base URL for public view links
      const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
      const host = req.headers['x-forwarded-host'] || req.headers.host || 'capitalloanconnect.com';
      const baseUrl = `${protocol}://${host}`;

      // Get all bank statements for this email to include all view links in webhook
      const allStatements = await storage.getBankStatementUploadsByEmail(email);
      const statementLinks = allStatements
        .filter(stmt => stmt.viewToken) // Only include statements with view tokens
        .map(stmt => ({
          fileName: stmt.originalFileName,
          viewUrl: `${baseUrl}/api/bank-statements/public/view/${stmt.viewToken}`,
        }));

      // Generate the combined view URL (single link to view ALL statements in one page)
      const combinedViewToken = generateCombinedViewToken(email);
      const combinedViewUrl = `${baseUrl}/api/bank-statements/public/view-all/${combinedViewToken}`;

      // Send webhook to GHL with "Statements Uploaded" tag and view links
      // Session-based throttling: only sends one webhook per email per 15-minute session
      // This prevents spam when users upload multiple PDFs at once
      // DISABLED for internal uploads (isInternal flag) - will be re-enabled with new webhook URL later
      // Also DISABLED for lead-portal uploads — leads are internal users, not public intake form submissions
      if (isInternal === 'true' || isLeadPortalUpload) {
        console.log(`[BANK UPLOAD] Webhook DISABLED for ${isLeadPortalUpload ? 'lead-portal' : 'internal'} upload (${email})`);
      } else {
        const nameParts = (matchingApp?.fullName || '').trim().split(' ');
        ghlService.sendBankStatementUploadedWebhook({
          email,
          businessName: businessName || matchingApp?.businessName || matchingApp?.legalBusinessName || undefined,
          phone: matchingApp?.phone || undefined,
          firstName: nameParts[0] || undefined,
          lastName: nameParts.slice(1).join(' ') || undefined,
          statementLinks,
          combinedViewUrl, // Single link to view ALL statements in one scrollable page
        }).then(result => {
          if (result.sent) {
            console.log(`[BANK UPLOAD] Webhook sent for ${email} with View All link: ${combinedViewUrl}`);
          } else {
            console.log(`[BANK UPLOAD] Webhook skipped for ${email}: ${result.reason}`);
          }
        }).catch(err => console.error('[GHL] Bank statement webhook error:', err));
      }

      // An Inertia application may submit bank statements separately from its
      // form data. GHL receives the statement links above; re-sync the linked
      // application to Salesforce so the external entry is not stranded in
      // only one system.
      if (matchingApp && isInertiaSubmission(matchingApp)) {
        syncApplicationToSalesforceAndPersist(matchingApp).catch(() => {});
      }

      // Create underwriting decision when unqualified
      if (approvalStatus === 'unqualified' && approvalNotes) {
        try {
          const resolvedBusinessName = businessName || matchingApp?.businessName || 'Unknown Business';
          await storage.createOrUpdateBusinessUnderwritingDecision({
            businessEmail: email,
            businessName: resolvedBusinessName,
            status: 'unqualified',
            declineReason: approvalNotes,
          });
          console.log(`[BANK UPLOAD] Created unqualified underwriting decision for ${resolvedBusinessName}: ${approvalNotes}`);
        } catch (unqualifiedError) {
          console.error('[BANK UPLOAD] Failed to create unqualified decision:', unqualifiedError);
        }
      }

      // Create lender approval record AND underwriting decision when approved with details
      let lenderApprovalId = null;
      if (approvalStatus === 'approved' && lenderName && advanceAmount) {
        try {
          // Parse currency amounts (remove $ and commas)
          const parseAmount = (val: string) => {
            if (!val) return null;
            const cleaned = val.replace(/[$,]/g, '');
            const parsed = parseFloat(cleaned);
            return isNaN(parsed) ? null : parsed.toString();
          };

          const resolvedBusinessName = businessName || matchingApp?.businessName || 'Unknown Business';

          // Create lender approval record with deal details
          const lenderApproval = await storage.createLenderApproval({
            businessName: resolvedBusinessName,
            businessEmail: email,
            loanApplicationId: linkedApplicationId || null,
            lenderName: lenderName,
            approvedAmount: parseAmount(advanceAmount),
            termLength: term || null,
            factorRate: factorRate || null,
            paybackAmount: parseAmount(totalPayback),
            paymentFrequency: paymentFrequency || null,
            paymentAmount: parseAmount(netAfterFees),
            status: 'accepted',
            notes: approvalNotes ? `${approvalNotes} (Approval Date: ${approvalDate || new Date().toISOString().split('T')[0]})` : `Approval Date: ${approvalDate || new Date().toISOString().split('T')[0]}`,
          });
          lenderApprovalId = lenderApproval.id;
          console.log(`[BANK UPLOAD] Created lender approval ${lenderApproval.id} for ${resolvedBusinessName}`);

          // Also create/update business underwriting decision (so it shows in dashboard)
          // Store the approval details in additionalApprovals format
          const approvalEntry = {
            id: `internal-${Date.now()}`,
            lender: lenderName,
            advanceAmount: advanceAmount || '',
            term: term || '',
            paymentFrequency: paymentFrequency || 'Weekly',
            factorRate: factorRate || '',
            totalPayback: totalPayback || '',
            netAfterFees: netAfterFees || '',
            notes: approvalNotes || '',
            approvalDate: approvalDate || new Date().toISOString().split('T')[0],
            isPrimary: true,
            createdAt: new Date().toISOString(),
          };

          await storage.createOrUpdateBusinessUnderwritingDecision({
            businessEmail: email,
            businessName: resolvedBusinessName,
            status: 'approved',
            additionalApprovals: [approvalEntry],
          });
          console.log(`[BANK UPLOAD] Created/updated underwriting decision for ${resolvedBusinessName}`);

        } catch (approvalError) {
          console.error('[BANK UPLOAD] Failed to create lender approval:', approvalError);
          // Don't fail the upload, just log the error
        }
      }

      // SMS: bank_statements_uploaded
      const _smsPhone = matchingApp?.phone;
      if (_smsPhone) {
        const _smsBsParts = (matchingApp?.fullName || '').trim().split(' ');
        fireSmsStageEvent({
          stage: 'bank_statements_uploaded',
          phone: _smsPhone,
          email: email || undefined,
          first_name: _smsBsParts[0] || undefined,
          last_name: _smsBsParts.slice(1).join(' ') || undefined,
          business_name: businessName || matchingApp?.businessName || undefined,
          deal_id: linkedApplicationId || undefined,
        });
      }

      res.json({
        success: true,
        upload: {
          id: upload.id,
          originalFileName: upload.originalFileName,
          fileSize: upload.fileSize,
          createdAt: upload.createdAt,
          linkedApplicationId: linkedApplicationId || null,
          storageType,
          lenderApprovalId,
        },
      });

      // ── Auto-submit to underwriting (debounced: fires 60s after the last upload) ──
      const _uwProtocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
      const _uwHost = req.headers['x-forwarded-host'] || req.headers.host || 'capitalloanconnect.com';
      const _uwBaseUrl = `${_uwProtocol}://${_uwHost}`;
      const _uwBizName = businessName || matchingApp?.businessName || matchingApp?.legalBusinessName;
      if (_uwTimers.has(email)) clearTimeout(_uwTimers.get(email)!);
      _uwTimers.set(email, setTimeout(() => {
        _uwTimers.delete(email);
        doSendUnderwritingEmail({ email, businessName: _uwBizName ?? undefined, baseUrl: _uwBaseUrl })
          .catch(err => console.error('[BANK UPLOAD] Auto underwriting email failed:', err));
      }, _UW_DEBOUNCE_MS));
      console.log(`[BANK UPLOAD] Underwriting email debounce reset for ${email} (fires in 60s)`);
    } catch (error) {
      console.error("Bank statement upload error:", error);
      res.status(500).json({ error: "Failed to upload bank statement" });
    }
  });

  // JSON-based upload — same logic but accepts { fileBase64, fileName, mimeType, ...metadata }
  // This bypasses multipart/form-data restrictions at the Replit/CDN proxy layer.
  app.post("/api/bank-statements/upload-json",
    express.json({ limit: '50mb' }),
    async (req: Request, res: Response) => {
      try {
        console.log(`[UPLOAD-JSON DIAGNOSTIC] POST /api/bank-statements/upload-json reached Express.`);
        const { fileBase64, fileName, mimeType: fileMimeType } = req.body;

        if (!fileBase64 || !fileName) {
          return res.status(400).json({ error: "fileBase64 and fileName are required" });
        }
        if (fileMimeType !== 'application/pdf') {
          return res.status(400).json({ error: "Only PDF files are allowed" });
        }
        const fileBuffer = Buffer.from(fileBase64, 'base64');
        if (fileBuffer.length > 25 * 1024 * 1024) {
          return res.status(400).json({ error: "File size exceeds 25MB limit" });
        }

        const file = {
          buffer: fileBuffer,
          originalname: fileName as string,
          mimetype: fileMimeType as string,
          size: fileBuffer.length,
        };

        const {
          applicationId, receivedAt, approvalStatus, approvalNotes,
          lenderId, lenderName,
          advanceAmount, term, paymentFrequency, factorRate, totalPayback, netAfterFees, approvalDate,
          isInternal
        } = req.body;

        const leadSessionEmail = (req.session.user?.isAuthenticated && req.session.user.role === 'lead' && req.session.user.merchantEmail)
          ? req.session.user.merchantEmail as string
          : null;
        const isLeadPortalUpload = Boolean(leadSessionEmail);

        let email: string = (leadSessionEmail || req.body.email || "").toLowerCase().trim();
        let businessName: string = req.body.businessName;

        if (!email) {
          return res.status(400).json({ error: "Email is required" });
        }

        if (isLeadPortalUpload && !businessName) {
          try {
            const acct = await db.execute(sql`SELECT business_name FROM lead_portal_accounts WHERE email = ${email} LIMIT 1`);
            businessName = (acct.rows[0] as any)?.business_name || businessName;
          } catch (_) {}
        }

        let receivedAtDate: Date | null = null;
        if (receivedAt) {
          receivedAtDate = new Date(receivedAt);
          if (isNaN(receivedAtDate.getTime())) receivedAtDate = null;
        }

        const reviewerEmail = (req.session as any)?.user?.email || 'internal-upload';

        const existingApp = await storage.getLoanApplicationByEmail(email);
        if (existingApp) {
          console.log(`[BANK UPLOAD] Found existing application ${existingApp.id} for email: ${email}`);
        } else {
          console.log(`[BANK UPLOAD] No application found for email: ${email}, will create orphan upload`);
        }

        let storedFileName: string;
        let storageType = "local";

        if (objectStorage.isConfigured()) {
          try {
            storedFileName = await objectStorage.uploadFile(file.buffer, file.originalname, file.mimetype);
            storageType = "object-storage";
            console.log(`[UPLOAD] ✓ Bank statement uploaded to Object Storage: ${storedFileName}`);
          } catch (objError) {
            console.error("[UPLOAD] ✗ Object Storage upload FAILED:", objError);
            return res.status(500).json({ error: "Failed to save file to permanent storage. Please try again or contact support." });
          }
        } else {
          console.error("[UPLOAD] ✗ Object Storage not configured - cannot accept uploads");
          return res.status(500).json({ error: "File storage is not configured. Please contact support." });
        }

        const viewToken = randomBytes(32).toString('hex');

        const upload = await storage.createBankStatementUpload({
          email,
          businessName: businessName || null,
          loanApplicationId: applicationId || null,
          originalFileName: file.originalname,
          storedFileName: storedFileName!,
          mimeType: file.mimetype,
          fileSize: file.size,
          source: isLeadPortalUpload ? "lead-portal" : undefined,
          viewToken,
          receivedAt: receivedAtDate,
          approvalStatus: approvalStatus || null,
          approvalNotes: approvalNotes || null,
          reviewedBy: approvalStatus ? reviewerEmail : null,
          reviewedAt: approvalStatus ? new Date() : null,
          lenderId: lenderId || null,
          lenderName: lenderName || null,
        });

        let linkedApplicationId = applicationId;
        let matchingApp: LoanApplication | undefined;
        if (!linkedApplicationId) {
          const applications = await storage.getAllLoanApplications();
          matchingApp = applications.find((app: LoanApplication) => app.email === email);
          if (matchingApp) {
            linkedApplicationId = matchingApp.id;
            console.log(`Auto-linked bank statement upload ${upload.id} to application ${matchingApp.id}`);
          }
        }

        const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
        const host = req.headers['x-forwarded-host'] || req.headers.host || 'capitalloanconnect.com';
        const baseUrl = `${protocol}://${host}`;

        const allStatements = await storage.getBankStatementUploadsByEmail(email);
        const statementLinks = allStatements
          .filter(stmt => stmt.viewToken)
          .map(stmt => ({
            fileName: stmt.originalFileName,
            viewUrl: `${baseUrl}/api/bank-statements/public/view/${stmt.viewToken}`,
          }));

        const combinedViewToken = generateCombinedViewToken(email);
        const combinedViewUrl = `${baseUrl}/api/bank-statements/public/view-all/${combinedViewToken}`;

        if (isInternal === 'true' || isInternal === true || isLeadPortalUpload) {
          console.log(`[BANK UPLOAD] Webhook DISABLED for ${isLeadPortalUpload ? 'lead-portal' : 'internal'} upload (${email})`);
        } else {
          const nameParts = (matchingApp?.fullName || '').trim().split(' ');
          ghlService.sendBankStatementUploadedWebhook({
            email,
            businessName: businessName || matchingApp?.businessName || matchingApp?.legalBusinessName || undefined,
            phone: matchingApp?.phone || undefined,
            firstName: nameParts[0] || undefined,
            lastName: nameParts.slice(1).join(' ') || undefined,
            statementLinks,
            combinedViewUrl,
          }).then(result => {
            if (result.sent) {
              console.log(`[BANK UPLOAD] Webhook sent for ${email} with View All link: ${combinedViewUrl}`);
            } else {
              console.log(`[BANK UPLOAD] Webhook skipped for ${email}: ${result.reason}`);
            }
          }).catch(err => console.error('[GHL] Bank statement webhook error:', err));
        }

        if (approvalStatus === 'unqualified' && approvalNotes) {
          try {
            const resolvedBusinessName = businessName || matchingApp?.businessName || 'Unknown Business';
            await storage.createOrUpdateBusinessUnderwritingDecision({
              businessEmail: email,
              businessName: resolvedBusinessName,
              status: 'unqualified',
              declineReason: approvalNotes,
            });
            console.log(`[BANK UPLOAD] Created unqualified underwriting decision for ${resolvedBusinessName}: ${approvalNotes}`);
          } catch (unqualifiedError) {
            console.error('[BANK UPLOAD] Failed to create unqualified decision:', unqualifiedError);
          }
        }

        let lenderApprovalId = null;
        if (approvalStatus === 'approved' && lenderName && advanceAmount) {
          try {
            const parseAmount = (val: string) => {
              if (!val) return null;
              const cleaned = val.replace(/[$,]/g, '');
              const parsed = parseFloat(cleaned);
              return isNaN(parsed) ? null : parsed.toString();
            };
            const resolvedBusinessName = businessName || matchingApp?.businessName || 'Unknown Business';
            const lenderApproval = await storage.createLenderApproval({
              businessName: resolvedBusinessName,
              businessEmail: email,
              loanApplicationId: linkedApplicationId || null,
              lenderName: lenderName,
              approvedAmount: parseAmount(advanceAmount),
              termLength: term || null,
              factorRate: factorRate || null,
              paybackAmount: parseAmount(totalPayback),
              paymentFrequency: paymentFrequency || null,
              paymentAmount: parseAmount(netAfterFees),
              status: 'accepted',
              notes: approvalNotes ? `${approvalNotes} (Approval Date: ${approvalDate || new Date().toISOString().split('T')[0]})` : `Approval Date: ${approvalDate || new Date().toISOString().split('T')[0]}`,
            });
            lenderApprovalId = lenderApproval.id;
            console.log(`[BANK UPLOAD] Created lender approval ${lenderApproval.id} for ${resolvedBusinessName}`);

            const approvalEntry = {
              id: `internal-${Date.now()}`,
              lender: lenderName,
              advanceAmount: advanceAmount || '',
              term: term || '',
              paymentFrequency: paymentFrequency || 'Weekly',
              factorRate: factorRate || '',
              totalPayback: totalPayback || '',
              netAfterFees: netAfterFees || '',
              notes: approvalNotes || '',
              approvalDate: approvalDate || new Date().toISOString().split('T')[0],
              isPrimary: true,
              createdAt: new Date().toISOString(),
            };

            await storage.createOrUpdateBusinessUnderwritingDecision({
              businessEmail: email,
              businessName: resolvedBusinessName,
              status: 'approved',
              additionalApprovals: [approvalEntry],
            });
            console.log(`[BANK UPLOAD] Created/updated underwriting decision for ${resolvedBusinessName}`);
          } catch (approvalError) {
            console.error('[BANK UPLOAD] Failed to create lender approval:', approvalError);
          }
        }

        const _smsPhone = matchingApp?.phone;
        if (_smsPhone) {
          const _smsBsParts = (matchingApp?.fullName || '').trim().split(' ');
          fireSmsStageEvent({
            stage: 'bank_statements_uploaded',
            phone: _smsPhone,
            email: email || undefined,
            first_name: _smsBsParts[0] || undefined,
            last_name: _smsBsParts.slice(1).join(' ') || undefined,
            business_name: businessName || matchingApp?.businessName || undefined,
            deal_id: linkedApplicationId || undefined,
          });
        }

        res.json({
          success: true,
          upload: {
            id: upload.id,
            originalFileName: upload.originalFileName,
            fileSize: upload.fileSize,
            createdAt: upload.createdAt,
            linkedApplicationId: linkedApplicationId || null,
            storageType,
            lenderApprovalId,
          },
        });

        const _uwProtocol2 = req.headers['x-forwarded-proto'] || req.protocol || 'https';
        const _uwHost2 = req.headers['x-forwarded-host'] || req.headers.host || 'capitalloanconnect.com';
        const _uwBaseUrl2 = `${_uwProtocol2}://${_uwHost2}`;
        const _uwBizName2 = businessName || matchingApp?.businessName || matchingApp?.legalBusinessName;
        if (_uwTimers.has(email)) clearTimeout(_uwTimers.get(email)!);
        _uwTimers.set(email, setTimeout(() => {
          _uwTimers.delete(email);
          doSendUnderwritingEmail({ email, businessName: _uwBizName2 ?? undefined, baseUrl: _uwBaseUrl2 })
            .catch(err => console.error('[BANK UPLOAD] Auto underwriting email failed:', err));
        }, _UW_DEBOUNCE_MS));
        console.log(`[BANK UPLOAD] Underwriting email debounce reset for ${email} (fires in 60s)`);
      } catch (error) {
        console.error("Bank statement JSON upload error:", error);
        res.status(500).json({ error: "Failed to upload bank statement" });
      }
    }
  );

  // 2. Get all bank statement uploads (for dashboard) - role-based filtering

  // GET /api/bank-statements/snapshot/:email — retrieve saved AI snapshot for a merchant
  app.get("/api/bank-statements/snapshot/:email", async (req: Request, res: Response) => {
    if (!req.session.user?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }
    try {
      const email = decodeURIComponent(req.params.email).toLowerCase().trim();
      const result = await db.execute(
        sql`SELECT snapshot, ran_at, ran_by, files_processed FROM underwriting_snapshots WHERE email = ${email} LIMIT 1`
      );
      const row = (result as any).rows?.[0];
      if (!row) return res.json({ snapshot: null });
      res.json({
        snapshot: row.snapshot,
        ranAt: row.ran_at,
        ranBy: row.ran_by,
        filesProcessed: row.files_processed,
      });
    } catch (err: any) {
      console.error("[SNAPSHOT] Error fetching snapshot:", err.message);
      res.status(500).json({ error: "Failed to load snapshot" });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // MERCHANT PROFILE ENHANCEMENTS (call history, notes, GHL pipeline)
  // ══════════════════════════════════════════════════════════════════════════

  // GET /api/merchant-profile/calls/:phone — call history for a phone number
  app.get("/api/merchant-profile/calls/:phone", async (req: Request, res: Response) => {
    if (!req.session.user?.isAuthenticated) return res.status(401).json({ error: "Auth required" });
    try {
      const phone = decodeURIComponent(req.params.phone).replace(/\D/g, '');
      if (phone.length < 7) return res.json({ calls: [] });
      // Match on last 10 digits to handle country code variations
      const phoneSuffix = phone.slice(-10);
      const result = await db.execute(sql`
        SELECT id, rep_name, direction, duration, caller_number, callee_number,
               caller_name, callee_name, result, start_time, end_time
        FROM rep_call_stats
        WHERE RIGHT(REGEXP_REPLACE(caller_number, '[^0-9]', '', 'g'), 10) = ${phoneSuffix}
           OR RIGHT(REGEXP_REPLACE(callee_number, '[^0-9]', '', 'g'), 10) = ${phoneSuffix}
        ORDER BY start_time DESC NULLS LAST
        LIMIT 25
      `);
      res.json({ calls: (result as any).rows || [] });
    } catch (err: any) {
      console.error("[MERCHANT-PROFILE] Call history error:", err.message);
      res.status(500).json({ error: "Failed to load call history" });
    }
  });

  // GET /api/merchant-profile/notes/:email — get notes for a business
  app.get("/api/merchant-profile/notes/:email", async (req: Request, res: Response) => {
    if (!req.session.user?.isAuthenticated) return res.status(401).json({ error: "Auth required" });
    try {
      const email = decodeURIComponent(req.params.email).toLowerCase().trim();
      const result = await db.execute(sql`
        SELECT id, note, author_name, author_email, created_at
        FROM merchant_notes
        WHERE LOWER(business_email) = ${email}
        ORDER BY created_at DESC
        LIMIT 50
      `);
      res.json({ notes: (result as any).rows || [] });
    } catch (err: any) {
      console.error("[MERCHANT-PROFILE] Notes error:", err.message);
      res.status(500).json({ error: "Failed to load notes" });
    }
  });

  // POST /api/merchant-profile/notes — add a note
  app.post("/api/merchant-profile/notes", async (req: Request, res: Response) => {
    if (!req.session.user?.isAuthenticated) return res.status(401).json({ error: "Auth required" });
    try {
      const { email, businessName, note } = req.body;
      if (!email || !note?.trim()) return res.status(400).json({ error: "Email and note are required" });
      const authorName = req.session.user.agentName || req.session.user.agentEmail || 'Unknown';
      const authorEmail = req.session.user.agentEmail || '';
      const result = await db.execute(sql`
        INSERT INTO merchant_notes (business_email, business_name, note, author_name, author_email)
        VALUES (${email.toLowerCase().trim()}, ${businessName || null}, ${note.trim()}, ${authorName}, ${authorEmail})
        RETURNING id, note, author_name, author_email, created_at
      `);
      const newNote = (result as any).rows?.[0];
      res.json({ success: true, note: newNote });
    } catch (err: any) {
      console.error("[MERCHANT-PROFILE] Add note error:", err.message);
      res.status(500).json({ error: "Failed to add note" });
    }
  });

  // DELETE /api/merchant-profile/notes/:id — delete a note
  app.delete("/api/merchant-profile/notes/:id", async (req: Request, res: Response) => {
    if (!req.session.user?.isAuthenticated) return res.status(401).json({ error: "Auth required" });
    if (req.session.user.role !== 'admin' && req.session.user.role !== 'underwriting') {
      return res.status(403).json({ error: "Only admins can delete notes" });
    }
    try {
      await db.execute(sql`DELETE FROM merchant_notes WHERE id = ${Number(req.params.id)}`);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to delete note" });
    }
  });

  // GET /api/merchant-profile/ghl/:email — GHL pipeline stage + contact info
  app.get("/api/merchant-profile/ghl/:email", async (req: Request, res: Response) => {
    if (!req.session.user?.isAuthenticated) return res.status(401).json({ error: "Auth required" });
    try {
      const email = decodeURIComponent(req.params.email).toLowerCase().trim();
      const contact = await ghlService.getContactByEmail(email);
      if (!contact) return res.json({ found: false });

      // Get opportunities for this contact
      let opportunities: any[] = [];
      try {
        opportunities = await ghlService.searchOpportunitiesByContact(contact.id);
      } catch { /* no opportunities */ }

      // Find the most recent/active opportunity
      const activeOpp = opportunities
        .filter((o: any) => o.status?.toLowerCase() !== 'lost')
        .sort((a: any, b: any) => new Date(b.updatedAt || b.createdAt || 0).getTime() - new Date(a.updatedAt || a.createdAt || 0).getTime())[0] || null;

      res.json({
        found: true,
        contactId: contact.id,
        contactName: [contact.firstName, contact.lastName].filter(Boolean).join(' '),
        tags: contact.tags || [],
        assignedTo: contact.assignedTo || null,
        pipelineStage: activeOpp?.pipelineStageId || activeOpp?.status || null,
        pipelineName: activeOpp?.pipelineId || null,
        opportunityName: activeOpp?.name || null,
        opportunityStatus: activeOpp?.status || null,
        opportunityValue: activeOpp?.monetaryValue || null,
        lastActivity: contact.dateUpdated || contact.dateAdded || null,
      });
    } catch (err: any) {
      console.error("[MERCHANT-PROFILE] GHL lookup error:", err.message);
      res.status(500).json({ error: "Failed to look up GHL data" });
    }
  });

  // POST /api/bank-statements/analyze-for-rep — AI underwriting snapshot for reps + underwriting team
  app.post("/api/bank-statements/analyze-for-rep", async (req: Request, res: Response) => {
    if (!req.session.user?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }
    const role = req.session.user.role;
    if (role !== 'admin' && role !== 'agent' && role !== 'underwriting') {
      return res.status(403).json({ error: "Access denied" });
    }

    try {
      const { email, businessName, creditScoreRange, timeInBusiness, industry } = req.body;
      if (!email) return res.status(400).json({ error: "Email is required" });

      const normalizedEmail = email.toLowerCase().trim();

      let uploads;
      if (role === 'admin') {
        uploads = await storage.getBankStatementUploadsByEmail(normalizedEmail);
      } else {
        // Agents: get by email but also verify they have access
        uploads = await storage.getBankStatementUploadsByEmail(normalizedEmail);
      }

      if (uploads.length === 0) {
        return res.status(404).json({ error: "No bank statements found for this email" });
      }

      console.log(`[SNAPSHOT] Analyzing ${uploads.length} statements for ${normalizedEmail}`);

      // Extract text from all PDFs (up to 6)
      const extractedTexts: string[] = [];
      for (const upload of uploads.slice(0, 6)) {
        try {
          let fileBuffer: Buffer;
          if (upload.storedFileName && upload.storedFileName.includes("bank-statements/")) {
            fileBuffer = await objectStorage.getFileBuffer(upload.storedFileName);
          } else {
            const filePath = path.join(UPLOAD_DIR, upload.storedFileName);
            if (fs.existsSync(filePath)) {
              fileBuffer = fs.readFileSync(filePath);
            } else {
              console.warn(`[SNAPSHOT] File not found: ${upload.storedFileName}`);
              continue;
            }
          }

          const parser = new PDFParse({ data: fileBuffer });
          const result = await parser.getText();
          const text = result.text || "";
          extractedTexts.push(`--- Statement: ${upload.originalFileName} ---\n${text}\n`);
          console.log(`[SNAPSHOT] Extracted ${text.length} chars from ${upload.originalFileName}`);
          await parser.destroy();
        } catch (pdfError) {
          console.error(`[SNAPSHOT] Error parsing ${upload.originalFileName}:`, pdfError);
          extractedTexts.push(`--- Statement: ${upload.originalFileName} ---\n[Could not extract text]\n`);
        }
      }

      if (extractedTexts.length === 0) {
        return res.status(400).json({ error: "Could not read any of the uploaded PDFs" });
      }

      const combinedText = extractedTexts.join("\n\n");
      const snapshot = await generateUnderwritingSnapshot(combinedText, {
        businessName: businessName || undefined,
        creditScoreRange: creditScoreRange || undefined,
        timeInBusiness: timeInBusiness || undefined,
        industry: industry || undefined,
      });

      console.log(`[SNAPSHOT] Complete for ${normalizedEmail} — worthSubmitting=${snapshot.worthSubmitting}, score=${snapshot.overallScore}`);

      // Persist snapshot so it can be re-accessed without re-running AI
      const ranBy = req.session.user?.agentEmail || req.session.user?.agentName || role;
      try {
        await db.execute(sql`
          INSERT INTO underwriting_snapshots (email, snapshot, ran_at, ran_by, files_processed)
          VALUES (${normalizedEmail}, ${JSON.stringify(snapshot)}::jsonb, NOW(), ${ranBy}, ${extractedTexts.length})
          ON CONFLICT (email) DO UPDATE SET
            snapshot = EXCLUDED.snapshot,
            ran_at = NOW(),
            ran_by = EXCLUDED.ran_by,
            files_processed = EXCLUDED.files_processed
        `);
        console.log(`[SNAPSHOT] Saved to DB for ${normalizedEmail}`);
      } catch (saveErr: any) {
        console.error("[SNAPSHOT] Failed to save to DB (non-fatal):", saveErr.message);
      }

      // Push AI Snapshot + Deal Qualification fields to Salesforce (non-fatal)
      syncAiSnapshotToSalesforce(normalizedEmail, snapshot as any).catch(err =>
        console.warn('[SNAPSHOT] SF AI Snapshot sync error (non-fatal):', err.message)
      );

      res.json({ success: true, snapshot, filesProcessed: extractedTexts.length });
    } catch (err: any) {
      console.error("[SNAPSHOT] Error:", err);
      res.status(500).json({ error: err.message || "Analysis failed" });
    }
  });

  // POST /api/bank-statements/submit-to-underwriting — manual trigger (now delegates to shared helper)
  app.post("/api/bank-statements/submit-to-underwriting", async (req: Request, res: Response) => {
    try {
      const { email, businessName } = req.body;
      if (!email) return res.status(400).json({ error: "Email is required" });
      const normalizedKey = email.toLowerCase().trim();
      const baseUrl = `${req.protocol}://${req.get('host')}`;

      // Enforce 2-minute cooldown to prevent duplicate sends from double-clicks or rapid retries
      const lastSent = _uwCooldown.get(normalizedKey);
      if (lastSent && Date.now() - lastSent < 2 * 60 * 1000) {
        console.log(`[SUBMIT-UW] Cooldown active for ${normalizedKey}, skipping duplicate send`);
        return res.json({ success: true, skipped: true, uploadCount: 0 });
      }

      // Cancel any pending auto-debounce timer so the auto-send doesn't fire on top of this manual one
      if (_uwTimers.has(normalizedKey)) {
        clearTimeout(_uwTimers.get(normalizedKey)!);
        _uwTimers.delete(normalizedKey);
        console.log(`[SUBMIT-UW] Cancelled pending auto-debounce for ${normalizedKey}`);
      }

      _uwCooldown.set(normalizedKey, Date.now());
      const result = await doSendUnderwritingEmail({ email, businessName, baseUrl });
      res.json({ success: true, uploadCount: result.uploadCount });
    } catch (err: any) {
      console.error("[BANK STATEMENTS] submit-to-underwriting error:", err);
      res.status(500).json({ error: "Failed to submit to underwriting" });
    }
  });

  // Short-lived server-side cache for the heavy "all uploads" admin/underwriting query.
  // Prevents multiple simultaneous logins from each hammering the DB with a full table scan.
  const bankStatementsAdminCache: { data: any[] | null; expiry: number } = { data: null, expiry: 0 };
  const BANK_STATEMENTS_CACHE_TTL_MS = 30_000; // 30 seconds

  app.get("/api/bank-statements/uploads", async (req, res) => {
    if (!req.session.user?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }

    try {
      let uploads;
      
      // Admin and underwriting see all uploads, agents see only uploads from their applications
      // Users (restricted role) see only their own uploads
      if (req.session.user.role === 'admin' || req.session.user.role === 'underwriting') {
        const now = Date.now();
        if (bankStatementsAdminCache.data && now < bankStatementsAdminCache.expiry) {
          console.log(`[BANK STATEMENTS] ${req.session.user.role} served from cache (${bankStatementsAdminCache.data.length} uploads)`);
          uploads = bankStatementsAdminCache.data;
        } else {
          uploads = await storage.getAllBankStatementUploads();
          bankStatementsAdminCache.data = uploads;
          bankStatementsAdminCache.expiry = now + BANK_STATEMENTS_CACHE_TTL_MS;
          console.log(`[BANK STATEMENTS] ${req.session.user.role} fetching all ${uploads.length} uploads (cache refreshed)`);
        }
      } else if (req.session.user.role === 'agent' && req.session.user.agentEmail) {
        uploads = await storage.getBankStatementUploadsByAgentEmail(req.session.user.agentEmail);
        console.log(`[BANK STATEMENTS] Agent ${req.session.user.agentName} fetching ${uploads.length} uploads`);
      } else if (req.session.user.role === 'user' && req.session.user.agentEmail) {
        // User role - can only see their own uploads (restricted access)
        uploads = await storage.getBankStatementUploadsByAgentEmail(req.session.user.agentEmail);
        console.log(`[BANK STATEMENTS] User ${req.session.user.agentName} fetching ${uploads.length} uploads`);
      } else {
        // Partners and other roles don't have access to bank statements
        return res.status(403).json({ error: "Access denied" });
      }
      
      res.json(uploads);
    } catch (error) {
      console.error("Error fetching bank statement uploads:", error);
      res.status(500).json({ error: "Failed to fetch uploads" });
    }
  });

  // Update bank statement approval status (underwriting and admin only)
  app.patch("/api/bank-statements/:id/approval", async (req, res) => {
    if (!req.session.user?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }

    // Only underwriting and admin can update approval status
    if (req.session.user.role !== 'underwriting' && req.session.user.role !== 'admin') {
      return res.status(403).json({ error: "Only underwriting team can update approval status" });
    }

    const { id } = req.params;
    const { approvalStatus, approvalNotes } = req.body;

    if (!approvalStatus || !['approved', 'declined', 'pending', 'unqualified'].includes(approvalStatus)) {
      return res.status(400).json({ error: "Invalid approval status. Must be 'approved', 'declined', 'pending', or 'unqualified'" });
    }

    try {
      const reviewerEmail = req.session.user.agentEmail || 'admin';
      const updatedUpload = await storage.updateBankStatementApproval(
        id,
        approvalStatus === 'pending' ? null : approvalStatus,
        approvalNotes || null,
        approvalStatus === 'pending' ? null : reviewerEmail
      );

      if (!updatedUpload) {
        return res.status(404).json({ error: "Bank statement not found" });
      }

      console.log(`[BANK STATEMENTS] ${reviewerEmail} set approval status to ${approvalStatus} for upload ${id}`);
      bankStatementsAdminCache.data = null; // bust cache so the change shows immediately
      res.json(updatedUpload);
    } catch (error) {
      console.error("Error updating bank statement approval:", error);
      res.status(500).json({ error: "Failed to update approval status" });
    }
  });

  // Admin: Edit a bank statement upload (businessName / email)
  app.patch("/api/bank-statements/:id", async (req, res) => {
    if (!req.session.user?.isAuthenticated) return res.status(401).json({ error: "Authentication required" });
    if (req.session.user.role !== 'admin') return res.status(403).json({ error: "Admin access required" });
    const { id } = req.params;
    const { businessName, email } = req.body as { businessName?: string; email?: string };
    try {
      const updated = await storage.updateBankStatementUpload(id, { businessName, email });
      if (!updated) return res.status(404).json({ error: "Upload not found" });
      bankStatementsAdminCache.data = null; // bust cache so the change shows immediately
      res.json(updated);
    } catch (error) {
      console.error("Error updating bank statement upload:", error);
      res.status(500).json({ error: "Failed to update upload" });
    }
  });

  // Admin: Delete a bank statement upload record (does not remove file from object storage)
  app.delete("/api/bank-statements/:id", async (req, res) => {
    if (!req.session.user?.isAuthenticated) return res.status(401).json({ error: "Authentication required" });
    if (req.session.user.role !== 'admin') return res.status(403).json({ error: "Admin access required" });
    const { id } = req.params;
    try {
      await storage.deleteBankStatementUpload(id);
      bankStatementsAdminCache.data = null; // bust cache so the change shows immediately
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting bank statement upload:", error);
      res.status(500).json({ error: "Failed to delete upload" });
    }
  });

  // ========================================
  // CONGRATULATIONS DOCUMENT UPLOAD ROUTES
  // ========================================

  // Configure multer for congratulations document uploads (voided check + driver's license)
  const congratsDocUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_SIZE },
    fileFilter: (_req, file, cb) => {
      const allowed = ["application/pdf", "image/jpeg", "image/png", "image/webp"];
      if (allowed.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error("Only PDF, JPG, PNG, or WebP files are allowed"));
      }
    },
  });

  app.post("/api/congratulations/upload", (req, res, next) => {
    congratsDocUpload.single("file")(req, res, (err: any) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: "File size exceeds 25MB limit" });
        }
        return res.status(400).json({ error: err.message });
      }
      next();
    });
  }, async (req, res) => {
    try {
      const file = req.file;
      if (!file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      const { email, businessName, docType } = req.body;

      if (!email) {
        return res.status(400).json({ error: "Email is required" });
      }

      if (!docType || !["voided_check", "drivers_license"].includes(docType)) {
        return res.status(400).json({ error: "Invalid document type" });
      }

      if (!objectStorage.isConfigured()) {
        console.error("[UPLOAD] Object Storage not configured - cannot accept uploads");
        return res.status(500).json({ error: "File storage is not configured. Please contact support." });
      }

      // Upload to object storage under a dedicated prefix
      const { randomUUID } = await import("crypto");
      const objectId = randomUUID();
      const prefix = `congratulations-docs/${docType}`;
      const objectName = `${prefix}/${objectId}-${file.originalname}`;

      // Encode buffer as base64 for storage (same pattern as bank statements)
      const base64Content = file.buffer.toString("base64");
      const { Client } = await import("@replit/object-storage");
      const client = new Client();
      const result = await client.uploadFromText(objectName, base64Content);

      if (!result.ok) {
        throw new Error(`Upload failed: ${(result as any).error?.message || "Unknown error"}`);
      }

      console.log(`[CONGRATS UPLOAD] Uploaded ${docType} for ${email}: ${objectName} (${file.size} bytes)`);

      // Save record to database
      const { contactId, opportunityId } = req.body;
      const dbRecord = await storage.createCongratulationsUpload({
        email: email.toLowerCase(),
        businessName: businessName || null,
        docType,
        objectName,
        originalFileName: file.originalname,
        fileSize: file.size,
        contactId: contactId || null,
        opportunityId: opportunityId || null,
      });

      console.log(`[CONGRATS UPLOAD] Saved DB record ${dbRecord.id} for ${email}`);

      // SMS: docs_uploaded — look up phone from linked application
      const _duApp = await storage.getLoanApplicationByEmail(email).catch(() => null);
      if (_duApp?.phone) {
        const _duParts = (_duApp.fullName || '').trim().split(' ');
        fireSmsStageEvent({
          stage: 'docs_uploaded',
          phone: _duApp.phone,
          email: email || undefined,
          first_name: _duParts[0] || undefined,
          last_name: _duParts.slice(1).join(' ') || undefined,
          business_name: businessName || _duApp.businessName || undefined,
          deal_id: _duApp.id,
          ghl_contact_id: contactId || undefined,
          metadata: { docType },
        });
      }

      res.json({
        success: true,
        upload: {
          id: dbRecord.id,
          objectName,
          docType,
          originalFileName: file.originalname,
          fileSize: file.size,
          email,
          businessName: businessName || null,
        },
      });
    } catch (error) {
      console.error("[CONGRATS UPLOAD] Error:", error);
      res.status(500).json({ error: "Failed to upload document. Please try again." });
    }
  });

  // GET all congratulations document uploads (admin only)
  app.get("/api/congratulations/uploads", async (req, res) => {
    if (!req.session.user?.isAuthenticated) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    try {
      const uploads = await storage.getAllCongratulationsUploads();
      res.json(uploads);
    } catch (error) {
      console.error("[CONGRATS UPLOADS] Error fetching uploads:", error);
      res.status(500).json({ error: "Failed to fetch uploads" });
    }
  });

  // GET uploads by email
  app.get("/api/congratulations/uploads/by-email/:email", async (req, res) => {
    if (!req.session.user?.isAuthenticated) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    try {
      const uploads = await storage.getCongratulationsUploadsByEmail(req.params.email);
      res.json(uploads);
    } catch (error) {
      console.error("[CONGRATS UPLOADS] Error fetching uploads by email:", error);
      res.status(500).json({ error: "Failed to fetch uploads" });
    }
  });

  app.post("/api/congratulations/complete", async (req, res) => {
    try {
      const { email, businessName, contactId, opportunityId, phone, ownerName } = req.body;

      if (!email) {
        return res.status(400).json({ error: "Email is required" });
      }

      const GHL_WEBHOOK_URL = "https://services.leadconnectorhq.com/hooks/n778xwOps9t8Q34eRPfM/webhook-trigger/2fca1a25-5e31-444b-a21a-f53fbbb56f35";

      const payload = {
        event: "documents_submitted",
        email,
        businessName: businessName || null,
        ownerName: ownerName || null,
        phone: phone || null,
        contactId: contactId || null,
        opportunityId: opportunityId || null,
        documents: ["voided_check", "drivers_license"],
        submittedAt: new Date().toISOString(),
      };

      console.log(`[CONGRATS COMPLETE] Firing GHL webhook for ${email}`, payload);

      const webhookResponse = await fetch(GHL_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!webhookResponse.ok) {
        const text = await webhookResponse.text();
        console.error(`[CONGRATS COMPLETE] GHL webhook failed (${webhookResponse.status}): ${text}`);
        return res.status(502).json({ error: "Failed to notify CRM. Documents were uploaded successfully." });
      }

      console.log(`[CONGRATS COMPLETE] GHL webhook sent successfully for ${email}`);

      // SMS: congratulations_reached (fires after both docs submitted and GHL notified)
      if (phone) {
        const _cgParts = (ownerName || '').trim().split(' ');
        // Look up deal_id from application
        const _cgApp = await storage.getLoanApplicationByEmail(email).catch(() => null);
        fireSmsStageEvent({
          stage: 'congratulations_reached',
          phone,
          email: email || undefined,
          first_name: _cgParts[0] || undefined,
          last_name: _cgParts.slice(1).join(' ') || undefined,
          business_name: businessName || undefined,
          deal_id: _cgApp?.id || undefined,
          ghl_contact_id: contactId || undefined,
        });
      }

      res.json({ success: true });
    } catch (error) {
      console.error("[CONGRATS COMPLETE] Error firing webhook:", error);
      res.status(500).json({ error: "Failed to send notification. Documents were uploaded successfully." });
    }
  });

  // ============= Business Underwriting Decisions =============
  
  // Get all business underwriting decisions
  // Lightweight status counts for page badges — avoids fetching full decision rows
  app.get("/api/underwriting-decisions/counts", async (req, res) => {
    if (!req.session.user?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }
    if (req.session.user.role !== 'underwriting' && req.session.user.role !== 'admin' && req.session.user.role !== 'agent') {
      return res.status(403).json({ error: "Access denied" });
    }
    try {
      const counts = await storage.getDecisionStatusCounts();
      res.json(counts);
    } catch (error) {
      console.error("Error fetching decision counts:", error);
      res.status(500).json({ error: "Failed to fetch counts" });
    }
  });

  // GigFi submission statuses by email — GigFi data lives on loan_applications,
  // not on decisions. Used by the Unqualified page to show submission outcomes.
  app.get("/api/admin/gigfi-statuses", async (req, res) => {
    if (!req.session.user?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }
    if (req.session.user.role !== 'underwriting' && req.session.user.role !== 'admin' && req.session.user.role !== 'agent') {
      return res.status(403).json({ error: "Access denied" });
    }
    try {
      const rows = await db.execute(sql`
        SELECT LOWER(email) AS email, gigfi_status AS status, gigfi_redirect_url AS redirect_url, gigfi_submitted_at AS submitted_at
        FROM loan_applications
        WHERE gigfi_status IS NOT NULL AND email IS NOT NULL
      `);
      const byEmail: Record<string, { status: string; redirectUrl: string | null; submittedAt: string | null }> = {};
      for (const row of (rows as any).rows || []) {
        byEmail[row.email] = {
          status: row.status,
          redirectUrl: row.redirect_url || null,
          submittedAt: row.submitted_at || null,
        };
      }
      res.json(byEmail);
    } catch (error) {
      console.error("Error fetching gigfi statuses:", error);
      res.status(500).json({ error: "Failed to fetch gigfi statuses" });
    }
  });

  app.get("/api/underwriting-decisions", async (req, res) => {
    if (!req.session.user?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }

    // Underwriting, admin, and agents can view decisions
    if (req.session.user.role !== 'underwriting' && req.session.user.role !== 'admin' && req.session.user.role !== 'agent') {
      return res.status(403).json({ error: "Access denied" });
    }

    try {
      // Optional server-side status filter (?status=approved|declined|funded|unqualified)
      const VALID_STATUSES = ['approved', 'declined', 'funded', 'unqualified'];
      const statusFilter = typeof req.query.status === 'string' && VALID_STATUSES.includes(req.query.status)
        ? req.query.status
        : undefined;
      // ?view=approvals|funded — dual visibility: includes any record that HAS
      // approvals/fundings even if its status moved on (e.g. funded biz with approvals)
      const viewFilter = req.query.view === 'approvals' || req.query.view === 'funded'
        ? (req.query.view as 'approvals' | 'funded')
        : undefined;
      const decisions = viewFilter
        ? await storage.getDecisionsForView(viewFilter)
        : await storage.getAllBusinessUnderwritingDecisions(statusFilter);

      // For agents, filter to only their files:
      // - assignedRep matches agent name
      // - OR repFollowers includes agent name
      // - OR businessEmail matches an application with their agentEmail
      if (req.session.user.role === 'agent' && req.session.user.agentName) {
        const agentName = req.session.user.agentName;
        const agentEmail = (req.session.user.agentEmail || '').toLowerCase();

        // Build set of business emails from apps assigned to this agent —
        // use a targeted query instead of scanning all 1,300+ applications.
        const agentApps = await storage.getApplicationEmailsByAgentEmail(agentEmail);
        const agentBusinessEmails = new Set<string>(agentApps);

        const agentDecisions = decisions.filter(d => {
          // Direct assignment
          if (d.assignedRep && d.assignedRep.toLowerCase() === agentName.toLowerCase()) return true;
          // Rep follower
          if (Array.isArray(d.repFollowers) && d.repFollowers.some((f: string) => f.toLowerCase() === agentName.toLowerCase())) return true;
          // Business email matches an app assigned to this agent
          if (d.businessEmail && agentBusinessEmails.has(d.businessEmail.toLowerCase())) return true;
          if (d.merchantEmail && agentBusinessEmails.has(d.merchantEmail.toLowerCase())) return true;
          return false;
        });

        return res.json(agentDecisions);
      }

      res.json(decisions);
    } catch (error) {
      console.error("Error fetching underwriting decisions:", error);
      res.status(500).json({ error: "Failed to fetch decisions" });
    }
  });
  
  // Get underwriting decision by business email
  app.get("/api/underwriting-decisions/by-email", async (req, res) => {
    if (!req.session.user?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }
    
    // Only underwriting and admin can view decisions
    if (req.session.user.role !== 'underwriting' && req.session.user.role !== 'admin') {
      return res.status(403).json({ error: "Access denied" });
    }
    
    const email = req.query.email as string;
    if (!email) {
      return res.status(400).json({ error: "Email parameter required" });
    }
    
    try {
      const decisions = await storage.getBusinessUnderwritingDecisionsByEmail(email);
      // Return array of all deals for this contact, or the first one for backwards compatibility
      res.json(decisions.length > 0 ? decisions : null);
    } catch (error) {
      console.error("Error fetching underwriting decision:", error);
      res.status(500).json({ error: "Failed to fetch decision" });
    }
  });
  
  // ─── GigFi auto-submit helper (fires async after unqualified decision saved) ──
  async function autoSubmitGigFiForUnqualified(decisionId: string, businessEmail: string): Promise<void> {
    if (!isGigFiConfigured()) {
      console.log(`[GIGFI AUTO] Skipping — GigFi not configured`);
      return;
    }

    try {
      // Fetch the loan application for this email
      const app = await storage.getLoanApplicationByEmail(businessEmail.toLowerCase().trim());
      if (!app) {
        console.log(`[GIGFI AUTO] No loan application found for ${businessEmail} — skipping`);
        return;
      }

      // Parse name
      const fullName = (app.fullName || `${(app as any).firstName || ''} ${(app as any).lastName || ''}`).trim();
      const nameParts = fullName.split(/\s+/).filter(Boolean);
      const firstName = nameParts[0] || 'Unknown';
      const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : nameParts[0] || 'Unknown';

      // Required fields check — skip if missing critical data
      const ssn = ((app as any).socialSecurityNumber || '').replace(/\D/g, '');
      const dob = (app as any).dateOfBirth || '';
      const homeAddress = (app as any).ownerAddress1 || (app as any).businessStreetAddress || (app as any).businessAddress || '';
      const homeCity    = (app as any).ownerCity || (app as any).city || '';
      const homeState   = ((app as any).ownerState || (app as any).state || '').toUpperCase().slice(0, 2);
      const homeZip     = ((app as any).ownerZip || (app as any).zipCode || '').replace(/\D/g, '').slice(0, 5);

      const missing: string[] = [];
      if (ssn.length !== 9) missing.push('SSN');
      if (!dob)             missing.push('DOB');
      if (!homeAddress)     missing.push('homeAddress');
      if (!homeCity)        missing.push('homeCity');
      if (!homeState)       missing.push('homeState');
      if (!homeZip)         missing.push('homeZip');

      if (missing.length > 0) {
        console.log(`[GIGFI AUTO] Skipping ${businessEmail} — missing: ${missing.join(', ')}`);
        await storage.updateBusinessUnderwritingDecision(decisionId, {
          gigfiStatus: 'SKIPPED' as any,
          gigfiSubmittedAt: new Date(),
        } as any);
        return;
      }

      // Parse monthly revenue (handles "$5,000 - $10,000" or "5000")
      const rawRev = String(app.monthlyRevenue || (app as any).averageMonthlyRevenue || '3000');
      const revMatch = rawRev.replace(/[$,]/g, '').match(/[\d.]+/);
      const monthlyRevenue = revMatch ? Math.round(parseFloat(revMatch[0])) : 3000;

      // Cap financing amount at $10,000
      const rawAmount = parseFloat(String(app.requestedAmount || '2500')) || 2500;
      const financingAmount = Math.min(rawAmount, 10000);

      // Next pay date = 14 days from today, skip to Monday if weekend
      const nextPay = new Date();
      nextPay.setDate(nextPay.getDate() + 14);
      const dow = nextPay.getDay();
      if (dow === 0) nextPay.setDate(nextPay.getDate() + 1); // Sunday → Monday
      if (dow === 6) nextPay.setDate(nextPay.getDate() + 2); // Saturday → Monday
      const mm = String(nextPay.getMonth() + 1).padStart(2, '0');
      const dd = String(nextPay.getDate()).padStart(2, '0');
      const yyyy = nextPay.getFullYear();
      const nextPayDay = `${mm}/${dd}/${yyyy}`;

      const leadData: GigFiLeadData = {
        firstName,
        lastName,
        email: app.email || businessEmail,
        phone: app.phone || '',
        businessName: (app as any).legalBusinessName || app.businessName || fullName,
        monthlyRevenue,
        financingAmount,
        businessAge: (app as any).timeInBusiness || undefined,
        ssn,
        dob,
        homeAddress,
        homeCity,
        homeState,
        homeZip,
        payFrequency: '2',   // bi-weekly — satisfies "at least every 2 weeks"
        nextPayDay,
      };

      console.log(`[GIGFI AUTO] Submitting ${businessEmail} — amount=$${financingAmount}, payFreq=bi-weekly, nextPay=${nextPayDay}`);
      const result = await submitToGigFi(leadData, app.id || decisionId);

      await storage.updateBusinessUnderwritingDecision(decisionId, {
        gigfiStatus: result.status,
        gigfiDecisionId: result.decisionId || null,
        gigfiRedirectUrl: result.redirectUrl || null,
        gigfiSubmittedAt: new Date(),
      } as any);

      console.log(`[GIGFI AUTO] Result for ${businessEmail}: ${result.status}${result.redirectUrl ? ` → ${result.redirectUrl}` : ''}`);
    } catch (err: any) {
      console.error(`[GIGFI AUTO] Error submitting ${businessEmail}:`, err.message || err);
    }
  }

  // Create or update business underwriting decision
  app.post("/api/underwriting-decisions", async (req, res) => {
    console.log(`[UNDERWRITING POST] Received request from ${req.session.user?.agentEmail || 'unknown'} (role: ${req.session.user?.role || 'none'})`);
    
    if (!req.session.user?.isAuthenticated) {
      console.log(`[UNDERWRITING POST] Rejected: not authenticated`);
      return res.status(401).json({ error: "Authentication required" });
    }
    
    // Only underwriting and admin can create/update decisions
    if (req.session.user.role !== 'underwriting' && req.session.user.role !== 'admin') {
      console.log(`[UNDERWRITING POST] Rejected: role '${req.session.user.role}' does not have permission`);
      return res.status(403).json({ error: "Only underwriting team can manage decisions" });
    }
    
    const {
      businessEmail,
      businessName,
      businessPhone,
      status,
      advanceAmount,
      term,
      paymentFrequency,
      factorRate,
      buyRate,
      sellRate,
      totalPayback,
      netAfterFees,
      lender,
      notes,
      approvalDate,
      declineReason,
      followUpWorthy,
      followUpDate,
      additionalApprovals,
      additionalDeclines,
      fundedDate,
      assignedRep,
      assignedRep2,
    } = req.body;

    console.log(`[UNDERWRITING POST] Data: email=${businessEmail}, name=${businessName}, status=${status}, approvals=${additionalApprovals?.length || 0}`);

    if (!businessEmail) {
      return res.status(400).json({ error: "Business email is required" });
    }

    if (!status || !['approved', 'declined', 'unqualified', 'funded'].includes(status)) {
      return res.status(400).json({ error: "Status must be 'approved', 'declined', 'unqualified', or 'funded'" });
    }

    try {
      const reviewerEmail = req.session.user.agentEmail || 'admin';

      // Sync primary approval data from additionalApprovals JSONB to top-level columns
      let syncedAdvanceAmount = advanceAmount || null;
      let syncedTerm = term || null;
      let syncedPaymentFrequency = paymentFrequency || null;
      let syncedFactorRate = factorRate || null;
      let syncedBuyRate = buyRate || null;
      let syncedSellRate = sellRate || null;
      let syncedTotalPayback = totalPayback || null;
      let syncedNetAfterFees = netAfterFees || null;
      let syncedLender = lender || null;
      let syncedNotes = notes || null;
      let syncedApprovalDate = approvalDate ? new Date(approvalDate) : new Date();

      if (additionalApprovals && Array.isArray(additionalApprovals)) {
        const primary = additionalApprovals.find((a: any) => a.isPrimary);
        if (primary) {
          syncedAdvanceAmount = primary.advanceAmount ? parseFloat(primary.advanceAmount) : null;
          syncedTerm = primary.term || null;
          syncedPaymentFrequency = primary.paymentFrequency || null;
          syncedFactorRate = primary.factorRate ? parseFloat(primary.factorRate) : null;
          syncedBuyRate = primary.buyRate ? parseFloat(primary.buyRate) : null;
          syncedSellRate = primary.sellRate ? parseFloat(primary.sellRate) : null;
          syncedTotalPayback = primary.totalPayback ? parseFloat(primary.totalPayback) : null;
          syncedNetAfterFees = primary.netAfterFees ? parseFloat(primary.netAfterFees) : null;
          syncedLender = primary.lender || null;
          syncedNotes = primary.notes || null;
          syncedApprovalDate = primary.approvalDate ? new Date(primary.approvalDate) : new Date();
        }
      }

      // For funded deals, build a fundedEntry and accumulate in additionalFundings
      let incomingAdditionalFundings = req.body.additionalFundings || null;
      if (status === 'funded' && !incomingAdditionalFundings) {
        const fundedEntry = {
          id: crypto.randomUUID(),
          lender: syncedLender || null,
          advanceAmount: syncedAdvanceAmount?.toString() || null,
          term: syncedTerm || null,
          paymentFrequency: syncedPaymentFrequency || null,
          factorRate: syncedFactorRate?.toString() || null,
          buyRate: syncedBuyRate?.toString() || null,
          sellRate: syncedSellRate?.toString() || null,
          maxUpsell: req.body.maxUpsell?.toString() || null,
          totalPayback: syncedTotalPayback?.toString() || null,
          netAfterFees: syncedNetAfterFees?.toString() || null,
          notes: syncedNotes || null,
          fundedDate: fundedDate ? new Date(fundedDate).toISOString() : new Date().toISOString(),
          assignedRep: assignedRep || null,
          assignedRep2: assignedRep2 || null,
          createdAt: new Date().toISOString(),
        };
        incomingAdditionalFundings = [fundedEntry];
      }

      // Rebuild declineReason text from additionalDeclines JSONB (source of truth)
      let finalDeclineReason = declineReason || null;
      let finalAdditionalDeclines = additionalDeclines || null;
      if (Array.isArray(finalAdditionalDeclines) && finalAdditionalDeclines.length > 0) {
        finalDeclineReason = finalAdditionalDeclines
          .map((d: any) => {
            const parts = [d.reason || 'No reason stated'];
            const lenderDate = [d.lender, d.date].filter(Boolean).join(' - ');
            if (lenderDate) parts[0] += ` (${lenderDate})`;
            return parts[0];
          })
          .join('; ');
      }

      const decision = await storage.createOrUpdateBusinessUnderwritingDecision({
        businessEmail,
        businessName: businessName || null,
        businessPhone: businessPhone || null,
        status,
        advanceAmount: syncedAdvanceAmount,
        term: syncedTerm,
        paymentFrequency: syncedPaymentFrequency,
        factorRate: syncedFactorRate,
        buyRate: syncedBuyRate,
        sellRate: syncedSellRate,
        totalPayback: syncedTotalPayback,
        netAfterFees: syncedNetAfterFees,
        lender: syncedLender,
        notes: syncedNotes,
        approvalDate: syncedApprovalDate,
        declineReason: finalDeclineReason,
        additionalDeclines: finalAdditionalDeclines,
        followUpWorthy: followUpWorthy || false,
        followUpDate: followUpDate ? new Date(followUpDate) : null,
        additionalApprovals: additionalApprovals || null,
        additionalFundings: incomingAdditionalFundings,
        reviewedBy: reviewerEmail,
        fundedDate: fundedDate ? new Date(fundedDate) : null,
        assignedRep: assignedRep || null,
        assignedRep2: assignedRep2 || null,
      });
      
      console.log(`[UNDERWRITING] ${reviewerEmail} set ${status} for business ${businessEmail}`);

      // /track lead lifecycle: funded lead → mark converted + pre-create portal (async)
      if (status === 'funded') {
        autoProvisionPortalForFundedLead(businessEmail, businessName).catch(() => {});
      }

      // Portal activation is now manual — staff clicks "Activate Portal" on the funded dashboard

      // Sync to GHL opportunity (async, non-blocking)
      ghlService.syncUnderwritingDecision(decision).then(async (ghlResult) => {
        try {
          await storage.updateBusinessUnderwritingDecision(decision.id, {
            ghlSynced: ghlResult.success,
            ghlSyncedAt: new Date(),
            ghlSyncMessage: ghlResult.message,
            ghlOpportunityId: ghlResult.opportunityId || null,
          });
          console.log(`[UNDERWRITING] GHL sync for ${businessEmail}: ${ghlResult.success ? 'success' : 'skipped'} - ${ghlResult.message}`);
        } catch (dbErr) {
          console.error(`[UNDERWRITING] Failed to save GHL sync status for ${businessEmail}:`, dbErr);
        }
      }).catch(err => {
        console.error(`[UNDERWRITING] GHL sync error for ${businessEmail}:`, err);
      });

      // Sync to Salesforce (async, non-blocking)
      if (SF_SYNC_ENABLED) syncDecisionToSalesforce(decision).then(async (sfResult) => {
        try {
          await storage.updateBusinessUnderwritingDecision(decision.id, {
            sfSynced: sfResult.synced,
            sfSyncedAt: new Date(),
            sfSyncMessage: sfResult.error || (sfResult.action || 'ok'),
            sfOpportunityId: sfResult.oppId || null,
          });
          console.log(`[UNDERWRITING] SF sync for ${businessEmail}: ${sfResult.synced ? 'success' : 'skipped'} - ${sfResult.action || sfResult.error || 'no-op'}`);

          // Alert on sync failure via SMS
          if (!sfResult.synced && process.env.SMS_MIDDLEWARE_URL) {
            try {
              const alertPhone = process.env.SYNC_ALERT_PHONE || "+18189174757";
              await fetch(`${process.env.SMS_MIDDLEWARE_URL.replace('/stage-event', '')}/webhooks/ghl/workflow-trigger`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  phone: alertPhone,
                  message: `[TCG Sync Alert] Decision for ${decision.businessName || businessEmail} failed to sync to SF: ${sfResult.error || sfResult.reason || 'unknown'}`,
                }),
              }).catch(() => {});
            } catch {}
          }
        } catch (dbErr) {
          console.error(`[UNDERWRITING] Failed to save SF sync status for ${businessEmail}:`, dbErr);
        }
      }).catch(err => {
        console.error(`[UNDERWRITING] SF sync error for ${businessEmail}:`, err);
      });

      // Sync decision to dialer_contacts (async, non-blocking)
      syncDecisionToDialer(decision).catch(err =>
        console.error(`[UNDERWRITING] Dialer sync error for ${businessEmail}:`, err)
      );

      // SMS: approval_issued + auto congratulations message
      if (status === 'approved' && businessPhone) {
        const _proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
        const _host = req.headers['x-forwarded-host'] || req.headers.host || 'capitalloanconnect.com';
        const _approvalLink = decision.approvalSlug ? `${_proto}://${_host}/approval-letter/${decision.approvalSlug}` : undefined;
        const _topAmount = decision.advanceAmount ? parseFloat(String(decision.advanceAmount)) : undefined;
        fireSmsStageEvent({
          stage: 'approval_issued',
          phone: businessPhone,
          email: businessEmail || undefined,
          business_name: businessName || undefined,
          deal_id: decision.id,
          approval_link: _approvalLink,
          amount: _topAmount,
          lender: decision.lender || undefined,
        });

        // Auto-trigger: congratulations SMS to merchant
        const _approvalNameParts = (businessName || '').trim().split(' ');
        triggerApprovalCongratulations({
          decisionId: decision.id,
          phone: businessPhone,
          email: businessEmail || undefined,
          firstName: _approvalNameParts[0] || undefined,
          businessName: businessName || undefined,
          approvalLink: _approvalLink,
          amount: _topAmount,
          lender: decision.lender || undefined,
        });
      }

      // SMS: funded + auto congratulations message
      if (status === 'funded' && businessPhone) {
        const _fundedAmount = decision.advanceAmount ? parseFloat(String(decision.advanceAmount)) : undefined;
        fireSmsStageEvent({
          stage: 'funded',
          phone: businessPhone,
          email: businessEmail || undefined,
          business_name: businessName || undefined,
          deal_id: decision.id,
          amount: _fundedAmount,
          lender: decision.lender || undefined,
        });

        // Auto-trigger: funded congratulations SMS to merchant
        const _fundedNameParts = (businessName || '').trim().split(' ');
        triggerFundedCongratulations({
          decisionId: decision.id,
          phone: businessPhone,
          email: businessEmail || undefined,
          firstName: _fundedNameParts[0] || undefined,
          businessName: businessName || undefined,
          amount: _fundedAmount,
          lender: decision.lender || undefined,
        });
      }

      // Auto-submit to GigFi when marked unqualified (async, non-blocking)
      if (status === 'unqualified' && businessEmail) {
        autoSubmitGigFiForUnqualified(decision.id, businessEmail).catch(err =>
          console.error('[GIGFI AUTO] Unhandled error:', err)
        );
      }

      res.json(decision);
    } catch (error: any) {
      console.error("Error saving underwriting decision:", error);
      const errorMessage = error?.message || error?.detail || "Failed to save decision";
      console.error("[UNDERWRITING POST] Full error details:", JSON.stringify({
        message: error?.message,
        detail: error?.detail,
        code: error?.code,
        constraint: error?.constraint,
        column: error?.column,
        table: error?.table,
        stack: error?.stack?.split('\n').slice(0, 5),
      }));
      res.status(500).json({ error: errorMessage });
    }
  });
  
  // Update business underwriting decision by ID (partial update)
  app.patch("/api/underwriting-decisions/:id", async (req, res) => {
    console.log(`[UNDERWRITING PATCH] Received request for decision ${req.params.id} from ${req.session.user?.agentEmail || 'unknown'} (role: ${req.session.user?.role || 'none'})`);
    
    if (!req.session.user?.isAuthenticated) {
      console.log(`[UNDERWRITING PATCH] Rejected: not authenticated`);
      return res.status(401).json({ error: "Authentication required" });
    }

    if (req.session.user.role !== 'underwriting' && req.session.user.role !== 'admin') {
      console.log(`[UNDERWRITING PATCH] Rejected: role '${req.session.user.role}' does not have permission`);
      return res.status(403).json({ error: "Only underwriting team can manage decisions" });
    }

    const { id } = req.params;
    const updates = req.body;
    console.log(`[UNDERWRITING PATCH] Updating decision ${id}, keys: ${Object.keys(updates).join(', ')}, approvals count: ${updates.additionalApprovals?.length || 'N/A'}`);

    try {
      // Convert date strings to Date objects if provided; treat empty strings as null
      if (updates.approvalDate !== undefined && typeof updates.approvalDate === 'string') {
        updates.approvalDate = updates.approvalDate ? new Date(updates.approvalDate) : null;
      }
      if (updates.followUpDate !== undefined && typeof updates.followUpDate === 'string') {
        updates.followUpDate = updates.followUpDate ? new Date(updates.followUpDate) : null;
      }
      if (updates.fundedDate !== undefined && typeof updates.fundedDate === 'string') {
        updates.fundedDate = updates.fundedDate ? new Date(updates.fundedDate) : null;
      }
      if (updates.approvalDeadline !== undefined && typeof updates.approvalDeadline === 'string') {
        updates.approvalDeadline = updates.approvalDeadline ? new Date(updates.approvalDeadline) : null;
      }

      // Sync primary approval data from additionalApprovals JSONB to top-level columns
      if (updates.additionalApprovals && Array.isArray(updates.additionalApprovals)) {
        const primary = updates.additionalApprovals.find((a: any) => a.isPrimary);
        if (primary) {
          updates.advanceAmount = primary.advanceAmount ? parseFloat(primary.advanceAmount) : null;
          updates.term = primary.term || null;
          updates.paymentFrequency = primary.paymentFrequency || null;
          updates.factorRate = primary.factorRate ? parseFloat(primary.factorRate) : null;
          updates.buyRate = primary.buyRate ? parseFloat(primary.buyRate) : null;
          updates.sellRate = primary.sellRate ? parseFloat(primary.sellRate) : null;
          updates.totalPayback = primary.totalPayback ? parseFloat(primary.totalPayback) : null;
          updates.netAfterFees = primary.netAfterFees ? parseFloat(primary.netAfterFees) : null;
          updates.lender = primary.lender || null;
          updates.notes = primary.notes || null;
          updates.approvalDate = primary.approvalDate ? new Date(primary.approvalDate) : null;
        }
      }

      updates.reviewedBy = req.session.user.agentEmail || 'admin';

      // Rebuild declineReason text from additionalDeclines JSONB when provided
      if (Array.isArray(updates.additionalDeclines) && updates.additionalDeclines.length > 0) {
        updates.declineReason = updates.additionalDeclines
          .map((d: any) => {
            const parts = [d.reason || 'No reason stated'];
            const lenderDate = [d.lender, d.date].filter(Boolean).join(' - ');
            if (lenderDate) parts[0] += ` (${lenderDate})`;
            return parts[0];
          })
          .join('; ');
      }

      // Snapshot old JSONB counts so we can detect NEW offers/fundings after the update
      const oldForNotify = (Array.isArray(updates.additionalApprovals) || Array.isArray(updates.additionalFundings))
        ? await storage.getBusinessUnderwritingDecision(id).catch(() => null)
        : null;

      const updated = await storage.updateBusinessUnderwritingDecision(id, updates);
      if (!updated) {
        return res.status(404).json({ error: "Decision not found" });
      }

      console.log(`[UNDERWRITING] Decision ${id} updated by ${req.session.user.agentEmail || 'admin'}`);

      // /track lead lifecycle: if this business is a lead-portal signup and just funded,
      // mark them converted and pre-create their merchant portal (async, non-blocking)
      if (updates.status === 'funded' || (Array.isArray(updates.additionalFundings) && updates.additionalFundings.length > 0)) {
        autoProvisionPortalForFundedLead(updated.businessEmail || updated.merchantEmail || '', updated.businessName).catch(() => {});
      }

      // Notify the merchant when a NEW offer or funding entry lands in their portal
      // (only for merchants with an activated portal; 10-min dedupe; async, non-blocking)
      try {
        if (oldForNotify) {
          const oldApprovals = Array.isArray(oldForNotify.additionalApprovals) ? (oldForNotify.additionalApprovals as any[]).length : 0;
          const newApprovals = Array.isArray(updates.additionalApprovals) ? updates.additionalApprovals.length : oldApprovals;
          const oldFundings = Array.isArray(oldForNotify.additionalFundings) ? (oldForNotify.additionalFundings as any[]).length : 0;
          const newFundings = Array.isArray(updates.additionalFundings) ? updates.additionalFundings.length : oldFundings;
          const notifyEmail = (updated.merchantEmail || updated.businessEmail || '').toLowerCase();
          if (notifyEmail && (newApprovals > oldApprovals || newFundings > oldFundings)) {
            storage.getMerchantPortalAccountByEmail(notifyEmail).then(portalAccount => {
              const hasActivePortal = !!(portalAccount?.passwordHash || updated.merchantPasswordHash);
              if (!hasActivePortal || !shouldSendMerchantAlert(`portal_update:${notifyEmail}`, 10 * 60 * 1000)) return;
              const what = newFundings > oldFundings ? "funding update" : "new offer";
              logPortalEvent('merchant', notifyEmail, 'portal_update_notified', what);
              const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
    <table width="580" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e5e7eb;">
      <tr><td style="background:#0f1e38;padding:24px 28px;">
        <p style="margin:0;font-size:20px;font-weight:700;color:#ffffff;">There's a ${what} in your portal</p>
      </td></tr>
      <tr><td style="padding:28px;">
        <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">Hi${updated.businessName ? ` ${updated.businessName}` : ""}, your Today Capital Group merchant portal was just updated with a ${what}. Sign in to review the details.</p>
        <table cellpadding="0" cellspacing="0" align="center"><tr><td style="background:#0d9488;border-radius:50px;">
          <a href="https://app.todaycapitalgroup.com/merchant" style="display:inline-block;padding:13px 32px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;">View My Portal</a>
        </td></tr></table>
      </td></tr>
      <tr><td style="background:#f9fafb;padding:18px 28px;border-top:1px solid #e5e7eb;">
        <p style="margin:0;font-size:12px;color:#9ca3af;">Today Capital Group &middot; 6303 Owensmouth Ave, Woodland Hills, CA 91367 &middot; (818) 351-0225</p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
              gmailService.sendEmail(notifyEmail, `You have a ${what} — Today Capital Group`, html).catch(err => {
                console.error('[MERCHANT] Failed to email portal update notification:', err);
              });
            }).catch(() => {});
          }
        }
      } catch (notifyErr) {
        console.error('[MERCHANT] portal update notify error:', notifyErr);
      }

      // Portal activation is now manual — staff clicks "Activate Portal" on the funded dashboard

      // Sync updated decision to GHL opportunity (async, non-blocking)
      ghlService.syncUnderwritingDecision(updated).then(async (ghlResult) => {
        try {
          await storage.updateBusinessUnderwritingDecision(id, {
            ghlSynced: ghlResult.success,
            ghlSyncedAt: new Date(),
            ghlSyncMessage: ghlResult.message,
            ghlOpportunityId: ghlResult.opportunityId || null,
          });
          console.log(`[UNDERWRITING] GHL sync for decision ${id}: ${ghlResult.success ? 'success' : 'skipped'} - ${ghlResult.message}`);
        } catch (dbErr) {
          console.error(`[UNDERWRITING] Failed to save GHL sync status for decision ${id}:`, dbErr);
        }
      }).catch(err => {
        console.error(`[UNDERWRITING] GHL sync error for decision ${id}:`, err);
      });

      // Sync updated decision to Salesforce (async, non-blocking)
      if (SF_SYNC_ENABLED) syncDecisionToSalesforce(updated).then(async (sfResult) => {
        try {
          await storage.updateBusinessUnderwritingDecision(id, {
            sfSynced: sfResult.synced,
            sfSyncedAt: new Date(),
            sfSyncMessage: sfResult.error || (sfResult.action || 'ok'),
            sfOpportunityId: sfResult.oppId || null,
          });
          console.log(`[UNDERWRITING] SF sync for decision ${id}: ${sfResult.synced ? 'success' : 'skipped'} - ${sfResult.action || sfResult.error || 'no-op'}`);
        } catch (dbErr) {
          console.error(`[UNDERWRITING] Failed to save SF sync status for decision ${id}:`, dbErr);
        }
      }).catch(err => {
        console.error(`[UNDERWRITING] SF sync error for decision ${id}:`, err);
      });

      // Sync updated decision to dialer_contacts (async, non-blocking)
      syncDecisionToDialer(updated).catch(err =>
        console.error(`[UNDERWRITING] Dialer sync error for decision ${id}:`, err)
      );

      // SMS: approval_issued + auto congratulations (PATCH path)
      if (updates.status === 'approved' && updated.businessPhone) {
        const _pProto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
        const _pHost = req.headers['x-forwarded-host'] || req.headers.host || 'capitalloanconnect.com';
        const _pLink = updated.approvalSlug ? `${_pProto}://${_pHost}/approval-letter/${updated.approvalSlug}` : undefined;
        const _pAmount = updated.advanceAmount ? parseFloat(String(updated.advanceAmount)) : undefined;
        fireSmsStageEvent({
          stage: 'approval_issued',
          phone: updated.businessPhone,
          email: updated.businessEmail || undefined,
          business_name: updated.businessName || undefined,
          deal_id: updated.id,
          approval_link: _pLink,
          amount: _pAmount,
          lender: updated.lender || undefined,
        });

        // Auto-trigger: congratulations SMS to merchant (PATCH path)
        const _pNameParts = (updated.businessName || '').trim().split(' ');
        triggerApprovalCongratulations({
          decisionId: updated.id,
          phone: updated.businessPhone,
          email: updated.businessEmail || undefined,
          firstName: _pNameParts[0] || undefined,
          businessName: updated.businessName || undefined,
          approvalLink: _pLink,
          amount: _pAmount,
          lender: updated.lender || undefined,
        });
      }

      // SMS: funded + auto congratulations (PATCH path)
      if (updates.status === 'funded' && updated.businessPhone) {
        const _pFundedAmount = updated.advanceAmount ? parseFloat(String(updated.advanceAmount)) : undefined;
        fireSmsStageEvent({
          stage: 'funded',
          phone: updated.businessPhone,
          email: updated.businessEmail || undefined,
          business_name: updated.businessName || undefined,
          deal_id: updated.id,
          amount: _pFundedAmount,
          lender: updated.lender || undefined,
        });

        // Auto-trigger: funded congratulations SMS to merchant (PATCH path)
        const _pFundedNameParts = (updated.businessName || '').trim().split(' ');
        triggerFundedCongratulations({
          decisionId: updated.id,
          phone: updated.businessPhone,
          email: updated.businessEmail || undefined,
          firstName: _pFundedNameParts[0] || undefined,
          businessName: updated.businessName || undefined,
          amount: _pFundedAmount,
          lender: updated.lender || undefined,
        });
      }

      res.json(updated);
    } catch (error) {
      console.error("Error updating underwriting decision:", error);
      res.status(500).json({ error: "Failed to update decision" });
    }
  });

  // Update followers for a funded decision
  app.put("/api/underwriting-decisions/:id/followers", async (req, res) => {
    if (!req.session.user?.isAuthenticated) return res.status(401).json({ error: "Authentication required" });
    if (req.session.user.role !== 'admin' && req.session.user.role !== 'underwriting') {
      return res.status(403).json({ error: "Admin access required" });
    }
    const { id } = req.params;
    const { followers } = req.body;
    if (!Array.isArray(followers)) return res.status(400).json({ error: "followers must be an array" });
    try {
      const updated = await storage.updateBusinessUnderwritingDecision(id, { repFollowers: followers });
      if (!updated) return res.status(404).json({ error: "Decision not found" });
      res.json({ success: true, repFollowers: updated.repFollowers });
    } catch (error) {
      console.error("Error updating followers:", error);
      res.status(500).json({ error: "Failed to update followers" });
    }
  });

  // Delete business underwriting decision (reset to no decision)
  app.delete("/api/underwriting-decisions/:id", async (req, res) => {
    if (!req.session.user?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }
    
    // Only underwriting and admin can delete decisions
    if (req.session.user.role !== 'underwriting' && req.session.user.role !== 'admin') {
      return res.status(403).json({ error: "Only underwriting team can manage decisions" });
    }
    
    const { id } = req.params;
    
    try {
      const deleted = await storage.deleteBusinessUnderwritingDecision(id);
      if (!deleted) {
        return res.status(404).json({ error: "Decision not found" });
      }
      
      console.log(`[UNDERWRITING] Decision ${id} deleted by ${req.session.user.agentEmail || 'admin'}`);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting underwriting decision:", error);
      res.status(500).json({ error: "Failed to delete decision" });
    }
  });

  // Bulk import approvals from CSV
  app.post("/api/underwriting-decisions/bulk-import", async (req, res) => {
    if (!req.session.user?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }
    
    if (req.session.user.role !== 'underwriting' && req.session.user.role !== 'admin') {
      return res.status(403).json({ error: "Only underwriting team or admin can bulk import" });
    }
    
    const { csvData } = req.body;
    
    if (!csvData || typeof csvData !== 'string') {
      return res.status(400).json({ error: "CSV data is required" });
    }
    
    try {
      const reviewerEmail = req.session.user.agentEmail || 'admin';
      
      // Parse CSV
      const lines = csvData.split('\n').map(line => line.trim()).filter(line => line);
      if (lines.length < 2) {
        return res.status(400).json({ error: "CSV must have a header row and at least one data row" });
      }
      
      // Parse header row
      const headers = parseCSVLine(lines[0]);
      const headerMap: Record<string, number> = {};
      headers.forEach((h, i) => {
        headerMap[h.toLowerCase().trim()] = i;
      });
      
      // Required columns
      const businessNameIdx = headerMap['business name'];
      const overallStatusIdx = headerMap['overall status'];
      const emailIdx = headerMap['email'];
      const phoneIdx = headerMap['phone'] ?? headerMap['phone number'];
      
      if (businessNameIdx === undefined) {
        return res.status(400).json({ error: "CSV must have a 'Business Name' column" });
      }
      
      const results: { businessName: string; status: string; error?: string }[] = [];
      
      // Process data rows
      for (let i = 1; i < lines.length; i++) {
        const values = parseCSVLine(lines[i]);
        const businessName = values[businessNameIdx]?.trim();
        
        if (!businessName) continue;
        
        const overallStatus = values[overallStatusIdx]?.trim().toLowerCase() || '';
        const isApproved = overallStatus.includes('approved') && !overallStatus.includes('declined only');
        
        // Use real email if provided, otherwise generate synthetic one
        const csvEmail = emailIdx !== undefined ? values[emailIdx]?.trim() : '';
        const csvPhone = phoneIdx !== undefined ? values[phoneIdx]?.trim() : '';
        const businessEmail = csvEmail || `${businessName.toLowerCase().replace(/[^a-z0-9]/g, '')}@imported.local`;
        const businessPhone = csvPhone || null;
        
        try {
          // Build approvals array from CSV columns
          const additionalApprovals: any[] = [];
          
          // Best/Primary offer
          const bestLender = values[headerMap['best lender']]?.trim();
          const bestAmount = values[headerMap['best funding amount']]?.trim();
          const bestFactorRate = values[headerMap['best factor rate']]?.trim();
          const bestTerm = values[headerMap['best term']]?.trim();
          const bestPaymentFreq = values[headerMap['best payment freq']]?.trim()?.toLowerCase() || 'weekly';
          const bestCommission = values[headerMap['best commission']]?.trim();
          const bestDate = values[headerMap['best date']]?.trim();
          
          if (bestLender && bestAmount) {
            additionalApprovals.push({
              id: crypto.randomUUID(),
              lender: bestLender,
              advanceAmount: parseAmount(bestAmount),
              term: bestTerm || '',
              paymentFrequency: mapPaymentFrequency(bestPaymentFreq),
              factorRate: bestFactorRate || '',
              totalPayback: '',
              netAfterFees: '',
              notes: bestCommission ? `Commission: ${bestCommission}` : '',
              approvalDate: parseDate(bestDate),
              isPrimary: true,
              createdAt: new Date().toISOString(),
            });
          }
          
          // Additional lenders (2-5)
          for (let lenderNum = 2; lenderNum <= 5; lenderNum++) {
            const lenderName = values[headerMap[`lender ${lenderNum}`]]?.trim();
            const amount = values[headerMap[`funding amount ${lenderNum}`]]?.trim();
            const factorRate = values[headerMap[`factor rate ${lenderNum}`]]?.trim();
            const commission = values[headerMap[`commission ${lenderNum}`]]?.trim();
            
            if (lenderName && amount) {
              additionalApprovals.push({
                id: crypto.randomUUID(),
                lender: lenderName,
                advanceAmount: parseAmount(amount),
                term: '',
                paymentFrequency: 'weekly',
                factorRate: factorRate || '',
                totalPayback: '',
                netAfterFees: '',
                notes: commission ? `Commission: ${commission}` : '',
                approvalDate: new Date().toISOString(),
                isPrimary: false,
                createdAt: new Date().toISOString(),
              });
            }
          }
          
          // Build decline reasons from CSV
          const declineReasons: string[] = [];
          for (let declineNum = 1; declineNum <= 3; declineNum++) {
            const declinedLender = values[headerMap[`declined lender ${declineNum}`]]?.trim();
            const declineReason = values[headerMap[`decline reason ${declineNum}`]]?.trim();
            if (declinedLender && declineReason) {
              declineReasons.push(`${declinedLender}: ${declineReason}`);
            }
          }
          
          // Determine status and create decision
          const status = isApproved && additionalApprovals.length > 0 ? 'approved' : 'declined';
          const primaryApproval = additionalApprovals.find(a => a.isPrimary);
          
          await storage.createOrUpdateBusinessUnderwritingDecision({
            businessEmail,
            businessName,
            businessPhone,
            status,
            advanceAmount: primaryApproval?.advanceAmount || null,
            term: primaryApproval?.term || null,
            paymentFrequency: primaryApproval?.paymentFrequency || null,
            factorRate: primaryApproval?.factorRate || null,
            totalPayback: null,
            netAfterFees: null,
            lender: primaryApproval?.lender || null,
            notes: primaryApproval?.notes || null,
            approvalDate: primaryApproval?.approvalDate ? new Date(primaryApproval.approvalDate) : new Date(),
            declineReason: status === 'declined' ? declineReasons.join('; ') : null,
            additionalApprovals: additionalApprovals.length > 0 ? additionalApprovals : null,
            reviewedBy: reviewerEmail,
          });
          
          results.push({ businessName, status: 'success' });
        } catch (rowError: any) {
          results.push({ businessName, status: 'error', error: rowError.message });
        }
      }
      
      const successCount = results.filter(r => r.status === 'success').length;
      const errorCount = results.filter(r => r.status === 'error').length;
      
      console.log(`[BULK IMPORT] ${reviewerEmail} imported ${successCount} approvals, ${errorCount} errors`);
      
      res.json({
        success: true,
        imported: successCount,
        errors: errorCount,
        results,
      });
    } catch (error: any) {
      console.error("Error bulk importing approvals:", error);
      res.status(500).json({ error: error.message || "Failed to import approvals" });
    }
  });

  // Funded deals CSV bulk import
  app.post("/api/underwriting-decisions/funded-bulk-import", async (req, res) => {
    if (!req.session.user?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }
    if (req.session.user.role !== 'underwriting' && req.session.user.role !== 'admin') {
      return res.status(403).json({ error: "Only underwriting team or admin can bulk import" });
    }

    const { csvData } = req.body;
    if (!csvData || typeof csvData !== 'string') {
      return res.status(400).json({ error: "CSV data is required" });
    }

    try {
      const reviewerEmail = req.session.user.agentEmail || 'admin';
      const lines = csvData.split('\n').map((l: string) => l.trim()).filter((l: string) => l);
      if (lines.length < 2) {
        return res.status(400).json({ error: "CSV must have a header row and at least one data row" });
      }

      const headers = parseCSVLine(lines[0]);
      const headerMap: Record<string, number> = {};
      headers.forEach((h: string, i: number) => { headerMap[h.toLowerCase().trim()] = i; });

      const businessNameIdx = headerMap['business name'];
      const businessEmailIdx = headerMap['business email'] ?? headerMap['email'];

      if (businessNameIdx === undefined) {
        return res.status(400).json({ error: "CSV must have a 'Business Name' column" });
      }
      if (businessEmailIdx === undefined) {
        return res.status(400).json({ error: "CSV must have a 'Business Email' column" });
      }

      const results: { businessName: string; status: string; error?: string }[] = [];

      for (let i = 1; i < lines.length; i++) {
        const values = parseCSVLine(lines[i]);
        const businessName = values[businessNameIdx]?.trim();
        if (!businessName) continue;

        const csvEmail = values[businessEmailIdx]?.trim();
        const businessEmail = csvEmail || `${businessName.toLowerCase().replace(/[^a-z0-9]/g, '')}@imported.local`;

        const lender = values[headerMap['lender']]?.trim() || '';
        const advanceAmount = parseAmount(values[headerMap['advance amount']]?.trim() || '');
        const term = values[headerMap['term']]?.trim() || '';
        const paymentFrequency = mapPaymentFrequency(values[headerMap['payment frequency']]?.trim()?.toLowerCase() || 'weekly');
        const factorRate = values[headerMap['factor rate']]?.trim() || '';
        const maxUpsell = parseAmount(values[headerMap['max upsell']]?.trim() || '');
        const totalPayback = parseAmount(values[headerMap['total payback']]?.trim() || '');
        const netAfterFees = parseAmount(values[headerMap['net after fees']]?.trim() || '');
        const notes = values[headerMap['notes']]?.trim() || '';
        const approvalDateRaw = values[headerMap['approval date']]?.trim() || '';
        const fundedDateRaw = values[headerMap['funded date']]?.trim() || '';
        const assignedRep = values[headerMap['assigned rep']]?.trim() || '';

        try {
          const fundedEntry = {
            id: crypto.randomUUID(),
            lender,
            advanceAmount,
            term,
            paymentFrequency,
            factorRate,
            maxUpsell,
            totalPayback,
            netAfterFees,
            notes,
            fundedDate: fundedDateRaw ? (parseDate(fundedDateRaw) || new Date().toISOString()) : new Date().toISOString(),
            assignedRep: assignedRep || null,
            createdAt: new Date().toISOString(),
          };

          await storage.createOrUpdateBusinessUnderwritingDecision({
            businessEmail,
            businessName,
            businessPhone: null,
            status: 'funded',
            advanceAmount: advanceAmount || null,
            term: term || null,
            paymentFrequency: paymentFrequency || null,
            factorRate: factorRate || null,
            maxUpsell: maxUpsell || null,
            totalPayback: totalPayback || null,
            netAfterFees: netAfterFees || null,
            lender: lender || null,
            notes: notes || null,
            approvalDate: approvalDateRaw ? new Date(parseDate(approvalDateRaw) || Date.now()) : new Date(),
            fundedDate: fundedDateRaw ? new Date(parseDate(fundedDateRaw) || Date.now()) : new Date(),
            assignedRep: assignedRep || null,
            additionalFundings: [fundedEntry],
            reviewedBy: reviewerEmail,
          });

          results.push({ businessName, status: 'success' });
        } catch (rowError: any) {
          results.push({ businessName, status: 'error', error: rowError.message });
        }
      }

      const successCount = results.filter(r => r.status === 'success').length;
      const errorCount = results.filter(r => r.status === 'error').length;
      console.log(`[FUNDED IMPORT] ${reviewerEmail} imported ${successCount} funded deals, ${errorCount} errors`);

      res.json({ success: true, imported: successCount, errors: errorCount, results });
    } catch (error: any) {
      console.error("Error bulk importing funded deals:", error);
      res.status(500).json({ error: error.message || "Failed to import funded deals" });
    }
  });
  
  // Helper functions for CSV parsing
  function parseCSVLine(line: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    result.push(current.trim());
    return result;
  }
  
  function parseAmount(value: string): string {
    if (!value) return '';
    // Remove currency symbols, commas, and parse number
    const num = parseFloat(value.replace(/[$,]/g, ''));
    return isNaN(num) ? '' : num.toString();
  }
  
  function parseDate(value: string): string {
    if (!value) return new Date().toISOString();
    try {
      const date = new Date(value);
      return isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
    } catch {
      return new Date().toISOString();
    }
  }
  
  function mapPaymentFrequency(freq: string): string {
    const f = freq.toLowerCase();
    if (f.includes('daily')) return 'daily';
    if (f.includes('monthly')) return 'monthly';
    if (f.includes('biweekly') || f.includes('bi-weekly')) return 'biweekly';
    return 'weekly';
  }

  // ═══════════════════════════════════════════════════════════════
  // MERCHANT POSITIONS — renewal pipeline tracking
  // ═══════════════════════════════════════════════════════════════

  // GET /api/merchant-positions — list all positions with optional filters
  app.get("/api/merchant-positions", async (req, res) => {
    try {
      const tier = req.query.tier ? String(req.query.tier) : null;
      const status = req.query.status ? String(req.query.status) : null;
      const outreachStatus = req.query.outreachStatus ? String(req.query.outreachStatus) : null;
      const result = await db.execute(sql`
        SELECT * FROM merchant_positions
        WHERE (${tier}::text IS NULL OR tier = ${tier})
          AND (${status}::text IS NULL OR status = ${status})
          AND (${outreachStatus}::text IS NULL OR outreach_status = ${outreachStatus})
        ORDER BY CASE tier WHEN 'HOT' THEN 1 WHEN 'WARM' THEN 2 WHEN 'SOON' THEN 3 WHEN 'EARLY' THEN 4 ELSE 5 END,
                 percent_complete DESC NULLS LAST
      `);
      res.json({ positions: result.rows });
    } catch (error) {
      console.error("[MERCHANT-POSITIONS] Error fetching:", error);
      res.status(500).json({ error: "Failed to fetch positions" });
    }
  });

  // GET /api/merchant-positions/summary — grouped by merchant with UW data + application info
  app.get("/api/merchant-positions/summary", async (req, res) => {
    try {
      const posResult = await db.execute(sql`
        SELECT mp.*, bud.status as uw_decision_status, bud.lender as uw_decision_lender,
               bud.advance_amount as uw_decision_amount, bud.funded_date as uw_decision_funded_date,
               bud.approval_date as uw_decision_approval_date, bud.decline_reason as uw_decision_decline_reason,
               bud.additional_approvals as uw_additional_approvals, bud.additional_fundings as uw_additional_fundings,
               bud.additional_declines as uw_additional_declines,
               bud.business_phone as uw_business_phone,
               la.full_name as app_owner_name, la.phone as app_phone,
               la.industry as app_industry, la.monthly_revenue as app_monthly_revenue,
               la.time_in_business as app_time_in_business
        FROM merchant_positions mp
        LEFT JOIN business_underwriting_decisions bud ON LOWER(mp.business_email) = LOWER(bud.business_email)
        LEFT JOIN LATERAL (
          SELECT full_name, phone, industry, monthly_revenue, time_in_business
          FROM loan_applications WHERE LOWER(email) = LOWER(mp.business_email)
          ORDER BY created_at DESC LIMIT 1
        ) la ON true
        WHERE mp.status = 'active'
        ORDER BY CASE mp.tier WHEN 'HOT' THEN 1 WHEN 'WARM' THEN 2 WHEN 'SOON' THEN 3 WHEN 'EARLY' THEN 4 ELSE 5 END,
                 mp.percent_complete DESC NULLS LAST
      `);
      res.json({ positions: posResult.rows });
    } catch (error) {
      console.error("[MERCHANT-POSITIONS] Error fetching summary:", error);
      res.status(500).json({ error: "Failed to fetch position summary" });
    }
  });

  // GET /api/merchant-positions/counts — tier counts for stat cards
  app.get("/api/merchant-positions/counts", async (_req, res) => {
    try {
      const result = await db.execute(sql`
        SELECT tier, COUNT(DISTINCT business_email) as merchant_count, COUNT(*) as position_count
        FROM merchant_positions WHERE status = 'active'
        GROUP BY tier
      `);
      const counts: Record<string, { merchants: number; positions: number }> = {};
      for (const row of result.rows as any[]) {
        counts[row.tier || 'UNKNOWN'] = { merchants: Number(row.merchant_count), positions: Number(row.position_count) };
      }
      res.json(counts);
    } catch (error) {
      console.error("[MERCHANT-POSITIONS] Error fetching counts:", error);
      res.status(500).json({ error: "Failed to fetch counts" });
    }
  });

  // POST /api/merchant-positions — create a new position
  app.post("/api/merchant-positions", async (req, res) => {
    try {
      const pos = req.body;
      const result = await db.execute(sql`
        INSERT INTO merchant_positions (
          business_email, business_name, funder_name, product_type,
          payment_amount, payment_amount_display, payment_frequency,
          estimated_funding_amount, estimated_total_payback, estimated_remaining_balance,
          percent_complete, first_payment_seen, last_payment_seen,
          estimated_start_date, estimated_payoff_date, renewal_eligible_date,
          funding_deposit_amount, funding_deposit_date,
          tier, outreach_status, outreach_notes, anomalies, source, status,
          uw_status, uw_lender, uw_amount, uw_approval_count, uw_decline_count, uw_funded_date
        ) VALUES (
          ${pos.businessEmail}, ${pos.businessName}, ${pos.funderName}, ${pos.productType || null},
          ${pos.paymentAmount || null}, ${pos.paymentAmountDisplay || null}, ${pos.paymentFrequency || null},
          ${pos.estimatedFundingAmount || null}, ${pos.estimatedTotalPayback || null}, ${pos.estimatedRemainingBalance || null},
          ${pos.percentComplete || null}, ${pos.firstPaymentSeen || null}, ${pos.lastPaymentSeen || null},
          ${pos.estimatedStartDate || null}, ${pos.estimatedPayoffDate || null}, ${pos.renewalEligibleDate || null},
          ${pos.fundingDepositAmount || null}, ${pos.fundingDepositDate || null},
          ${pos.tier || null}, ${pos.outreachStatus || 'not_contacted'}, ${pos.outreachNotes || null},
          ${pos.anomalies || null}, ${pos.source || 'ai_extraction'}, ${pos.status || 'active'},
          ${pos.uwStatus || null}, ${pos.uwLender || null}, ${pos.uwAmount || null},
          ${pos.uwApprovalCount || 0}, ${pos.uwDeclineCount || 0}, ${pos.uwFundedDate || null}
        ) RETURNING *
      `);
      res.json(result.rows[0]);
    } catch (error) {
      console.error("[MERCHANT-POSITIONS] Error creating:", error);
      res.status(500).json({ error: "Failed to create position" });
    }
  });

  // POST /api/merchant-positions/bulk — bulk insert positions
  app.post("/api/merchant-positions/bulk", async (req, res) => {
    try {
      const { positions } = req.body;
      if (!Array.isArray(positions) || positions.length === 0) {
        return res.status(400).json({ error: "positions array required" });
      }
      let inserted = 0;
      for (const pos of positions) {
        await db.execute(sql`
          INSERT INTO merchant_positions (
            business_email, business_name, funder_name, product_type,
            payment_amount, payment_amount_display, payment_frequency,
            estimated_funding_amount, estimated_total_payback, estimated_remaining_balance,
            percent_complete, first_payment_seen, last_payment_seen,
            estimated_start_date, estimated_payoff_date, renewal_eligible_date,
            funding_deposit_amount, funding_deposit_date,
            tier, outreach_status, outreach_notes, anomalies, source, status,
            uw_status, uw_lender, uw_amount, uw_approval_count, uw_decline_count, uw_funded_date
          ) VALUES (
            ${pos.businessEmail}, ${pos.businessName || null}, ${pos.funderName}, ${pos.productType || null},
            ${pos.paymentAmount || null}, ${pos.paymentAmountDisplay || null}, ${pos.paymentFrequency || null},
            ${pos.estimatedFundingAmount || null}, ${pos.estimatedTotalPayback || null}, ${pos.estimatedRemainingBalance || null},
            ${pos.percentComplete || null}, ${pos.firstPaymentSeen || null}, ${pos.lastPaymentSeen || null},
            ${pos.estimatedStartDate || null}, ${pos.estimatedPayoffDate || null}, ${pos.renewalEligibleDate || null},
            ${pos.fundingDepositAmount || null}, ${pos.fundingDepositDate || null},
            ${pos.tier || null}, ${pos.outreachStatus || 'not_contacted'}, ${pos.outreachNotes || null},
            ${pos.anomalies || null}, ${pos.source || 'ai_extraction'}, ${pos.status || 'active'},
            ${pos.uwStatus || null}, ${pos.uwLender || null}, ${pos.uwAmount || null},
            ${pos.uwApprovalCount || 0}, ${pos.uwDeclineCount || 0}, ${pos.uwFundedDate || null}
          )
        `);
        inserted++;
      }
      res.json({ inserted, total: positions.length });
    } catch (error) {
      console.error("[MERCHANT-POSITIONS] Error bulk insert:", error);
      res.status(500).json({ error: "Failed to bulk insert positions" });
    }
  });

  // PATCH /api/merchant-positions/:id — update a position (outreach status, notes, etc.)
  app.patch("/api/merchant-positions/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const u = req.body;
      const result = await db.execute(sql`
        UPDATE merchant_positions SET
          tier = COALESCE(${u.tier ?? null}, tier),
          outreach_status = COALESCE(${u.outreachStatus ?? null}, outreach_status),
          outreach_notes = COALESCE(${u.outreachNotes ?? null}, outreach_notes),
          status = COALESCE(${u.status ?? null}, status),
          percent_complete = COALESCE(${u.percentComplete ?? null}, percent_complete),
          estimated_payoff_date = COALESCE(${u.estimatedPayoffDate ?? null}, estimated_payoff_date),
          renewal_eligible_date = COALESCE(${u.renewalEligibleDate ?? null}, renewal_eligible_date),
          anomalies = COALESCE(${u.anomalies ?? null}, anomalies),
          uw_status = COALESCE(${u.uwStatus ?? null}, uw_status),
          uw_lender = COALESCE(${u.uwLender ?? null}, uw_lender),
          uw_amount = COALESCE(${u.uwAmount ?? null}, uw_amount),
          uw_approval_count = COALESCE(${u.uwApprovalCount ?? null}, uw_approval_count),
          uw_decline_count = COALESCE(${u.uwDeclineCount ?? null}, uw_decline_count),
          uw_funded_date = COALESCE(${u.uwFundedDate ?? null}, uw_funded_date),
          updated_at = NOW()
        WHERE id = ${id} RETURNING *
      `);
      if (!result.rows.length) return res.status(404).json({ error: "Position not found" });
      res.json(result.rows[0]);
    } catch (error) {
      console.error("[MERCHANT-POSITIONS] Error updating:", error);
      res.status(500).json({ error: "Failed to update position" });
    }
  });

  // DELETE /api/merchant-positions/:id — remove a position
  app.delete("/api/merchant-positions/:id", async (req, res) => {
    try {
      const { id } = req.params;
      await db.execute(sql`DELETE FROM merchant_positions WHERE id = ${id}`);
      res.json({ success: true });
    } catch (error) {
      console.error("[MERCHANT-POSITIONS] Error deleting:", error);
      res.status(500).json({ error: "Failed to delete position" });
    }
  });

  // Accept Offer click tracking — fires GHL webhook then redirects to /congratulations
  async function notifyOfferAccepted(decision: any, details: Record<string, string | null | undefined> = {}) {
    if (!decision) return;

    const recipients = new Set([
      "marketing@todaycapitalgroup.com",
      "admin@todaycapitalgroup.com",
    ]);

    // assignedRep is normally stored as the rep's name on the underwriting
    // decision.  Also support an email stored directly in that field.
    const repNames = [decision.assignedRep, decision.assignedRep2]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
    for (const rep of repNames) {
      const directEmail = rep.includes("@") ? rep.trim() : null;
      const mappedEmail = REP_DIRECTORY[rep] || null;
      if (directEmail || mappedEmail) recipients.add((directEmail || mappedEmail!).toLowerCase());
    }

    // Some older decisions do not have assignedRep populated.  Fall back to
    // the sales/agent email attached to the original application.
    if (decision.businessEmail) {
      try {
        const application = await storage.getAnyLoanApplicationByEmail(decision.businessEmail);
        if (application?.agentEmail) recipients.add(application.agentEmail.toLowerCase().trim());
      } catch (error) {
        console.error("[ACCEPT OFFER] Could not look up application sales rep:", error);
      }
    }

    const detailRows = Object.entries({
      "Business": decision.businessName || "—",
      "Merchant Email": decision.businessEmail || "—",
      "Phone": decision.businessPhone || "—",
      "Lender": decision.lender || "—",
      "Approved Amount": decision.advanceAmount ? `$${decision.advanceAmount}` : "—",
      "Assigned Rep": repNames.join(", ") || "—",
      ...details,
    })
      .map(([label, value]) => `<tr><td style="padding:7px 12px;font-weight:600;color:#555">${label}</td><td style="padding:7px 12px">${value || "—"}</td></tr>`)
      .join("");

    const subject = `Offer Accepted — ${decision.businessName || decision.businessEmail || "Merchant"}`;
    const html = `
      <div style="font-family:Arial,sans-serif;color:#222">
        <h2 style="color:#0f766e">Offer Accepted</h2>
        <p>A merchant clicked “Accept Offer” on their approved offer letter.</p>
        <table style="border-collapse:collapse;border:1px solid #ddd">${detailRows}</table>
      </div>
    `;

    const to = Array.from(recipients).join(", ");
    const sent = await gmailService.sendEmail(to, subject, html);
    if (!sent) {
      console.error(`[ACCEPT OFFER] Notification email failed for ${to}`);
    } else {
      console.log(`[ACCEPT OFFER] Notification email sent to ${to}`);
    }
  }

  app.get("/api/approval-letter/:slug/accept", async (req, res) => {
    const { slug } = req.params;

    try {
      const decision = await storage.getBusinessUnderwritingDecisionBySlug(slug);

      // Build /congratulations redirect params from whatever we have
      const params = new URLSearchParams();
      if (decision?.businessEmail) params.set("email", decision.businessEmail);
      if (decision?.businessName) params.set("businessName", decision.businessName);
      if (decision?.businessPhone) params.set("phone", decision.businessPhone);
      if (decision?.ghlOpportunityId) params.set("opportunityId", decision.ghlOpportunityId);

      // Fire GHL webhook in background (don't block the redirect)
      if (decision) {
        const GHL_ACCEPT_WEBHOOK_URL =
          "https://services.leadconnectorhq.com/hooks/n778xwOps9t8Q34eRPfM/webhook-trigger/52ad2d89-b393-4f32-a102-5b835e7f6db7";

        const payload = {
          event: "accept_offer_clicked",
          email: decision.businessEmail,
          businessName: decision.businessName || null,
          phone: decision.businessPhone || null,
          lender: decision.lender || null,
          advanceAmount: decision.advanceAmount ? String(decision.advanceAmount) : null,
          term: decision.term || null,
          ghlOpportunityId: decision.ghlOpportunityId || null,
          slug,
          clickedAt: new Date().toISOString(),
        };

        console.log(`[ACCEPT OFFER] Firing GHL webhook for ${decision.businessEmail}`, payload);

        fetch(GHL_ACCEPT_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
          .then((r) => {
            if (!r.ok) r.text().then((t) => console.error(`[ACCEPT OFFER] GHL webhook failed (${r.status}): ${t}`));
            else console.log(`[ACCEPT OFFER] GHL webhook sent for ${decision.businessEmail}`);
          })
          .catch((e) => console.error("[ACCEPT OFFER] GHL webhook error:", e));

        // Await this before redirecting so the short-lived public request does
        // not terminate before Gmail receives the notification.
        await notifyOfferAccepted(decision, { "Offer URL": `/approval-letter/${slug}` });
      }

      res.redirect(302, `/congratulations${params.toString() ? `?${params.toString()}` : ""}`);
    } catch (error) {
      console.error("[ACCEPT OFFER] Error:", error);
      res.redirect(302, "/congratulations");
    }
  });

  // Get approval letter by slug (public route for approved businesses)
  app.get("/api/approval-letter/:slug", async (req, res) => {
    const { slug } = req.params;
    
    try {
      const decision = await storage.getBusinessUnderwritingDecisionBySlug(slug);
      
      if (!decision) {
        return res.status(404).json({ error: "Approval letter not found" });
      }
      
      if (decision.status !== 'approved' && decision.status !== 'funded') {
        return res.status(404).json({ error: "No valid approval found" });
      }
      
      // Return approval details for the letter page (includes all approvals)
      res.json({
        businessName: decision.businessName,
        advanceAmount: decision.advanceAmount,
        term: decision.term,
        paymentFrequency: decision.paymentFrequency,
        factorRate: decision.factorRate,
        totalPayback: decision.totalPayback,
        netAfterFees: decision.netAfterFees,
        lender: decision.lender,
        approvalDate: decision.approvalDate,
        notes: decision.notes,
        additionalApprovals: decision.additionalApprovals,
      });
    } catch (error) {
      console.error("Error fetching approval letter:", error);
      res.status(500).json({ error: "Failed to fetch approval letter" });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // OFFER EXPLORER — interactive pricing page for in-house (Today Capital Group) offers.
  // Any approval entry whose lender is Today Capital Group automatically gets
  // /offer/:slug where the merchant can slide the draw amount and see payments.
  // ═══════════════════════════════════════════════════════════════

  const isTcgLender = (lender: string | null | undefined) =>
    !!lender && /today\s*capital|\btcg\b/i.test(lender);

  // Public: offer terms for the explorer page (TCG-lender approvals only)
  app.get("/api/offer/:slug", async (req, res) => {
    try {
      const decision = await storage.getBusinessUnderwritingDecisionBySlug(req.params.slug);
      if (!decision || (decision.status !== 'approved' && decision.status !== 'funded')) {
        return res.status(404).json({ error: "Offer not found" });
      }

      const entries: any[] = Array.isArray(decision.additionalApprovals) ? decision.additionalApprovals as any[] : [];
      // Find the primary approval entry (any lender) to inherit early payoff data if needed
      const primaryEntry: any = entries.find((a) => a.isPrimary) || entries[0] || null;
      let offers = entries
        .filter((a) => isTcgLender(a?.lender))
        .sort((a, b) => (b.isPrimary ? 1 : 0) - (a.isPrimary ? 1 : 0))
        .map((a) => {
          // Inherit early payoff data from the primary entry when this TCG offer doesn't have it
          const earlyPayoffEnabled = a.earlyPayoffEnabled || (primaryEntry && !isTcgLender(primaryEntry.lender) ? primaryEntry.earlyPayoffEnabled : false) || false;
          const earlyPayoffMode = a.earlyPayoffMode || (primaryEntry && !isTcgLender(primaryEntry.lender) ? primaryEntry.earlyPayoffMode : null) || 'amounts';
          const earlyPayoffAmounts = Array.isArray(a.earlyPayoffAmounts) && a.earlyPayoffAmounts.length > 0
            ? a.earlyPayoffAmounts
            : (primaryEntry && !isTcgLender(primaryEntry.lender) && Array.isArray(primaryEntry.earlyPayoffAmounts) ? primaryEntry.earlyPayoffAmounts : null);
          const earlyPayoffRates = Array.isArray(a.earlyPayoffRates) && a.earlyPayoffRates.length > 0
            ? a.earlyPayoffRates
            : (primaryEntry && !isTcgLender(primaryEntry.lender) && Array.isArray(primaryEntry.earlyPayoffRates) ? primaryEntry.earlyPayoffRates : null);
          return {
            advanceAmount: a.advanceAmount || null,
            term: a.term || null,
            paymentFrequency: a.paymentFrequency || null,
            factorRate: a.factorRate || null,
            totalPayback: a.totalPayback || null,
            netAfterFees: a.netAfterFees || null,
            approvalDate: a.approvalDate || null,
            notes: a.notes || null,
            minimumDraw: a.minimumDraw != null && a.minimumDraw !== "" ? a.minimumDraw : null,
            numberOfPayments: a.numberOfPayments || null,
            lenderName: a.lenderName || null,
            earlyPayoffEnabled,
            earlyPayoffMode,
            earlyPayoffAmounts,
            earlyPayoffRates,
          };
        });

      // Legacy top-level approval fields
      if (offers.length === 0 && isTcgLender(decision.lender)) {
        offers = [{
          advanceAmount: decision.advanceAmount ? String(decision.advanceAmount) : null,
          term: decision.term || null,
          paymentFrequency: decision.paymentFrequency || null,
          factorRate: decision.factorRate ? String(decision.factorRate) : null,
          totalPayback: decision.totalPayback ? String(decision.totalPayback) : null,
          netAfterFees: decision.netAfterFees ? String(decision.netAfterFees) : null,
          approvalDate: decision.approvalDate ? String(decision.approvalDate) : null,
          notes: decision.notes || null,
          minimumDraw: null,
          numberOfPayments: null,
          lenderName: decision.lender || null,
          earlyPayoffEnabled: false,
          earlyPayoffMode: 'amounts',
          earlyPayoffAmounts: null,
          earlyPayoffRates: null,
        }];
      }

      if (offers.length === 0) {
        return res.status(404).json({ error: "No Today Capital Group offer on this approval" });
      }

      res.json({ businessName: decision.businessName, offers });
    } catch (error) {
      console.error("[OFFER EXPLORER] fetch error:", error);
      res.status(500).json({ error: "Failed to fetch offer" });
    }
  });

  // Accept from the explorer — carries the merchant's chosen draw amount into the GHL webhook
  app.get("/api/offer/:slug/accept", async (req, res) => {
    const { slug } = req.params;
    try {
      const decision = await storage.getBusinessUnderwritingDecisionBySlug(slug);

      const params = new URLSearchParams();
      if (decision?.businessEmail) params.set("email", decision.businessEmail);
      if (decision?.businessName) params.set("businessName", decision.businessName);
      if (decision?.businessPhone) params.set("phone", decision.businessPhone);
      if (decision?.ghlOpportunityId) params.set("opportunityId", decision.ghlOpportunityId);

      if (decision) {
        const GHL_ACCEPT_WEBHOOK_URL =
          "https://services.leadconnectorhq.com/hooks/n778xwOps9t8Q34eRPfM/webhook-trigger/52ad2d89-b393-4f32-a102-5b835e7f6db7";
        const payload = {
          event: "offer_explorer_accept_clicked",
          email: decision.businessEmail,
          businessName: decision.businessName || null,
          phone: decision.businessPhone || null,
          lender: "Today Capital Group",
          approvedAmount: req.query.approved ? String(req.query.approved) : null,
          selectedDrawAmount: req.query.amount ? String(req.query.amount) : null,
          estimatedPayment: req.query.payment ? String(req.query.payment) : null,
          estimatedPayback: req.query.payback ? String(req.query.payback) : null,
          term: req.query.term ? String(req.query.term) : null,
          factorRate: req.query.factor ? String(req.query.factor) : null,
          ghlOpportunityId: decision.ghlOpportunityId || null,
          slug,
          clickedAt: new Date().toISOString(),
        };
        console.log(`[OFFER EXPLORER] Accept clicked for ${decision.businessEmail}`, payload);
        fetch(GHL_ACCEPT_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }).then((r) => {
          if (!r.ok) r.text().then((t) => console.error(`[OFFER EXPLORER] GHL webhook failed (${r.status}): ${t}`));
        }).catch((e) => console.error("[OFFER EXPLORER] GHL webhook error:", e));

        // Alert the team with the merchant's selected structure
        sendAdminMerchantAlert({
          title: "Offer Explorer: Merchant Accepted a TCG Offer",
          event: "offer_explorer_accept",
          merchantEmail: decision.businessEmail,
          businessName: decision.businessName || null,
          details: {
            "Approved Amount": req.query.approved ? `$${req.query.approved}` : null,
            "Selected Draw": req.query.amount ? `$${req.query.amount}` : null,
            "Estimated Payment": req.query.payment ? `$${req.query.payment}` : null,
            "Total Payback": req.query.payback ? `$${req.query.payback}` : null,
            "Term": req.query.term ? String(req.query.term) : null,
            "Factor Rate": req.query.factor ? String(req.query.factor) : null,
            "Next Step": "Reach out to finalize docs",
          },
        }).catch(() => {});

        await notifyOfferAccepted(decision, {
          "Approved Amount": req.query.approved ? `$${req.query.approved}` : null,
          "Selected Draw": req.query.amount ? `$${req.query.amount}` : null,
          "Estimated Payment": req.query.payment ? `$${req.query.payment}` : null,
          "Total Payback": req.query.payback ? `$${req.query.payback}` : null,
          "Term": req.query.term ? String(req.query.term) : null,
          "Factor Rate": req.query.factor ? String(req.query.factor) : null,
          "Offer URL": `/offer/${slug}`,
        });
      }

      res.redirect(302, `/congratulations${params.toString() ? `?${params.toString()}` : ""}`);
    } catch (error) {
      console.error("[OFFER EXPLORER] accept error:", error);
      res.redirect(302, "/congratulations");
    }
  });

  // 2b. Get combined view URL for all statements by email (for dashboard "View All" button)
  app.get("/api/bank-statements/view-url", async (req, res) => {
    if (!req.session.user?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const email = req.query.email as string;
    if (!email) {
      return res.status(400).json({ error: "Email parameter required" });
    }

    try {
      // Role-based access check: admin can view all, agents only their accessible uploads
      if (req.session.user.role === 'agent' && req.session.user.agentEmail) {
        const agentUploads = await storage.getBankStatementUploadsByAgentEmail(req.session.user.agentEmail);
        const hasAccess = agentUploads.some(u => u.email === email);
        if (!hasAccess) {
          return res.status(403).json({ error: "Access denied to this email's statements" });
        }
      } else if (req.session.user.role !== 'admin') {
        return res.status(403).json({ error: "Access denied" });
      }

      const baseUrl = process.env.REPLIT_DOMAINS 
        ? `https://${process.env.REPLIT_DOMAINS.split(',')[0]}`
        : `${req.protocol}://${req.get('host')}`;
      
      const combinedViewToken = generateCombinedViewToken(email);
      const viewAllUrl = `${baseUrl}/api/bank-statements/public/view-all/${combinedViewToken}`;
      
      res.json({ url: viewAllUrl });
    } catch (error) {
      console.error("Error generating view URL:", error);
      res.status(500).json({ error: "Failed to generate view URL" });
    }
  });

  // 3. Download bank statement PDF - role-based access control
  app.get("/api/bank-statements/download/:id", async (req, res) => {
    if (!req.session.user?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }

    try {
      const upload = await storage.getBankStatementUpload(req.params.id);
      if (!upload) {
        return res.status(404).json({ error: "Upload not found" });
      }

      // Role-based access check for agents
      if (req.session.user.role === 'agent' && req.session.user.agentEmail) {
        // Verify this agent has access to this bank statement
        const agentUploads = await storage.getBankStatementUploadsByAgentEmail(req.session.user.agentEmail);
        const hasAccess = agentUploads.some(u => u.id === upload.id);
        if (!hasAccess) {
          console.log(`[BANK STATEMENTS] Agent ${req.session.user.agentName} denied access to upload ${upload.id}`);
          return res.status(403).json({ error: "Access denied - this statement is not from your applications" });
        }
      } else if (req.session.user.role !== 'admin') {
        // Only admins and agents can download
        return res.status(403).json({ error: "Access denied" });
      }

      // Check if file is in Object Storage (path contains "bank-statements/")
      if (upload.storedFileName.includes("bank-statements/")) {
        // File is in Object Storage - downloadFile handles all headers
        try {
          await objectStorage.downloadFile(upload.storedFileName, res, upload.originalFileName);
          return;
        } catch (objError) {
          console.error("[DOWNLOAD] Object Storage download failed:", objError);
          if (!res.headersSent) {
            return res.status(404).json({ error: "File not found in storage" });
          }
          return;
        }
      }

      // Fallback: check local disk
      const filePath = path.join(UPLOAD_DIR, upload.storedFileName);
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: "File not found on disk" });
      }

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${upload.originalFileName}"`);
      res.sendFile(filePath);
    } catch (error) {
      console.error("Error downloading bank statement:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to download file" });
      }
    }
  });

  // 3a. View bank statement PDF in browser (authenticated - for dashboard)
  app.get("/api/bank-statements/view/:id", async (req, res) => {
    if (!req.session.user?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }

    try {
      const upload = await storage.getBankStatementUpload(req.params.id);
      if (!upload) {
        return res.status(404).json({ error: "Upload not found" });
      }

      // Role-based access check for agents
      if (req.session.user.role === 'agent' && req.session.user.agentEmail) {
        // Verify this agent has access to this bank statement
        const agentUploads = await storage.getBankStatementUploadsByAgentEmail(req.session.user.agentEmail);
        const hasAccess = agentUploads.some(u => u.id === upload.id);
        if (!hasAccess) {
          console.log(`[BANK STATEMENTS] Agent ${req.session.user.agentName} denied view access to upload ${upload.id}`);
          return res.status(403).json({ error: "Access denied - this statement is not from your applications" });
        }
      } else if (req.session.user.role !== 'admin') {
        // Only admins and agents can view
        return res.status(403).json({ error: "Access denied" });
      }

      // Check if file is in Object Storage (path contains "bank-statements/")
      if (upload.storedFileName.includes("bank-statements/")) {
        // File is in Object Storage - viewFile handles all headers (uses inline disposition)
        try {
          await objectStorage.viewFile(upload.storedFileName, res, upload.originalFileName);
          return;
        } catch (objError) {
          console.error("[VIEW] Object Storage view failed:", objError);
          if (!res.headersSent) {
            return res.status(404).json({ error: "File not found in storage" });
          }
          return;
        }
      }

      // Fallback: check local disk
      const filePath = path.join(UPLOAD_DIR, upload.storedFileName);
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: "File not found on disk" });
      }

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="${upload.originalFileName}"`);
      res.sendFile(filePath);
    } catch (error) {
      console.error("Error viewing bank statement:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to view file" });
      }
    }
  });

  // 3b. Public view bank statement PDF via token (for GoHighLevel webhook links)
  // This endpoint does NOT require authentication - access is granted via secure token
  app.get("/api/bank-statements/public/view/:token", async (req, res) => {
    try {
      const { token } = req.params;

      if (!token || token.length !== 64) {
        return res.status(400).json({ error: "Invalid token format" });
      }

      const upload = await storage.getBankStatementUploadByViewToken(token);
      if (!upload) {
        return res.status(404).json({ error: "Statement not found or link expired" });
      }

      console.log(`[BANK STATEMENTS] Public view accessed for: ${upload.originalFileName} (${upload.email})`);
      console.log(`[PUBLIC VIEW] Storage path: ${upload.storedFileName}, Has prefix: ${upload.storedFileName?.includes('bank-statements/')}`);

      // Check if file is in Object Storage (path contains "bank-statements/")
      if (upload.storedFileName.includes("bank-statements/")) {
        // File is in Object Storage - viewFile handles all headers (uses inline disposition)
        try {
          await objectStorage.viewFile(upload.storedFileName, res, upload.originalFileName);
          return;
        } catch (objError) {
          console.error("[PUBLIC VIEW] Object Storage view failed:", objError);
          if (!res.headersSent) {
            return res.status(404).json({ error: "File not found in storage" });
          }
          return;
        }
      }

      // Fallback: check local disk
      const filePath = path.join(UPLOAD_DIR, upload.storedFileName);
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: "File not found on disk" });
      }

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="${upload.originalFileName}"`);
      // Allow embedding in iframes
      res.removeHeader("X-Frame-Options");
      res.setHeader("X-Frame-Options", "ALLOWALL");
      res.setHeader("Content-Security-Policy", "frame-ancestors *");
      res.sendFile(filePath);
    } catch (error) {
      console.error("Error viewing bank statement via public link:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to view file" });
      }
    }
  });

  // 3b2. Public DOWNLOAD bank statement PDF via token (forces browser download, no inline preview)
  app.get("/api/bank-statements/public/download/:token", async (req, res) => {
    try {
      const { token } = req.params;
      if (!token || token.length !== 64) {
        return res.status(400).json({ error: "Invalid token format" });
      }
      const upload = await storage.getBankStatementUploadByViewToken(token);
      if (!upload) {
        return res.status(404).json({ error: "Statement not found" });
      }

      let fileBuffer: Buffer;
      if (upload.storedFileName.includes("bank-statements/")) {
        fileBuffer = await objectStorage.getFileBuffer(upload.storedFileName);
      } else {
        const filePath = path.join(UPLOAD_DIR, upload.storedFileName);
        if (!fs.existsSync(filePath)) {
          return res.status(404).json({ error: "File not found on disk" });
        }
        fileBuffer = fs.readFileSync(filePath);
      }

      const filename = upload.originalFileName || "statement.pdf";
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Length", fileBuffer.length.toString());
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("Cache-Control", "private, max-age=3600");
      console.log(`[BANK STATEMENTS] Public download: ${filename} (${upload.email})`);
      res.end(fileBuffer);
    } catch (error) {
      console.error("Error downloading bank statement via public link:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to download file" });
      }
    }
  });

  // 3c. Combined view - all bank statements for an email in one scrollable page
  // Token format: base64(email):hmac_signature
  app.get("/api/bank-statements/public/view-all/:token", async (req, res) => {
    try {
      const { token } = req.params;

      // Parse the token (format: base64email.signature)
      const parts = token.split('.');
      if (parts.length !== 2) {
        return res.status(400).json({ error: "Invalid token format" });
      }

      const [encodedEmail, signature] = parts;

      // Decode email
      let email: string;
      try {
        email = Buffer.from(encodedEmail, 'base64url').toString('utf-8');
      } catch {
        return res.status(400).json({ error: "Invalid token encoding" });
      }

      // Verify signature using HMAC
      const secret = process.env.COMBINED_VIEW_SECRET || process.env.SESSION_SECRET || 'bank-statement-view-secret';
      const expectedSignature = require('crypto')
        .createHmac('sha256', secret)
        .update(email)
        .digest('hex')
        .substring(0, 32); // Use first 32 chars for shorter URLs

      if (signature !== expectedSignature) {
        return res.status(403).json({ error: "Invalid or expired link" });
      }

      // Get all statements for this email
      const statements = await storage.getBankStatementUploadsByEmail(email);

      if (statements.length === 0) {
        return res.status(404).send(`
          <!DOCTYPE html>
          <html>
          <head>
            <title>No Statements Found</title>
            <style>
              body { font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f5f5f5; }
              .message { text-align: center; padding: 40px; background: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            </style>
          </head>
          <body>
            <div class="message">
              <h2>No Bank Statements Found</h2>
              <p>No bank statements have been uploaded for this contact yet.</p>
            </div>
          </body>
          </html>
        `);
      }

      // Get business name from first statement or email
      const businessName = statements[0].businessName || email;

      console.log(`[BANK STATEMENTS] Combined view accessed for: ${email} (${statements.length} statements)`);
      
      // Debug: Log each statement's storage path (in single line for log visibility)
      const statementsWithTokens = statements.filter(s => s.viewToken);
      console.log(`[COMBINED VIEW DEBUG] Total: ${statements.length}, With tokens: ${statementsWithTokens.length}`);
      statements.forEach((stmt, i) => {
        const hasPrefix = stmt.storedFileName?.includes('bank-statements/');
        const hasToken = !!stmt.viewToken;
        console.log(`[COMBINED VIEW] #${i+1} file="${stmt.originalFileName}" storage="${stmt.storedFileName}" hasPrefix=${hasPrefix} hasToken=${hasToken}`);
      });

      // Generate HTML page with embedded PDFs using relative URLs
      // Relative URLs ensure iframes load from the same origin in both dev and production
      const statementsHtml = statements
        .filter(stmt => stmt.viewToken)
        .map((stmt, index) => `
          <div class="statement-container">
            <div class="statement-header">
              <span class="statement-number">${index + 1}</span>
              <div class="statement-info">
                <h3>${escapeHtml(stmt.originalFileName)}</h3>
                <p>Uploaded: ${stmt.createdAt ? new Date(stmt.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : 'Unknown'}</p>
              </div>
              <a href="/api/bank-statements/public/view/${stmt.viewToken}" target="_blank" class="view-link">Open PDF</a>
            </div>
            <div class="pdf-wrapper" id="wrapper-${index}">
              <div class="loading-indicator" id="loading-${index}">Loading PDF...</div>
              <object data="/api/bank-statements/public/view/${stmt.viewToken}" type="application/pdf" class="pdf-viewer" id="pdf-${index}">
                <p>Unable to display PDF. <a href="/api/bank-statements/public/view/${stmt.viewToken}" target="_blank">Click here to view</a></p>
              </object>
            </div>
          </div>
        `).join('');

      const html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Bank Statements - ${escapeHtml(businessName)}</title>
          <style>
            * { box-sizing: border-box; margin: 0; padding: 0; }
            body {
              font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              background: #1a1a2e;
              color: #eee;
              min-height: 100vh;
            }
            .header {
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              padding: 30px 20px;
              text-align: center;
              position: sticky;
              top: 0;
              z-index: 100;
              box-shadow: 0 4px 20px rgba(0,0,0,0.3);
            }
            .header h1 {
              font-size: 1.8rem;
              font-weight: 600;
              margin-bottom: 8px;
            }
            .header p {
              opacity: 0.9;
              font-size: 1rem;
            }
            .container {
              max-width: 1200px;
              margin: 0 auto;
              padding: 30px 20px;
            }
            .statement-container {
              background: #16213e;
              border-radius: 12px;
              margin-bottom: 30px;
              overflow: hidden;
              box-shadow: 0 4px 15px rgba(0,0,0,0.2);
            }
            .statement-header {
              display: flex;
              align-items: center;
              padding: 20px;
              background: #1a1a2e;
              border-bottom: 1px solid #333;
            }
            .statement-number {
              width: 40px;
              height: 40px;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              border-radius: 50%;
              display: flex;
              align-items: center;
              justify-content: center;
              font-weight: bold;
              margin-right: 15px;
              flex-shrink: 0;
            }
            .statement-info h3 {
              font-size: 1.1rem;
              font-weight: 500;
              margin-bottom: 4px;
              word-break: break-word;
            }
            .statement-info p {
              font-size: 0.85rem;
              color: #888;
            }
            .view-link {
              margin-left: auto;
              padding: 8px 16px;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              color: white;
              text-decoration: none;
              border-radius: 6px;
              font-size: 0.9rem;
              font-weight: 500;
              transition: opacity 0.2s;
            }
            .view-link:hover {
              opacity: 0.9;
            }
            .pdf-wrapper {
              position: relative;
              width: 100%;
              height: 800px;
              background: #fff;
            }
            .loading-indicator {
              position: absolute;
              top: 50%;
              left: 50%;
              transform: translate(-50%, -50%);
              color: #666;
              font-size: 1.1rem;
              z-index: 1;
            }
            .pdf-viewer {
              position: relative;
              z-index: 2;
              width: 100%;
              height: 100%;
              border: none;
              background: #fff;
            }
            .footer {
              text-align: center;
              padding: 30px;
              color: #666;
              font-size: 0.85rem;
            }
            @media (max-width: 768px) {
              .header h1 { font-size: 1.4rem; }
              .pdf-wrapper { height: 500px; }
              .statement-header { padding: 15px; flex-wrap: wrap; gap: 10px; }
              .view-link { margin-left: 0; margin-top: 10px; }
            }
          </style>
        </head>
        <body>
          <div class="header">
            <h1>Bank Statements</h1>
            <p>${escapeHtml(businessName)} &bull; ${statements.length} Statement${statements.length !== 1 ? 's' : ''}</p>
          </div>
          <div class="container">
            ${statementsHtml}
          </div>
          <div class="footer">
            <p>Powered by Capital Loan Connect</p>
          </div>
        </body>
        </html>
      `;

      res.setHeader('Content-Type', 'text/html');
      res.send(html);
    } catch (error) {
      console.error("Error viewing combined bank statements:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to load statements" });
      }
    }
  });

  // 4. Bulk download all bank statements for a business as ZIP
  app.get("/api/bank-statements/download-all/:businessName", async (req, res) => {
    if (!req.session.user?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }

    try {
      const businessName = decodeURIComponent(req.params.businessName);
      console.log(`[BULK DOWNLOAD] Requesting all statements for business: "${businessName}"`);

      // Get all uploads for this business
      let uploads;
      if (req.session.user.role === 'admin') {
        uploads = await storage.getAllBankStatementUploads();
      } else if (req.session.user.role === 'agent' && req.session.user.agentEmail) {
        uploads = await storage.getBankStatementUploadsByAgentEmail(req.session.user.agentEmail);
      } else {
        return res.status(403).json({ error: "Access denied" });
      }

      // Filter by business name
      const businessUploads = uploads.filter(u =>
        (u.businessName || 'Unknown Business') === businessName
      );

      if (businessUploads.length === 0) {
        return res.status(404).json({ error: "No statements found for this business" });
      }

      console.log(`[BULK DOWNLOAD] Found ${businessUploads.length} statements for "${businessName}"`);

      // Track filenames to handle duplicates and track success/failures
      const usedFilenames = new Map<string, number>();
      const successfulFiles: string[] = [];
      const failedFiles: { name: string; reason: string }[] = [];
      const fileBuffers: { name: string; buffer: Buffer }[] = [];

      // Helper to get unique filename
      const getUniqueFilename = (originalName: string): string => {
        const count = usedFilenames.get(originalName) || 0;
        usedFilenames.set(originalName, count + 1);

        if (count === 0) {
          return originalName;
        }

        // Add suffix before extension for duplicates
        const lastDot = originalName.lastIndexOf('.');
        if (lastDot > 0) {
          const name = originalName.substring(0, lastDot);
          const ext = originalName.substring(lastDot);
          return `${name}_${count}${ext}`;
        }
        return `${originalName}_${count}`;
      };

      // First, collect all file buffers before creating the archive
      for (const upload of businessUploads) {
        try {
          let fileBuffer: Buffer;

          // Check if file is in Object Storage (has bank-statements/ prefix)
          if (upload.storedFileName && upload.storedFileName.includes("bank-statements/")) {
            console.log(`[BULK DOWNLOAD] Fetching from Object Storage: ${upload.storedFileName}`);
            fileBuffer = await objectStorage.getFileBuffer(upload.storedFileName);
          } else {
            // Fallback: check local disk
            const filePath = path.join(UPLOAD_DIR, upload.storedFileName);
            if (fs.existsSync(filePath)) {
              console.log(`[BULK DOWNLOAD] Reading from local disk: ${filePath}`);
              fileBuffer = fs.readFileSync(filePath);
            } else {
              console.warn(`[BULK DOWNLOAD] File not found: ${upload.storedFileName}`);
              failedFiles.push({ name: upload.originalFileName, reason: 'File not found in storage' });
              continue;
            }
          }

          // Store the buffer for later
          const uniqueFilename = getUniqueFilename(upload.originalFileName);
          fileBuffers.push({ name: uniqueFilename, buffer: fileBuffer });
          successfulFiles.push(uniqueFilename);
          console.log(`[BULK DOWNLOAD] Prepared ${uniqueFilename} (${fileBuffer.length} bytes)`);
        } catch (fileError) {
          const errorMessage = fileError instanceof Error ? fileError.message : 'Unknown error';
          console.error(`[BULK DOWNLOAD] Error fetching file ${upload.originalFileName}:`, fileError);
          failedFiles.push({ name: upload.originalFileName, reason: errorMessage });
        }
      }

      // Create manifest content
      const manifestContent = [
        `Bank Statements Download Manifest`,
        `Business: ${businessName}`,
        `Downloaded: ${new Date().toISOString()}`,
        ``,
        `=== Successfully Included (${successfulFiles.length} files) ===`,
        ...successfulFiles.map(f => `  - ${f}`),
      ];

      if (failedFiles.length > 0) {
        manifestContent.push(
          ``,
          `=== Failed to Include (${failedFiles.length} files) ===`,
          ...failedFiles.map(f => `  x ${f.name}: ${f.reason}`)
        );
      }

      manifestContent.push(
        ``,
        `Total: ${successfulFiles.length} of ${businessUploads.length} files included`
      );

      // Now create the archive with all collected buffers
      const archive = archiver('zip', { zlib: { level: 5 } });

      // Sanitize business name for filename
      const safeBusinessName = businessName.replace(/[^a-zA-Z0-9-_]/g, '_').substring(0, 50);
      const zipFileName = `${safeBusinessName}_Bank_Statements.zip`;

      // Set up error handling for archive
      archive.on('error', (err: Error) => {
        console.error('[BULK DOWNLOAD] Archive error:', err);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to create archive' });
        }
      });

      archive.on('warning', (err: Error) => {
        console.warn('[BULK DOWNLOAD] Archive warning:', err);
      });

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${zipFileName}"`);

      archive.pipe(res);

      // Add all files to archive
      for (const file of fileBuffers) {
        archive.append(file.buffer, { name: file.name });
        console.log(`[BULK DOWNLOAD] Added ${file.name} to archive`);
      }

      // Add manifest
      archive.append(manifestContent.join('\n'), { name: '_manifest.txt' });

      // Finalize the archive
      await archive.finalize();
      console.log(`[BULK DOWNLOAD] Archive created for "${businessName}": ${successfulFiles.length}/${businessUploads.length} files included`);
    } catch (error) {
      console.error("Error creating bulk download:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to create download" });
      }
    }
  });

  // Admin endpoint: Generate missing view tokens for bank statements
  app.post("/api/admin/bank-statements/generate-view-tokens", async (req, res) => {
    if (!req.session.user?.isAuthenticated || req.session.user.role !== 'admin') {
      return res.status(403).json({ error: "Admin access required" });
    }

    try {
      console.log("[ADMIN] Starting view token generation for statements missing tokens...");
      
      // Get all uploads
      const allUploads = await storage.getAllBankStatementUploads();
      const uploadsWithoutTokens = allUploads.filter(u => !u.viewToken);
      
      console.log(`[ADMIN] Found ${uploadsWithoutTokens.length} statements without view tokens`);
      
      if (uploadsWithoutTokens.length === 0) {
        return res.json({ 
          success: true, 
          message: "All statements already have view tokens",
          updated: 0 
        });
      }

      let updated = 0;
      const errors: string[] = [];

      for (const upload of uploadsWithoutTokens) {
        try {
          // Generate a secure random 64-character hex token
          const viewToken = require('crypto').randomBytes(32).toString('hex');
          
          await storage.updateBankStatementViewToken(upload.id, viewToken);
          console.log(`[ADMIN] Generated token for: ${upload.originalFileName} (${upload.email})`);
          updated++;
        } catch (error) {
          const errorMsg = `Failed to update ${upload.id}: ${error instanceof Error ? error.message : 'Unknown error'}`;
          console.error(`[ADMIN] ${errorMsg}`);
          errors.push(errorMsg);
        }
      }

      console.log(`[ADMIN] View token generation complete: ${updated}/${uploadsWithoutTokens.length} updated`);
      
      res.json({
        success: true,
        message: `Generated view tokens for ${updated} statements`,
        updated,
        total: uploadsWithoutTokens.length,
        errors: errors.length > 0 ? errors : undefined
      });
    } catch (error) {
      console.error("[ADMIN] Error generating view tokens:", error);
      res.status(500).json({ error: "Failed to generate view tokens" });
    }
  });

  // Admin: Send a test bank statement webhook to GHL (for testing the View All link)
  app.post("/api/admin/bank-statements/test-webhook", async (req, res) => {
    if (!req.session.user?.isAuthenticated || req.session.user.role !== 'admin') {
      return res.status(403).json({ error: "Admin access required" });
    }

    try {
      const { email } = req.body;
      
      if (!email) {
        return res.status(400).json({ error: "Email is required" });
      }

      // Build base URL for view links
      const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
      const host = req.headers['x-forwarded-host'] || req.headers.host || 'app.todaycapitalgroup.com';
      const baseUrl = `${protocol}://${host}`;

      // Get all bank statements for this email
      const statements = await storage.getBankStatementUploadsByEmail(email);
      
      if (statements.length === 0) {
        return res.status(404).json({ error: `No bank statements found for email: ${email}` });
      }

      // Build statement links
      const statementLinks = statements
        .filter(stmt => stmt.viewToken)
        .map(stmt => ({
          fileName: stmt.originalFileName,
          viewUrl: `${baseUrl}/api/bank-statements/public/view/${stmt.viewToken}`,
        }));

      // Generate combined view URL
      const combinedViewToken = generateCombinedViewToken(email);
      const combinedViewUrl = `${baseUrl}/api/bank-statements/public/view-all/${combinedViewToken}`;

      // Look up matching application for contact details
      const matchingApp = await storage.getLoanApplicationByEmail(email);
      const nameParts = (matchingApp?.fullName || '').trim().split(' ');

      console.log('[ADMIN] Sending TEST bank statement webhook for:', email);
      console.log('[ADMIN] View All URL:', combinedViewUrl);
      console.log('[ADMIN] Statement count:', statements.length);

      // Force send the webhook (bypass session throttling for testing)
      // We'll call the webhook URL directly here instead of using ghlService
      const BANK_STATEMENT_WEBHOOK_URL = 'https://services.leadconnectorhq.com/hooks/n778xwOps9t8Q34eRPfM/webhook-trigger/763f2d42-9850-4ed3-acde-9449ef94f9ae';

      const statementData: Record<string, string> = {};
      statementLinks.slice(0, 10).forEach((link, index) => {
        const num = index + 1;
        statementData[`bank_statement_${num}_name`] = link.fileName;
        statementData[`bank_statement_${num}_url`] = link.viewUrl;
      });
      statementData['bank_statement_count'] = String(statementLinks.length);

      const webhookPayload = {
        email,
        phone: matchingApp?.phone || null,
        first_name: nameParts[0] || null,
        last_name: nameParts.slice(1).join(' ') || null,
        company_name: matchingApp?.businessName || matchingApp?.legalBusinessName || null,
        submission_date: new Date().toISOString(),
        source: "Bank Statement Upload (TEST)",
        tags: ["Statements Uploaded", "TEST_WEBHOOK"],
        bank_statements_view_all_url: combinedViewUrl,
        ...statementData,
      };

      const response = await fetch(BANK_STATEMENT_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(webhookPayload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[ADMIN] Test webhook failed:', response.status, errorText);
        return res.status(500).json({ 
          error: "Webhook request failed",
          status: response.status,
          details: errorText
        });
      }

      console.log('[ADMIN] Test webhook sent successfully');
      res.json({
        success: true,
        message: `Test webhook sent for ${email}`,
        payload: webhookPayload,
        combinedViewUrl,
        statementCount: statements.length
      });
    } catch (error) {
      console.error("[ADMIN] Error sending test webhook:", error);
      res.status(500).json({ error: "Failed to send test webhook" });
    }
  });

  // 5. Analyze uploaded PDF statements for a business
  app.post("/api/bank-statements/analyze/:businessName", async (req, res) => {
    if (!req.session.user?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }

    try {
      if (!isOpenAIConfigured()) {
        return res.status(503).json({
          error: "Analysis service not available",
          message: "OpenAI API is not configured.",
        });
      }

      const businessName = decodeURIComponent(req.params.businessName);
      const { creditScoreRange, timeInBusiness, industry } = req.body;

      console.log(`[PDF ANALYZE] Starting analysis for business: "${businessName}"`);

      // Get all uploads for this business
      let uploads;
      if (req.session.user.role === 'admin') {
        uploads = await storage.getAllBankStatementUploads();
      } else if (req.session.user.role === 'agent' && req.session.user.agentEmail) {
        uploads = await storage.getBankStatementUploadsByAgentEmail(req.session.user.agentEmail);
      } else {
        return res.status(403).json({ error: "Access denied" });
      }

      // Filter by business name
      const businessUploads = uploads.filter(u =>
        (u.businessName || 'Unknown Business') === businessName
      );

      if (businessUploads.length === 0) {
        return res.status(404).json({ error: "No statements found for this business" });
      }

      console.log(`[PDF ANALYZE] Found ${businessUploads.length} statements for "${businessName}"`);

      // Extract text from all PDFs
      const extractedTexts: string[] = [];

      for (const upload of businessUploads.slice(0, 6)) { // Limit to 6 files
        try {
          let fileBuffer: Buffer;

          // Get file from Object Storage or local disk
          if (upload.storedFileName && upload.storedFileName.includes("bank-statements/")) {
            fileBuffer = await objectStorage.getFileBuffer(upload.storedFileName);
          } else {
            const filePath = path.join(UPLOAD_DIR, upload.storedFileName);
            if (fs.existsSync(filePath)) {
              fileBuffer = fs.readFileSync(filePath);
            } else {
              console.warn(`[PDF ANALYZE] File not found: ${upload.storedFileName}`);
              continue;
            }
          }

          // Extract text from PDF
          const parser = new PDFParse({ data: fileBuffer });
          const result = await parser.getText();
          const text = result.text || "";
          extractedTexts.push(`--- Statement: ${upload.originalFileName} ---\n${text}\n`);
          console.log(`[PDF ANALYZE] Extracted ${text.length} chars from ${upload.originalFileName}`);
          await parser.destroy();
        } catch (pdfError) {
          console.error(`[PDF ANALYZE] Error parsing ${upload.originalFileName}:`, pdfError);
          extractedTexts.push(`--- Statement: ${upload.originalFileName} ---\n[Error: Could not extract text from this PDF.]\n`);
        }
      }

      if (extractedTexts.length === 0) {
        return res.status(400).json({
          error: "No readable content",
          message: "Could not extract text from any of the uploaded PDFs.",
        });
      }

      const combinedText = extractedTexts.join("\n\n");
      console.log(`[PDF ANALYZE] Total text for analysis: ${combinedText.length} chars`);

      // Analyze with OpenAI
      const analysis = await analyzeBankStatements(combinedText, {
        creditScoreRange,
        timeInBusiness,
        industry,
      });

      console.log(`[PDF ANALYZE] Analysis complete. Score: ${analysis.overallScore}, Tier: ${analysis.qualificationTier}`);

      res.json({
        success: true,
        analysis,
        source: "uploaded",
        businessName,
        filesProcessed: extractedTexts.length,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error("[PDF ANALYZE] Error:", error);
      res.status(500).json({
        error: "Analysis failed",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  // Download blank application template as PDF (matching completed application style)
  app.get("/api/application-template", async (req, res) => {
    try {
      const templateType = (req.query.type as string) || 'standard';
      const isRedacted   = templateType === 'redacted';
      const includeLingo = templateType === 'lcg';
      const includeSignature = templateType === 'signature';
      const typeLabels: Record<string, string> = {
        standard: 'Standard', signature: 'Signature', lcg: 'LCG', redacted: 'Redacted',
      };
      const typeLabel = typeLabels[templateType] || 'Standard';

      const doc = new PDFDocument({ margin: 0, size: 'A4' });
      
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="Application-Template-${typeLabel}.pdf"`);
      
      doc.pipe(res);
      
      // Colors (matching the completed application PDF)
      const headerBg = '#E8EEF3'; // Light blue-gray
      const darkNavy = '#1B2E4D'; // Dark navy text
      const teal = '#5FBFB8'; // Teal accent
      const fieldBg = '#FAFAFA'; // Light gray for field boxes
      const fieldBorder = '#E5E7EB'; // Border for fields
      const labelColor = '#6B7280'; // Gray for labels
      
      // Header background
      doc.rect(0, 0, 595, 113).fill(headerBg);
      
      // Add logo image (matching the completed application PDF)
      // Logo dimensions: original 450x138, scaled to ~170x52 for PDF
      const logoPath = path.join(process.cwd(), 'client', 'public', 'assets', 'tcg-logo.png');
      try {
        if (fs.existsSync(logoPath)) {
          doc.image(logoPath, 57, 28, { width: 170 });
        } else {
          // Fallback to text if logo not found
          doc.fillColor(teal).fontSize(24).font('Helvetica-Bold').text('TODAY', 57, 28);
          doc.fillColor(darkNavy).fontSize(24).font('Helvetica-Bold').text('CAPITAL GROUP', 57, 50, { continued: false });
        }
      } catch (logoError) {
        // Fallback to text if logo fails to load
        doc.fillColor(teal).fontSize(24).font('Helvetica-Bold').text('TODAY', 57, 28);
        doc.fillColor(darkNavy).fontSize(24).font('Helvetica-Bold').text('CAPITAL GROUP', 57, 50, { continued: false });
      }
      
      // Date on right
      const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      doc.fillColor(teal).fontSize(10).font('Helvetica').text('Date: ' + today, 425, 35);
      
      let yPos = 140;
      const leftCol = 57;
      const rightCol = 306;
      const fieldWidth = 230;
      const smallFieldWidth = 107;
      const fieldHeight = 24;
      const rowSpacing = 37;
      
      // Helper function for section headers
      const addSectionHeader = (title: string) => {
        doc.fillColor(darkNavy).fontSize(14).font('Helvetica-Bold').text(title, leftCol, yPos);
        doc.strokeColor(teal).lineWidth(2).moveTo(leftCol, yPos + 18).lineTo(leftCol + 160, yPos + 18).stroke();
        yPos += 35;
      };
      
      // Helper function for field with label and box
      const addField = (label: string, x: number, y: number, width: number) => {
        doc.fillColor(labelColor).fontSize(8).font('Helvetica-Bold').text(label, x, y);
        doc.rect(x, y + 10, width, fieldHeight).fillAndStroke(fieldBg, fieldBorder);
        doc.fillColor('#9CA3AF').fontSize(10).font('Helvetica').text('—', x + 8, y + 17);
      };
      
      // Business Information Section
      addSectionHeader('Business Information');
      
      addField('Legal Name:', leftCol, yPos, fieldWidth);
      addField('DBA:', rightCol, yPos, fieldWidth);
      yPos += rowSpacing;
      
      addField('Website:', leftCol, yPos, fieldWidth);
      addField('Start Date:', rightCol, yPos, fieldWidth);
      yPos += rowSpacing;
      
      addField('EIN:', leftCol, yPos, fieldWidth);
      addField('Industry:', rightCol, yPos, fieldWidth);
      yPos += rowSpacing;
      
      addField('Address:', leftCol, yPos, fieldWidth);
      addField('City:', rightCol, yPos, fieldWidth);
      yPos += rowSpacing;
      
      addField('State:', leftCol, yPos, smallFieldWidth);
      addField('ZIP:', leftCol + 120, yPos, smallFieldWidth);
      addField('State of Inc:', rightCol, yPos, fieldWidth);
      yPos += rowSpacing;
      
      addField('Requested Amount:', leftCol, yPos, fieldWidth);
      addField('MCA Balance:', rightCol, yPos, fieldWidth);
      yPos += rowSpacing;
      
      addField('Credit Cards:', leftCol, yPos, fieldWidth);
      addField('MCA Bank:', rightCol, yPos, fieldWidth);
      yPos += 50;
      
      // Owner Information Section
      addSectionHeader('Owner Information');
      
      addField('Full Name:', leftCol, yPos, fieldWidth);
      addField('Email:', rightCol, yPos, fieldWidth);
      yPos += rowSpacing;
      
      addField('Phone:', leftCol, yPos, fieldWidth);
      if (isRedacted) {
        doc.fillColor(labelColor).fontSize(8).font('Helvetica-Bold').text('SSN:', rightCol, yPos);
        doc.rect(rightCol, yPos + 10, fieldWidth, fieldHeight).fillAndStroke('#F0F0F0', '#E5E7EB');
        doc.fillColor('#C0C0C0').fontSize(9).font('Helvetica').text('[REDACTED]', rightCol + 8, yPos + 17);
      } else {
        addField('SSN:', rightCol, yPos, fieldWidth);
      }
      yPos += rowSpacing;
      
      if (isRedacted) {
        doc.fillColor(labelColor).fontSize(8).font('Helvetica-Bold').text('Date of Birth:', leftCol, yPos);
        doc.rect(leftCol, yPos + 10, fieldWidth, fieldHeight).fillAndStroke('#F0F0F0', '#E5E7EB');
        doc.fillColor('#C0C0C0').fontSize(9).font('Helvetica').text('[REDACTED]', leftCol + 8, yPos + 17);
      } else {
        addField('Date of Birth:', leftCol, yPos, fieldWidth);
      }
      addField('FICO Score:', rightCol, yPos, fieldWidth);
      yPos += rowSpacing;
      
      addField('Ownership %:', leftCol, yPos, fieldWidth);
      addField('Home Address:', rightCol, yPos, fieldWidth);
      yPos += rowSpacing;
      
      addField('City:', leftCol, yPos, fieldWidth);
      addField('State:', rightCol, yPos, smallFieldWidth);
      addField('ZIP:', rightCol + 120, yPos, smallFieldWidth);
      yPos += 50;

      // — Signature section (signature template only) —
      if (includeSignature) {
        if (yPos > 680) { doc.addPage(); yPos = 50; }
        doc.strokeColor(teal).lineWidth(2).moveTo(leftCol, yPos).lineTo(leftCol + 160, yPos).stroke();
        yPos += 8;
        doc.fillColor(darkNavy).fontSize(14).font('Helvetica-Bold').text('Applicant Signature', leftCol, yPos);
        yPos += 28;
        // Signature line
        doc.strokeColor('#9CA3AF').lineWidth(1)
          .moveTo(leftCol, yPos + 30).lineTo(leftCol + 230, yPos + 30).stroke();
        doc.fillColor(labelColor).fontSize(8).font('Helvetica-Bold').text('Signature', leftCol, yPos + 33);
        // Date line
        doc.strokeColor('#9CA3AF').lineWidth(1)
          .moveTo(rightCol, yPos + 30).lineTo(rightCol + 140, yPos + 30).stroke();
        doc.fillColor(labelColor).fontSize(8).font('Helvetica-Bold').text('Date', rightCol, yPos + 33);
        yPos += 60;
        // Printed name line
        doc.strokeColor('#9CA3AF').lineWidth(1)
          .moveTo(leftCol, yPos).lineTo(leftCol + 230, yPos).stroke();
        doc.fillColor(labelColor).fontSize(8).font('Helvetica-Bold').text('Printed Name', leftCol, yPos + 3);
        // Title line
        doc.strokeColor('#9CA3AF').lineWidth(1)
          .moveTo(rightCol, yPos).lineTo(rightCol + 140, yPos).stroke();
        doc.fillColor(labelColor).fontSize(8).font('Helvetica-Bold').text('Title', rightCol, yPos + 3);
      }

      // — Authorization & Consent block (LCG template only) —
      if (includeLingo) {
        if (yPos > 620) { doc.addPage(); yPos = 50; }
        doc.fillColor(darkNavy).fontSize(14).font('Helvetica-Bold').text('Authorization & Consent', leftCol, yPos);
        doc.strokeColor(teal).lineWidth(2).moveTo(leftCol, yPos + 18).lineTo(leftCol + 160, yPos + 18).stroke();
        yPos += 32;
        const lingoText = 'The Merchant and Owner(s)/Officer(s) identified above (individually, and "Applicant") each represents, acknowledges and agrees that (1) all the information and documents provided to Today Capital Group LLC ("Representative") including credit card processor statements are true, accurate and complete, (2) Applicant will immediately notify Representative of any change in such information or financial condition, (3) Applicant authorizes Representative to disclose all information and documents that Representative may obtain including credit reports to the other persons or entities (collectively, "Assignees") that may be involved with or acquire commercial funding having daily repayment features or purchases of future receivables, including Merchant Cash Advance transactions, including without limitation the application therefor (collectively, "Transactions"), and each Assignee is authorized to use such information and documents, and share such information and documents with other Assignees, in connection with potential Transactions, (4) Representative and each Assignee will rely upon the accuracy and completeness of such information and documents, (5) Representative, Assignees, and each of their representatives, successors, assigns and designees (collectively, "Recipients") are authorized to request and receive and investigative reports, credit reports, statements from creditors or financial institutions, verification information, or any other information that a Recipient deems necessary, (6) Applicant waives and releases and claims against Recipients and any other information-providers arising from any act or omission relating to the requesting, receiving, or release of information, (7) each Owner/Officer represents that he or she is authorized to sign this form on behalf of Merchant and (8) Applicant consents to receive marketing calls and texts from Representative and its affiliates or assigns using automated technology. Consent is not a condition of funding. A copy of this authorization may be accepted as an original. Applicant further agrees to the use of electronic signatures for the execution of this document, including, but not limited to, the use of specialized electronic signature platforms.';
        doc.fontSize(8).font('Helvetica').fillColor('#3C3C3C');
        const lines = doc.heightOfString(lingoText, { width: 481 });
        if (yPos + lines > 750) { doc.addPage(); yPos = 50; }
        doc.text(lingoText, leftCol, yPos, { width: 481, lineGap: 2 });
      }
      
      doc.end();
    } catch (error) {
      console.error("Error generating application template:", error);
      res.status(500).json({ error: "Failed to generate template" });
    }
  });

  // Export all applications as CSV
  app.get("/api/applications/export/csv", async (req, res) => {
    try {
      const applications = await storage.getAllLoanApplications();
      
      // Get all bank statement uploads to check which applications have statements
      const allUploads = await storage.getAllBankStatementUploads();
      
      // Create a map of email -> has statements
      const emailsWithStatements = new Set<string>();
      for (const upload of allUploads) {
        if (upload.email) {
          emailsWithStatements.add(upload.email.toLowerCase().trim());
        }
      }
      
      // Build base URL for view links
      const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
      const host = req.headers['x-forwarded-host'] || req.headers.host || 'app.todaycapitalgroup.com';
      const baseUrl = `${protocol}://${host}`;
      
      // Define CSV headers matching all application fields
      const headers = [
        'ID',
        'Full Name',
        'Email',
        'Phone',
        'Date of Birth',
        'Legal Business Name',
        'DBA',
        'Industry',
        'EIN',
        'Business Start Date',
        'State of Incorporation',
        'Company Email',
        'Website',
        'Business Address',
        'Business City',
        'Business State',
        'Business ZIP',
        'Owner Address',
        'Owner City',
        'Owner State',
        'Owner ZIP',
        'Ownership %',
        'FICO Score',
        'SSN',
        'Process Credit Cards',
        'Requested Amount',
        'Use of Funds',
        'MCA Balance Amount',
        'MCA Balance Bank',
        'Current Step',
        'Is Completed',
        'Is Full Application Completed',
        'Agent',
        'GHL Contact ID',
        'Agent View URL',
        'Plaid Item ID',
        'View Statements URL',
        'Created At'
      ];
      
      // Helper to escape CSV values
      const escapeCSV = (value: any): string => {
        if (value === null || value === undefined) return '';
        const str = String(value);
        if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      };
      
      // Build CSV rows
      const rows = applications.map(app => {
        // Generate View All link if this application has uploaded statements
        let viewStatementsUrl = '';
        if (app.email && emailsWithStatements.has(app.email.toLowerCase().trim())) {
          const combinedViewToken = generateCombinedViewToken(app.email);
          viewStatementsUrl = `${baseUrl}/api/bank-statements/public/view-all/${combinedViewToken}`;
        }
        
        return [
          escapeCSV(app.id),
          escapeCSV(app.fullName),
          escapeCSV(app.email),
          escapeCSV(app.phone),
          escapeCSV(app.dateOfBirth),
          escapeCSV(app.legalBusinessName),
          escapeCSV(app.doingBusinessAs),
          escapeCSV(app.industry),
          escapeCSV(app.ein),
          escapeCSV(app.businessStartDate),
          escapeCSV(app.stateOfIncorporation),
          escapeCSV(app.companyEmail),
          escapeCSV(app.companyWebsite),
          escapeCSV(app.businessAddress),
          escapeCSV(app.city),
          escapeCSV(app.state),
          escapeCSV(app.zipCode),
          escapeCSV(app.ownerAddress1),
          escapeCSV(app.ownerCity),
          escapeCSV(app.ownerState),
          escapeCSV(app.ownerZip),
          escapeCSV(app.ownership),
          escapeCSV(app.ficoScoreExact),
          escapeCSV(app.socialSecurityNumber),
          escapeCSV(app.doYouProcessCreditCards),
          escapeCSV(app.requestedAmount),
          escapeCSV(app.useOfFunds),
          escapeCSV(app.mcaBalanceAmount),
          escapeCSV(app.mcaBalanceBankName),
          escapeCSV(app.currentStep),
          escapeCSV(app.isCompleted),
          escapeCSV(app.isFullApplicationCompleted),
          escapeCSV(app.agentName),
          escapeCSV(app.ghlContactId),
          escapeCSV(app.agentViewUrl),
          escapeCSV(app.plaidItemId),
          escapeCSV(viewStatementsUrl),
          escapeCSV(app.createdAt)
        ].join(',');
      });
      
      const csvContent = [headers.join(','), ...rows].join('\n');
      
      const filename = `Applications_Export_${new Date().toISOString().split('T')[0]}.csv`;
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csvContent);
    } catch (error) {
      console.error("Error exporting applications to CSV:", error);
      res.status(500).json({ error: "Failed to export applications" });
    }
  });

  // ========================================
  // BOT DETECTION ROUTES
  // ========================================

  // Get all bot attempts (admin only)
  app.get("/api/bot-attempts", async (req, res) => {
    try {
      // Check authentication - admin only
      if (!req.session.user?.isAuthenticated || req.session.user.role !== 'admin') {
        return res.status(403).json({ error: "Admin access required" });
      }

      const attempts = await storage.getAllBotAttempts();
      res.json(attempts);
    } catch (error) {
      console.error("Error fetching bot attempts:", error);
      res.status(500).json({ error: "Failed to fetch bot attempts" });
    }
  });

  // Get bot attempts count (for dashboard badge)
  app.get("/api/bot-attempts/count", async (req, res) => {
    try {
      // Check authentication - admin only
      if (!req.session.user?.isAuthenticated || req.session.user.role !== 'admin') {
        return res.status(403).json({ error: "Admin access required" });
      }

      const count = await storage.getBotAttemptsCount();
      res.json({ count });
    } catch (error) {
      console.error("Error fetching bot attempts count:", error);
      res.status(500).json({ error: "Failed to fetch count" });
    }
  });

  // ========================================
  // ACH AUTHORIZATION FORM
  // ========================================

  try {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS ach_authorizations (
      id SERIAL PRIMARY KEY,
      bank_name TEXT NOT NULL,
      bank_address TEXT,
      bank_city TEXT,
      bank_state TEXT,
      bank_zip TEXT,
      account_type TEXT DEFAULT 'checking',
      routing_number TEXT NOT NULL,
      account_number TEXT NOT NULL,
      debit_date TEXT,
      amount TEXT,
      business_name TEXT NOT NULL,
      business_address TEXT,
      business_city TEXT,
      business_state TEXT,
      business_zip TEXT,
      contact_name TEXT,
      contact_email TEXT,
      contact_phone TEXT,
      signature_data TEXT,
      signed_at TIMESTAMP,
      ip_address TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
  } catch (err) {
    console.error("[ACH] Failed to ensure table:", err);
  }

  // POST /api/ach-form/submit — public endpoint for ACH form submission
  app.post("/api/ach-form/submit", async (req: Request, res: Response) => {
    try {
      const {
        bankName, bankAddress, bankCity, bankState, bankZip,
        accountType, routingNumber, accountNumber,
        debitDate, amount,
        businessName, businessAddress, businessCity, businessState, businessZip,
        contactName, contactEmail, contactPhone,
        signatureData, signedAt,
      } = req.body;

      if (!bankName || !routingNumber || !accountNumber || !businessName) {
        return res.status(400).json({ error: "Bank name, routing number, account number, and business name are required" });
      }

      if (routingNumber.length !== 9) {
        return res.status(400).json({ error: "Routing number must be 9 digits" });
      }

      const ipAddress = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "";

      await db.execute(sql`INSERT INTO ach_authorizations (
        bank_name, bank_address, bank_city, bank_state, bank_zip,
        account_type, routing_number, account_number,
        debit_date, amount,
        business_name, business_address, business_city, business_state, business_zip,
        contact_name, contact_email, contact_phone,
        signature_data, signed_at, ip_address
      ) VALUES (
        ${bankName}, ${bankAddress || null}, ${bankCity || null}, ${bankState || null}, ${bankZip || null},
        ${accountType || 'checking'}, ${routingNumber}, ${accountNumber},
        ${debitDate || null}, ${amount || null},
        ${businessName}, ${businessAddress || null}, ${businessCity || null}, ${businessState || null}, ${businessZip || null},
        ${contactName || null}, ${contactEmail || null}, ${contactPhone || null},
        ${signatureData || null}, ${signedAt ? new Date(signedAt) : new Date()}, ${String(ipAddress)}
      )`);

      console.log(`[ACH] Authorization submitted: ${businessName} | ${contactEmail || bankName} | $${amount || '?'}`);
      res.json({ success: true });
    } catch (err: any) {
      console.error("[ACH] Submit error:", err);
      res.status(500).json({ error: "Failed to submit authorization" });
    }
  });

  // GET /api/ach-form/submissions — admin view
  app.get("/api/ach-form/submissions", async (req: Request, res: Response) => {
    if (!req.session.user?.isAuthenticated || req.session.user.role === 'merchant' || req.session.user.role === 'lead') {
      return res.status(401).json({ error: "Admin access required" });
    }
    try {
      const result = await db.execute(sql`SELECT id, bank_name, account_type, routing_number, account_number, debit_date, amount, business_name, contact_name, contact_email, contact_phone, signed_at, ip_address, created_at FROM ach_authorizations ORDER BY created_at DESC`);
      res.json(result.rows);
    } catch (err: any) {
      console.error("[ACH] Fetch error:", err);
      res.status(500).json({ error: "Failed to fetch submissions" });
    }
  });

  // ========================================
  // SERVICES INTEREST TRACKING
  // ========================================

  // ========================================
  // ADS LEADS — seed CSV contacts on first run
  // (Table is defined in shared/schema.ts and managed by Drizzle/publish flow)
  // ========================================
  try {
    // Normalize any existing contacts: all non-form-submission leads → "Clicked through Email"
    await db.execute(sql`UPDATE ads_leads SET lead_type = 'Clicked through Email' WHERE lead_type != 'Form Submission'`);

    const countRes = await db.execute(sql`SELECT COUNT(*) FROM ads_leads WHERE lead_type != 'Form Submission'`);
    if (String(countRes.rows[0]?.count ?? '0') === '0') {
      const csvContacts = [
        ['deniseb@burgessservices.com','Denise','Burgess','+13035882573','Burgess Services LLC','','','62031.50','','','Clicked through Email','2025-10-07'],
        ['mochs@wclh.com','Mikel','Ochs','+14068024104','1978 LLC','Billings','MT','374011.00','SMA','SMA1','Clicked through Email','2025-10-03'],
        ['todd@kingprecisionsolutions.com','Todd','King','+18773123858','King Precision Solutions','','','1169618.00','UCC','UCC 4.6.26','Clicked through Email','2026-04-06'],
        ['jed@fastpaypartners.com','Jed','Simon','+13109862048','Fast Pay Partners','','CA','216000.00','','','Clicked through Email','2026-04-14'],
        ['jim.blair@aberdean.com','James','Blair','+16082049619','DOKKOBRAZIL, INC.','','','2395916.00','UCC','UCC 4.6.26','Clicked through Email','2026-04-06'],
        ['bl@specializedcrane.com','Brian','Lambrix','+19189913260','Specialized Hoisting and Hauling LLC','Tulsa','OK','42562.03','L4C','L4C14','Clicked through Email','2025-10-07'],
        ['mcastaldo@mactecpackaging.com','Michael','Castaldo','+17324168525','MACTEC PACKAGING TECHNOLOGIES','','','1788716.00','UCC','UCC 4.6.26','Clicked through Email','2026-04-06'],
        ['joyce@se-oc.com','Joyce','Cumbo','+15055037228','GRANDVIEW TAVERN','','','1642214.00','UCC','UCC 4.6.26','Clicked through Email','2026-04-06'],
        ['terry@energytechhvac.com','Terry','Dipoma','+18015801230','TERRY DIPOMA','','','186796.00','UCC','UCC 4.6.26','Clicked through Email','2026-04-06'],
        ['bobfaia@mks-corp.com','Robert','Faia','+19787772196','MK SERVICES CORP.','','','10342450.00','UCC','UCC 4.6.26','Clicked through Email','2026-04-06'],
        ['emayfield@healthsourcechiro.com','Eric','Mayfield','+16128740705','MAYFIELD CHIROPRACTIC','','','357903.00','UCC','UCC 4.6.26','Clicked through Email','2026-04-06'],
        ['kleatherman@fitnessforumonline.com','Karen','Leatherman','+18436613800','KAL, INC.','','','1460051.00','UCC','UCC 4.6.26','Clicked through Email','2026-04-06'],
        ['docvroom@advancedcarechiro.com','Brian','Vroom','+15033581417','ADVANCED CARE CHIROPRACTIC, P.C.','','','163981.00','','','Clicked through Email','2025-10-07'],
        ['jvalore@wandynamics.com','Jason','Valore','+18774009490','WAN DYNAMICS, INC.','','','1031011.00','UCC','UCC 4.6.26','Clicked through Email','2026-03-31'],
        ['ervin.redd@cruiseplanners.com','Ervin','Redd','+18582291356','Wayfare Travel','San Diego','CA','337000.00','SMA','SMA1','Clicked through Email','2025-10-20'],
        ['david.cabral@elsequip.com','David','Cabral','+16173121765','469 LINCOLN STREET LLC','Boston','MA','133622.00','L4C','L4C14','Clicked through Email','2025-10-07'],
        ['mark.edfort@evolutionmedcom.com','Mark','Edfort','+16109559621','Evolution Medical Communications','Allentown','PA','2637464.00','EGTML','EGTML1','Clicked through Email','2025-10-15'],
        ['greg.plummer@enjoyrepeat.com','Gregory','Plummer','+13107173150','Enjoy Repeat, Inc.','Los Angeles','CA','128730.00','L4C','L4C14','Clicked through Email','2025-10-07'],
      ];
      for (const [email, firstName, lastName, phone, businessName, city, state, monthlyRevenue, source, leadBatch, leadType, createdDate] of csvContacts) {
        await db.execute(sql`INSERT INTO ads_leads (email, first_name, last_name, phone, business_name, city, state, monthly_revenue, source, lead_batch, lead_type, last_activity, created_at)
          VALUES (${email}, ${firstName}, ${lastName}, ${phone}, ${businessName}, ${city || null}, ${state || null}, ${monthlyRevenue}, ${source || null}, ${leadBatch || null}, ${leadType}, ${new Date('2026-04-30')}, ${new Date(createdDate)})
          ON CONFLICT (email) DO NOTHING`);
      }
      console.log("[ADS-LEADS] Seeded 18 CSV contacts");
    }

    // Always upsert new batch contacts (ON CONFLICT DO NOTHING keeps existing rows safe)
    const batchMay2026 = [
      ['info@epiccg.com','Andrew','Painter','Clicked through Email','2026-05-04 20:25:00'],
      ['noah@bnastaffing.com','Noah','Nielsen','Clicked through Email','2026-05-04 17:10:00'],
      ['ncaron@macairgroup.com','Nicole','Caron','Clicked through Email','2026-05-04 18:49:00'],
      ['daynah@microsoft.com','Dayna','Hailey','Clicked through Email','2026-05-04 17:09:00'],
      ['rcastiglione@wnyasset.com','Rob','Castiglione','Clicked through Email','2026-05-04 17:07:00'],
      ['lbarnes@eyeboston.com','Lisa','Barnes','Clicked through Email','2026-05-04 16:08:00'],
      ['sara.b.wilson@cummins.com','Sara','Wilson','Clicked through Email','2026-05-04 16:08:00'],
      ['nadkarni@dell.com','Nadkarni','Sachit','Clicked through Email','2026-05-04 16:08:00'],
      ['minh.ly.2011@marshall.usc.edu','Mike','Ly','Clicked through Email','2026-05-04 20:53:00'],
      ['todd@earthtrades.com','Todd','Henderson','Clicked through Email','2026-05-04 13:52:00'],
      ['pete.eskew@id.me','Peter','Eskew','Clicked through Email','2026-05-04 12:07:00'],
      ['tniles@negllc.us','Tim','Niles','Clicked through Email','2026-05-04 12:08:00'],
      ['miljan.petkovic@roamingnetworks.com','Roaming','Networks','Clicked through Email','2026-05-04 12:08:00'],
      ['marc@americandoor.com','Marc','Jurman','Clicked through Email','2026-05-04 11:09:00'],
      ['kkoch1@psusd.us','Kevin','Koch','Clicked through Email','2026-05-04 11:09:00'],
      ['lsutherland@vsi360.com','Len','Sutherland','Clicked through Email','2026-05-04 11:07:00'],
      ['hfleishman@gtglobal.com','Herman','Fleishman','Clicked through Email','2026-05-04 11:29:00'],
    ];
    for (const [email, firstName, lastName, leadType, createdAt] of batchMay2026) {
      await db.execute(sql`INSERT INTO ads_leads (email, first_name, last_name, lead_type, last_activity, created_at)
        VALUES (${email}, ${firstName}, ${lastName}, ${leadType}, ${new Date('2026-05-04')}, ${new Date(createdAt)})
        ON CONFLICT (email) DO NOTHING`);
    }
    // Update Denise Burgess last_activity — she clicked again May 4
    await db.execute(sql`UPDATE ads_leads SET last_activity = ${new Date('2026-05-04 20:26:00')} WHERE email = 'deniseb@burgessservices.com'`);
  } catch (err) {
    console.error("[ADS-LEADS] Failed to seed contacts:", err);
  }

  // Ensure table exists
  try {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS service_interests (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      first_name TEXT,
      last_name TEXT,
      phone TEXT,
      business_name TEXT,
      service TEXT NOT NULL,
      other_details TEXT,
      source TEXT,
      utm_campaign TEXT,
      utm_source TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    await db.execute(sql`ALTER TABLE service_interests ADD COLUMN IF NOT EXISTS rep_email TEXT`);
    await db.execute(sql`ALTER TABLE service_interests ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'new'`);
  } catch (err) {
    console.error("[SERVICES] Failed to ensure table:", err);
  }

  // POST /api/services/interest — record a service interest click (no auth required)
  app.post("/api/services/interest", async (req: Request, res: Response) => {
    try {
      const { email, firstName, lastName, phone, businessName, service, otherDetails, source, utmCampaign, utmSource, repEmail } = req.body;
      if (!email || !service) return res.status(400).json({ error: "Email and service are required" });

      const normalizedEmail = email.toLowerCase().trim();
      // repEmail: the logged-in rep's email, stored for dashboard filtering
      const normalizedRepEmail = repEmail ? repEmail.toLowerCase().trim() : null;

      // Skip dedup for rep-referral — reps should always be able to submit
      if (source !== "rep-referral") {
        const existing = await db.execute(sql`SELECT id FROM service_interests WHERE email = ${normalizedEmail} AND service = ${service} AND created_at >= NOW() - INTERVAL '24 hours'`);
        if (existing.rows.length > 0) {
          return res.json({ success: true, message: "Already recorded" });
        }
      }

      await db.execute(sql`INSERT INTO service_interests (email, first_name, last_name, phone, business_name, service, other_details, source, utm_campaign, utm_source, rep_email)
        VALUES (${normalizedEmail}, ${firstName || null}, ${lastName || null}, ${phone || null}, ${businessName || null}, ${service}, ${otherDetails || null}, ${source || 'direct'}, ${utmCampaign || null}, ${utmSource || null}, ${normalizedRepEmail})`);

      console.log(`[SERVICES] Interest recorded: ${normalizedEmail} -> ${service} (source: ${source || 'direct'}, rep: ${normalizedRepEmail || 'none'})`);
      const { subject: svcSub, html: svcHtml } = buildServicesInterestEmail({ email: normalizedEmail, firstName, lastName, phone, businessName, service, otherDetails, source, utmSource });
      sendMarketingNotification(svcSub, svcHtml).catch(() => {});
      res.json({ success: true });
    } catch (err: any) {
      console.error("[SERVICES] interest error:", err);
      res.status(500).json({ error: "Failed to record interest" });
    }
  });

  // GET /api/rep/website-referrals — rep sees their own referrals; admin sees all
  app.get("/api/rep/website-referrals", async (req: Request, res: Response) => {
    if (!req.session.user?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }
    try {
      const { role, agentEmail } = req.session.user as any;
      const isAdmin = role === 'admin' || role === 'underwriting';
      let rows;
      if (isAdmin) {
        const result = await db.execute(sql`
          SELECT * FROM service_interests
          WHERE source = 'rep-referral'
          ORDER BY created_at DESC
        `);
        rows = result.rows;
      } else {
        // Match by stored rep_email first; fall back to utm_source name match for legacy records
        const result = await db.execute(sql`
          SELECT * FROM service_interests
          WHERE source = 'rep-referral'
            AND (
              LOWER(rep_email) = ${agentEmail.toLowerCase()}
              OR (rep_email IS NULL AND LOWER(utm_source) = LOWER((
                SELECT name FROM unnest(ARRAY[${agentEmail}]::text[]) AS name LIMIT 1
              )))
            )
          ORDER BY created_at DESC
        `);
        // Simpler: just match by rep_email
        const result2 = await db.execute(sql`
          SELECT * FROM service_interests
          WHERE source = 'rep-referral'
            AND LOWER(rep_email) = ${agentEmail.toLowerCase()}
          ORDER BY created_at DESC
        `);
        rows = result2.rows;
      }
      res.json(rows);
    } catch (err: any) {
      console.error("[REP-REFERRALS] fetch error:", err);
      res.status(500).json({ error: "Failed to fetch referrals" });
    }
  });

  // PATCH /api/rep/website-referrals/:id/status — update referral status (admin only)
  app.patch("/api/rep/website-referrals/:id/status", async (req: Request, res: Response) => {
    if (!req.session.user?.isAuthenticated) return res.status(401).json({ error: "Auth required" });
    const { role } = req.session.user as any;
    if (role !== 'admin' && role !== 'underwriting') return res.status(403).json({ error: "Admin only" });
    try {
      const { id } = req.params;
      const { status } = req.body;
      if (!status) return res.status(400).json({ error: "Status required" });
      await db.execute(sql`UPDATE service_interests SET status = ${status} WHERE id = ${Number(id)}`);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: "Failed to update status" });
    }
  });

  // POST /api/processing/submit — public endpoint for credit card processing review requests
  app.post("/api/processing/submit", express.json({ limit: '30mb' }), async (req: Request, res: Response) => {
    try {
      const { firstName, lastName, email, phone, businessName, currentProcessor, monthlyVolume, fileBase64, fileName, fileMimeType } = req.body;
      if (!email) return res.status(400).json({ error: "Email is required" });
      const normalizedEmail = email.toLowerCase().trim();

      // Record service interest
      await db.execute(sql`INSERT INTO service_interests (email, first_name, last_name, phone, business_name, service, other_details, source)
        VALUES (${normalizedEmail}, ${firstName || null}, ${lastName || null}, ${phone || null}, ${businessName || null}, 'credit-card-processing',
          ${[currentProcessor && `Processor: ${currentProcessor}`, monthlyVolume && `Volume: ${monthlyVolume}`].filter(Boolean).join(' | ') || null},
          'processing-review'
        ) ON CONFLICT DO NOTHING`);

      console.log(`[PROCESSING] Review request from ${normalizedEmail} — ${businessName || 'no biz name'}`);

      // Upload file to Object Storage if provided
      if (fileBase64 && fileName) {
        try {
          const fileBuffer = Buffer.from(fileBase64, 'base64');
          if (objectStorage.isConfigured()) {
            const storedFileName = await objectStorage.uploadFile(fileBuffer, fileName, fileMimeType || 'application/pdf');
            const { randomBytes } = await import('crypto');
            const viewToken = randomBytes(32).toString('hex');
            await storage.createBankStatementUpload({
              email: normalizedEmail,
              businessName: businessName || null,
              loanApplicationId: null,
              originalFileName: fileName,
              storedFileName,
              mimeType: fileMimeType || 'application/pdf',
              fileSize: fileBuffer.length,
              source: 'credit-card-processing',
              viewToken,
              receivedAt: null,
              approvalStatus: null,
              approvalNotes: null,
              reviewedBy: null,
              reviewedAt: null,
              lenderId: null,
              lenderName: null,
            });
            console.log(`[PROCESSING] Statement stored for ${normalizedEmail}: ${storedFileName}`);
          }
        } catch (uploadErr) {
          console.warn('[PROCESSING] File upload failed (non-fatal):', uploadErr);
        }
      }

      // Send team notification email
      try {
        const details = [
          firstName || lastName ? `Name: ${[firstName, lastName].filter(Boolean).join(' ')}` : null,
          phone ? `Phone: ${phone}` : null,
          businessName ? `Business: ${businessName}` : null,
          currentProcessor ? `Current Processor: ${currentProcessor}` : null,
          monthlyVolume ? `Monthly Volume: ${monthlyVolume}` : null,
          fileBase64 ? `Statement: Uploaded (${fileName})` : 'Statement: Not uploaded',
        ].filter(Boolean).join('<br>');

        const html = `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;">
            <h2 style="color:#0f1729;margin-bottom:16px;">New Credit Card Processing Review Request</h2>
            <p style="color:#334155;font-size:15px;margin-bottom:20px;">A business has submitted a processing statement review request from the landing page.</p>
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:20px;font-size:14px;color:#334155;line-height:1.8;">
              <strong>Email:</strong> ${normalizedEmail}<br>${details}
            </div>
          </div>`;
        await sendMarketingNotification(`New Processing Review: ${normalizedEmail}`, html);
      } catch (emailErr) {
        console.warn('[PROCESSING] Notification email failed (non-fatal):', emailErr);
      }

      res.json({ success: true });
    } catch (err: any) {
      console.error('[PROCESSING] submit error:', err);
      res.status(500).json({ error: 'Failed to submit. Please try again.' });
    }
  });

  // Ensure website_contracts table exists with all columns
  try {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS website_contracts (
      id SERIAL PRIMARY KEY,
      token TEXT UNIQUE,
      status TEXT DEFAULT 'draft',
      effective_date TEXT,
      client_name TEXT,
      client_address TEXT,
      project_fee TEXT,
      hosting_option TEXT,
      tcg_printed_name TEXT,
      tcg_title TEXT,
      tcg_date TEXT,
      tcg_signature TEXT,
      tcg_signed_at TIMESTAMP,
      client_printed_name TEXT,
      client_title TEXT,
      client_company TEXT,
      client_date TEXT,
      client_signature TEXT,
      submitted_at TIMESTAMP DEFAULT NOW()
    )`);
    // Add missing columns and relax NOT NULL constraints for draft support
    const alterStmts = [
      `ALTER TABLE website_contracts ADD COLUMN IF NOT EXISTS token TEXT`,
      `ALTER TABLE website_contracts ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'draft'`,
      `ALTER TABLE website_contracts ADD COLUMN IF NOT EXISTS tcg_signature TEXT`,
      `ALTER TABLE website_contracts ADD COLUMN IF NOT EXISTS tcg_signed_at TIMESTAMP`,
      `ALTER TABLE website_contracts ADD COLUMN IF NOT EXISTS client_signature TEXT`,
      `ALTER TABLE website_contracts ALTER COLUMN client_name DROP NOT NULL`,
      `ALTER TABLE website_contracts ALTER COLUMN client_printed_name DROP NOT NULL`,
      `ALTER TABLE website_contracts ADD COLUMN IF NOT EXISTS name TEXT`,
    ];
    for (const stmt of alterStmts) {
      await db.execute(sql.raw(stmt)).catch(() => {});
    }
    // Add unique index on token separately (ADD COLUMN IF NOT EXISTS can't include UNIQUE)
    await db.execute(sql.raw(`CREATE UNIQUE INDEX IF NOT EXISTS website_contracts_token_idx ON website_contracts (token) WHERE token IS NOT NULL`)).catch(() => {});
  } catch (err) {
    console.error("[CONTRACT] Failed to ensure website_contracts table:", err);
  }

  // GET /api/contracts/website/list — list all contracts (admin/agent only)
  app.get("/api/contracts/website/list", async (req: Request, res: Response) => {
    if (!req.session.user?.isAuthenticated) return res.status(401).json({ error: "Authentication required" });
    const role = req.session.user.role;
    if (role !== 'admin' && role !== 'agent') return res.status(403).json({ error: "Access denied" });
    try {
      const result = await db.execute(sql`
        SELECT id, token, name, status, client_name, project_fee, submitted_at
        FROM website_contracts
        ORDER BY submitted_at DESC
        LIMIT 200
      `);
      res.json(result.rows.map((r: any) => ({
        id: r.id,
        token: r.token,
        name: r.name,
        status: r.status,
        clientName: r.client_name,
        projectFee: r.project_fee,
        submittedAt: r.submitted_at,
      })));
    } catch (err: any) {
      console.error("[CONTRACT] list error:", err);
      res.status(500).json({ error: "Failed to load agreements" });
    }
  });

  // GET /api/contracts/website/draft/:token — load a saved draft
  app.get("/api/contracts/website/draft/:token", async (req: Request, res: Response) => {
    try {
      const { token } = req.params;
      const result = await db.execute(sql`
        SELECT effective_date, client_name, client_address, project_fee, hosting_option,
               tcg_printed_name, tcg_title, tcg_date, tcg_signed_at,
               client_printed_name, client_title, client_company, client_date, status, name
        FROM website_contracts WHERE token = ${token} LIMIT 1
      `);
      if (!result.rows.length) return res.status(404).json({ error: "Not found" });
      const r = result.rows[0] as any;
      res.json({
        effectiveDate: r.effective_date,
        clientName: r.client_name,
        clientAddress: r.client_address,
        projectFee: r.project_fee,
        hostingOption: r.hosting_option,
        tcgPrintedName: r.tcg_printed_name,
        tcgTitle: r.tcg_title,
        tcgDate: r.tcg_date,
        tcgSignedAt: r.tcg_signed_at,
        clientPrintedName: r.client_printed_name,
        clientTitle: r.client_title,
        clientCompany: r.client_company,
        clientDate: r.client_date,
        status: r.status,
        name: r.name,
      });
    } catch (err: any) {
      console.error("[CONTRACT] draft load error:", err);
      res.status(500).json({ error: "Failed to load draft" });
    }
  });

  // POST /api/contracts/website/draft — create or update a draft, return token
  app.post("/api/contracts/website/draft", async (req: Request, res: Response) => {
    try {
      const {
        token: existingToken,
        name,
        effectiveDate, clientName, clientAddress, projectFee, hostingOption,
        tcgPrintedName, tcgTitle, tcgDate, tcgSignature,
        clientPrintedName, clientTitle, clientCompany, clientDate, clientSignature,
      } = req.body;

      const hasTcgSig = !!(tcgSignature && tcgSignature.length > 0);
      const hasClientSig = !!(clientSignature && clientSignature.length > 0);

      if (existingToken) {
        // Update existing draft
        await db.execute(sql`
          UPDATE website_contracts SET
            name = COALESCE(${name || null}, name),
            effective_date = ${effectiveDate || null},
            client_name = ${clientName || null},
            client_address = ${clientAddress || null},
            project_fee = ${projectFee || null},
            hosting_option = ${hostingOption || null},
            tcg_printed_name = ${tcgPrintedName || null},
            tcg_title = ${tcgTitle || null},
            tcg_date = ${tcgDate || null},
            tcg_signature = COALESCE(${hasTcgSig ? tcgSignature : null}, tcg_signature),
            tcg_signed_at = CASE WHEN ${hasTcgSig} AND tcg_signed_at IS NULL THEN NOW() ELSE tcg_signed_at END,
            client_printed_name = ${clientPrintedName || null},
            client_title = ${clientTitle || null},
            client_company = ${clientCompany || null},
            client_date = ${clientDate || null},
            client_signature = COALESCE(${hasClientSig ? clientSignature : null}, client_signature)
          WHERE token = ${existingToken}
        `);
        res.json({ token: existingToken });
      } else {
        // Create new draft with unique token
        const newToken = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
        await db.execute(sql`
          INSERT INTO website_contracts (
            token, status, name, effective_date, client_name, client_address, project_fee, hosting_option,
            tcg_printed_name, tcg_title, tcg_date, tcg_signature, tcg_signed_at,
            client_printed_name, client_title, client_company, client_date, client_signature
          ) VALUES (
            ${newToken}, 'draft', ${name || null},
            ${effectiveDate || null}, ${clientName || null}, ${clientAddress || null},
            ${projectFee || null}, ${hostingOption || null},
            ${tcgPrintedName || null}, ${tcgTitle || null}, ${tcgDate || null},
            ${hasTcgSig ? tcgSignature : null},
            ${hasTcgSig ? sql`NOW()` : null},
            ${clientPrintedName || null}, ${clientTitle || null}, ${clientCompany || null},
            ${clientDate || null}, ${hasClientSig ? clientSignature : null}
          )
        `);
        res.json({ token: newToken });
      }
    } catch (err: any) {
      console.error("[CONTRACT] draft save error:", err);
      res.status(500).json({ error: "Failed to save draft" });
    }
  });

  // POST /api/contracts/website — finalize a signed agreement
  app.post("/api/contracts/website", async (req: Request, res: Response) => {
    try {
      const {
        token: existingToken,
        name,
        effectiveDate, clientName, clientAddress, projectFee, hostingOption,
        tcgPrintedName, tcgTitle, tcgDate, tcgSignature,
        clientPrintedName, clientTitle, clientCompany, clientDate, clientSignature,
      } = req.body;

      if (!clientName || !clientPrintedName) {
        return res.status(400).json({ error: "Client name and printed name are required" });
      }

      const hasTcgSig = !!(tcgSignature && tcgSignature.length > 0);
      const hasClientSig = !!(clientSignature && clientSignature.length > 0);

      if (existingToken) {
        // Update existing record and mark complete
        await db.execute(sql`
          UPDATE website_contracts SET
            status = 'complete',
            name = COALESCE(${name || null}, name),
            effective_date = ${effectiveDate || null},
            client_name = ${clientName},
            client_address = ${clientAddress || null},
            project_fee = ${projectFee || null},
            hosting_option = ${hostingOption || null},
            tcg_printed_name = ${tcgPrintedName || null},
            tcg_title = ${tcgTitle || null},
            tcg_date = ${tcgDate || null},
            tcg_signature = COALESCE(${hasTcgSig ? tcgSignature : null}, tcg_signature),
            tcg_signed_at = CASE WHEN ${hasTcgSig} AND tcg_signed_at IS NULL THEN NOW() ELSE tcg_signed_at END,
            client_printed_name = ${clientPrintedName},
            client_title = ${clientTitle || null},
            client_company = ${clientCompany || null},
            client_date = ${clientDate || null},
            client_signature = COALESCE(${hasClientSig ? clientSignature : null}, client_signature),
            submitted_at = NOW()
          WHERE token = ${existingToken}
        `);
      } else {
        // New submission without a prior draft
        await db.execute(sql`
          INSERT INTO website_contracts (
            status, name, effective_date, client_name, client_address, project_fee, hosting_option,
            tcg_printed_name, tcg_title, tcg_date, tcg_signature, tcg_signed_at,
            client_printed_name, client_title, client_company, client_date, client_signature,
            submitted_at
          ) VALUES (
            'complete', ${name || null}, ${effectiveDate || null}, ${clientName}, ${clientAddress || null},
            ${projectFee || null}, ${hostingOption || null},
            ${tcgPrintedName || null}, ${tcgTitle || null}, ${tcgDate || null},
            ${hasTcgSig ? tcgSignature : null}, ${hasTcgSig ? sql`NOW()` : null},
            ${clientPrintedName}, ${clientTitle || null}, ${clientCompany || null},
            ${clientDate || null}, ${hasClientSig ? clientSignature : null}, NOW()
          )
        `);
      }

      // Email notification
      const subject = `[Website Contract] Signed Agreement — ${clientName}`;
      const html = `
        <h2 style="color:#1e40af;">Website Build Services Agreement Submitted</h2>
        <table style="border-collapse:collapse;width:100%;font-family:sans-serif;font-size:14px;">
          <tr><td style="padding:6px 12px;font-weight:bold;color:#555;width:180px;">Effective Date</td><td style="padding:6px 12px;">${effectiveDate || '—'}</td></tr>
          <tr style="background:#f8faff;"><td style="padding:6px 12px;font-weight:bold;color:#555;">Client Name</td><td style="padding:6px 12px;">${clientName}</td></tr>
          <tr><td style="padding:6px 12px;font-weight:bold;color:#555;">Client Address</td><td style="padding:6px 12px;">${clientAddress || '—'}</td></tr>
          <tr style="background:#f8faff;"><td style="padding:6px 12px;font-weight:bold;color:#555;">Project Fee</td><td style="padding:6px 12px;">${projectFee ? '$' + projectFee : '—'}</td></tr>
          <tr><td style="padding:6px 12px;font-weight:bold;color:#555;">Hosting Option</td><td style="padding:6px 12px;">${hostingOption ? 'Option ' + hostingOption : '—'}</td></tr>
          <tr style="background:#f8faff;"><td style="padding:6px 12px;font-weight:bold;color:#555;">TCG Signer</td><td style="padding:6px 12px;">${tcgPrintedName || '—'} — ${tcgTitle || '—'}</td></tr>
          <tr><td style="padding:6px 12px;font-weight:bold;color:#555;">Client Signer</td><td style="padding:6px 12px;">${clientPrintedName} — ${clientTitle || '—'}</td></tr>
          <tr style="background:#f8faff;"><td style="padding:6px 12px;font-weight:bold;color:#555;">Client Company</td><td style="padding:6px 12px;">${clientCompany || '—'}</td></tr>
          <tr><td style="padding:6px 12px;font-weight:bold;color:#555;">Client Date</td><td style="padding:6px 12px;">${clientDate || '—'}</td></tr>
        </table>
        <p style="margin-top:20px;font-size:12px;color:#888;">Submitted via /services/website/contract</p>
      `;
      sendMarketingNotification(subject, html).catch(() => {});

      console.log(`[CONTRACT] Website agreement signed by ${clientName} / ${clientPrintedName}`);
      res.json({ success: true });
    } catch (err: any) {
      console.error("[CONTRACT] website contract error:", err);
      res.status(500).json({ error: "Failed to save contract" });
    }
  });

  // GET /api/services/interests — admin view of all interest clicks
  app.get("/api/services/interests", async (req: Request, res: Response) => {
    if (!req.session.user?.isAuthenticated || req.session.user.role === 'merchant' || req.session.user.role === 'lead') {
      return res.status(401).json({ error: "Admin access required" });
    }
    try {
      const result = await db.execute(sql`
        SELECT service, COUNT(*) as clicks, COUNT(DISTINCT email) as unique_contacts,
          array_agg(DISTINCT email ORDER BY email) as emails
        FROM service_interests
        GROUP BY service
        ORDER BY clicks DESC
      `);
      const recent = await db.execute(sql`SELECT * FROM service_interests ORDER BY created_at DESC`);
      res.json({ summary: result.rows, recent: recent.rows });
    } catch (err: any) {
      console.error("[SERVICES] interests fetch error:", err);
      res.status(500).json({ error: "Failed to fetch interests" });
    }
  });

  // GET /api/services/lookup — lookup contact info from loan_applications by email (for pre-filling)
  app.get("/api/services/lookup", async (req: Request, res: Response) => {
    const email = (req.query.email as string || "").toLowerCase().trim();
    if (!email) return res.json({});
    try {
      const result = await db.execute(sql`SELECT full_name, phone, business_name FROM loan_applications WHERE email = ${email} ORDER BY created_at DESC LIMIT 1`);
      if (result.rows.length > 0) {
        const r = result.rows[0] as any;
        const parts = (r.full_name || "").trim().split(/\s+/);
        res.json({ firstName: parts[0] || "", lastName: parts.slice(1).join(" ") || "", phone: r.phone || "", businessName: r.business_name || "" });
      } else {
        res.json({});
      }
    } catch (_) {
      res.json({});
    }
  });

  // ========================================
  // ANALYTICS DASHBOARD API
  // ========================================

  // GET /api/analytics/overview — top-level KPIs
  app.get("/api/analytics/overview", async (req: Request, res: Response) => {
    if (!req.session.user?.isAuthenticated || req.session.user.role === 'merchant' || req.session.user.role === 'lead') {
      return res.status(401).json({ error: "Admin access required" });
    }
    try {
      const [apps, decisions, statements, funded] = await Promise.all([
        db.execute(sql`SELECT COUNT(*) as total, COUNT(CASE WHEN created_at >= NOW() - INTERVAL '7 days' THEN 1 END) as week, COUNT(CASE WHEN created_at >= NOW() - INTERVAL '30 days' THEN 1 END) as month FROM loan_applications`),
        db.execute(sql`SELECT status, COUNT(*) as c, COALESCE(SUM(advance_amount::numeric), 0) as total_value FROM business_underwriting_decisions GROUP BY status`),
        db.execute(sql`SELECT COUNT(*) as total, COUNT(CASE WHEN created_at >= NOW() - INTERVAL '7 days' THEN 1 END) as week FROM bank_statement_uploads`),
        db.execute(sql`SELECT COALESCE(SUM(advance_amount::numeric), 0) as total_funded, COUNT(*) as count, COALESCE(AVG(advance_amount::numeric), 0) as avg_deal FROM business_underwriting_decisions WHERE status = 'funded'`),
      ]);

      const statusMap: Record<string, { count: number; value: number }> = {};
      for (const r of decisions.rows as any[]) {
        statusMap[r.status] = { count: Number(r.c), value: Number(r.total_value) };
      }

      const appRow = apps.rows[0] as any;
      const fundedRow = funded.rows[0] as any;
      const stmtRow = statements.rows[0] as any;

      res.json({
        applications: { total: Number(appRow.total), thisWeek: Number(appRow.week), thisMonth: Number(appRow.month) },
        pipeline: {
          approved: statusMap.approved || { count: 0, value: 0 },
          funded: statusMap.funded || { count: 0, value: 0 },
          declined: statusMap.declined || { count: 0, value: 0 },
          unqualified: statusMap.unqualified || { count: 0, value: 0 },
        },
        statements: { total: Number(stmtRow.total), thisWeek: Number(stmtRow.week) },
        funding: { totalFunded: Number(fundedRow.total_funded), dealCount: Number(fundedRow.count), avgDeal: Number(fundedRow.avg_deal) },
      });
    } catch (err: any) {
      console.error("[ANALYTICS] overview error:", err);
      res.status(500).json({ error: "Failed to load analytics" });
    }
  });

  // GET /api/analytics/timeline — weekly/monthly deal flow over time
  app.get("/api/analytics/timeline", async (req: Request, res: Response) => {
    if (!req.session.user?.isAuthenticated || req.session.user.role === 'merchant' || req.session.user.role === 'lead') {
      return res.status(401).json({ error: "Admin access required" });
    }
    try {
      const [appsByWeek, decisionsByWeek, fundedByWeek] = await Promise.all([
        db.execute(sql`SELECT DATE_TRUNC('week', created_at) as week, COUNT(*) as c FROM loan_applications WHERE created_at >= NOW() - INTERVAL '6 months' GROUP BY week ORDER BY week`),
        db.execute(sql`SELECT DATE_TRUNC('week', created_at) as week, status, COUNT(*) as c, COALESCE(SUM(advance_amount::numeric), 0) as value FROM business_underwriting_decisions WHERE created_at >= NOW() - INTERVAL '6 months' GROUP BY week, status ORDER BY week`),
        db.execute(sql`SELECT DATE_TRUNC('month', COALESCE(funded_date::timestamp, created_at)) as month, COUNT(*) as c, COALESCE(SUM(advance_amount::numeric), 0) as value FROM business_underwriting_decisions WHERE status = 'funded' AND created_at >= NOW() - INTERVAL '12 months' GROUP BY month ORDER BY month`),
      ]);

      res.json({
        applicationsByWeek: appsByWeek.rows,
        decisionsByWeek: decisionsByWeek.rows,
        fundedByMonth: fundedByWeek.rows,
      });
    } catch (err: any) {
      console.error("[ANALYTICS] timeline error:", err);
      res.status(500).json({ error: "Failed to load timeline" });
    }
  });

  // GET /api/analytics/reps — rep performance comparison
  app.get("/api/analytics/reps", async (req: Request, res: Response) => {
    if (!req.session.user?.isAuthenticated || req.session.user.role === 'merchant' || req.session.user.role === 'lead') {
      return res.status(401).json({ error: "Admin access required" });
    }
    try {
      const result = await db.execute(sql`
        SELECT
          COALESCE(assigned_rep, 'Unassigned') as rep,
          COUNT(*) as total_deals,
          COUNT(CASE WHEN status = 'approved' THEN 1 END) as approved,
          COUNT(CASE WHEN status = 'funded' THEN 1 END) as funded,
          COUNT(CASE WHEN status = 'declined' THEN 1 END) as declined,
          COUNT(CASE WHEN status = 'unqualified' THEN 1 END) as unqualified,
          COALESCE(SUM(CASE WHEN status = 'funded' THEN advance_amount::numeric END), 0) as funded_value,
          COALESCE(SUM(CASE WHEN status = 'approved' THEN advance_amount::numeric END), 0) as approved_value,
          COALESCE(AVG(CASE WHEN status = 'funded' THEN advance_amount::numeric END), 0) as avg_funded_deal,
          ROUND(COUNT(CASE WHEN status = 'funded' THEN 1 END)::numeric / NULLIF(COUNT(*)::numeric, 0) * 100, 1) as close_rate
        FROM business_underwriting_decisions
        GROUP BY assigned_rep
        ORDER BY funded_value DESC
      `);
      res.json(result.rows);
    } catch (err: any) {
      console.error("[ANALYTICS] reps error:", err);
      res.status(500).json({ error: "Failed to load rep data" });
    }
  });

  // GET /api/analytics/lenders — lender breakdown
  app.get("/api/analytics/lenders", async (req: Request, res: Response) => {
    if (!req.session.user?.isAuthenticated || req.session.user.role === 'merchant' || req.session.user.role === 'lead') {
      return res.status(401).json({ error: "Admin access required" });
    }
    try {
      const result = await db.execute(sql`
        SELECT
          COALESCE(lender, 'Unknown') as lender,
          COUNT(*) as total,
          COUNT(CASE WHEN status = 'funded' THEN 1 END) as funded,
          COUNT(CASE WHEN status = 'approved' THEN 1 END) as approved,
          COALESCE(SUM(CASE WHEN status = 'funded' THEN advance_amount::numeric END), 0) as funded_value,
          COALESCE(SUM(CASE WHEN status = 'approved' THEN advance_amount::numeric END), 0) as approved_value
        FROM business_underwriting_decisions
        WHERE lender IS NOT NULL AND lender != ''
        GROUP BY lender
        ORDER BY funded_value DESC
        LIMIT 20
      `);
      res.json(result.rows);
    } catch (err: any) {
      console.error("[ANALYTICS] lenders error:", err);
      res.status(500).json({ error: "Failed to load lender data" });
    }
  });

  // GET /api/analytics/recent — recent activity feed
  app.get("/api/analytics/recent", async (req: Request, res: Response) => {
    if (!req.session.user?.isAuthenticated || req.session.user.role === 'merchant' || req.session.user.role === 'lead') {
      return res.status(401).json({ error: "Admin access required" });
    }
    try {
      const result = await db.execute(sql`
        SELECT id, business_name, business_email, status, advance_amount, lender, assigned_rep, created_at, funded_date
        FROM business_underwriting_decisions
        ORDER BY created_at DESC
        LIMIT 25
      `);
      res.json(result.rows);
    } catch (err: any) {
      console.error("[ANALYTICS] recent error:", err);
      res.status(500).json({ error: "Failed to load recent activity" });
    }
  });

  // ========================================
  // LEAD PORTAL ROUTES
  // ========================================

  // Ensure lead tables exist
  try {
    await db.execute(sql`CREATE TABLE IF NOT EXISTS lead_portal_accounts (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT,
      first_name TEXT,
      last_name TEXT,
      phone TEXT,
      business_name TEXT,
      industry TEXT,
      monthly_revenue TEXT,
      time_in_business TEXT,
      referral_source TEXT,
      qualification_score INTEGER,
      qualification_tier TEXT,
      is_qualified BOOLEAN DEFAULT false,
      assigned_rep TEXT,
      notes TEXT,
      status TEXT DEFAULT 'active',
      last_active_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    await db.execute(sql`ALTER TABLE lead_portal_accounts ADD COLUMN IF NOT EXISTS referral_code TEXT`);
    await db.execute(sql`ALTER TABLE lead_portal_accounts ADD COLUMN IF NOT EXISTS onboarding_step TEXT DEFAULT 'add_position'`);
    await db.execute(sql`ALTER TABLE lead_portal_accounts ADD COLUMN IF NOT EXISTS qualified_at TIMESTAMP`);
    await db.execute(sql`ALTER TABLE lead_portal_accounts ADD COLUMN IF NOT EXISTS qualified_notified_at TIMESTAMP`);
    await db.execute(sql`ALTER TABLE lead_portal_accounts ADD COLUMN IF NOT EXISTS nurture_steps_sent TEXT`);
    await db.execute(sql`ALTER TABLE lead_portal_accounts ADD COLUMN IF NOT EXISTS referred_by TEXT`);
    await db.execute(sql`CREATE TABLE IF NOT EXISTS lead_positions (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_email TEXT NOT NULL,
      funder_name TEXT NOT NULL,
      product_type TEXT,
      funded_amount DECIMAL(12,2),
      payback_amount DECIMAL(12,2),
      factor_rate TEXT,
      payment_amount DECIMAL(12,2),
      payment_frequency TEXT,
      funded_date TEXT,
      estimated_payoff_date TEXT,
      remaining_balance DECIMAL(12,2),
      status TEXT DEFAULT 'active',
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )`);
    await db.execute(sql`CREATE TABLE IF NOT EXISTS lead_otp_codes (
      phone TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      email TEXT NOT NULL,
      attempts INTEGER DEFAULT 0,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    console.log("[LEAD] Lead portal tables ensured");
  } catch (err) {
    console.error("[LEAD] Failed to ensure lead tables:", err);
  }

  // Helper: get lead email from session
  function getLeadEmail(req: Request): string | null {
    if (req.session.user?.isAuthenticated && req.session.user.role === 'lead' && req.session.user.merchantEmail) {
      return req.session.user.merchantEmail;
    }
    return null;
  }

  // GET /api/lead/public-stats — real numbers for the /track signup page (cached 1h)
  let _leadPublicStatsCache: { data: { businesses: number; totalTracked: number }; at: number } | null = null;
  app.get("/api/lead/public-stats", async (_req: Request, res: Response) => {
    try {
      if (_leadPublicStatsCache && Date.now() - _leadPublicStatsCache.at < 60 * 60 * 1000) {
        return res.json(_leadPublicStatsCache.data);
      }
      const [accounts, fundedBiz, posSum, fundedSum] = await Promise.all([
        db.execute(sql`SELECT COUNT(*)::int AS c FROM lead_portal_accounts`),
        db.execute(sql`SELECT COUNT(DISTINCT business_email)::int AS c FROM business_underwriting_decisions
          WHERE status = 'funded' OR (jsonb_typeof(additional_fundings) = 'array' AND jsonb_array_length(additional_fundings) > 0)`),
        db.execute(sql`SELECT COALESCE(SUM(COALESCE(payback_amount, funded_amount)), 0)::numeric AS s FROM lead_positions`),
        db.execute(sql`SELECT COALESCE(SUM(NULLIF(REGEXP_REPLACE(f->>'advanceAmount', '[^0-9.]', '', 'g'), '')::numeric), 0) AS s
          FROM business_underwriting_decisions d,
          LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(d.additional_fundings) = 'array' THEN d.additional_fundings ELSE '[]'::jsonb END) f`),
      ]);
      const data = {
        businesses: Number((accounts.rows[0] as any)?.c || 0) + Number((fundedBiz.rows[0] as any)?.c || 0),
        totalTracked: Number((posSum.rows[0] as any)?.s || 0) + Number((fundedSum.rows[0] as any)?.s || 0),
      };
      _leadPublicStatsCache = { data, at: Date.now() };
      res.json(data);
    } catch (err: any) {
      console.error("[LEAD] public-stats error:", err);
      res.status(500).json({ error: "Failed to load stats" });
    }
  });

  // POST /api/lead/signup
  app.post("/api/lead/signup", async (req: Request, res: Response) => {
    try {
      const { email, firstName, lastName, phone, businessName, referralCode } = req.body;
      if (!email) return res.status(400).json({ error: "Email is required" });

      const normalizedEmail = email.toLowerCase().trim();

      // Check if account already exists
      const existing = await db.execute(sql`SELECT id FROM lead_portal_accounts WHERE email = ${normalizedEmail}`);
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: "An account with this email already exists. Try signing in." });
      }

      // Passwordless signup — sign-in happens via SMS OTP. Each account gets its
      // own referral code; referred_by records the code they arrived through.
      const ownReferralCode = randomBytes(4).toString("hex");
      try {
        await db.execute(sql`INSERT INTO lead_portal_accounts (email, password_hash, first_name, last_name, phone, business_name, referral_code, referred_by)
          VALUES (${normalizedEmail}, ${null}, ${firstName || null}, ${lastName || null}, ${phone || null}, ${businessName || null}, ${ownReferralCode}, ${referralCode || null})`);
      } catch {
        // Fallback for a DB missing the newer referral columns
        await db.execute(sql`INSERT INTO lead_portal_accounts (email, password_hash, first_name, last_name, phone, business_name)
          VALUES (${normalizedEmail}, ${null}, ${firstName || null}, ${lastName || null}, ${phone || null}, ${businessName || null})`);
      }

      // Auto-login
      req.session.user = {
        isAuthenticated: true,
        role: 'lead',
        merchantEmail: normalizedEmail,
        merchantName: [firstName, lastName].filter(Boolean).join(" ") || undefined,
      };

      logPortalEvent('lead', normalizedEmail, 'signup', referralCode ? `ref:${referralCode}` : undefined);
      const { subject: leadSub, html: leadHtml } = buildLeadPortalSignupEmail({ email: normalizedEmail, firstName, lastName, phone, businessName });
      sendMarketingNotification(leadSub, leadHtml).catch(() => {});

      res.json({ success: true });
    } catch (err: any) {
      console.error("[LEAD] signup error:", err);
      res.status(500).json({ error: "Signup failed. Please try again." });
    }
  });

  // GET /api/lead/auth/check
  app.get("/api/lead/auth/check", async (req: Request, res: Response) => {
    if (req.session.user?.isAuthenticated && req.session.user.role === 'lead' && req.session.user.merchantEmail) {
      try {
        // Try full query first (includes columns added in later migrations)
        const result = await db.execute(sql`SELECT first_name, last_name, business_name, password_hash, referral_code, onboarding_step FROM lead_portal_accounts WHERE email = ${req.session.user.merchantEmail}`);
        const row = result.rows[0] as any;
        // Backfill a referral code for accounts created before codes existed
        let referralCode = row?.referral_code || "";
        if (row && !referralCode) {
          referralCode = randomBytes(4).toString("hex");
          await db.execute(sql`UPDATE lead_portal_accounts SET referral_code = ${referralCode} WHERE email = ${req.session.user.merchantEmail}`);
        }
        return res.json({
          isAuthenticated: true,
          email: req.session.user.merchantEmail,
          name: row ? [row.first_name, row.last_name].filter(Boolean).join(" ") : req.session.user.merchantName,
          businessName: row?.business_name || "",
          hasPassword: !!row?.password_hash,
          referralCode,
          onboardingStep: row?.onboarding_step || "add_position",
        });
      } catch (err: any) {
        // Fallback: query only the base columns (handles production DBs missing newer columns)
        try {
          const result = await db.execute(sql`SELECT first_name, last_name, business_name, password_hash FROM lead_portal_accounts WHERE email = ${req.session.user.merchantEmail}`);
          const row = result.rows[0] as any;
          return res.json({
            isAuthenticated: true,
            email: req.session.user.merchantEmail,
            name: row ? [row.first_name, row.last_name].filter(Boolean).join(" ") : req.session.user.merchantName,
            businessName: row?.business_name || "",
            hasPassword: !!row?.password_hash,
            referralCode: "",
            onboardingStep: "add_position",
          });
        } catch (err2: any) {
          console.error("[LEAD] auth/check fallback query failed:", err2);
          return res.json({
            isAuthenticated: true,
            email: req.session.user.merchantEmail,
            name: req.session.user.merchantName || "",
            businessName: "",
            hasPassword: false,
            referralCode: "",
            onboardingStep: "add_position",
          });
        }
      }
    } else {
      res.json({ isAuthenticated: false });
    }
  });

  // POST /api/lead/auth/logout
  app.post("/api/lead/auth/logout", (req: Request, res: Response) => {
    req.session.destroy(() => {});
    res.json({ success: true });
  });

  // ── ADMIN /track PREVIEW ──
  // GET /api/admin/lead-portal/preview?email=... — one-click staff link that signs
  // the browser into the lead's /track portal as that merchant. Requires an active
  // staff session (log into the dashboard first, same browser). The staff session
  // is stashed and can be restored via /api/admin/lead-portal/exit-preview.
  app.get("/api/admin/lead-portal/preview", async (req: Request, res: Response) => {
    const user = req.session.user;
    if (!user?.isAuthenticated || (user.role !== 'admin' && user.role !== 'underwriting' && user.role !== 'agent')) {
      // Session cookies are SameSite=Strict in production, so a link clicked from
      // Excel/Sheets/email arrives without the cookie. Self-redirect once — that
      // navigation is same-site, so the cookie comes through on the retry.
      if (!req.query.r) {
        const qs = new URLSearchParams({ email: String(req.query.email || ''), r: '1' }).toString();
        return res.status(200).send(`<!doctype html><meta http-equiv="refresh" content="0;url=/api/admin/lead-portal/preview?${qs}"><script>location.replace("/api/admin/lead-portal/preview?${qs}")</script>Opening portal…`);
      }
      return res.status(403).send("Log in to the admin dashboard in this browser first, then click the link again.");
    }
    const email = String(req.query.email || '').trim().toLowerCase();
    if (!email) return res.status(400).send("email query param required");
    try {
      const result = await db.execute(sql`SELECT email, first_name, last_name FROM lead_portal_accounts WHERE LOWER(email) = ${email} LIMIT 1`);
      if (result.rows.length === 0) return res.status(404).send(`No /track account found for ${email}`);
      const row = result.rows[0] as any;
      req.session.staffBackup = { ...user };
      req.session.user = {
        isAuthenticated: true,
        role: 'lead',
        merchantEmail: (row.email as string).toLowerCase(),
        merchantName: [row.first_name, row.last_name].filter(Boolean).join(' ') || undefined,
      };
      console.log(`[LEAD] Admin preview of /track for ${email} by ${user.agentEmail || 'admin'}`);
      res.redirect("/track");
    } catch (err) {
      console.error("[LEAD] admin preview error:", err);
      res.status(500).send("Failed to open preview");
    }
  });

  // GET /api/admin/lead-portal/exit-preview — restore the stashed staff session
  app.get("/api/admin/lead-portal/exit-preview", (req: Request, res: Response) => {
    if (req.session.staffBackup) {
      req.session.user = req.session.staffBackup;
      delete req.session.staffBackup;
      return res.redirect("/dashboard");
    }
    res.redirect("/");
  });

  // ── EMAIL CLICK → SALESFORCE WEBHOOKS (GHL workflow + Mailgun events) ──
  const EMAIL_CLICK_WEBHOOK_KEY = process.env.EMAIL_CLICK_WEBHOOK_KEY || "tcg-clk-7f3kq9vw2m";
  const SF_REP_VALUES = ["Dillon LeBlanc", "Julius Speck", "Kenny Nwobi", "Gregory Dergevorkian", "Bryce Jennings", "Lucas Bishop", "Justin Neumann", "Sean Pimentel", "Matthew Abajian"];

  // Map a free-form rep hint (GHL user name, list value, email) onto the SF picklist roster
  function normalizeRepName(raw?: string | null): string | undefined {
    if (!raw) return undefined;
    const r = String(raw).trim().toLowerCase();
    if (!r) return undefined;
    for (const v of SF_REP_VALUES) {
      const [first, last] = v.toLowerCase().split(" ");
      if (r === v.toLowerCase() || r.includes(last) || (first.length > 3 && r.includes(first))) return v;
    }
    return undefined;
  }

  // Rep cascade for clickers not yet in SF: live GHL owner → uploaded rep list → prior application attribution
  async function resolveRepForEmail(email: string, phone?: string): Promise<string | undefined> {
    const lower = email.toLowerCase();
    try {
      const owner = await ghlService.resolveOwnerRepName(phone || null, email);
      const n = normalizeRepName(owner?.repName);
      if (n) return n;
    } catch {}
    try {
      const r = await db.execute(sql`SELECT rep FROM email_click_rep_list WHERE LOWER(email) = ${lower} LIMIT 1`);
      const n = normalizeRepName((r.rows[0] as any)?.rep);
      if (n) return n;
    } catch {}
    try {
      const r = await db.execute(sql`SELECT agent_name FROM loan_applications WHERE LOWER(email) = ${lower} AND agent_name IS NOT NULL ORDER BY created_at DESC LIMIT 1`);
      const n = normalizeRepName((r.rows[0] as any)?.agent_name);
      if (n) return n;
    } catch {}
    return undefined;
  }

  // GHL workflow webhook fired when a lead gets (re)assigned. Doesn't trust the
  // payload's rep — looks up the contact's CURRENT owner live from GHL, then
  // mirrors it to the CLC application record and Salesforce (Lead + Opportunity).
  app.post("/api/webhooks/ghl/assignment", async (req: Request, res: Response) => {
    if ((req.query.key as string) !== EMAIL_CLICK_WEBHOOK_KEY) return res.status(403).json({ error: "bad key" });
    try {
      const b: any = req.body || {};
      const c: any = b.contact || b;
      const email = String(b.email || c.email || "").trim().toLowerCase();
      const phone = String(b.phone || c.phone || "").trim();
      if (!email && !phone) return res.status(400).json({ error: "no email or phone in payload" });

      // Rep comes from the webhook payload. Accept a name from the usual fields,
      // or a GHL user id (mapped through the agents registry). Live GHL lookup
      // only as a last resort when the payload carries nothing.
      let repName = String(b.rep || b.assigned_user_name || b.user?.name || c.assigned_user_name || b.customData?.rep || "").trim();
      let repEmail = String(b.assigned_user_email || b.user?.email || "").trim();
      let repGhlId = String(b.assignedTo || c.assignedTo || b.assigned_to || "").trim();
      if (!repName && repGhlId) {
        const a = AGENTS.find(x => x.ghlId && x.ghlId === repGhlId);
        if (a) { repName = a.name; repEmail = repEmail || a.email; }
      }
      if (!repName) {
        const owner = await ghlService.resolveOwnerRepName(phone || null, email || null);
        if (owner?.repName) { repName = owner.repName; repEmail = repEmail || owner.repEmail || ""; repGhlId = repGhlId || owner.userId || ""; }
      }
      if (!repName) {
        console.log(`[GHL-ASSIGN] ${email || phone}: no rep in payload or GHL — nothing to sync`);
        return res.json({ synced: false, reason: "no rep info" });
      }
      const owner = { repName, repEmail, userId: repGhlId };
      const sfRep = normalizeRepName(owner.repName);

      // CLC: stamp agent fields on the matching application(s)
      let clcUpdated = 0;
      if (email) {
        const r = await db.execute(sql`UPDATE loan_applications
          SET agent_name = ${owner.repName}, agent_email = ${owner.repEmail || null}, agent_ghl_id = ${owner.userId || null}
          WHERE LOWER(email) = ${email}`);
        clcUpdated = (r as any).rowCount ?? 0;
        await db.execute(sql`UPDATE business_underwriting_decisions
          SET assigned_rep = ${sfRep || owner.repName}, updated_at = NOW()
          WHERE LOWER(business_email) = ${email} AND (assigned_rep IS NULL OR assigned_rep != ${sfRep || owner.repName})`).catch(() => {});
      }

      // Salesforce: mirror onto Lead + Opportunity
      let sfResult: any = { skipped: "rep not on SF picklist" };
      if (sfRep && email) {
        sfResult = await syncRepAssignmentToSalesforce(email, sfRep);
      }
      console.log(`[GHL-ASSIGN] ${email || phone} -> ${owner.repName}${sfRep ? ` (SF: ${sfRep})` : " (no SF picklist match)"} | clc apps: ${clcUpdated} | sf:`, sfResult);
      res.json({ synced: true, rep: owner.repName, sfRep: sfRep || null, clcUpdated, sf: sfResult });
    } catch (e: any) {
      console.error("[GHL-ASSIGN] handler error:", e);
      res.status(500).json({ error: e.message });
    }
  });

  // GHL workflow "Custom Webhook" step → POST here (?key= shared secret)
  app.post("/api/webhooks/ghl/email-click", async (req: Request, res: Response) => {
    if ((req.query.key as string) !== EMAIL_CLICK_WEBHOOK_KEY) return res.status(403).json({ error: "bad key" });
    try {
      const b: any = req.body || {};
      const c: any = b.contact || b;
      const email = String(b.email || c.email || "").trim();
      if (!email || !email.includes("@")) return res.status(400).json({ error: "no email in payload" });
      const rep = normalizeRepName(b.rep || b.assigned_user_name || b.user?.name || c.assigned_user_name)
        || await resolveRepForEmail(email, b.phone || c.phone);
      const out = await recordEmailClickInSalesforce({
        email,
        source: "ghl",
        campaign: b.campaign || b.email_name || b.workflow?.name || "GHL email",
        url: b.link || b.url,
        firstName: b.first_name || c.first_name || c.firstName,
        lastName: b.last_name || c.last_name || c.lastName,
        phone: b.phone || c.phone,
        businessName: b.company_name || c.company_name || c.companyName,
        rep,
      });
      console.log(`[EMAIL-CLICK] ghl ${email} -> ${out.result}${out.error ? ` (${out.error})` : ""}`);
      res.json(out);
    } catch (e: any) {
      console.error("[EMAIL-CLICK] ghl handler error:", e);
      res.status(500).json({ error: e.message });
    }
  });

  // Mailgun "Clicked" event webhook → POST here. Verifies Mailgun's HMAC signature
  // when MAILGUN_WEBHOOK_SIGNING_KEY is set; otherwise falls back to ?key= secret.
  app.post("/api/webhooks/mailgun/click", async (req: Request, res: Response) => {
    try {
      const b: any = req.body || {};
      const signKey = process.env.MAILGUN_WEBHOOK_SIGNING_KEY;
      let authorized = false;
      const s = b.signature;
      if (signKey && s?.timestamp && s?.token && s?.signature) {
        const digest = createHmac("sha256", signKey).update(s.timestamp + s.token).digest("hex");
        authorized = digest === s.signature;
      }
      if (!authorized) authorized = (req.query.key as string) === EMAIL_CLICK_WEBHOOK_KEY;
      if (!authorized) return res.status(403).json({ error: "bad signature" });

      const ev: any = b["event-data"] || b;
      const email = String(ev.recipient || "").trim();
      if (!email || !email.includes("@")) return res.status(400).json({ error: "no recipient" });
      const uv: any = ev["user-variables"] || {};
      const campaign = (Array.isArray(ev.tags) && ev.tags[0]) || uv.campaign || ev.message?.headers?.subject || "Mailgun email";
      const rep = normalizeRepName(uv.rep) || await resolveRepForEmail(email);
      const out = await recordEmailClickInSalesforce({
        email,
        source: "mailgun",
        campaign,
        url: ev.url,
        firstName: uv.first_name,
        businessName: uv.business_name,
        rep,
      });

      // Mirror the click into GHL: tag existing contacts; create clickers that aren't there yet
      try {
        const existing = await ghlService.getContactByEmail(email);
        if (existing?.id) {
          await ghlService.addTagsToContact(existing.id, ["mailgun-clicker"]);
        } else {
          const cid = await ghlService.createOrUpdateContact({
            email,
            fullName: uv.first_name || email.split("@")[0],
            businessName: uv.business_name || "",
            phone: "",
          } as any);
          if (cid) await ghlService.addTagsToContact(cid, ["mailgun-clicker"]);
        }
      } catch (ghlErr) {
        console.warn("[EMAIL-CLICK] GHL mirror failed (SF write succeeded):", ghlErr);
      }

      console.log(`[EMAIL-CLICK] mailgun ${email} -> ${out.result}${out.error ? ` (${out.error})` : ""}`);
      res.json(out);
    } catch (e: any) {
      console.error("[EMAIL-CLICK] mailgun handler error:", e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── SMS OTP Auth ──
  // Codes are stored in lead_otp_codes (DB-backed so they survive restarts
  // and work across instances). One active code per phone, 10-min expiry,
  // max 5 verify attempts, 60s resend cooldown.

  function normalizePhoneForOtp(raw: string): string {
    const digits = raw.replace(/\D/g, '');
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    return digits.length > 0 ? `+${digits}` : raw;
  }

  // POST /api/lead/request-otp
  app.post("/api/lead/request-otp", async (req: Request, res: Response) => {
    try {
      const { phone } = req.body;
      if (!phone) return res.status(400).json({ error: "Phone number is required" });

      const normalized = normalizePhoneForOtp(phone.trim());
      const digits10 = normalized.replace(/\D/g, '').slice(-10);

      // Look up account by phone
      const result = await db.execute(sql`
        SELECT email, first_name FROM lead_portal_accounts
        WHERE REGEXP_REPLACE(phone, '[^0-9]', '', 'g') = ${digits10}
           OR phone = ${normalized}
           OR phone = ${phone.trim()}
        LIMIT 1
      `);

      if (result.rows.length === 0) {
        return res.status(404).json({ error: "No account found with that phone number. Please sign up first." });
      }

      const row = result.rows[0] as any;

      // Resend cooldown: max one code per phone per 60 seconds
      const recent = await db.execute(
        sql`SELECT 1 FROM lead_otp_codes WHERE phone = ${normalized} AND created_at > NOW() - INTERVAL '60 seconds'`,
      );
      if (recent.rows.length > 0) {
        return res.status(429).json({ error: "A code was just sent. Please wait a minute before requesting another." });
      }

      const code = String(Math.floor(100000 + Math.random() * 900000));
      await db.execute(sql`
        INSERT INTO lead_otp_codes (phone, code, email, attempts, expires_at, created_at)
        VALUES (${normalized}, ${code}, ${row.email}, 0, NOW() + INTERVAL '10 minutes', NOW())
        ON CONFLICT (phone) DO UPDATE SET
          code = EXCLUDED.code, email = EXCLUDED.email, attempts = 0,
          expires_at = EXCLUDED.expires_at, created_at = NOW()
      `);

      const { sendSms } = await import('./services/twilio');
      const smsResult = await sendSms(normalized, `Your Today Capital Group sign-in code is: ${code}\n\nExpires in 10 minutes. Do not share this code.`);
      if (!smsResult.success) {
        console.error("[LEAD] OTP SMS failed:", smsResult.error);
        return res.status(500).json({ error: "Failed to send SMS. Please try again or contact support." });
      }

      console.log(`[LEAD] OTP sent to ${normalized} for ${row.email}`);
      res.json({ success: true });
    } catch (err: any) {
      console.error("[LEAD] request-otp error:", err);
      res.status(500).json({ error: "Failed to send code. Please try again." });
    }
  });

  // POST /api/lead/verify-otp
  app.post("/api/lead/verify-otp", async (req: Request, res: Response) => {
    try {
      const { phone, code } = req.body;
      if (!phone || !code) return res.status(400).json({ error: "Phone and code are required" });

      const normalized = normalizePhoneForOtp(phone.trim());
      const otpRes = await db.execute(
        sql`SELECT code, email, attempts, expires_at FROM lead_otp_codes WHERE phone = ${normalized}`,
      );
      const entry = otpRes.rows[0] as any;

      if (!entry || new Date(entry.expires_at).getTime() < Date.now()) {
        await db.execute(sql`DELETE FROM lead_otp_codes WHERE phone = ${normalized}`);
        return res.status(401).json({ error: "This code has expired. Please request a new one." });
      }

      if (Number(entry.attempts) >= 5) {
        await db.execute(sql`DELETE FROM lead_otp_codes WHERE phone = ${normalized}`);
        return res.status(401).json({ error: "Too many incorrect attempts. Please request a new code." });
      }

      if (entry.code !== String(code).trim()) {
        await db.execute(sql`UPDATE lead_otp_codes SET attempts = attempts + 1 WHERE phone = ${normalized}`);
        return res.status(401).json({ error: "Incorrect code. Please check your text and try again." });
      }

      await db.execute(sql`DELETE FROM lead_otp_codes WHERE phone = ${normalized}`); // one-time use

      const result = await db.execute(sql`SELECT first_name, last_name, business_name FROM lead_portal_accounts WHERE email = ${entry.email}`);
      if (result.rows.length === 0) return res.status(404).json({ error: "Account not found" });

      const row = result.rows[0] as any;
      const name = [row.first_name, row.last_name].filter(Boolean).join(" ");

      req.session.user = {
        isAuthenticated: true,
        role: "lead",
        merchantEmail: entry.email,
        merchantName: name || undefined,
      };

      await new Promise<void>((resolve, reject) => req.session.save(err => err ? reject(err) : resolve()));
      await db.execute(sql`UPDATE lead_portal_accounts SET last_active_at = NOW() WHERE email = ${entry.email}`);
      logPortalEvent('lead', entry.email, 'login', 'sms_otp');

      res.json({ success: true, name, businessName: row.business_name });
    } catch (err: any) {
      console.error("[LEAD] verify-otp error:", err);
      res.status(500).json({ error: "Verification failed. Please try again." });
    }
  });

  // ── Lead Positions CRUD ──

  // GET /api/lead/positions
  app.get("/api/lead/positions", async (req: Request, res: Response) => {
    const email = getLeadEmail(req);
    if (!email) return res.status(401).json({ error: "Authentication required" });

    const result = await db.execute(sql`SELECT * FROM lead_positions WHERE lead_email = ${email} ORDER BY created_at DESC`);
    res.json(result.rows);
  });

  // Helper: validate optional position dollar amounts. Returns the parsed
  // number (or null if not provided) — throws a message string on bad input.
  function parsePositionAmount(value: any, field: string): number | null {
    if (value === undefined || value === null || value === "") return null;
    const n = Number(value);
    if (!Number.isFinite(n)) throw `${field} must be a valid number`;
    if (n <= 0) throw `${field} must be greater than zero`;
    if (n > 50_000_000) throw `${field} looks too large — please double-check the amount`;
    return n;
  }

  // POST /api/lead/positions
  app.post("/api/lead/positions", async (req: Request, res: Response) => {
    const email = getLeadEmail(req);
    if (!email) return res.status(401).json({ error: "Authentication required" });

    const { funderName, productType, fundedAmount, paybackAmount, factorRate, paymentAmount, paymentFrequency, fundedDate, remainingBalance } = req.body;
    if (!funderName || !String(funderName).trim()) return res.status(400).json({ error: "Funder name is required" });

    let funded: number | null, payback: number | null, payment: number | null, remaining: number | null;
    try {
      funded = parsePositionAmount(fundedAmount, "Funded amount");
      payback = parsePositionAmount(paybackAmount, "Payback amount");
      payment = parsePositionAmount(paymentAmount, "Payment amount");
      remaining = parsePositionAmount(remainingBalance, "Remaining balance");
    } catch (msg) {
      return res.status(400).json({ error: String(msg) });
    }
    if (remaining != null && payback != null && remaining > payback) {
      return res.status(400).json({ error: "Remaining balance can't be more than the total payback amount" });
    }
    if (funded != null && payback != null && payback < funded) {
      return res.status(400).json({ error: "Payback amount can't be less than the funded amount" });
    }

    await db.execute(sql`INSERT INTO lead_positions (lead_email, funder_name, product_type, funded_amount, payback_amount, factor_rate, payment_amount, payment_frequency, funded_date, remaining_balance)
      VALUES (${email}, ${String(funderName).trim().slice(0, 200)}, ${productType || null}, ${funded}, ${payback}, ${factorRate || null}, ${payment}, ${paymentFrequency || null}, ${fundedDate || null}, ${remaining})`);

    logPortalEvent('lead', email, 'position_added', String(funderName).trim().slice(0, 100));
    evaluateLeadQualification(email).catch(() => {});
    res.json({ success: true });
  });

  // PATCH /api/lead/positions/:id
  app.patch("/api/lead/positions/:id", async (req: Request, res: Response) => {
    const email = getLeadEmail(req);
    if (!email) return res.status(401).json({ error: "Authentication required" });

    const { remainingBalance, status, paymentAmount, paymentFrequency } = req.body;

    let remaining: number | null, payment: number | null;
    try {
      remaining = parsePositionAmount(remainingBalance, "Remaining balance");
      payment = parsePositionAmount(paymentAmount, "Payment amount");
    } catch (msg) {
      return res.status(400).json({ error: String(msg) });
    }

    const existing = await db.execute(
      sql`SELECT payback_amount FROM lead_positions WHERE id = ${req.params.id} AND lead_email = ${email}`,
    );
    if (existing.rows.length === 0) return res.status(404).json({ error: "Position not found" });
    const payback = Number((existing.rows[0] as any).payback_amount) || 0;
    if (remaining != null && payback > 0 && remaining > payback) {
      return res.status(400).json({ error: "Remaining balance can't be more than the total payback amount" });
    }

    await db.execute(sql`
      UPDATE lead_positions SET
        remaining_balance = COALESCE(${remaining}, remaining_balance),
        status = COALESCE(${status ?? null}, status),
        payment_amount = COALESCE(${payment}, payment_amount),
        payment_frequency = COALESCE(${paymentFrequency ?? null}, payment_frequency)
      WHERE id = ${req.params.id} AND lead_email = ${email}
    `);
    evaluateLeadQualification(email).catch(() => {});
    res.json({ success: true });
  });

  // DELETE /api/lead/positions/:id
  app.delete("/api/lead/positions/:id", async (req: Request, res: Response) => {
    const email = getLeadEmail(req);
    if (!email) return res.status(401).json({ error: "Authentication required" });

    await db.execute(sql`DELETE FROM lead_positions WHERE id = ${req.params.id} AND lead_email = ${email}`);
    res.json({ success: true });
  });

  // POST /api/lead/positions/extract — AI-powered term extraction from text or PDF
  {
    const multerMemory = (await import("multer")).default({ storage: (await import("multer")).default.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
    app.post("/api/lead/positions/extract", (req, res, next) => {
      multerMemory.single("file")(req, res, next);
    }, async (req: Request, res: Response) => {
      const email = getLeadEmail(req);
      if (!email) return res.status(401).json({ error: "Authentication required" });
      if (!isOpenAIConfigured()) return res.status(503).json({ error: "AI extraction is not configured." });

      try {
        const pdfBuffer: Buffer | null = req.file?.buffer || null;
        const text: string = req.body?.text || "";

        if (pdfBuffer) {
          // For any PDF upload (text-based or image-based), send directly to GPT-4o
          // which can read both text-layer PDFs and scanned/image PDFs natively
          console.log(`[EXTRACT] PDF upload (${pdfBuffer.length} bytes), sending to GPT-4o`);
          const terms = await extractPositionTermsFromPdfBuffer(pdfBuffer);
          return res.json(terms);
        }

        // Pasted text path
        if (!text || text.trim().length < 10) {
          return res.status(400).json({ error: "No content to analyze. Please paste some text or upload a PDF." });
        }

        const terms = await extractPositionTerms(text);
        res.json(terms);
      } catch (err: any) {
        console.error("[EXTRACT] extraction error:", err);
        res.status(500).json({ error: err.message || "Extraction failed" });
      }
    });
  }

  // ── Lead Banking (reuses merchant Chirp infrastructure) ──

  // GET /api/lead/banking/insights
  app.get("/api/lead/banking/insights", async (req: Request, res: Response) => {
    const email = getLeadEmail(req);
    if (!email) return res.status(401).json({ error: "Authentication required" });

    // Statement-based analysis (cached from uploaded PDFs) — lets the Financials
    // tab show real numbers before a bank is ever connected.
    let statementInsights: any = null;
    try {
      const pdfCache = await storage.getMerchantInsight(email, 'pdf');
      const pd = pdfCache?.insightsData as any;
      if (pd) {
        statementInsights = {
          analyzedAt: (pdfCache as any).updatedAt || (pdfCache as any).createdAt || null,
          overallScore: Number(pd.overallScore) || 0,
          scoreExplanation: pd.scoreExplanation || "",
          monthlyRevenue: Number(pd.estimatedMonthlyRevenue) || 0,
          monthlyExpenses: Number(pd.estimatedMonthlyExpenses) || 0,
          netCashFlow: Number(pd.netCashFlow) || 0,
          avgDailyBalance: Number(pd.averageDailyBalance) || 0,
          revenueConsistency: pd.revenueConsistency || null,
          monthlyBreakdown: Array.isArray(pd.monthlyBreakdown) ? pd.monthlyBreakdown.slice(-6) : [],
        };
      }
    } catch {}

    const snapshot = await storage.getMerchantBankSnapshot(email);
    if (!snapshot) return res.json({ connected: false, hasPendingConnection: false, statementInsights });

    // Bank data can arrive via the Chirp webhook while the lead is away —
    // re-evaluate qualification whenever they view their financials.
    if (snapshot.isAccountConnected) evaluateLeadQualification(email).catch(() => {});

    const accounts: any[] = Array.isArray(snapshot.accountsData) ? snapshot.accountsData : [];
    const metrics = (snapshot.metrics as any) || {};
    const summaryData = (snapshot.summaryData as any) || {};
    const hasPendingConnection = Boolean(snapshot.chirpRequestCode) && !snapshot.isAccountConnected;

    const parseMoney = (v: unknown): number => {
      if (typeof v === "number") return v;
      if (typeof v !== "string") return 0;
      const n = Number.parseFloat(v.replace(/[^0-9.\-]/g, ""));
      return Number.isFinite(n) ? n : 0;
    };
    const fmtMoney = (v: unknown) => {
      const n = parseMoney(v);
      return n > 0 ? `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : null;
    };

    const activityByMonth: any[] = (summaryData.activityByMonth || [])
      .filter((m: any) => (m.month || "").toLowerCase() !== "all")
      .map((m: any) => ({
        month: m.month,
        totalCredit: parseMoney(m.totalCredit),
        totalDebit: parseMoney(m.totalDebit),
        averageDailyBalance: parseMoney(m.averageDailyBalance ?? m.averageMonthlyBalance),
        net: parseMoney(m.net ?? m.totalNet ?? (parseMoney(m.totalCredit) - parseMoney(m.totalDebit))),
      }));

    res.json({
      connected: Boolean(snapshot.isAccountConnected),
      hasPendingConnection,
      statementInsights,
      status: snapshot.status,
      institutionName: snapshot.institutionName,
      connectedAt: snapshot.connectedAt,
      lastSyncedAt: snapshot.lastSyncedAt,
      accounts: accounts.map(a => ({ name: a.accountName || "Account", type: a.type || "", balance: Number(a.balance) || 0 })),
      metrics: {
        monthlyRevenue: Number(metrics.monthlyRevenue) || 0,
        monthlyExpenses: Number(metrics.monthlyExpenses) || 0,
        netCashFlow: Number(metrics.netCashFlow) || 0,
        avgBalance: Number(metrics.avgBalance) || 0,
        currentBalance: Number(metrics.currentBalance) || 0,
        monthsAnalyzed: Number(metrics.monthsAnalyzed) || 0,
        revenueTrend: metrics.revenueTrend || null,
        healthScore: Number(metrics.healthScore) || 0,
      },
      activityByMonth,
    });
  });

  // POST /api/lead/detect-positions — scan Chirp transactions for MCA payment patterns
  app.post("/api/lead/detect-positions", async (req: Request, res: Response) => {
    const email = getLeadEmail(req);
    if (!email) return res.status(401).json({ error: "Authentication required" });

    try {
      const snapshot = await storage.getMerchantBankSnapshot(email);
      if (!snapshot?.chirpRequestCode) {
        return res.status(400).json({ error: "No bank connection found. Connect your bank in the Financials tab first." });
      }

      // Prefer transactions already stored on the snapshot (survives Chirp WAF
      // blocks); fall back to a live read + normalize
      let txns: NormalizedTxn[] = Array.isArray(snapshot.transactionsData) ? (snapshot.transactionsData as any) : [];
      if (txns.length === 0) {
        let details: any = null;
        try {
          details = await chirpService.getRequestDetails(snapshot.chirpRequestCode, { numberOfDays: 90, sort: "DESCENDING" });
        } catch (e: any) {
          console.warn("[LEAD] detect-positions: Chirp fetch failed:", e?.message);
          return res.status(503).json({ error: "Unable to read bank transactions right now. Try again shortly." });
        }
        txns = normalizeChirpTransactions((details as any)?.TransactionSummaries || (details as any)?.transactionSummaries || []);
      }
      if (txns.length === 0) {
        return res.json({ detected: 0, added: 0, message: "No transactions found in your connected bank. Try syncing your bank first." });
      }

      const normalize = (s: string) =>
        s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);

      // Shared detector (same logic that powers underwriting metrics)
      const patterns = detectMcaPatterns(txns).map(p => ({
        desc: p.funderGuess || p.description,
        amount: p.amount,
        frequency: p.frequency,
        count: p.count,
        firstDate: p.firstDate,
      }));

      if (patterns.length === 0) {
        return res.json({
          detected: 0, added: 0,
          message: "No recurring MCA payment patterns detected in your transactions. You can add positions manually.",
        });
      }

      // Get existing positions to avoid duplicates
      const existingRows = await db.execute(
        sql`SELECT funder_name, payment_amount FROM lead_positions WHERE lead_email = ${email}`
      );
      const existingKeys = new Set(
        existingRows.rows.map((r: any) => `${normalize(String(r.funder_name))}:${Math.round(Number(r.payment_amount))}`)
      );

      let added = 0;
      for (const p of patterns) {
        const key = `${normalize(p.desc)}:${Math.round(p.amount)}`;
        if (existingKeys.has(key)) continue;

        // Estimate remaining balance: based on frequency and count seen so far
        const paymentsPerMonth = p.frequency === "daily" ? 21 : p.frequency === "weekly" ? 4 : p.frequency === "bi-weekly" ? 2 : 1;
        const estimatedTotalPayments = paymentsPerMonth * 6; // assume 6-month advance
        const estimatedRemaining = Math.round(p.amount * Math.max(estimatedTotalPayments - p.count, paymentsPerMonth));

        await db.execute(sql`
          INSERT INTO lead_positions (lead_email, funder_name, product_type, payment_amount, payment_frequency, remaining_balance, funded_date, notes, status)
          VALUES (
            ${email},
            ${p.desc.slice(0, 60)},
            'MCA',
            ${p.amount},
            ${p.frequency},
            ${estimatedRemaining},
            ${p.firstDate || null},
            ${'Auto-detected from bank transactions (' + p.count + ' payments found)'},
            'active'
          )
        `);
        added++;
      }

      res.json({
        detected: patterns.length,
        added,
        message: added > 0
          ? `Found ${patterns.length} recurring payment pattern${patterns.length !== 1 ? "s" : ""}. Added ${added} new position${added !== 1 ? "s" : ""} — review them in the Positions tab.`
          : `Found ${patterns.length} pattern${patterns.length !== 1 ? "s" : ""} but they are already tracked.`,
      });
    } catch (err: any) {
      console.error("[LEAD] detect-positions error:", err);
      res.status(500).json({ error: err.message || "Detection failed" });
    }
  });

  // POST /api/lead/chirp/connect
  app.post("/api/lead/chirp/connect", async (req: Request, res: Response) => {
    const email = getLeadEmail(req);
    if (!email) return res.status(401).json({ error: "Authentication required" });

    try {
      // Guard: don't clobber a live connection or duplicate a fresh pending request
      const existingSnap = await storage.getMerchantBankSnapshot(email);
      if (existingSnap && !req.body?.force) {
        if (existingSnap.isAccountConnected) {
          return res.json({
            success: true,
            alreadyConnected: true,
            institutionName: existingSnap.institutionName,
            lastSyncedAt: existingSnap.lastSyncedAt,
          });
        }
        const ageMs = existingSnap.createdAt ? Date.now() - new Date(existingSnap.createdAt).getTime() : Infinity;
        if (existingSnap.widgetUrl && ageMs < 24 * 60 * 60 * 1000) {
          return res.json({
            requestCode: existingSnap.chirpRequestCode,
            widgetUrl: existingSnap.widgetUrl,
            verificationUrl: existingSnap.verificationUrl || existingSnap.widgetUrl,
            resumed: true,
          });
        }
      }

      const leadAccount = await db.execute(sql`SELECT first_name, last_name, phone FROM lead_portal_accounts WHERE email = ${email}`);
      const lead = leadAccount.rows[0] as any;

      const phone = req.body?.phone || lead?.phone;
      if (!phone) return res.status(400).json({ error: "A phone number is required to connect your bank. Please update your profile." });

      const result = await chirpService.createVerificationRequest({
        cusFirstName: lead?.first_name || "Lead",
        cusLastName: lead?.last_name || "User",
        cusEmail: email,
        cusPhone: phone,
      });

      // Sanitize URLs before persisting — Chirp sandbox sometimes returns "NA"
      const sanitizeLeadUrl = (u?: string) =>
        u && /^https?:\/\//i.test(u.trim()) ? u.trim() : undefined;
      const leadSafeWidget = sanitizeLeadUrl(result.widgetUrl)
        || `https://chirp.digital/api/widget?requestCode=${result.requestCode}`;
      const leadSafeVerification = sanitizeLeadUrl(result.verificationUrl) || leadSafeWidget;

      // Save stub snapshot (explicit nulls reset any previous connection's data)
      await storage.upsertMerchantBankSnapshot({
        merchantEmail: email,
        chirpRequestCode: result.requestCode,
        status: "Unverified",
        isAccountConnected: false,
        institutionName: null,
        accountsData: null,
        summaryData: null,
        metrics: null,
        transactionsData: null,
        widgetUrl: leadSafeWidget,
        verificationUrl: leadSafeVerification,
        statementFiledAt: null,
        lastSyncedAt: new Date(),
      });

      // Register webhooks so Chirp pushes status/refresh events to us
      if (process.env.PUBLIC_BASE_URL) {
        const webhookUrl = `${process.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/api/chirp/webhook`;
        chirpService.createCustomerNotification({
          name: `lead-portal-status-${result.requestCode}`,
          requestCode: result.requestCode,
          type: "REQUEST_STATUS",
          rule: "GREATER_THAN",
          webhookUrl: [webhookUrl],
          notifyViaWebhook: true,
          notifyViaEmail: false,
          active: true,
        }).catch(e => console.warn("[CHIRP][LEAD] webhook register error:", e?.message));
        chirpService.createCustomerNotification({
          name: `lead-portal-refresh-${result.requestCode}`,
          requestCode: result.requestCode,
          type: "REFRESH",
          rule: "GREATER_THAN",
          webhookUrl: [webhookUrl],
          notifyViaWebhook: true,
          notifyViaEmail: false,
          active: true,
        }).catch(e => console.warn("[CHIRP][LEAD] refresh webhook register error:", e?.message));
      }

      res.json({ requestCode: result.requestCode, widgetUrl: leadSafeWidget, verificationUrl: leadSafeVerification });
    } catch (err: any) {
      console.error("[LEAD] chirp connect error:", err);
      res.status(500).json({ error: err.message || "Failed to start bank connection" });
    }
  });

  // POST /api/lead/chirp/sync
  app.post("/api/lead/chirp/sync", async (req: Request, res: Response) => {
    const email = getLeadEmail(req);
    if (!email) return res.status(401).json({ error: "Authentication required" });

    const existing = await storage.getMerchantBankSnapshot(email);
    if (!existing?.chirpRequestCode) return res.status(400).json({ error: "No bank connection found." });

    const snapshot = await syncMerchantSnapshotFromChirp(email, existing.chirpRequestCode);
    evaluateLeadQualification(email).catch(() => {});
    res.json({ success: true, lastSyncedAt: snapshot?.lastSyncedAt });
  });

  // DELETE /api/lead/chirp/connection — disconnect (removes cached snapshot)
  app.delete("/api/lead/chirp/connection", async (req: Request, res: Response) => {
    const email = getLeadEmail(req);
    if (!email) return res.status(401).json({ error: "Authentication required" });
    try {
      await storage.deleteMerchantBankSnapshot(email);
      res.json({ success: true });
    } catch (err: any) {
      console.error("[CHIRP][LEAD] disconnect error:", err);
      res.status(500).json({ error: "Failed to disconnect" });
    }
  });

  // POST /api/lead/chirp/register-webhook — registers/refreshes webhook for pending connection
  app.post("/api/lead/chirp/register-webhook", async (req: Request, res: Response) => {
    const email = getLeadEmail(req);
    if (!email) return res.status(401).json({ error: "Authentication required" });
    try {
      const snapshot = await storage.getMerchantBankSnapshot(email);
      if (!snapshot?.chirpRequestCode) return res.status(400).json({ error: "No bank connection found." });
      await registerChirpWebhookForCode(snapshot.chirpRequestCode);
      res.json({ success: true, requestCode: snapshot.chirpRequestCode });
    } catch (err: any) {
      console.error("[CHIRP][LEAD] register-webhook error:", err);
      res.status(500).json({ error: err.message || "Failed to register webhook" });
    }
  });

  // GET /api/lead/bank-statements — list uploaded statements for this lead
  app.get("/api/lead/bank-statements", async (req: Request, res: Response) => {
    const email = getLeadEmail(req);
    if (!email) return res.status(401).json({ error: "Authentication required" });
    try {
      const uploads = await storage.getBankStatementUploadsByEmail(email);
      res.json(uploads.map((s: any) => ({
        id: s.id,
        fileName: s.fileName,
        fileSize: s.fileSize,
        uploadedAt: s.uploadedAt || s.createdAt,
        viewToken: s.viewToken,
      })));
    } catch (err: any) {
      console.error("[LEAD] bank-statements list error:", err);
      res.status(500).json({ error: "Failed to fetch statements" });
    }
  });

  // POST /api/lead/upload-statement — lead uploads a PDF bank statement from the tracker
  app.post("/api/lead/upload-statement", (req, res, next) => {
    bankStatementUpload.single("file")(req, res, (err: any) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: "File too large (25MB max)" });
        if (err.message === 'Only PDF files are allowed') return res.status(400).json({ error: err.message });
        return res.status(400).json({ error: "Upload error: " + err.message });
      }
      next();
    });
  }, async (req: Request, res: Response) => {
    const email = getLeadEmail(req);
    if (!email) return res.status(401).json({ error: "Authentication required" });
    try {
      const file = req.file;
      if (!file) return res.status(400).json({ error: "No file uploaded" });

      let storedFileName: string;
      if (objectStorage.isConfigured()) {
        storedFileName = await objectStorage.uploadFile(
          file.buffer,
          `bank-statements/${email}/${Date.now()}_${file.originalname}`,
          file.mimetype,
        );
      } else {
        storedFileName = `${Date.now()}_${file.originalname}`;
        fs.writeFileSync(path.join(UPLOAD_DIR, storedFileName), file.buffer);
      }

      await storage.createBankStatementUpload({
        email,
        originalFileName: file.originalname,
        storedFileName,
        fileSize: file.size,
        mimeType: file.mimetype,
        source: "lead_portal",
        viewToken: randomUUID(),
      });

      logPortalEvent('lead', email, 'statement_upload', file.originalname);
      sendMarketingNotification(
        `Track lead uploaded a bank statement: ${email}`,
        `<p><strong>${email}</strong> uploaded <strong>${file.originalname}</strong> (${Math.round(file.size / 1024)} KB) from the /track portal.</p>`
      ).catch(() => {});

      console.log(`[LEAD UPLOAD] ${email} uploaded ${file.originalname} (${(file.size / 1024).toFixed(0)} KB)`);
      res.json({ success: true, fileName: file.originalname, fileSize: file.size });
    } catch (err: any) {
      console.error("[LEAD UPLOAD] error:", err);
      res.status(500).json({ error: "Upload failed" });
    }
  });

  // POST /api/lead/onboarding/advance — persist onboarding progress
  app.post("/api/lead/onboarding/advance", async (req: Request, res: Response) => {
    const email = getLeadEmail(req);
    if (!email) return res.status(401).json({ error: "Authentication required" });
    const step = String(req.body?.step || "");
    const allowedSteps = ["add_position", "connect_bank", "view_qualify", "done"];
    if (!allowedSteps.includes(step)) return res.status(400).json({ error: "Invalid step" });
    try {
      await db.execute(sql`UPDATE lead_portal_accounts SET onboarding_step = ${step} WHERE email = ${email}`);
      res.json({ success: true, step });
    } catch (err: any) {
      console.error("[LEAD] onboarding advance error:", err);
      res.status(500).json({ error: "Failed to save progress" });
    }
  });

  // GET /api/lead/referrals — how many businesses signed up through my referral link
  app.get("/api/lead/referrals", async (req: Request, res: Response) => {
    const email = getLeadEmail(req);
    if (!email) return res.status(401).json({ error: "Authentication required" });
    try {
      const me = await db.execute(sql`SELECT referral_code FROM lead_portal_accounts WHERE email = ${email}`);
      const code = (me.rows[0] as any)?.referral_code;
      if (!code) return res.json({ referralCount: 0 });
      const result = await db.execute(sql`SELECT COUNT(*)::int AS count FROM lead_portal_accounts WHERE referred_by = ${code} AND email != ${email}`);
      res.json({ referralCount: Number((result.rows[0] as any)?.count) || 0 });
    } catch (err: any) {
      console.error("[LEAD] referrals error:", err);
      res.status(500).json({ error: "Failed to fetch referrals" });
    }
  });

  // GET /api/admin/lead-portal/leads — admin view with sales intelligence
  app.get("/api/admin/lead-portal/leads", async (req: Request, res: Response) => {
    if (!req.session.user?.isAuthenticated || req.session.user.role === 'merchant' || req.session.user.role === 'lead') {
      return res.status(401).json({ error: "Admin access required" });
    }
    try {
      const result = await db.execute(sql`SELECT l.*,
        (SELECT COUNT(*) FROM lead_positions WHERE lead_email = l.email) as position_count,
        (SELECT json_agg(json_build_object(
          'id', lp.id, 'funderName', lp.funder_name, 'productType', lp.product_type,
          'fundedAmount', lp.funded_amount, 'paybackAmount', lp.payback_amount,
          'paymentAmount', lp.payment_amount, 'paymentFrequency', lp.payment_frequency,
          'fundedDate', lp.funded_date, 'estimatedPayoffDate', lp.estimated_payoff_date,
          'remainingBalance', lp.remaining_balance, 'status', lp.status, 'notes', lp.notes
        )) FROM lead_positions lp WHERE lp.lead_email = l.email) as positions,
        (SELECT COUNT(*) FROM bank_statement_uploads WHERE email = l.email) as statement_count,
        (SELECT json_agg(json_build_object('id', id, 'fileName', original_file_name, 'uploadedAt', created_at, 'source', source) ORDER BY created_at DESC)
         FROM bank_statement_uploads WHERE email = l.email) as statements,
        mp_agg.tier, mp_agg.funder_count, mp_agg.named_funder_count, mp_agg.daily_load,
        mp_agg.uw_status, mp_agg.uw_lender, mp_agg.uw_amount, mp_agg.uw_funded_date,
        mp_agg.uw_approval_count, mp_agg.uw_decline_count, mp_agg.outreach_status,
        mp_agg.outreach_notes, mp_agg.funder_names,
        clc.clc_status, clc.clc_lender, clc.clc_amount, clc.clc_funded_date,
        clc.clc_additional_fundings, clc.clc_approval_date
        FROM lead_portal_accounts l
        LEFT JOIN LATERAL (
          SELECT
            MAX(CASE WHEN mp.tier = 'HOT' THEN 'HOT' WHEN mp.tier = 'WARM' THEN 'WARM' WHEN mp.tier = 'SOON' THEN 'SOON' ELSE 'EARLY' END) as tier,
            COUNT(*)::int as funder_count,
            COUNT(*) FILTER (WHERE mp.funder_name != 'Unknown Funder')::int as named_funder_count,
            COALESCE(SUM(CASE WHEN mp.payment_frequency = 'daily' THEN mp.payment_amount::numeric
              WHEN mp.payment_frequency = 'weekly' THEN mp.payment_amount::numeric / 5
              ELSE 0 END), 0)::numeric as daily_load,
            MAX(mp.uw_status) as uw_status,
            MAX(mp.uw_lender) as uw_lender,
            MAX(mp.uw_amount)::numeric as uw_amount,
            MAX(mp.uw_funded_date) as uw_funded_date,
            MAX(mp.uw_approval_count)::int as uw_approval_count,
            MAX(mp.uw_decline_count)::int as uw_decline_count,
            MAX(mp.outreach_status) as outreach_status,
            MAX(mp.outreach_notes) as outreach_notes,
            string_agg(DISTINCT mp.funder_name, ', ') FILTER (WHERE mp.funder_name != 'Unknown Funder') as funder_names
          FROM merchant_positions mp
          WHERE LOWER(mp.business_email) = LOWER(l.email) AND mp.status = 'active'
        ) mp_agg ON true
        LEFT JOIN LATERAL (
          SELECT bud.status as clc_status, bud.lender as clc_lender,
                 bud.advance_amount::numeric as clc_amount,
                 bud.funded_date as clc_funded_date,
                 bud.additional_fundings as clc_additional_fundings,
                 bud.approval_date as clc_approval_date
          FROM business_underwriting_decisions bud
          WHERE LOWER(bud.business_email) = LOWER(l.email)
          LIMIT 1
        ) clc ON true
        ORDER BY l.created_at DESC`);
      res.json(result.rows);
    } catch (err: any) {
      console.error("[LEAD] admin leads fetch error:", err);
      res.status(500).json({ error: "Failed to fetch leads" });
    }
  });

  // GET /api/my-leads — role-scoped lead pipeline (agents see their own, admins see all)
  app.get("/api/my-leads", async (req: Request, res: Response) => {
    if (!req.session.user?.isAuthenticated || req.session.user.role === 'merchant' || req.session.user.role === 'lead') {
      return res.status(401).json({ error: "Authentication required" });
    }
    const role = req.session.user.role;
    const agentEmail = req.session.user.agentEmail?.toLowerCase();
    const isAdmin = role === 'admin' || role === 'underwriting';

    try {
      const result = await db.execute(sql`
        SELECT l.id, l.email, l.first_name, l.last_name, l.phone, l.business_name,
               l.industry, l.monthly_revenue, l.time_in_business, l.notes, l.status, l.created_at,
               (SELECT COUNT(*) FROM lead_positions WHERE lead_email = l.email) as position_count,
               (SELECT json_agg(json_build_object(
                 'id', lp.id, 'funderName', lp.funder_name, 'productType', lp.product_type,
                 'fundedAmount', lp.funded_amount, 'paybackAmount', lp.payback_amount,
                 'paymentAmount', lp.payment_amount, 'paymentFrequency', lp.payment_frequency,
                 'fundedDate', lp.funded_date, 'estimatedPayoffDate', lp.estimated_payoff_date,
                 'remainingBalance', lp.remaining_balance, 'status', lp.status
               )) FROM lead_positions lp WHERE lp.lead_email = l.email) as positions,
               mp_agg.tier, mp_agg.funder_count, mp_agg.named_funder_count, mp_agg.daily_load,
               mp_agg.uw_status, mp_agg.uw_lender, mp_agg.uw_amount, mp_agg.uw_funded_date,
               mp_agg.uw_approval_count, mp_agg.uw_decline_count, mp_agg.outreach_status,
               mp_agg.outreach_notes, mp_agg.funder_names,
               clc.clc_status, clc.clc_lender, clc.clc_amount, clc.clc_funded_date,
               clc.clc_additional_fundings, clc.clc_approval_date,
               agent_info.agent_name, agent_info.agent_email
        FROM lead_portal_accounts l
        LEFT JOIN LATERAL (
          SELECT
            MAX(CASE WHEN mp.tier = 'HOT' THEN 'HOT' WHEN mp.tier = 'WARM' THEN 'WARM' WHEN mp.tier = 'SOON' THEN 'SOON' ELSE 'EARLY' END) as tier,
            COUNT(*)::int as funder_count,
            COUNT(*) FILTER (WHERE mp.funder_name != 'Unknown Funder')::int as named_funder_count,
            COALESCE(SUM(CASE WHEN mp.payment_frequency = 'daily' THEN mp.payment_amount::numeric
              WHEN mp.payment_frequency = 'weekly' THEN mp.payment_amount::numeric / 5
              ELSE 0 END), 0)::numeric as daily_load,
            MAX(mp.uw_status) as uw_status, MAX(mp.uw_lender) as uw_lender,
            MAX(mp.uw_amount)::numeric as uw_amount, MAX(mp.uw_funded_date) as uw_funded_date,
            MAX(mp.uw_approval_count)::int as uw_approval_count,
            MAX(mp.uw_decline_count)::int as uw_decline_count,
            MAX(mp.outreach_status) as outreach_status, MAX(mp.outreach_notes) as outreach_notes,
            string_agg(DISTINCT mp.funder_name, ', ') FILTER (WHERE mp.funder_name != 'Unknown Funder') as funder_names
          FROM merchant_positions mp
          WHERE LOWER(mp.business_email) = LOWER(l.email) AND mp.status = 'active'
        ) mp_agg ON true
        LEFT JOIN LATERAL (
          SELECT bud.status as clc_status, bud.lender as clc_lender,
                 bud.advance_amount::numeric as clc_amount,
                 bud.funded_date as clc_funded_date,
                 bud.additional_fundings as clc_additional_fundings,
                 bud.approval_date as clc_approval_date
          FROM business_underwriting_decisions bud
          WHERE LOWER(bud.business_email) = LOWER(l.email)
          LIMIT 1
        ) clc ON true
        LEFT JOIN LATERAL (
          SELECT agent_name, agent_email
          FROM loan_applications WHERE LOWER(email) = LOWER(l.email) AND agent_name IS NOT NULL
          ORDER BY created_at DESC LIMIT 1
        ) agent_info ON true
        WHERE (${isAdmin} OR LOWER(agent_info.agent_email) = LOWER(${agentEmail || ''}))
        ORDER BY l.created_at DESC
      `);
      res.json(result.rows);
    } catch (err: any) {
      console.error("[MY-LEADS] fetch error:", err);
      res.status(500).json({ error: "Failed to fetch leads" });
    }
  });

  // PATCH /api/admin/lead-portal/leads/:id/outreach — update outreach status
  app.patch("/api/admin/lead-portal/leads/:id/outreach", async (req: Request, res: Response) => {
    if (!req.session.user?.isAuthenticated || req.session.user.role === 'merchant' || req.session.user.role === 'lead') {
      return res.status(401).json({ error: "Admin access required" });
    }
    const { status, notes } = req.body;
    const validStatuses = ['not_contacted', 'contacted', 'in_progress', 'converted', 'passed'];
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({ error: "Invalid outreach status" });
    }
    try {
      const account = await db.execute(sql`SELECT email FROM lead_portal_accounts WHERE id = ${parseInt(req.params.id)}`);
      if (!account.rows.length) return res.status(404).json({ error: "Account not found" });
      const email = (account.rows[0] as any).email;

      if (status) {
        await db.execute(sql`UPDATE merchant_positions SET outreach_status = ${status}, updated_at = NOW()
          WHERE LOWER(business_email) = LOWER(${email})`);
      }
      if (notes !== undefined) {
        await db.execute(sql`UPDATE merchant_positions SET outreach_notes = ${notes}, updated_at = NOW()
          WHERE LOWER(business_email) = LOWER(${email})`);
        await db.execute(sql`UPDATE lead_portal_accounts SET notes = ${notes} WHERE id = ${parseInt(req.params.id)}`);
      }
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[LEAD] outreach update error:", err);
      res.status(500).json({ error: "Failed to update outreach" });
    }
  });

  // ========================================
  // PARTNER PORTAL ROUTES
  // ========================================

  // Ensure partners table exists (auto-create if missing)
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS partners (
        id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT,
        company_name TEXT,
        contact_name TEXT,
        phone TEXT,
        profession TEXT,
        client_base_size TEXT,
        logo_url TEXT,
        slug TEXT UNIQUE,
        invite_code TEXT UNIQUE,
        commission_rate NUMERIC(5,2) DEFAULT 3.00,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    // Add any missing columns for existing tables
    await pool.query(`ALTER TABLE partners ADD COLUMN IF NOT EXISTS slug TEXT;`);
    await pool.query(`ALTER TABLE partners ADD COLUMN IF NOT EXISTS invite_code TEXT;`);
    await pool.query(`ALTER TABLE partners ADD COLUMN IF NOT EXISTS password_hash TEXT;`);
    await pool.query(`ALTER TABLE partners ADD COLUMN IF NOT EXISTS contact_name TEXT;`);
    await pool.query(`ALTER TABLE partners ADD COLUMN IF NOT EXISTS profession TEXT;`);
    await pool.query(`ALTER TABLE partners ADD COLUMN IF NOT EXISTS client_base_size TEXT;`);
    await pool.query(`ALTER TABLE partners ADD COLUMN IF NOT EXISTS logo_url TEXT;`);
    // Add unique constraints if missing
    await pool.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'partners_slug_key') THEN ALTER TABLE partners ADD CONSTRAINT partners_slug_key UNIQUE (slug); END IF; END $$`);
    await pool.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'partners_invite_code_key') THEN ALTER TABLE partners ADD CONSTRAINT partners_invite_code_key UNIQUE (invite_code); END IF; END $$`);
    // Drop NOT NULL on legacy 'name' column if it exists (old schema had name NOT NULL, new schema uses contact_name)
    await pool.query(`ALTER TABLE partners ALTER COLUMN name DROP NOT NULL;`).catch(() => {/* column may not exist */});
    console.log("[PARTNER] Partners table ensured");
  } catch (err) {
    console.error("[PARTNER] Failed to ensure partners table:", err);
  }

  // ── Email unsubscribes table ───────────────────────────────────────────────
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS email_unsubscribes (
        email TEXT PRIMARY KEY,
        unsubscribed_at TIMESTAMP DEFAULT NOW(),
        source TEXT DEFAULT 'one-click'
      )
    `);
    console.log("[UNSUB] email_unsubscribes table ensured");
  } catch (err) {
    console.error("[UNSUB] Failed to ensure email_unsubscribes table:", err);
  }

  // ── Unsubscribe page (GET /unsubscribe) ───────────────────────────────────
  app.get("/unsubscribe", (req: Request, res: Response) => {
    const email = (req.query.email as string) || "";
    const safeEmail = email.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const status = req.query.status as string;
    const isConfirmed = status === "done";

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Unsubscribe – Today Capital Group</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f8fafc;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
    .card{background:#fff;border-radius:12px;box-shadow:0 2px 16px rgba(0,0,0,.08);max-width:480px;width:100%;padding:48px 40px;text-align:center}
    .logo{font-size:13px;font-weight:700;letter-spacing:2px;color:#2dd4bf;text-transform:uppercase;margin-bottom:32px}
    h1{font-size:24px;font-weight:700;color:#0f172a;margin-bottom:12px}
    p{font-size:15px;color:#64748b;line-height:1.6;margin-bottom:24px}
    .email-pill{display:inline-block;background:#f1f5f9;border-radius:6px;padding:6px 14px;font-size:14px;color:#334155;margin-bottom:28px;word-break:break-all}
    button,a.btn{display:inline-block;background:#0f1e38;color:#fff;border:none;border-radius:8px;padding:13px 32px;font-size:15px;font-weight:600;cursor:pointer;text-decoration:none;transition:opacity .15s}
    button:hover,a.btn:hover{opacity:.85}
    .check{width:56px;height:56px;border-radius:50%;background:#dcfce7;display:flex;align-items:center;justify-content:center;margin:0 auto 24px;font-size:28px}
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">Today Capital Group</div>
    ${isConfirmed ? `
    <div class="check">&#10003;</div>
    <h1>You've been unsubscribed</h1>
    <p>You won't receive any more marketing emails from us${safeEmail ? ` at <strong>${safeEmail}</strong>` : ""}.</p>
    <a class="btn" href="https://todaycapitalgroup.com">Back to website</a>
    ` : `
    <h1>Unsubscribe from emails</h1>
    ${safeEmail ? `<div class="email-pill">${safeEmail}</div>` : ""}
    <p>Click the button below to stop receiving marketing emails from Today Capital Group.</p>
    <form method="POST" action="/api/unsubscribe">
      <input type="hidden" name="email" value="${safeEmail}"/>
      <button type="submit">Confirm unsubscribe</button>
    </form>
    `}
  </div>
</body>
</html>`);
  });

  // ── One-click unsubscribe (POST /api/unsubscribe) ─────────────────────────
  // Called by email clients that support List-Unsubscribe-Post (RFC 8058)
  // AND by our own confirm-unsubscribe form above.
  app.post("/api/unsubscribe", async (req: Request, res: Response) => {
    const email = (req.body?.email || req.query.email || "").toString().trim().toLowerCase();
    if (!email) return res.status(400).json({ error: "email required" });
    try {
      await db.execute(sql`
        INSERT INTO email_unsubscribes (email, unsubscribed_at, source)
        VALUES (${email}, NOW(), 'one-click')
        ON CONFLICT (email) DO NOTHING
      `);
      console.log(`[UNSUB] ${email} unsubscribed`);
      // RFC 8058 one-click callers expect 200 with no body; browser form
      // submissions get a friendly confirmation redirect.
      const isFormSubmit = req.headers["content-type"]?.includes("application/x-www-form-urlencoded");
      if (isFormSubmit) {
        return res.redirect(302, `/unsubscribe?email=${encodeURIComponent(email)}&status=done`);
      }
      return res.status(200).send("OK");
    } catch (err) {
      console.error("[UNSUB] Failed to record unsubscribe:", err);
      return res.status(500).json({ error: "internal error" });
    }
  });

  // Helper functions for password hashing
  const hashPassword = (password: string): string => {
    const salt = randomBytes(16).toString("hex");
    const hash = scryptSync(password, salt, 64).toString("hex");
    return `${salt}:${hash}`;
  };

  const verifyPassword = (password: string, storedHash: string): boolean => {
    const [salt, hash] = storedHash.split(":");
    const hashBuffer = Buffer.from(hash, "hex");
    const suppliedHashBuffer = scryptSync(password, salt, 64);
    return timingSafeEqual(hashBuffer, suppliedHashBuffer);
  };

  // Generate unique invite code for partners
  const generateInviteCode = (): string => {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let code = "";
    for (let i = 0; i < 8; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  };

  // Generate URL-friendly slug from company name
  const generateSlug = (companyName: string): string => {
    return companyName
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
  };

  // Partner Registration
  app.post("/api/partner/register", async (req, res) => {
    try {
      const { email, password, companyName, contactName, phone, profession, clientBaseSize } = req.body;

      // Validate required fields
      if (!email || !password || !companyName || !contactName) {
        return res.status(400).json({ error: "Email, password, company name, and contact name are required" });
      }

      // Check if partner already exists
      const existingPartner = await storage.getPartnerByEmail(email.toLowerCase());
      if (existingPartner) {
        return res.status(409).json({ error: "A partner account with this email already exists" });
      }

      // Generate unique invite code
      let inviteCode = generateInviteCode();
      let existingCode = await storage.getPartnerByInviteCode(inviteCode);
      while (existingCode) {
        inviteCode = generateInviteCode();
        existingCode = await storage.getPartnerByInviteCode(inviteCode);
      }

      // Generate unique slug from company name
      let baseSlug = generateSlug(companyName);
      let slug = baseSlug;
      let slugSuffix = 1;
      let existingSlug = await storage.getPartnerBySlug(slug);
      while (existingSlug) {
        slug = `${baseSlug}-${slugSuffix}`;
        slugSuffix++;
        existingSlug = await storage.getPartnerBySlug(slug);
      }

      // Hash password and create partner
      const passwordHash = hashPassword(password);
      const partner = await storage.createPartner({
        email: email.toLowerCase(),
        passwordHash,
        companyName,
        contactName,
        phone: phone || null,
        profession: profession || null,
        clientBaseSize: clientBaseSize || null,
        slug,
        inviteCode,
        isActive: true,
      });

      // Set session
      req.session.user = {
        isAuthenticated: true,
        role: "partner",
        partnerId: partner.id,
        partnerEmail: partner.email,
        partnerName: partner.contactName,
        companyName: partner.companyName,
      };

      res.json({
        success: true,
        partner: {
          id: partner.id,
          email: partner.email,
          companyName: partner.companyName,
          contactName: partner.contactName,
          inviteCode: partner.inviteCode,
          slug: partner.slug,
        },
      });
    } catch (error) {
      console.error("Partner registration error:", error);
      res.status(500).json({ error: "Failed to register partner" });
    }
  });

  // Partner Login
  app.post("/api/partner/login", async (req, res) => {
    try {
      const { email, password } = req.body;

      if (!email || !password) {
        return res.status(400).json({ error: "Email and password are required" });
      }

      const partner = await storage.getPartnerByEmail(email.toLowerCase());
      if (!partner) {
        return res.status(401).json({ error: "Invalid email or password" });
      }

      if (!partner.isActive) {
        return res.status(403).json({ error: "Account is disabled. Please contact support." });
      }

      const isValidPassword = verifyPassword(password, partner.passwordHash);
      if (!isValidPassword) {
        return res.status(401).json({ error: "Invalid email or password" });
      }

      // Generate slug for existing partners who don't have one
      let partnerSlug = partner.slug;
      if (!partnerSlug) {
        let baseSlug = generateSlug(partner.companyName);
        let slug = baseSlug;
        let slugSuffix = 1;
        let existingSlug = await storage.getPartnerBySlug(slug);
        while (existingSlug) {
          slug = `${baseSlug}-${slugSuffix}`;
          slugSuffix++;
          existingSlug = await storage.getPartnerBySlug(slug);
        }
        await storage.updatePartner(partner.id, { slug });
        partnerSlug = slug;
      }

      // Set session
      req.session.user = {
        isAuthenticated: true,
        role: "partner",
        partnerId: partner.id,
        partnerEmail: partner.email,
        partnerName: partner.contactName,
        companyName: partner.companyName,
      };

      res.json({
        success: true,
        role: "partner",
        partner: {
          id: partner.id,
          email: partner.email,
          companyName: partner.companyName,
          contactName: partner.contactName,
          slug: partnerSlug,
          inviteCode: partner.inviteCode,
          commissionRate: partner.commissionRate,
        },
      });
    } catch (error) {
      console.error("Partner login error:", error);
      res.status(500).json({ error: "Login failed" });
    }
  });

  // Get partner profile
  app.get("/api/partner/profile", async (req, res) => {
    try {
      if (!req.session.user?.isAuthenticated || req.session.user.role !== "partner" || !req.session.user.partnerId) {
        return res.status(401).json({ error: "Partner authentication required" });
      }

      const partnerId = req.session.user.partnerId;
      const partner = await storage.getPartner(partnerId);
      if (!partner) {
        return res.status(404).json({ error: "Partner not found" });
      }

      res.json({
        id: partner.id,
        email: partner.email,
        companyName: partner.companyName,
        contactName: partner.contactName,
        phone: partner.phone,
        profession: partner.profession,
        clientBaseSize: partner.clientBaseSize,
        logoUrl: partner.logoUrl,
        slug: partner.slug,
        inviteCode: partner.inviteCode,
        commissionRate: partner.commissionRate,
        createdAt: partner.createdAt,
      });
    } catch (error) {
      console.error("Error fetching partner profile:", error);
      res.status(500).json({ error: "Failed to fetch profile" });
    }
  });

  // Get partner's referred applications (filtered and redacted)
  app.get("/api/partner/applications", async (req, res) => {
    try {
      if (!req.session.user?.isAuthenticated || req.session.user.role !== "partner" || !req.session.user.partnerId) {
        return res.status(401).json({ error: "Partner authentication required" });
      }

      const partnerId = req.session.user.partnerId;
      const applications = await storage.getApplicationsByPartnerId(partnerId);

      // Redact sensitive fields - partners should only see status, not sensitive data
      const redactedApplications = applications.map((app) => ({
        id: app.id,
        businessName: app.businessName || app.legalBusinessName,
        contactName: app.fullName,
        email: app.email, // Partners may need to know which client this is
        phone: app.phone,
        requestedAmount: app.requestedAmount,
        status: getApplicationStatus(app),
        createdAt: app.createdAt,
        updatedAt: app.updatedAt,
        // Business context (non-sensitive)
        industry: app.industry,
        timeInBusiness: app.timeInBusiness,
        // Progress indicators
        isCompleted: app.isCompleted,
        isFullApplicationCompleted: app.isFullApplicationCompleted,
        hasBankConnection: !!app.plaidItemId,
      }));

      res.json(redactedApplications);
    } catch (error) {
      console.error("Error fetching partner applications:", error);
      res.status(500).json({ error: "Failed to fetch applications" });
    }
  });

  // Helper function to determine application status for partners
  function getApplicationStatus(app: LoanApplication): string {
    if (!app.isCompleted) return "Intake Started";
    if (!app.isFullApplicationCompleted) return "Pre-Qualified";
    if (!app.plaidItemId) return "Application Submitted";
    // Could add more statuses based on other fields in the future
    return "Under Review";
  }

  // Get partner stats/dashboard summary
  app.get("/api/partner/stats", async (req, res) => {
    try {
      if (!req.session.user?.isAuthenticated || req.session.user.role !== "partner" || !req.session.user.partnerId) {
        return res.status(401).json({ error: "Partner authentication required" });
      }

      const partnerId = req.session.user.partnerId;
      const applications = await storage.getApplicationsByPartnerId(partnerId);
      const partner = await storage.getPartner(partnerId);

      const totalReferrals = applications.length;
      const intakeCompleted = applications.filter((a) => a.isCompleted).length;
      const fullAppsCompleted = applications.filter((a) => a.isFullApplicationCompleted).length;
      const withBankConnection = applications.filter((a) => a.plaidItemId).length;

      // Calculate total requested volume
      const totalRequestedVolume = applications.reduce((sum, app) => {
        const amount = parseFloat(app.requestedAmount?.toString() || "0");
        return sum + (isNaN(amount) ? 0 : amount);
      }, 0);

      // Estimated commission (based on requested amounts, not funded - placeholder)
      const commissionRate = parseFloat(partner?.commissionRate?.toString() || "3") / 100;
      const estimatedCommission = totalRequestedVolume * commissionRate;

      res.json({
        totalReferrals,
        intakeCompleted,
        fullAppsCompleted,
        withBankConnection,
        totalRequestedVolume,
        estimatedCommission,
        commissionRate: partner?.commissionRate || "3.00",
      });
    } catch (error) {
      console.error("Error fetching partner stats:", error);
      res.status(500).json({ error: "Failed to fetch stats" });
    }
  });

  // Validate referral code (for /r/:code route)
  app.get("/api/partner/validate-code/:code", async (req, res) => {
    try {
      const { code } = req.params;
      const partner = await storage.getPartnerByInviteCode(code.toUpperCase());

      if (!partner || !partner.isActive) {
        return res.status(404).json({ valid: false, error: "Invalid referral code" });
      }

      res.json({
        valid: true,
        partnerId: partner.id,
        companyName: partner.companyName,
      });
    } catch (error) {
      console.error("Error validating referral code:", error);
      res.status(500).json({ valid: false, error: "Failed to validate code" });
    }
  });

  // Validate partner slug (for /apply/:slug application pages)
  app.get("/api/partner/validate-slug/:slug", async (req, res) => {
    try {
      const { slug } = req.params;
      const partner = await storage.getPartnerBySlug(slug.toLowerCase());

      if (!partner || !partner.isActive) {
        return res.status(404).json({ valid: false, error: "Invalid partner link" });
      }

      res.json({
        valid: true,
        partnerId: partner.id,
        companyName: partner.companyName,
        contactName: partner.contactName,
      });
    } catch (error) {
      console.error("Error validating partner slug:", error);
      res.status(500).json({ valid: false, error: "Failed to validate partner" });
    }
  });

  // Admin: Get all partners (admin only)
  app.get("/api/admin/partners", async (req, res) => {
    try {
      if (!req.session.user?.isAuthenticated || req.session.user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const partners = await storage.getAllPartners();

      // Include application counts for each partner
      const partnersWithStats = await Promise.all(
        partners.map(async (partner) => {
          const applications = await storage.getApplicationsByPartnerId(partner.id);
          return {
            id: partner.id,
            email: partner.email,
            companyName: partner.companyName,
            contactName: partner.contactName,
            phone: partner.phone,
            profession: partner.profession,
            inviteCode: partner.inviteCode,
            commissionRate: partner.commissionRate,
            isActive: partner.isActive,
            totalReferrals: applications.length,
            createdAt: partner.createdAt,
          };
        })
      );

      res.json(partnersWithStats);
    } catch (error) {
      console.error("Error fetching partners:", error);
      res.status(500).json({ error: "Failed to fetch partners" });
    }
  });

  // Admin: Update partner (enable/disable, change commission rate)
  app.patch("/api/admin/partners/:id", async (req, res) => {
    try {
      if (!req.session.user?.isAuthenticated || req.session.user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const { id } = req.params;
      const { isActive, commissionRate } = req.body;

      const updates: any = {};
      if (typeof isActive === "boolean") updates.isActive = isActive;
      if (commissionRate !== undefined) updates.commissionRate = commissionRate.toString();

      const partner = await storage.updatePartner(id, updates);
      if (!partner) {
        return res.status(404).json({ error: "Partner not found" });
      }

      res.json({
        success: true,
        partner: {
          id: partner.id,
          email: partner.email,
          companyName: partner.companyName,
          isActive: partner.isActive,
          commissionRate: partner.commissionRate,
        },
      });
    } catch (error) {
      console.error("Error updating partner:", error);
      res.status(500).json({ error: "Failed to update partner" });
    }
  });

  // ========================================
  // FUNDING CHECK / PRE-QUALIFICATION ROUTES
  // ========================================

  // Configure multer for funding check uploads (memory storage for immediate processing)
  const fundingCheckUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
    fileFilter: (_req, file, cb) => {
      if (file.mimetype === "application/pdf") {
        cb(null, true);
      } else {
        cb(new Error("Only PDF files are allowed"));
      }
    },
  });

  // Check if OpenAI is configured
  app.get("/api/funding-check/status", (_req, res) => {
    res.json({
      available: isOpenAIConfigured(),
      message: isOpenAIConfigured()
        ? "Funding check service is available"
        : "Funding check service is not configured. Please set OPENAI_API_KEY.",
    });
  });

  // Analyze bank statements for funding eligibility
  app.post(
    "/api/funding-check/analyze",
    fundingCheckUpload.array("statements", 6), // Allow up to 6 statements
    async (req, res) => {
      try {
        // Check if OpenAI is configured
        if (!isOpenAIConfigured()) {
          return res.status(503).json({
            error: "Funding check service is not available",
            message: "Please contact support to enable this feature.",
          });
        }

        const files = req.files as Express.Multer.File[];

        if (!files || files.length === 0) {
          return res.status(400).json({
            error: "No files uploaded",
            message: "Please upload at least one bank statement PDF.",
          });
        }

        console.log(`[FUNDING CHECK] Processing ${files.length} PDF file(s)`);

        // Get email from request body for saving statements
        const email = req.body.email;

        // Extract text from all PDFs and save them to storage
        const extractedTexts: string[] = [];

        for (const file of files) {
          try {
            const parser = new PDFParse({ data: file.buffer });
            const result = await parser.getText();
            const text = result.text || "";
            extractedTexts.push(
              `--- Statement: ${file.originalname} ---\n${text}\n`
            );
            console.log(
              `[FUNDING CHECK] Extracted ${text.length} characters from ${file.originalname}`
            );
            await parser.destroy();

            // Save to object storage with "Checker" source tag if email provided
            if (email && objectStorage.isConfigured()) {
              try {
                const storedFileName = await objectStorage.uploadFile(
                  file.buffer,
                  file.originalname,
                  file.mimetype
                );
                await storage.createBankStatementUpload({
                  email,
                  businessName: req.body.businessName || null,
                  loanApplicationId: null,
                  originalFileName: file.originalname,
                  storedFileName: storedFileName,
                  mimeType: file.mimetype,
                  fileSize: file.size,
                  source: "Checker",
                });
                console.log(`[FUNDING CHECK] Saved ${file.originalname} to storage with Checker tag`);
              } catch (saveError) {
                console.error(`[FUNDING CHECK] Failed to save ${file.originalname}:`, saveError);
              }
            }
          } catch (pdfError) {
            console.error(
              `[FUNDING CHECK] Error parsing ${file.originalname}:`,
              pdfError
            );
            extractedTexts.push(
              `--- Statement: ${file.originalname} ---\n[Error: Could not extract text from this PDF. It may be scanned/image-based.]\n`
            );
          }
        }

        const combinedText = extractedTexts.join("\n\n");

        // Get additional info from request body
        const additionalInfo = {
          creditScoreRange: req.body.creditScoreRange,
          timeInBusiness: req.body.timeInBusiness,
          industry: req.body.industry,
        };

        console.log("[FUNDING CHECK] Sending to OpenAI for analysis...");

        // Analyze with OpenAI
        const analysis = await analyzeBankStatements(combinedText, additionalInfo);

        console.log(
          `[FUNDING CHECK] Analysis complete. Score: ${analysis.overallScore}, Tier: ${analysis.qualificationTier}`
        );

        res.json({
          success: true,
          analysis,
          filesProcessed: files.length,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        console.error("[FUNDING CHECK] Analysis error:", error);
        res.status(500).json({
          error: "Analysis failed",
          message:
            error instanceof Error
              ? error.message
              : "An unexpected error occurred during analysis.",
        });
      }
    }
  );

  // ========================================
  // APPROVAL EMAIL SCANNING ROUTES
  // ========================================

  // Check Google Sheets connection status (admin only)
  app.get("/api/approvals/gmail-status", async (req, res) => {
    const user = (req.session as any)?.user;
    if (!user?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }
    if (user.role !== "admin") {
      return res.status(403).json({ error: "Admin access required" });
    }

    try {
      // Now checking Google Sheets connection instead of Gmail
      const isConfigured = await googleSheetsService.isConfigured();
      res.json({ connected: isConfigured, source: "google_sheets" });
    } catch (error) {
      res.json({ connected: false, error: "Failed to check Google Sheets status" });
    }
  });

  // Get all approvals (admin only)
  app.get("/api/approvals", async (req, res) => {
    const user = (req.session as any)?.user;
    if (!user?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }
    if (user.role !== "admin") {
      return res.status(403).json({ error: "Admin access required" });
    }

    try {
      const approvals = await storage.getAllLenderApprovals();
      res.json(approvals);
    } catch (error) {
      console.error("[APPROVALS] Error fetching approvals:", error);
      res.status(500).json({ error: "Failed to fetch approvals" });
    }
  });

  // Get approvals grouped by business (admin only)
  app.get("/api/approvals/by-business", async (req, res) => {
    const user = (req.session as any)?.user;
    if (!user?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }
    if (user.role !== "admin") {
      return res.status(403).json({ error: "Admin access required" });
    }

    try {
      const approvals = await storage.getAllLenderApprovals();
      
      // Group by business name
      const grouped: Record<string, typeof approvals> = {};
      for (const approval of approvals) {
        const key = approval.businessName || "Unknown Business";
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(approval);
      }
      
      res.json(grouped);
    } catch (error) {
      console.error("[APPROVALS] Error fetching approvals by business:", error);
      res.status(500).json({ error: "Failed to fetch approvals" });
    }
  });

  // Get approvals grouped by lender (admin only)
  app.get("/api/approvals/by-lender", async (req, res) => {
    const user = (req.session as any)?.user;
    if (!user?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }
    if (user.role !== "admin") {
      return res.status(403).json({ error: "Admin access required" });
    }

    try {
      const approvals = await storage.getAllLenderApprovals();
      
      // Group by lender name
      const grouped: Record<string, typeof approvals> = {};
      for (const approval of approvals) {
        const key = approval.lenderName || "Unknown Lender";
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(approval);
      }
      
      res.json(grouped);
    } catch (error) {
      console.error("[APPROVALS] Error fetching approvals by lender:", error);
      res.status(500).json({ error: "Failed to fetch approvals" });
    }
  });

  // Manual scan trigger - sync approvals from Google Sheets (admin only)
  app.post("/api/approvals/scan", async (req, res) => {
    const user = (req.session as any)?.user;
    if (!user?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }
    if (user.role !== "admin") {
      return res.status(403).json({ error: "Admin access required" });
    }

    try {
      console.log(`[APPROVAL SYNC] Starting sync from Google Sheets...`);
      
      // Check if Google Sheets is configured
      const isSheetsConfigured = await googleSheetsService.isConfigured();
      if (!isSheetsConfigured) {
        return res.status(400).json({ error: "Google Sheets is not connected. Please connect your Google Sheets account first." });
      }
      
      // Fetch approvals from Google Sheets
      const sheetApprovals = await googleSheetsService.fetchApprovals();
      console.log(`[APPROVAL SYNC] Fetched ${sheetApprovals.length} approvals from Google Sheets`);
      
      const results = {
        scanned: sheetApprovals.length,
        newApprovals: 0,
        updated: 0,
        skipped: 0,
        errors: 0,
        ghlSynced: 0,
        ghlSkipped: 0,
        ghlErrors: 0,
        approvals: [] as any[]
      };
      
      for (const row of sheetApprovals) {
        try {
          // Check if we've already processed this row (using rowId as emailId for deduplication)
          const existing = await storage.getLenderApprovalByEmailId(row.rowId);
          
          if (existing) {
            // Update existing record if data changed
            const updates: any = {};
            if (row.approvedAmount && row.approvedAmount !== existing.approvedAmount?.toString()) {
              updates.approvedAmount = googleSheetsService.parseAmount(row.approvedAmount);
            }
            if (row.status && row.status !== existing.status) {
              updates.status = row.status.toLowerCase();
            }
            if (row.termLength && row.termLength !== existing.termLength) {
              updates.termLength = row.termLength;
            }
            if (row.factorRate && row.factorRate !== existing.factorRate) {
              updates.factorRate = row.factorRate;
            }
            if (row.notes && row.notes !== existing.notes) {
              updates.notes = row.notes;
            }
            
            if (Object.keys(updates).length > 0) {
              await storage.updateLenderApproval(existing.id, updates);
              console.log(`[APPROVAL SYNC] Updated approval: ${row.businessName}`);
              results.updated++;

              // If status changed to approved/denied, sync to GHL
              if (updates.status && (updates.status === 'approved' || updates.status === 'denied' || updates.status === 'declined')) {
                try {
                  const ghlResult = await ghlService.syncApprovalToOpportunity({
                    businessName: row.businessName,
                    lenderName: row.lenderName,
                    status: updates.status,
                    approvedAmount: row.approvedAmount,
                    termLength: row.termLength,
                    factorRate: row.factorRate,
                    paybackAmount: row.paybackAmount,
                    paymentAmount: row.paymentAmount,
                    paymentFrequency: row.paymentFrequency,
                    productType: row.productType
                  });

                  // Save GHL sync status to database
                  await storage.updateLenderApproval(existing.id, {
                    ghlSynced: ghlResult.success,
                    ghlSyncedAt: new Date(),
                    ghlSyncMessage: ghlResult.message,
                    ghlOpportunityId: ghlResult.opportunityId || null
                  });

                  if (ghlResult.success) {
                    console.log(`[APPROVAL SYNC] GHL sync success (update): ${ghlResult.message}`);
                    results.ghlSynced++;
                  } else {
                    console.log(`[APPROVAL SYNC] GHL sync skipped (update): ${ghlResult.message}`);
                    results.ghlSkipped++;
                  }
                } catch (ghlError: any) {
                  console.error(`[APPROVAL SYNC] GHL sync error (update) for ${row.businessName}:`, ghlError);
                  // Save error status to database
                  await storage.updateLenderApproval(existing.id, {
                    ghlSynced: false,
                    ghlSyncedAt: new Date(),
                    ghlSyncMessage: `Error: ${ghlError.message || 'Unknown error'}`
                  });
                  results.ghlErrors++;
                }
              }
            } else {
              results.skipped++;
            }
            continue;
          }
          
          // Create new approval record
          const approval = await storage.createLenderApproval({
            businessName: row.businessName,
            businessEmail: row.businessEmail || null,
            lenderName: row.lenderName,
            lenderEmail: row.lenderEmail || null,
            approvedAmount: googleSheetsService.parseAmount(row.approvedAmount),
            termLength: row.termLength || null,
            factorRate: row.factorRate || null,
            paybackAmount: googleSheetsService.parseAmount(row.paybackAmount),
            paymentFrequency: row.paymentFrequency || null,
            paymentAmount: googleSheetsService.parseAmount(row.paymentAmount),
            interestRate: row.interestRate || null,
            productType: row.productType || null,
            status: row.status?.toLowerCase() || "pending",
            expirationDate: row.expirationDate || null,
            conditions: row.conditions || null,
            notes: row.notes || null,
            emailId: row.rowId, // Use rowId for deduplication
            emailSubject: `Google Sheets Import - Row ${row.rowId}`,
            emailReceivedAt: googleSheetsService.parseDate(row.dateReceived) || new Date(),
            rawEmailContent: null
          });
          
          console.log(`[APPROVAL SYNC] Created approval: ${approval.businessName} - $${approval.approvedAmount} from ${approval.lenderName}`);
          results.newApprovals++;
          results.approvals.push({
            id: approval.id,
            businessName: approval.businessName,
            lenderName: approval.lenderName,
            approvedAmount: approval.approvedAmount
          });

          // Sync to GHL opportunity (if status is approved/denied)
          try {
            const ghlResult = await ghlService.syncApprovalToOpportunity({
              businessName: row.businessName,
              lenderName: row.lenderName,
              status: row.status || 'pending',
              approvedAmount: row.approvedAmount,
              termLength: row.termLength,
              factorRate: row.factorRate,
              paybackAmount: row.paybackAmount,
              paymentAmount: row.paymentAmount,
              paymentFrequency: row.paymentFrequency,
              productType: row.productType
            });

            // Save GHL sync status to database
            await storage.updateLenderApproval(approval.id, {
              ghlSynced: ghlResult.success,
              ghlSyncedAt: new Date(),
              ghlSyncMessage: ghlResult.message,
              ghlOpportunityId: ghlResult.opportunityId || null
            });

            if (ghlResult.success) {
              console.log(`[APPROVAL SYNC] GHL sync success: ${ghlResult.message}`);
              results.ghlSynced++;
            } else {
              console.log(`[APPROVAL SYNC] GHL sync skipped: ${ghlResult.message}`);
              results.ghlSkipped++;
            }
          } catch (ghlError: any) {
            console.error(`[APPROVAL SYNC] GHL sync error for ${row.businessName}:`, ghlError);
            // Save error status to database
            await storage.updateLenderApproval(approval.id, {
              ghlSynced: false,
              ghlSyncedAt: new Date(),
              ghlSyncMessage: `Error: ${ghlError.message || 'Unknown error'}`
            });
            results.ghlErrors++;
          }

        } catch (rowError) {
          console.error(`[APPROVAL SYNC] Error processing row ${row.rowId}:`, rowError);
          results.errors++;
        }
      }

      console.log(`[APPROVAL SYNC] Complete. New: ${results.newApprovals}, Updated: ${results.updated}, Skipped: ${results.skipped}, Errors: ${results.errors}, GHL Synced: ${results.ghlSynced}, GHL Skipped: ${results.ghlSkipped}`);
      
      res.json(results);
      
    } catch (error) {
      console.error("[APPROVAL SYNC] Error during sync:", error);
      res.status(500).json({ error: "Failed to sync approvals from Google Sheets" });
    }
  });

  // Update approval status (admin only)
  app.patch("/api/approvals/:id", async (req, res) => {
    const user = (req.session as any)?.user;
    if (!user?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }
    if (user.role !== "admin") {
      return res.status(403).json({ error: "Admin access required" });
    }

    try {
      const { id } = req.params;
      const updates = req.body;
      
      const updated = await storage.updateLenderApproval(id, updates);
      if (!updated) {
        return res.status(404).json({ error: "Approval not found" });
      }
      
      res.json(updated);
    } catch (error) {
      console.error("[APPROVALS] Error updating approval:", error);
      res.status(500).json({ error: "Failed to update approval" });
    }
  });

  // Get approval statistics (admin only)
  app.get("/api/approvals/stats", async (req, res) => {
    const user = (req.session as any)?.user;
    if (!user?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }
    if (user.role !== "admin") {
      return res.status(403).json({ error: "Admin access required" });
    }

    try {
      const approvals = await storage.getAllLenderApprovals();
      
      // Calculate stats
      const totalApprovals = approvals.length;
      const pendingApprovals = approvals.filter(a => a.status === "pending").length;
      const acceptedApprovals = approvals.filter(a => a.status === "accepted").length;
      const totalApprovedAmount = approvals.reduce((sum, a) => sum + (parseFloat(a.approvedAmount?.toString() || "0") || 0), 0);
      
      // Unique businesses and lenders
      const uniqueBusinesses = new Set(approvals.map(a => a.businessName)).size;
      const uniqueLenders = new Set(approvals.map(a => a.lenderName)).size;
      
      res.json({
        totalApprovals,
        pendingApprovals,
        acceptedApprovals,
        totalApprovedAmount,
        uniqueBusinesses,
        uniqueLenders
      });
    } catch (error) {
      console.error("[APPROVALS] Error fetching stats:", error);
      res.status(500).json({ error: "Failed to fetch stats" });
    }
  });

  const httpServer = createServer(app);

  // Schedule hourly approval syncs from Google Sheets
  const SCAN_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  
  async function runScheduledSync() {
    console.log("[SCHEDULED SYNC] Running hourly Google Sheets approval sync...");
    
    try {
      const isSheetsConfigured = await googleSheetsService.isConfigured();
      if (!isSheetsConfigured) {
        console.log("[SCHEDULED SYNC] Google Sheets not configured, skipping sync");
        return;
      }
      
      // Fetch all approvals from Google Sheets
      const sheetApprovals = await googleSheetsService.fetchApprovals();
      console.log(`[SCHEDULED SYNC] Found ${sheetApprovals.length} approvals in sheet`);
      
      let newApprovals = 0;
      let updatedApprovals = 0;
      let ghlSynced = 0;
      let ghlSkipped = 0;

      for (const row of sheetApprovals) {
        try {
          // Check if already processed
          const existing = await storage.getLenderApprovalByEmailId(row.rowId);

          if (existing) {
            // Check if any data has changed and update if needed
            const updates: any = {};
            if (row.approvedAmount && row.approvedAmount !== existing.approvedAmount?.toString()) {
              updates.approvedAmount = googleSheetsService.parseAmount(row.approvedAmount);
            }
            if (row.status && row.status.toLowerCase() !== existing.status) {
              updates.status = row.status.toLowerCase();
            }

            if (Object.keys(updates).length > 0) {
              await storage.updateLenderApproval(existing.id, updates);
              updatedApprovals++;

              // If status changed to approved/denied, sync to GHL
              if (updates.status && (updates.status === 'approved' || updates.status === 'denied' || updates.status === 'declined')) {
                try {
                  const ghlResult = await ghlService.syncApprovalToOpportunity({
                    businessName: row.businessName,
                    lenderName: row.lenderName,
                    status: updates.status,
                    approvedAmount: row.approvedAmount,
                    termLength: row.termLength,
                    factorRate: row.factorRate,
                    paybackAmount: row.paybackAmount,
                    paymentAmount: row.paymentAmount,
                    paymentFrequency: row.paymentFrequency,
                    productType: row.productType
                  });
                  // Save GHL sync status
                  await storage.updateLenderApproval(existing.id, {
                    ghlSynced: ghlResult.success,
                    ghlSyncedAt: new Date(),
                    ghlSyncMessage: ghlResult.message,
                    ghlOpportunityId: ghlResult.opportunityId || null
                  });
                  if (ghlResult.success) ghlSynced++;
                  else ghlSkipped++;
                } catch (ghlError: any) {
                  console.error(`[SCHEDULED SYNC] GHL sync error:`, ghlError);
                  await storage.updateLenderApproval(existing.id, {
                    ghlSynced: false,
                    ghlSyncedAt: new Date(),
                    ghlSyncMessage: `Error: ${ghlError.message || 'Unknown error'}`
                  });
                }
              }
            }
            continue;
          }

          // Create new approval
          const newApproval = await storage.createLenderApproval({
            businessName: row.businessName,
            businessEmail: row.businessEmail || null,
            lenderName: row.lenderName,
            lenderEmail: row.lenderEmail || null,
            approvedAmount: googleSheetsService.parseAmount(row.approvedAmount),
            termLength: row.termLength || null,
            factorRate: row.factorRate || null,
            paybackAmount: googleSheetsService.parseAmount(row.paybackAmount),
            paymentFrequency: row.paymentFrequency || null,
            paymentAmount: googleSheetsService.parseAmount(row.paymentAmount),
            interestRate: row.interestRate || null,
            productType: row.productType || null,
            status: row.status?.toLowerCase() || "pending",
            expirationDate: row.expirationDate || null,
            conditions: row.conditions || null,
            notes: row.notes || null,
            emailId: row.rowId,
            emailSubject: `Google Sheets Import - Row ${row.rowId}`,
            emailReceivedAt: googleSheetsService.parseDate(row.dateReceived) || new Date(),
            rawEmailContent: null
          });
          newApprovals++;

          // Sync new approval to GHL opportunity (if status is approved/denied)
          try {
            const ghlResult = await ghlService.syncApprovalToOpportunity({
              businessName: row.businessName,
              lenderName: row.lenderName,
              status: row.status || 'pending',
              approvedAmount: row.approvedAmount,
              termLength: row.termLength,
              factorRate: row.factorRate,
              paybackAmount: row.paybackAmount,
              paymentAmount: row.paymentAmount,
              paymentFrequency: row.paymentFrequency,
              productType: row.productType
            });
            // Save GHL sync status
            await storage.updateLenderApproval(newApproval.id, {
              ghlSynced: ghlResult.success,
              ghlSyncedAt: new Date(),
              ghlSyncMessage: ghlResult.message,
              ghlOpportunityId: ghlResult.opportunityId || null
            });
            if (ghlResult.success) ghlSynced++;
            else ghlSkipped++;
          } catch (ghlError: any) {
            console.error(`[SCHEDULED SYNC] GHL sync error:`, ghlError);
            await storage.updateLenderApproval(newApproval.id, {
              ghlSynced: false,
              ghlSyncedAt: new Date(),
              ghlSyncMessage: `Error: ${ghlError.message || 'Unknown error'}`
            });
          }
        } catch (rowError) {
          console.error(`[SCHEDULED SYNC] Error processing row:`, rowError);
        }
      }

      console.log(`[SCHEDULED SYNC] Complete. New: ${newApprovals}, Updated: ${updatedApprovals}, GHL Synced: ${ghlSynced}, GHL Skipped: ${ghlSkipped}`);
      
    } catch (error) {
      console.error("[SCHEDULED SYNC] Error during scheduled sync:", error);
    }
  }
  
  // Google Sheets approval sync disabled — approval tracking handled via underwriting decisions
  // setInterval(runScheduledSync, SCAN_INTERVAL_MS);
  console.log("[STARTUP] Google Sheets approval sync disabled");

  // ========================================
  // REP CONSOLE ROUTES
  // ========================================

  /**
   * GET /api/rep-console/search
   *
   * Search for contacts by email, phone, or name.
   * Used for quick contact lookup in the Rep Console.
   *
   * IMPORTANT: This route must be defined BEFORE /:contactId to avoid
   * "search" being matched as a contactId parameter.
   */
  app.get("/api/rep-console/search", async (req, res) => {
    try {
      // Check authentication
      const user = req.session?.user;
      if (!user?.isAuthenticated || (user.role !== 'admin' && user.role !== 'agent')) {
        return res.status(401).json({
          success: false,
          error: "Unauthorized"
        });
      }

      const query = req.query.q as string;
      if (!query || query.length < 2) {
        return res.status(400).json({
          success: false,
          error: "Search query must be at least 2 characters"
        });
      }

      // Search in local database first (faster)
      const localResults = await storage.getLoanApplicationByEmailOrPhone(query);

      return res.json({
        success: true,
        data: {
          localMatch: localResults ? {
            id: localResults.id,
            email: localResults.email,
            phone: localResults.phone,
            businessName: localResults.businessName || localResults.legalBusinessName,
            fullName: localResults.fullName,
            ghlContactId: localResults.ghlContactId
          } : null
        }
      });

    } catch (error: any) {
      console.error("[REP CONSOLE SEARCH] Error:", error);
      return res.status(500).json({
        success: false,
        error: "Search failed"
      });
    }
  });

  /**
   * GET /api/rep-console/smart-lists
   *
   * Get all available smart lists with contact counts for the agent call queue.
   * NOTE: This MUST be defined BEFORE the :contactId wildcard route
   */
  app.get("/api/rep-console/smart-lists", async (req, res) => {
    try {
      const user = req.session?.user;
      if (!user?.isAuthenticated || (user.role !== 'admin' && user.role !== 'agent')) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
      }

      const result = await repConsoleService.getSmartLists();
      return res.json({ success: true, data: result });

    } catch (error: any) {
      console.error("[REP CONSOLE SMART LISTS] Error:", error);
      return res.status(500).json({ success: false, error: error.message || "Failed to fetch smart lists" });
    }
  });

  /**
   * GET /api/rep-console/smart-lists/:listId
   *
   * Get contacts for a specific smart list.
   * NOTE: This MUST be defined BEFORE the :contactId wildcard route
   */
  app.get("/api/rep-console/smart-lists/:listId", async (req, res) => {
    try {
      const user = req.session?.user;
      if (!user?.isAuthenticated || (user.role !== 'admin' && user.role !== 'agent')) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
      }

      const { listId } = req.params;
      const limit = parseInt(req.query.limit as string) || 50;

      const result = await repConsoleService.getSmartListContacts(listId, limit);
      return res.json({ success: true, data: result });

    } catch (error: any) {
      console.error("[REP CONSOLE SMART LIST CONTACTS] Error:", error);
      return res.status(500).json({ success: false, error: error.message || "Failed to fetch list contacts" });
    }
  });

  /**
   * GET /api/rep-console/:contactId
   *
   * Aggregates all contact data from GoHighLevel into a unified Contact360 view.
   * Returns: contact info, active opportunity, tasks, notes, conversations, lender approvals.
   *
   * Query params:
   * - locationId (optional): GHL location ID. Falls back to env var if not provided.
   */
  app.get("/api/rep-console/:contactId", async (req, res) => {
    try {
      // Check authentication (admin or agent role)
      const user = req.session?.user;
      if (!user?.isAuthenticated || (user.role !== 'admin' && user.role !== 'agent')) {
        return res.status(401).json({
          success: false,
          error: "Unauthorized. Must be logged in as admin or agent."
        });
      }

      const { contactId } = req.params;
      const locationId = req.query.locationId as string | undefined;

      if (!contactId) {
        return res.status(400).json({
          success: false,
          error: "Contact ID is required"
        });
      }

      console.log(`[REP CONSOLE] Fetching Contact360 for ${contactId}`);
      const contact360 = await repConsoleService.getContact360(contactId, locationId);

      return res.json({
        success: true,
        data: contact360
      });

    } catch (error: any) {
      console.error("[REP CONSOLE] Error fetching Contact360:", error);

      if (error.message?.includes('not found')) {
        return res.status(404).json({
          success: false,
          error: "Contact not found"
        });
      }

      if (error.message?.includes('not configured')) {
        return res.status(503).json({
          success: false,
          error: "GoHighLevel integration not configured"
        });
      }

      return res.status(500).json({
        success: false,
        error: error.message || "Failed to fetch contact data"
      });
    }
  });

  /**
   * POST /api/rep-console/smart-search
   *
   * Natural language contact search using AI to parse queries.
   * Returns a list of contacts matching the parsed criteria.
   */
  app.post("/api/rep-console/smart-search", async (req, res) => {
    try {
      // Check authentication
      const user = req.session?.user;
      if (!user?.isAuthenticated || (user.role !== 'admin' && user.role !== 'agent')) {
        return res.status(401).json({
          success: false,
          error: "Unauthorized"
        });
      }

      const { query } = req.body;
      if (!query || typeof query !== 'string' || query.length < 2) {
        return res.status(400).json({
          success: false,
          error: "Query must be at least 2 characters"
        });
      }

      console.log(`[REP CONSOLE] Smart search query: "${query}"`);

      // Parse the natural language query using AI
      const parsed = await parseContactSearchQuery(query);
      console.log(`[REP CONSOLE] Parsed query:`, parsed);

      // Execute the search based on parsed criteria
      let searchResults;
      
      if (parsed.searchType === 'tags' && parsed.tags && parsed.tags.length > 0) {
        searchResults = await repConsoleService.searchContactsByTags(
          parsed.tags,
          parsed.limit || 25
        );
      } else {
        searchResults = await repConsoleService.searchContacts({
          query: parsed.query || undefined,
          tags: parsed.tags || undefined,
          limit: parsed.limit || 25
        });
      }

      return res.json({
        success: true,
        data: {
          contacts: searchResults.contacts,
          total: searchResults.total,
          hasMore: searchResults.hasMore,
          parsedQuery: parsed
        }
      });

    } catch (error: any) {
      console.error("[REP CONSOLE SMART SEARCH] Error:", error);
      return res.status(500).json({
        success: false,
        error: error.message || "Smart search failed"
      });
    }
  });

  /**
   * GET /api/rep-console/contacts
   *
   * List contacts with optional filters for manual/structured search.
   */
  app.get("/api/rep-console/contacts", async (req, res) => {
    try {
      // Check authentication
      const user = req.session?.user;
      if (!user?.isAuthenticated || (user.role !== 'admin' && user.role !== 'agent')) {
        return res.status(401).json({
          success: false,
          error: "Unauthorized"
        });
      }

      const query = req.query.q as string | undefined;
      const tags = req.query.tags ? (req.query.tags as string).split(',') : undefined;
      const limit = parseInt(req.query.limit as string) || 25;

      const searchResults = await repConsoleService.searchContacts({
        query,
        tags,
        limit: Math.min(limit, 100)
      });

      return res.json({
        success: true,
        data: searchResults
      });

    } catch (error: any) {
      console.error("[REP CONSOLE CONTACTS] Error:", error);
      return res.status(500).json({
        success: false,
        error: error.message || "Failed to fetch contacts"
      });
    }
  });

  /**
   * POST /api/rep-console/:contactId/notes
   *
   * Add a note to a contact.
   */
  app.post("/api/rep-console/:contactId/notes", async (req, res) => {
    try {
      const user = req.session?.user;
      if (!user?.isAuthenticated || (user.role !== 'admin' && user.role !== 'agent')) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
      }

      const { contactId } = req.params;
      const { body } = req.body;

      if (!body || typeof body !== 'string') {
        return res.status(400).json({ success: false, error: "Note body is required" });
      }

      const result = await repConsoleService.addNoteToContact(contactId, body);
      
      if (result.success) {
        return res.json({ success: true, data: { noteId: result.noteId } });
      } else {
        return res.status(500).json({ success: false, error: result.error });
      }

    } catch (error: any) {
      console.error("[REP CONSOLE ADD NOTE] Error:", error);
      return res.status(500).json({ success: false, error: error.message || "Failed to add note" });
    }
  });

  /**
   * POST /api/rep-console/:contactId/tasks
   *
   * Create a task for a contact.
   */
  app.post("/api/rep-console/:contactId/tasks", async (req, res) => {
    try {
      const user = req.session?.user;
      if (!user?.isAuthenticated || (user.role !== 'admin' && user.role !== 'agent')) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
      }

      const { contactId } = req.params;
      const { title, dueDate, description } = req.body;

      if (!title || typeof title !== 'string') {
        return res.status(400).json({ success: false, error: "Task title is required" });
      }
      if (!dueDate) {
        return res.status(400).json({ success: false, error: "Due date is required" });
      }

      const result = await repConsoleService.createTaskForContact(contactId, title, dueDate, description);
      
      if (result.success) {
        return res.json({ success: true, data: { taskId: result.taskId } });
      } else {
        return res.status(500).json({ success: false, error: result.error });
      }

    } catch (error: any) {
      console.error("[REP CONSOLE CREATE TASK] Error:", error);
      return res.status(500).json({ success: false, error: error.message || "Failed to create task" });
    }
  });

  /**
   * POST /api/rep-console/:contactId/tags
   *
   * Add a tag to a contact.
   */
  app.post("/api/rep-console/:contactId/tags", async (req, res) => {
    try {
      const user = req.session?.user;
      if (!user?.isAuthenticated || (user.role !== 'admin' && user.role !== 'agent')) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
      }

      const { contactId } = req.params;
      const { tag } = req.body;

      if (!tag || typeof tag !== 'string') {
        return res.status(400).json({ success: false, error: "Tag is required" });
      }

      const result = await repConsoleService.addTagToContact(contactId, tag);
      
      if (result.success) {
        return res.json({ success: true });
      } else {
        return res.status(500).json({ success: false, error: result.error });
      }

    } catch (error: any) {
      console.error("[REP CONSOLE ADD TAG] Error:", error);
      return res.status(500).json({ success: false, error: error.message || "Failed to add tag" });
    }
  });

  /**
   * POST /api/rep-console/command
   *
   * Parse a natural language command and optionally execute it.
   * Supports search, add_note, create_task, add_tag intents.
   */
  app.post("/api/rep-console/command", async (req, res) => {
    try {
      const user = req.session?.user;
      if (!user?.isAuthenticated || (user.role !== 'admin' && user.role !== 'agent')) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
      }

      const { command, contactId, contactName, execute } = req.body;

      if (!command || typeof command !== 'string' || command.length < 2) {
        return res.status(400).json({ success: false, error: "Command must be at least 2 characters" });
      }

      console.log(`[REP CONSOLE COMMAND] Input: "${command}", Contact: ${contactName || 'none'}`);

      // Parse the command
      const parsed = await parseRepConsoleCommand(command, contactName);
      console.log(`[REP CONSOLE COMMAND] Parsed:`, parsed);

      // If execute is true and we have a contactId, execute the action
      if (execute && contactId && !parsed.requiresConfirmation) {
        let actionResult = null;

        switch (parsed.intent) {
          case 'add_note':
            if (parsed.actionParams?.noteBody) {
              actionResult = await repConsoleService.addNoteToContact(contactId, parsed.actionParams.noteBody);
            }
            break;
          case 'create_task':
            if (parsed.actionParams?.taskTitle && parsed.actionParams?.taskDueDate) {
              actionResult = await repConsoleService.createTaskForContact(
                contactId,
                parsed.actionParams.taskTitle,
                parsed.actionParams.taskDueDate
              );
            }
            break;
          case 'add_tag':
            if (parsed.actionParams?.tagName) {
              actionResult = await repConsoleService.addTagToContact(contactId, parsed.actionParams.tagName);
            }
            break;
        }

        return res.json({
          success: true,
          data: {
            parsed,
            executed: !!actionResult,
            actionResult
          }
        });
      }

      // Just return the parsed command for preview/confirmation
      return res.json({
        success: true,
        data: { parsed, executed: false }
      });

    } catch (error: any) {
      console.error("[REP CONSOLE COMMAND] Error:", error);
      return res.status(500).json({ success: false, error: error.message || "Command processing failed" });
    }
  });

  // ========================================
  // REP CONSOLE - ENHANCED GHL INTEGRATION
  // ========================================

  /**
   * GET /api/rep-console/pipelines
   * Get all pipelines with their stages
   */
  app.get("/api/rep-console/pipelines", async (req, res) => {
    try {
      const user = req.session?.user;
      if (!user?.isAuthenticated || (user.role !== 'admin' && user.role !== 'agent')) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
      }

      const result = await repConsoleService.getAllPipelines();
      return res.json({ success: true, pipelines: result.pipelines });

    } catch (error: any) {
      console.error("[REP CONSOLE PIPELINES] Error:", error);
      return res.status(500).json({ success: false, error: error.message || "Failed to fetch pipelines" });
    }
  });

  /**
   * PUT /api/rep-console/:contactId/tasks/:taskId
   * Update task (mark complete/incomplete)
   */
  app.put("/api/rep-console/:contactId/tasks/:taskId", async (req, res) => {
    try {
      const user = req.session?.user;
      if (!user?.isAuthenticated || (user.role !== 'admin' && user.role !== 'agent')) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
      }

      const { contactId, taskId } = req.params;
      const { completed } = req.body;

      if (typeof completed !== 'boolean') {
        return res.status(400).json({ success: false, error: "completed (boolean) is required" });
      }

      const result = await repConsoleService.updateTaskStatus(contactId, taskId, completed);

      if (result.success) {
        return res.json({ success: true });
      } else {
        return res.status(500).json({ success: false, error: result.error });
      }

    } catch (error: any) {
      console.error("[REP CONSOLE UPDATE TASK] Error:", error);
      return res.status(500).json({ success: false, error: error.message || "Failed to update task" });
    }
  });

  /**
   * DELETE /api/rep-console/:contactId/tasks/:taskId
   * Delete a task
   */
  app.delete("/api/rep-console/:contactId/tasks/:taskId", async (req, res) => {
    try {
      const user = req.session?.user;
      if (!user?.isAuthenticated || (user.role !== 'admin' && user.role !== 'agent')) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
      }

      const { contactId, taskId } = req.params;
      const result = await repConsoleService.deleteTask(contactId, taskId);

      if (result.success) {
        return res.json({ success: true });
      } else {
        return res.status(500).json({ success: false, error: result.error });
      }

    } catch (error: any) {
      console.error("[REP CONSOLE DELETE TASK] Error:", error);
      return res.status(500).json({ success: false, error: error.message || "Failed to delete task" });
    }
  });

  /**
   * PUT /api/rep-console/:contactId/notes/:noteId
   * Update a note
   */
  app.put("/api/rep-console/:contactId/notes/:noteId", async (req, res) => {
    try {
      const user = req.session?.user;
      if (!user?.isAuthenticated || (user.role !== 'admin' && user.role !== 'agent')) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
      }

      const { contactId, noteId } = req.params;
      const { body } = req.body;

      if (!body || typeof body !== 'string') {
        return res.status(400).json({ success: false, error: "body (string) is required" });
      }

      const result = await repConsoleService.updateNote(contactId, noteId, body);

      if (result.success) {
        return res.json({ success: true });
      } else {
        return res.status(500).json({ success: false, error: result.error });
      }

    } catch (error: any) {
      console.error("[REP CONSOLE UPDATE NOTE] Error:", error);
      return res.status(500).json({ success: false, error: error.message || "Failed to update note" });
    }
  });

  /**
   * DELETE /api/rep-console/:contactId/notes/:noteId
   * Delete a note
   */
  app.delete("/api/rep-console/:contactId/notes/:noteId", async (req, res) => {
    try {
      const user = req.session?.user;
      if (!user?.isAuthenticated || (user.role !== 'admin' && user.role !== 'agent')) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
      }

      const { contactId, noteId } = req.params;
      const result = await repConsoleService.deleteNote(contactId, noteId);

      if (result.success) {
        return res.json({ success: true });
      } else {
        return res.status(500).json({ success: false, error: result.error });
      }

    } catch (error: any) {
      console.error("[REP CONSOLE DELETE NOTE] Error:", error);
      return res.status(500).json({ success: false, error: error.message || "Failed to delete note" });
    }
  });

  /**
   * DELETE /api/rep-console/:contactId/tags/:tag
   * Remove a tag from contact
   */
  app.delete("/api/rep-console/:contactId/tags/:tag", async (req, res) => {
    try {
      const user = req.session?.user;
      if (!user?.isAuthenticated || (user.role !== 'admin' && user.role !== 'agent')) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
      }

      const { contactId, tag } = req.params;
      const result = await repConsoleService.removeTagFromContact(contactId, decodeURIComponent(tag));

      if (result.success) {
        return res.json({ success: true });
      } else {
        return res.status(500).json({ success: false, error: result.error });
      }

    } catch (error: any) {
      console.error("[REP CONSOLE REMOVE TAG] Error:", error);
      return res.status(500).json({ success: false, error: error.message || "Failed to remove tag" });
    }
  });

  /**
   * PUT /api/rep-console/:contactId
   * Update contact fields
   */
  app.put("/api/rep-console/:contactId", async (req, res) => {
    try {
      const user = req.session?.user;
      if (!user?.isAuthenticated || (user.role !== 'admin' && user.role !== 'agent')) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
      }

      const { contactId } = req.params;
      const { firstName, lastName, email, phone, companyName, address1, city, state, postalCode } = req.body;

      const updates: any = {};
      if (firstName !== undefined) updates.firstName = firstName;
      if (lastName !== undefined) updates.lastName = lastName;
      if (email !== undefined) updates.email = email;
      if (phone !== undefined) updates.phone = phone;
      if (companyName !== undefined) updates.companyName = companyName;
      if (address1 !== undefined) updates.address1 = address1;
      if (city !== undefined) updates.city = city;
      if (state !== undefined) updates.state = state;
      if (postalCode !== undefined) updates.postalCode = postalCode;

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ success: false, error: "No fields to update" });
      }

      const result = await repConsoleService.updateContact(contactId, updates);

      if (result.success) {
        return res.json({ success: true });
      } else {
        return res.status(500).json({ success: false, error: result.error });
      }

    } catch (error: any) {
      console.error("[REP CONSOLE UPDATE CONTACT] Error:", error);
      return res.status(500).json({ success: false, error: error.message || "Failed to update contact" });
    }
  });

  /**
   * PUT /api/rep-console/opportunities/:opportunityId/stage
   * Update opportunity pipeline stage
   */
  app.put("/api/rep-console/opportunities/:opportunityId/stage", async (req, res) => {
    try {
      const user = req.session?.user;
      if (!user?.isAuthenticated || (user.role !== 'admin' && user.role !== 'agent')) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
      }

      const { opportunityId } = req.params;
      const { pipelineStageId } = req.body;

      if (!pipelineStageId || typeof pipelineStageId !== 'string') {
        return res.status(400).json({ success: false, error: "pipelineStageId is required" });
      }

      const result = await repConsoleService.updateOpportunityStage(opportunityId, pipelineStageId);

      if (result.success) {
        return res.json({ success: true });
      } else {
        return res.status(500).json({ success: false, error: result.error });
      }

    } catch (error: any) {
      console.error("[REP CONSOLE UPDATE STAGE] Error:", error);
      return res.status(500).json({ success: false, error: error.message || "Failed to update stage" });
    }
  });

  /**
   * PUT /api/rep-console/opportunities/:opportunityId/status
   * Update opportunity status (open, won, lost, abandoned)
   */
  app.put("/api/rep-console/opportunities/:opportunityId/status", async (req, res) => {
    try {
      const user = req.session?.user;
      if (!user?.isAuthenticated || (user.role !== 'admin' && user.role !== 'agent')) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
      }

      const { opportunityId } = req.params;
      const { status } = req.body;

      if (!status || !['open', 'won', 'lost', 'abandoned'].includes(status)) {
        return res.status(400).json({ success: false, error: "status must be one of: open, won, lost, abandoned" });
      }

      const result = await repConsoleService.updateOpportunityStatus(opportunityId, status);

      if (result.success) {
        return res.json({ success: true });
      } else {
        return res.status(500).json({ success: false, error: result.error });
      }

    } catch (error: any) {
      console.error("[REP CONSOLE UPDATE STATUS] Error:", error);
      return res.status(500).json({ success: false, error: error.message || "Failed to update status" });
    }
  });

  /**
   * PUT /api/rep-console/opportunities/:opportunityId/value
   * Update opportunity monetary value
   */
  app.put("/api/rep-console/opportunities/:opportunityId/value", async (req, res) => {
    try {
      const user = req.session?.user;
      if (!user?.isAuthenticated || (user.role !== 'admin' && user.role !== 'agent')) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
      }

      const { opportunityId } = req.params;
      const { monetaryValue } = req.body;

      if (typeof monetaryValue !== 'number' || monetaryValue < 0) {
        return res.status(400).json({ success: false, error: "monetaryValue (number >= 0) is required" });
      }

      const result = await repConsoleService.updateOpportunityValue(opportunityId, monetaryValue);

      if (result.success) {
        return res.json({ success: true });
      } else {
        return res.status(500).json({ success: false, error: result.error });
      }

    } catch (error: any) {
      console.error("[REP CONSOLE UPDATE VALUE] Error:", error);
      return res.status(500).json({ success: false, error: error.message || "Failed to update value" });
    }
  });

  /**
   * PUT /api/rep-console/opportunities/:opportunityId/next-action
   * Update opportunity next action and due date
   */
  app.put("/api/rep-console/opportunities/:opportunityId/next-action", async (req, res) => {
    try {
      const user = req.session?.user;
      if (!user?.isAuthenticated || (user.role !== 'admin' && user.role !== 'agent')) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
      }

      const { opportunityId } = req.params;
      const { nextAction, nextActionDue } = req.body;

      // Update custom fields on the opportunity
      const result = await repConsoleService.updateOpportunityNextAction(opportunityId, nextAction, nextActionDue);

      if (result.success) {
        return res.json({ success: true });
      } else {
        return res.status(500).json({ success: false, error: result.error });
      }

    } catch (error: any) {
      console.error("[REP CONSOLE UPDATE NEXT ACTION] Error:", error);
      return res.status(500).json({ success: false, error: error.message || "Failed to update next action" });
    }
  });

  /**
   * POST /api/rep-console/:contactId/sms
   * Send SMS to contact
   */
  app.post("/api/rep-console/:contactId/sms", async (req, res) => {
    try {
      const user = req.session?.user;
      if (!user?.isAuthenticated || (user.role !== 'admin' && user.role !== 'agent')) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
      }

      const { contactId } = req.params;
      const { message } = req.body;

      if (!message || typeof message !== 'string') {
        return res.status(400).json({ success: false, error: "message is required" });
      }

      const result = await repConsoleService.sendSMS(contactId, message);

      if (result.success) {
        return res.json({ success: true, messageId: result.messageId });
      } else {
        return res.status(500).json({ success: false, error: result.error });
      }

    } catch (error: any) {
      console.error("[REP CONSOLE SEND SMS] Error:", error);
      return res.status(500).json({ success: false, error: error.message || "Failed to send SMS" });
    }
  });

  /**
   * POST /api/rep-console/:contactId/email
   * Send Email to contact
   */
  app.post("/api/rep-console/:contactId/email", async (req, res) => {
    try {
      const user = req.session?.user;
      if (!user?.isAuthenticated || (user.role !== 'admin' && user.role !== 'agent')) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
      }

      const { contactId } = req.params;
      const { subject, body } = req.body;

      if (!subject || typeof subject !== 'string') {
        return res.status(400).json({ success: false, error: "subject is required" });
      }
      if (!body || typeof body !== 'string') {
        return res.status(400).json({ success: false, error: "body is required" });
      }

      const result = await repConsoleService.sendEmail(contactId, subject, body);

      if (result.success) {
        return res.json({ success: true, messageId: result.messageId });
      } else {
        return res.status(500).json({ success: false, error: result.error });
      }

    } catch (error: any) {
      console.error("[REP CONSOLE SEND EMAIL] Error:", error);
      return res.status(500).json({ success: false, error: error.message || "Failed to send email" });
    }
  });

  // Leaderboard API - public endpoint for TV display
  app.get("/api/leaderboard", async (_req, res) => {
    try {
      const applications = await storage.getAllLoanApplications();
      const decisions = await storage.getAllBusinessUnderwritingDecisions();

      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - 7);

      // Applications: count per agentName (last 30 days)
      const appCounts: Record<string, number> = {};
      for (const app of applications) {
        const name = app.agentName;
        if (!name) continue;
        if (app.createdAt && new Date(app.createdAt) < cutoffDate) continue;
        appCounts[name] = (appCounts[name] || 0) + 1;
      }

      // Approvals: sum advanceAmount per assignedRep where status = "approved" (last 30 days by approvalDate or createdAt)
      const approvalAmounts: Record<string, number> = {};
      const approvalCounts: Record<string, number> = {};
      for (const d of decisions) {
        if (d.status !== "approved") continue;
        const dateRef = d.approvalDate || d.createdAt;
        if (dateRef && new Date(dateRef) < cutoffDate) continue;
        const amount = d.advanceAmount ? parseFloat(String(d.advanceAmount)) : 0;
        const reps = [d.assignedRep, (d as any).assignedRep2].filter(Boolean) as string[];
        for (const rep of reps) {
          if (!isNaN(amount)) approvalAmounts[rep] = (approvalAmounts[rep] || 0) + amount;
          approvalCounts[rep] = (approvalCounts[rep] || 0) + 1;
        }
      }

      // Funded: sum advanceAmount per assignedRep where status = "funded" (past week by fundedDate or createdAt)
      const fundedAmounts: Record<string, number> = {};
      const fundedCounts: Record<string, number> = {};
      for (const d of decisions) {
        if (d.status !== "funded") continue;
        const dateRef = d.fundedDate || d.createdAt;
        if (dateRef && new Date(dateRef) < cutoffDate) continue;
        const amount = d.advanceAmount ? parseFloat(String(d.advanceAmount)) : 0;
        if (isNaN(amount)) continue;
        const reps = [d.assignedRep, (d as any).assignedRep2].filter(Boolean) as string[];
        for (const rep of reps) {
          fundedAmounts[rep] = (fundedAmounts[rep] || 0) + amount;
          fundedCounts[rep] = (fundedCounts[rep] || 0) + 1;
        }
      }

      // Build sorted arrays
      const applicationLeaderboard = Object.entries(appCounts)
        .map(([name, count]) => ({ name, count, amount: 0 }))
        .sort((a, b) => b.count - a.count);

      const approvalLeaderboard = Object.entries(approvalAmounts)
        .map(([name, amount]) => ({ name, amount, count: approvalCounts[name] || 0 }))
        .sort((a, b) => b.amount - a.amount);

      const fundedLeaderboard = Object.entries(fundedAmounts)
        .map(([name, amount]) => ({ name, amount, count: fundedCounts[name] || 0 }))
        .sort((a, b) => b.amount - a.amount);

      res.json({
        applications: applicationLeaderboard,
        approvals: approvalLeaderboard,
        funded: fundedLeaderboard,
      });
    } catch (error) {
      console.error("Error fetching leaderboard:", error);
      res.status(500).json({ error: "Failed to fetch leaderboard data" });
    }
  });

  // ========================================
  // MESSAGING CENTER ROUTES
  // ========================================

  // Get all merchants aggregated from applications, statements, approvals, funded deals
  app.get("/api/messaging/merchants", async (req, res) => {
    if (!req.session.user?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }
    if (req.session.user.role !== 'admin' && req.session.user.role !== 'underwriting') {
      return res.status(403).json({ error: "Admin or underwriting access required" });
    }

    try {
      // Gather contacts from all sources
      const [applications, decisions, bankUploads] = await Promise.all([
        storage.getAllLoanApplications(),
        storage.getAllBusinessUnderwritingDecisions(),
        storage.getAllBankStatementUploads(),
      ]);

      // Use email as unique key, merge data from all sources
      const merchantMap = new Map<string, {
        email: string;
        businessName: string;
        phone: string;
        sources: string[];
        status: string | null;
        assignedRep: string | null;
      }>();

      // Applications
      for (const app of applications) {
        if (!app.email) continue;
        const key = app.email.toLowerCase();
        const existing = merchantMap.get(key);
        if (existing) {
          if (!existing.sources.includes('application')) existing.sources.push('application');
          if (!existing.businessName && app.businessName) existing.businessName = app.businessName;
          if (!existing.phone && app.phone) existing.phone = app.phone;
        } else {
          merchantMap.set(key, {
            email: app.email,
            businessName: app.businessName || app.legalBusinessName || '',
            phone: app.phone || '',
            sources: ['application'],
            status: null,
            assignedRep: app.agentName || null,
          });
        }
      }

      // Bank statement uploads
      for (const upload of bankUploads) {
        if (!upload.email) continue;
        const key = upload.email.toLowerCase();
        const existing = merchantMap.get(key);
        if (existing) {
          if (!existing.sources.includes('statements')) existing.sources.push('statements');
          if (!existing.businessName && upload.businessName) existing.businessName = upload.businessName;
        } else {
          merchantMap.set(key, {
            email: upload.email,
            businessName: upload.businessName || '',
            phone: '',
            sources: ['statements'],
            status: null,
            assignedRep: null,
          });
        }
      }

      // Underwriting decisions (approvals, funded, declines)
      for (const dec of decisions) {
        if (!dec.businessEmail) continue;
        const key = dec.businessEmail.toLowerCase();
        const existing = merchantMap.get(key);
        const sourceLabel = dec.status === 'funded' ? 'funded' : dec.status === 'approved' ? 'approved' : dec.status || 'decision';
        if (existing) {
          if (!existing.sources.includes(sourceLabel)) existing.sources.push(sourceLabel);
          if (!existing.businessName && dec.businessName) existing.businessName = dec.businessName;
          if (!existing.phone && dec.businessPhone) existing.phone = dec.businessPhone;
          // Prefer decision status/rep over application data
          if (dec.status) existing.status = dec.status;
          if (dec.assignedRep) existing.assignedRep = dec.assignedRep;
        } else {
          merchantMap.set(key, {
            email: dec.businessEmail,
            businessName: dec.businessName || '',
            phone: dec.businessPhone || '',
            sources: [sourceLabel],
            status: dec.status || null,
            assignedRep: dec.assignedRep || null,
          });
        }
      }

      const merchants = Array.from(merchantMap.values()).sort((a, b) =>
        (a.businessName || a.email).localeCompare(b.businessName || b.email)
      );

      res.json(merchants);
    } catch (error) {
      console.error("[MESSAGING] Error fetching merchants:", error);
      res.status(500).json({ error: "Failed to fetch merchants" });
    }
  });

  // Send messages to merchants via email and/or SMS
  app.post("/api/messaging/send", async (req, res) => {
    if (!req.session.user?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }
    if (req.session.user.role !== 'admin' && req.session.user.role !== 'underwriting') {
      return res.status(403).json({ error: "Admin or underwriting access required" });
    }

    try {
      const { recipients, subject, message, channel } = req.body as {
        recipients: { email: string; phone?: string; businessName?: string }[];
        subject: string;
        message: string;
        channel: 'email' | 'sms' | 'both';
      };

      if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
        return res.status(400).json({ error: "At least one recipient is required" });
      }
      if (!message || typeof message !== 'string' || message.trim().length === 0) {
        return res.status(400).json({ error: "Message is required" });
      }
      if (message.length > 5000) {
        return res.status(400).json({ error: "Message must be under 5000 characters" });
      }

      const results: { email: string; emailSent?: boolean; smsSent?: boolean; error?: string }[] = [];

      // Set up Gmail client once if needed for emails
      let gmail: any = null;
      if (channel === 'email' || channel === 'both') {
        try {
          const { google } = await import('googleapis');
          const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
          const xReplitToken = process.env.REPL_IDENTITY
            ? 'repl ' + process.env.REPL_IDENTITY
            : process.env.WEB_REPL_RENEWAL
            ? 'depl ' + process.env.WEB_REPL_RENEWAL
            : null;

          if (xReplitToken && hostname) {
            const connRes = await fetch(
              'https://' + hostname + '/api/v2/connection?include_secrets=true&connector_names=google-mail',
              { headers: { 'Accept': 'application/json', 'X_REPLIT_TOKEN': xReplitToken } }
            ).then(r => r.json());
            const accessToken = connRes.items?.[0]?.settings?.access_token || connRes.items?.[0]?.settings?.oauth?.credentials?.access_token;
            if (accessToken) {
              const oauth2Client = new google.auth.OAuth2();
              oauth2Client.setCredentials({ access_token: accessToken });
              gmail = google.gmail({ version: 'v1', auth: oauth2Client });
            }
          }
        } catch (gmailErr) {
          console.error('[MESSAGING] Gmail setup failed:', gmailErr);
        }
      }

      const senderName = req.session.user.agentEmail || 'Today Capital Group';

      for (const recipient of recipients) {
        const result: typeof results[0] = { email: recipient.email };

        // Send email
        if ((channel === 'email' || channel === 'both') && gmail) {
          try {
            const emailSubject = subject || 'Message from Today Capital Group';
            const htmlBody = `
              <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2 style="color: #14B8A6;">Today Capital Group</h2>
                <p>Hello${recipient.businessName ? ` ${recipient.businessName}` : ''},</p>
                <div style="white-space: pre-wrap; line-height: 1.6;">${message.trim().replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</div>
                <hr style="margin: 24px 0; border: none; border-top: 1px solid #eee;" />
                <p style="color: #999; font-size: 12px;">Today Capital Group</p>
              </div>
            `;
            const raw = Buffer.from(
              `To: ${recipient.email}\r\n` +
              `Subject: ${emailSubject}\r\n` +
              `Content-Type: text/html; charset=utf-8\r\n` +
              `\r\n` +
              htmlBody
            ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

            await gmail.users.messages.send({
              userId: 'me',
              requestBody: { raw },
            });
            result.emailSent = true;
          } catch (emailErr) {
            console.error(`[MESSAGING] Email to ${recipient.email} failed:`, emailErr);
            result.emailSent = false;
            result.error = 'Email send failed';
          }
        }

        // Send SMS
        if ((channel === 'sms' || channel === 'both') && recipient.phone) {
          try {
            const { sendSms } = await import('./services/twilio');
            const smsResult = await sendSms(recipient.phone, message.trim());
            result.smsSent = smsResult.success;
            if (!smsResult.success && !result.error) {
              result.error = smsResult.error || 'SMS send failed';
            }
          } catch (smsErr) {
            console.error(`[MESSAGING] SMS to ${recipient.phone} failed:`, smsErr);
            result.smsSent = false;
          }
        } else if ((channel === 'sms' || channel === 'both') && !recipient.phone) {
          result.smsSent = false;
          result.error = (result.error ? result.error + '; ' : '') + 'No phone number';
        }

        results.push(result);
      }

      const emailsSent = results.filter(r => r.emailSent).length;
      const smsSent = results.filter(r => r.smsSent).length;
      const failures = results.filter(r => r.error).length;

      console.log(`[MESSAGING] Sent by ${senderName}: ${emailsSent} emails, ${smsSent} SMS, ${failures} failures`);

      res.json({
        sent: results.length,
        emailsSent,
        smsSent,
        failures,
        results,
      });
    } catch (error) {
      console.error("[MESSAGING] Error sending messages:", error);
      res.status(500).json({ error: "Failed to send messages" });
    }
  });

  // ========================================
  // SYSTEM SETTINGS (admin-only)
  // ========================================

  // GET all settings (for the settings UI)
  app.get("/api/settings", async (req, res) => {
    if (!req.session.user?.isAuthenticated || req.session.user.role !== 'admin') {
      return res.status(403).json({ error: "Admin access required" });
    }
    try {
      const settings = await storage.getAllSettings();
      // Return as a key-value map for easy consumption
      const map: Record<string, string> = {};
      for (const s of settings) {
        map[s.key] = s.value;
      }
      res.json(map);
    } catch (error) {
      console.error("[SETTINGS] Error fetching settings:", error);
      res.status(500).json({ error: "Failed to fetch settings" });
    }
  });

  // PUT a single setting
  app.put("/api/settings/:key", async (req, res) => {
    if (!req.session.user?.isAuthenticated || req.session.user.role !== 'admin') {
      return res.status(403).json({ error: "Admin access required" });
    }
    try {
      const { key } = req.params;
      const { value } = req.body;
      if (value === undefined || value === null) {
        return res.status(400).json({ error: "value is required" });
      }
      await storage.setSetting(key, String(value), req.session.user.agentEmail || 'admin');
      console.log(`[SETTINGS] ${key} set to "${value}" by ${req.session.user.agentEmail || 'admin'}`);
      res.json({ success: true, key, value: String(value) });
    } catch (error) {
      console.error("[SETTINGS] Error saving setting:", error);
      res.status(500).json({ error: "Failed to save setting" });
    }
  });

  // ========================================
  // MERCHANT PORTAL ROUTES
  // ========================================

  // Helper: send merchant portal invite email via Gmail API
  async function sendMerchantInviteEmail(toEmail: string, businessName: string, token: string): Promise<boolean> {
    try {
      const { google } = await import('googleapis');
      // Reuse Gmail connector auth
      const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
      const xReplitToken = process.env.REPL_IDENTITY
        ? 'repl ' + process.env.REPL_IDENTITY
        : process.env.WEB_REPL_RENEWAL
        ? 'depl ' + process.env.WEB_REPL_RENEWAL
        : null;

      if (!xReplitToken || !hostname) {
        console.log('[MERCHANT] Gmail connector not available, skipping email send');
        return false;
      }

      const connRes = await fetch(
        'https://' + hostname + '/api/v2/connection?include_secrets=true&connector_names=google-mail',
        { headers: { 'Accept': 'application/json', 'X_REPLIT_TOKEN': xReplitToken } }
      ).then(r => r.json());

      const accessToken = connRes.items?.[0]?.settings?.access_token || connRes.items?.[0]?.settings?.oauth?.credentials?.access_token;
      if (!accessToken) {
        console.log('[MERCHANT] No Gmail access token available');
        return false;
      }

      const oauth2Client = new google.auth.OAuth2();
      oauth2Client.setCredentials({ access_token: accessToken });
      const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

      const baseUrl = process.env.PUBLIC_BASE_URL
        ? process.env.PUBLIC_BASE_URL.replace(/\/$/, '')
        : process.env.NODE_ENV === 'production'
        ? 'https://app.todaycapitalgroup.com'
        : process.env.REPLIT_DEV_DOMAIN
        ? `https://${process.env.REPLIT_DEV_DOMAIN}`
        : 'http://localhost:5000';

      const activateUrl = `${baseUrl}/merchant/activate?token=${token}`;

      const subject = 'Your Today Capital Group portal is ready';
      const htmlBody = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #14B8A6;">Today Capital Group</h2>
          <p>Hello${businessName ? ` ${businessName}` : ''},</p>
          <p>Your <strong>Today Capital Group Merchant Portal</strong> is ready. Use it to track your application status, upload documents, view funding details, and communicate with your rep — all in one place.</p>
          <p style="margin: 24px 0;">
            <a href="${activateUrl}" style="display: inline-block; padding: 14px 28px; background: #14B8A6; color: #fff; text-decoration: none; border-radius: 8px; font-weight: bold;">
              Set Up Your Portal Access
            </a>
          </p>
          <p style="color: #666; font-size: 13px;">If the button doesn't work, copy and paste this link into your browser:</p>
          <p style="color: #666; font-size: 13px; word-break: break-all;">${activateUrl}</p>
          <hr style="margin: 24px 0; border: none; border-top: 1px solid #eee;" />
          <p style="color: #999; font-size: 12px;">Today Capital Group · Merchant Portal</p>
        </div>
      `;

      const raw = Buffer.from(
        `To: ${toEmail}\r\n` +
        `Subject: ${subject}\r\n` +
        `Content-Type: text/html; charset=utf-8\r\n` +
        `\r\n` +
        htmlBody
      ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

      await gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw },
      });

      console.log(`[MERCHANT] Invite email sent to ${toEmail}`);
      return true;
    } catch (error) {
      console.error('[MERCHANT] Failed to send invite email:', error);
      return false;
    }
  }

  // Helper: auto-create portal account and optionally send portal link
  async function autoCreatePortalAccount(opts: {
    email: string;
    name?: string;
    phone?: string;
    businessName?: string;
    applicationId?: string; // loan application UUID
    triggerKey: string; // which setting key to check
    sendLink: boolean; // whether to actually send the email
  }): Promise<void> {
    try {
      const normalizedEmail = opts.email.toLowerCase();

      // Check if this trigger is enabled
      const { isTriggerEnabled } = await import('./messaging-triggers');
      const enabled = await isTriggerEnabled(opts.triggerKey);

      // Always create the portal account (even if trigger is off, for manual sending later)
      const token = randomBytes(32).toString('hex');
      await storage.createMerchantPortalAccount({
        email: normalizedEmail,
        portalToken: token,
        name: opts.name || null,
        phone: opts.phone || null,
        businessName: opts.businessName || null,
        applicationId: opts.applicationId || null,
        portalLinkSentAt: enabled && opts.sendLink ? new Date() : null,
      });

      if (enabled && opts.sendLink) {
        await sendMerchantInviteEmail(normalizedEmail, opts.name || opts.businessName || '', token);
        console.log(`[MERCHANT] Auto-sent portal link to ${normalizedEmail} (trigger: ${opts.triggerKey})`);
      } else {
        console.log(`[MERCHANT] Portal account created for ${normalizedEmail} (link not sent, trigger ${opts.triggerKey} ${enabled ? 'enabled but sendLink=false' : 'disabled'})`);
      }
    } catch (error) {
      console.error('[MERCHANT] Auto-create portal account error:', error);
    }
  }

  // Helper: send merchant password reset email via Gmail API
  async function sendMerchantResetEmail(toEmail: string, businessName: string, token: string): Promise<boolean> {
    try {
      const { google } = await import('googleapis');
      const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
      const xReplitToken = process.env.REPL_IDENTITY
        ? 'repl ' + process.env.REPL_IDENTITY
        : process.env.WEB_REPL_RENEWAL
        ? 'depl ' + process.env.WEB_REPL_RENEWAL
        : null;

      if (!xReplitToken || !hostname) {
        console.log('[MERCHANT] Gmail connector not available, skipping reset email');
        return false;
      }

      const connRes = await fetch(
        'https://' + hostname + '/api/v2/connection?include_secrets=true&connector_names=google-mail',
        { headers: { 'Accept': 'application/json', 'X_REPLIT_TOKEN': xReplitToken } }
      ).then(r => r.json());

      const accessToken = connRes.items?.[0]?.settings?.access_token || connRes.items?.[0]?.settings?.oauth?.credentials?.access_token;
      if (!accessToken) {
        console.log('[MERCHANT] No Gmail access token available for reset email');
        return false;
      }

      const oauth2Client = new google.auth.OAuth2();
      oauth2Client.setCredentials({ access_token: accessToken });
      const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

      const baseUrl = process.env.PUBLIC_BASE_URL
        ? process.env.PUBLIC_BASE_URL.replace(/\/$/, '')
        : process.env.NODE_ENV === 'production'
        ? 'https://app.todaycapitalgroup.com'
        : process.env.REPLIT_DEV_DOMAIN
        ? `https://${process.env.REPLIT_DEV_DOMAIN}`
        : 'http://localhost:5000';

      const resetUrl = `${baseUrl}/merchant/reset-password?token=${token}`;

      const subject = 'Reset your Today Capital Group portal password';
      const htmlBody = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #14B8A6;">Today Capital Group</h2>
          <p>Hello${businessName ? ` ${businessName}` : ''},</p>
          <p>We received a request to reset your Merchant Portal password. Click the button below to set a new password:</p>
          <p style="margin: 24px 0;">
            <a href="${resetUrl}" style="display: inline-block; padding: 14px 28px; background: #14B8A6; color: #fff; text-decoration: none; border-radius: 8px; font-weight: bold;">
              Reset My Password
            </a>
          </p>
          <p style="color: #666; font-size: 13px;">If the button doesn't work, copy and paste this link into your browser:</p>
          <p style="color: #666; font-size: 13px; word-break: break-all;">${resetUrl}</p>
          <p style="color: #666; font-size: 13px; margin-top: 16px;">If you didn't request this, you can safely ignore this email. Your password will not be changed.</p>
          <hr style="margin: 24px 0; border: none; border-top: 1px solid #eee;" />
          <p style="color: #999; font-size: 12px;">Today Capital Group · Merchant Portal</p>
        </div>
      `;

      const raw = Buffer.from(
        `To: ${toEmail}\r\n` +
        `Subject: ${subject}\r\n` +
        `Content-Type: text/html; charset=utf-8\r\n` +
        `\r\n` +
        htmlBody
      ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

      await gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw },
      });

      console.log(`[MERCHANT] Reset email sent to ${toEmail}`);
      return true;
    } catch (error) {
      console.error('[MERCHANT] Failed to send reset email:', error);
      return false;
    }
  }

  // Helper: send notification email to assigned rep when merchant sends a portal message
  async function sendRepMessageNotificationEmail(repEmail: string, merchantName: string, messagePreview: string): Promise<boolean> {
    try {
      const { google } = await import('googleapis');
      const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
      const xReplitToken = process.env.REPL_IDENTITY
        ? 'repl ' + process.env.REPL_IDENTITY
        : process.env.WEB_REPL_RENEWAL
        ? 'depl ' + process.env.WEB_REPL_RENEWAL
        : null;

      if (!xReplitToken || !hostname) {
        console.log('[MERCHANT] Gmail connector not available, skipping rep notification');
        return false;
      }

      const connRes = await fetch(
        'https://' + hostname + '/api/v2/connection?include_secrets=true&connector_names=google-mail',
        { headers: { 'Accept': 'application/json', 'X_REPLIT_TOKEN': xReplitToken } }
      ).then(r => r.json());

      const accessToken = connRes.items?.[0]?.settings?.access_token || connRes.items?.[0]?.settings?.oauth?.credentials?.access_token;
      if (!accessToken) {
        console.log('[MERCHANT] No Gmail access token for rep notification');
        return false;
      }

      const oauth2Client = new google.auth.OAuth2();
      oauth2Client.setCredentials({ access_token: accessToken });
      const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

      const baseUrl = process.env.PUBLIC_BASE_URL
        ? process.env.PUBLIC_BASE_URL.replace(/\/$/, '')
        : process.env.NODE_ENV === 'production'
        ? 'https://app.todaycapitalgroup.com'
        : process.env.REPLIT_DEV_DOMAIN
        ? `https://${process.env.REPLIT_DEV_DOMAIN}`
        : 'http://localhost:5000';

      const truncatedMsg = messagePreview.length > 200 ? messagePreview.slice(0, 200) + '...' : messagePreview;

      const subject = `New portal message from ${merchantName}`;
      const htmlBody = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #14B8A6;">Today Capital Group</h2>
          <p>You have a new message from <strong>${merchantName}</strong> on the Merchant Portal:</p>
          <div style="background: #f4f4f5; border-radius: 8px; padding: 16px; margin: 16px 0; font-style: italic; color: #333;">
            "${truncatedMsg}"
          </div>
          <p style="margin: 24px 0;">
            <a href="${baseUrl}/dashboard" style="display: inline-block; padding: 14px 28px; background: #14B8A6; color: #fff; text-decoration: none; border-radius: 8px; font-weight: bold;">
              View in Dashboard
            </a>
          </p>
          <hr style="margin: 24px 0; border: none; border-top: 1px solid #eee;" />
          <p style="color: #999; font-size: 12px;">Today Capital Group · Merchant Portal Notification</p>
        </div>
      `;

      const raw = Buffer.from(
        `To: ${repEmail}\r\n` +
        `Subject: ${subject}\r\n` +
        `Content-Type: text/html; charset=utf-8\r\n` +
        `\r\n` +
        htmlBody
      ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

      await gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw },
      });

      console.log(`[MERCHANT] Rep notification email sent to ${repEmail} for message from ${merchantName}`);
      return true;
    } catch (error) {
      console.error('[MERCHANT] Failed to send rep notification email:', error);
      return false;
    }
  }

  // Rate limiter for merchant login — max 5 attempts per email per 15 minutes.
  // DB-backed (merchant_login_attempts / merchant_otp_codes) so limits and codes
  // survive server restarts and work across instances.
  const MERCHANT_LOGIN_MAX_ATTEMPTS = 5;
  const MERCHANT_LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
  const isMerchantLoginBlocked = async (email: string): Promise<boolean> => {
    try {
      const r = await db.execute(sql`SELECT attempts, window_start FROM merchant_login_attempts WHERE email = ${email}`);
      const row = r.rows[0] as any;
      if (!row) return false;
      if (Date.now() - new Date(row.window_start).getTime() > MERCHANT_LOGIN_WINDOW_MS) {
        await db.execute(sql`DELETE FROM merchant_login_attempts WHERE email = ${email}`);
        return false;
      }
      return Number(row.attempts) >= MERCHANT_LOGIN_MAX_ATTEMPTS;
    } catch { return false; }
  };
  const bumpMerchantLoginAttempts = (email: string) => {
    db.execute(sql`INSERT INTO merchant_login_attempts (email, attempts, window_start) VALUES (${email}, 1, NOW())
      ON CONFLICT (email) DO UPDATE SET attempts = merchant_login_attempts.attempts + 1`).catch(() => {});
  };
  const clearMerchantLoginAttempts = (email: string) => {
    db.execute(sql`DELETE FROM merchant_login_attempts WHERE email = ${email}`).catch(() => {});
  };
  const merchantAlertDedupe = new Map<string, number>();
  const shouldSendMerchantAlert = (key: string, cooldownMs = 60 * 60 * 1000) => {
    const now = Date.now();
    const prev = merchantAlertDedupe.get(key) || 0;
    if (now - prev < cooldownMs) return false;
    merchantAlertDedupe.set(key, now);
    return true;
  };
  const sendAdminMerchantAlert = async (params: {
    title: string;
    event: string;
    merchantEmail?: string | null;
    merchantName?: string | null;
    businessName?: string | null;
    details?: Record<string, string | number | null | undefined>;
  }) => {
    const msg = buildAdminAlertEmail(params);
    await sendMarketingNotification(msg.subject, msg.html, process.env.ADMIN_ALERT_EMAIL || "marketing@todaycapitalgroup.com");
  };

  // Merchant SMS Login: request one-time code by phone number
  app.post("/api/merchant/login/request-otp", async (req, res) => {
    try {
      const rawPhone = String(req.body?.phone || "");
      const normalized = rawPhone.replace(/\D/g, "");
      if (normalized.length !== 10) {
        return res.status(400).json({ error: "Please enter a valid 10-digit phone number." });
      }

      // Match by phone in applications table (source of truth for merchant contact phone).
      const appByPhone = await storage.getLoanApplicationByEmailOrPhone(normalized);
      if (!appByPhone?.email) {
        // Deliberately generic response for privacy
        return res.json({ success: true, masked: "***-***-" + normalized.slice(-4) });
      }

      const code = String(Math.floor(100000 + Math.random() * 900000));
      await db.execute(sql`
        INSERT INTO merchant_otp_codes (phone, code, email, attempts, expires_at, created_at)
        VALUES (${normalized}, ${code}, ${appByPhone.email.toLowerCase()}, 0, NOW() + INTERVAL '10 minutes', NOW())
        ON CONFLICT (phone) DO UPDATE SET
          code = EXCLUDED.code, email = EXCLUDED.email, attempts = 0,
          expires_at = EXCLUDED.expires_at, created_at = NOW()
      `);

      const { sendSms } = await import('./services/twilio');
      const smsResult = await sendSms(normalized, `Your Today Capital Group merchant portal code is: ${code}\n\nExpires in 10 minutes. Do not share this code.`);
      if (!smsResult.success) {
        return res.status(500).json({ error: smsResult.error || "Unable to send code right now." });
      }

      res.json({ success: true, masked: "***-***-" + normalized.slice(-4) });
    } catch (error) {
      console.error("[MERCHANT] request-otp error:", error);
      res.status(500).json({ error: "Failed to send verification code." });
    }
  });

  // Merchant SMS Login: verify one-time code
  app.post("/api/merchant/login/verify-otp", async (req, res) => {
    try {
      const rawPhone = String(req.body?.phone || "");
      const code = String(req.body?.code || "").trim();
      const normalized = rawPhone.replace(/\D/g, "");
      const otpRes = await db.execute(sql`SELECT code, email, attempts, expires_at FROM merchant_otp_codes WHERE phone = ${normalized}`);
      const entry = otpRes.rows[0] as any;
      if (!entry || new Date(entry.expires_at).getTime() < Date.now()) {
        await db.execute(sql`DELETE FROM merchant_otp_codes WHERE phone = ${normalized}`);
        return res.status(400).json({ error: "Invalid or expired code." });
      }
      if (Number(entry.attempts) >= 5) {
        await db.execute(sql`DELETE FROM merchant_otp_codes WHERE phone = ${normalized}`);
        return res.status(400).json({ error: "Too many incorrect attempts. Please request a new code." });
      }
      if (entry.code !== code) {
        await db.execute(sql`UPDATE merchant_otp_codes SET attempts = attempts + 1 WHERE phone = ${normalized}`);
        return res.status(400).json({ error: "Invalid or expired code." });
      }
      await db.execute(sql`DELETE FROM merchant_otp_codes WHERE phone = ${normalized}`); // one-time use

      const portalAccount = await storage.getMerchantPortalAccountByEmail(entry.email);
      const decision = await storage.getBusinessUnderwritingDecisionByMerchantEmail(entry.email);
      const merchantName = portalAccount?.name || portalAccount?.businessName || decision?.businessName;

      req.session.user = {
        isAuthenticated: true,
        role: 'merchant',
        merchantEmail: entry.email,
        merchantName: merchantName || undefined,
      };
      recordMerchantLogin(entry.email, "sms_otp");
      sendAdminMerchantAlert({
        title: "Merchant Portal Login",
        event: "merchant_login_sms_otp",
        merchantEmail: entry.email,
        merchantName: merchantName || undefined,
        businessName: portalAccount?.businessName || decision?.businessName || undefined,
        details: { method: "sms_otp" },
      }).catch(() => {});

      res.json({ success: true });
    } catch (error) {
      console.error("[MERCHANT] verify-otp error:", error);
      res.status(500).json({ error: "Verification failed." });
    }
  });

  // Merchant Login
  app.post("/api/merchant/login", async (req, res) => {
    try {
      const { email, password } = req.body;
      if (!email || !password) {
        return res.status(400).json({ error: "Email and password are required" });
      }

      // Rate limiting check (DB-backed)
      const normalizedEmail = email.toLowerCase();
      if (await isMerchantLoginBlocked(normalizedEmail)) {
        return res.status(429).json({ error: "Too many login attempts. Please try again in 15 minutes." });
      }

      // Check merchantPortalAccounts first (new system), then fall back to businessUnderwritingDecisions (legacy)
      const portalAccount = await storage.getMerchantPortalAccountByEmail(normalizedEmail);
      const decision = await storage.getBusinessUnderwritingDecisionByMerchantEmail(normalizedEmail);

      const passwordHash = portalAccount?.passwordHash || decision?.merchantPasswordHash;
      if (!passwordHash) {
        bumpMerchantLoginAttempts(normalizedEmail);
        return res.status(401).json({ error: "Invalid email or password" });
      }

      const isValid = verifyPassword(password, passwordHash);
      if (!isValid) {
        bumpMerchantLoginAttempts(normalizedEmail);
        return res.status(401).json({ error: "Invalid email or password" });
      }

      // Clear rate limit on successful login
      clearMerchantLoginAttempts(normalizedEmail);
      recordMerchantLogin(normalizedEmail, "password");

      const merchantName = portalAccount?.name || portalAccount?.businessName || decision?.businessName;
      req.session.user = {
        isAuthenticated: true,
        role: 'merchant',
        merchantEmail: normalizedEmail,
        merchantName: merchantName || undefined,
      };
      sendAdminMerchantAlert({
        title: "Merchant Portal Login",
        event: "merchant_login_password",
        merchantEmail: normalizedEmail,
        merchantName: merchantName || undefined,
        businessName: portalAccount?.businessName || decision?.businessName || undefined,
        details: { method: "password" },
      }).catch(() => {});

      res.json({ success: true });
    } catch (error) {
      console.error("[MERCHANT] Login error:", error);
      res.status(500).json({ error: "Login failed" });
    }
  });

  // Merchant Activate (magic link handler) - checks both new portal accounts and legacy decisions
  app.post("/api/merchant/activate", async (req, res) => {
    try {
      const { token, password } = req.body;
      if (!token || !password) {
        return res.status(400).json({ error: "Token and password are required" });
      }

      if (password.length < 6) {
        return res.status(400).json({ error: "Password must be at least 6 characters" });
      }

      const hashedPw = hashPassword(password);

      // Check new merchantPortalAccounts first
      const portalAccount = await storage.getMerchantPortalAccountByToken(token);
      if (portalAccount) {
        await storage.updateMerchantPortalAccount(portalAccount.id, {
          passwordHash: hashedPw,
          portalToken: null,
        });

        req.session.user = {
          isAuthenticated: true,
          role: 'merchant',
          merchantEmail: portalAccount.email,
          merchantName: portalAccount.name || portalAccount.businessName || undefined,
        };
        recordMerchantLogin(portalAccount.email, "activate");

        return res.json({ success: true });
      }

      // Fall back to legacy businessUnderwritingDecisions
      const decision = await storage.getBusinessUnderwritingDecisionByMerchantToken(token);
      if (!decision) {
        return res.status(400).json({ error: "Invalid or expired activation token" });
      }

      await storage.updateBusinessUnderwritingDecision(decision.id, {
        merchantPasswordHash: hashedPw,
        merchantPortalToken: null,
      });

      req.session.user = {
        isAuthenticated: true,
        role: 'merchant',
        merchantEmail: decision.merchantEmail || decision.businessEmail,
        merchantName: decision.businessName || undefined,
      };

      res.json({ success: true });
    } catch (error) {
      console.error("[MERCHANT] Activation error:", error);
      res.status(500).json({ error: "Activation failed" });
    }
  });

  // Merchant Auth Check
  app.get("/api/merchant/auth/check", (req, res) => {
    if (req.session.user?.isAuthenticated && req.session.user.role === 'merchant') {
      const merchantEmail = req.session.user.merchantEmail;
      if (merchantEmail && shouldSendMerchantAlert(`portal_access:${merchantEmail}`, 30 * 60 * 1000)) {
        sendAdminMerchantAlert({
          title: "Merchant Accessed Portal",
          event: "merchant_portal_access",
          merchantEmail,
          merchantName: req.session.user.merchantName || undefined,
          details: { source: "auth_check" },
        }).catch(() => {});
      }
      return res.json({
        isAuthenticated: true,
        email: req.session.user.merchantEmail,
        name: req.session.user.merchantName,
      });
    }
    res.json({ isAuthenticated: false });
  });

  // Merchant Logout
  app.post("/api/merchant/auth/logout", (req, res) => {
    req.session.destroy((err) => {
      if (err) {
        return res.status(500).json({ error: "Logout failed" });
      }
      res.json({ success: true });
    });
  });

  // Merchant Deals - returns funded deals for authenticated merchant
  app.get("/api/merchant/deals", async (req, res) => {
    if (!req.session.user?.isAuthenticated || req.session.user.role !== 'merchant' || !req.session.user.merchantEmail) {
      return res.status(401).json({ error: "Merchant authentication required" });
    }

    try {
      logPortalEvent('merchant', req.session.user.merchantEmail, 'portal_view');
      const decisions = await storage.getBusinessUnderwritingDecisionsByMerchantEmail(req.session.user.merchantEmail);
      const deals: any[] = [];

      for (const decision of decisions) {
        if (decision.status !== 'funded') continue;

        // Shared renewal/offer fields from the decision
        const sharedFields = {
          maxUpsell: decision.maxUpsell ? parseFloat(decision.maxUpsell) : null,
          approvalDeadline: decision.approvalDeadline ? new Date(decision.approvalDeadline).toISOString() : null,
          additionalApprovals: Array.isArray(decision.additionalApprovals) ? decision.additionalApprovals : [],
          decisionId: decision.id,
        };

        // Line-of-credit fields propagated to all deals from this decision
        const locFields = {
          isLineOfCredit: (decision as any).isLineOfCredit || false,
          creditLineTotal: (decision as any).creditLineTotal ? parseFloat(String((decision as any).creditLineTotal)) : null,
        };

        // Build deals from additionalFundings JSONB array
        const fundings = Array.isArray(decision.additionalFundings) ? decision.additionalFundings as any[] : [];

        for (let fi = 0; fi < fundings.length; fi++) {
          const funding = fundings[fi];
          // Skip fundings hidden from merchant portal
          if (funding.hiddenFromPortal) continue;
          // Fundings are stored newest-first (index 0 = most recent draw).
          // Only tag the most-recent (first) funding as LOC — older fundings pre-date the credit line.
          const thisLocFields = fi === 0 ? locFields : { isLineOfCredit: false, creditLineTotal: null };
          deals.push({
            id: funding.id || decision.id,
            businessName: decision.businessName || 'N/A',
            lender: funding.lender || decision.lender || 'N/A',
            advanceAmount: parseFloat(funding.advanceAmount || decision.advanceAmount || '0'),
            factorRate: parseFloat(funding.factorRate || decision.factorRate || '1'),
            totalPayback: parseFloat(funding.totalPayback || decision.totalPayback || '0'),
            paymentFrequency: funding.paymentFrequency || decision.paymentFrequency || 'daily',
            fundedDate: funding.fundedDate || (decision.fundedDate ? new Date(decision.fundedDate).toISOString() : new Date().toISOString()),
            term: funding.term || decision.term || '6 months',
            status: 'active',
            assignedRep: funding.assignedRep || decision.assignedRep || null,
            ...sharedFields,
            ...thisLocFields,
          });
        }

        // If no additionalFundings, use top-level fields
        if (fundings.length === 0) {
          deals.push({
            id: decision.id,
            businessName: decision.businessName || 'N/A',
            lender: decision.lender || 'N/A',
            advanceAmount: parseFloat(decision.advanceAmount || '0'),
            factorRate: parseFloat(decision.factorRate || '1'),
            totalPayback: parseFloat(decision.totalPayback || '0'),
            paymentFrequency: decision.paymentFrequency || 'daily',
            fundedDate: decision.fundedDate ? new Date(decision.fundedDate).toISOString() : new Date().toISOString(),
            term: decision.term || '6 months',
            status: 'active',
            assignedRep: decision.assignedRep || null,
            ...sharedFields,
            ...locFields,
          });
        }
      }

      // Alert admins when merchant reaches ~30% paid into a position (first time/day per deal).
      for (const d of deals) {
        const funded = new Date(d.fundedDate);
        if (!funded || Number.isNaN(funded.getTime())) continue;
        const totalPayback = (Number(d.totalPayback) > 0)
          ? Number(d.totalPayback)
          : (Number(d.advanceAmount) > 0 && Number(d.factorRate) > 1 ? Number(d.advanceAmount) * Number(d.factorRate) : 0);
        if (totalPayback <= 0) continue;
        const termMatch = String(d.term || "").match(/(\d+(?:\.\d+)?)/);
        const termCount = termMatch ? Number(termMatch[1]) : 0;
        if (!termCount) continue;
        const freq = String(d.paymentFrequency || "daily").toLowerCase();
        let totalPayments = termCount;
        if (freq.includes("daily")) totalPayments = termCount;
        else if (freq.includes("bi")) totalPayments = termCount / 2;
        else if (freq.includes("week")) totalPayments = termCount;
        else if (freq.includes("month")) totalPayments = termCount;
        const paymentAmount = totalPayback / Math.max(1, totalPayments);
        const elapsedDays = Math.max(0, Math.floor((Date.now() - funded.getTime()) / (1000 * 60 * 60 * 24)));
        let paymentsMade = elapsedDays;
        if (freq.includes("week")) paymentsMade = Math.floor(elapsedDays / 7);
        if (freq.includes("bi")) paymentsMade = Math.floor(elapsedDays / 14);
        if (freq.includes("month")) paymentsMade = Math.floor(elapsedDays / 30);
        const pctPaid = Math.min(100, (paymentsMade * paymentAmount / totalPayback) * 100);
        if (pctPaid >= 30 && shouldSendMerchantAlert(`deal_30pct:${req.session.user.merchantEmail}:${d.id}`, 24 * 60 * 60 * 1000)) {
          sendAdminMerchantAlert({
            title: "Merchant Reached 30% Paid Milestone",
            event: "position_30_percent_paid",
            merchantEmail: req.session.user.merchantEmail,
            businessName: d.businessName,
            details: { dealId: d.id, lender: d.lender, percentPaid: `${pctPaid.toFixed(1)}%` },
          }).catch(() => {});
        }
      }

      // Attach the merchant's latest self-reported balance per deal so the
      // client can anchor payoff math to reality instead of the time estimate
      try {
        const reports = await db.execute(sql`
          SELECT DISTINCT ON (deal_id) deal_id, reported_balance, reported_at
          FROM merchant_balance_reports
          WHERE LOWER(merchant_email) = ${req.session.user.merchantEmail.toLowerCase()}
          ORDER BY deal_id, reported_at DESC
        `);
        const byDeal = new Map((reports.rows as any[]).map(r => [String(r.deal_id), r]));
        for (const d of deals) {
          const rep = byDeal.get(String(d.id));
          d.reportedBalance = rep ? Number(rep.reported_balance) : null;
          d.reportedAt = rep ? rep.reported_at : null;
        }
      } catch (repErr) {
        console.error("[MERCHANT] balance reports lookup failed:", repErr);
      }

      res.json(deals);
    } catch (error) {
      console.error("[MERCHANT] Error fetching deals:", error);
      res.status(500).json({ error: "Failed to fetch deals" });
    }
  });

  // Merchant reports their actual remaining balance for a deal (balance correction)
  app.post("/api/merchant/deals/balance-report", async (req, res) => {
    if (!req.session.user?.isAuthenticated || req.session.user.role !== 'merchant' || !req.session.user.merchantEmail) {
      return res.status(401).json({ error: "Merchant authentication required" });
    }
    try {
      const email = req.session.user.merchantEmail.toLowerCase();
      const dealId = String(req.body?.dealId || "").trim();
      const raw = String(req.body?.reportedBalance ?? "").replace(/[^0-9.]/g, "");
      const reportedBalance = parseFloat(raw);
      if (!dealId) return res.status(400).json({ error: "dealId is required" });
      if (!Number.isFinite(reportedBalance) || reportedBalance < 0 || reportedBalance > 10_000_000) {
        return res.status(400).json({ error: "Please enter a valid balance amount" });
      }

      await db.execute(sql`INSERT INTO merchant_balance_reports (merchant_email, deal_id, reported_balance)
        VALUES (${email}, ${dealId}, ${reportedBalance})`);
      logPortalEvent('merchant', email, 'balance_reported', `${dealId}: $${reportedBalance}`);
      if (shouldSendMerchantAlert(`balance_report:${email}`, 60 * 60 * 1000)) {
        sendAdminMerchantAlert({
          title: "Merchant Updated Remaining Balance",
          event: "merchant_balance_report",
          merchantEmail: email,
          details: { dealId, reportedBalance: `$${reportedBalance.toLocaleString()}` },
        }).catch(() => {});
      }

      res.json({ success: true, reportedBalance });
    } catch (error) {
      console.error("[MERCHANT] balance-report error:", error);
      res.status(500).json({ error: "Failed to save balance" });
    }
  });

  // Merchant requests a renewal / additional-funding review — alerts the team
  app.post("/api/merchant/renewal-request", async (req, res) => {
    if (!req.session.user?.isAuthenticated || req.session.user.role !== 'merchant' || !req.session.user.merchantEmail) {
      return res.status(401).json({ error: "Merchant authentication required" });
    }
    const email = req.session.user.merchantEmail;
    try {
      logPortalEvent('merchant', email, 'renewal_request');
      const decisions = await storage.getBusinessUnderwritingDecisionsByMerchantEmail(email);
      const latest = decisions[0];
      const note = typeof req.body?.note === "string" ? req.body.note.slice(0, 500) : "";
      // Cooldown prevents duplicate alert emails from repeat clicks
      if (shouldSendMerchantAlert(`renewal_request:${email}`, 60 * 60 * 1000)) {
        sendAdminMerchantAlert({
          title: "Merchant Requested a Renewal Review",
          event: "renewal_requested",
          merchantEmail: email,
          businessName: latest?.businessName || null,
          details: {
            "Assigned Rep": latest?.assignedRep || "Unassigned",
            "Lender": latest?.lender || null,
            "Merchant Note": note || null,
            "Next Step": "Reach out within 1 business day",
          },
        }).catch(() => {});
        console.log(`[MERCHANT] Renewal review requested by ${email}`);
      }
      res.json({ success: true });
    } catch (error) {
      console.error("[MERCHANT] renewal-request error:", error);
      res.status(500).json({ error: "Failed to submit renewal request" });
    }
  });

  // Merchant payoff letter (PDF) — estimated payoff statement for a funded position
  app.get("/api/merchant/payoff-letter", async (req, res) => {
    if (!req.session.user?.isAuthenticated || req.session.user.role !== 'merchant' || !req.session.user.merchantEmail) {
      return res.status(401).json({ error: "Merchant authentication required" });
    }
    try {
      const dealId = String(req.query.dealId || "");
      const decisions = await storage.getBusinessUnderwritingDecisionsByMerchantEmail(req.session.user.merchantEmail);

      // Rebuild the merchant's deals (same shape as /api/merchant/deals)
      let deal: any = null;
      for (const decision of decisions) {
        if (decision.status !== 'funded') continue;
        const fundings = Array.isArray(decision.additionalFundings) ? decision.additionalFundings as any[] : [];
        const candidates = fundings.length > 0
          ? fundings.map((f) => ({
              id: f.id || decision.id,
              businessName: decision.businessName || 'N/A',
              lender: f.lender || decision.lender || 'N/A',
              advanceAmount: parseFloat(f.advanceAmount || decision.advanceAmount || '0'),
              factorRate: parseFloat(f.factorRate || decision.factorRate || '1'),
              totalPayback: parseFloat(f.totalPayback || decision.totalPayback || '0'),
              paymentFrequency: f.paymentFrequency || decision.paymentFrequency || 'daily',
              fundedDate: f.fundedDate || (decision.fundedDate ? new Date(decision.fundedDate).toISOString() : new Date().toISOString()),
              term: f.term || decision.term || '6 months',
              assignedRep: f.assignedRep || decision.assignedRep || null,
            }))
          : [{
              id: decision.id,
              businessName: decision.businessName || 'N/A',
              lender: decision.lender || 'N/A',
              advanceAmount: parseFloat(decision.advanceAmount || '0'),
              factorRate: parseFloat(decision.factorRate || '1'),
              totalPayback: parseFloat(decision.totalPayback || '0'),
              paymentFrequency: decision.paymentFrequency || 'daily',
              fundedDate: decision.fundedDate ? new Date(decision.fundedDate).toISOString() : new Date().toISOString(),
              term: decision.term || '6 months',
              assignedRep: decision.assignedRep || null,
            }];
        deal = candidates.find((c) => String(c.id) === dealId) || deal;
      }
      if (!deal) return res.status(404).json({ error: "Position not found" });

      // ── Server-side payoff math (mirrors calcDeal in MerchantPortal.tsx) ──
      const today = new Date();
      const funded = new Date(deal.fundedDate);
      const derivedPayback = deal.advanceAmount * deal.factorRate;
      const totalPayback = deal.advanceAmount > 0 && deal.factorRate > 1
        ? derivedPayback : (deal.totalPayback || derivedPayback || 0);
      const freq = String(deal.paymentFrequency || "daily").toLowerCase();
      const isDaily = freq === "daily";
      const isBiWeekly = freq.includes("bi");
      const isWeekly = !isBiWeekly && freq.includes("week");
      const isMonthly = freq.includes("month");

      const termStr = String(deal.term || "").toLowerCase();
      const termMatch = termStr.match(/(\d+(?:\.\d+)?)/);
      const termVal = termMatch ? parseFloat(termMatch[1]) : 6;
      const termUnit: 'days' | 'weeks' | 'months' =
        /day/.test(termStr) ? 'days' : /week|wk/.test(termStr) ? 'weeks' : /month|mo\b/.test(termStr) ? 'months'
        : isDaily ? 'days' : (isWeekly || isBiWeekly) ? 'weeks' : 'months';

      let totalPayments: number;
      if (isDaily) totalPayments = termUnit === 'days' ? Math.round(termVal) : termUnit === 'weeks' ? Math.round(termVal * 5) : Math.round(termVal * 21);
      else if (isWeekly) totalPayments = termUnit === 'weeks' ? Math.round(termVal) : termUnit === 'months' ? Math.round(termVal * 4.33) : Math.round(termVal / 7);
      else if (isBiWeekly) totalPayments = termUnit === 'weeks' ? Math.round(termVal / 2) : termUnit === 'months' ? Math.round(termVal * 2) : Math.round(termVal / 14);
      else totalPayments = termUnit === 'months' ? Math.round(termVal) : termUnit === 'weeks' ? Math.round(termVal / 4.33) : Math.round(termVal / 30);
      totalPayments = Math.max(1, totalPayments);
      const paymentAmount = totalPayback / totalPayments;

      let paymentsMade: number;
      if (isDaily) {
        // Business days between funded and today
        let count = 0;
        const d = new Date(funded);
        while (d < today) {
          d.setDate(d.getDate() + 1);
          if (d.getDay() !== 0 && d.getDay() !== 6) count++;
        }
        paymentsMade = count;
      } else if (isMonthly) {
        paymentsMade = Math.max(0, (today.getFullYear() - funded.getFullYear()) * 12 + (today.getMonth() - funded.getMonth()));
      } else {
        const msPerPeriod = (isBiWeekly ? 14 : 7) * 24 * 60 * 60 * 1000;
        paymentsMade = Math.max(0, Math.floor((today.getTime() - funded.getTime()) / msPerPeriod));
      }
      paymentsMade = Math.min(paymentsMade, totalPayments);
      const amountPaid = Math.min(paymentsMade * paymentAmount, totalPayback);
      const remaining = Math.max(totalPayback - amountPaid, 0);
      const paymentsRemaining = totalPayments - paymentsMade;

      let projectedPayoff = new Date(today);
      if (isDaily) {
        let added = 0;
        while (added < paymentsRemaining) {
          projectedPayoff.setDate(projectedPayoff.getDate() + 1);
          if (projectedPayoff.getDay() !== 0 && projectedPayoff.getDay() !== 6) added++;
        }
      } else if (isMonthly) {
        projectedPayoff.setMonth(projectedPayoff.getMonth() + paymentsRemaining);
      } else {
        projectedPayoff = new Date(today.getTime() + paymentsRemaining * (isBiWeekly ? 14 : 7) * 24 * 60 * 60 * 1000);
      }

      const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      const dateFmt = (d: Date) => d.toLocaleDateString("en-US", { month: 'long', day: 'numeric', year: 'numeric' });

      // ── Build PDF ──
      const pdfBuffer: Buffer = await new Promise((resolve, reject) => {
        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        const chunks: Buffer[] = [];
        doc.on('data', (chunk: Buffer) => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        const darkNavy = '#1B2E4D';
        const teal = '#5FBFB8';
        const labelColor = '#6B7280';

        doc.rect(0, 0, 595, 80).fill('#E8EEF3');
        doc.fillColor(teal).fontSize(20).font('Helvetica-Bold').text('TODAY', 50, 25);
        doc.fillColor(darkNavy).fontSize(20).font('Helvetica-Bold').text('CAPITAL GROUP', 130, 25);
        doc.fillColor(labelColor).fontSize(10).font('Helvetica').text(`Date: ${dateFmt(today)}`, 400, 30);
        doc.fillColor(darkNavy).fontSize(10).font('Helvetica').text('Estimated Payoff Statement', 400, 45);

        let y = 110;
        doc.fillColor(darkNavy).fontSize(16).font('Helvetica-Bold').text('Estimated Payoff Statement', 50, y);
        y += 30;
        doc.fillColor('#111827').fontSize(11).font('Helvetica')
          .text(`RE: ${deal.businessName} — funded position with ${deal.lender}`, 50, y);
        y += 30;

        const addLine = (label: string, value: string, bold = false) => {
          doc.fillColor(labelColor).fontSize(10).font('Helvetica').text(label, 50, y, { width: 220 });
          doc.fillColor(bold ? darkNavy : '#111827').fontSize(bold ? 12 : 10).font(bold ? 'Helvetica-Bold' : 'Helvetica').text(value, 280, y - (bold ? 1 : 0));
          y += bold ? 26 : 22;
        };

        addLine('Funded Date', dateFmt(funded));
        addLine('Advance Amount', money(deal.advanceAmount));
        addLine('Factor Rate', `${deal.factorRate}x`);
        addLine('Total Payback', money(totalPayback));
        addLine('Payment Frequency', deal.paymentFrequency);
        addLine('Per-Payment Amount', money(paymentAmount));
        addLine('Estimated Payments Made', `${paymentsMade} of ${totalPayments}`);
        addLine('Estimated Amount Paid', money(amountPaid));
        y += 6;
        doc.strokeColor(teal).lineWidth(1).moveTo(50, y).lineTo(545, y).stroke();
        y += 14;
        addLine('Estimated Remaining Balance', money(remaining), true);
        addLine('Projected Payoff Date', dateFmt(projectedPayoff), true);

        y += 20;
        doc.fillColor(labelColor).fontSize(9).font('Helvetica').text(
          'This statement reflects estimated figures based on your original payment schedule and assumes all scheduled ' +
          'payments have been made on time. It is provided for informational purposes only and is not a binding payoff ' +
          'quote. Actual payoff amounts, including any fees, discounts, or adjustments, must be confirmed directly with ' +
          `${deal.lender} or your Today Capital Group representative before remitting payment.`,
          50, y, { width: 495, lineGap: 3 },
        );
        y += 80;
        doc.fillColor(darkNavy).fontSize(10).font('Helvetica-Bold').text('Today Capital Group', 50, y);
        y += 14;
        doc.fillColor(labelColor).fontSize(9).font('Helvetica')
          .text('6303 Owensmouth Ave, Woodland Hills, CA 91367  ·  (818) 351-0225  ·  info@todaycapitalgroup.com', 50, y);

        doc.end();
      });

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="payoff-statement-${dealId}.pdf"`);
      res.send(pdfBuffer);
    } catch (error) {
      console.error("[MERCHANT] payoff-letter error:", error);
      res.status(500).json({ error: "Failed to generate payoff letter" });
    }
  });

  // Merchant Bank Statements - returns uploaded statements for authenticated merchant
  app.get("/api/merchant/statements", async (req, res) => {
    if (!req.session.user?.isAuthenticated || req.session.user.role !== 'merchant' || !req.session.user.merchantEmail) {
      return res.status(401).json({ error: "Merchant authentication required" });
    }
    try {
      const uploads = await storage.getBankStatementUploadsByEmail(req.session.user.merchantEmail);
      const statements = uploads.map(u => ({
        id: u.id,
        originalFileName: u.originalFileName,
        fileSize: u.fileSize,
        viewToken: u.viewToken,
        receivedAt: u.receivedAt,
        createdAt: u.createdAt,
      }));
      res.json(statements);
    } catch (error) {
      console.error("[MERCHANT] Error fetching statements:", error);
      res.status(500).json({ error: "Failed to fetch statements" });
    }
  });

  // Merchant Activity Feed - aggregates milestones, messages, and offers
  app.get("/api/merchant/activity", async (req, res) => {
    const email = await getMerchantEmailFromRequest(req);
    if (!email) return res.status(401).json({ error: "Merchant authentication required" });
    try {
      const activities: any[] = [];

      // Get decisions for milestone events
      const decisions = await storage.getBusinessUnderwritingDecisionsByMerchantEmail(email);
      for (const d of decisions) {
        if (d.status === 'funded' && d.fundedDate) {
          activities.push({
            id: `funded-${d.id}`,
            type: 'milestone',
            icon: 'dollar',
            title: 'Deal Funded',
            description: `${d.lender || 'Your lender'} funded ${d.advanceAmount ? '$' + parseFloat(d.advanceAmount).toLocaleString() : 'your advance'}`,
            timestamp: new Date(d.fundedDate).toISOString(),
          });
        }
        if (d.status === 'funded' && d.approvalDeadline) {
          activities.push({
            id: `offer-${d.id}`,
            type: 'offer',
            icon: 'star',
            title: 'Renewal Offer Available',
            description: d.maxUpsell ? `Pre-qualified for up to $${parseFloat(d.maxUpsell).toLocaleString()}` : 'You may qualify for additional funding',
            timestamp: new Date((d.updatedAt || d.createdAt || d.fundedDate) as any).toISOString(),
          });
        }
        // Payment milestone estimates from additionalFundings
        const fundings = Array.isArray(d.additionalFundings) ? d.additionalFundings as any[] : [];
        for (const f of fundings) {
          if (f.fundedDate) {
            activities.push({
              id: `funded-${f.id || d.id}-${f.lender}`,
              type: 'milestone',
              icon: 'dollar',
              title: `Position Funded — ${f.lender}`,
              description: `${f.lender} funded $${parseFloat(f.advanceAmount || '0').toLocaleString()}`,
              timestamp: new Date(f.fundedDate).toISOString(),
            });
          }
        }
      }

      // Get recent messages
      const messages = await storage.getMerchantMessagesByEmail(email);
      for (const m of messages.slice(-20)) {
        activities.push({
          id: `msg-${m.id}`,
          type: 'message',
          icon: 'message',
          title: m.senderRole === 'merchant' ? 'You sent a message' : `Message from ${m.senderName || 'your rep'}`,
          description: m.message.length > 80 ? m.message.substring(0, 80) + '...' : m.message,
          timestamp: new Date(m.createdAt ?? Date.now()).toISOString(),
        });
      }

      // Sort by timestamp descending
      activities.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      res.json(activities.slice(0, 50));
    } catch (error) {
      console.error("[MERCHANT] Error fetching activity:", error);
      res.status(500).json({ error: "Failed to fetch activity" });
    }
  });

  // Merchant Password Reset - Request
  app.post("/api/merchant/reset-password/request", async (req, res) => {
    try {
      const { email } = req.body;
      if (!email) {
        return res.status(400).json({ error: "Email is required" });
      }

      const normalizedEmail = email.toLowerCase();
      const token = randomBytes(32).toString('hex');

      // Check the new merchantPortalAccounts table first, then legacy decision columns.
      // Always return success to prevent email enumeration.
      const portalAccount = await storage.getMerchantPortalAccountByEmail(normalizedEmail);
      if (portalAccount?.passwordHash) {
        await storage.updateMerchantPortalAccount(portalAccount.id, { portalToken: token });
        await sendMerchantResetEmail(normalizedEmail, portalAccount.businessName || portalAccount.name || '', token);
        return res.json({ success: true, message: "If an account exists with that email, a reset link has been sent." });
      }

      const decision = await storage.getBusinessUnderwritingDecisionByMerchantEmail(normalizedEmail);
      if (!decision || !decision.merchantPasswordHash) {
        return res.json({ success: true, message: "If an account exists with that email, a reset link has been sent." });
      }

      await storage.updateBusinessUnderwritingDecision(decision.id, {
        merchantPortalToken: token,
      });

      // Send reset email
      await sendMerchantResetEmail(decision.merchantEmail || email, decision.businessName || '', token);

      res.json({ success: true, message: "If an account exists with that email, a reset link has been sent." });
    } catch (error) {
      console.error("[MERCHANT] Password reset request error:", error);
      res.status(500).json({ error: "Password reset request failed" });
    }
  });

  // Merchant Password Reset - Execute
  app.post("/api/merchant/reset-password", async (req, res) => {
    try {
      const { token, password } = req.body;
      if (!token || !password) {
        return res.status(400).json({ error: "Token and password are required" });
      }

      if (password.length < 6) {
        return res.status(400).json({ error: "Password must be at least 6 characters" });
      }

      const passwordHash = hashPassword(password);

      // Check new merchantPortalAccounts first, then legacy decision columns
      const portalAccount = await storage.getMerchantPortalAccountByToken(token);
      if (portalAccount) {
        await storage.updateMerchantPortalAccount(portalAccount.id, {
          passwordHash,
          portalToken: null,
        });
        req.session.user = {
          isAuthenticated: true,
          role: 'merchant',
          merchantEmail: portalAccount.email,
          merchantName: portalAccount.name || portalAccount.businessName || undefined,
        };
        recordMerchantLogin(portalAccount.email, "password_reset");
        return res.json({ success: true });
      }

      const decision = await storage.getBusinessUnderwritingDecisionByMerchantToken(token);
      if (!decision) {
        return res.status(400).json({ error: "Invalid or expired reset link" });
      }

      await storage.updateBusinessUnderwritingDecision(decision.id, {
        merchantPasswordHash: passwordHash,
        merchantPortalToken: null,
      });

      req.session.user = {
        isAuthenticated: true,
        role: 'merchant',
        merchantEmail: decision.merchantEmail || decision.businessEmail,
        merchantName: decision.businessName || undefined,
      };
      recordMerchantLogin((decision.merchantEmail || decision.businessEmail || '').toLowerCase(), "password_reset");

      res.json({ success: true });
    } catch (error) {
      console.error("[MERCHANT] Password reset error:", error);
      res.status(500).json({ error: "Password reset failed" });
    }
  });

  // Create portal account WITHOUT sending the invite email (staff sets up the portal first)
  app.post("/api/merchant/create-portal", async (req, res) => {
    if (!req.session.user?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }
    if (req.session.user.role !== 'underwriting' && req.session.user.role !== 'admin') {
      return res.status(403).json({ error: "Only staff can create portals" });
    }

    try {
      const { decisionId } = req.body;
      if (!decisionId) {
        return res.status(400).json({ error: "decisionId is required" });
      }

      const decision = await storage.getBusinessUnderwritingDecision(decisionId);
      if (!decision) {
        return res.status(404).json({ error: "Decision not found" });
      }
      if (!decision.businessEmail) {
        return res.status(400).json({ error: "No business email on record" });
      }

      const token = randomBytes(32).toString('hex');
      await storage.updateBusinessUnderwritingDecision(decision.id, {
        merchantEmail: decision.businessEmail.toLowerCase(),
        merchantPortalToken: token,
      });
      // Mirror into merchantPortalAccounts (new system) so both auth paths agree
      await storage.createMerchantPortalAccount({
        email: decision.businessEmail.toLowerCase(),
        businessName: decision.businessName || null,
        portalToken: token,
      } as any).catch((err: any) => console.error('[MERCHANT] create-portal account mirror failed:', err?.message || err));

      console.log(`[MERCHANT] Portal created (no email sent) for ${decision.businessEmail} by ${req.session.user.agentEmail || 'admin'}`);
      res.json({ success: true, message: `Portal created for ${decision.businessEmail}. No invite sent yet.` });
    } catch (error) {
      console.error("[MERCHANT] Create portal error:", error);
      res.status(500).json({ error: "Failed to create portal" });
    }
  });

  // Admin: Generate a short-lived preview token to access a merchant's portal without affecting admin session
  app.post("/api/merchant/admin-access", async (req, res) => {
    if (!req.session.user?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }
    if (req.session.user.role !== 'underwriting' && req.session.user.role !== 'admin') {
      return res.status(403).json({ error: "Only staff can preview portals" });
    }
    try {
      const { decisionId } = req.body;
      if (!decisionId) return res.status(400).json({ error: "decisionId is required" });

      const decision = await storage.getBusinessUnderwritingDecision(decisionId);
      if (!decision) return res.status(404).json({ error: "Decision not found" });
      if (!decision.merchantEmail && !decision.businessEmail) {
        return res.status(400).json({ error: "No merchant email found — set up the portal first." });
      }

      const email = (decision.merchantEmail || decision.businessEmail || '').toLowerCase();
      const name = decision.businessName || decision.businessEmail || 'Merchant';
      const token = randomBytes(32).toString('hex');

      adminPreviewTokens.set(token, {
        email,
        name,
        businessName: decision.businessName || '',
        expiresAt: Date.now() + 30 * 60 * 1000, // 30-minute TTL
      });
      // Persist so the token survives a server restart mid-preview
      await db.execute(sql`INSERT INTO portal_preview_tokens (token, email, created_by, expires_at)
        VALUES (${token}, ${email}, ${req.session.user.agentEmail || 'admin'}, NOW() + INTERVAL '30 minutes')`).catch(() => {});

      const replitDomain = process.env.REPLIT_DOMAINS?.split(',')[0]?.trim();
      const baseUrl = replitDomain
        ? `https://${replitDomain}`
        : `${(req.headers['x-forwarded-proto'] as string || 'http').split(',')[0].trim()}://${req.headers['host'] || 'localhost:5000'}`;

      console.log(`[MERCHANT] Admin preview token generated for ${email} by ${req.session.user.agentEmail || 'admin'}`);
      res.json({ previewUrl: `${baseUrl}/merchant?adminPreview=${token}` });
    } catch (error) {
      console.error("[MERCHANT] Admin access error:", error);
      res.status(500).json({ error: "Failed to generate preview token" });
    }
  });

  // Admin preview: Return all merchant portal data using a preview token (no session required)
  app.get("/api/merchant/admin-preview-data", async (req, res) => {
    const token = req.query.token as string;
    if (!token) return res.status(400).json({ error: "token is required" });

    let preview = adminPreviewTokens.get(token);
    if (!preview || preview.expiresAt <= Date.now()) {
      // Cache miss (e.g. restart since token was issued) — check the DB
      try {
        const r = await db.execute(sql`SELECT email, expires_at FROM portal_preview_tokens WHERE token = ${token} AND expires_at > NOW()`);
        const row = r.rows[0] as any;
        if (row?.email) {
          preview = { email: row.email, name: "", businessName: "", expiresAt: new Date(row.expires_at).getTime() };
          adminPreviewTokens.set(token, preview);
        }
      } catch {}
    }
    if (!preview || preview.expiresAt <= Date.now()) {
      return res.status(401).json({ error: "Invalid or expired preview token" });
    }

    try {
      const email = preview.email;

      // Fetch all data in parallel
      const [decisions, uploads, congrats, messages] = await Promise.all([
        storage.getBusinessUnderwritingDecisionsByMerchantEmail(email),
        storage.getBankStatementUploadsByEmail(email),
        storage.getCongratulationsUploadsByEmail(email),
        storage.getMerchantMessagesByEmail(email),
      ]);

      // Build deals (same logic as /api/merchant/deals)
      const deals: any[] = [];
      for (const decision of decisions) {
        if (decision.status !== 'funded') continue;
        const sharedFields = {
          maxUpsell: decision.maxUpsell ? parseFloat(decision.maxUpsell) : null,
          approvalDeadline: decision.approvalDeadline ? new Date(decision.approvalDeadline).toISOString() : null,
          additionalApprovals: Array.isArray(decision.additionalApprovals) ? decision.additionalApprovals : [],
          decisionId: decision.id,
        };
        const locFields = {
          isLineOfCredit: (decision as any).isLineOfCredit || false,
          creditLineTotal: (decision as any).creditLineTotal ? parseFloat(String((decision as any).creditLineTotal)) : null,
        };
        const fundings = Array.isArray(decision.additionalFundings) ? decision.additionalFundings as any[] : [];
        if (fundings.length > 0) {
          for (let fi = 0; fi < fundings.length; fi++) {
            const funding = fundings[fi];
            // Skip fundings hidden from merchant portal
            if (funding.hiddenFromPortal) continue;
            // Fundings are stored newest-first (index 0 = most recent draw).
            // Only tag the most-recent (first) funding as LOC — older fundings pre-date the credit line.
            const thisLocFields = fi === 0 ? locFields : { isLineOfCredit: false, creditLineTotal: null };
            deals.push({
              id: funding.id || decision.id,
              businessName: decision.businessName || 'N/A',
              lender: funding.lender || decision.lender || 'N/A',
              advanceAmount: parseFloat(funding.advanceAmount || decision.advanceAmount || '0'),
              factorRate: parseFloat(funding.factorRate || decision.factorRate || '1'),
              totalPayback: parseFloat(funding.totalPayback || decision.totalPayback || '0'),
              paymentFrequency: funding.paymentFrequency || decision.paymentFrequency || 'daily',
              fundedDate: funding.fundedDate || (decision.fundedDate ? new Date(decision.fundedDate).toISOString() : new Date().toISOString()),
              term: funding.term || decision.term || '6 months',
              status: 'active',
              assignedRep: funding.assignedRep || decision.assignedRep || null,
              ...sharedFields,
              ...thisLocFields,
            });
          }
        } else {
          deals.push({
            id: decision.id,
            businessName: decision.businessName || 'N/A',
            lender: decision.lender || 'N/A',
            advanceAmount: parseFloat(decision.advanceAmount || '0'),
            factorRate: parseFloat(decision.factorRate || '1'),
            totalPayback: parseFloat(decision.totalPayback || '0'),
            paymentFrequency: decision.paymentFrequency || 'daily',
            fundedDate: decision.fundedDate ? new Date(decision.fundedDate).toISOString() : new Date().toISOString(),
            term: decision.term || '6 months',
            status: 'active',
            assignedRep: decision.assignedRep || null,
            ...sharedFields,
            ...locFields,
          });
        }
      }

      // Build statements
      const statements = uploads.map(u => ({
        id: u.id,
        originalFileName: u.originalFileName,
        fileSize: u.fileSize,
        viewToken: u.viewToken,
        receivedAt: u.receivedAt,
        createdAt: u.createdAt,
      }));

      // Build documents
      const documents = [
        ...congrats.map(c => ({
          id: c.id,
          type: c.docType,
          name: c.originalFileName,
          fileSize: c.fileSize,
          category: 'closing' as const,
          createdAt: c.createdAt,
          downloadUrl: null,
        })),
        ...uploads.map(s => ({
          id: s.id,
          type: 'bank_statement',
          name: s.originalFileName,
          fileSize: s.fileSize,
          category: 'statements' as const,
          createdAt: s.createdAt,
          downloadUrl: s.viewToken ? `/api/bank-statements/public/view/${s.viewToken}` : null,
        })),
      ];

      res.json({
        merchant: { email, name: preview.name, businessName: preview.businessName },
        deals,
        statements,
        documents,
        messages,
        isAdminPreview: true,
        expiresAt: preview.expiresAt,
      });
    } catch (error) {
      console.error("[MERCHANT] Admin preview data error:", error);
      res.status(500).json({ error: "Failed to load preview data" });
    }
  });

  app.post("/api/merchant/resend-invite", async (req, res) => {
    if (!req.session.user?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }
    if (req.session.user.role !== 'underwriting' && req.session.user.role !== 'admin') {
      return res.status(403).json({ error: "Only staff can resend invites" });
    }

    try {
      const { decisionId } = req.body;
      if (!decisionId) {
        return res.status(400).json({ error: "decisionId is required" });
      }

      const decision = await storage.getBusinessUnderwritingDecision(decisionId);
      if (!decision) {
        return res.status(404).json({ error: "Decision not found" });
      }

      if (!decision.businessEmail) {
        return res.status(400).json({ error: "No business email on record" });
      }

      const token = randomBytes(32).toString('hex');
      await storage.updateBusinessUnderwritingDecision(decision.id, {
        merchantEmail: decision.businessEmail.toLowerCase(),
        merchantPortalToken: token,
      });

      const emailSent = await sendMerchantInviteEmail(
        decision.businessEmail,
        decision.businessName || '',
        token
      );

      res.json({
        success: true,
        emailSent,
        message: emailSent
          ? `Portal invite sent to ${decision.businessEmail}`
          : `Token generated but email could not be sent. Manual activation link needed.`,
      });
    } catch (error) {
      console.error("[MERCHANT] Resend invite error:", error);
      res.status(500).json({ error: "Failed to resend invite" });
    }
  });

  // Send Portal Link - for any application (manual from dashboard)
  app.post("/api/merchant/send-portal-link", async (req, res) => {
    if (!req.session.user?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }
    if (req.session.user.role !== 'admin' && req.session.user.role !== 'underwriting' && req.session.user.role !== 'agent') {
      return res.status(403).json({ error: "Staff access required" });
    }

    try {
      const { applicationId, email } = req.body;
      if (!applicationId && !email) {
        return res.status(400).json({ error: "applicationId or email is required" });
      }

      let targetEmail = email?.toLowerCase();
      let name = '';
      let businessName = '';
      let appId: string | null = null;

      if (applicationId) {
        const app = await storage.getLoanApplication(applicationId);
        if (!app) return res.status(404).json({ error: "Application not found" });
        targetEmail = app.email?.toLowerCase();
        name = app.fullName || '';
        businessName = app.businessName || app.legalBusinessName || '';
        appId = app.id;
      }

      if (!targetEmail) {
        return res.status(400).json({ error: "No email found for this application" });
      }

      const token = randomBytes(32).toString('hex');

      // Create or update portal account
      await storage.createMerchantPortalAccount({
        email: targetEmail,
        portalToken: token,
        name: name || null,
        businessName: businessName || null,
        applicationId: appId,
        portalLinkSentAt: new Date(),
      });

      const emailSent = await sendMerchantInviteEmail(targetEmail, name || businessName, token);

      res.json({
        success: true,
        emailSent,
        message: emailSent
          ? `Portal link sent to ${targetEmail}`
          : `Token generated but email could not be sent.`,
      });
    } catch (error) {
      console.error("[MERCHANT] Send portal link error:", error);
      res.status(500).json({ error: "Failed to send portal link" });
    }
  });

  // Merchant Application Status - returns application progress for non-funded merchants
  app.get("/api/merchant/application-status", async (req, res) => {
    if (!req.session.user?.isAuthenticated || req.session.user.role !== 'merchant' || !req.session.user.merchantEmail) {
      return res.status(401).json({ error: "Merchant authentication required" });
    }
    try {
      const email = req.session.user.merchantEmail;
      const app = await storage.getLoanApplicationByEmail(email);
      if (!app) {
        return res.json({ hasApplication: false });
      }

      // Check bank statement uploads
      const uploads = await storage.getBankStatementUploadsByEmail(email);

      res.json({
        hasApplication: true,
        applicationId: app.id,
        businessName: app.businessName || app.legalBusinessName || null,
        isIntakeCompleted: !!app.isCompleted,
        isFullApplicationCompleted: !!app.isFullApplicationCompleted,
        currentStep: app.currentStep || 0,
        bankStatementsUploaded: uploads.length > 0,
        bankStatementCount: uploads.length,
        createdAt: app.createdAt,
        updatedAt: app.updatedAt,
      });
    } catch (error) {
      console.error("[MERCHANT] Application status error:", error);
      res.status(500).json({ error: "Failed to fetch application status" });
    }
  });

  // ── MERCHANT FINANCIALS ──────────────────────────────────────────────
  // (Merchant-portal Plaid Link endpoints removed — Chirp replaced Plaid in the
  // portal UI. Historical Plaid insights still surface via /financial-insights.)

  // Route 3b: Merchant/lead portal statement upload
  app.post("/api/merchant/bank-statements/upload", (req, res, next) => {
    bankStatementUpload.single("file")(req, res, (err: any) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: "File too large (25MB max)" });
        if (err.message === 'Only PDF files are allowed') return res.status(400).json({ error: err.message });
        return res.status(400).json({ error: "Upload error: " + err.message });
      }
      next();
    });
  }, async (req, res) => {
    const merchantEmail = await getMerchantEmailFromRequest(req);
    if (!merchantEmail) return res.status(401).json({ error: "Authentication required" });

    try {
      const file = req.file;
      if (!file) return res.status(400).json({ error: "No file uploaded" });

      let storedFileName: string;
      let storageType = "local";

      if (objectStorage.isConfigured()) {
        storedFileName = await objectStorage.uploadFile(
          file.buffer,
          `bank-statements/${merchantEmail}/${Date.now()}_${file.originalname}`,
          file.mimetype,
        );
        storageType = "object";
      } else {
        storedFileName = `${Date.now()}_${file.originalname}`;
        const localPath = path.join(UPLOAD_DIR, storedFileName);
        fs.writeFileSync(localPath, file.buffer);
      }

      const viewToken = randomUUID();
      await storage.createBankStatementUpload({
        email: merchantEmail,
        originalFileName: file.originalname,
        storedFileName,
        fileSize: file.size,
        mimeType: file.mimetype,
        // storageType has no column on bank_statement_uploads — object-storage files
        // are identified by their "bank-statements/" storedFileName prefix instead
        viewToken,
      });
      if (shouldSendMerchantAlert(`merchant_upload:${merchantEmail}`, 30 * 60 * 1000)) {
        sendAdminMerchantAlert({
          title: "Merchant Uploaded Bank Statement",
          event: "merchant_bank_statement_upload",
          merchantEmail,
          details: { fileName: file.originalname, fileSize: `${Math.round(file.size / 1024)} KB` },
        }).catch(() => {});
      }

      logPortalEvent('merchant', merchantEmail, 'statement_upload', file.originalname);
      console.log(`[MERCHANT UPLOAD] ${merchantEmail} uploaded ${file.originalname} (${(file.size / 1024).toFixed(0)} KB)`);
      res.json({ success: true, fileName: file.originalname, fileSize: file.size });
    } catch (err: any) {
      console.error("[MERCHANT UPLOAD] error:", err);
      res.status(500).json({ error: "Upload failed" });
    }
  });

  // Route 4: Analyze merchant's uploaded PDF bank statements
  app.post("/api/merchant/bank-statements/analyze", async (req, res) => {
    const merchantEmail = await getMerchantEmailFromRequest(req);
    if (!merchantEmail) {
      return res.status(401).json({ error: "Merchant authentication required" });
    }
    try {
      const email = merchantEmail;
      const uploads = await storage.getBankStatementUploadsByEmail(email);

      if (!uploads || uploads.length === 0) {
        return res.status(400).json({ error: "No bank statements found to analyze" });
      }

      const extractedTexts: string[] = [];

      for (const upload of uploads.slice(0, 6)) {
        try {
          let fileBuffer: Buffer;

          if (upload.storedFileName && upload.storedFileName.includes("bank-statements/")) {
            fileBuffer = await objectStorage.getFileBuffer(upload.storedFileName);
          } else {
            const filePath = path.join(UPLOAD_DIR, upload.storedFileName);
            if (fs.existsSync(filePath)) {
              fileBuffer = fs.readFileSync(filePath);
            } else {
              console.warn(`[MERCHANT PDF] File not found: ${upload.storedFileName}`);
              continue;
            }
          }

          const parser = new PDFParse({ data: fileBuffer });
          const result = await parser.getText();
          const text = result.text || "";
          extractedTexts.push(`--- Statement: ${upload.originalFileName} ---\n${text}\n`);
          await parser.destroy();
        } catch (pdfError) {
          console.error(`[MERCHANT PDF] Error parsing ${upload.originalFileName}:`, pdfError);
        }
      }

      if (extractedTexts.length === 0) {
        return res.status(400).json({ error: "Could not extract text from uploaded PDFs" });
      }

      const combinedText = extractedTexts.join("\n\n");
      const analysis = await analyzeBankStatements(combinedText, {});

      // Cache the result (7 day expiry for PDF)
      await storage.createOrUpdateMerchantInsight({
        merchantEmail: email.toLowerCase(),
        sourceType: 'pdf',
        insightsData: analysis as any,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      });

      console.log(`[MERCHANT PDF] Analysis complete for ${email}. Score: ${analysis.overallScore}`);
      res.json({ success: true, analysis });
    } catch (error) {
      console.error("[MERCHANT PDF] Analysis error:", error);
      res.status(500).json({ error: "Failed to analyze statements" });
    }
  });

  // Admin/batch: run the same statement analysis for any email — used to pre-warm
  // /track Financials for provisioned accounts so insights are ready at first login.
  app.post("/api/admin/claude/analyze-statements", claudeAuth, async (req, res) => {
    const email = String(req.body?.email || "").toLowerCase().trim();
    if (!email || !email.includes("@")) return res.status(400).json({ error: "body.email required" });
    try {
      // Skip if a fresh analysis is already cached (unless force)
      if (!req.body?.force) {
        const cached = await storage.getMerchantInsight(email, 'pdf');
        if (cached && (!cached.expiresAt || new Date(cached.expiresAt) > new Date())) {
          return res.json({ success: true, skipped: "fresh analysis already cached" });
        }
      }
      const uploads = await storage.getBankStatementUploadsByEmail(email);
      if (!uploads || uploads.length === 0) return res.status(404).json({ error: "no statements on file" });

      // Most recent statements first
      const sorted = [...uploads].sort((a: any, b: any) =>
        new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
      const extractedTexts: string[] = [];
      for (const upload of sorted.slice(0, 6)) {
        try {
          let fileBuffer: Buffer;
          if (upload.storedFileName && upload.storedFileName.includes("bank-statements/")) {
            fileBuffer = await objectStorage.getFileBuffer(upload.storedFileName);
          } else {
            const filePath = path.join(UPLOAD_DIR, upload.storedFileName);
            if (!fs.existsSync(filePath)) continue;
            fileBuffer = fs.readFileSync(filePath);
          }
          const parser = new PDFParse({ data: fileBuffer });
          const result = await parser.getText();
          extractedTexts.push(`--- Statement: ${upload.originalFileName} ---\n${result.text || ""}\n`);
          await parser.destroy();
        } catch (pdfError) {
          console.error(`[ADMIN PDF] parse error ${upload.originalFileName}:`, pdfError);
        }
      }
      if (extractedTexts.length === 0) return res.status(422).json({ error: "could not extract text from statements" });

      const analysis = await analyzeBankStatements(extractedTexts.join("\n\n"), {});
      await storage.createOrUpdateMerchantInsight({
        merchantEmail: email,
        sourceType: 'pdf',
        insightsData: analysis as any,
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000), // pre-warmed: keep 90 days
      });
      console.log(`[ADMIN PDF] Pre-warmed analysis for ${email}. Score: ${analysis.overallScore}`);
      res.json({ success: true, score: analysis.overallScore, statements: extractedTexts.length });
    } catch (error: any) {
      console.error("[ADMIN PDF] analyze error:", error);
      res.status(500).json({ error: error.message || "analysis failed" });
    }
  });

  // Route 5: Get combined financial insights
  app.get("/api/merchant/financial-insights", async (req, res) => {
    const email = await getMerchantEmailFromRequest(req);
    if (!email) return res.status(401).json({ error: "Merchant authentication required" });
    try {

      // Check cached insights
      const pdfCache = await storage.getMerchantInsight(email, 'pdf');
      const plaidCache = await storage.getMerchantInsight(email, 'plaid');

      // Check if Plaid insights are stale and need refresh
      let plaidData = plaidCache?.insightsData as any;
      const plaidStale = plaidCache && plaidCache.expiresAt && new Date(plaidCache.expiresAt) < new Date();

      if (plaidStale) {
        // Re-fetch from Plaid in background
        const tokens = await storage.getPlaidAccessTokensForMerchant(email);
        if (tokens.length > 0) {
          try {
            const freshAnalysis = await plaidService.analyzeFinancials(tokens[0].accessToken);
            if (freshAnalysis) {
              await storage.createOrUpdateMerchantInsight({
                merchantEmail: email.toLowerCase(),
                sourceType: 'plaid',
                insightsData: freshAnalysis as any,
                expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
              });
              plaidData = freshAnalysis;
            }
          } catch (refreshErr) {
            console.error('[MERCHANT] Plaid refresh failed, using stale cache:', refreshErr);
          }
        }
      }

      const pdfData = pdfCache?.insightsData as any;
      const connections = await storage.getMerchantPlaidConnectionsByEmail(email);
      const statements = await storage.getBankStatementUploadsByEmail(email);

      // Translate PDF insights to merchant-friendly format
      let pdfInsights = null;
      if (pdfData) {
        const score = pdfData.overallScore || 0;
        const cashFlowHealth = score >= 75 ? 'strong' : score >= 50 ? 'moderate' : 'needs-attention';

        pdfInsights = {
          cashFlowHealth,
          overallScore: score,
          scoreExplanation: pdfData.scoreExplanation || "",
          estimatedMonthlyRevenue: pdfData.estimatedMonthlyRevenue || 0,
          estimatedMonthlyExpenses: pdfData.estimatedMonthlyExpenses || 0,
          netCashFlow: pdfData.netCashFlow || 0,
          averageDailyBalance: pdfData.averageDailyBalance || 0,
          currentBalance: pdfData.currentBalance || 0,
          revenueConsistency: pdfData.revenueConsistency || null,
          cashRunwayDays: pdfData.cashRunwayDays || 0,
          monthlyBreakdown: pdfData.monthlyBreakdown || [],
          positiveIndicators: (pdfData.positiveIndicators || [])
            .sort((a: any, b: any) => (a.priority || 99) - (b.priority || 99))
            .map((p: any) => ({
              label: typeof p === 'string' ? p : p.indicator || "",
              details: typeof p === 'string' ? "" : p.details || "",
            })),
          concerns: (pdfData.redFlags || [])
            .sort((a: any, b: any) => (a.priority || 99) - (b.priority || 99))
            .map((f: any) => ({
              label: typeof f === 'string' ? f : f.issue || "",
              details: typeof f === 'string' ? "" : f.details || "",
              severity: typeof f === 'string' ? "medium" : f.severity || "medium",
            })),
          tips: pdfData.improvementSuggestions || [],
          summary: pdfData.summary || '',
          analyzedAt: pdfCache?.generatedAt?.toISOString() || new Date().toISOString(),
        };
      }

      // Translate Plaid insights
      let plaidInsights = null;
      if (plaidData) {
        plaidInsights = {
          accounts: plaidData.accounts || [],
          monthlyRevenue: plaidData.monthlyRevenue || plaidData.estimatedMonthlyRevenue || 0,
          avgBalance: plaidData.averageBalance || plaidData.averageDailyBalance || 0,
          revenueTrend: plaidData.revenueTrend || 'stable',
          lastUpdated: plaidCache?.generatedAt?.toISOString() || new Date().toISOString(),
        };
      }

      // Determine renewal nudge
      const bestScore = pdfData?.overallScore || 0;
      const revenue = pdfData?.estimatedMonthlyRevenue || plaidData?.monthlyRevenue || 0;
      const renewalEligible = bestScore >= 60 && revenue > 10000;
      const renewalReasons: string[] = [];
      if (renewalEligible) {
        renewalReasons.push(`Financial health score of ${bestScore}/100 — above our renewal threshold of 60`);
        renewalReasons.push(`Verified monthly revenue of ~$${Math.round(revenue).toLocaleString("en-US")} — above the $10,000 minimum`);
        if (Number(pdfData?.netCashFlow) > 0) {
          renewalReasons.push(`Positive net cash flow of ~$${Math.round(pdfData.netCashFlow).toLocaleString("en-US")}/mo`);
        }
      }
      const renewalNudge = {
        eligible: renewalEligible,
        message: renewalEligible
          ? "Based on your financial activity, you may qualify for additional funding. Talk to your rep to explore options."
          : "",
        reasons: renewalReasons,
      };

      res.json({
        hasStatements: statements.length > 0,
        hasPlaidConnection: connections.length > 0,
        pdfInsights,
        plaidInsights,
        renewalNudge,
        statements: statements.map(s => ({
          id: s.id,
          fileName: s.originalFileName,
          fileSize: s.fileSize,
          uploadedAt: (s.receivedAt || s.createdAt)?.toISOString() || null,
          viewToken: s.viewToken || null,
        })),
      });
    } catch (error) {
      console.error("[MERCHANT] Financial insights error:", error);
      res.status(500).json({ error: "Failed to fetch financial insights" });
    }
  });

  // ── MERCHANT PORTAL PREMIUM FEATURES ─────────────────────────────────

  // Merchant Documents (Document Vault) - returns congratulations uploads (voided check, driver's license) + bank statements
  app.get("/api/merchant/documents", async (req, res) => {
    if (!req.session.user?.isAuthenticated || req.session.user.role !== 'merchant' || !req.session.user.merchantEmail) {
      return res.status(401).json({ error: "Merchant authentication required" });
    }
    try {
      const email = req.session.user.merchantEmail;
      const [congrats, statements] = await Promise.all([
        storage.getCongratulationsUploadsByEmail(email),
        storage.getBankStatementUploadsByEmail(email),
      ]);
      const documents = [
        ...congrats.map(c => ({
          id: c.id,
          type: c.docType, // 'voided_check' or 'drivers_license'
          name: c.originalFileName,
          fileSize: c.fileSize,
          category: 'closing' as const,
          createdAt: c.createdAt,
          downloadUrl: null, // Object storage - served via separate endpoint
        })),
        ...statements.map(s => ({
          id: s.id,
          type: 'bank_statement',
          name: s.originalFileName,
          fileSize: s.fileSize,
          category: 'statements' as const,
          createdAt: s.createdAt,
          downloadUrl: s.viewToken ? `/api/bank-statements/public/view/${s.viewToken}` : null,
        })),
      ];
      res.json(documents);
    } catch (error) {
      console.error("[MERCHANT] Error fetching documents:", error);
      res.status(500).json({ error: "Failed to fetch documents" });
    }
  });

  // Merchant Messages - List messages for authenticated merchant
  app.get("/api/merchant/messages", async (req, res) => {
    const merchantEmail = await getMerchantEmailFromRequest(req);
    if (!merchantEmail) return res.status(401).json({ error: "Merchant authentication required" });
    try {
      const messages = await storage.getMerchantMessagesByEmail(merchantEmail);
      await storage.markMerchantMessagesRead(merchantEmail, 'merchant');
      res.json(messages);
    } catch (error) {
      console.error("[MERCHANT] Error fetching messages:", error);
      res.status(500).json({ error: "Failed to fetch messages" });
    }
  });

  // Merchant Messages - Send a message from merchant
  app.post("/api/merchant/messages", async (req, res) => {
    if (!req.session.user?.isAuthenticated || req.session.user.role !== 'merchant' || !req.session.user.merchantEmail) {
      return res.status(401).json({ error: "Merchant authentication required" });
    }
    try {
      const { message, dealId } = req.body;
      if (!message || typeof message !== 'string' || message.trim().length === 0) {
        return res.status(400).json({ error: "Message is required" });
      }
      if (message.length > 2000) {
        return res.status(400).json({ error: "Message must be under 2000 characters" });
      }
      const msg = await storage.createMerchantMessage({
        merchantEmail: req.session.user.merchantEmail,
        dealId: dealId || null,
        senderRole: 'merchant',
        senderName: req.session.user.merchantName || req.session.user.merchantEmail,
        message: message.trim(),
        isRead: false,
      });
      logPortalEvent('merchant', req.session.user.merchantEmail, 'message_sent');

      // Notify assigned rep via email (async, non-blocking)
      const decision = await storage.getBusinessUnderwritingDecisionByEmail(req.session.user.merchantEmail);
      if (decision?.assignedRep) {
        const repAgent = AGENTS.find(a => a.name.toLowerCase() === decision.assignedRep!.toLowerCase());
        if (repAgent) {
          const merchantLabel = req.session.user.merchantName || decision.businessName || req.session.user.merchantEmail;
          sendRepMessageNotificationEmail(repAgent.email, merchantLabel, message.trim()).catch(err => {
            console.error('[MERCHANT] Failed to email rep notification:', err);
          });
        }
      }

      res.json(msg);
    } catch (error) {
      console.error("[MERCHANT] Error sending message:", error);
      res.status(500).json({ error: "Failed to send message" });
    }
  });

  // Merchant Messages - Unread count for merchant
  app.get("/api/merchant/messages/unread", async (req, res) => {
    const merchantEmail = await getMerchantEmailFromRequest(req);
    if (!merchantEmail) return res.status(401).json({ error: "Merchant authentication required" });
    try {
      const count = await storage.getUnreadMerchantMessageCount(merchantEmail, 'merchant');
      res.json({ count });
    } catch (error) {
      res.status(500).json({ error: "Failed to get unread count" });
    }
  });

  // Merchant: LOC Draw Request — notifies assigned rep via email
  app.post("/api/merchant/draw-request", async (req, res) => {
    const merchantEmail = await getMerchantEmailFromRequest(req);
    if (!merchantEmail) return res.status(401).json({ error: "Merchant authentication required" });
    try {
      const { amount, method } = req.body as { amount: number; method: "bank" | "statement" };
      if (!amount || amount <= 0) return res.status(400).json({ error: "Invalid draw amount" });

      const decision = await storage.getBusinessUnderwritingDecisionByEmail(merchantEmail);
      const businessName = decision?.businessName || req.session.user?.merchantName || merchantEmail;
      const repName = decision?.assignedRep || null;
      const repAgent = repName ? AGENTS.find(a => a.name.toLowerCase() === repName.toLowerCase()) : null;
      const repEmail = repAgent?.email || 'underwriting@todaycapitalgroup.com';

      const methodLabel = method === "bank" ? "bank account connected via Chirp" : "bank statements uploaded";

      // Build and send email to rep
      try {
        const { google } = await import('googleapis');
        const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
        const xReplitToken = process.env.REPL_IDENTITY
          ? 'repl ' + process.env.REPL_IDENTITY
          : process.env.WEB_REPL_RENEWAL
          ? 'depl ' + process.env.WEB_REPL_RENEWAL
          : null;

        if (xReplitToken && hostname) {
          const connRes = await fetch(
            'https://' + hostname + '/api/v2/connection?include_secrets=true&connector_names=google-mail',
            { headers: { 'Accept': 'application/json', 'X_REPLIT_TOKEN': xReplitToken } }
          ).then(r => r.json());

          const accessToken = connRes.items?.[0]?.settings?.access_token || connRes.items?.[0]?.settings?.oauth?.credentials?.access_token;
          if (accessToken) {
            const oauth2Client = new google.auth.OAuth2();
            oauth2Client.setCredentials({ access_token: accessToken });
            const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

            const baseUrl = process.env.PUBLIC_BASE_URL
              ? process.env.PUBLIC_BASE_URL.replace(/\/$/, '')
              : process.env.NODE_ENV === 'production'
              ? 'https://app.todaycapitalgroup.com'
              : process.env.REPLIT_DEV_DOMAIN
              ? `https://${process.env.REPLIT_DEV_DOMAIN}`
              : 'http://localhost:5000';

            const amountFormatted = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(amount);
            const htmlBody = `
              <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2 style="color: #14B8A6;">Today Capital Group — LOC Draw Request</h2>
                <p><strong>${businessName}</strong> has requested to draw additional funds from their line of credit.</p>
                <table style="width:100%; border-collapse:collapse; margin: 20px 0;">
                  <tr style="background:#f4f4f5;">
                    <td style="padding:10px 14px; font-weight:600;">Business</td>
                    <td style="padding:10px 14px;">${businessName}</td>
                  </tr>
                  <tr>
                    <td style="padding:10px 14px; font-weight:600;">Email</td>
                    <td style="padding:10px 14px;">${merchantEmail}</td>
                  </tr>
                  <tr style="background:#f4f4f5;">
                    <td style="padding:10px 14px; font-weight:600;">Requested Amount</td>
                    <td style="padding:10px 14px; color:#0d9488; font-weight:700; font-size:18px;">${amountFormatted}</td>
                  </tr>
                  <tr>
                    <td style="padding:10px 14px; font-weight:600;">Verification Method</td>
                    <td style="padding:10px 14px;">${methodLabel}</td>
                  </tr>
                </table>
                <p style="margin: 24px 0;">
                  <a href="${baseUrl}/dashboard" style="display:inline-block; padding:14px 28px; background:#14B8A6; color:#fff; text-decoration:none; border-radius:8px; font-weight:bold;">
                    View in Dashboard
                  </a>
                </p>
                <hr style="margin:24px 0; border:none; border-top:1px solid #eee;" />
                <p style="color:#999; font-size:12px;">Today Capital Group · Merchant Portal · LOC Draw Request</p>
              </div>
            `;

            const raw = Buffer.from(
              `To: ${repEmail}\r\nSubject: LOC Draw Request — ${businessName} wants ${amountFormatted}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${htmlBody}`
            ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

            await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
            console.log(`[MERCHANT] LOC draw request email sent to ${repEmail} for ${businessName} — ${amountFormatted}`);
          }
        }
      } catch (emailErr) {
        console.error('[MERCHANT] Failed to send draw request email:', emailErr);
        // Don't fail the request — the draw request is still recorded
      }

      logPortalEvent('merchant', merchantEmail, 'loc_draw_requested');
      res.json({ success: true, repName });
    } catch (error) {
      console.error("[MERCHANT] Error processing draw request:", error);
      res.status(500).json({ error: "Failed to submit draw request" });
    }
  });

  // Staff: Send message to merchant (admin/underwriting only)
  app.post("/api/merchant/messages/staff", async (req, res) => {
    if (!req.session.user?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }
    if (req.session.user.role !== 'admin' && req.session.user.role !== 'underwriting') {
      return res.status(403).json({ error: "Staff access required" });
    }
    try {
      const { merchantEmail, message, dealId, senderName } = req.body;
      if (!merchantEmail || !message) {
        return res.status(400).json({ error: "merchantEmail and message are required" });
      }
      if (message.length > 2000) {
        return res.status(400).json({ error: "Message must be under 2000 characters" });
      }
      const msg = await storage.createMerchantMessage({
        merchantEmail: merchantEmail.toLowerCase(),
        dealId: dealId || null,
        senderRole: 'rep',
        senderName: senderName || 'Today Capital Group',
        message: message.trim(),
        isRead: false,
      });

      // Send SMS notification to merchant (async, non-blocking)
      const decision = await storage.getBusinessUnderwritingDecisionByEmail(merchantEmail.toLowerCase());
      if (decision?.businessPhone) {
        notifyMerchantNewMessage(decision.businessPhone, senderName || 'Today Capital Group').catch(err => {
          console.error('[TWILIO] Failed to notify merchant:', err);
        });
      }

      // Email the merchant so portal replies don't go unseen (async, non-blocking)
      {
        const fromName = senderName || 'Today Capital Group';
        const preview = String(message).trim().slice(0, 300);
        const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
    <table width="580" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e5e7eb;">
      <tr><td style="background:#0f1e38;padding:24px 28px;">
        <p style="margin:0;font-size:20px;font-weight:700;color:#ffffff;">New message from ${fromName}</p>
      </td></tr>
      <tr><td style="padding:28px;">
        <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#374151;">You have a new message waiting in your Today Capital Group merchant portal:</p>
        <div style="background:#f9fafb;border-left:3px solid #0d9488;border-radius:6px;padding:14px 16px;margin:0 0 20px;font-size:14px;line-height:1.6;color:#111827;">${preview.replace(/</g, "&lt;")}</div>
        <table cellpadding="0" cellspacing="0" align="center"><tr><td style="background:#0d9488;border-radius:50px;">
          <a href="https://app.todaycapitalgroup.com/merchant" style="display:inline-block;padding:13px 32px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;">View &amp; Reply in Portal</a>
        </td></tr></table>
      </td></tr>
      <tr><td style="background:#f9fafb;padding:18px 28px;border-top:1px solid #e5e7eb;">
        <p style="margin:0;font-size:12px;color:#9ca3af;">Today Capital Group &middot; 6303 Owensmouth Ave, Woodland Hills, CA 91367 &middot; (818) 351-0225</p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
        gmailService.sendEmail(merchantEmail.toLowerCase(), `New message from ${fromName} — Today Capital Group`, html).catch(err => {
          console.error('[MERCHANT] Failed to email merchant message notification:', err);
        });
      }

      res.json(msg);
    } catch (error) {
      console.error("[MERCHANT] Staff message error:", error);
      res.status(500).json({ error: "Failed to send message" });
    }
  });

  // Staff: Get messages for a merchant (admin/underwriting only)
  app.get("/api/merchant/messages/staff/:email", async (req, res) => {
    if (!req.session.user?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }
    if (req.session.user.role !== 'admin' && req.session.user.role !== 'underwriting') {
      return res.status(403).json({ error: "Staff access required" });
    }
    try {
      const messages = await storage.getMerchantMessagesByEmail(req.params.email);
      await storage.markMerchantMessagesRead(req.params.email, 'rep');
      res.json(messages);
    } catch (error) {
      console.error("[MERCHANT] Staff messages fetch error:", error);
      res.status(500).json({ error: "Failed to fetch messages" });
    }
  });

  // Staff: All merchant message threads, grouped by merchant (admin/underwriting only)
  app.get("/api/admin/merchant-messages/threads", async (req, res) => {
    if (!req.session.user?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }
    if (req.session.user.role !== 'admin' && req.session.user.role !== 'underwriting') {
      return res.status(403).json({ error: "Staff access required" });
    }
    try {
      const result = await db.execute(sql`
        SELECT m.merchant_email AS "merchantEmail",
          MAX(m.created_at) AS "lastAt",
          (SELECT message FROM merchant_messages WHERE merchant_email = m.merchant_email ORDER BY created_at DESC LIMIT 1) AS "lastMessage",
          (SELECT sender_role FROM merchant_messages WHERE merchant_email = m.merchant_email ORDER BY created_at DESC LIMIT 1) AS "lastSenderRole",
          COUNT(*) FILTER (WHERE m.sender_role = 'merchant' AND m.is_read = false)::int AS "unreadCount",
          COUNT(*)::int AS "messageCount",
          (SELECT business_name FROM business_underwriting_decisions WHERE business_email = m.merchant_email LIMIT 1) AS "businessName",
          (SELECT assigned_rep FROM business_underwriting_decisions WHERE business_email = m.merchant_email LIMIT 1) AS "assignedRep"
        FROM merchant_messages m
        GROUP BY m.merchant_email
        ORDER BY MAX(m.created_at) DESC
      `);
      res.json(result.rows);
    } catch (error) {
      console.error("[MERCHANT] Threads fetch error:", error);
      res.status(500).json({ error: "Failed to fetch threads" });
    }
  });

  // Staff: Portal engagement for one merchant — last login + recent events
  app.get("/api/admin/portal-engagement/:email", async (req, res) => {
    if (!req.session.user?.isAuthenticated || req.session.user.role === 'merchant' || req.session.user.role === 'lead') {
      return res.status(401).json({ error: "Staff access required" });
    }
    try {
      const email = req.params.email.toLowerCase();
      const [account, events] = await Promise.all([
        db.execute(sql`SELECT last_login_at, login_count, portal_link_sent_at FROM merchant_portal_accounts WHERE LOWER(email) = ${email} LIMIT 1`),
        db.execute(sql`SELECT portal, event, detail, created_at FROM portal_events WHERE LOWER(email) = ${email} ORDER BY created_at DESC LIMIT 25`),
      ]);
      const acct = account.rows[0] as any;
      res.json({
        lastLoginAt: acct?.last_login_at || null,
        loginCount: Number(acct?.login_count) || 0,
        portalLinkSentAt: acct?.portal_link_sent_at || null,
        hasPortalAccount: !!acct,
        recentEvents: events.rows,
      });
    } catch (error) {
      console.error("[MERCHANT] Engagement fetch error:", error);
      res.status(500).json({ error: "Failed to fetch engagement" });
    }
  });

  // Staff: Total unread merchant messages (for nav badge)
  app.get("/api/admin/merchant-messages/unread-count", async (req, res) => {
    if (!req.session.user?.isAuthenticated || req.session.user.role === 'merchant' || req.session.user.role === 'lead') {
      return res.status(401).json({ error: "Staff access required" });
    }
    try {
      const result = await db.execute(sql`SELECT COUNT(*)::int AS c FROM merchant_messages WHERE sender_role = 'merchant' AND is_read = false`);
      res.json({ count: Number((result.rows[0] as any)?.c) || 0 });
    } catch (error) {
      res.status(500).json({ error: "Failed to get unread count" });
    }
  });

  // ─── SMS/EMAIL ACTIVITY SYNC TO SALESFORCE ──────────────────────────────

  async function findSfContactAndOpp(phone?: string, email?: string): Promise<{ whoId?: string; whatId?: string } | null> {
    if (!process.env.SF_INSTANCE_URL) return null;
    const { getAccessToken: getSfToken } = await import("./services/salesforce");
    const token = await getSfToken();
    if (!token) return null;
    const sfQ = async (soql: string) => {
      try {
        const r = await fetch(`${process.env.SF_INSTANCE_URL}/services/data/v66.0/query?q=${encodeURIComponent(soql)}`, { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
        if (!r.ok) return [];
        return ((await r.json()) as any).records || [];
      } catch { return []; }
    };
    const digits = (phone || "").replace(/\D/g, "").slice(-10);
    let whoId: string | undefined, whatId: string | undefined;
    if (email) {
      const c = await sfQ(`SELECT Id, AccountId FROM Contact WHERE Email = '${email.replace(/'/g, "\\'")}' LIMIT 1`);
      if (c.length) { whoId = c[0].Id; const o = await sfQ(`SELECT Id FROM Opportunity WHERE AccountId = '${c[0].AccountId}' ORDER BY LastModifiedDate DESC LIMIT 1`); if (o.length) whatId = o[0].Id; }
    }
    if (!whoId && digits.length === 10) {
      const c = await sfQ(`SELECT Id, AccountId FROM Contact WHERE Phone LIKE '%${digits}' OR MobilePhone LIKE '%${digits}' LIMIT 1`);
      if (c.length) { whoId = c[0].Id; const o = await sfQ(`SELECT Id FROM Opportunity WHERE AccountId = '${c[0].AccountId}' ORDER BY LastModifiedDate DESC LIMIT 1`); if (o.length) whatId = o[0].Id; }
    }
    if (!whoId && email) { const l = await sfQ(`SELECT Id FROM Lead WHERE Email = '${email.replace(/'/g, "\\'")}' AND IsConverted = false LIMIT 1`); if (l.length) whoId = l[0].Id; }
    if (!whoId && digits.length === 10) { const l = await sfQ(`SELECT Id FROM Lead WHERE Phone LIKE '%${digits}' AND IsConverted = false LIMIT 1`); if (l.length) whoId = l[0].Id; }
    return whoId ? { whoId, whatId } : null;
  }

  async function createSfTask(fields: Record<string, any>): Promise<boolean> {
    try {
      const { getAccessToken: getSfToken } = await import("./services/salesforce");
      const token = await getSfToken();
      if (!token || !process.env.SF_INSTANCE_URL) return false;
      const r = await fetch(`${process.env.SF_INSTANCE_URL}/services/data/v66.0/sobjects/Task`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(fields),
      });
      if (r.ok) { console.log(`[SF Activity] Task created: ${fields.Subject}`); return true; }
      console.warn(`[SF Activity] Task failed: ${JSON.stringify(await r.json()).slice(0, 200)}`);
      return false;
    } catch (e: any) { console.error(`[SF Activity] Error: ${e.message}`); return false; }
  }

  // POST /api/webhooks/twilio-status — delivery status callbacks from Twilio
  app.post("/api/webhooks/twilio-status", express.urlencoded({ extended: false }), async (req: Request, res: Response) => {
    res.sendStatus(204);
    try {
      const { To, MessageStatus, MessageSid, Body } = req.body;
      const status = (MessageStatus || "").toLowerCase();
      if (!["delivered", "undelivered", "failed"].includes(status)) return;
      const digits = (To || "").replace(/\D/g, "").slice(-10);
      const appResult = await db.execute(sql`SELECT email, full_name FROM loan_applications WHERE regexp_replace(phone, '[^0-9]', '', 'g') LIKE ${"%" + digits} ORDER BY created_at DESC LIMIT 1`);
      const app = (appResult as any).rows?.[0];
      const match = await findSfContactAndOpp(To, app?.email);
      if (!match) return;
      await createSfTask({
        WhoId: match.whoId, WhatId: match.whatId || undefined,
        Subject: (status === "delivered" ? `SMS Delivered to ${To}` : `SMS ${status} to ${To}`).slice(0, 255),
        Description: Body ? `Message: ${Body}\n\nStatus: ${MessageStatus}\nSID: ${MessageSid}` : `Status: ${MessageStatus}`,
        Status: "Completed", Priority: "Normal", ActivityDate: new Date().toISOString().split("T")[0], Type: "SMS",
      });
    } catch (e: any) { console.error("[Twilio Status] Error:", e.message); }
  });

  // POST /api/webhooks/twilio-inbound — inbound SMS replies
  app.post("/api/webhooks/twilio-inbound", express.urlencoded({ extended: false }), async (req: Request, res: Response) => {
    res.type("text/xml").send("<Response></Response>");
    try {
      const { From, Body } = req.body;
      const digits = (From || "").replace(/\D/g, "").slice(-10);
      const appResult = await db.execute(sql`SELECT email, full_name FROM loan_applications WHERE regexp_replace(phone, '[^0-9]', '', 'g') LIKE ${"%" + digits} ORDER BY created_at DESC LIMIT 1`);
      const app = (appResult as any).rows?.[0];
      const match = await findSfContactAndOpp(From, app?.email);
      if (!match) return;
      await createSfTask({
        WhoId: match.whoId, WhatId: match.whatId || undefined,
        Subject: `SMS Reply from ${app?.full_name || From}: ${(Body || "").slice(0, 80)}`.slice(0, 255),
        Description: `Inbound SMS from ${From}\n\nMessage: ${Body || "(empty)"}`,
        Status: "Completed", Priority: "Normal", ActivityDate: new Date().toISOString().split("T")[0], Type: "SMS",
      });
    } catch (e: any) { console.error("[Twilio Inbound] Error:", e.message); }
  });

  // POST /api/webhooks/mailgun-events — email event webhooks from Mailgun
  app.post("/api/webhooks/mailgun-events", async (req: Request, res: Response) => {
    res.sendStatus(200);
    try {
      const ed = req.body?.["event-data"] || req.body;
      const event = (ed?.event || "").toLowerCase();
      const recipient = ed?.recipient || "";
      const subject = ed?.message?.headers?.subject || "";
      if (!["delivered", "opened", "clicked", "unsubscribed", "complained"].includes(event) || !recipient) return;
      const match = await findSfContactAndOpp(undefined, recipient);
      if (!match) return;
      const subjectMap: Record<string, string> = {
        delivered: `Email Delivered: ${subject}`, opened: `Email Opened: ${subject}`,
        clicked: `Email Link Clicked: ${subject}`, unsubscribed: `Unsubscribed: ${recipient}`,
        complained: `Spam Complaint: ${recipient}`,
      };
      const descMap: Record<string, string> = {
        delivered: `Email "${subject}" delivered to ${recipient}`,
        opened: `${recipient} opened "${subject}"`,
        clicked: `${recipient} clicked link in "${subject}"${ed?.url ? "\nURL: " + ed.url : ""}`,
        unsubscribed: `${recipient} unsubscribed from "${subject}"`,
        complained: `${recipient} marked "${subject}" as spam`,
      };
      await createSfTask({
        WhoId: match.whoId, WhatId: match.whatId || undefined,
        Subject: (subjectMap[event] || `Email ${event}`).slice(0, 255),
        Description: descMap[event] || `Event: ${event}`,
        Status: "Completed", Priority: event === "complained" || event === "unsubscribed" ? "High" : "Normal",
        ActivityDate: new Date().toISOString().split("T")[0], Type: "Email",
      });
    } catch (e: any) { console.error("[Mailgun Event] Error:", e.message); }
  });

  // ─── APPROVAL FOLLOW-UP REPORT ──────────────────────────────────────────

  app.get("/api/admin/approval-followup", async (req: Request, res: Response) => {
    if (!req.session.user?.isAuthenticated) return res.status(401).json({ error: "Auth required" });
    try {
      const result = await db.execute(sql`SELECT value FROM system_settings WHERE key = 'approval_followup_report'`);
      const row = (result as any).rows?.[0];
      if (!row) return res.json(null);
      res.json(typeof row.value === 'string' ? JSON.parse(row.value) : row.value);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ─── FUNDED DEALS AUDIT REPORT ─────────────────────────────────────────

  app.get("/api/admin/funded-deals-audit", async (req: Request, res: Response) => {
    if (!req.session.user?.isAuthenticated) return res.status(401).json({ error: "Auth required" });
    try {
      const fs = await import("fs");
      const path = await import("path");

      // ── Load CLC static data ────────────────────────────────────────────────
      let baseData: any = null;
      const filePath = path.join(process.cwd(), "server", "data", "funded-deals-audit.json");
      if (fs.existsSync(filePath)) {
        baseData = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      } else {
        const result = await db.execute(sql`SELECT value FROM system_settings WHERE key = 'funded_deals_audit'`);
        const row = (result as any).rows?.[0];
        if (row) baseData = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
      }
      if (!baseData) return res.json(null);

      // ── Dedup key: normalise business name + date ───────────────────────────
      const norm = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const clcDeals: any[] = Array.isArray(baseData.deals) ? baseData.deals : [];
      const seen = new Set<string>(
        clcDeals.map((d: any) => `${norm(d.name)}_${(d.funded_date || "").substring(0, 10)}`)
      );

      // ── Query DB for funded decisions ────────────────────────────────────────
      const dbResult = await db.execute(sql`
        SELECT
          business_name,
          advance_amount,
          lender,
          funded_date,
          assigned_rep,
          additional_fundings
        FROM business_underwriting_decisions
        WHERE status = 'approved'
          AND funded_date IS NOT NULL
          AND advance_amount IS NOT NULL
        ORDER BY funded_date DESC
      `);

      const dbOnlyDeals: any[] = [];

      for (const row of (dbResult as any).rows) {
        const dateStr = row.funded_date
          ? (typeof row.funded_date === "string"
              ? row.funded_date.substring(0, 10)
              : new Date(row.funded_date).toISOString().substring(0, 10))
          : null;
        if (!dateStr) continue;

        // Primary funded deal
        const key = `${norm(row.business_name)}_${dateStr}`;
        if (!seen.has(key)) {
          seen.add(key);
          dbOnlyDeals.push({
            name: row.business_name || "Unknown",
            amount: parseFloat(row.advance_amount) || 0,
            lender: row.lender || "Unknown",
            funded_date: dateStr,
            rep: row.assigned_rep || "Unknown",
            source: "db",
          });
        }

        // Additional fundings from JSONB array
        const addFundings: any[] = Array.isArray(row.additional_fundings) ? row.additional_fundings : [];
        for (const af of addFundings) {
          const afAmt = parseFloat(af.advanceAmount || af.amount || 0);
          if (!afAmt) continue;
          const afDate = af.fundedDate
            ? (typeof af.fundedDate === "string"
                ? af.fundedDate.substring(0, 10)
                : new Date(af.fundedDate).toISOString().substring(0, 10))
            : null;
          if (!afDate) continue;
          const afKey = `${norm(row.business_name)}_${afDate}`;
          if (!seen.has(afKey)) {
            seen.add(afKey);
            dbOnlyDeals.push({
              name: row.business_name || "Unknown",
              amount: afAmt,
              lender: af.lender || row.lender || "Unknown",
              funded_date: afDate,
              rep: af.assignedRep || row.assigned_rep || "Unknown",
              source: "db",
            });
          }
        }
      }

      // ── Merge and recompute aggregates ──────────────────────────────────────
      const allDeals: any[] = [...clcDeals, ...dbOnlyDeals];
      const totalDeals = allDeals.length;
      const totalAmount = allDeals.reduce((s: number, d: any) => s + (d.amount || 0), 0);
      const dates = allDeals.map((d: any) => d.funded_date).filter(Boolean).sort();

      // by_rep
      const repMap = new Map<string, { count: number; total: number }>();
      for (const d of allDeals) {
        const rep = d.rep || "Unknown";
        const existing = repMap.get(rep) || { count: 0, total: 0 };
        repMap.set(rep, { count: existing.count + 1, total: existing.total + (d.amount || 0) });
      }
      const by_rep = Array.from(repMap.entries())
        .map(([rep, v]) => ({ rep, count: v.count, total: Math.round(v.total), avg: Math.round(v.total / v.count) }))
        .sort((a, b) => b.total - a.total);

      // by_lender
      const lenderMap = new Map<string, { count: number; total: number }>();
      for (const d of allDeals) {
        const lender = d.lender || "Unknown";
        const existing = lenderMap.get(lender) || { count: 0, total: 0 };
        lenderMap.set(lender, { count: existing.count + 1, total: existing.total + (d.amount || 0) });
      }
      const by_lender = Array.from(lenderMap.entries())
        .map(([lender, v]) => ({ lender, count: v.count, total: Math.round(v.total) }))
        .sort((a, b) => b.total - a.total);

      // by_month
      const monthMap = new Map<string, { count: number; total: number }>();
      for (const d of allDeals) {
        const month = (d.funded_date || "").substring(0, 7);
        if (!month) continue;
        const existing = monthMap.get(month) || { count: 0, total: 0 };
        monthMap.set(month, { count: existing.count + 1, total: existing.total + (d.amount || 0) });
      }
      const by_month = Array.from(monthMap.entries())
        .map(([month, v]) => ({ month, count: v.count, total: Math.round(v.total) }))
        .sort((a, b) => a.month.localeCompare(b.month));

      // size_distribution
      const brackets = [
        { label: "Under $10K", min: 0, max: 10000 },
        { label: "$10K-$25K", min: 10000, max: 25000 },
        { label: "$25K-$50K", min: 25000, max: 50000 },
        { label: "$50K-$100K", min: 50000, max: 100000 },
        { label: "$100K-$250K", min: 100000, max: 250000 },
        { label: "$250K+", min: 250000, max: Infinity },
      ];
      const size_distribution = brackets.map(b => ({
        bracket: b.label,
        count: allDeals.filter((d: any) => (d.amount || 0) >= b.min && (d.amount || 0) < b.max).length,
      }));

      // Update not_in_clc: original not_in_clc entries + new DB-only deals
      const existingNotInClc: any[] = Array.isArray(baseData.not_in_clc) ? baseData.not_in_clc : [];
      const existingNotInClcKeys = new Set(
        existingNotInClc.map((d: any) => `${norm(d.name)}_${(d.funded_date || "").substring(0, 10)}`)
      );
      const newNotInClc = [
        ...existingNotInClc,
        ...dbOnlyDeals.filter((d: any) => !existingNotInClcKeys.has(`${norm(d.name)}_${d.funded_date}`)),
      ];

      // clc_match_count = deals that appear in the CLC static list (original count)
      const clcMatchCount = baseData.summary?.clc_match_count ?? clcDeals.length;

      return res.json({
        generated_at: baseData.generated_at,
        summary: {
          total_deals: totalDeals,
          total_amount: Math.round(totalAmount * 100) / 100,
          avg_deal_size: totalDeals ? Math.round(totalAmount / totalDeals) : 0,
          date_range: dates.length ? [dates[0], dates[dates.length - 1]] : [],
          clc_match_count: clcMatchCount,
          clc_match_rate: totalDeals ? Math.round((clcMatchCount / totalDeals) * 100) : 0,
          not_in_clc_count: newNotInClc.length,
          not_in_clc_amount: Math.round(newNotInClc.reduce((s: number, d: any) => s + (d.amount || 0), 0) * 100) / 100,
          in_db_other_status: baseData.summary?.in_db_other_status ?? 0,
          db_only_count: dbOnlyDeals.length,
        },
        by_rep,
        by_lender,
        by_month,
        by_source: baseData.by_source || [],
        size_distribution,
        not_in_clc: newNotInClc,
        deals: allDeals,
      });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // ─── SMS 90-DAY REPORT (stored historical stats) ────────────────────────

  app.get("/api/admin/sms/90day-stats", async (req: Request, res: Response) => {
    if (!req.session.user?.isAuthenticated || req.session.user.role !== 'admin') {
      return res.status(403).json({ error: "Admin access required" });
    }
    try {
      const result = await db.execute(sql`SELECT value FROM system_settings WHERE key = 'sms_90day_stats'`);
      const row = (result as any).rows?.[0];
      if (!row) return res.json(null);
      res.json(typeof row.value === 'string' ? JSON.parse(row.value) : row.value);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── SMS ANALYTICS ──────────────────────────────────────────────────────────

  // GET /api/admin/sms/analytics — aggregate SMS stats from Twilio + campaign log
  app.get("/api/admin/sms/analytics", async (req: Request, res: Response) => {
    if (!req.session.user?.isAuthenticated || req.session.user.role !== 'admin') {
      return res.status(403).json({ error: "Admin access required" });
    }

    const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
    const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
      return res.status(503).json({ error: "Twilio credentials not configured" });
    }

    const days = Math.min(Number(req.query.days) || 30, 90);
    const since = new Date();
    since.setDate(since.getDate() - days);
    const sinceStr = since.toISOString().split("T")[0];

    try {
      const authHeader = 'Basic ' + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
      const baseUrl = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;

      // Fetch outbound and inbound counts in parallel
      const [outboundRes, inboundRes, campaignStats] = await Promise.all([
        // Outbound messages
        fetch(`${baseUrl}?DateSent>=${sinceStr}&Direction=outbound-api&PageSize=1`, {
          headers: { Authorization: authHeader },
          signal: AbortSignal.timeout(15000),
        }).then(r => r.json()).catch(() => ({ total: 0, messages: [] })),

        // Inbound messages (replies)
        fetch(`${baseUrl}?DateSent>=${sinceStr}&Direction=inbound&PageSize=1`, {
          headers: { Authorization: authHeader },
          signal: AbortSignal.timeout(15000),
        }).then(r => r.json()).catch(() => ({ total: 0, messages: [] })),

        // Campaign breakdown from our log table
        db.execute(sql`
          SELECT stage,
                 COUNT(*) as send_count,
                 COUNT(DISTINCT phone) as unique_recipients,
                 MIN(created_at) as first_sent,
                 MAX(created_at) as last_sent
          FROM sms_campaign_log
          WHERE created_at >= ${since}
          GROUP BY stage
          ORDER BY send_count DESC
        `).catch(() => ({ rows: [] })),
      ]);

      // Get daily send volume from campaign log
      const dailyVolume = await db.execute(sql`
        SELECT DATE(created_at) as date, stage, COUNT(*) as count
        FROM sms_campaign_log
        WHERE created_at >= ${since}
        GROUP BY DATE(created_at), stage
        ORDER BY date DESC
      `).catch(() => ({ rows: [] }));

      // Get recent messages sample for context
      const recentOutbound = await fetch(
        `${baseUrl}?DateSent>=${sinceStr}&Direction=outbound-api&PageSize=20`,
        { headers: { Authorization: authHeader }, signal: AbortSignal.timeout(15000) }
      ).then(r => r.json()).catch(() => ({ messages: [] }));

      // Compute delivery stats from the sample
      const outboundMessages = recentOutbound.messages || [];
      const deliveryStats = {
        delivered: outboundMessages.filter((m: any) => m.status === 'delivered').length,
        undelivered: outboundMessages.filter((m: any) => m.status === 'undelivered').length,
        failed: outboundMessages.filter((m: any) => m.status === 'failed').length,
        sent: outboundMessages.filter((m: any) => m.status === 'sent').length,
        queued: outboundMessages.filter((m: any) => m.status === 'queued').length,
        sampleSize: outboundMessages.length,
      };

      res.json({
        period: { days, since: sinceStr },
        totals: {
          outbound: outboundRes.total || 0,
          inbound: inboundRes.total || 0,
          replyRate: (outboundRes.total || 0) > 0
            ? ((inboundRes.total || 0) / (outboundRes.total || 1) * 100).toFixed(1) + "%"
            : "N/A",
        },
        deliveryStats,
        campaigns: (campaignStats as any).rows || [],
        dailyVolume: (dailyVolume as any).rows || [],
      });
    } catch (err: any) {
      console.error("[SMS Analytics] Error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/sms/backfill — pull recent Twilio messages and backfill campaign log
  app.post("/api/admin/sms/backfill", async (req: Request, res: Response) => {
    if (!req.session.user?.isAuthenticated || req.session.user.role !== 'admin') {
      return res.status(403).json({ error: "Admin access required" });
    }

    const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
    const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
      return res.status(503).json({ error: "Twilio credentials not configured" });
    }

    const days = Math.min(Number(req.body.days) || 30, 90);
    const since = new Date();
    since.setDate(since.getDate() - days);
    const sinceStr = since.toISOString().split("T")[0];

    try {
      const authHeader = 'Basic ' + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
      const baseUrl = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;

      // Pull outbound messages in pages
      let pageUrl: string | null = `${baseUrl}?DateSent>=${sinceStr}&Direction=outbound-api&PageSize=200`;
      let totalInserted = 0;
      let totalScanned = 0;
      const stageMap: Record<string, number> = {};

      while (pageUrl) {
        const fullUrl: string = pageUrl.startsWith("http") ? pageUrl : `https://api.twilio.com${pageUrl}`;
        const pageRes: any = await fetch(fullUrl, {
          headers: { Authorization: authHeader },
          signal: AbortSignal.timeout(30000),
        });
        const pageData: any = await pageRes.json();
        const messages = pageData.messages || [];
        totalScanned += messages.length;

        for (const msg of messages) {
          // Infer campaign/stage from message body
          const body = (msg.body || "").toLowerCase();
          let stage = "unknown";
          if (body.includes("congratulations") && body.includes("approved")) stage = "approval_congratulations";
          else if (body.includes("congratulations") && body.includes("funded")) stage = "funded_congratulations";
          else if (body.includes("bank statement") || body.includes("upload")) stage = "bank_statements_reminder";
          else if (body.includes("application") && body.includes("complete")) stage = "app_abandoned";
          else if (body.includes("approval") && body.includes("stale")) stage = "approval_stale_reminder";
          else if (body.includes("portal")) stage = "portal_notification";
          else if (body.includes("-tcg") || body.includes("today capital")) stage = "outreach";

          try {
            const result = await pool.query(
              `INSERT INTO sms_campaign_log (phone, stage, message_body, twilio_sid, status, created_at)
               VALUES ($1, $2, $3, $4, $5, $6)
               ON CONFLICT DO NOTHING`,
              [msg.to, stage, msg.body, msg.sid, msg.status, new Date(msg.date_sent)]
            );
            if (String(result.rowCount) === "1") {
              totalInserted++;
              stageMap[stage] = (stageMap[stage] || 0) + 1;
            }
          } catch { /* skip duplicates */ }
        }

        pageUrl = pageData.next_page_uri || null;
        if (messages.length < 200) break;
      }

      res.json({
        success: true,
        scanned: totalScanned,
        inserted: totalInserted,
        byCampaign: stageMap,
      });
    } catch (err: any) {
      console.error("[SMS Backfill] Error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GHL EMAIL CAMPAIGN STATS (historical) ──────────────────────────────

  // GET /api/admin/email/ghl-stats — returns stored GHL email campaign stats
  app.get("/api/admin/email/ghl-stats", async (req: Request, res: Response) => {
    if (!req.session.user?.isAuthenticated || req.session.user.role !== 'admin') {
      return res.status(403).json({ error: "Admin access required" });
    }
    try {
      const result = await db.execute(sql`SELECT value FROM system_settings WHERE key = 'ghl_email_stats'`);
      const row = (result as any).rows?.[0];
      if (!row) return res.json(null);
      res.json(typeof row.value === 'string' ? JSON.parse(row.value) : row.value);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── MAILGUN EMAIL ANALYTICS ─────────────────────────────────────────────

  // GET /api/admin/email/analytics — aggregate email stats from Mailgun
  app.get("/api/admin/email/analytics", async (req: Request, res: Response) => {
    if (!req.session.user?.isAuthenticated || req.session.user.role !== 'admin') {
      return res.status(403).json({ error: "Admin access required" });
    }

    const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY;
    if (!MAILGUN_API_KEY) return res.status(503).json({ error: "MAILGUN_API_KEY not configured" });
    const days = Math.min(Number(req.query.days) || 30, 90);

    const domains = [
      "send.todaycapitalgroup.com",
      "mail.todaycapitalgroup.com",
      "updates.todaycapitalgroup.com",
      "news.todaycapitalgroup.com",
    ];

    const authHeader = 'Basic ' + Buffer.from(`api:${MAILGUN_API_KEY}`).toString('base64');

    try {
      // Pull stats for each domain in parallel
      const domainStats = await Promise.all(domains.map(async (domain) => {
        try {
          const statsRes = await fetch(
            `https://api.mailgun.net/v3/${domain}/stats/total?event=accepted&event=delivered&event=opened&event=clicked&event=unsubscribed&event=failed&event=complained&duration=${days}d`,
            { headers: { Authorization: authHeader }, signal: AbortSignal.timeout(15000) }
          );
          const data = await statsRes.json();
          const buckets = data.stats || [];

          // Aggregate across all daily buckets
          const totals: Record<string, number> = {
            accepted: 0, delivered: 0, opened: 0, clicked: 0,
            unsubscribed: 0, complained: 0, failed: 0,
          };
          const daily: Array<{ date: string; delivered: number; opened: number; clicked: number }> = [];

          for (const bucket of buckets) {
            totals.accepted += bucket.accepted?.outgoing || 0;
            totals.delivered += bucket.delivered?.total || 0;
            totals.opened += bucket.opened?.total || 0;
            totals.clicked += bucket.clicked?.total || 0;
            totals.unsubscribed += bucket.unsubscribed?.total || 0;
            totals.complained += bucket.complained?.total || 0;
            totals.failed += (bucket.failed?.permanent?.total || 0) + (bucket.failed?.temporary?.total || 0);

            const dateStr = bucket.time ? new Date(bucket.time).toISOString().split("T")[0] : "";
            if (dateStr && (bucket.delivered?.total || bucket.opened?.total)) {
              daily.push({
                date: dateStr,
                delivered: bucket.delivered?.total || 0,
                opened: bucket.opened?.total || 0,
                clicked: bucket.clicked?.total || 0,
              });
            }
          }

          return { domain, totals, daily, active: totals.accepted > 0 || totals.delivered > 0 };
        } catch {
          return { domain, totals: {}, daily: [], active: false };
        }
      }));

      // Aggregate across all domains
      const combined: Record<string, number> = {
        accepted: 0, delivered: 0, opened: 0, clicked: 0,
        unsubscribed: 0, complained: 0, failed: 0,
      };
      for (const ds of domainStats) {
        for (const [key, val] of Object.entries(ds.totals)) {
          combined[key] = (combined[key] || 0) + (val as number);
        }
      }

      const openRate = combined.delivered > 0
        ? ((combined.opened / combined.delivered) * 100).toFixed(1) + "%"
        : "N/A";
      const clickRate = combined.opened > 0
        ? ((combined.clicked / combined.opened) * 100).toFixed(1) + "%"
        : "N/A";

      res.json({
        period: { days },
        totals: { ...combined, openRate, clickRate },
        domains: domainStats.filter(d => d.active),
      });
    } catch (err: any) {
      console.error("[EMAIL Analytics] Error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ─── SMS INBOX ROUTES ─────────────────────────────────────────────────────

  // GET /api/admin/sms/inbound — list all inbound messages from Twilio
  app.get("/api/admin/sms/inbound", async (req, res) => {
    if (!req.session.user?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }
    if (req.session.user.role !== 'admin') {
      return res.status(403).json({ error: "Admin access required" });
    }

    const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
    const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
      return res.status(503).json({ error: "Twilio credentials not configured" });
    }

    try {
      const pageSize = Math.min(Number(req.query.pageSize) || 100, 200);
      const page = Number(req.query.page) || 0;
      const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json?Direction=inbound&PageSize=${pageSize}&Page=${page}`;

      const twilioRes = await fetch(url, {
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64'),
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!twilioRes.ok) {
        const errBody = await twilioRes.text();
        console.error('[TWILIO] Inbound messages fetch failed:', twilioRes.status, errBody);
        return res.status(500).json({ error: `Twilio API error: ${twilioRes.status}` });
      }

      const data = await twilioRes.json();
      const messages: any[] = data.messages || [];

      // Collect unique phone numbers to batch-lookup contacts
      const uniquePhones = [...new Set(messages.map((m: any) => m.from as string))];
      const contactMap: Record<string, any> = {};

      for (const phone of uniquePhones) {
        try {
          const digits = phone.replace(/\D/g, '');
          const result = await pool.query(
            `SELECT id, full_name, email, phone, business_name, legal_business_name
             FROM loan_applications
             WHERE regexp_replace(phone, '[^0-9]', '', 'g') = $1
             ORDER BY created_at DESC
             LIMIT 1`,
            [digits]
          );
          if (result.rows.length > 0) {
            const row = result.rows[0];
            contactMap[phone] = {
              id: row.id,
              fullName: row.full_name,
              email: row.email,
              phone: row.phone,
              businessName: row.business_name,
              legalBusinessName: row.legal_business_name,
            };
          }
        } catch { /* ignore per-phone lookup errors */ }
      }

      const enriched = messages.map((msg: any) => ({
        sid: msg.sid,
        from: msg.from,
        to: msg.to,
        body: msg.body,
        dateSent: msg.date_sent,
        status: msg.status,
        direction: msg.direction,
        contact: contactMap[msg.from] || null,
      }));

      res.json({
        messages: enriched,
        hasMore: !!data.next_page_uri,
        total: data.total,
      });
    } catch (error) {
      console.error("[SMS] Inbound fetch error:", error);
      res.status(500).json({ error: "Failed to fetch SMS messages" });
    }
  });

  // GET /api/admin/sms/conversation/:phone — fetch full thread (inbound + outbound) for a number
  app.get("/api/admin/sms/conversation/:phone", async (req, res) => {
    if (!req.session.user?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }
    if (req.session.user.role !== 'admin') {
      return res.status(403).json({ error: "Admin access required" });
    }

    const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
    const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
    const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
      return res.status(503).json({ error: "Twilio credentials not configured" });
    }

    try {
      const contactPhone = decodeURIComponent(req.params.phone);
      const authHeader = 'Basic ' + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');

      const [inboundRes, outboundRes] = await Promise.all([
        fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json?From=${encodeURIComponent(contactPhone)}&PageSize=50`, {
          headers: { 'Authorization': authHeader },
          signal: AbortSignal.timeout(15000),
        }),
        fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json?To=${encodeURIComponent(contactPhone)}&PageSize=50`, {
          headers: { 'Authorization': authHeader },
          signal: AbortSignal.timeout(15000),
        }),
      ]);

      const inboundData = inboundRes.ok ? await inboundRes.json() : { messages: [] };
      const outboundData = outboundRes.ok ? await outboundRes.json() : { messages: [] };

      const allMessages = [
        ...(inboundData.messages || []),
        ...(outboundData.messages || []),
      ]
        .map((m: any) => ({
          sid: m.sid,
          from: m.from,
          to: m.to,
          body: m.body,
          dateSent: m.date_sent,
          status: m.status,
          direction: m.direction,
        }))
        .sort((a, b) => new Date(a.dateSent).getTime() - new Date(b.dateSent).getTime());

      res.json({ messages: allMessages, ourNumber: TWILIO_PHONE_NUMBER || null });
    } catch (error) {
      console.error("[SMS] Conversation fetch error:", error);
      res.status(500).json({ error: "Failed to fetch conversation" });
    }
  });

  // POST /api/admin/sms/reply — send an outbound SMS reply
  app.post("/api/admin/sms/reply", async (req, res) => {
    if (!req.session.user?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }
    if (req.session.user.role !== 'admin') {
      return res.status(403).json({ error: "Admin access required" });
    }

    const { to, body } = req.body;
    if (!to || !body?.trim()) {
      return res.status(400).json({ error: "Missing 'to' or 'body'" });
    }

    try {
      const { sendSms } = await import('./services/twilio');
      const result = await sendSms(to, body.trim());
      if (result.success) {
        res.json({ success: true, sid: result.sid });
      } else {
        res.status(500).json({ error: result.error || "Failed to send SMS" });
      }
    } catch (error) {
      console.error("[SMS] Reply error:", error);
      res.status(500).json({ error: "Failed to send SMS reply" });
    }
  });

  // ==========================================
  // GigFi Partner Lead Submission
  // ==========================================
  // Lead prefill endpoint — used by /gig to auto-populate contact fields
  app.get("/api/lead/prefill", async (req: Request, res: Response) => {
    try {
      const { email, phone } = req.query as { email?: string; phone?: string };
      if (!email && !phone) {
        return res.status(400).json({ error: "email or phone query param required" });
      }
      let app: any;
      if (email) {
        app = await storage.getAnyLoanApplicationByEmail(email.toLowerCase().trim());
      }
      if (!app && phone) {
        app = await storage.getLoanApplicationByEmailOrPhone(phone.trim());
      }
      if (!app) {
        return res.status(404).json({ error: "No matching lead found" });
      }
      return res.json({
        fullName: app.fullName || "",
        email: app.email || "",
        phone: app.phone || "",
        businessName: app.businessName || "",
      });
    } catch (err) {
      console.error("[prefill]", err);
      return res.status(500).json({ error: "Server error" });
    }
  });

  // GET /api/gigfi/submissions — all leads that have been submitted to GigFi
  app.get("/api/gigfi/submissions", async (req: Request, res: Response) => {
    if (!req.session.user || !['admin', 'agent', 'user'].includes(req.session.user.role)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    try {
      const submissions = await storage.getGigFiSubmissions();
      return res.json({ submissions });
    } catch (err) {
      console.error("[GIGFI SUBMISSIONS]", err);
      return res.status(500).json({ error: "Failed to load submissions" });
    }
  });

  // POST /api/gigfi/record — record a pre-existing GigFi result without re-submitting to GigFi
  app.post("/api/gigfi/record", async (req: Request, res: Response) => {
    const { applicationId, status, decisionId, redirectUrl } = req.body;
    if (!applicationId || !status) {
      return res.status(400).json({ error: "applicationId and status are required" });
    }
    try {
      await storage.saveGigFiResult(applicationId, status, decisionId, redirectUrl);
      return res.json({ ok: true });
    } catch (err) {
      console.error("[GIGFI RECORD]", err);
      return res.status(500).json({ error: "Failed to record result" });
    }
  });

  // Helper: validate external API key (Bearer token = ADMIN_PASSWORD)
  function validateExternalApiKey(req: Request, res: Response): boolean {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const adminPassword = process.env.ADMIN_PASSWORD || "Tcg1!tcg";
    if (!token || token !== adminPassword) {
      res.status(401).json({ error: "Unauthorized — provide a valid Bearer token" });
      return false;
    }
    return true;
  }

  // GET /api/gigfi/external/pending
  // Returns declined/unqualified underwriting decisions with linked application data.
  // Intended for external programs that want to pull new candidates and submit them to GigFi.
  // Auth: Bearer token = ADMIN_PASSWORD
  // Query params: lookbackDays (default 30) — how many days back to search
  app.get("/api/gigfi/external/pending", async (req: Request, res: Response) => {
    if (!validateExternalApiKey(req, res)) return;
    const lookbackDays = Math.min(parseInt((req.query.lookbackDays as string) || "30", 10), 365);
    try {
      const decisions = await storage.getDeclinedDecisionsForExternalGigFi(lookbackDays);
      return res.json({
        count: decisions.length,
        lookbackDays,
        decisions,
      });
    } catch (err) {
      console.error("[GIGFI EXTERNAL PENDING]", err);
      return res.status(500).json({ error: "Failed to fetch pending decisions" });
    }
  });

  // POST /api/gigfi/external/record
  // Records a GigFi submission result from an external program.
  // Accepts applicationId OR email (will find the most recent unsubmitted application for that email).
  // On success, the submission appears in the GigFi Submissions page immediately.
  // Auth: Bearer token = ADMIN_PASSWORD
  // Body: { applicationId?, email?, status, decisionId?, redirectUrl? }
  app.post("/api/gigfi/external/record", async (req: Request, res: Response) => {
    if (!validateExternalApiKey(req, res)) return;
    const { applicationId, email, status, decisionId, redirectUrl } = req.body;

    if (!status || !["ACCEPTED", "REJECTED", "ERROR"].includes(status.toUpperCase())) {
      return res.status(400).json({ error: "status is required and must be ACCEPTED, REJECTED, or ERROR" });
    }
    if (!applicationId && !email) {
      return res.status(400).json({ error: "Provide either applicationId or email" });
    }

    try {
      const normalizedStatus = status.toUpperCase();
      if (applicationId) {
        await storage.saveGigFiResult(applicationId, normalizedStatus, decisionId, redirectUrl);
        console.log(`[GIGFI EXTERNAL] Recorded result for applicationId=${applicationId} status=${normalizedStatus}`);
        return res.json({ ok: true, applicationId });
      } else {
        const result = await storage.saveGigFiResultByEmail(email, normalizedStatus, decisionId, redirectUrl);
        if (!result) {
          return res.status(404).json({
            error: "No un-submitted application found for that email. It may already have a GigFi result recorded, or may not exist in the database.",
          });
        }
        console.log(`[GIGFI EXTERNAL] Recorded result for email=${email} applicationId=${result.applicationId} status=${normalizedStatus}`);
        return res.json({ ok: true, applicationId: result.applicationId });
      }
    } catch (err) {
      console.error("[GIGFI EXTERNAL RECORD]", err);
      return res.status(500).json({ error: "Failed to record GigFi result" });
    }
  });

  // Internal GigFi applicant search — admin/agent only
  app.get("/api/gigfi/search", async (req: Request, res: Response) => {
    if (!req.session.user || !['admin', 'agent', 'user'].includes(req.session.user.role)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const query = (req.query.q as string || "").trim();
    if (!query || query.length < 2) {
      return res.status(400).json({ error: "Query must be at least 2 characters" });
    }
    try {
      const apps = await storage.searchFullApplicationsForGigFi(query);
      return res.json({ results: apps });
    } catch (err) {
      console.error("[GIGFI SEARCH]", err);
      return res.status(500).json({ error: "Search failed" });
    }
  });

  app.post("/api/gigfi/submit", async (req: Request, res: Response) => {
    try {
      if (!isGigFiConfigured()) {
        return res.status(503).json({ error: "GigFi integration is not currently available." });
      }

      const {
        applicationId,
        firstName,
        lastName,
        email,
        phone,
        businessName,
        monthlyRevenue,
        financingAmount,
        businessAge,
        ssn,
        dob,
        homeAddress,
        homeCity,
        homeState,
        homeZip,
        bankName,
        abaNumber,
        accountNumber,
        accountType,
        payFrequency,
        nextPayDay,
      } = req.body;

      // Validate required fields
      const missing: string[] = [];
      if (!firstName) missing.push("firstName");
      if (!lastName) missing.push("lastName");
      if (!email) missing.push("email");
      if (!phone) missing.push("phone");
      if (!ssn || ssn.replace(/\D/g, "").length !== 9) missing.push("ssn (9 digits)");
      if (!dob) missing.push("dob");
      if (!homeAddress) missing.push("homeAddress");
      if (!homeCity) missing.push("homeCity");
      if (!homeState || homeState.length !== 2) missing.push("homeState (2 chars)");
      if (!homeZip || homeZip.replace(/\D/g, "").length !== 5) missing.push("homeZip (5 digits)");
      if (!payFrequency) missing.push("payFrequency");
      if (!nextPayDay) missing.push("nextPayDay");

      if (missing.length > 0) {
        return res.status(400).json({ error: `Missing or invalid fields: ${missing.join(", ")}` });
      }

      const leadData: GigFiLeadData = {
        firstName,
        lastName,
        email,
        phone,
        businessName: businessName || "",
        monthlyRevenue: parseFloat(monthlyRevenue) || 0,
        financingAmount: parseFloat(financingAmount) || 500,
        businessAge,
        ssn: ssn.replace(/\D/g, ""),
        dob,
        homeAddress,
        homeCity,
        homeState: homeState.toUpperCase(),
        homeZip: homeZip.replace(/\D/g, "").slice(0, 5),
        ...(bankName && { bankName }),
        ...(abaNumber && { abaNumber: abaNumber.replace(/\D/g, "") }),
        ...(accountNumber && { accountNumber }),
        ...(accountType && { accountType }),
        payFrequency,
        nextPayDay,
        cellPhone: phone,
        clientIpAddress: (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || undefined,
      };

      const result = await submitToGigFi(leadData, applicationId || `anon-${Date.now()}`);

      // Persist GigFi decision to the loan application record
      if (applicationId && result.status) {
        storage.saveGigFiResult(
          applicationId,
          result.status,
          result.decisionId,
          result.redirectUrl,
        ).catch(err => console.error("[GIGFI] Failed to save result to DB:", err));
      }

      res.json(result);
    } catch (error: any) {
      console.error("[GIGFI] Endpoint error:", error);
      res.status(500).json({
        success: false,
        status: "ERROR",
        errorMessage: "An unexpected error occurred. Please try again.",
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // ADMIN MERCHANT PROFILE — 360° view of a merchant by email
  // ═══════════════════════════════════════════════════════════════

  app.get("/api/admin/merchant-profile/:email", async (req, res) => {
    if (!req.session.user?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }
    if (req.session.user.role !== 'admin' && req.session.user.role !== 'underwriting' && req.session.user.role !== 'agent') {
      return res.status(403).json({ error: "Staff access required" });
    }

    try {
      const email = decodeURIComponent(req.params.email).toLowerCase();
      if (!email || !email.includes('@')) {
        return res.status(400).json({ error: "Valid email is required" });
      }

      // ── PHASE 1: Fetch everything by email ──
      const [
        emailApplications,
        emailDecisions,
        emailBankStatements,
        emailCongratsUploads,
        emailMessages,
        portalAccount,
        emailLenderApprovals,
      ] = await Promise.all([
        storage.getAllLoanApplications().then(apps => apps.filter(a => a.email?.toLowerCase() === email)),
        storage.getBusinessUnderwritingDecisionsByEmail(email).then(async (byEmail) => {
          const byMerchant = await storage.getBusinessUnderwritingDecisionsByMerchantEmail(email);
          const map = new Map<string, typeof byEmail[0]>();
          for (const d of [...byEmail, ...byMerchant]) map.set(d.id, d);
          return Array.from(map.values());
        }),
        storage.getBankStatementUploadsByEmail(email),
        storage.getCongratulationsUploadsByEmail(email),
        storage.getMerchantMessagesByEmail(email),
        storage.getMerchantPortalAccountByEmail(email),
        storage.getAllLenderApprovals().then(all => all.filter(a => a.businessEmail?.toLowerCase() === email)),
      ]);

      // ── PHASE 2: Collect known business names for fallback matching ──
      const knownNames = new Set<string>();
      for (const a of emailApplications) {
        if (a.businessName) knownNames.add(a.businessName.toLowerCase().trim());
        if (a.legalBusinessName) knownNames.add(a.legalBusinessName.toLowerCase().trim());
      }
      for (const d of emailDecisions) {
        if (d.businessName) knownNames.add(d.businessName.toLowerCase().trim());
      }
      if (portalAccount?.businessName) knownNames.add(portalAccount.businessName.toLowerCase().trim());
      // Also add names from lender approvals
      for (const la of emailLenderApprovals) {
        if (la.businessName) knownNames.add(la.businessName.toLowerCase().trim());
      }

      // Helper: check if a name matches any of our known business names (exact match only)
      const nameMatches = (name: string | null | undefined): boolean => {
        if (!name) return false;
        const normalized = name.toLowerCase().trim();
        if (!normalized || normalized.length < 3) return false;
        return knownNames.has(normalized);
      };

      // ── PHASE 3: Business-name fallback — ONLY when email match found nothing ──
      let applications = emailApplications;
      let decisions = emailDecisions;
      let bankStatements = emailBankStatements;
      let congratsUploads = emailCongratsUploads;
      let messages = emailMessages;
      let lenderApprovalsRaw = emailLenderApprovals;

      if (knownNames.size > 0) {
        // Only fall back to name matching for categories where email returned zero results
        if (applications.length === 0) {
          const allApps = await storage.getAllLoanApplications();
          applications = allApps.filter(a =>
            nameMatches(a.businessName) || nameMatches(a.legalBusinessName)
          );
        }

        if (decisions.length === 0) {
          const allDecisions = await storage.getAllBusinessUnderwritingDecisions();
          decisions = allDecisions.filter(d => nameMatches(d.businessName));
        }

        if (bankStatements.length === 0) {
          const allStatements = await storage.getAllBankStatementUploads();
          bankStatements = allStatements.filter(s => nameMatches(s.businessName));
        }

        if (congratsUploads.length === 0) {
          const allCongrats = await storage.getAllCongratulationsUploads();
          congratsUploads = allCongrats.filter(c => nameMatches(c.businessName));
        }

        if (lenderApprovalsRaw.length === 0) {
          const allLenderApprovals = await storage.getAllLenderApprovals();
          lenderApprovalsRaw = allLenderApprovals.filter(la => nameMatches(la.businessName));
        }

        // Messages stay email-only (they are tied to portal sessions, name matching would be unreliable)
      }

      // Separate decisions by status
      const approvals = decisions.filter(d => d.status === 'approved');
      const declines = decisions.filter(d => d.status === 'declined');
      const fundedDecisions = decisions.filter(d => d.status === 'funded' || d.fundedDate);

      // Build funded deals list (same logic as merchant portal)
      const fundedDeals: any[] = [];
      for (const decision of fundedDecisions) {
        const fundings = Array.isArray(decision.additionalFundings) ? decision.additionalFundings as any[] : [];
        if (fundings.length > 0) {
          for (const funding of fundings) {
            fundedDeals.push({
              id: funding.id || decision.id,
              lender: funding.lender || decision.lender || 'N/A',
              advanceAmount: funding.advanceAmount || decision.advanceAmount || '0',
              factorRate: funding.factorRate || decision.factorRate || '0',
              totalPayback: funding.totalPayback || decision.totalPayback || '0',
              paymentFrequency: funding.paymentFrequency || decision.paymentFrequency || 'daily',
              fundedDate: funding.fundedDate || (decision.fundedDate ? new Date(decision.fundedDate).toISOString() : null),
              term: funding.term || decision.term || '',
              assignedRep: funding.assignedRep || decision.assignedRep || null,
              notes: funding.notes || decision.notes || null,
              decisionId: decision.id,
            });
          }
        } else {
          fundedDeals.push({
            id: decision.id,
            lender: decision.lender || 'N/A',
            advanceAmount: decision.advanceAmount || '0',
            factorRate: decision.factorRate || '0',
            totalPayback: decision.totalPayback || '0',
            paymentFrequency: decision.paymentFrequency || 'daily',
            fundedDate: decision.fundedDate ? new Date(decision.fundedDate).toISOString() : null,
            term: decision.term || '',
            assignedRep: decision.assignedRep || null,
            notes: decision.notes || null,
            decisionId: decision.id,
          });
        }
      }

      // Documents = congrats uploads (voided check, drivers license) + bank statements
      const documents = [
        ...congratsUploads.map(c => ({
          id: c.id,
          type: c.docType,
          name: c.originalFileName,
          fileSize: c.fileSize,
          category: 'closing' as const,
          createdAt: c.createdAt,
          objectName: c.objectName,
        })),
        ...bankStatements.map(s => ({
          id: s.id,
          type: 'bank_statement',
          name: s.originalFileName,
          fileSize: s.fileSize,
          category: 'statements' as const,
          createdAt: s.createdAt,
          viewToken: s.viewToken,
          approvalStatus: s.approvalStatus,
          lenderName: s.lenderName,
        })),
      ];

      // Derive business info from first available source
      const firstApp = applications[0];
      const firstDecision = decisions[0];
      const businessInfo = {
        businessName: firstApp?.businessName || firstApp?.legalBusinessName || firstDecision?.businessName || portalAccount?.businessName || '',
        contactName: firstApp?.fullName || portalAccount?.name || '',
        phone: firstApp?.phone || firstDecision?.businessPhone || portalAccount?.phone || '',
        email,
        industry: firstApp?.industry || '',
        ein: firstApp?.ein || '',
        timeInBusiness: firstApp?.timeInBusiness || '',
        monthlyRevenue: firstApp?.monthlyRevenue || firstApp?.averageMonthlyRevenue || '',
        creditScore: firstApp?.creditScore || firstApp?.personalCreditScoreRange || '',
        businessAddress: firstApp?.businessAddress || '',
        city: firstApp?.city || '',
        state: firstApp?.state || '',
        zipCode: firstApp?.zipCode || '',
        requestedAmount: firstApp?.requestedAmount || '',
      };

      // Portal status
      const portalStatus = {
        hasAccount: !!portalAccount,
        hasPassword: !!(portalAccount?.passwordHash || fundedDecisions.some(d => d.merchantPasswordHash)),
        portalLinkSentAt: portalAccount?.portalLinkSentAt || null,
        createdAt: portalAccount?.createdAt || null,
      };

      // Activity timeline (most recent first)
      const timeline: Array<{ type: string; date: string; summary: string; id?: string }> = [];
      for (const app of applications) {
        timeline.push({ type: 'application', date: (app.createdAt || new Date()).toISOString(), summary: `Application submitted${app.isFullApplicationCompleted ? ' (full)' : app.isCompleted ? ' (intake)' : ' (partial)'}`, id: app.id });
      }
      for (const d of approvals) {
        timeline.push({ type: 'approval', date: (d.createdAt || new Date()).toISOString(), summary: `Approved by ${d.lender || 'lender'} for ${d.advanceAmount ? `$${parseFloat(d.advanceAmount).toLocaleString()}` : 'N/A'}`, id: d.id });
      }
      for (const d of declines) {
        timeline.push({ type: 'decline', date: (d.createdAt || new Date()).toISOString(), summary: `Declined${d.declineReason ? `: ${d.declineReason}` : ''}`, id: d.id });
      }
      for (const deal of fundedDeals) {
        timeline.push({ type: 'funded', date: deal.fundedDate || (new Date()).toISOString(), summary: `Funded by ${deal.lender} — $${parseFloat(deal.advanceAmount).toLocaleString()}`, id: deal.id });
      }
      for (const s of bankStatements) {
        timeline.push({ type: 'statement', date: (s.receivedAt || s.createdAt || new Date()).toISOString(), summary: `Bank statement uploaded: ${s.originalFileName}`, id: s.id });
      }
      for (const c of congratsUploads) {
        timeline.push({ type: 'document', date: (c.createdAt || new Date()).toISOString(), summary: `${c.docType === 'voided_check' ? 'Voided check' : 'Driver\'s license'} uploaded`, id: c.id });
      }
      timeline.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

      // Track which records matched by email vs business name
      const emailAppIds = new Set(emailApplications.map(a => a.id));
      const emailDecisionIds = new Set(emailDecisions.map(d => d.id));
      const emailStatementIds = new Set(emailBankStatements.map(s => s.id));
      const emailCongratsIds = new Set(emailCongratsUploads.map(c => c.id));
      const emailLaIds = new Set(emailLenderApprovals.map(la => la.id));

      res.json({
        businessInfo,
        applications: applications.map(a => ({
          id: a.id,
          fullName: a.fullName,
          businessName: a.businessName || a.legalBusinessName,
          email: a.email,
          phone: a.phone,
          isCompleted: a.isCompleted,
          isFullApplicationCompleted: a.isFullApplicationCompleted,
          currentStep: a.currentStep,
          agentName: a.agentName,
          agentEmail: a.agentEmail,
          requestedAmount: a.requestedAmount,
          monthlyRevenue: a.monthlyRevenue,
          creditScore: a.creditScore || a.personalCreditScoreRange,
          createdAt: a.createdAt,
          updatedAt: a.updatedAt,
          matchedVia: emailAppIds.has(a.id) ? 'email' as const : 'business_name' as const,
        })),
        approvals: approvals.map(d => ({
          id: d.id,
          lender: d.lender,
          advanceAmount: d.advanceAmount,
          term: d.term,
          factorRate: d.factorRate,
          paymentFrequency: d.paymentFrequency,
          totalPayback: d.totalPayback,
          approvalDate: d.approvalDate,
          approvalDeadline: d.approvalDeadline,
          assignedRep: d.assignedRep,
          notes: d.notes,
          additionalApprovals: d.additionalApprovals,
          showOnLetter: d.showOnLetter,
          approvalSlug: d.approvalSlug,
          createdAt: d.createdAt,
          matchedVia: emailDecisionIds.has(d.id) ? 'email' as const : 'business_name' as const,
        })),
        declines: declines.map(d => ({
          id: d.id,
          lender: d.lender,
          declineReason: d.declineReason,
          followUpWorthy: d.followUpWorthy,
          followUpDate: d.followUpDate,
          notes: d.notes,
          reviewedBy: d.reviewedBy,
          createdAt: d.createdAt,
          matchedVia: emailDecisionIds.has(d.id) ? 'email' as const : 'business_name' as const,
        })),
        fundedDeals,
        lenderApprovals: lenderApprovalsRaw.map(la => ({
          id: la.id,
          lenderName: la.lenderName,
          approvedAmount: la.approvedAmount,
          termLength: la.termLength,
          factorRate: la.factorRate,
          paybackAmount: la.paybackAmount,
          productType: la.productType,
          status: la.status,
          createdAt: la.createdAt,
          matchedVia: emailLaIds.has(la.id) ? 'email' as const : 'business_name' as const,
        })),
        documents,
        messages,
        portalStatus,
        timeline,
      });
    } catch (error) {
      console.error("[ADMIN] Merchant profile error:", error);
      res.status(500).json({ error: "Failed to load merchant profile" });
    }
  });

  // Search merchants by name or email for the merchant profile lookup
  app.get("/api/admin/merchant-search", async (req, res) => {
    if (!req.session.user?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }
    if (req.session.user.role !== 'admin' && req.session.user.role !== 'underwriting' && req.session.user.role !== 'agent') {
      return res.status(403).json({ error: "Staff access required" });
    }

    try {
      const q = (req.query.q as string || '').toLowerCase().trim();
      if (!q || q.length < 2) {
        return res.json([]);
      }

      // Search across applications and decisions for matching email or business name
      const [allApps, allDecisions] = await Promise.all([
        storage.getAllLoanApplications(),
        storage.getAllBusinessUnderwritingDecisions(),
      ]);

      const merchantMap = new Map<string, { email: string; businessName: string; contactName: string; hasDecision: boolean; status: string }>();

      for (const app of allApps) {
        const email = app.email?.toLowerCase();
        if (!email) continue;
        if (email.includes(q) || (app.businessName || '').toLowerCase().includes(q) || (app.fullName || '').toLowerCase().includes(q)) {
          if (!merchantMap.has(email)) {
            merchantMap.set(email, {
              email,
              businessName: app.businessName || app.legalBusinessName || '',
              contactName: app.fullName || '',
              hasDecision: false,
              status: app.isFullApplicationCompleted ? 'full_app' : app.isCompleted ? 'intake' : 'partial',
            });
          }
        }
      }

      for (const d of allDecisions) {
        const email = (d.businessEmail || d.merchantEmail || '').toLowerCase();
        if (!email) continue;
        if (email.includes(q) || (d.businessName || '').toLowerCase().includes(q)) {
          const existing = merchantMap.get(email);
          if (existing) {
            existing.hasDecision = true;
            existing.status = d.fundedDate ? 'funded' : d.status || existing.status;
            if (!existing.businessName && d.businessName) existing.businessName = d.businessName;
          } else {
            merchantMap.set(email, {
              email,
              businessName: d.businessName || '',
              contactName: '',
              hasDecision: true,
              status: d.fundedDate ? 'funded' : d.status || 'unknown',
            });
          }
        }
      }

      const results = Array.from(merchantMap.values()).slice(0, 20);
      res.json(results);
    } catch (error) {
      console.error("[ADMIN] Merchant search error:", error);
      res.status(500).json({ error: "Search failed" });
    }
  });

  // ========================================
  // SALESFORCE SCHEDULED SYNC (3x daily)
  // Syncs decisions created/updated today that haven't synced to SF yet
  // Runs at 8am, 1pm, 8pm EST (12:00, 17:00, 00:00 UTC)
  // ========================================
  async function retryFailedSfSyncs() {
    try {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const failedDecisions = await db.execute(
        drizzleSql`SELECT * FROM business_underwriting_decisions WHERE (sf_synced = false OR sf_synced IS NULL) AND (created_at >= ${todayStart} OR updated_at >= ${todayStart}) ORDER BY created_at DESC`
      );
      const rows = failedDecisions.rows as any[];
      if (rows.length === 0) {
        console.log("[SF Scheduled Sync] No unsynced decisions found");
        return;
      }
      console.log(`[SF Scheduled Sync] Retrying ${rows.length} unsynced decisions...`);
      let synced = 0;
      let failed = 0;
      for (const d of rows) {
        try {
          const result = await syncDecisionToSalesforce(d);
          await storage.updateBusinessUnderwritingDecision(d.id, {
            sfSynced: result.synced,
            sfSyncedAt: new Date(),
            sfSyncMessage: result.error || result.action || null,
            sfOpportunityId: result.oppId || null,
          });
          if (result.synced) synced++;
          else failed++;
        } catch (err: any) {
          failed++;
          console.error(`[SF Scheduled Sync] Error syncing ${d.business_name}: ${err.message}`);
        }
      }
      console.log(`[SF Scheduled Sync] Done: ${synced} synced, ${failed} failed out of ${rows.length}`);
    } catch (err: any) {
      console.error(`[SF Scheduled Sync] Error: ${err.message}`);
    }
  }

  // Schedule: check every hour, run at 8am/1pm/8pm EST
  const SF_SYNC_HOURS_UTC = [12, 17, 0]; // 8am, 1pm, 8pm EST (UTC-4 EDT)
  let lastSfSyncHour = -1;
  if (SF_SYNC_ENABLED) {
    setInterval(() => {
      const nowUtc = new Date().getUTCHours();
      if (SF_SYNC_HOURS_UTC.includes(nowUtc) && lastSfSyncHour !== nowUtc) {
        lastSfSyncHour = nowUtc;
        console.log(`[SF Scheduled Sync] Triggered at UTC hour ${nowUtc}`);
        retryFailedSfSyncs();
      }
    }, 10 * 60 * 1000); // Check every 10 minutes
  }

  // ═══════════════════════════════════════════════════════════════
  // ADMIN GIGFI CSV SUBMISSION
  // ═══════════════════════════════════════════════════════════════

  
  // POST /api/admin/gigfi-csv-submit — submit a list of leads from CSV (App ID used to pull SSN from DB)
  app.post("/api/admin/gigfi-csv-submit", async (req: Request, res: Response) => {
    if (!req.session.user || req.session.user.role !== "admin") {
      return res.status(401).json({ error: "Admin access required" });
    }
    if (!isGigFiConfigured()) {
      return res.status(503).json({ error: "GigFi not configured" });
    }

    // Each lead: { appId, firstName, lastName, email, phone, businessName, dob, address, city, state, zip, revenue?, businessAge? }
    const leads: Array<{
      appId: string;
      firstName: string;
      lastName: string;
      email: string;
      phone: string;
      businessName: string;
      dob: string;
      address: string;
      city: string;
      state: string;
      zip: string;
      revenue?: number;
      businessAge?: string;
    }> = req.body.leads;

    if (!Array.isArray(leads) || leads.length === 0) {
      return res.status(400).json({ error: "leads array required" });
    }

    function normalizePhone(p: string): string { return (p || "").replace(/\D/g, "").slice(0, 10); }
    function isValidPhone(p: string): boolean { return normalizePhone(p).length === 10; }

    const results: Array<{
      appId: string;
      name: string;
      email: string;
      status: string;
      gigfiStatus?: string;
      redirectUrl?: string;
      decisionId?: string;
      skippedReason?: string;
    }> = [];

    for (const lead of leads) {
      const fullName = `${lead.firstName} ${lead.lastName}`.trim();
      try {
        // Look up SSN from DB by App ID
        const app = await storage.getLoanApplication(lead.appId);
        if (!app) {
          results.push({ appId: lead.appId, name: fullName, email: lead.email, status: "SKIPPED", skippedReason: "App ID not found in DB" });
          continue;
        }

        const ssn = (app.socialSecurityNumber || "").replace(/\D/g, "");
        if (ssn.length !== 9) {
          results.push({ appId: lead.appId, name: fullName, email: lead.email, status: "SKIPPED", skippedReason: `SSN missing or invalid (found: "${app.socialSecurityNumber || "none"}")` });
          continue;
        }

        // Validate phone
        const phone = isValidPhone(lead.phone) ? lead.phone : "";
        if (!phone) {
          results.push({ appId: lead.appId, name: fullName, email: lead.email, status: "SKIPPED", skippedReason: `Invalid phone: "${lead.phone}"` });
          continue;
        }

        // Validate address
        const zip = (lead.zip || "").replace(/\D/g, "").slice(0, 5);
        const state = (lead.state || "").toUpperCase().slice(0, 2);
        if (!lead.address || !lead.city || state.length !== 2 || zip.length !== 5) {
          results.push({ appId: lead.appId, name: fullName, email: lead.email, status: "SKIPPED", skippedReason: `Incomplete address (addr="${lead.address}" city="${lead.city}" state="${state}" zip="${zip}")` });
          continue;
        }

        // Validate DOB
        if (!lead.dob) {
          results.push({ appId: lead.appId, name: fullName, email: lead.email, status: "SKIPPED", skippedReason: "DOB missing" });
          continue;
        }

        // Sanity-check DOB year (must be 1900–2010 for an adult applicant)
        const dobYear = parseInt((lead.dob || "").slice(0, 4), 10);
        if (isNaN(dobYear) || dobYear < 1900 || dobYear > 2010) {
          results.push({ appId: lead.appId, name: fullName, email: lead.email, status: "SKIPPED", skippedReason: `DOB year looks invalid: "${lead.dob}"` });
          continue;
        }

        const leadData: GigFiLeadData = {
          firstName: lead.firstName,
          lastName: lead.lastName,
          email: lead.email,
          phone,
          businessName: lead.businessName,
          monthlyRevenue: lead.revenue || 3000,
          financingAmount: 10000,
          businessAge: lead.businessAge,
          ssn,
          dob: lead.dob,
          homeAddress: lead.address,
          homeCity: lead.city,
          homeState: state,
          homeZip: zip,
          payFrequency: "4",         // Monthly
          nextPayDay: "05/01/2026",
          cellPhone: phone,
        };

        const gigfiResult = await submitToGigFi(leadData, lead.appId);

        storage.saveGigFiResult(lead.appId, gigfiResult.status, gigfiResult.decisionId, gigfiResult.redirectUrl)
          .catch(err => console.error("[GIGFI-CSV] Failed to save result:", err));

        results.push({
          appId: lead.appId,
          name: fullName,
          email: lead.email,
          status: "SUBMITTED",
          gigfiStatus: gigfiResult.status,
          redirectUrl: gigfiResult.redirectUrl,
          decisionId: gigfiResult.decisionId,
          skippedReason: gigfiResult.errorMessage,
        });
      } catch (err: any) {
        results.push({ appId: lead.appId, name: fullName, email: lead.email, status: "ERROR", skippedReason: err.message });
      }
    }

    const submitted = results.filter(r => r.status === "SUBMITTED");
    const accepted = submitted.filter(r => r.gigfiStatus === "ACCEPTED");
    const rejected = submitted.filter(r => r.gigfiStatus === "REJECTED");
    const skipped = results.filter(r => r.status !== "SUBMITTED");

    res.json({
      summary: { total: leads.length, submitted: submitted.length, accepted: accepted.length, rejected: rejected.length, skipped: skipped.length },
      results,
    });
  });

  // ========================================
  // UNDERWRITING PORTAL ROUTES
  // ========================================

  // Auth guard for underwriting routes
  const requireUnderwriting = (req: Request, res: Response, next: NextFunction) => {
    if (!req.session.user?.isAuthenticated) return res.status(401).json({ error: "Authentication required" });
    if (req.session.user.role !== 'underwriting' && req.session.user.role !== 'admin') {
      return res.status(403).json({ error: "Underwriting access required" });
    }
    next();
  };

  // GET /api/underwriting/queue — files needing review: statements uploaded in past 30 days,
  // not already resolved (approved/declined/unqualified decision within past 30 days)
  app.get("/api/underwriting/queue", requireUnderwriting, async (_req: Request, res: Response) => {
    try {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      // Statuses that mean the file has been resolved for this cycle
      const TERMINAL_STATUSES = new Set(['approved', 'declined', 'unqualified']);

      const [allUploads, allDecisions, allApps] = await Promise.all([
        storage.getAllBankStatementUploads(),
        storage.getAllBusinessUnderwritingDecisions(),
        storage.getAllLoanApplications(),
      ]);

      // Filter to bank statements uploaded within the past 30 days only
      const recentUploads = allUploads.filter(u => {
        const uploadDate = u.receivedAt || u.createdAt;
        return uploadDate && new Date(uploadDate) >= thirtyDaysAgo;
      });

      // Group recent uploads by email
      const uploadsByEmail = new Map<string, typeof allUploads>();
      for (const u of recentUploads) {
        const key = u.email.toLowerCase();
        if (!uploadsByEmail.has(key)) uploadsByEmail.set(key, []);
        uploadsByEmail.get(key)!.push(u);
      }

      // Build queue items — include ALL files with statements (no terminal-decision filter)
      // allDecisions is ordered updatedAt DESC so [0] is the most recent per email
      const queue = Array.from(uploadsByEmail.entries())
        .map(([email, uploads]) => {
          const app = allApps.find(a => a.email.toLowerCase() === email);
          const decisions = allDecisions.filter(d => d.businessEmail?.toLowerCase() === email);
          // Most recent decision (allDecisions sorted updatedAt DESC)
          const latestDecision = decisions.length > 0 ? decisions[0] : null;

          return {
            email,
            businessName: app?.legalBusinessName || app?.businessName || uploads[0]?.businessName || email,
            fullName: app?.fullName || null,
            phone: app?.phone || null,
            state: app?.state || null,
            industry: app?.industry || null,
            requestedAmount: app?.requestedAmount || null,
            creditScore: app?.creditScore || app?.ficoScoreExact || null,
            timeInBusiness: app?.timeInBusiness || null,
            monthlyRevenue: app?.monthlyRevenue || app?.averageMonthlyRevenue || null,
            agentName: app?.agentName || null,
            agentEmail: app?.agentEmail || null,
            applicationId: app?.id || null,
            statementCount: uploads.length,
            latestUploadAt: uploads.reduce((latest, u) => {
              const d = (u.receivedAt || u.createdAt) ? new Date((u.receivedAt || u.createdAt)!).getTime() : 0;
              return d > latest ? d : latest;
            }, 0),
            hasDecision: !!latestDecision,
            decisionStatus: latestDecision?.status || null,
            decisionId: latestDecision?.id || null,
            // When the file was submitted to lenders via Shop File
            uwSubmittedAt: (app as any)?.uwSubmittedAt || null,
          };
        });

      // Sort by latest upload date descending (oldest uploads rise to the top of urgency)
      queue.sort((a, b) => b.latestUploadAt - a.latestUploadAt);

      res.json(queue);
    } catch (err: any) {
      console.error("[UNDERWRITING] queue error:", err);
      res.status(500).json({ error: "Failed to load underwriting queue" });
    }
  });

  // GET /api/underwriting/file/:email — full file details for underwriter review
  app.get("/api/underwriting/file/:email", requireUnderwriting, async (req: Request, res: Response) => {
    try {
      const email = decodeURIComponent(req.params.email).toLowerCase();

      const [application, uploads, decisions, lenderApprovals, snapshotRow] = await Promise.all([
        storage.getLoanApplicationByEmail(email),
        storage.getBankStatementUploadsByEmail(email),
        storage.getBusinessUnderwritingDecisionsByEmail(email),
        storage.getLenderApprovalsByBusinessEmail(email),
        db.execute(sql`SELECT snapshot, ran_at, ran_by, files_processed FROM underwriting_snapshots WHERE email = ${email} LIMIT 1`).catch(() => ({ rows: [] })),
      ]);

      const savedSnapshot = (snapshotRow as any).rows?.[0] ?? null;

      res.json({
        application: application || null,
        bankStatements: uploads,
        underwritingDecisions: decisions,
        lenderApprovals: lenderApprovals || [],
        savedSnapshot: savedSnapshot ? {
          snapshot: savedSnapshot.snapshot,
          ranAt: savedSnapshot.ran_at,
          ranBy: savedSnapshot.ran_by,
          filesProcessed: savedSnapshot.files_processed,
        } : null,
      });
    } catch (err: any) {
      console.error("[UNDERWRITING] file detail error:", err);
      res.status(500).json({ error: "Failed to load file details" });
    }
  });

  // POST /api/underwriting/shop — send deal to selected lenders with attachments
  app.post("/api/underwriting/shop", requireUnderwriting, async (req: Request, res: Response) => {
    try {
      const {
        email,               // merchant email
        lenderEmails,        // array of { to: string[], cc?: string[], lenderName: string }
        statementIds,        // array of bank statement upload IDs to include
        dealOverview,        // { state, industry, amountSeeking, positionSeeking, outstandingBalance, creditScore, creditLeary, additionalNotes }
        ccReps,              // optional array of rep email addresses to CC on all lender sends
      } = req.body;

      if (!email || !lenderEmails?.length) {
        return res.status(400).json({ error: "Email and at least one lender are required" });
      }

      const normalizedEmail = email.toLowerCase().trim();
      const application = await storage.getLoanApplicationByEmail(normalizedEmail);
      const businessName = application?.legalBusinessName || application?.businessName || normalizedEmail;

      // Generate the same redacted PDF used for underwriting submissions
      const appPdfBuffer = await generateAgentViewRedactedPdfBuffer(application);

      // Gather selected bank statement PDFs
      const attachments: Array<{ filename: string; content: Buffer; mimeType: string }> = [];

      if (appPdfBuffer) {
        attachments.push({
          filename: `Application - ${businessName}.pdf`,
          content: appPdfBuffer,
          mimeType: "application/pdf",
        });
      }

      if (statementIds?.length) {
        for (const stmtId of statementIds) {
          try {
            const upload = await storage.getBankStatementUpload(stmtId);
            if (!upload) continue;
            let fileBuffer: Buffer;
            if (upload.storedFileName?.includes("bank-statements/")) {
              fileBuffer = await objectStorage.getFileBuffer(upload.storedFileName);
            } else {
              const filePath = path.join(UPLOAD_DIR, upload.storedFileName);
              if (fs.existsSync(filePath)) {
                fileBuffer = fs.readFileSync(filePath);
              } else {
                console.warn(`[SHOP] File not found: ${upload.storedFileName}`);
                continue;
              }
            }
            attachments.push({
              filename: upload.originalFileName || `Statement-${stmtId}.pdf`,
              content: fileBuffer,
              mimeType: "application/pdf",
            });
          } catch (stmtErr) {
            console.error(`[SHOP] Error loading statement ${stmtId}:`, stmtErr);
          }
        }
      }

      // Build the deal overview for the email body
      const ov = dealOverview || {};
      const ownerNameVal = ov.ownerName || application?.fullName;
      const timeInBusinessVal = ov.timeInBusiness || application?.timeInBusiness;
      const overviewRows = [
        ownerNameVal ? `<tr><td style="padding:4px 12px;color:#555;font-weight:600;width:180px;">Owner Name:</td><td style="padding:4px 12px;">${ownerNameVal}</td></tr>` : '',
        timeInBusinessVal ? `<tr><td style="padding:4px 12px;color:#555;font-weight:600;">Time in Business:</td><td style="padding:4px 12px;">${timeInBusinessVal}</td></tr>` : '',
        ov.state ? `<tr><td style="padding:4px 12px;color:#555;font-weight:600;">State:</td><td style="padding:4px 12px;">${ov.state}</td></tr>` : '',
        ov.industry ? `<tr><td style="padding:4px 12px;color:#555;font-weight:600;">Industry:</td><td style="padding:4px 12px;">${ov.industry}</td></tr>` : '',
        ov.amountSeeking ? `<tr><td style="padding:4px 12px;color:#555;font-weight:600;">Amount Seeking:</td><td style="padding:4px 12px;">${ov.amountSeeking}</td></tr>` : '',
        ov.positionSeeking ? `<tr><td style="padding:4px 12px;color:#555;font-weight:600;">Position Seeking:</td><td style="padding:4px 12px;">${ov.positionSeeking}</td></tr>` : '',
        ov.outstandingBalance ? `<tr><td style="padding:4px 12px;color:#555;font-weight:600;">Outstanding Balance:</td><td style="padding:4px 12px;">${ov.outstandingBalance}</td></tr>` : '',
        ov.creditScore ? `<tr><td style="padding:4px 12px;color:#555;font-weight:600;">Credit Score:</td><td style="padding:4px 12px;">${ov.creditScore}</td></tr>` : '',
        ov.additionalNotes ? `<tr><td style="padding:4px 12px;color:#555;font-weight:600;">Additional Notes:</td><td style="padding:4px 12px;">${ov.additionalNotes}</td></tr>` : '',
      ].filter(Boolean).join('\n');

      const subject = `NEW DEAL SUBMISSION - ${businessName}`;
      const htmlBody = `
        <div style="font-family:Arial,sans-serif;max-width:600px;">
          <h2 style="color:#1e3a5f;margin-bottom:4px;">NEW DEAL SUBMISSION</h2>
          <p style="color:#555;font-size:14px;margin-top:0;">From Today Capital Group</p>
          <table style="border-collapse:collapse;width:100%;font-size:14px;margin:16px 0;border:1px solid #e0e0e0;border-radius:6px;">
            ${overviewRows}
          </table>
          <p style="font-size:13px;color:#888;">Application and bank statements attached.</p>
        </div>
      `;

      // Always CC these internal addresses on every lender submission
      const ALWAYS_CC = ['dillon@todaycapitalgroup.com', 'admin@todaycapitalgroup.com'];

      // Send to each lender (separate email thread per lender)
      const results: Array<{ lenderName: string; success: boolean; error?: string }> = [];
      for (const lender of lenderEmails) {
        try {
          // Combine all lender emails (to + cc) into the To field so all contacts receive it
          const allLenderEmails = [...(lender.to || []), ...(lender.cc || [])];
          const toAddr = allLenderEmails.join(", ");

          // Build CC list: always-CC addresses + user-selected rep CCs
          const ccSet = new Set<string>(ALWAYS_CC);
          if (Array.isArray(ccReps)) {
            for (const rep of ccReps) {
              if (rep?.trim()) ccSet.add(rep.trim());
            }
          }
          // Remove any CC addresses that are already in To to avoid duplicates
          for (const addr of allLenderEmails) {
            ccSet.delete(addr.toLowerCase());
          }
          const ccAddr = ccSet.size > 0 ? Array.from(ccSet).join(", ") : undefined;

          const success = await gmailService.sendEmailWithAttachments(
            toAddr,
            subject,
            htmlBody,
            attachments,
            ccAddr,
            "Today Capital Group Underwriting <underwriting@todaycapitalgroup.com>",
          );
          results.push({ lenderName: lender.lenderName, success });
          if (success) {
            console.log(`[SHOP] Deal sent to ${lender.lenderName} (${toAddr}) CC: ${ccAddr || 'none'}`);
          }
        } catch (sendErr: any) {
          console.error(`[SHOP] Failed to send to ${lender.lenderName}:`, sendErr);
          results.push({ lenderName: lender.lenderName, success: false, error: sendErr.message });
        }
      }

      // Stamp uw_submitted_at on the loan application if at least one send succeeded
      const anySuccess = results.some(r => r.success);
      if (anySuccess) {
        const normalizedEmail = email.toLowerCase().trim();
        try {
          await db.execute(sql`
            UPDATE loan_applications
            SET uw_submitted_at = NOW()
            WHERE LOWER(email) = ${normalizedEmail}
          `);
          console.log(`[SHOP] Stamped uw_submitted_at for ${normalizedEmail}`);
        } catch (stampErr) {
          console.warn('[SHOP] Failed to stamp uw_submitted_at (non-fatal):', stampErr);
        }

        // Move the SF Opportunity to the Underwriting stage (forward-only, non-fatal)
        promoteOpportunityToUnderwriting(normalizedEmail).catch(err =>
          console.warn('[SHOP] SF stage promotion error (non-fatal):', err.message));

        // Push Deal Qualification fields to Salesforce using shop deal overview (non-fatal)
        syncUwSubmissionToSalesforce(normalizedEmail, application ?? null, { dealOverview: ov }).catch(err =>
          console.warn('[SHOP] SF Deal Qual sync error (non-fatal):', err.message)
        );
      }

      res.json({ success: true, results, attachmentCount: attachments.length });
    } catch (err: any) {
      console.error("[UNDERWRITING] shop error:", err);
      res.status(500).json({ error: "Failed to shop deal" });
    }
  });

  // POST /api/underwriting/request-info — request more info from the sales rep
  app.post("/api/underwriting/request-info", requireUnderwriting, async (req: Request, res: Response) => {
    try {
      const { email, note } = req.body;
      if (!email || !note) return res.status(400).json({ error: "Email and note are required" });

      const normalizedEmail = email.toLowerCase().trim();
      const application = await storage.getLoanApplicationByEmail(normalizedEmail);
      const businessName = application?.legalBusinessName || application?.businessName || normalizedEmail;
      const agentEmail = application?.agentEmail;
      const agentName = application?.agentName || 'Rep';

      if (!agentEmail) {
        return res.status(400).json({ error: "No sales rep on file for this merchant. Cannot send request." });
      }

      const subject = `[More Info Needed] ${businessName}`;
      const html = `
        <div style="font-family:Arial,sans-serif;max-width:600px;">
          <div style="background:#1e3a5f;padding:16px 24px;border-radius:8px 8px 0 0;">
            <h2 style="color:#fff;margin:0;font-size:18px;">Underwriting Request — More Information Needed</h2>
          </div>
          <div style="border:1px solid #e0e0e0;border-top:none;padding:20px 24px;border-radius:0 0 8px 8px;">
            <p style="font-size:14px;color:#333;">Hi ${agentName},</p>
            <p style="font-size:14px;color:#333;">Our underwriting team needs additional information for the following file before we can proceed:</p>
            <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px;">
              <tr><td style="padding:6px 12px;font-weight:600;color:#555;width:140px;">Business:</td><td style="padding:6px 12px;">${businessName}</td></tr>
              <tr style="background:#f8faff;"><td style="padding:6px 12px;font-weight:600;color:#555;">Email:</td><td style="padding:6px 12px;">${normalizedEmail}</td></tr>
            </table>
            <div style="background:#fffbeb;border:1px solid #fbbf24;border-radius:6px;padding:14px 18px;margin:16px 0;">
              <p style="font-size:13px;font-weight:600;color:#92400e;margin:0 0 6px;">What we need:</p>
              <p style="font-size:14px;color:#333;margin:0;white-space:pre-wrap;">${note}</p>
            </div>
            <p style="font-size:13px;color:#888;margin-top:20px;">— Today Capital Group Underwriting Team</p>
          </div>
        </div>
      `;

      await gmailService.sendEmail(agentEmail, subject, html);
      console.log(`[UNDERWRITING] Info request sent to ${agentEmail} for ${businessName}`);
      res.json({ success: true, sentTo: agentEmail });
    } catch (err: any) {
      console.error("[UNDERWRITING] request-info error:", err);
      res.status(500).json({ error: "Failed to send info request" });
    }
  });

  // POST /api/underwriting/mark-unqualified — mark file as unqualified with reason
  app.post("/api/underwriting/mark-unqualified", requireUnderwriting, async (req: Request, res: Response) => {
    try {
      const { email, note } = req.body;
      if (!email || !note) return res.status(400).json({ error: "Email and note are required" });

      const normalizedEmail = email.toLowerCase().trim();
      const application = await storage.getLoanApplicationByEmail(normalizedEmail);
      const businessName = application?.legalBusinessName || application?.businessName || normalizedEmail;
      const reviewerEmail = req.session.user?.agentEmail || 'underwriting';

      const decision = await storage.createOrUpdateBusinessUnderwritingDecision({
        businessEmail: normalizedEmail,
        businessName,
        status: 'declined',
        declineReason: note,
        reviewedBy: reviewerEmail,
      });

      // Notify the assigned rep if one exists
      const agentEmail = application?.agentEmail;
      if (agentEmail) {
        const agentName = application?.agentName || 'Rep';
        const subject = `[Unqualified] ${businessName}`;
        const html = `
          <div style="font-family:Arial,sans-serif;max-width:600px;">
            <div style="background:#dc2626;padding:16px 24px;border-radius:8px 8px 0 0;">
              <h2 style="color:#fff;margin:0;font-size:18px;">File Marked Unqualified</h2>
            </div>
            <div style="border:1px solid #e0e0e0;border-top:none;padding:20px 24px;border-radius:0 0 8px 8px;">
              <p style="font-size:14px;color:#333;">Hi ${agentName},</p>
              <p style="font-size:14px;color:#333;">The following file has been reviewed and marked as <strong>unqualified</strong> by our underwriting team:</p>
              <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px;">
                <tr><td style="padding:6px 12px;font-weight:600;color:#555;width:140px;">Business:</td><td style="padding:6px 12px;">${businessName}</td></tr>
                <tr style="background:#f8faff;"><td style="padding:6px 12px;font-weight:600;color:#555;">Email:</td><td style="padding:6px 12px;">${normalizedEmail}</td></tr>
              </table>
              <div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:6px;padding:14px 18px;margin:16px 0;">
                <p style="font-size:13px;font-weight:600;color:#991b1b;margin:0 0 6px;">Reason:</p>
                <p style="font-size:14px;color:#333;margin:0;white-space:pre-wrap;">${note}</p>
              </div>
              <p style="font-size:13px;color:#888;margin-top:20px;">— Today Capital Group Underwriting Team</p>
            </div>
          </div>
        `;
        gmailService.sendEmail(agentEmail, subject, html).catch(err =>
          console.error(`[UNDERWRITING] Failed to notify rep about unqualified:`, err)
        );
      }

      console.log(`[UNDERWRITING] ${reviewerEmail} marked ${businessName} as unqualified: ${note}`);

      // Auto-submit to GigFi (async, non-blocking)
      autoSubmitGigFiForUnqualified(decision.id, normalizedEmail).catch(err =>
        console.error('[GIGFI AUTO] Unhandled error:', err)
      );

      res.json({ success: true, decision });
    } catch (err: any) {
      console.error("[UNDERWRITING] mark-unqualified error:", err);
      res.status(500).json({ error: "Failed to mark as unqualified" });
    }
  });

  // GET /api/underwriting/lender-network — return the lender network for the shopping UI
  app.get("/api/underwriting/lender-network", requireUnderwriting, async (_req: Request, res: Response) => {
    const { LENDER_NETWORK } = await import("../shared/lenderNetwork");
    res.json(LENDER_NETWORK);
  });

  // Helper: Generate application PDF as a Buffer (for email attachment)
  /**
   * Generate application PDF in-memory as a Buffer.
   * @param redacted – if true, SSN and DOB are replaced with [REDACTED]
   */
  async function generateApplicationPdfBuffer(application: any, redacted = false): Promise<Buffer | null> {
    if (!application) return null;

    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        const chunks: Buffer[] = [];
        doc.on('data', (chunk: Buffer) => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        const darkNavy = '#1B2E4D';
        const teal = '#5FBFB8';
        const labelColor = '#6B7280';

        // Header
        doc.rect(0, 0, 595, 80).fill('#E8EEF3');
        doc.fillColor(teal).fontSize(20).font('Helvetica-Bold').text('TODAY', 50, 25);
        doc.fillColor(darkNavy).fontSize(20).font('Helvetica-Bold').text('CAPITAL GROUP', 130, 25);
        doc.fillColor(labelColor).fontSize(10).font('Helvetica').text(
          'Date: ' + new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
          420, 30
        );
        doc.fillColor(darkNavy).fontSize(10).font('Helvetica').text('Business Funding Application', 420, 45);

        let y = 100;
        const leftCol = 50;
        const rightCol = 310;
        const fieldW = 230;

        const addSection = (title: string) => {
          if (y > 700) { doc.addPage(); y = 50; }
          doc.fillColor(darkNavy).fontSize(13).font('Helvetica-Bold').text(title, leftCol, y);
          doc.strokeColor(teal).lineWidth(1.5).moveTo(leftCol, y + 16).lineTo(leftCol + 140, y + 16).stroke();
          y += 30;
        };

        const addRow = (label: string, value: string | null | undefined, x: number) => {
          if (y > 750) { doc.addPage(); y = 50; }
          doc.fillColor(labelColor).fontSize(8).font('Helvetica-Bold').text(label, x, y);
          doc.fillColor('#111827').fontSize(10).font('Helvetica').text(value || '—', x, y + 11, { width: fieldW });
          y += 28;
        };

        const addRowPair = (l1: string, v1: string | null | undefined, l2: string, v2: string | null | undefined) => {
          if (y > 750) { doc.addPage(); y = 50; }
          doc.fillColor(labelColor).fontSize(8).font('Helvetica-Bold').text(l1, leftCol, y);
          doc.fillColor('#111827').fontSize(10).font('Helvetica').text(v1 || '—', leftCol, y + 11, { width: fieldW });
          doc.fillColor(labelColor).fontSize(8).font('Helvetica-Bold').text(l2, rightCol, y);
          doc.fillColor('#111827').fontSize(10).font('Helvetica').text(v2 || '—', rightCol, y + 11, { width: fieldW });
          y += 28;
        };

        addSection('Business Information');
        addRowPair('Legal Business Name:', application.legalBusinessName || application.businessName, 'DBA:', application.doingBusinessAs);
        addRowPair('Business Type:', application.businessType, 'Industry:', application.industry);
        addRowPair('EIN:', application.ein, 'Start Date:', application.businessStartDate);
        addRowPair('State of Incorporation:', application.stateOfIncorporation, 'Time in Business:', application.timeInBusiness);
        addRowPair('Company Email:', application.companyEmail || application.businessEmail, 'Website:', application.companyWebsite);
        const bizStreet = application.businessStreetAddress || application.businessAddress;
        const bizCsz = application.businessCsz || [application.city, application.state, application.zipCode].filter(Boolean).join(', ');
        addRowPair('Business Address:', bizStreet, 'City / State / ZIP:', bizCsz);
        const revenue = application.monthlyRevenue || application.averageMonthlyRevenue;
        addRowPair('Requested Amount:', application.requestedAmount ? '$' + Number(application.requestedAmount).toLocaleString() : null, 'Monthly Revenue:', revenue ? '$' + Number(revenue).toLocaleString() : null);
        addRowPair('Credit Cards Processed:', application.doYouProcessCreditCards, 'Bank:', application.bankName);

        addSection('Owner Information');
        addRowPair('Full Name:', application.fullName, 'Ownership %:', application.ownership || application.ownerPercentage);
        addRowPair('Email:', application.email, 'Phone:', application.phone);

        // SSN and DOB: redacted for external submissions, last-4 for internal
        const ssnDisplay = redacted
          ? (application.socialSecurityNumber ? '[REDACTED]' : null)
          : (application.socialSecurityNumber ? '***-**-' + String(application.socialSecurityNumber).slice(-4) : null);
        const dobDisplay = redacted
          ? (application.dateOfBirth ? '[REDACTED]' : null)
          : application.dateOfBirth;
        addRowPair('Date of Birth:', dobDisplay, 'SSN:', ssnDisplay);

        addRowPair('Credit Score:', application.ficoScoreExact || application.personalCreditScoreRange || application.creditScore, 'Best Time to Contact:', application.bestTimeToContact);
        const ownerLine1 = [application.ownerAddress1, application.ownerAddress2].filter(Boolean).join(', ');
        const ownerCsz = application.ownerCsz || [application.ownerCity, application.ownerState, application.ownerZip].filter(Boolean).join(', ');
        addRowPair('Home Address:', ownerLine1 || null, 'City / State / ZIP:', ownerCsz || null);

        if (application.hasOutstandingLoans || application.mcaBalanceAmount) {
          addSection('Outstanding Obligations');
          addRowPair('Has Outstanding Loans:', application.hasOutstandingLoans ? 'Yes' : 'No', 'Outstanding Amount:', application.outstandingLoansAmount ? '$' + Number(application.outstandingLoansAmount).toLocaleString() : null);
          addRowPair('MCA Balance:', application.mcaBalanceAmount ? '$' + Number(application.mcaBalanceAmount).toLocaleString() : null, 'MCA Bank:', application.mcaBalanceBankName);
        }

        addSection('Additional Details');
        addRowPair('Use of Funds:', application.useOfFunds, 'Funding Urgency:', application.fundingUrgency);
        addRowPair('Referral Source:', application.referralSource, 'Agent:', [application.agentName, application.agentEmail].filter(Boolean).join(' — ') || null);
        if (application.signatureDate) {
          addRow('Application Signed:', new Date(application.signatureDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }), leftCol);
        }

        doc.end();
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Server-side replica of the agent view's "Download Redacted PDF"
   * (client/public/ApplicationView.html → downloadPDF(true)). Produces a PDF
   * that looks identical to the jsPDF version: same layout, colors, boxed
   * fields, and signature block. Redacted = merchant email and phone omitted
   * (SSN/DOB stay visible, matching the agent-view redacted output).
   *
   * jsPDF works in millimeters with baseline-positioned text; pdfkit works in
   * points with top-positioned text, so coordinates are mm→pt converted and
   * text is shifted up by the font ascent to match baselines.
   */
  async function generateAgentViewRedactedPdfBuffer(application: any): Promise<Buffer | null> {
    if (!application) return null;

    return new Promise((resolve, reject) => {
      try {
        const MM = 2.83465; // 1mm in PDF points
        const doc = new PDFDocument({ margin: 0, size: 'A4' });
        const chunks: Buffer[] = [];
        doc.on('data', (chunk: Buffer) => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        const darkNavy = '#1B2E4D';
        const teal = '#5FBFB8';
        const labelGray = '#646464';
        const boxBorder = '#C8C8C8';
        const boxFill = '#FAFAFA';

        // Text at a jsPDF-style baseline position (x/y in mm)
        const textAt = (str: string, xMm: number, yMm: number, size: number, opts: { font?: string; color?: string; width?: number } = {}) => {
          doc.font(opts.font || 'Helvetica').fontSize(size).fillColor(opts.color || '#000000');
          const yPt = yMm * MM - size * 0.75; // approximate Helvetica ascent
          doc.text(str, xMm * MM, yPt, { lineBreak: !!opts.width, width: opts.width ? opts.width * MM : undefined });
        };

        // Header (matches jsPDF: light blue-gray band + logo + date)
        doc.rect(0, 0, 210 * MM, 40 * MM).fill('#E8EEF3');
        let logoDrawn = false;
        try {
          const logoPath = path.join(process.cwd(), 'client', 'public', 'assets', 'tcg-logo.png');
          if (fs.existsSync(logoPath)) {
            doc.image(logoPath, 20 * MM, 10 * MM, { width: 60 * MM, height: 18.4 * MM });
            logoDrawn = true;
          }
        } catch { /* fall back to text header */ }
        if (!logoDrawn) {
          textAt('TODAY CAPITAL GROUP', 20, 20, 18, { font: 'Helvetica-Bold', color: darkNavy });
        }
        const dateText = application.updatedAt
          ? new Date(application.updatedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
          : new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
        textAt(`Date: ${dateText}`, 150, 20, 10, { color: darkNavy });

        let yPos = 50; // mm, same starting point as the agent view

        const addSectionHeader = (title: string) => {
          textAt(title, 20, yPos, 14, { font: 'Helvetica-Bold', color: darkNavy });
          doc.strokeColor(teal).lineWidth(0.5 * MM)
            .moveTo(20 * MM, (yPos + 2) * MM).lineTo(60 * MM, (yPos + 2) * MM).stroke();
          yPos += 10;
        };

        const addField = (label: string, value: string | null | undefined, x: number, width: number) => {
          if (yPos > 270) { doc.addPage(); yPos = 20; }
          textAt(label, x, yPos, 9, { font: 'Helvetica-Bold', color: labelGray });
          doc.rect(x * MM, (yPos + 2) * MM, width * MM, 8 * MM)
            .fillAndStroke(boxFill, boxBorder);
          doc.lineWidth(0.57); // jsPDF default ~0.2mm
          textAt(String(value || '—').substring(0, 40), x + 2, yPos + 7, 10);
        };

        // Same value resolution as the agent view page (loadApplicationData)
        const fmtMoney = (v: any) => (v ? `$${parseFloat(v).toLocaleString()}` : '');
        const parseCsz = (csz: string) => {
          const parts = (csz || '').split(',').map((p: string) => p.trim());
          if (parts.length >= 2) {
            const stateZip = parts[1].split(' ').filter(Boolean);
            return { city: parts[0], state: stateZip[0] || '', zip: stateZip[1] || '' };
          }
          return { city: '', state: '', zip: '' };
        };
        let bizCity = application.city || '', bizState = application.state || '', bizZip = application.zipCode || '';
        if (!bizCity && !bizState && !bizZip && application.businessCsz) {
          ({ city: bizCity, state: bizState, zip: bizZip } = parseCsz(application.businessCsz));
        }
        let oCity = application.ownerCity || '', oState = application.ownerState || '', oZip = application.ownerZip || '';
        if (!oCity && !oState && !oZip && application.ownerCsz) {
          ({ city: oCity, state: oState, zip: oZip } = parseCsz(application.ownerCsz));
        }

        // Business Information (identical field order/positions to the agent view)
        addSectionHeader('Business Information');
        addField('Legal Name:', application.legalBusinessName || application.businessName, 20, 85);
        addField('DBA:', application.doingBusinessAs, 110, 85);
        yPos += 13;
        addField('Website:', application.companyWebsite, 20, 85);
        addField('Start Date:', application.businessStartDate, 110, 85);
        yPos += 13;
        addField('EIN:', application.ein, 20, 85);
        addField('Industry:', application.industry, 110, 85);
        yPos += 13;
        addField('Address:', application.businessStreetAddress || application.businessAddress, 20, 85);
        addField('City:', bizCity, 110, 85);
        yPos += 13;
        addField('State:', bizState, 20, 40);
        addField('ZIP:', bizZip, 65, 40);
        addField('State of Inc:', application.stateOfIncorporation, 110, 85);
        yPos += 13;
        addField('Requested Amount:', fmtMoney(application.requestedAmount), 20, 85);
        addField('MCA Balance:', fmtMoney(application.mcaBalanceAmount), 110, 85);
        yPos += 13;
        addField('Credit Cards:', application.doYouProcessCreditCards, 20, 85);
        addField('MCA Bank:', application.mcaBalanceBankName, 110, 85);
        yPos += 20;

        // Owner Information — redacted layout (email and phone omitted)
        addSectionHeader('Owner Information');
        addField('Full Name:', application.fullName, 20, 85);
        addField('SSN:', application.socialSecurityNumber, 110, 85);
        yPos += 13;
        addField('Date of Birth:', application.dateOfBirth, 20, 85);
        addField('FICO Score:', application.personalCreditScoreRange || application.ficoScoreExact || application.creditScore, 110, 85);
        yPos += 13;
        addField('Ownership %:', application.ownerPercentage || application.ownership, 20, 85);
        addField('Home Address:', application.ownerAddress1, 110, 85);
        yPos += 13;
        addField('City:', oCity, 20, 85);
        addField('State:', oState, 110, 40);
        addField('ZIP:', oZip, 155, 40);
        yPos += 25;

        // Signature section — disclosure left, signature right (same as agent view)
        if (application.applicantSignature) {
          if (yPos > 240) { doc.addPage(); yPos = 20; }
          const disclosureText = 'Confirm Application\nBy signing below, each of the listed business and business owner/officer (individually and collectively, "you") authorize Today Capital Group and its representatives, successors, assigns, and designees involved with or acquiring commercial loans or purchases of future receivables, including Merchant Cash Advance transactions (collectively, "Transactions"), to obtain consumer or personal, business, and investigative reports and other information about you. This includes credit card processor statements and bank statements from consumer reporting agencies such as TransUnion, Experian, and Equifax, Identity IQ, and other credit bureaus, banks, creditors, government agencies, and third parties (the "Recipients"). You also authorize Today Capital Group to transmit this application form, along with any obtained information, to any or all of the Recipients for the stated purposes. Furthermore, you consent to any creditor or financial institution releasing information about you to Today Capital Group and the Recipients. You authorize Today Capital Group to communicate with the Recipients on your behalf and represent you in dealings with them. Additionally, you permit Today Capital Group and its Recipients to contact you via text message, automated call, or email using the contact information provided above.';
          textAt(disclosureText, 20, yPos, 7, { color: labelGray, width: 95 });

          const sigY = yPos;
          textAt('Applicant Signature', 120, sigY, 14, { font: 'Helvetica-Bold', color: darkNavy });
          doc.strokeColor(teal).lineWidth(0.5 * MM)
            .moveTo(120 * MM, (sigY + 2) * MM).lineTo(175 * MM, (sigY + 2) * MM).stroke();

          if (String(application.applicantSignature).startsWith('data:image')) {
            // Drawn signature image with a date-only stamp below
            try {
              const base64 = String(application.applicantSignature).split(',')[1];
              const sigBuf = Buffer.from(base64, 'base64');
              doc.image(sigBuf, 120 * MM, (sigY + 8) * MM, { width: 70 * MM, height: 21 * MM });
            } catch (sigErr) {
              console.warn('[SUBMIT-UW] Failed to embed signature image:', sigErr);
            }
            const rawDate = application.signatureDate || application.updatedAt || application.createdAt;
            const signedDate = rawDate
              ? new Date(rawDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
              : new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
            textAt(`Date: ${signedDate}`, 120, sigY + 33, 9, { color: labelGray });
          } else {
            // Checkbox/e-sig — digital consent record with a date-only stamp
            const stampY = sigY + 10;
            const rawDate = application.signatureDate || application.updatedAt || application.createdAt;
            const signedDate = rawDate
              ? new Date(rawDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
              : new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
            textAt(`Digitally Signed by: ${application.fullName || 'Unknown'}`, 120, stampY, 11, { font: 'Helvetica-Bold' });
            textAt(`Date: ${signedDate}`, 120, stampY + 6, 9, { color: labelGray });
            textAt('Electronic Consent Accepted', 120, stampY + 11, 9, { font: 'Helvetica-Oblique', color: labelGray });
          }
        }

        doc.end();
      } catch (err) {
        reject(err);
      }
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // REP STATISTICS ROUTES
  // ══════════════════════════════════════════════════════════════════════════

  const ZOOM_WEBHOOK_SECRET = process.env.ZOOM_WEBHOOK_SECRET || "nZ5tsBsIQYabSHlDeg_qHg";
  const ZOOM_ACCOUNT_ID = process.env.ZOOM_ACCOUNT_ID || "G3A7aGaYQYuc9vsZSziQlw";
  const ZOOM_CLIENT_ID = process.env.ZOOM_CLIENT_ID || "Ja6yklo9RCyOmbu1r4zrkA";
  const ZOOM_CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET || "v3zjmZmAZ5z5DwKD7OVp6ysyhGnydwYD";

  const REP_DIRECTORY: Record<string, string> = {
    "Bryce Jennings": "Bryce@todaycapitalgroup.com",
    "Caden Lehto": "caden@todaycapitalgroup.com",
    "Dennys Cisne": "Dennys@todaycapitalgroup.com",
    "Diego Orellana": "diego@todaycapitalgroup.com",
    "Dillon LeBlanc": "Dillon@todaycapitalgroup.com",
    "Dominic Kendl": "Dominic@todaycapitalgroup.com",
    "Gregory Dergevorkian": "greg@todaycapitalgroup.com",
    "Jonathan Rendon": "jonathan@todaycapitalgroup.com",
    "Julius Speck": "julius@todaycapitalgroup.com",
    "Kenny Nwobi": "Kenny@todaycapitalgroup.com",
    "Ryan Wilcox": "ryan@todaycapitalgroup.com",
  };

  // Reverse lookup: email -> name
  const EMAIL_TO_REP: Record<string, string> = {};
  for (const [name, email] of Object.entries(REP_DIRECTORY)) {
    EMAIL_TO_REP[email.toLowerCase()] = name;
  }
  // Additional Zoom email mappings (aliases, legacy, etc.)
  EMAIL_TO_REP["carlos@todaycapitalgroup.com"] = "Jonathan Rendon";
  EMAIL_TO_REP["kenny@fundorafunding.com"] = "Kenny Nwobi";
  EMAIL_TO_REP["gregory@todaycapitalgroup.com"] = "Greg Dergevorkian";

  // Zoom display name -> dashboard name (for webhook caller/callee name matching)
  const ZOOM_NAME_MAP: Record<string, string> = {
    "Gregory Dergevorkian": "Greg Dergevorkian",
    "Carlos Batista": "Jonathan Rendon",
    "JONATHAN BISCHOP": "Jonathan Rendon",
    "Kenny@fundorafunding.com": "Kenny Nwobi",
  };

  // GET /api/rep-stats — aggregated stats for ALL reps
  app.get("/api/rep-stats", async (_req: Request, res: Response) => {
    try {
      const [allApplications, allDecisions] = await Promise.all([
        storage.getAllLoanApplications(),
        storage.getAllBusinessUnderwritingDecisions(),
      ]);
      let allCalls: any[] = [];
      try { allCalls = await storage.getAllRepCallStats(); } catch { /* table may not exist yet */ }

      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

      // Reps explicitly excluded from the stats page
      const EXCLUDED_REPS = new Set([
        "Tyler Bernie", "Tyler",
        "Manny Fanalua", "Manny",
        "James", "James Atkinson",
        "Jonathan Bishop",
        "Sage", "Sage Robinson",
        "Trevor Bosetti",
        "Greg Dergevorkian", // alias — rolls up into Gregory Dergevorkian
        // First-name-only aliases — all roll up into the canonical full-name entry below
        "Kenny", "Bryce", "Caden", "Dennys", "Diego", "Dillon",
        "Dominic", "Gregory", "Jonathan", "Julius", "Ryan",
      ]);

      // Reverse alias map: stored-name → canonical rep name (for legacy DB records)
      const CALL_NAME_ALIASES: Record<string, string> = {
        "Carlos Batista": "Jonathan Rendon",
        "Greg Dergevorkian": "Gregory Dergevorkian",
        // First-name-only variants stored in legacy DB records
        "Kenny": "Kenny Nwobi",
        "Bryce": "Bryce Jennings",
        "Caden": "Caden Lehto",
        "Dennys": "Dennys Cisne",
        "Diego": "Diego Orellana",
        "Dillon": "Dillon LeBlanc",
        "Dominic": "Dominic Kendl",
        "Gregory": "Gregory Dergevorkian",
        "Jonathan": "Jonathan Rendon",
        "Julius": "Julius Speck",
        "Ryan": "Ryan Wilcox",
      };

      // Build set of known rep names from all sources (excluding blocked reps)
      const repNames = new Set<string>();
      for (const [name] of Object.entries(REP_DIRECTORY)) {
        if (!EXCLUDED_REPS.has(name)) repNames.add(name);
      }
      for (const app of allApplications) {
        if (app.agentName && !EXCLUDED_REPS.has(app.agentName)) repNames.add(app.agentName);
      }
      for (const dec of allDecisions) {
        if (dec.assignedRep && !EXCLUDED_REPS.has(dec.assignedRep)) repNames.add(dec.assignedRep);
      }
      // Only add call-sourced names if they're in REP_DIRECTORY (prevents junk entries
      // like email addresses or company names grabbed from caller ID)
      for (const call of allCalls) {
        const n = call.repName;
        if (n && n !== "Unknown" && REP_DIRECTORY[n] && !EXCLUDED_REPS.has(n)) repNames.add(n);
      }

      const results: any[] = [];

      for (const repName of repNames) {
        const repEmail = REP_DIRECTORY[repName]?.toLowerCase() || "";

        // All stored names that should count toward this rep (includes legacy aliases)
        const aliasNames = Object.entries(CALL_NAME_ALIASES)
          .filter(([, canonical]) => canonical === repName)
          .map(([stored]) => stored);

        // Applications — match canonical name, email, or any legacy alias names
        const repApps = allApplications.filter(a =>
          a.agentName === repName ||
          aliasNames.includes(a.agentName || "") ||
          (repEmail && a.agentEmail?.toLowerCase() === repEmail)
        );
        const applications_count = repApps.length;
        const applications_30d = repApps.filter(a =>
          a.createdAt && new Date(a.createdAt) >= thirtyDaysAgo
        ).length;

        // Decisions — match canonical name or any legacy alias names
        const repDecisions = allDecisions.filter(d =>
          d.assignedRep === repName || aliasNames.includes(d.assignedRep || "")
        );

        const approvedDecisions = repDecisions.filter(d => d.status === "approved");
        const approvals_count = approvedDecisions.length;
        const approvals_amount = approvedDecisions.reduce((sum, d) =>
          sum + (d.advanceAmount ? Number(d.advanceAmount) : 0), 0);

        const fundedDecisions = repDecisions.filter(d => d.status === "funded");
        const funded_count = fundedDecisions.length;
        const funded_amount = fundedDecisions.reduce((sum, d) =>
          sum + (d.advanceAmount ? Number(d.advanceAmount) : 0), 0);

        // Additional fundings across ALL decisions (not just this rep's assigned)
        let additional_funded_count = 0;
        let additional_funded_amount = 0;
        for (const dec of allDecisions) {
          const fundings = Array.isArray(dec.additionalFundings) ? dec.additionalFundings as any[] : [];
          for (const f of fundings) {
            if (f.assignedRep === repName || aliasNames.includes(f.assignedRep || "")) {
              additional_funded_count++;
              additional_funded_amount += f.advanceAmount ? Number(f.advanceAmount) : 0;
            }
          }
        }

        const total_funded_amount = funded_amount + additional_funded_amount;

        const decline_count = repDecisions.filter(d => d.status === "declined").length;

        // Calls — match by email, canonical name, or any legacy alias names
        const repCalls = allCalls.filter(c =>
          (repEmail && c.repEmail?.toLowerCase() === repEmail) ||
          c.repName === repName ||
          aliasNames.includes(c.repName || "")
        );
        const calls_total = repCalls.length;
        const calls_30d = repCalls.filter(c => {
          const callTime = c.startTime || c.createdAt;
          return callTime && new Date(callTime) >= thirtyDaysAgo;
        }).length;
        const calls_today = repCalls.filter(c => {
          const callTime = c.startTime || c.createdAt;
          return callTime && new Date(callTime) >= todayStart;
        }).length;
        // Zoom uses "connected", "answered", and "Call connected" depending on source
        const isConnected = (r: string) => /connected|answered/i.test(r || "");
        const connectedCalls = repCalls.filter(c => isConnected(c.result));
        const calls_connected = connectedCalls.length;
        const calls_duration_total = repCalls.reduce((sum, c) => sum + (c.duration || 0), 0);
        const calls_avg_duration = connectedCalls.length > 0
          ? connectedCalls.reduce((sum, c) => sum + (c.duration || 0), 0) / connectedCalls.length
          : 0;

        // Rates as decimals (0-1) — frontend formatPercent() multiplies by 100
        const conversion_rate = applications_count > 0
          ? funded_count / applications_count : 0;
        const connect_rate = calls_total > 0
          ? calls_connected / calls_total : 0;

        // SCORE (0-100) — weights: apps 15, approvals 20, funded deals 25, volume 15, calls 15, connect 10
        const score = Math.min(100, Math.round(
          Math.min(15, (applications_count / 50) * 15) +
          Math.min(20, (approvals_count / 30) * 20) +
          Math.min(25, (funded_count / 20) * 25) +
          Math.min(15, (total_funded_amount / 500000) * 15) +
          Math.min(15, (calls_total / 500) * 15) +
          Math.min(10, (connect_rate / 0.5) * 10)
        ));

        results.push({
          name: repName,
          email: repEmail,
          applications_count,
          applications_30d,
          approvals_count,
          approvals_amount: Math.round(approvals_amount * 100) / 100,
          funded_count,
          funded_amount: Math.round(funded_amount * 100) / 100,
          additional_funded_count,
          additional_funded_amount: Math.round(additional_funded_amount * 100) / 100,
          total_funded_amount: Math.round(total_funded_amount * 100) / 100,
          decline_count,
          calls_total,
          calls_30d,
          calls_today,
          calls_connected,
          calls_duration_total,
          calls_avg_duration: Math.round(calls_avg_duration),
          conversion_rate: Math.round(conversion_rate * 10000) / 10000,
          connect_rate: Math.round(connect_rate * 10000) / 10000,
          score,
        });
      }

      // Sort by score descending
      results.sort((a, b) => b.score - a.score);

      res.json(results);
    } catch (err: any) {
      console.error("[REP-STATS] Error:", err.message);
      res.status(500).json({ error: "Failed to compute rep stats" });
    }
  });

  // GET /api/rep-stats/calls/recent — 50 most recent calls across all reps
  app.get("/api/rep-stats/calls/recent", async (_req: Request, res: Response) => {
    try {
      let allCalls: any[] = [];
      try { allCalls = await storage.getAllRepCallStats(); } catch { /* table may not exist yet */ }
      const recent = allCalls.slice(0, 50).map(c => ({
        id: c.id,
        rep_name: c.repName,
        rep_email: c.repEmail,
        caller_number: c.callerNumber,
        callee_number: c.calleeNumber,
        caller_name: c.callerName,
        callee_name: c.calleeName,
        direction: c.direction,
        duration: c.duration,
        result: c.result,
        start_time: c.startTime,
        end_time: c.endTime,
        created_at: c.createdAt,
      }));
      res.json(recent);
    } catch (err: any) {
      console.error("[REP-STATS] Error fetching recent calls:", err.message);
      res.status(500).json({ error: "Failed to fetch recent calls" });
    }
  });

  // GET /api/rep-stats/:repName — detailed stats for a single rep
  app.get("/api/rep-stats/:repName", async (req: Request, res: Response) => {
    try {
      const repName = decodeURIComponent(req.params.repName);
      const repEmail = REP_DIRECTORY[repName]?.toLowerCase() || "";

      const [allApplications, allDecisions] = await Promise.all([
        storage.getAllLoanApplications(),
        storage.getAllBusinessUnderwritingDecisions(),
      ]);
      let allCalls: any[] = [];
      try { allCalls = await storage.getAllRepCallStats(); } catch { /* table may not exist yet */ }

      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      // Applications
      const repApps = allApplications.filter(a =>
        a.agentName === repName ||
        (repEmail && a.agentEmail?.toLowerCase() === repEmail)
      );
      const applications_count = repApps.length;
      const applications_30d = repApps.filter(a =>
        a.createdAt && new Date(a.createdAt) >= thirtyDaysAgo
      ).length;

      // Decisions
      const repDecisions = allDecisions.filter(d => d.assignedRep === repName);

      const approvedDecisions = repDecisions.filter(d => d.status === "approved");
      const approvals_count = approvedDecisions.length;
      const approvals_amount = approvedDecisions.reduce((sum, d) =>
        sum + (d.advanceAmount ? Number(d.advanceAmount) : 0), 0);

      const fundedDecisions = repDecisions.filter(d => d.status === "funded");
      const funded_count = fundedDecisions.length;
      const funded_amount = fundedDecisions.reduce((sum, d) =>
        sum + (d.advanceAmount ? Number(d.advanceAmount) : 0), 0);

      let additional_funded_count = 0;
      let additional_funded_amount = 0;
      for (const dec of allDecisions) {
        const fundings = Array.isArray(dec.additionalFundings) ? dec.additionalFundings as any[] : [];
        for (const f of fundings) {
          if (f.assignedRep === repName) {
            additional_funded_count++;
            additional_funded_amount += f.advanceAmount ? Number(f.advanceAmount) : 0;
          }
        }
      }

      const total_funded_amount = funded_amount + additional_funded_amount;
      const decline_count = repDecisions.filter(d => d.status === "declined").length;

      // Calls
      const repCalls = allCalls.filter(c =>
        c.repEmail?.toLowerCase() === repEmail ||
        c.repName === repName
      );
      const calls_total = repCalls.length;
      const calls_30d = repCalls.filter(c => {
        const callTime = c.startTime || c.createdAt;
        return callTime && new Date(callTime) >= thirtyDaysAgo;
      }).length;
      const isConnected = (r: string) => /connected|answered/i.test(r || "");
      const connectedCalls = repCalls.filter(c => isConnected(c.result));
      const calls_connected = connectedCalls.length;
      const calls_duration_total = repCalls.reduce((sum, c) => sum + (c.duration || 0), 0);
      const calls_avg_duration = connectedCalls.length > 0
        ? connectedCalls.reduce((sum, c) => sum + (c.duration || 0), 0) / connectedCalls.length
        : 0;

      // Rates as decimals (0-1) — frontend formatPercent() multiplies by 100
      const conversion_rate = applications_count > 0
        ? funded_count / applications_count : 0;
      const connect_rate = calls_total > 0
        ? calls_connected / calls_total : 0;

      // SCORE — matches frontend computeScoreBreakdown() exactly
      const score = Math.min(100, Math.round(
        Math.min(15, (applications_count / 50) * 15) +
        Math.min(20, (approvals_count / 30) * 20) +
        Math.min(25, (funded_count / 20) * 25) +
        Math.min(15, (total_funded_amount / 500000) * 15) +
        Math.min(15, (calls_total / 500) * 15) +
        Math.min(10, (connect_rate / 0.5) * 10)
      ));

      // Recent items
      const recent_applications = repApps
        .sort((a, b) => new Date(b.createdAt!).getTime() - new Date(a.createdAt!).getTime())
        .slice(0, 10)
        .map(a => ({
          business_name: a.businessName || a.legalBusinessName,
          date: a.createdAt,
          email: a.email,
        }));

      const recent_approvals = approvedDecisions
        .sort((a, b) => new Date(b.updatedAt!).getTime() - new Date(a.updatedAt!).getTime())
        .slice(0, 10)
        .map(d => ({
          business_name: d.businessName,
          amount: d.advanceAmount ? Number(d.advanceAmount) : 0,
          lender: d.lender,
          date: d.updatedAt,
        }));

      const recent_funded = fundedDecisions
        .sort((a, b) => new Date(b.fundedDate || b.updatedAt!).getTime() - new Date(a.fundedDate || a.updatedAt!).getTime())
        .slice(0, 10)
        .map(d => ({
          business_name: d.businessName,
          amount: d.advanceAmount ? Number(d.advanceAmount) : 0,
          lender: d.lender,
          date: d.fundedDate || d.updatedAt,
        }));

      const recent_calls = repCalls
        .slice(0, 20)
        .map(c => ({
          number: c.direction === "outbound" ? c.calleeNumber : c.callerNumber,
          duration: c.duration,
          result: c.result,
          direction: c.direction,
          date: c.startTime || c.createdAt,
        }));

      // Monthly breakdown (last 6 months)
      const monthly_breakdown: any[] = [];
      for (let i = 0; i < 6; i++) {
        const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);
        const label = monthStart.toISOString().slice(0, 7); // YYYY-MM

        const monthApps = repApps.filter(a =>
          a.createdAt && new Date(a.createdAt) >= monthStart && new Date(a.createdAt) <= monthEnd
        ).length;

        const monthApprovals = approvedDecisions.filter(d =>
          d.updatedAt && new Date(d.updatedAt) >= monthStart && new Date(d.updatedAt) <= monthEnd
        ).length;

        const monthFunded = fundedDecisions.filter(d => {
          const dt = d.fundedDate || d.updatedAt;
          return dt && new Date(dt) >= monthStart && new Date(dt) <= monthEnd;
        }).length;

        const monthCalls = repCalls.filter(c =>
          c.createdAt && new Date(c.createdAt) >= monthStart && new Date(c.createdAt) <= monthEnd
        ).length;

        monthly_breakdown.push({
          month: label,
          applications: monthApps,
          approvals: monthApprovals,
          funded: monthFunded,
          calls: monthCalls,
        });
      }

      res.json({
        rep_name: repName,
        rep_email: repEmail,
        applications_count,
        applications_30d,
        approvals_count,
        approvals_amount: Math.round(approvals_amount * 100) / 100,
        funded_count,
        funded_amount: Math.round(funded_amount * 100) / 100,
        additional_funded_count,
        additional_funded_amount: Math.round(additional_funded_amount * 100) / 100,
        total_funded_amount: Math.round(total_funded_amount * 100) / 100,
        decline_count,
        calls_total,
        calls_30d,
        calls_connected,
        calls_duration_total,
        calls_avg_duration: Math.round(calls_avg_duration),
        conversion_rate: Math.round(conversion_rate * 10000) / 10000,
        connect_rate: Math.round(connect_rate * 10000) / 10000,
        score,
        recent_applications,
        recent_approvals,
        recent_funded,
        recent_calls,
        monthly_breakdown,
      });
    } catch (err: any) {
      console.error("[REP-STATS] Error:", err.message);
      res.status(500).json({ error: "Failed to compute rep stats for " + req.params.repName });
    }
  });

  // POST /api/webhooks/zoom — Zoom Phone webhook for call events
  app.post("/api/webhooks/zoom", async (req: Request, res: Response) => {
    try {
      const body = req.body;

      // Handle Zoom webhook verification challenge
      if (body?.event === "endpoint.url_validation") {
        const plainToken = body.payload?.plainToken;
        if (!plainToken) {
          return res.status(400).json({ error: "Missing plainToken" });
        }
        const encryptedToken = createHmac("sha256", ZOOM_WEBHOOK_SECRET)
          .update(plainToken)
          .digest("hex");
        console.log("[ZOOM-WEBHOOK] Responding to URL validation challenge");
        return res.status(200).json({ plainToken, encryptedToken });
      }

      // Handle call ended events
      const eventType = body?.event;
      if (eventType === "phone.callee_ended" || eventType === "phone.caller_ended") {
        const payload = body.payload || {};
        const callObj = payload.object || {};

        const callId = callObj.call_id || callObj.id || randomUUID();
        const direction = callObj.direction || (eventType === "phone.caller_ended" ? "outbound" : "inbound");
        const duration = callObj.duration || 0;
        const callerNumber = callObj.caller?.phone_number || callObj.caller_number || "";
        const calleeNumber = callObj.callee?.phone_number || callObj.callee_number || "";
        const callerName = callObj.caller?.name || callObj.caller_name || "";
        const calleeName = callObj.callee?.name || callObj.callee_name || "";
        const result = callObj.result || callObj.answer_result || "unknown";
        const startTime = callObj.date_time ? new Date(callObj.date_time) : null;
        const endTime = callObj.end_date_time ? new Date(callObj.end_date_time) : null;
        const zoomUserId = callObj.user_id || payload.account_id || "";
        const zoomUserEmail = callObj.user?.email || callObj.email || "";

        // Map Zoom user email to rep, then check name map for display name corrections
        let repName = EMAIL_TO_REP[zoomUserEmail.toLowerCase()] || callerName || calleeName || "Unknown";
        if (ZOOM_NAME_MAP[repName]) repName = ZOOM_NAME_MAP[repName];
        const repEmail = zoomUserEmail || REP_DIRECTORY[repName]?.toLowerCase() || "";

        const statId = `zoom-${callId}-${Date.now()}`;

        try {
          await storage.insertRepCallStat({
            id: statId,
            repName,
            repEmail: repEmail.toLowerCase(),
            callId,
            callType: direction,
            direction,
            duration,
            callerNumber,
            calleeNumber,
            callerName,
            calleeName,
            result,
            startTime,
            endTime,
            recordingUrl: callObj.recording_url || null,
            zoomUserId,
            zoomUserEmail,
            rawPayload: body,
            createdAt: new Date(),
          });
          console.log(`[ZOOM-WEBHOOK] Recorded call ${callId} for ${repName} (${direction}, ${duration}s, result: ${result})`);
        } catch (insertErr: any) {
          console.error(`[ZOOM-WEBHOOK] Failed to insert call stat (table may not exist): ${insertErr.message}`);
        }
      }

      res.status(200).json({ status: "ok" });
    } catch (err: any) {
      console.error("[ZOOM-WEBHOOK] Error processing webhook:", err.message);
      res.status(200).json({ status: "error", message: err.message });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // PIPELINE REPORTS
  // ══════════════════════════════════════════════════════════════════════════

  // POST /api/pipeline-reports — save a pipeline report
  app.post("/api/pipeline-reports", async (req: Request, res: Response) => {
    // Allow Claude API key OR authenticated admin/underwriting session
    const claudeKey = req.headers['x-claude-api-key'];
    const isClaudeAuth = claudeKey === process.env.CLAUDE_API_KEY;
    const isSessionAuth = req.session.user?.isAuthenticated &&
      (req.session.user.role === 'admin' || req.session.user.role === 'underwriting');

    if (!isClaudeAuth && !isSessionAuth) {
      return res.status(403).json({ error: "Not authorized" });
    }

    try {
      const { repName, repEmail, reportDate, reportType, htmlContent, dealCount, highCount, totalValue, dealsData } = req.body;
      if (!repName || !htmlContent) {
        return res.status(400).json({ error: "repName and htmlContent are required" });
      }

      const result = await db.execute(sql`
        INSERT INTO pipeline_reports (rep_name, rep_email, report_date, report_type, html_content, deal_count, high_count, total_value, deals_data)
        VALUES (${repName}, ${repEmail || null}, ${reportDate || new Date().toISOString().slice(0, 10)}, ${reportType || 'daily'}, ${htmlContent}, ${dealCount || 0}, ${highCount || 0}, ${totalValue || 0}, ${dealsData ? JSON.stringify(dealsData) : null}::jsonb)
        RETURNING id
      `);

      const id = (result as any).rows?.[0]?.id;
      console.log(`[PIPELINE-REPORTS] Saved report for ${repName} (id: ${id})`);

      // Fire email to rep (async, non-blocking so the save response returns immediately)
      if (repEmail) {
        sendPipelineReportEmail({
          to: repEmail,
          repName,
          reportDate: reportDate || new Date().toISOString().slice(0, 10),
          reportType: reportType || 'daily',
          htmlContent,
        }).then(emailResult => {
          if (emailResult.sent) {
            console.log(`[PIPELINE-REPORTS] Email sent to ${repEmail} for report ${id}`);
          } else {
            console.warn(`[PIPELINE-REPORTS] Email failed for ${repEmail} (report ${id}): ${emailResult.error}`);
          }
        }).catch(err => {
          console.error(`[PIPELINE-REPORTS] Email error for ${repEmail}:`, err.message);
        });
      }

      res.json({ success: true, id });
    } catch (err: any) {
      console.error("[PIPELINE-REPORTS] Save error:", err.message);
      res.status(500).json({ error: "Failed to save report" });
    }
  });

  // GET /api/pipeline-reports — list reports (with optional filters)
  app.get("/api/pipeline-reports", async (req: Request, res: Response) => {
    if (!req.session.user?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }

    try {
      const { rep, date, type, limit: limitParam } = req.query;
      const lim = Math.min(Number(limitParam) || 50, 200);

      // For agents, force filter to their own name
      const repFilter = req.session.user.role === 'agent' && req.session.user.agentName
        ? req.session.user.agentName
        : (rep && rep !== 'all' ? String(rep) : null);

      const result = await db.execute(sql`
        SELECT id, rep_name, rep_email, report_date, report_type, deal_count, high_count, total_value, created_at
        FROM pipeline_reports
        WHERE (${repFilter}::text IS NULL OR rep_name = ${repFilter})
          AND (${date ? String(date) : null}::text IS NULL OR report_date = ${date ? String(date) : null}::date)
          AND (${type ? String(type) : null}::text IS NULL OR report_type = ${type ? String(type) : null})
        ORDER BY report_date DESC, created_at DESC
        LIMIT ${lim}
      `);
      res.json((result as any).rows || []);
    } catch (err: any) {
      console.error("[PIPELINE-REPORTS] List error:", err.message);
      res.status(500).json({ error: "Failed to list reports" });
    }
  });

  // GET /api/pipeline-reports/:id — get a single report (includes HTML)
  app.get("/api/pipeline-reports/:id", async (req: Request, res: Response) => {
    if (!req.session.user?.isAuthenticated) {
      return res.status(401).json({ error: "Authentication required" });
    }

    try {
      const { id } = req.params;
      const result = await db.execute(sql`SELECT * FROM pipeline_reports WHERE id = ${Number(id)}`);
      const report = (result as any).rows?.[0];
      if (!report) return res.status(404).json({ error: "Report not found" });

      // Agents can only view their own
      if (req.session.user.role === 'agent' && req.session.user.agentName &&
          report.rep_name !== req.session.user.agentName) {
        return res.status(403).json({ error: "Access denied" });
      }

      res.json(report);
    } catch (err: any) {
      console.error("[PIPELINE-REPORTS] Get error:", err.message);
      res.status(500).json({ error: "Failed to get report" });
    }
  });

  // ── Ads Leads GHL sync — runs every 2 hours indefinitely ─────────────────
  (function startAdsLeadsPoll() {
    const INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours
    adsSyncState.active = true;
    adsSyncState.nextRunAt = new Date(Date.now() + INTERVAL_MS).toISOString();
    // Run immediately on startup, then repeat every 2 hours
    runAdsLeadsSync().then(() => {
      adsSyncState.nextRunAt = new Date(Date.now() + INTERVAL_MS).toISOString();
    });
    setInterval(async () => {
      await runAdsLeadsSync();
      adsSyncState.nextRunAt = new Date(Date.now() + INTERVAL_MS).toISOString();
    }, INTERVAL_MS);
    console.log("[ADS-SYNC] GHL tag polling started — tag='clicked ads', every 2 hours");
  })();

  // ── /track lead nurture sequence — day 1 / 3 / 7 onboarding emails ──────
  startLeadNurtureScheduler();

  // ── OG meta injection for agent application links ─────────────────────────
  // When email clients crawl /{initials} to build a link preview, they receive
  // index.html with proper og:title / og:description / og:image injected so the
  // link card looks professional and doesn't trigger spam heuristics.
  // Regular browsers receive the same HTML — React boots normally via the module
  // script tags. In development Vite handles the route instead (next() falls
  // through); in production we read the built index.html and patch the head.
  const AGENT_INITIALS_SET = new Set(AGENTS.map((a) => a.initials.toLowerCase()));

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "GET") return next();

    // Match /{2-3 lowercase letters} — agent initials and quiz variants
    const match = req.path.match(/^\/([a-z]{2,3})(\/quiz)?$/);
    if (!match) return next();
    const initials = match[1];
    if (!AGENT_INITIALS_SET.has(initials)) return next();

    const agent = AGENTS.find((a) => a.initials.toLowerCase() === initials);
    const agentFirstName = agent ? agent.name.split(" ")[0] : "a Today Capital Group advisor";
    const canonicalBase = "https://app.todaycapitalgroup.com";
    const canonicalUrl = `${canonicalBase}/${initials}${match[2] || ""}`;

    const ogTitle = "Apply for Business Funding — Today Capital Group";
    const ogDesc = `Get funded in as little as 24–48 hours. ${agentFirstName} will walk you through your options. Complete a short application — it takes about 5 minutes.`;
    const ogImage = `${canonicalBase}/og-preview.svg`;

    const ogTags = `
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="Today Capital Group" />
    <meta property="og:title" content="${ogTitle}" />
    <meta property="og:description" content="${ogDesc}" />
    <meta property="og:image" content="${ogImage}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:url" content="${canonicalUrl}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${ogTitle}" />
    <meta name="twitter:description" content="${ogDesc}" />
    <meta name="twitter:image" content="${ogImage}" />`;

    const isProduction = process.env.NODE_ENV === "production";
    const htmlCandidates = isProduction
      ? [path.join(process.cwd(), "dist", "public", "index.html")]
      : [path.join(process.cwd(), "client", "index.html")];

    for (const htmlPath of htmlCandidates) {
      try {
        let html = fs.readFileSync(htmlPath, "utf-8");
        // Replace the generic og:title (if present) or inject before </head>
        if (html.includes('property="og:title"')) {
          html = html
            .replace(/(<meta property="og:title"[^>]*>)/, `<meta property="og:title" content="${ogTitle}" />`)
            .replace(/(<meta property="og:description"[^>]*>)/, `<meta property="og:description" content="${ogDesc}" />`)
            .replace(/(<meta property="og:url"[^>]*>)/, `<meta property="og:url" content="${canonicalUrl}" />`)
            .replace(/(<meta name="twitter:title"[^>]*>)/, `<meta name="twitter:title" content="${ogTitle}" />`)
            .replace(/(<meta name="twitter:description"[^>]*>)/, `<meta name="twitter:description" content="${ogDesc}" />`);
        } else {
          html = html.replace("</head>", `${ogTags}\n  </head>`);
        }
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        return res.send(html);
      } catch {
        // file not found — fall through to next candidate or Vite
      }
    }
    next();
  });

  return httpServer;
}
