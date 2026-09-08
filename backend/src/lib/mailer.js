const fs = require('node:fs');
const path = require('node:path');
const nodemailer = require('nodemailer');

// Where to drop logged emails when SMTP is not configured (dev / local).
// IMPORTANT: this file MUST live outside `backend/uploads/` because that
// directory is mounted as a Docker volume and parts of it are served
// statically. Putting the mail log under /uploads would expose every
// outbound email — including password-reset URLs — to any unauthenticated
// HTTP caller. We keep it under `backend/logs/` instead.
const LOG_DIR = path.join(__dirname, '..', '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'sent-mail.log');

const APP_NAME = process.env.APP_NAME || 'PM Tool';
const APP_ORIGIN = process.env.APP_ORIGIN || 'http://localhost:3000';
const FROM_ADDRESS =
    process.env.MAIL_FROM ||
    `"${APP_NAME}" <no-reply@localhost>`;

let transporter = null;
let mode = 'log'; // 'smtp' | 'log'

function init() {
    const host = process.env.SMTP_HOST;
    const port = process.env.SMTP_PORT
        ? Number(process.env.SMTP_PORT)
        : null;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    const secure = process.env.SMTP_SECURE === 'true';

    if (!host || !port) {
        console.log('[mailer] SMTP not configured; emails will be logged to', LOG_FILE);
        return;
    }

    transporter = nodemailer.createTransport({
        host,
        port,
        secure,
        auth: user && pass ? { user, pass } : undefined,
    });
    mode = 'smtp';
    console.log(`[mailer] SMTP transport ready (${host}:${port}, secure=${secure})`);
}

init();

function appLink(path = '/') {
    if (!path) return APP_ORIGIN;
    if (path.startsWith('http')) return path;
    if (!path.startsWith('/')) path = `/${path}`;
    return `${APP_ORIGIN}${path}`;
}

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Wraps body content in a tidy mobile-friendly HTML shell. Keep it inline
// styled because mail clients (and especially Gmail) routinely strip <style>.
function wrapHtml({ heading, intro, bodyHtml, ctaText, ctaUrl, footer }) {
    const cta =
        ctaText && ctaUrl
            ? `<p style="margin:24px 0;text-align:left;">
                 <a href="${escapeHtml(ctaUrl)}"
                    style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;
                           padding:10px 18px;border-radius:6px;font-weight:600;font-size:14px;">
                   ${escapeHtml(ctaText)}
                 </a>
               </p>`
            : '';
    return `<!doctype html>
<html><body style="margin:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb;">
        <tr>
          <td style="background:#111827;color:#fff;padding:14px 24px;font-weight:600;font-size:14px;letter-spacing:0.3px;">
            ${escapeHtml(APP_NAME)}
          </td>
        </tr>
        <tr>
          <td style="padding:24px;">
            <h2 style="margin:0 0 8px 0;font-size:20px;line-height:1.3;">${escapeHtml(heading)}</h2>
            ${intro ? `<p style="margin:0 0 12px 0;color:#4b5563;font-size:14px;line-height:1.5;">${escapeHtml(intro)}</p>` : ''}
            <div style="font-size:14px;color:#111;line-height:1.6;">${bodyHtml || ''}</div>
            ${cta}
            ${footer ? `<p style="margin:24px 0 0 0;color:#6b7280;font-size:12px;line-height:1.5;">${escapeHtml(footer)}</p>` : ''}
          </td>
        </tr>
        <tr>
          <td style="background:#f9fafb;color:#9ca3af;font-size:11px;padding:12px 24px;text-align:center;border-top:1px solid #e5e7eb;">
            You're receiving this because you have email notifications enabled in ${escapeHtml(APP_NAME)}.
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function buildPlain({ heading, intro, body, ctaText, ctaUrl, footer }) {
    const lines = [heading, ''];
    if (intro) lines.push(intro, '');
    if (body) lines.push(body, '');
    if (ctaText && ctaUrl) lines.push(`${ctaText}: ${ctaUrl}`, '');
    if (footer) lines.push(footer);
    return lines.join('\n');
}

async function logToFile(message) {
    const line = [
        '====================',
        new Date().toISOString(),
        `to: ${message.to}`,
        `from: ${message.from}`,
        `subject: ${message.subject}`,
        '',
        message.text || '(no plain-text body)',
        '',
    ].join('\n');
    try {
        await fs.promises.mkdir(path.dirname(LOG_FILE), { recursive: true });
        await fs.promises.appendFile(LOG_FILE, line + '\n');
    } catch (err) {
        console.warn('[mailer] failed to append to log file:', err.message);
    }
    console.log(`[mailer] (logged) → ${message.to} :: ${message.subject}`);
}

// Strip CR/LF from header-like fields. nodemailer already folds bare
// newlines but we belt-and-brace it here so user-supplied content
// (project / task names, mention text…) can never inject extra
// headers via a crafted subject. Also collapses runs of whitespace and
// caps the length so the message stays well-formed.
function sanitiseHeader(value, max = 250) {
    if (!value) return '';
    const s = String(value)
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// Low-level: send raw text+html email. Returns true on success, false on
// failure. Never throws — email failures should not break user flows.
async function sendMail({ to, subject, html, text }) {
    if (!to) return false;
    const message = {
        from: FROM_ADDRESS,
        to,
        subject: sanitiseHeader(subject),
        text,
        html,
    };
    try {
        if (mode === 'smtp' && transporter) {
            await transporter.sendMail(message);
            return true;
        }
        await logToFile(message);
        return true;
    } catch (err) {
        console.warn(`[mailer] send failed for ${to}: ${err.message}`);
        try {
            await logToFile({ ...message, text: `(SMTP send failed: ${err.message})\n\n${text || ''}` });
        } catch {
            // already logged inside logToFile
        }
        return false;
    }
}

// High-level: send a templated message in our standard layout.
async function sendTemplate({
    to,
    subject,
    heading,
    intro,
    body,
    bodyHtml,
    ctaText,
    ctaUrl,
    footer,
}) {
    const html = wrapHtml({
        heading,
        intro,
        bodyHtml: bodyHtml || (body ? `<p>${escapeHtml(body).replace(/\n/g, '<br>')}</p>` : ''),
        ctaText,
        ctaUrl,
        footer,
    });
    const text = buildPlain({ heading, intro, body, ctaText, ctaUrl, footer });
    return sendMail({ to, subject, html, text });
}

module.exports = {
    sendMail,
    sendTemplate,
    appLink,
    APP_NAME,
    APP_ORIGIN,
};
