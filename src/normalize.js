// Normalize & validate a raw form submission.
// Everything between @n8n-begin and @n8n-end is inlined into the n8n Code node
// by scripts/build-workflow.mjs, so it must stay dependency-free.

// @n8n-begin
const FREE_EMAIL_DOMAINS = [
  'gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com',
  'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'mail.com',
  'qq.com', '163.com', '126.com', 'yandex.com', 'zoho.com',
];

const MAX_MESSAGE_CHARS = 2000; // cost control: never send novels to the LLM

function cleanText(value, maxLen) {
  if (value === undefined || value === null) return '';
  let s = String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '') // control chars
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (maxLen && s.length > maxLen) s = s.slice(0, maxLen) + '…';
  return s;
}

// Small deterministic hash (FNV-1a) so the same submission always gets the same id.
// Used as the Google Sheets match key, which makes webhook retries idempotent.
function fnv1a(input, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
// 64 bits (two seeds) so two different leads practically never share an id.
function stableId(input) {
  return 'lead_' + fnv1a(input, 0x811c9dc5) + fnv1a(input, 0x9e3779b1);
}

function normalizeWebsite(raw) {
  const s = cleanText(raw, 300).toLowerCase();
  if (!s) return { website: '', domain: '' };
  const withScheme = /^https?:\/\//.test(s) ? s : 'https://' + s;
  const m = withScheme.match(/^https?:\/\/(?:www\.)?([^/?#:]+)/);
  const domain = m ? m[1] : '';
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) return { website: '', domain: '' };
  return { website: 'https://' + domain, domain };
}

// Phrases that try to steer the AI. We don't block the lead (a real buyer could
// paste odd text), we flag it so the reply is never sent without a human look.
const INJECTION_PATTERNS = [
  /ignore (all |any |the )?(previous|prior|above|earlier) (instructions|prompts?|rules)/i,
  /disregard (the |your |all )?(instructions|rules|system prompt)/i,
  /\byou are now (an?|the|my) (ai|assistant|model|bot|system)\b/i,
  /\bsystem prompt\b/i,
  /\bscore (this|me|the lead|it) (as |at )?(100|hot)\b/i,
  /<\/?\s*(system|assistant|user|instructions?|lead)\s*>/i,
];

function normalizeLead(raw, receivedAt) {
  let body = raw && typeof raw === 'object' ? raw : {};
  // Some form tools nest the fields one level down.
  if (!body.email && body.data && typeof body.data === 'object') body = body.data;
  if (!body.email && body.fields && typeof body.fields === 'object' && !Array.isArray(body.fields)) body = body.fields;
  const errors = [];

  const name = cleanText(body.name || body.full_name || body.fullName, 120);
  const email = cleanText(body.email, 254).toLowerCase();
  const message = cleanText(body.message || body.details || body.comments, MAX_MESSAGE_CHARS);
  const source = cleanText(body.source || body.utm_source || 'website', 60).toLowerCase();
  const { website, domain: websiteDomain } = normalizeWebsite(body.website || body.url);

  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) errors.push('invalid_email');
  if (message.length < 5) errors.push('empty_message');

  const emailDomain = email.includes('@') ? email.split('@')[1] : '';
  const isFreeEmail = FREE_EMAIL_DOMAINS.includes(emailDomain);

  let company = cleanText(body.company || body.company_name, 120);
  if (!company) {
    const d = websiteDomain || (!isFreeEmail ? emailDomain : '');
    company = d ? d.split('.')[0].replace(/(^|-)([a-z])/g, (_, p, c) => (p ? ' ' : '') + c.toUpperCase()) : '';
  }

  // Every field that is shown to the model is checked, not just the message.
  const injectionSuspected = [message, name, company, source].some((text) => INJECTION_PATTERNS.some((re) => re.test(text)));

  // Honeypot: a hidden form field humans never see. Bots fill every field.
  const honeypotFilled = cleanText(body.fax_number || body.hp, 50).length > 0;

  // Same email + same message on the same day = same lead (form double-submits, webhook retries).
  const day = String(receivedAt || '').slice(0, 10);

  return {
    valid: errors.length === 0,
    errors,
    lead: {
      lead_id: stableId(email + '|' + message.toLowerCase() + '|' + day),
      honeypot_filled: honeypotFilled,
      received_at: receivedAt,
      name,
      first_name: name.split(' ')[0] || '',
      email,
      email_domain: emailDomain,
      is_free_email: isFreeEmail,
      company,
      website,
      message,
      source,
      injection_suspected: injectionSuspected,
    },
  };
}
// @n8n-end

module.exports = { normalizeLead, stableId, cleanText, FREE_EMAIL_DOMAINS, MAX_MESSAGE_CHARS };
