/**
 * Salesforce Sync — creates/updates SF records when a new application is saved.
 *
 * Auth: JWT Bearer Flow using a Connected App + RSA private key.
 * Access tokens are cached for 55 minutes and auto-refreshed via JWT (no refresh token needed).
 * Falls back to SF_ACCESS_TOKEN env var if JWT credentials are not fully configured.
 */

import crypto from "crypto";

const SF_INSTANCE_URL = process.env.SF_INSTANCE_URL;
const SF_LOGIN_URL = process.env.SF_LOGIN_URL || "https://login.salesforce.com";
const SF_CLIENT_ID = process.env.SF_CLIENT_ID || "";
const SF_USERNAME = process.env.SF_USERNAME || "";
// SF_PRIVATE_KEY is stored as base64-encoded PEM to avoid multiline truncation in secrets
const _rawKey = process.env.SF_PRIVATE_KEY || "";
const SF_PRIVATE_KEY = _rawKey.startsWith("-----")
  ? _rawKey.replace(/\\n/g, "\n")
  : Buffer.from(_rawKey, "base64").toString("utf8");

let cachedAccessToken = process.env.SF_ACCESS_TOKEN || "";
let tokenExpiresAt = 0;

// True when JWT Bearer Flow credentials are configured (replaces the old refresh-token check)
const SF_CAN_REFRESH = !!(SF_PRIVATE_KEY && SF_CLIENT_ID && SF_USERNAME);

function base64url(input: string | Buffer): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function buildJwt(): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const claims = base64url(JSON.stringify({
    iss: SF_CLIENT_ID,
    sub: SF_USERNAME,
    aud: SF_LOGIN_URL,
    exp: now + 180,
  }));
  const signingInput = `${header}.${claims}`;
  const sign = crypto.createSign("SHA256");
  sign.update(signingInput);
  const sig = base64url(sign.sign(SF_PRIVATE_KEY));
  return `${signingInput}.${sig}`;
}

async function refreshAccessToken(): Promise<string> {
  if (!SF_CLIENT_ID || !SF_USERNAME || !SF_PRIVATE_KEY) {
    console.warn("[SF Auth] JWT credentials not fully configured — using cached/env token");
    return cachedAccessToken;
  }
  try {
    const jwt = buildJwt();
    const res = await fetch(`${SF_LOGIN_URL}/services/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }),
    });
    const data = await res.json() as any;
    if (data.access_token) {
      cachedAccessToken = data.access_token;
      tokenExpiresAt = Date.now() + 55 * 60 * 1000;
      console.log("[SF Auth] JWT token obtained successfully");
      return cachedAccessToken;
    }
    console.error("[SF Auth] JWT token request failed:", data.error, data.error_description);
    return cachedAccessToken;
  } catch (err: any) {
    console.error("[SF Auth] JWT error:", err.message);
    return cachedAccessToken;
  }
}

export async function getAccessToken(): Promise<string> {
  if (!cachedAccessToken || Date.now() > tokenExpiresAt) {
    return refreshAccessToken();
  }
  return cachedAccessToken;
}

function sfHeaders(token: string) {
  return { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" };
}

async function sfApi(method: string, path: string, body?: object): Promise<{ success: boolean; id?: string; data?: any; error?: string }> {
  try {
    let token = await getAccessToken();
    let res = await fetch(`${SF_INSTANCE_URL}/services/data/v66.0${path}`, {
      method, headers: sfHeaders(token), body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && SF_CAN_REFRESH) {
      tokenExpiresAt = 0;
      token = await refreshAccessToken();
      res = await fetch(`${SF_INSTANCE_URL}/services/data/v66.0${path}`, {
        method, headers: sfHeaders(token), body: body ? JSON.stringify(body) : undefined,
      });
    }
    if (res.status === 204) return { success: true };
    const data = await res.json();
    if (res.ok) return { success: true, id: data.id, data };
    const msg = Array.isArray(data) ? data.map((e: any) => e.message).join("; ") : data.message || JSON.stringify(data);
    return { success: false, error: msg };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

async function sfQuery(soql: string): Promise<any[]> {
  try {
    const token = await getAccessToken();
    const res = await fetch(
      `${SF_INSTANCE_URL}/services/data/v66.0/query?q=${encodeURIComponent(soql)}`,
      { headers: sfHeaders(token) }
    );
    if (res.status === 401 && SF_CAN_REFRESH) {
      tokenExpiresAt = 0;
      const fresh = await refreshAccessToken();
      const retry = await fetch(
        `${SF_INSTANCE_URL}/services/data/v66.0/query?q=${encodeURIComponent(soql)}`,
        { headers: sfHeaders(fresh) }
      );
      return ((await retry.json()) as any).records || [];
    }
    return ((await res.json()) as any).records || [];
  } catch { return []; }
}

const US_STATES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS",
  "KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY",
  "NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC"
]);

function parseNum(v: any): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).replace(/[$,]/g, ""));
  return isNaN(n) ? null : n;
}

function mapCreditScore(v: any): string | null {
  if (!v) return null;
  const n = parseInt(v);
  if (isNaN(n)) return String(v);
  if (n >= 800) return "800+";
  if (n >= 750) return "750-799";
  if (n >= 700) return "700-749";
  if (n >= 650) return "650-699";
  if (n >= 600) return "600-649";
  if (n >= 550) return "550-599";
  if (n >= 500) return "500-549";
  return "Below 500";
}

function mapIndustry(v: any): string | null {
  if (!v) return null;
  const map: Record<string, string> = {
    // Full application / Step2Business values
    "Retail": "Retail",
    "Restaurant/Food Service": "Restaurant",
    "Healthcare": "Healthcare",
    "Construction": "Construction",
    "Professional Services": "Professional Services",
    "Manufacturing": "Manufacturing",
    "Technology": "Technology",
    "Transportation": "Transportation",
    "Real Estate": "Real Estate",
    "Wholesale": "Wholesale",
    "Other": "Other",
    // Quiz / intake form values
    "Restaurants & Food Services": "Restaurant",
    "Health Services": "Healthcare",
    "Utilities and Home Services": "Construction",
    "Hospitality": "Hospitality",
    "Restaurant": "Restaurant",
    // Lowercase variants
    "restaurant": "Restaurant",
    "retail": "Retail",
    "healthcare": "Healthcare",
    "construction": "Construction",
    "transportation": "Transportation",
    "technology": "Technology",
    "manufacturing": "Manufacturing",
  };
  // Return null for unmapped values so SF's restricted picklist isn't violated
  return map[v] ?? null;
}

// Opportunity.Business_Entity_Type__c picklist: Corporation (C-Corp) / (S-Corp),
// LLC, LLP, Non-Profit, Partnership, Sole Proprietorship, Other
function mapEntityType(v: any): string | null {
  if (!v) return null;
  const s = String(v).toLowerCase();
  if (s.includes("llc") || s.includes("limited liability")) return "LLC";
  if (s.includes("llp")) return "LLP";
  if (s.includes("s-corp") || s.includes("s corp")) return "Corporation (S-Corp)";
  if (s.includes("c-corp") || s.includes("c corp") || s === "corporation" || s.includes("inc")) return "Corporation (C-Corp)";
  if (s.includes("non-profit") || s.includes("nonprofit")) return "Non-Profit";
  if (s.includes("partner")) return "Partnership";
  if (s.includes("sole")) return "Sole Proprietorship";
  return null;
}

// Purpose_Of_Funds__c is a restricted picklist. CLC values sometimes arrive
// HTML-encoded ("Marketing &amp; Advertising") or as variants not in the list.
function mapPurpose(v: any): string | null {
  if (!v) return null;
  const s = String(v).replace(/&amp;/g, "&").replace(/&#39;/g, "'").trim();
  const allowed = new Set(["Working Capital", "Expansion", "Equipment Purchase", "Inventory", "Payroll", "Marketing", "Debt Consolidation", "Renovation", "Emergency", "Other"]);
  if (allowed.has(s)) return s;
  const variants: Record<string, string> = {
    "marketing & advertising": "Marketing",
    "marketing and advertising": "Marketing",
    "equipment": "Equipment Purchase",
    "debt refinance": "Debt Consolidation",
    "hiring": "Payroll",
    "hiring/payroll": "Payroll",
  };
  return variants[s.toLowerCase()] || "Other";
}

// Marketing attribution: same field API names exist on Lead AND Opportunity.
function buildAttributionFields(app: Record<string, any>): Record<string, any> {
  const url = (v: any) => {
    const s = (v || "").toString().slice(0, 255);
    return /^https?:\/\//i.test(s) ? s : null;
  };
  return clean({
    UTM_Source__c: app.utmSource || app.utm_source || null,
    UTM_Medium__c: (app.utmMedium || app.utm_medium || "").toString().slice(0, 255) || null,
    UTM_Campaign__c: (app.utmCampaign || app.utm_campaign || "").toString().slice(0, 255) || null,
    UTM_Term__c: (app.utmTerm || app.utm_term || "").toString().slice(0, 255) || null,
    UTM_Content__c: (app.utmContent || app.utm_content || "").toString().slice(0, 255) || null,
    Referrer_URL__c: url(app.referrerUrl || app.referrer_url),
    Landing_Page__c: (app.sourcePage || app.source_page || "").toString().slice(0, 255) || null,
    Google_Click_ID__c: (app.gclid || "").toString().slice(0, 255) || null,
    Facebook_Click_ID__c: (app.fbclid || "").toString().slice(0, 255) || null,
    Microsoft_Click_ID__c: (app.msclkid || "").toString().slice(0, 255) || null,
  });
}

// CLC stores time-in-business as a range; Years_in_Business__c is a number.
// Use a representative midpoint so SF reports/filters stay meaningful.
function mapYearsInBusiness(v: any): number | null {
  if (!v) return null;
  const map: Record<string, number> = {
    "less than 3 months": 0.1,
    "3-5 months": 0.3,
    "6-12 months": 0.75,
    "less than 1 year": 0.5,
    "1-2 years": 1.5,
    "2-5 years": 3.5,
    "more than 5 years": 7,
    "5+ years": 7,
  };
  return map[String(v).toLowerCase().trim()] ?? null;
}

// Normalize CLC date values (Date objects or ISO strings) to YYYY-MM-DD
function sfDate(v: any): string | null {
  if (!v) return null;
  const s = v instanceof Date ? v.toISOString() : String(v);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

// Summarize prior-advance / outstanding-loan answers into the Opp's
// Prior_Advance_Details__c textarea (no dedicated opp fields exist for these).
function buildPriorAdvanceDetails(app: Record<string, any>): string | null {
  const parts: string[] = [];
  const hasLoans = app.hasOutstandingLoans ?? app.has_outstanding_loans;
  const loansAmt = app.outstandingLoansAmount ?? app.outstanding_loans_amount;
  const mcaAmt = app.mcaBalanceAmount ?? app.mca_balance_amount;
  const mcaBank = app.mcaBalanceBankName ?? app.mca_balance_bank_name;
  if (hasLoans !== undefined && hasLoans !== null && hasLoans !== "") parts.push(`Outstanding loans: ${hasLoans}`);
  if (loansAmt) parts.push(`Outstanding balance: $${loansAmt}`);
  if (mcaAmt) parts.push(`MCA balance: $${mcaAmt}`);
  if (mcaBank) parts.push(`MCA funder/bank: ${mcaBank}`);
  return parts.length ? parts.join(" | ").slice(0, 5000) : null;
}

// Every application field that has a writable counterpart on the Opportunity.
// Used by BOTH the update path and the create path so a new opp is born with
// the full application picture, not a minimal stub.
function buildOppFieldsFromApp(app: Record<string, any>, email: string, phone: string, businessName: string): Record<string, any> {
  const state = ((app.state || app.businessState || app.business_state || "") as string).toUpperCase().trim().slice(0, 2);
  const altEmail = (app.businessEmail || app.business_email || app.companyEmail || app.company_email || "") as string;
  return clean({
    Email__c: email || null,
    Phone_Number__c: phone || null,
    Doing_Business_As_DBA__c: app.doingBusinessAs || app.doing_business_as || businessName || null,
    Amount_Requested__c: parseNum(app.requestedAmount || app.requested_amount),
    Monthly_Revenue__c: parseNum(app.monthlyRevenue || app.monthly_revenue || app.averageMonthlyRevenue || app.average_monthly_revenue),
    Personal_Credit_Score_Range__c: mapCreditScore(app.creditScore || app.credit_score || app.personalCreditScoreRange || app.personal_credit_score_range || app.ficoScoreExact || app.fico_score_exact),
    Industry__c: mapIndustry(app.industry),
    Primary_Business_Bank__c: app.bankName || app.bank_name || null,
    Purpose_Of_Funds__c: mapPurpose(app.useOfFunds || app.use_of_funds),
    EIN__c: (app.ein || "").toString().slice(0, 10) || null,
    Business_Start_Date__c: sfDate(app.businessStartDate || app.business_start_date),
    Ownership_Percentage__c: parseNum(app.ownership || app.ownerPercentage || app.owner_percentage),
    ...(US_STATES.has(state) ? { Business_State__c: state } : {}),
    Owner_Date_of_Birth__c: sfDate(app.dateOfBirth || app.date_of_birth),
    Do_You_Process_Credit_Cards__c: ["Yes", "No"].includes(app.doYouProcessCreditCards || app.do_you_process_credit_cards) ? (app.doYouProcessCreditCards || app.do_you_process_credit_cards) : null,
    Business_Entity_Type__c: mapEntityType(app.businessType || app.business_type),
    Years_in_Business__c: mapYearsInBusiness(app.timeInBusiness || app.time_in_business),
    Prior_Advance_Details__c: buildPriorAdvanceDetails(app),
    Signed_Authorization_Date__c: sfDate(app.signatureDate || app.signature_date),
    ...buildAttributionFields(app),
    Lead_Sub_Source__c: app.trackingSource || app.tracking_source || app.sourcePage || app.source_page || null,
    Application_URL__c: app.agentViewUrl || app.agent_view_url || null,
    ...(altEmail && altEmail.toLowerCase() !== (email || "").toLowerCase() && altEmail.includes("@") ? { Alt_Email__c: altEmail } : {}),
  });
}

// Forward-only stage promotion: which stages each sync event may move an opp FROM.
const STAGE_PROMOTIONS: Record<string, Set<string>> = {
  "Intake Completed": new Set(["Application & Docs"]),
  "Application In": new Set(["Application & Docs", "Intake Completed"]),
  "Underwriting": new Set(["Application & Docs", "Intake Completed", "Application In"]),
};

function stagePromotionAllowed(current: string | undefined, desired: string): boolean {
  return !!current && STAGE_PROMOTIONS[desired]?.has(current) === true;
}

function clean(obj: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined && v !== "") result[k] = v;
  }
  return result;
}

/**
 * Stage mapping: dashboard underwriting decision status → SF Opportunity stage.
 */
export function dashboardStatusToSfStage(status: string): string {
  const map: Record<string, string> = {
    approved: "Present Offer",
    declined: "Closed Lost",
    funded: "Closed Won",
    unqualified: "Closed Lost",
  };
  return map[status?.toLowerCase()] || "Application & Docs";
}

/**
 * Auto-compute Pipeline Bucket (Engagement_Status__c) from stage + approval data.
 * Reps can override manually; this sets the default whenever stage changes.
 */
export function computePipelineBucket(stage: string, hasApproval?: boolean): string {
  switch (stage) {
    case "Present Offer":
    case "Contracts Out":
    case "Contracts In":
    case "Final Review":
    case "Negotiate":
      return hasApproval ? "Hot Pipeline" : "Warm Pipeline";
    case "Underwriting":
      return "Underwriting";
    case "Application & Docs":
    case "Intake Completed":
      return "Working";
    case "Renewal Prospecting":
      return "Renewal";
    case "Closed Won":
      return "Closed Won";
    case "Closed Lost":
      return "Closed Lost";
    default:
      return "Working";
  }
}

/**
 * Main sync function — call this after saving a loan_application.
 * UPDATE-ONLY: searches for existing SF Leads and Opportunities by email/phone,
 * updates them with application data. Does NOT create new records.
 */
export async function syncApplicationToSalesforce(app: Record<string, any>): Promise<{ synced: boolean; action?: string; accountId?: string; contactId?: string; oppId?: string; leadId?: string; reason?: string; error?: string }> {
  if (!SF_INSTANCE_URL || (!cachedAccessToken && !SF_CAN_REFRESH)) {
    console.log("[SF Sync] Skipped — no SF credentials configured");
    return { synced: false, reason: "no credentials" };
  }

  try {
    const email = app.email || app.business_email || "";
    const phone = app.phone || "";
    const fullName = app.fullName || app.full_name || "";
    const businessName = app.businessName || app.business_name || app.legalBusinessName || "";
    const state = (app.state || "").toUpperCase().trim();

    if (!email && !phone) {
      return { synced: false, reason: "no email or phone to match" };
    }

    console.log(`[SF Sync] Processing (update-only): ${businessName || fullName || email}`);

    // Full application → "Application In"; completed intake/quiz → "Intake Completed";
    // anything earlier (partial) → "Application & Docs"
    const isFullApp = !!(app.isFullApplicationCompleted || app.is_full_application_completed);
    const isIntakeDone = !!(app.isCompleted || app.is_completed);
    const desiredStage = isFullApp ? "Application In" : isIntakeDone ? "Intake Completed" : "Application & Docs";

    // Application fields to push to both Leads and Opportunities
    const appFields = clean({
      Amount_Requested__c: parseNum(app.requestedAmount || app.requested_amount),
      Monthly_Revenue__c: parseNum(app.monthlyRevenue || app.monthly_revenue),
      Personal_Credit_Score_Range__c: mapCreditScore(app.creditScore || app.credit_score || app.personalCreditScoreRange || app.personal_credit_score_range),
      Primary_Business_Bank__c: app.bankName || app.bank_name || null,
      Purpose_Of_Funds__c: mapPurpose(app.useOfFunds || app.use_of_funds),
    });

    // Additional fields only applicable to Leads
    // (MCA_Balance_Amount__c and Funding_Time_Frame__c exist ONLY on Lead —
    // including them in an Opportunity PATCH fails the entire update.)
    const leadOnlyFields = clean({
      Company: businessName || null,
      Doing_Business_As__c: app.doingBusinessAs || app.doing_business_as || null,
      EIN__c: app.ein || null,
      Industry: mapIndustry(app.industry),
      Business_Start_Date__c: sfDate(app.businessStartDate || app.business_start_date),
      Ownership_Percentage__c: parseNum(app.ownership || app.ownerPercentage || app.owner_percentage),
      Do_You_Process_Credit_Cards__c: app.doYouProcessCreditCards || app.do_you_process_credit_cards || null,
      ...buildAttributionFields(app),
      Application_URL__c: app.agentViewUrl || app.agent_view_url || null,
      MCA_Balance_Amount__c: parseNum(app.mcaBalanceAmount || app.mca_balance_amount),
    });

    // Everything from the application with a writable Opportunity counterpart
    const oppOnlyFields = buildOppFieldsFromApp(app, email, phone, businessName);

    const digits = phone ? phone.replace(/\D/g, "").slice(-10) : "";
    let updated = false;
    let leadId: string | undefined;
    let oppId: string | undefined;

    // --- 1. Search and update existing Lead ---
    let existingLead: any = null;

    if (email) {
      const byEmail = await sfQuery(
        `SELECT Id, Name FROM Lead WHERE Email = '${email.replace(/'/g, "\\'")}' AND IsConverted = false LIMIT 1`
      );
      if (byEmail.length) existingLead = byEmail[0];
    }

    if (!existingLead && digits.length === 10) {
      const byPhone = await sfQuery(
        `SELECT Id, Name FROM Lead WHERE Phone LIKE '%${digits}' AND IsConverted = false LIMIT 1`
      );
      if (byPhone.length) existingLead = byPhone[0];
    }

    if (existingLead) {
      const leadUpdate = clean({ ...appFields, ...leadOnlyFields });
      if (Object.keys(leadUpdate).length > 0) {
        const res = await sfApi("PATCH", `/sobjects/Lead/${existingLead.Id}`, leadUpdate);
        if (res.success) {
          console.log(`[SF Sync] Updated Lead: ${existingLead.Name} (${existingLead.Id}) — ${Object.keys(leadUpdate).length} fields`);
          leadId = existingLead.Id;
          updated = true;
        } else {
          console.log(`[SF Sync] Lead update failed: ${res.error}`);
        }
      }
    }

    // --- 2. Search and update existing Opportunity ---
    // Open opps first, newest first. If only a CLOSED opp matches, this is
    // renewal activity — do NOT update the funded deal; remember its Account
    // so the create path can hang a fresh Opp on the same Account.
    let existingOpp: any = null;
    let renewalAccountId: string | null = null;
    const considerOpp = (opp: any) => {
      if (!opp) return;
      if (opp.IsClosed) {
        renewalAccountId = renewalAccountId || opp.AccountId || null;
      } else {
        existingOpp = opp;
      }
    };

    // Stored SF Opportunity ID from a previous sync wins outright
    const storedOppId = app.sfOpportunityId || app.sf_opportunity_id;
    if (storedOppId) {
      const verify = await sfQuery(`SELECT Id, Name, AccountId, IsClosed, StageName FROM Opportunity WHERE Id = '${String(storedOppId).replace(/'/g, "\\'")}' LIMIT 1`);
      if (verify.length) considerOpp(verify[0]);
      if (!existingOpp && renewalAccountId) {
        // Stored opp is closed — reroute to the newest open opp on the Account
        const open = await sfQuery(`SELECT Id, Name, AccountId, IsClosed, StageName FROM Opportunity WHERE AccountId = '${renewalAccountId}' AND IsClosed = false ORDER BY CreatedDate DESC LIMIT 1`);
        if (open.length) existingOpp = open[0];
      }
    }

    if (!existingOpp && email) {
      const byEmail = await sfQuery(
        `SELECT Id, Name, AccountId, IsClosed, StageName FROM Opportunity WHERE Email__c = '${email.replace(/'/g, "\\'")}' ORDER BY IsClosed ASC, CreatedDate DESC LIMIT 1`
      );
      if (byEmail.length) considerOpp(byEmail[0]);
    }

    if (!existingOpp && digits.length === 10) {
      const byPhone = await sfQuery(
        `SELECT Id, Name, AccountId, IsClosed, StageName FROM Opportunity WHERE Phone_Number__c LIKE '%${digits}' ORDER BY IsClosed ASC, CreatedDate DESC LIMIT 1`
      );
      if (byPhone.length) considerOpp(byPhone[0]);
    }

    // Fallback: Contact email → Account → Opportunity
    if (!existingOpp && email) {
      const byAcctContact = await sfQuery(
        `SELECT Id, Name, AccountId, IsClosed, StageName FROM Opportunity WHERE AccountId IN (SELECT AccountId FROM Contact WHERE Email = '${email.replace(/'/g, "\\'")}') ORDER BY IsClosed ASC, CreatedDate DESC LIMIT 1`
      );
      if (byAcctContact.length) considerOpp(byAcctContact[0]);
    }

    if (existingOpp) {
      const oppUpdate = clean({ ...appFields, ...oppOnlyFields });
      // Promote the stage forward when a full application lands (never demote,
      // never touch opps already past intake stages)
      if (stagePromotionAllowed(existingOpp.StageName, desiredStage)) {
        oppUpdate.StageName = desiredStage;
        console.log(`[SF Sync] Promoting Opp stage: ${existingOpp.StageName} -> ${desiredStage}`);
      }
      if (Object.keys(oppUpdate).length > 0) {
        const res = await sfApi("PATCH", `/sobjects/Opportunity/${existingOpp.Id}`, oppUpdate);
        if (res.success) {
          console.log(`[SF Sync] Updated Opp: ${existingOpp.Name} (${existingOpp.Id}) — ${Object.keys(oppUpdate).length} fields`);
          oppId = existingOpp.Id;
          updated = true;
        } else {
          console.log(`[SF Sync] Opp update failed: ${res.error}`);
        }
      }

      // Also update the parent Account if we have business details
      if (existingOpp.AccountId) {
        const acctUpdate = clean({
          Company_Name__c: businessName || null,
          Doing_Business_As__c: app.doingBusinessAs || app.doing_business_as || null,
          EIN__c: app.ein || null,
          Industry: mapIndustry(app.industry),
          Monthly_Revenue__c: parseNum(app.monthlyRevenue || app.monthly_revenue),
          Primary_Business_Bank__c: app.bankName || app.bank_name || null,
          Phone: phone || null,
          Website: app.companyWebsite || app.company_website || null,
          BillingStreet: app.businessStreetAddress || app.business_street_address || app.businessAddress || app.business_address || null,
          BillingCity: app.city || null,
          ...(US_STATES.has(state) ? { BillingStateCode: state } : {}),
          BillingPostalCode: app.zipCode || app.zip_code || null,
          ...((state || app.city) ? { BillingCountryCode: "US" } : {}),
        });
        if (Object.keys(acctUpdate).length > 0) {
          await sfApi("PATCH", `/sobjects/Account/${existingOpp.AccountId}`, acctUpdate);
        }
      }
    }

    if (updated) {
      if (oppId) {
        await persistSfIds(email, { oppId, accountId: existingOpp?.AccountId, method: "app-sync", created: false });
      }
      return {
        synced: true,
        action: "updated",
        leadId,
        oppId,
        accountId: existingOpp?.AccountId,
      };
    }

    // Auto-create for ALL reps (no longer Dillon-only)
    console.log(`[SF Sync] No existing Lead or Opportunity found — auto-creating SF records for ${businessName || email}`);

    // If we found a Lead earlier, convert it first
    if (existingLead) {
      try {
        const token = await getAccessToken();
        // Convert Lead via SOAP API
        const soapBody = `<?xml version="1.0" encoding="utf-8"?>
          <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:sf="urn:partner.soap.sforce.com">
            <soapenv:Header><sf:SessionHeader><sf:sessionId>${token}</sf:sessionId></sf:SessionHeader></soapenv:Header>
            <soapenv:Body>
              <sf:convertLead><sf:leadConverts>
                <sf:leadId>${existingLead.Id}</sf:leadId>
                <sf:convertedStatus>Qualified</sf:convertedStatus>
                <sf:doNotCreateOpportunity>false</sf:doNotCreateOpportunity>
              </sf:leadConverts></sf:convertLead>
            </soapenv:Body>
          </soapenv:Envelope>`;

        const convRes = await fetch(`${SF_INSTANCE_URL}/services/Soap/u/66.0`, {
          method: "POST",
          headers: { "Content-Type": "text/xml", "SOAPAction": "convertLead" },
          body: soapBody,
        });
        const convText = await convRes.text();

        // Parse SOAP response for IDs
        const getTag = (tag: string) => {
          const m = convText.match(new RegExp(`<${tag}>(.*?)</${tag}>`));
          return m ? m[1] : null;
        };

        const convOppId = getTag("opportunityId");
        const convAcctId = getTag("accountId");
        const convCtId = getTag("contactId");
        const convSuccess = getTag("success") === "true";

        if (convSuccess && convOppId) {
          console.log(`[SF Sync] Converted Lead ${existingLead.Id} → Opp ${convOppId}`);
          await persistSfIds(email, { oppId: convOppId, accountId: convAcctId || undefined, contactId: convCtId || undefined, method: "lead-converted", created: false });
          return {
            synced: true,
            action: "lead-converted",
            leadId: existingLead.Id,
            oppId: convOppId,
            accountId: convAcctId || undefined,
            contactId: convCtId || undefined,
          };
        } else {
          console.log(`[SF Sync] Lead conversion failed, falling through to create`);
        }
      } catch (convErr: any) {
        console.error(`[SF Sync] Lead conversion error: ${convErr.message}`);
      }
    }

    // No Lead to convert — create via the shared path, which reuses an
    // existing Account/Contact (or the closed opp's Account for renewals)
    // before ever minting new ones.
    const createResult = await findOrCreateSfOpportunity({
      email,
      phone,
      businessName,
      fullName,
      stage: desiredStage,
      app,
      ...(renewalAccountId ? { existingAccountId: renewalAccountId } : {}),
    });

    if (!createResult) {
      return { synced: false, error: "find/create failed" };
    }

    console.log(`[SF Sync] ${createResult.created ? "Created" : "Matched"} via ${createResult.method}: Account=${createResult.accountId}, Opp=${createResult.oppId}`);
    return {
      synced: true,
      action: createResult.created ? "created" : "updated",
      accountId: createResult.accountId,
      contactId: createResult.contactId,
      oppId: createResult.oppId,
    };

  } catch (err: any) {
    console.error(`[SF Sync] Error: ${err.message}`);
    return { synced: false, error: err.message };
  }
}

/**
 * Sync a business_underwriting_decision to Salesforce.
 * Updates the linked Opportunity's stage, amounts, and funded details.
 * If no SF Opportunity exists yet, attempts to find one via email/phone.
 */
export async function syncDecisionToSalesforce(decision: Record<string, any>, app?: Record<string, any>): Promise<{ synced: boolean; action?: string; oppId?: string; error?: string; reason?: string }> {
  if (!SF_INSTANCE_URL || (!cachedAccessToken && !SF_CAN_REFRESH)) {
    return { synced: false, error: "no credentials" };
  }

  try {
    const email = decision.business_email || decision.businessEmail || app?.email || "";
    const secondaryEmail = decision.secondary_email || decision.secondaryEmail || app?.business_email || app?.company_email || "";
    const phone = decision.business_phone || decision.businessPhone || app?.phone || "";
    const status = decision.status || "";
    const sfStage = dashboardStatusToSfStage(status);

    console.log(`[SF Decision Sync] ${decision.business_name || email} → status=${status}, sfStage=${sfStage}`);

    // Use the 8-method cascade to find or create the SF Opportunity
    const findResult = await findOrCreateSfOpportunity({
      sfOppId: decision.sf_opportunity_id || decision.sfOpportunityId || app?.sf_opportunity_id || app?.sfOpportunityId,
      ghlOppId: decision.ghl_opportunity_id || decision.ghlOpportunityId,
      email,
      secondaryEmail,
      phone,
      businessName: decision.business_name || decision.businessName || "",
      fullName: app?.full_name || app?.fullName || "",
      stage: sfStage,
      app: app || undefined,
    });

    if (!findResult) {
      console.log("[SF Decision Sync] Could not find or create SF Opportunity — skipping");
      return { synced: false, error: "no matching Opportunity and auto-create failed" };
    }

    const oppId = findResult.oppId;
    if (findResult.created) {
      console.log(`[SF Decision Sync] Auto-created new Opp ${oppId} for ${decision.business_name || email}`);
    }

    // Build update payload based on decision status
    const hasApproval = !!(decision.advance_amount || decision.advanceAmount);
    const updateFields: Record<string, any> = {
      StageName: sfStage,
    };

    // Approval fields
    if (status === "approved" || status === "funded") {
      if (decision.advance_amount || decision.advanceAmount) {
        updateFields.Highest_Approval__c = parseNum(decision.advance_amount || decision.advanceAmount);
      }
      if (decision.factor_rate || decision.factorRate) {
        updateFields.Factor_Rate__c = parseNum(decision.factor_rate || decision.factorRate);
      }
      if (decision.total_payback || decision.totalPayback) {
        updateFields.Payback_Amount__c = parseNum(decision.total_payback || decision.totalPayback);
      }
      if (decision.lender) {
        updateFields.Description = `Lender: ${decision.lender}`;
      }
      if (decision.term) {
        updateFields.Term_Length__c = parseNum(decision.term?.replace?.(/[^\d]/g, ""));
      }
      if (decision.payment_frequency || decision.paymentFrequency) {
        updateFields.Payment_Frequency__c = decision.payment_frequency || decision.paymentFrequency;
      }
    }

    // Funded-specific fields
    if (status === "funded") {
      if (decision.advance_amount || decision.advanceAmount) {
        updateFields.Amount_Funded__c = parseNum(decision.advance_amount || decision.advanceAmount);
      }
      if (decision.funded_date || decision.fundedDate) {
        const fd = new Date(decision.funded_date || decision.fundedDate);
        if (!isNaN(fd.getTime())) {
          updateFields.Funded_Date__c = fd.toISOString().split("T")[0];
          updateFields.CloseDate = fd.toISOString().split("T")[0];
        }
      }
    }

    // Declined/unqualified fields
    if (status === "declined" || status === "unqualified") {
      if (decision.decline_reason || decision.declineReason) {
        updateFields.Declined_Reason__c = decision.decline_reason || decision.declineReason;
      }
      updateFields.CloseDate = new Date().toISOString().split("T")[0];
    }

    // Application-level fields (push whenever we have them)
    if (app) {
      if (app.monthly_revenue || app.monthlyRevenue) updateFields.Monthly_Revenue__c = parseNum(app.monthly_revenue || app.monthlyRevenue);
      if (app.requested_amount || app.requestedAmount) updateFields.Amount_Requested__c = parseNum(app.requested_amount || app.requestedAmount);
      if (app.credit_score || app.creditScore || app.personalCreditScoreRange) {
        updateFields.Personal_Credit_Score_Range__c = mapCreditScore(app.credit_score || app.creditScore || app.personalCreditScoreRange);
      }
      if (app.industry) updateFields.Industry__c = mapIndustry(app.industry);
      if (app.phone) updateFields.Phone_Number__c = app.phone;
      if (app.email) updateFields.Email__c = app.email;
      if (app.businessName || app.business_name) updateFields.Doing_Business_As_DBA__c = app.businessName || app.business_name;
    }

    // Lender name → Funder lookup
    if (decision.lender) {
      const funderAcctId = await getFunderAccountId(decision.lender).catch(() => null);
      if (funderAcctId) updateFields.Funder_Name__c = funderAcctId;
    }

    // Assigned rep → GHL ID (for tracking on the Opp)
    if (decision.ghl_opportunity_id || decision.ghlOpportunityId) {
      updateFields.GHL_Id__c = decision.ghl_opportunity_id || decision.ghlOpportunityId;
    }

    // Clean nulls
    const cleaned = clean(updateFields);

    let res = await sfApi("PATCH", `/sobjects/Opportunity/${oppId}`, cleaned);
    if (!res.success && (cleaned.StageName === "Closed Won" || cleaned.StageName === "Closed Lost")) {
      // Org validation may block the stage flip (e.g. Closed Won requires all
      // Funded Details). Land the data anyway and leave the stage for a rep.
      console.warn(`[SF Decision Sync] ${cleaned.StageName} blocked (${res.error}) — retrying without stage change`);
      const { StageName: _omit, ...withoutStage } = cleaned;
      if (Object.keys(withoutStage).length > 0) {
        res = await sfApi("PATCH", `/sobjects/Opportunity/${oppId}`, withoutStage);
      }
    }
    if (res.success) {
      const action = findResult.created ? "created+updated" : "updated";
      console.log(`[SF Decision Sync] ${action} Opp ${oppId}: stage=${sfStage}, fields=${Object.keys(cleaned).join(",")}, method=${findResult.method}`);

      // Also sync lender submissions for this decision
      await syncLenderSubmissionsToSalesforce(oppId, decision).catch(err =>
        console.error(`[SF Lender Sync] Error (non-fatal): ${err.message}`)
      );

      return { synced: true, action, oppId };
    } else {
      console.error(`[SF Decision Sync] Failed: ${res.error}`);
      return { synced: false, oppId, error: res.error };
    }

  } catch (err: any) {
    console.error(`[SF Decision Sync] Error: ${err.message}`);
    return { synced: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Lender Submission sync — creates/updates Lender_Submission__c records
// ---------------------------------------------------------------------------

// Cache: lender name (lowercased) → SF Account Id
let funderAccountCache: Map<string, string> | null = null;
let funderRecordTypeId: string | null = null;

async function getFunderAccountId(lenderName: string): Promise<string | null> {
  if (!lenderName) return null;

  // Build cache on first call
  if (!funderAccountCache) {
    funderAccountCache = new Map();
    const funders = await sfQuery(
      "SELECT Id, Name FROM Account WHERE RecordType.Name = 'Funder'"
    );
    for (const f of funders) {
      funderAccountCache.set(f.Name.toLowerCase().trim(), f.Id);
    }
    console.log(`[SF Lender Sync] Cached ${funderAccountCache.size} Funder accounts`);
  }

  const key = lenderName.toLowerCase().trim();

  // Exact match
  if (funderAccountCache.has(key)) return funderAccountCache.get(key)!;

  // Fuzzy: check if cache key contains or is contained by the search name
  for (const [cachedName, id] of funderAccountCache) {
    if (cachedName.includes(key) || key.includes(cachedName)) return id;
  }

  // No match — create a new Funder Account
  console.log(`[SF Lender Sync] Creating new Funder account: ${lenderName}`);
  if (!funderRecordTypeId) {
    const rts = await sfQuery(
      "SELECT Id FROM RecordType WHERE SObjectType='Account' AND Name='Funder' AND IsActive=true"
    );
    funderRecordTypeId = rts[0]?.Id || null;
  }

  const newAcct = await sfApi("POST", "/sobjects/Account", clean({
    Name: lenderName,
    ...(funderRecordTypeId ? { RecordTypeId: funderRecordTypeId } : {}),
    Account_Status__c: "Active",
  }));

  if (newAcct.success && newAcct.id) {
    funderAccountCache.set(key, newAcct.id);
    return newAcct.id;
  }
  return null;
}

function mapDecisionStatusToSubmissionStatus(status: string): string {
  const map: Record<string, string> = {
    approved: "Approved",
    declined: "Declined",
    funded: "Approved", // funded deals were approved first
    unqualified: "Declined",
  };
  return map[status?.toLowerCase()] || "Submitted";
}

function parseTermMonths(term: any): number | null {
  if (!term) return null;
  const s = String(term);
  const n = parseInt(s.replace(/[^\d]/g, ""));
  return isNaN(n) ? null : n;
}

/**
 * Sync lender submissions for a decision to SF Lender_Submission__c records.
 * Handles both the primary lender and any additional_approvals.
 */
export async function syncLenderSubmissionsToSalesforce(
  oppId: string,
  decision: Record<string, any>
): Promise<{ created: number; updated: number; errors: number }> {
  const results = { created: 0, updated: 0, errors: 0 };

  // Gather all lender submissions from the decision
  const submissions: Array<{
    lender: string;
    status: string;
    amount: any;
    factorRate: any;
    buyRate?: any;
    term: any;
    declineReason?: string;
    date?: any;
    notes?: string;
    paymentFrequency?: string;
  }> = [];

  // Use additional_approvals as the source of truth when available —
  // it contains per-lender details including the primary (isPrimary: true)
  const additionalApprovals = decision.additional_approvals || decision.additionalApprovals;
  const seenLenders = new Set<string>();

  if (Array.isArray(additionalApprovals) && additionalApprovals.length > 0) {
    for (const aa of additionalApprovals) {
      if (!aa.lender) continue;
      const lenderKey = aa.lender.toLowerCase().trim();
      if (seenLenders.has(lenderKey)) continue;
      seenLenders.add(lenderKey);

      submissions.push({
        lender: aa.lender,
        status: aa.isPrimary ? (decision.status || "approved") : "approved",
        amount: aa.advanceAmount || aa.amount || aa.advance_amount,
        factorRate: aa.factorRate || aa.factor_rate,
        buyRate: aa.buyRate || aa.buy_rate,
        term: aa.term,
        date: aa.approvalDate || aa.approval_date || aa.date || decision.approval_date || decision.approvalDate,
        notes: aa.notes || null,
        paymentFrequency: aa.paymentFrequency || aa.payment_frequency,
        declineReason: aa.declineReason || aa.decline_reason,
      });
    }
  }

  // Fallback: if no additional_approvals, use the top-level decision fields
  if (submissions.length === 0 && decision.lender) {
    submissions.push({
      lender: decision.lender,
      status: decision.status || "approved",
      amount: decision.advance_amount || decision.advanceAmount,
      factorRate: decision.factor_rate || decision.factorRate,
      term: decision.term,
      declineReason: decision.decline_reason || decision.declineReason,
      date: decision.approval_date || decision.approvalDate || decision.created_at || decision.createdAt,
      notes: decision.notes,
      paymentFrequency: decision.payment_frequency || decision.paymentFrequency,
    });
  }

  if (submissions.length === 0) return results;

  // Fetch existing submissions for this Opportunity — include amount and date for content-based dedup
  const existing = await sfQuery(
    `SELECT Id, Name, Offer_Amount__c, Submitted_Date__c, Factor_Rate__c FROM Lender_Submission__c WHERE Opportunity__c = '${oppId}'`
  );

  // Normalize a number for comparison: round to nearest dollar
  const normalizeAmt = (v: any): string => {
    const n = parseNum(v);
    return n !== null ? String(Math.round(n)) : "";
  };

  // Normalize a date string to YYYY-MM-DD for comparison
  const normalizeDate = (v: any): string => {
    if (!v) return "";
    const d = new Date(String(v).includes("T") ? v : v + "T00:00:00");
    return isNaN(d.getTime()) ? "" : d.toISOString().split("T")[0];
  };

  // Map 1: exact content key (lender|amount|date) → SF record Id — used to skip identical re-syncs
  const existingByExactKey = new Map<string, string>();
  // Map 2: lender name → SF record Id — used to update when content changed
  const existingByLender = new Map<string, string>();

  for (const e of existing) {
    const lenderKey = e.Name?.toLowerCase()?.trim() ?? "";
    const amtKey = normalizeAmt(e.Offer_Amount__c);
    const dateKey = normalizeDate(e.Submitted_Date__c);
    const exactKey = `${lenderKey}|${amtKey}|${dateKey}`;
    existingByExactKey.set(exactKey, e.Id);
    // Only store the first lender match (to handle cases where multiple rounds exist for same lender)
    if (!existingByLender.has(lenderKey)) {
      existingByLender.set(lenderKey, e.Id);
    }
  }

  let skipped = 0;

  for (const sub of submissions) {
    try {
      const lenderAccountId = await getFunderAccountId(sub.lender);
      const submissionStatus = mapDecisionStatusToSubmissionStatus(sub.status);
      const subDate = sub.date ? new Date(String(sub.date).includes("T") ? sub.date : sub.date + "T00:00:00") : new Date();
      const dateStr = !isNaN(subDate.getTime()) ? subDate.toISOString().split("T")[0] : null;

      const lenderKey = sub.lender.toLowerCase().trim();
      const amtKey = normalizeAmt(sub.amount);
      const dateKey = dateStr ?? "";
      const exactKey = `${lenderKey}|${amtKey}|${dateKey}`;

      // ── Skip if an SF record already has the exact same lender + amount + date ──
      if (existingByExactKey.has(exactKey)) {
        skipped++;
        console.log(`[SF Lender Sync] Skipping ${sub.lender} on Opp ${oppId} — identical record already exists (amt=${amtKey}, date=${dateKey})`);
        continue;
      }

      const record = clean({
        Opportunity__c: oppId,
        Lender__c: lenderAccountId,
        Status__c: submissionStatus,
        Offer_Amount__c: parseNum(sub.amount),
        Factor_Rate__c: parseNum(sub.factorRate),
        Buy_Rate__c: parseNum(sub.buyRate),
        Term_Months__c: parseTermMonths(sub.term),
        Submitted_Date__c: dateStr,
        Response_Date__c: dateStr,
        Submission_Notes__c: sub.notes || null,
        ...(submissionStatus === "Declined" && sub.declineReason
          ? { Decline_Reason__c: sub.declineReason }
          : {}),
      });

      // ── Update if lender already exists but content changed (e.g. amount was revised) ──
      const existingId = existingByLender.get(lenderKey);

      if (existingId) {
        const res = await sfApi("PATCH", `/sobjects/Lender_Submission__c/${existingId}`, record);
        if (res.success) {
          results.updated++;
          console.log(`[SF Lender Sync] Updated: ${sub.lender} on Opp ${oppId} (amt changed to ${amtKey})`);
        } else {
          results.errors++;
          console.error(`[SF Lender Sync] Update failed for ${sub.lender}: ${res.error}`);
        }
      } else {
        // ── Create new entry for this lender ──
        const createRecord = { ...record, Name: sub.lender };
        const res = await sfApi("POST", "/sobjects/Lender_Submission__c", createRecord);
        if (res.success) {
          results.created++;
          console.log(`[SF Lender Sync] Created: ${sub.lender} on Opp ${oppId}`);
        } else {
          results.errors++;
          console.error(`[SF Lender Sync] Create failed for ${sub.lender}: ${res.error}`);
        }
      }
    } catch (err: any) {
      results.errors++;
      console.error(`[SF Lender Sync] Error for ${sub.lender}: ${err.message}`);
    }
  }

  console.log(`[SF Lender Sync] Done: ${results.created} created, ${results.updated} updated, ${skipped} skipped (identical), ${results.errors} errors`);
  return results;
}

// ─── 8-Method Opportunity Finder + Auto-Create ───────────────────────────────


interface FindOppResult {
  oppId: string;
  accountId?: string;
  contactId?: string;
  method: string;        // which search method found it
  created: boolean;      // true if we created a new Opp
}

/**
 * Exhaustive 8-method search for a matching SF Opportunity.
 * If no match is found, auto-creates Account + Contact + Opportunity.
 *
 * Search cascade:
 * 1. Pre-stored SF Opportunity ID
 * 2. GHL Opportunity ID → SF GHL_Id__c
 * 3. Lead email → ConvertedOpportunityId
 * 4. Lead phone → ConvertedOpportunityId
 * 5. Contact email → Account → Opportunity
 * 6. Contact phone → Account → Opportunity
 * 7. Opp.Email__c / Phone_Number__c custom fields
 * 8. Business name wildcard match
 * → Auto-create if all fail
 */
const OPEN_SF_STAGES = new Set(["Application & Docs", "Intake Completed", "Application In", "Underwriting", "Approved", "Present Offer", "Contracts Out", "Contracts In", "Final Review", "Negotiate", "Renewal Prospecting"]);

// One find/create per merchant at a time — concurrent syncs (app save + snapshot +
// decision firing together) share a single result instead of racing to create dupes.
const inflightFinds = new Map<string, Promise<FindOppResult | null>>();

/**
 * Write the resolved SF IDs back to CLC so the next sync short-circuits on
 * Method 1 instead of re-running the fuzzy search (the root cause of dupes).
 */
async function persistSfIds(email: string | undefined, result: FindOppResult): Promise<void> {
  if (!email || !result.oppId) return;
  try {
    const { neonPool } = await import("../db");
    if (!neonPool) return;
    await neonPool.query(
      `UPDATE loan_applications SET sf_opportunity_id = $1,
         sf_account_id = COALESCE($2, sf_account_id),
         sf_contact_id = COALESCE($3, sf_contact_id),
         sf_synced_at = NOW()
       WHERE LOWER(email) = $4`,
      [result.oppId, result.accountId || null, result.contactId || null, email.toLowerCase().trim()]
    );
    await neonPool.query(
      `UPDATE business_underwriting_decisions SET sf_opportunity_id = $1 WHERE LOWER(business_email) = $2`,
      [result.oppId, email.toLowerCase().trim()]
    );
  } catch (e: any) {
    console.error(`[SF Find] persist IDs failed (non-fatal): ${e.message}`);
  }
}

async function findOrCreateSfOpportunity(params: {
  sfOppId?: string;
  ghlOppId?: string;
  email?: string;
  secondaryEmail?: string;
  phone?: string;
  businessName?: string;
  fullName?: string;
  stage?: string;
  app?: Record<string, any>;
  existingAccountId?: string;
}): Promise<FindOppResult | null> {
  if (!SF_INSTANCE_URL || (!cachedAccessToken && !SF_CAN_REFRESH)) return null;

  const key = (params.email || params.phone || params.businessName || "").toLowerCase().trim();
  if (key && inflightFinds.has(key)) return inflightFinds.get(key)!;

  const promise = doFindOrCreateSfOpportunity(params)
    .then(async (result) => {
      if (result) await persistSfIds(params.email, result);
      return result;
    })
    .finally(() => { if (key) inflightFinds.delete(key); });

  if (key) inflightFinds.set(key, promise);
  return promise;
}

async function doFindOrCreateSfOpportunity(params: {
  sfOppId?: string;
  ghlOppId?: string;
  email?: string;
  secondaryEmail?: string;
  phone?: string;
  businessName?: string;
  fullName?: string;
  stage?: string;
  app?: Record<string, any>;
  existingAccountId?: string;
}): Promise<FindOppResult | null> {
  const { sfOppId, ghlOppId, email, secondaryEmail, phone, businessName } = params;
  const safeEmail = (email || "").replace(/'/g, "\\'").toLowerCase().trim();
  const safeEmail2 = (secondaryEmail || "").replace(/'/g, "\\'").toLowerCase().trim();
  const digits = (phone || "").replace(/\D/g, "").slice(-10);
  const safeBizName = (businessName || "").replace(/'/g, "\\'").slice(0, 80);

  // Syncs targeting an open stage represent NEW deal activity. Renewal rule:
  // if the matched opp is already closed (funded/lost), route to the newest
  // OPEN opp on the same Account — or create a fresh one under that Account.
  const targetOpen = !params.stage || OPEN_SF_STAGES.has(params.stage);
  const resolveCandidate = async (opp: { Id: string; AccountId?: string; IsClosed?: boolean }, method: string): Promise<FindOppResult | null> => {
    if (targetOpen && opp.IsClosed && opp.AccountId) {
      const open = await sfQuery(
        `SELECT Id, AccountId FROM Opportunity WHERE AccountId = '${opp.AccountId}' AND IsClosed = false ORDER BY CreatedDate DESC LIMIT 1`
      );
      if (open.length) {
        console.log(`[SF Find] ${method}: matched closed Opp ${opp.Id} → rerouted to newest open Opp ${open[0].Id} (renewal)`);
        return { oppId: open[0].Id, accountId: open[0].AccountId, method: `${method}+newest-open`, created: false };
      }
      console.log(`[SF Find] ${method}: matched closed Opp ${opp.Id}, no open Opp on Account — creating renewal Opp on same Account`);
      const created = await autoCreateSfOpportunity({ ...params, existingAccountId: opp.AccountId });
      return created ? { ...created, method: `${method}+renewal-create` } : null;
    }
    return { oppId: opp.Id, accountId: opp.AccountId, method, created: false };
  };
  // Newest open opps first, so post-funding activity maps to the live deal
  const OPP_ORDER = "ORDER BY IsClosed ASC, CreatedDate DESC";

  // ── Method 1: Pre-stored SF Opportunity ID ──
  if (sfOppId) {
    console.log(`[SF Find] Method 1: stored SF Opp ID ${sfOppId}`);
    const verify = await sfQuery(`SELECT Id, AccountId, IsClosed FROM Opportunity WHERE Id = '${sfOppId}' LIMIT 1`);
    if (verify.length) return resolveCandidate(verify[0], "stored-id");
  }

  // ── Method 2: GHL Opportunity ID → SF GHL_Id__c ──
  if (ghlOppId) {
    const byGhl = await sfQuery(`SELECT Id, AccountId, IsClosed FROM Opportunity WHERE GHL_Id__c = '${ghlOppId.replace(/'/g, "\\'")}' ${OPP_ORDER} LIMIT 1`);
    if (byGhl.length) {
      console.log(`[SF Find] Method 2: GHL ID ${ghlOppId} → Opp ${byGhl[0].Id}`);
      return resolveCandidate(byGhl[0], "ghl-id");
    }
  }

  // ── Method 3: Lead email → ConvertedOpportunityId ──
  if (safeEmail) {
    const byLeadEmail = await sfQuery(
      `SELECT ConvertedOpportunityId, ConvertedAccountId, ConvertedContactId FROM Lead WHERE Email = '${safeEmail}' AND IsConverted = true AND ConvertedOpportunityId != null LIMIT 1`
    );
    if (byLeadEmail.length && byLeadEmail[0].ConvertedOpportunityId) {
      console.log(`[SF Find] Method 3: Lead email ${safeEmail} → converted Opp ${byLeadEmail[0].ConvertedOpportunityId}`);
      const verify = await sfQuery(`SELECT Id, AccountId, IsClosed FROM Opportunity WHERE Id = '${byLeadEmail[0].ConvertedOpportunityId}' LIMIT 1`);
      if (verify.length) {
        const resolved = await resolveCandidate(verify[0], "lead-email-converted");
        if (resolved) return { ...resolved, contactId: resolved.contactId || byLeadEmail[0].ConvertedContactId };
      }
    }
  }

  // ── Method 4: Lead phone → ConvertedOpportunityId ──
  if (digits.length === 10) {
    const byLeadPhone = await sfQuery(
      `SELECT ConvertedOpportunityId, ConvertedAccountId, ConvertedContactId FROM Lead WHERE (Phone LIKE '%${digits}' OR MobilePhone LIKE '%${digits}') AND IsConverted = true AND ConvertedOpportunityId != null LIMIT 1`
    );
    if (byLeadPhone.length && byLeadPhone[0].ConvertedOpportunityId) {
      console.log(`[SF Find] Method 4: Lead phone ${digits} → converted Opp ${byLeadPhone[0].ConvertedOpportunityId}`);
      const verify = await sfQuery(`SELECT Id, AccountId, IsClosed FROM Opportunity WHERE Id = '${byLeadPhone[0].ConvertedOpportunityId}' LIMIT 1`);
      if (verify.length) {
        const resolved = await resolveCandidate(verify[0], "lead-phone-converted");
        if (resolved) return { ...resolved, contactId: resolved.contactId || byLeadPhone[0].ConvertedContactId };
      }
    }
  }

  // ── Method 5: Contact email → Account → Opportunity ──
  for (const e of [safeEmail, safeEmail2].filter(Boolean)) {
    // Try Primary_Contact__r.Email first
    const byPrimaryContact = await sfQuery(
      `SELECT Id, AccountId, IsClosed FROM Opportunity WHERE Primary_Contact__r.Email = '${e}' ${OPP_ORDER} LIMIT 1`
    );
    if (byPrimaryContact.length) {
      console.log(`[SF Find] Method 5a: Primary Contact email ${e} → Opp ${byPrimaryContact[0].Id}`);
      return resolveCandidate(byPrimaryContact[0], "contact-email-primary");
    }

    // Then Contact → Account → Opportunity
    const byAcctContact = await sfQuery(
      `SELECT Id, AccountId, IsClosed FROM Opportunity WHERE AccountId IN (SELECT AccountId FROM Contact WHERE Email = '${e}') ${OPP_ORDER} LIMIT 1`
    );
    if (byAcctContact.length) {
      console.log(`[SF Find] Method 5b: Contact email ${e} → Account → Opp ${byAcctContact[0].Id}`);
      return resolveCandidate(byAcctContact[0], "contact-email-account");
    }
  }

  // ── Method 6: Contact phone → Account → Opportunity ──
  if (digits.length === 10) {
    const byContactPhone = await sfQuery(
      `SELECT Id, AccountId, IsClosed FROM Opportunity WHERE AccountId IN (SELECT AccountId FROM Contact WHERE Phone LIKE '%${digits}' OR MobilePhone LIKE '%${digits}') ${OPP_ORDER} LIMIT 1`
    );
    if (byContactPhone.length) {
      console.log(`[SF Find] Method 6: Contact phone ${digits} → Account → Opp ${byContactPhone[0].Id}`);
      return resolveCandidate(byContactPhone[0], "contact-phone-account");
    }
  }

  // ── Method 7: Opp.Email__c / Phone_Number__c custom fields ──
  if (safeEmail) {
    const byOppEmail = await sfQuery(`SELECT Id, AccountId, IsClosed FROM Opportunity WHERE Email__c = '${safeEmail}' ${OPP_ORDER} LIMIT 1`);
    if (byOppEmail.length) {
      console.log(`[SF Find] Method 7a: Opp Email__c ${safeEmail} → ${byOppEmail[0].Id}`);
      return resolveCandidate(byOppEmail[0], "opp-email-field");
    }
  }
  if (digits.length === 10) {
    const byOppPhone = await sfQuery(`SELECT Id, AccountId, IsClosed FROM Opportunity WHERE Phone_Number__c LIKE '%${digits}' ${OPP_ORDER} LIMIT 1`);
    if (byOppPhone.length) {
      console.log(`[SF Find] Method 7b: Opp Phone_Number__c ${digits} → ${byOppPhone[0].Id}`);
      return resolveCandidate(byOppPhone[0], "opp-phone-field");
    }
  }

  // ── Method 8: Business name wildcard match ──
  if (safeBizName && safeBizName.length > 3) {
    // Try Opportunity Name
    const byOppName = await sfQuery(
      `SELECT Id, AccountId, IsClosed FROM Opportunity WHERE Name LIKE '%${safeBizName}%' ${OPP_ORDER} LIMIT 1`
    );
    if (byOppName.length) {
      console.log(`[SF Find] Method 8a: Opp Name matches '${safeBizName}' → ${byOppName[0].Id}`);
      return resolveCandidate(byOppName[0], "biz-name-opp");
    }
    // Try Account Name
    const byAcctName = await sfQuery(
      `SELECT Id, AccountId, IsClosed FROM Opportunity WHERE AccountId IN (SELECT Id FROM Account WHERE Name LIKE '%${safeBizName}%') ${OPP_ORDER} LIMIT 1`
    );
    if (byAcctName.length) {
      console.log(`[SF Find] Method 8b: Account Name matches '${safeBizName}' → ${byAcctName[0].Id}`);
      return resolveCandidate(byAcctName[0], "biz-name-account");
    }
  }

  // ── All 8 methods exhausted → Auto-create ──
  console.log(`[SF Find] All 8 methods exhausted for ${businessName || email || phone} — auto-creating`);
  return autoCreateSfOpportunity(params);
}

/**
 * Creates a new Account + Contact + Opportunity in Salesforce.
 */
async function autoCreateSfOpportunity(params: {
  email?: string;
  phone?: string;
  businessName?: string;
  fullName?: string;
  stage?: string;
  app?: Record<string, any>;
  existingAccountId?: string; // reuse this Account (renewal path) instead of searching/creating
}): Promise<FindOppResult | null> {
  const { email, phone, businessName, fullName, stage, app } = params;
  const state = ((app?.state || app?.ownerState || "").toUpperCase().trim()).slice(0, 2);
  const safeEmail = (email || "").replace(/'/g, "\\'").toLowerCase().trim();
  const digits = (phone || "").replace(/\D/g, "").slice(-10);

  const accountName = (businessName || fullName || email || "Unknown").slice(0, 255);

  // ── Reuse an existing Account before ever creating one. Accounts without
  // Opportunities are invisible to the opp-based search cascade, so without
  // this check every failed sync minted another duplicate Account. ──
  let reuseAccountId: string | null = params.existingAccountId || null;
  let reuseContactId: string | null = null;

  if (!reuseAccountId && safeEmail) {
    const ct = await sfQuery(`SELECT Id, AccountId FROM Contact WHERE Email = '${safeEmail}' AND AccountId != null ORDER BY CreatedDate DESC LIMIT 1`);
    if (ct.length) { reuseAccountId = ct[0].AccountId; reuseContactId = ct[0].Id; }
  }
  if (!reuseAccountId && digits.length === 10) {
    const ct = await sfQuery(`SELECT Id, AccountId FROM Contact WHERE (Phone LIKE '%${digits}' OR MobilePhone LIKE '%${digits}') AND AccountId != null ORDER BY CreatedDate DESC LIMIT 1`);
    if (ct.length) { reuseAccountId = ct[0].AccountId; reuseContactId = ct[0].Id; }
  }
  if (!reuseAccountId && businessName && businessName.trim().length > 3) {
    const acct = await sfQuery(`SELECT Id FROM Account WHERE Name = '${businessName.trim().replace(/'/g, "\\'")}' ORDER BY CreatedDate DESC LIMIT 1`);
    if (acct.length) reuseAccountId = acct[0].Id;
  }
  if (reuseAccountId && !reuseContactId && safeEmail) {
    const ct = await sfQuery(`SELECT Id FROM Contact WHERE AccountId = '${reuseAccountId}' ORDER BY CreatedDate DESC LIMIT 1`);
    if (ct.length) reuseContactId = ct[0].Id;
  }
  if (reuseAccountId) {
    console.log(`[SF Create] Reusing existing Account ${reuseAccountId}${reuseContactId ? ` + Contact ${reuseContactId}` : ""} for ${accountName}`);
  }

  // Get Merchant record type
  const rts = await sfQuery("SELECT Id FROM RecordType WHERE SObjectType='Account' AND Name='Merchant' AND IsActive=true");
  const merchantRtId = rts[0]?.Id;

  // Resolve name — try to avoid using email as name
  let resolvedName = fullName || "";
  if (!resolvedName || resolvedName.includes("@")) {
    try {
      const { neonPool } = await import("../db");
      if (neonPool) {
        const nameResult = await neonPool.query(
          "SELECT first_name, last_name FROM dialer_contacts WHERE LOWER(email) = $1 AND first_name IS NOT NULL AND first_name != '' LIMIT 1",
          [(email || "").toLowerCase()]
        );
        if (nameResult.rows[0]) {
          const fn = nameResult.rows[0].first_name || "";
          const ln = nameResult.rows[0].last_name || "";
          if (fn && !fn.includes("@")) resolvedName = `${fn} ${ln}`.trim();
        }
      }
    } catch {}
  }

  const nameParts = (resolvedName || "").split(/\s+/).filter(p => p && !p.includes("@"));
  const today = new Date();
  const dateStr = `${today.getMonth() + 1}/${today.getDate()}/${String(today.getFullYear()).slice(2)}`;
  const closeDate = new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0];

  // Create Account (only when no existing one could be reused)
  let accountId = reuseAccountId;
  let accountWasCreated = false;
  if (!accountId) {
    const account = clean({
      Name: accountName,
      ...(merchantRtId ? { RecordTypeId: merchantRtId } : {}),
      Company_Name__c: businessName || null,
      Doing_Business_As__c: app?.doingBusinessAs || app?.doing_business_as || null,
      EIN__c: app?.ein || null,
      Industry: mapIndustry(app?.industry),
      Monthly_Revenue__c: parseNum(app?.monthlyRevenue || app?.monthly_revenue),
      Primary_Business_Bank__c: app?.bankName || app?.bank_name || null,
      Phone: phone || null,
      Website: app?.companyWebsite || app?.company_website || null,
      BillingCity: app?.city || null,
      ...(US_STATES.has(state) ? { BillingStateCode: state } : {}),
      BillingPostalCode: app?.zipCode || app?.zip_code || null,
      ...((state || app?.city) ? { BillingCountryCode: "US" } : {}),
      Account_Status__c: "Pending",
    });

    const acctRes = await sfApi("POST", "/sobjects/Account", account);
    if (!acctRes.success) {
      console.error(`[SF Create] Account creation failed: ${acctRes.error}`);
      return null;
    }
    accountId = acctRes.id!;
    accountWasCreated = true;
  }

  // Create Contact (only when the account doesn't already have one)
  let contactId: string | undefined = reuseContactId || undefined;
  if (!contactId) {
    const contact = clean({
      AccountId: accountId,
      FirstName: nameParts[0] || null,
      LastName: nameParts.slice(1).join(" ") || (nameParts[0] ? "Unknown" : businessName || "Unknown"),
      Email: email || null,
      Phone: phone || null,
      Birthdate: sfDate(app?.dateOfBirth || app?.date_of_birth),
      MailingStreet: [app?.ownerAddress1 || app?.owner_address_1, app?.ownerAddress2 || app?.owner_address_2].filter(Boolean).join(", ") || null,
      MailingCity: app?.ownerCity || app?.owner_city || null,
      ...(US_STATES.has(((app?.ownerState || app?.owner_state || "") as string).toUpperCase().trim()) ? { MailingStateCode: ((app?.ownerState || app?.owner_state) as string).toUpperCase().trim(), MailingCountryCode: "US" } : {}),
      MailingPostalCode: app?.ownerZip || app?.owner_zip || null,
      Personal_Credit_Score_Range__c: mapCreditScore(app?.creditScore || app?.credit_score),
    });
    const ctRes = await sfApi("POST", "/sobjects/Contact", contact);
    if (ctRes.success) contactId = ctRes.id;
  }

  // Create Opportunity — ALWAYS in an open stage. Creating directly in Closed
  // Won trips the org's "Funded Details required" validation rule, which is
  // how orphan duplicate Accounts were minted. The caller's follow-up PATCH
  // moves the stage once the funded fields are on the record.
  const requestedStage = stage || "Application & Docs";
  const sfStage = OPEN_SF_STAGES.has(requestedStage) ? requestedStage : "Underwriting";
  const opportunity = clean({
    AccountId: accountId,
    Primary_Contact__c: contactId || null,
    Name: `${accountName} - ${dateStr}`.slice(0, 120),
    StageName: sfStage,
    CloseDate: closeDate,
    // Full application field mapping — a new opp carries everything the app collected
    ...buildOppFieldsFromApp(app || {}, email || "", phone || "", businessName || ""),
    LeadSource: app?.referralSource || app?.referral_source || "Website",
    Revenue_Verified__c: false,
    Bank_Statement_Tampering_Flag__c: false,
  });

  const oppRes = await sfApi("POST", "/sobjects/Opportunity", opportunity);
  if (!oppRes.success) {
    console.error(`[SF Create] Opportunity creation failed: ${oppRes.error}`);
    // Roll back a freshly-minted Account so we never leave orphan duplicates
    // that the opp-based search cascade can't see.
    if (accountWasCreated && accountId) {
      await sfApi("DELETE", `/sobjects/Account/${accountId}`).catch(() => {});
      console.log(`[SF Create] Rolled back orphan Account ${accountId}`);
    }
    return null;
  }

  console.log(`[SF Create] ${accountWasCreated ? "Auto-created" : "Created Opp on existing Account"}: Account=${accountId}, Contact=${contactId || "none"}, Opp=${oppRes.id} (stage=${sfStage})`);
  return {
    oppId: oppRes.id!,
    accountId,
    contactId,
    method: accountWasCreated ? "auto-created" : "created-on-existing-account",
    created: true,
  };
}

/**
 * Move a merchant's open SF Opportunity to the Underwriting stage when their
 * file is submitted to underwriting in CLC. Forward-only: opps already at or
 * past Underwriting are left alone.
 */
export async function promoteOpportunityToUnderwriting(email: string, phone?: string): Promise<{ promoted: boolean; oppId?: string; reason?: string }> {
  if (!SF_INSTANCE_URL || (!cachedAccessToken && !SF_CAN_REFRESH)) return { promoted: false, reason: "no credentials" };
  try {
    const ctx = await getStoredSfContext(email);
    let opp: any = null;
    if (ctx.sfOppId) {
      const rows = await sfQuery(`SELECT Id, StageName, IsClosed FROM Opportunity WHERE Id = '${String(ctx.sfOppId).replace(/'/g, "\\'")}' LIMIT 1`);
      if (rows.length && !rows[0].IsClosed) opp = rows[0];
    }
    if (!opp && email) {
      const rows = await sfQuery(`SELECT Id, StageName, IsClosed FROM Opportunity WHERE Email__c = '${email.replace(/'/g, "\\'")}' AND IsClosed = false ORDER BY CreatedDate DESC LIMIT 1`);
      if (rows.length) opp = rows[0];
    }
    const digits = (phone || ctx.phone || "").replace(/\D/g, "").slice(-10);
    if (!opp && digits.length === 10) {
      const rows = await sfQuery(`SELECT Id, StageName, IsClosed FROM Opportunity WHERE Phone_Number__c LIKE '%${digits}' AND IsClosed = false ORDER BY CreatedDate DESC LIMIT 1`);
      if (rows.length) opp = rows[0];
    }
    if (!opp) return { promoted: false, reason: "no open opportunity found" };
    if (!stagePromotionAllowed(opp.StageName, "Underwriting")) {
      return { promoted: false, oppId: opp.Id, reason: `stage is ${opp.StageName}` };
    }
    const res = await sfApi("PATCH", `/sobjects/Opportunity/${opp.Id}`, { StageName: "Underwriting" });
    if (res.success) {
      console.log(`[SF Sync] Promoted Opp ${opp.Id} to Underwriting (was ${opp.StageName})`);
      return { promoted: true, oppId: opp.Id };
    }
    return { promoted: false, oppId: opp.Id, reason: res.error };
  } catch (err: any) {
    return { promoted: false, reason: err.message };
  }
}

/**
 * Look up CLC-stored SF/GHL IDs + phone + business name for an email, so
 * every sync path can pass them into the cascade — an email mismatch alone
 * must never be enough to trigger a duplicate create.
 */
export async function getStoredSfContext(email: string): Promise<{ sfOppId?: string; ghlOppId?: string; phone?: string; businessName?: string }> {
  const out: { sfOppId?: string; ghlOppId?: string; phone?: string; businessName?: string } = {};
  if (!email) return out;
  try {
    const { neonPool } = await import("../db");
    if (!neonPool) return out;
    const dec = await neonPool.query(
      `SELECT sf_opportunity_id, ghl_opportunity_id, business_phone, business_name
       FROM business_underwriting_decisions WHERE LOWER(business_email) = $1 LIMIT 1`,
      [email.toLowerCase().trim()]
    );
    if (dec.rows[0]) {
      out.sfOppId = dec.rows[0].sf_opportunity_id || undefined;
      out.ghlOppId = dec.rows[0].ghl_opportunity_id || undefined;
      out.phone = dec.rows[0].business_phone || undefined;
      out.businessName = dec.rows[0].business_name || undefined;
    }
    if (!out.sfOppId) {
      const app = await neonPool.query(
        `SELECT sf_opportunity_id, phone, COALESCE(legal_business_name, business_name) AS business_name
         FROM loan_applications WHERE LOWER(email) = $1
         ORDER BY (sf_opportunity_id IS NOT NULL) DESC, created_at DESC LIMIT 1`,
        [email.toLowerCase().trim()]
      );
      if (app.rows[0]) {
        out.sfOppId = out.sfOppId || app.rows[0].sf_opportunity_id || undefined;
        out.phone = out.phone || app.rows[0].phone || undefined;
        out.businessName = out.businessName || app.rows[0].business_name || undefined;
      }
    }
  } catch (e: any) {
    console.error(`[SF Find] stored-ID enrichment failed (non-fatal): ${e.message}`);
  }
  return out;
}

// Backwards-compatible wrapper used by UW submission and AI snapshot sync.
async function findSfOpportunityByEmail(email: string): Promise<{ Id: string; AccountId?: string } | null> {
  if (!email) return null;
  const stored = await getStoredSfContext(email);
  const result = await findOrCreateSfOpportunity({
    sfOppId: stored.sfOppId,
    ghlOppId: stored.ghlOppId,
    email,
    phone: stored.phone,
    businessName: stored.businessName,
    stage: "Application & Docs",
  });
  if (!result) return null;
  return { Id: result.oppId, AccountId: result.accountId };
}

// ─── Value mappers for picklist / numeric SF fields ──────────────────────────

/** Parse "2 years", "18 months", "1 year 6 months" → number of months (double). */
function parseMonths(v: any): number | null {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v).toLowerCase().trim();
  const num = parseNum(s);
  if (num !== null && !s.includes("year") && !s.includes("month")) return num;
  let months = 0;
  const years = s.match(/(\d+\.?\d*)\s*year/);
  const mos   = s.match(/(\d+\.?\d*)\s*month/);
  if (years) months += Math.round(parseFloat(years[1]) * 12);
  if (mos)   months += Math.round(parseFloat(mos[1]));
  return months > 0 ? months : (num !== null ? num : null);
}

/** Map free-text revenue trend → SF picklist value (Increasing | Stable | Declining). */
function mapRevenueTrend(v: any): string | null {
  if (!v) return null;
  const s = String(v).toLowerCase();
  if (s.includes("increas") || s.includes("up") || s.includes("grow")) return "Increasing";
  if (s.includes("declin") || s.includes("decreas") || s.includes("down")) return "Declining";
  if (s.includes("stable") || s.includes("flat") || s.includes("consistent")) return "Stable";
  return null;
}

/** Map worthSubmitting / qualificationTier → SF picklist (Submit | Conditional | Needs Review | Do Not Submit). */
function mapUwRecommendation(worthSubmitting: any, qualificationTier: any): string | null {
  if (worthSubmitting === true)  return "Submit";
  if (worthSubmitting === false) return "Do Not Submit";
  const t = String(qualificationTier || "").toLowerCase();
  if (t.includes("tier 1") || t.includes("strong")) return "Submit";
  if (t.includes("tier 2") || t.includes("moderate")) return "Conditional";
  if (t.includes("tier 3") || t.includes("weak"))    return "Needs Review";
  if (t.includes("tier 4") || t.includes("decline") || t.includes("not")) return "Do Not Submit";
  return null;
}

/** Normalise position string → SF picklist value (1st | 2nd | 3rd | 4th | 5th). */
function mapPosition(v: any): string | null {
  if (!v) return null;
  const s = String(v).toLowerCase().trim();
  const map: Record<string, string> = { "1": "1st", "2": "2nd", "3": "3rd", "4": "4th", "5": "5th",
    "1st": "1st", "2nd": "2nd", "3rd": "3rd", "4th": "4th", "5th": "5th",
    "first": "1st", "second": "2nd", "third": "3rd", "fourth": "4th", "fifth": "5th" };
  return map[s] ?? null;
}

// ─── Deal Qualification sync (called on UW submission / shop file) ─────────────

/**
 * Push Deal Qualification fields to the SF Opportunity when a file is submitted
 * to underwriting. Accepts the application record plus an optional saved AI
 * snapshot and/or the shop-dialog dealOverview object.
 */
export async function syncUwSubmissionToSalesforce(
  email: string,
  application: Record<string, any> | null,
  options?: {
    snapshot?: Record<string, any> | null;
    dealOverview?: Record<string, any> | null;
  }
): Promise<void> {
  if (!SF_INSTANCE_URL || (!cachedAccessToken && !SF_CAN_REFRESH)) return;

  const { snapshot, dealOverview } = options || {};
  const safeEmail = email.toLowerCase().trim();
  const app = application || {};
  const ov = dealOverview || {};
  const snap = snapshot || {};

  // legalBusinessName is the canonical field in loan_applications; fall back
  // to businessName and finally doingBusinessAs so we never use email as name.
  const businessName =
    app.legalBusinessName || app.legal_business_name ||
    app.businessName      || app.business_name       ||
    app.doingBusinessAs   || app.doing_business_as   || null;

  const ownerName =
    app.ownerName  || app.owner_name  ||
    app.fullName   || app.full_name   ||
    app.contactName|| app.contact_name|| null;

  try {
    // Use the full 8-method finder + auto-create so a missing Opp is created
    // rather than silently skipped. Stored IDs first so repeats can't duplicate.
    const stored = await getStoredSfContext(safeEmail);
    const found = await findOrCreateSfOpportunity({
      sfOppId:      app.sfOpportunityId || app.sf_opportunity_id || stored.sfOppId,
      ghlOppId:     stored.ghlOppId,
      email:        safeEmail,
      phone:        app.phone || app.businessPhone || app.business_phone || stored.phone,
      businessName: businessName || stored.businessName || undefined,
      fullName:     ownerName || undefined,
      stage:        "Application & Docs",
      app,
    });

    if (!found) {
      console.log(`[SF UW Sync] Could not find or create Opportunity for ${safeEmail} — skipping`);
      return;
    }

    if (found.created) {
      console.log(`[SF UW Sync] Auto-created Opp ${found.oppId} for ${safeEmail} (method: ${found.method})`);
    } else {
      console.log(`[SF UW Sync] Found Opp ${found.oppId} via method: ${found.method}`);
    }

    // Build a clean Opp Name from the business name (also corrects any existing
    // opps that were previously named with an email address).
    const today = new Date();
    const dateStr = `${today.getMonth() + 1}/${today.getDate()}/${String(today.getFullYear()).slice(2)}`;
    const oppName = businessName
      ? `${businessName} - ${dateStr}`.slice(0, 120)
      : null;

    // Average monthly deposit count from snapshot monthly breakdown
    let avgMonthlyDeposits: number | null = null;
    if (snap.monthlyData?.length) {
      const counts = (snap.monthlyData as any[])
        .map((m: any) => parseNum(m.numDeposits))
        .filter((n): n is number => n !== null);
      if (counts.length) {
        avgMonthlyDeposits = Math.round(counts.reduce((a, b) => a + b, 0) / counts.length);
      }
    }

    const fields = clean({
      // Opp name — uses business name so it's never the raw email
      ...(oppName ? { Name: oppName } : {}),

      // Contact / business identifiers
      Email__c:                 safeEmail,
      Phone_Number__c:          app.phone || app.businessPhone || app.business_phone || null,
      Doing_Business_As_DBA__c: app.doingBusinessAs || app.doing_business_as || app.businessName || app.business_name || null,
      Industry__c:              mapIndustry(app.industry),
      Primary_Business_Bank__c: app.bankName || app.bank_name || null,
      Purpose_Of_Funds__c:      app.useOfFunds || app.use_of_funds || null,
      Funding_Time_Frame__c:    app.fundingUrgency || app.funding_urgency || null,
      LeadSource:               app.referralSource || app.referral_source || null,

      // Deal qualification
      Amount_Requested__c:            parseNum(ov.amountSeeking || app.requestedAmount || app.requested_amount),
      Monthly_Revenue__c:             parseNum(
        snap.avgMonthlyRevenue        ||
        app.averageMonthlyRevenue     || app.average_monthly_revenue ||
        app.monthlyRevenue            || app.monthly_revenue
      ),
      Personal_Credit_Score_Range__c: mapCreditScore(
        ov.creditScore        ||
        app.creditScore       || app.credit_score ||
        app.personalCreditScoreRange  || app.personal_credit_score_range
      ),
      Time_in_Business_Months__c:     parseMonths(ov.timeInBusiness || app.timeInBusiness || app.time_in_business),

      // Position — picklist field, requires exact value
      Position__c: mapPosition(ov.positionSeeking),

      // Bank-analysis fields (from saved AI snapshot, if available)
      Average_Daily_Balance__c:     parseNum(snap.avgDailyBalance),
      Monthly_Deposit_Count__c:     avgMonthlyDeposits,
      Number_of_NSFs_Overdrafts__c: snap.nsfCount != null ? Number(snap.nsfCount) : null,
      Revenue_Trend__c:             mapRevenueTrend(snap.revenueTrend),
      Total_Monthly_Debt__c:        parseNum(snap.totalMonthlyDebtPayments),
      Factor_Rate__c:               parseNum(snap.estimatedFactor),
    });

    if (Object.keys(fields).length === 0) return;

    const res = await sfApi("PATCH", `/sobjects/Opportunity/${found.oppId}`, fields);
    if (res.success) {
      console.log(`[SF UW Sync] Opp ${found.oppId} updated — ${Object.keys(fields).length} fields (name: "${oppName || "unchanged"}")`);
    } else {
      console.warn(`[SF UW Sync] Opp ${found.oppId} update failed: ${res.error}`);
    }
  } catch (err: any) {
    console.error("[SF UW Sync] Error:", err.message);
  }
}

// ─── AI Snapshot sync (called after generateUnderwritingSnapshot is saved) ───

/**
 * Push AI Snapshot fields to the SF Opportunity after the AI underwriting
 * snapshot is generated and persisted. Also refreshes snapshot-derived Deal
 * Qualification fields so both sections stay in sync.
 *
 * Confirmed SF field names (queried from production org):
 *   UW_Score__c, UW_Summary__c, UW_Red_Flags__c, UW_Recommendation__c, Last_UW_Run__c
 *   Number_of_NSFs_Overdrafts__c, Monthly_Deposit_Count__c, Revenue_Trend__c (picklist)
 */
// Convert "Jan 2024" / "January 2024" / "2024-01" style month strings → "YYYY-MM-DD"
function parsePeriodStart(month: string): string | null {
  if (!month) return null;
  const s = String(month).trim();
  // "YYYY-MM" format
  const iso = s.match(/^(\d{4})-(\d{2})$/);
  if (iso) return `${iso[1]}-${iso[2]}-01`;
  // "Mon YYYY" or "Month YYYY"
  const named = s.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (named) {
    const months = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
    const idx = months.indexOf(named[1].toLowerCase().slice(0, 3));
    if (idx >= 0) return `${named[2]}-${String(idx + 1).padStart(2, "0")}-01`;
  }
  return null;
}

function mapPaymentFrequency(v: any): string | null {
  if (!v) return null;
  const s = String(v).toLowerCase().trim();
  if (s.includes("daily") || s === "day") return "Daily";
  if (s.includes("bi-weekly") || s.includes("biweekly") || s.includes("bi weekly")) return "Bi-Weekly";
  if (s.includes("weekly") || s === "week") return "Weekly";
  if (s.includes("monthly") || s === "month") return "Monthly";
  return "Irregular";
}

// Delete all child records of a given type for an opportunity, then bulk-create new ones
async function replaceChildRecords(
  oppId: string,
  objectType: string,
  newRecords: Record<string, any>[]
): Promise<void> {
  // 1. Query existing IDs
  const existing = await sfQuery(`SELECT Id FROM ${objectType} WHERE Opportunity__c = '${oppId}'`);
  // 2. Delete each one (Collections DELETE requires IDs in query string — easier to loop)
  for (const rec of existing) {
    await sfApi("DELETE", `/sobjects/${objectType}/${rec.Id}`);
  }
  if (existing.length > 0) {
    console.log(`[SF Child Sync] Deleted ${existing.length} existing ${objectType} records for opp ${oppId}`);
  }

  // 3. Bulk-create new records via Collections API
  if (!newRecords.length) return;
  const payload = {
    allOrNone: false,
    records: newRecords.map(r => ({
      attributes: { type: objectType },
      Opportunity__c: oppId,
      ...r,
    })),
  };
  const res = await sfApi("POST", `/composite/sobjects`, payload);
  if (res.success && Array.isArray(res.data)) {
    const ok = (res.data as any[]).filter(r => r.success).length;
    const fail = (res.data as any[]).filter(r => !r.success);
    console.log(`[SF Child Sync] Created ${ok}/${newRecords.length} ${objectType} records`);
    if (fail.length) console.warn(`[SF Child Sync] ${fail.length} failures:`, JSON.stringify(fail));
  } else if (!res.success) {
    console.warn(`[SF Child Sync] ${objectType} bulk create failed: ${res.error}`);
  }
}

export async function syncAiSnapshotToSalesforce(
  email: string,
  snapshot: Record<string, any>
): Promise<void> {
  if (!SF_INSTANCE_URL || (!cachedAccessToken && !SF_CAN_REFRESH)) return;

  const safeEmail = email.toLowerCase().trim();

  try {
    const opp = await findSfOpportunityByEmail(safeEmail);
    if (!opp) {
      console.log(`[SF Snapshot Sync] No opportunity found for ${safeEmail} — skipping`);
      return;
    }

    // Red flags as newline-separated list → UW_Red_Flags__c (textarea, 32 768 chars)
    const redFlagsText = Array.isArray(snapshot.redFlags) && snapshot.redFlags.length
      ? (snapshot.redFlags as any[]).map((f: any) => `${f.flag} [${f.severity}]`).join('\n')
      : null;

    // Average monthly deposit count
    let avgMonthlyDeposits: number | null = null;
    if (snapshot.monthlyData?.length) {
      const counts = (snapshot.monthlyData as any[])
        .map((m: any) => parseNum(m.numDeposits))
        .filter((n): n is number => n !== null);
      if (counts.length) {
        avgMonthlyDeposits = Math.round(counts.reduce((a, b) => a + b, 0) / counts.length);
      }
    }

    const fields = clean({
      UW_Recommendation__c:  mapUwRecommendation(snapshot.worthSubmitting, snapshot.qualificationTier),
      UW_Score__c:           snapshot.overallScore != null ? Number(snapshot.overallScore) : null,
      Last_UW_Run__c:        new Date().toISOString(),
      UW_Summary__c:         snapshot.summary || null,
      UW_Red_Flags__c:       redFlagsText,
      Monthly_Revenue__c:           parseNum(snapshot.avgMonthlyRevenue),
      Average_Daily_Balance__c:     parseNum(snapshot.avgDailyBalance),
      Monthly_Deposit_Count__c:     avgMonthlyDeposits,
      Number_of_NSFs_Overdrafts__c: snapshot.nsfCount != null ? Number(snapshot.nsfCount) : null,
      Revenue_Trend__c:             mapRevenueTrend(snapshot.revenueTrend),
      Total_Monthly_Debt__c:        parseNum(snapshot.totalMonthlyDebtPayments),
      Factor_Rate__c:               parseNum(snapshot.estimatedFactor),
    });

    if (Object.keys(fields).length > 0) {
      const res = await sfApi("PATCH", `/sobjects/Opportunity/${opp.Id}`, fields);
      if (res.success) {
        console.log(`[SF Snapshot Sync] AI Snapshot + Deal Qual updated on Opp ${opp.Id} — ${Object.keys(fields).length} fields`);
      } else {
        console.warn(`[SF Snapshot Sync] Opp ${opp.Id} update failed: ${res.error}`);
      }
    }

    // ── Bank_Statement_Period__c child records (one per month) ──────────────
    if (Array.isArray(snapshot.monthlyData) && snapshot.monthlyData.length > 0) {
      const bankPeriods = (snapshot.monthlyData as any[]).map((m: any) => clean({
        Statement_Month__c:    m.month ? String(m.month) : null,
        Period_Start__c:       parsePeriodStart(m.month),
        Statement_Key__c:      m.month ? `${opp.Id}-${m.month}` : null,
        Deposits__c:           parseNum(m.deposits ?? m.totalDeposits),
        Average_Balance__c:    parseNum(m.avgBalance ?? m.avgDailyBalance),
        Ending_Balance__c:     parseNum(m.endBalance ?? m.endingBalance),
        Number_of_Deposits__c: m.numDeposits != null ? Number(m.numDeposits) : null,
        NSF_Count__c:          (m.nsfs ?? m.nsfCount) != null ? Number(m.nsfs ?? m.nsfCount) : null,
        Negative_Days__c:      m.negativeDays != null ? Number(m.negativeDays) : null,
      }));
      await replaceChildRecords(opp.Id, "Bank_Statement_Period__c", bankPeriods);
    }

    // ── Existing_Position__c child records (one per MCA position) ───────────
    if (Array.isArray(snapshot.existingPositions) && snapshot.existingPositions.length > 0) {
      const positions = (snapshot.existingPositions as any[]).map((p: any) => clean({
        Funder_Name__c:       p.funder ? String(p.funder) : null,
        Payment_Amount__c:    parseNum(p.estimatedPayment),
        Payment_Frequency__c: mapPaymentFrequency(p.frequency),
        Current_Balance__c:   parseNum(p.balance),
        Position_Notes__c:    p.notes ? String(p.notes) : null,
      }));
      await replaceChildRecords(opp.Id, "Existing_Position__c", positions);
    }

  } catch (err: any) {
    console.error("[SF Snapshot Sync] Error:", err.message);
  }
}

// ── Email-click attribution (fed by the GHL + Mailgun click webhooks) ──
// Stamps click fields + logs a Task on the matching Lead/Opportunity, or
// creates a new Lead when the clicker isn't in Salesforce yet.
export async function recordEmailClickInSalesforce(click: {
  email: string; campaign?: string; url?: string; source: string;
  firstName?: string; lastName?: string; phone?: string; businessName?: string;
  rep?: string;
}): Promise<{ result: string; id?: string; rep?: string; error?: string }> {
  const emailEsc = click.email.trim().toLowerCase().replace(/'/g, "\'");
  const now = new Date().toISOString();
  const campaign = (click.campaign || "unknown").slice(0, 255);
  const clickFields = {
    Email_Clicker__c: true,
    Last_Email_Click__c: now,
    Last_Email_Click_Campaign__c: campaign,
  };
  const logTask = (ref: { WhoId?: string; WhatId?: string }) => sfApi("POST", "/sobjects/Task", {
    Subject: `Email clicked: ${campaign} (${click.source})`,
    Description: `Link: ${click.url || "n/a"}\nSource: ${click.source}\nRecipient: ${click.email}`,
    Status: "Completed",
    ActivityDate: now.slice(0, 10),
    ...ref,
  });

  const leads = await sfQuery(`SELECT Id, Sales_Rep__c FROM Lead WHERE Email = '${emailEsc}' AND IsConverted = false ORDER BY LastModifiedDate DESC LIMIT 1`);
  if (leads.length) {
    await sfApi("PATCH", `/sobjects/Lead/${leads[0].Id}`, clickFields);
    await logTask({ WhoId: leads[0].Id });
    return { result: "lead-updated", id: leads[0].Id, rep: leads[0].Sales_Rep__c || undefined };
  }

  const opps = await sfQuery(`SELECT Id, Sales_Rep__c FROM Opportunity WHERE Email__c = '${emailEsc}' ORDER BY LastModifiedDate DESC LIMIT 1`);
  if (opps.length) {
    await sfApi("PATCH", `/sobjects/Opportunity/${opps[0].Id}`, clickFields);
    await logTask({ WhatId: opps[0].Id });
    return { result: "opportunity-updated", id: opps[0].Id, rep: opps[0].Sales_Rep__c || undefined };
  }

  const lastName = (click.lastName || click.firstName || click.email.split("@")[0]).slice(0, 80) || "Unknown";
  const created = await sfApi("POST", "/sobjects/Lead", {
    FirstName: (click.firstName || "").slice(0, 40) || undefined,
    LastName: lastName,
    Company: (click.businessName || lastName).slice(0, 255),
    Email: click.email.trim(),
    Phone: click.phone || undefined,
    LeadSource: click.source === "mailgun" ? "Email - Mailgun" : "Email - GHL",
    Lead_Sub_Source__c: `email click: ${campaign}`.slice(0, 255),
    Sales_Rep__c: click.rep || undefined,
    ...clickFields,
  });
  if (created.success && created.id) {
    await logTask({ WhoId: created.id });
    return { result: "lead-created", id: created.id, rep: click.rep };
  }
  return { result: "error", error: created.error };
}

// ── Rep assignment sync (fed by the GHL assignment webhook) ──
// Sets Sales_Rep__c on the matching Lead and most recent Opportunity so SF
// mirrors the current GHL owner. Overwrites — GHL is the assignment source of truth.
export async function syncRepAssignmentToSalesforce(email: string, repName: string): Promise<{ leadId?: string; oppId?: string; error?: string }> {
  const emailEsc = email.trim().toLowerCase().replace(/'/g, "\'");
  const out: { leadId?: string; oppId?: string; error?: string } = {};
  try {
    const leads = await sfQuery(`SELECT Id, Sales_Rep__c FROM Lead WHERE Email = '${emailEsc}' AND IsConverted = false ORDER BY LastModifiedDate DESC LIMIT 1`);
    if (leads.length && leads[0].Sales_Rep__c !== repName) {
      await sfApi("PATCH", `/sobjects/Lead/${leads[0].Id}`, { Sales_Rep__c: repName });
      out.leadId = leads[0].Id;
    }
    const opps = await sfQuery(`SELECT Id, Sales_Rep__c FROM Opportunity WHERE Email__c = '${emailEsc}' ORDER BY LastModifiedDate DESC LIMIT 1`);
    if (opps.length && opps[0].Sales_Rep__c !== repName) {
      await sfApi("PATCH", `/sobjects/Opportunity/${opps[0].Id}`, { Sales_Rep__c: repName });
      out.oppId = opps[0].Id;
    }
  } catch (err: any) {
    out.error = err.message;
  }
  return out;
}
