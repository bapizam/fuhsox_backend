import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import nodemailer from 'nodemailer';
import Handlebars from 'handlebars';
import fs from 'fs';
import path from 'path';
import { env } from '@config/env';
import logger from '@lib/logger';

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
  secure: false,
});

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

export async function sendEmail(params: SendEmailParams): Promise<void> {
  const from = `FuhsoX <${env.AWS_SES_FROM_EMAIL}>`;

  if (env.NODE_ENV === 'production') {
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
    // Nodemailer (dev/test — MailHog or Mailtrap)
    await smtpTransport.sendMail({
      from,
      to:      params.to,
      subject: params.subject,
      html:    params.html,
      text:    params.text ?? strip(params.html),
    });
  }

  logger.debug({ to: params.to, subject: params.subject }, 'Email sent');
}

// ─── Strip HTML for plain-text fallback ───────────────────────────────────────

function strip(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const emailService = { sendEmail, renderEmailTemplate };
