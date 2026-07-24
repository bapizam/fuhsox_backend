import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import nodemailer from 'nodemailer';
import Handlebars from 'handlebars';
import fs from 'fs';
import path from 'path';
import { env } from '@config/env';
import logger from '@lib/logger';

// ─── Provider selection ────────────────────────────────────────────────────────

/**
 * SES for production (Render), SMTP for local dev/testing. Explicit
 * MAIL_PROVIDER wins; otherwise fall back to the original NODE_ENV rule so
 * deployments that never set it behave exactly as before.
 *
 * SES goes over HTTPS:443 via the SDK — NOT SMTP — which is why it works on a
 * free Render instance despite Render blocking outbound ports 25/465/587.
 */
const MAIL_PROVIDER =
  env.MAIL_PROVIDER ?? (env.NODE_ENV === 'production' ? 'ses' : 'smtp');

// Fail at boot rather than silently queueing jobs that can never send — a failed
// email job is invisible to the caller, since request-otp returns before it runs.
if (MAIL_PROVIDER === 'brevo' && !env.BREVO_API_KEY) {
  throw new Error('MAIL_PROVIDER=brevo requires BREVO_API_KEY to be set');
}

if (MAIL_PROVIDER === 'resend' && !env.RESEND_API_KEY) {
  throw new Error('MAIL_PROVIDER=resend requires RESEND_API_KEY to be set');
}

// ─── Email Clients ─────────────────────────────────────────────────────────────

const sesClient = new SESClient({
  region: env.AWS_REGION,
  credentials: {
    accessKeyId:     env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
  },
});

const smtpTransport = nodemailer.createTransport({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  auth: env.SMTP_USER
    ? { user: env.SMTP_USER, pass: env.SMTP_PASS }
    : undefined,
  // 465 is implicit TLS from the first byte; 587 (Brevo, Gmail) and 1025
  // (MailHog) start plaintext and upgrade via STARTTLS. Hard-coding false broke 465.
  secure: env.SMTP_PORT === 465,
  // Refuse to fall back to cleartext on the submission port, which would leak the
  // Gmail app password. Scoped to 587 because MailHog on 1025 offers no STARTTLS.
  requireTLS: env.SMTP_PORT === 587,
});

// ─── Template Helpers ──────────────────────────────────────────────────────────

// Handlebars ships no comparison helpers, so `{{#if (gt days_remaining 1)}}` in
// exam-countdown.hbs threw `Missing helper: "gt"` and every countdown email
// failed to render. Registered at module load, before any template compiles.
Handlebars.registerHelper('gt', (a: unknown, b: unknown) => Number(a) > Number(b));

// ─── Template Cache ────────────────────────────────────────────────────────────

const templateCache = new Map<string, HandlebarsTemplateDelegate>();

const TEMPLATES_DIR = path.join(process.cwd(), 'email-templates');

function loadTemplate(templateName: string): HandlebarsTemplateDelegate {
  const cached = templateCache.get(templateName);
  if (cached && env.NODE_ENV === 'production') return cached;

  const templatePath = path.join(TEMPLATES_DIR, `${templateName}.hbs`);

  if (!fs.existsSync(templatePath)) {
    throw new Error(`Email template not found: ${templatePath}`);
  }

  const source = fs.readFileSync(templatePath, 'utf-8');
  const compiled = Handlebars.compile(source);
  templateCache.set(templateName, compiled);
  return compiled;
}

// Promise-typed (callers await it) but not `async` — rendering is synchronous.
export function renderEmailTemplate(
  templateName: string,
  data: Record<string, unknown>,
): Promise<string> {
  const template = loadTemplate(templateName);
  return Promise.resolve(template({ ...data, year: new Date().getFullYear() }));
}

// ─── Send Email ────────────────────────────────────────────────────────────────

export interface SendEmailParams {
  to:       string;
  subject:  string;
  html:     string;
  text?:    string;
}

const FROM_NAME = 'FuhsoX';

export async function sendEmail(params: SendEmailParams): Promise<void> {
  const fromEmail = env.MAIL_FROM_EMAIL ?? env.AWS_SES_FROM_EMAIL;
  const from = `${FROM_NAME} <${fromEmail}>`;

  if (MAIL_PROVIDER === 'brevo') {
    // Brevo transactional API. Deliberately HTTP, not their SMTP relay: Render's
    // free web services block outbound ports 25/465/587, so only :443 gets out.
    // `sender.email` must be a sender Brevo has verified on the account.
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key':      env.BREVO_API_KEY as string,
        'content-type': 'application/json',
        accept:         'application/json',
      },
      body: JSON.stringify({
        sender:      { name: FROM_NAME, email: fromEmail },
        to:          [{ email: params.to }],
        subject:     params.subject,
        htmlContent: params.html,
        textContent: params.text ?? strip(params.html),
      }),
    });

    // Surface Brevo's own error text — "sender not verified" and "invalid key"
    // are both 400s, and without the body the worker logs an opaque failure.
    if (!res.ok) {
      const detail = await res.text().catch(() => '<unreadable body>');
      throw new Error(`Brevo send failed (${res.status}): ${detail}`);
    }
  } else if (MAIL_PROVIDER === 'resend') {
    // Resend transactional API — HTTPS:443, so it survives Render's free-tier
    // SMTP block. `from` must be a domain Resend has verified, OR the shared
    // onboarding@resend.dev sender, which needs no domain of your own.
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization:  `Bearer ${env.RESEND_API_KEY as string}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to:      [params.to],
        subject: params.subject,
        html:    params.html,
        text:    params.text ?? strip(params.html),
      }),
    });

    // Same reasoning as Brevo: an unverified sender and a bad key are both 4xx,
    // and without the body the worker only logs an opaque failure. Resend's
    // 403 for "can only send to your own address" is especially easy to
    // misread as an auth problem, so the detail matters.
    if (!res.ok) {
      const detail = await res.text().catch(() => '<unreadable body>');
      throw new Error(`Resend send failed (${res.status}): ${detail}`);
    }
  } else if (MAIL_PROVIDER === 'ses') {
    // AWS SES
    const command = new SendEmailCommand({
      Source: from,
      Destination: { ToAddresses: [params.to] },
      Message: {
        Subject: { Data: params.subject, Charset: 'UTF-8' },
        Body: {
          Html: { Data: params.html,          Charset: 'UTF-8' },
          Text: { Data: params.text ?? strip(params.html), Charset: 'UTF-8' },
        },
      },
    });
    await sesClient.send(command);
  } else {
    // Nodemailer over SMTP (dev/test — Brevo, MailHog or Mailtrap)
    await smtpTransport.sendMail({
      from,
      to:      params.to,
      subject: params.subject,
      html:    params.html,
      text:    params.text ?? strip(params.html),
    });
  }

  logger.debug(
    { to: params.to, subject: params.subject, provider: MAIL_PROVIDER },
    'Email sent',
  );
}

// ─── Strip HTML for plain-text fallback ───────────────────────────────────────

function strip(html: string): string {
  return (
    html
      // Text inside <head>/<style>/<script> survives a naive tag strip, so the
      // text/plain part used to open with ~2KB of raw CSS — which is both what
      // text-only clients show and what spam filters score.
      .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '')
      .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
      // The hidden preheader only exists to seed the inbox preview line.
      .replace(/<div[^>]*display\s*:\s*none[\s\S]*?<\/div>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
      .replace(/<\/table>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&copy;/gi, '(c)')
      .replace(/&middot;/gi, '-')
      .replace(/&mdash;/gi, '—')
      // Layout-only entities left in the markup (&zwnj;, &shy;, …) carry no text.
      .replace(/&[a-z]+;|&#\d+;/gi, '')
      .split('\n')
      .map((line) => line.trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

export const emailService = { sendEmail, renderEmailTemplate };
