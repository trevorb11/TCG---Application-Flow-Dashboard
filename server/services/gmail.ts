// Gmail Service for Approval Email Scanning
// Integration: google-mail connector

import { google } from 'googleapis';

async function getAccessToken() {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY 
    ? 'repl ' + process.env.REPL_IDENTITY 
    : process.env.WEB_REPL_RENEWAL 
    ? 'depl ' + process.env.WEB_REPL_RENEWAL 
    : null;

  if (!xReplitToken) {
    throw new Error('X_REPLIT_TOKEN not found for repl/depl');
  }

  const response = await fetch(
    'https://' + hostname + '/api/v2/connection?include_secrets=true&connector_names=google-mail',
    {
      headers: {
        'Accept': 'application/json',
        'X_REPLIT_TOKEN': xReplitToken
      }
    }
  );

  if (!response.ok) {
    throw new Error(`Unable to resolve Gmail connection (${response.status})`);
  }

  const data = await response.json();
  const connectionSettings = data.items?.[0];

  const accessToken = connectionSettings?.settings?.access_token
    || connectionSettings?.settings?.oauth?.credentials?.access_token;

  if (!connectionSettings || !accessToken) {
    throw new Error('Gmail not connected');
  }
  return accessToken;
}

async function getUncachableGmailClient() {
  const accessToken = await getAccessToken();

  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({
    access_token: accessToken
  });

  return google.gmail({ version: 'v1', auth: oauth2Client });
}

export interface EmailMessage {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  date: Date;
  body: string;
  snippet: string;
}

// Known lender domains/patterns for filtering
const LENDER_PATTERNS = [
  'ondeck', 'bluevine', 'fundbox', 'kabbage', 'credibly', 
  'nationalfunding', 'forward', 'rapid', 'quickbridge', 'bfs',
  'capify', 'businessbacker', 'reliant', 'celtic', 'greenbox',
  'forward', 'lendingtree', 'fundera', 'lendio', 'chtree',
  'can-capital', 'yellowstone', 'fora', 'clearco', 'pipe',
  'paypal', 'square', 'stripe', 'shopify', 'amazon',
  'approval', 'approved', 'offer', 'funding', 'loan', 'advance'
];

// Subject line keywords that indicate an approval
const APPROVAL_KEYWORDS = [
  'approved', 'approval', 'congratulations', 'offer letter',
  'funding offer', 'you qualify', 'pre-approved', 'decision',
  'offer available', 'funding ready', 'accepted', 'eligible'
];

export class GmailService {
  
  async isConfigured(): Promise<boolean> {
    try {
      await getAccessToken();
      return true;
    } catch {
      return false;
    }
  }

  async fetchRecentEmails(hoursBack: number = 24, maxResults: number = 50): Promise<EmailMessage[]> {
    const gmail = await getUncachableGmailClient();
    const emails: EmailMessage[] = [];
    
    // Calculate time threshold
    const afterDate = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
    const afterTimestamp = Math.floor(afterDate.getTime() / 1000);
    
    // Build search query for potential approval emails
    const subjectQueries = APPROVAL_KEYWORDS.map(kw => `subject:${kw}`).join(' OR ');
    const query = `after:${afterTimestamp} (${subjectQueries})`;
    
    console.log(`[GMAIL] Searching emails with query: ${query}`);
    
    try {
      const response = await gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults: maxResults
      });
      
      const messages = response.data.messages || [];
      console.log(`[GMAIL] Found ${messages.length} potential approval emails`);
      
      for (const message of messages) {
        if (!message.id) continue;
        
        try {
          const fullMessage = await gmail.users.messages.get({
            userId: 'me',
            id: message.id,
            format: 'full'
          });
          
          const headers = fullMessage.data.payload?.headers || [];
          const getHeader = (name: string) => 
            headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';
          
          // Extract body
          let body = '';
          const payload = fullMessage.data.payload;
          
          if (payload?.body?.data) {
            body = Buffer.from(payload.body.data, 'base64').toString('utf-8');
          } else if (payload?.parts) {
            for (const part of payload.parts) {
              if (part.mimeType === 'text/plain' && part.body?.data) {
                body = Buffer.from(part.body.data, 'base64').toString('utf-8');
                break;
              } else if (part.mimeType === 'text/html' && part.body?.data) {
                body = Buffer.from(part.body.data, 'base64').toString('utf-8');
              }
            }
          }
          
          emails.push({
            id: message.id,
            threadId: message.threadId || '',
            subject: getHeader('Subject'),
            from: getHeader('From'),
            to: getHeader('To'),
            date: new Date(parseInt(fullMessage.data.internalDate || '0')),
            body: body,
            snippet: fullMessage.data.snippet || ''
          });
          
        } catch (fetchError) {
          console.error(`[GMAIL] Error fetching message ${message.id}:`, fetchError);
        }
      }
      
    } catch (error) {
      console.error('[GMAIL] Error searching emails:', error);
      throw error;
    }
    
    return emails;
  }

  async getEmailById(messageId: string): Promise<EmailMessage | null> {
    try {
      const gmail = await getUncachableGmailClient();
      
      const fullMessage = await gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'full'
      });
      
      const headers = fullMessage.data.payload?.headers || [];
      const getHeader = (name: string) => 
        headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';
      
      let body = '';
      const payload = fullMessage.data.payload;
      
      if (payload?.body?.data) {
        body = Buffer.from(payload.body.data, 'base64').toString('utf-8');
      } else if (payload?.parts) {
        for (const part of payload.parts) {
          if (part.mimeType === 'text/plain' && part.body?.data) {
            body = Buffer.from(part.body.data, 'base64').toString('utf-8');
            break;
          } else if (part.mimeType === 'text/html' && part.body?.data) {
            body = Buffer.from(part.body.data, 'base64').toString('utf-8');
          }
        }
      }
      
      return {
        id: messageId,
        threadId: fullMessage.data.threadId || '',
        subject: getHeader('Subject'),
        from: getHeader('From'),
        to: getHeader('To'),
        date: new Date(parseInt(fullMessage.data.internalDate || '0')),
        body: body,
        snippet: fullMessage.data.snippet || ''
      };
      
    } catch (error) {
      console.error(`[GMAIL] Error fetching email ${messageId}:`, error);
      return null;
    }
  }

  async sendEmail(to: string, subject: string, htmlBody: string): Promise<boolean> {
    try {
      const gmail = await getUncachableGmailClient();

      // Fetch authenticated sender address (cached after first call) for display-name From header
      let senderEmail = "";
      try {
        const profile = await gmail.users.getProfile({ userId: "me" });
        senderEmail = profile.data.emailAddress || "";
      } catch { /* fall back to no display name */ }

      const fromHeader = senderEmail
        ? `From: Today Capital Group <${senderEmail}>`
        : `From: Today Capital Group`;

      // Build a plain-text version by stripping HTML tags (spam filters penalise HTML-only)
      const plainText = htmlBody
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, "")
        .replace(/&middot;/g, "·")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&nbsp;/g, " ")
        .replace(/[ \t]{2,}/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

      const boundary = `boundary_${Date.now()}`;
      const messageId = `<${Date.now()}.${Math.random().toString(36).slice(2)}@todaycapitalgroup.com>`;
      const unsubscribeEmail = "marketing@todaycapitalgroup.com";
      const unsubscribeUrl = `https://app.todaycapitalgroup.com/unsubscribe?email=${encodeURIComponent(to)}`;

      const messageParts = [
        fromHeader,
        `To: ${to}`,
        `Subject: ${subject}`,
        `Message-ID: ${messageId}`,
        `List-Unsubscribe: <${unsubscribeUrl}>, <mailto:${unsubscribeEmail}?subject=Unsubscribe>`,
        `List-Unsubscribe-Post: List-Unsubscribe=One-Click`,
        `MIME-Version: 1.0`,
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        ``,
        `--${boundary}`,
        `Content-Type: text/plain; charset=UTF-8`,
        `Content-Transfer-Encoding: quoted-printable`,
        ``,
        plainText,
        ``,
        `--${boundary}`,
        `Content-Type: text/html; charset=UTF-8`,
        ``,
        htmlBody,
        ``,
        `--${boundary}--`,
      ];
      const raw = Buffer.from(messageParts.join("\r\n")).toString("base64url");
      const result = await gmail.users.messages.send({
        userId: "me",
        requestBody: { raw },
      });
      console.log(`[GMAIL] Email sent → ${to} | id=${result.data.id} | subject="${subject}"`);
      return true;
    } catch (err) {
      console.error(`[GMAIL] Failed to send email to ${to}:`, err);
      return false;
    }
  }

  /**
   * Send an email with PDF attachments (for shopping deals to lenders).
   * `to` can be a comma-separated list of addresses.
   * `cc` is optional comma-separated list.
   */
  async sendEmailWithAttachments(
    to: string,
    subject: string,
    htmlBody: string,
    attachments: Array<{ filename: string; content: Buffer; mimeType: string }>,
    cc?: string,
    from?: string,
  ): Promise<boolean> {
    try {
      const gmail = await getUncachableGmailClient();
      const boundary = `boundary_mixed_${Date.now()}`;
      const altBoundary = `boundary_alt_${Date.now()}`;

      // RFC 2047: encode subject as UTF-8 Base64 if it contains any non-ASCII chars
      const encodeSubject = (s: string) =>
        /[^\x00-\x7F]/.test(s) ? `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=` : s;

      const headers = [
        from ? `From: ${from}` : null,
        `To: ${to}`,
        cc ? `Cc: ${cc}` : null,
        `Subject: ${encodeSubject(subject)}`,
        `MIME-Version: 1.0`,
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
      ].filter(Boolean).join("\r\n");

      // HTML body part wrapped in multipart/alternative
      const bodyPart = [
        `--${boundary}`,
        `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
        ``,
        `--${altBoundary}`,
        `Content-Type: text/html; charset=UTF-8`,
        `Content-Transfer-Encoding: 7bit`,
        ``,
        htmlBody,
        ``,
        `--${altBoundary}--`,
      ].join("\r\n");

      // Attachment parts
      const attachmentParts = attachments.map(att => [
        `--${boundary}`,
        `Content-Type: ${att.mimeType}; name="${att.filename}"`,
        `Content-Disposition: attachment; filename="${att.filename}"`,
        `Content-Transfer-Encoding: base64`,
        ``,
        att.content.toString("base64"),
      ].join("\r\n")).join("\r\n");

      const fullMessage = [headers, ``, bodyPart, attachmentParts, `--${boundary}--`].join("\r\n");
      const raw = Buffer.from(fullMessage).toString("base64url");

      const result = await gmail.users.messages.send({
        userId: "me",
        requestBody: { raw },
      });
      console.log(`[GMAIL] Email with ${attachments.length} attachments sent → ${to} | id=${result.data.id} | subject="${subject}"`);
      return true;
    } catch (err) {
      console.error(`[GMAIL] Failed to send email with attachments to ${to}:`, err);
      return false;
    }
  }

  isLikelyApprovalEmail(email: EmailMessage): boolean {
    const subject = email.subject.toLowerCase();
    const from = email.from.toLowerCase();
    const body = email.body.toLowerCase();
    
    // Check if subject contains approval keywords
    const hasApprovalKeyword = APPROVAL_KEYWORDS.some(kw => 
      subject.includes(kw.toLowerCase())
    );
    
    // Check if from a known lender
    const fromKnownLender = LENDER_PATTERNS.some(pattern => 
      from.includes(pattern.toLowerCase())
    );
    
    // Check body for approval language
    const bodyHasApproval = body.includes('approved') || 
                            body.includes('approval') ||
                            body.includes('offer') ||
                            body.includes('congratulations');
    
    // Check for dollar amounts (common in approvals)
    const hasDollarAmount = /\$[\d,]+/.test(email.body) || /\$[\d,]+/.test(subject);
    
    return (hasApprovalKeyword && (hasDollarAmount || fromKnownLender)) ||
           (fromKnownLender && bodyHasApproval);
  }
}

export const gmailService = new GmailService();
