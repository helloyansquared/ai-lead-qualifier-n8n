// Validates the model's output, falls back to rules when needed, and decides
// what happens next. The model never picks recipients, links or the routing
// tier: code derives all of those.
// Inlined by scripts/build-workflow.mjs together with rules.js and request.js.

// @n8n-begin
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>()]+/gi;
// Bare domains like "pay.example/confirm" (common TLDs only, so "Node.js" survives).
const BARE_DOMAIN_RE = /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|co|ai|app|dev|biz|info|xyz|me|us|uk|cn|ru|top|site|online|shop|link|click|example)\b(?:\/[^\s<>()]*)?/gi;
const EMAIL_RE = /[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/gi;
const PHONE_RE = /\+?\d[\d\s().-]{7,}\d/g;

function stripAll(s, re, flag, flags, replacement) {
  re.lastIndex = 0;
  if (!re.test(s)) return s;
  re.lastIndex = 0;
  flags.push(flag);
  return s.replace(re, replacement);
}

function sanitizeReply(text, lead, settings) {
  const flags = [];
  let s = String(text || '');
  s = stripAll(s, /<[a-z/][^>]*>/gi, 'html_removed', flags, '');
  s = stripAll(s, EMAIL_RE, 'emails_removed', flags, '[email removed]'); // before domains, so addresses go whole
  s = stripAll(s, URL_RE, 'links_removed', flags, '');
  s = stripAll(s, BARE_DOMAIN_RE, 'links_removed', flags, '');
  // Phone numbers: 9+ digits, so dates like 2026-12-01 are left alone.
  s = s.replace(PHONE_RE, (m) => {
    if (m.replace(/\D/g, '').length < 9) return m;
    flags.push('phone_removed');
    return '[phone removed]';
  });
  s = s.replace(/[ \t]{2,}/g, ' ').trim();
  // The signature is added by code. If the model signed off anyway, drop its
  // closing line (and a short name line under it) so the email isn't signed twice.
  const lines = s.split('\n');
  const SIGNOFF_RE = /^(best|kind|warm|many)?\s*(regards|wishes)\b|^(thanks|thank you|cheers|sincerely|best|all the best|talk soon)\b[^.?!]*[,.!]?$/i;
  for (let i = lines.length - 1, seen = 0; i >= 0 && seen < 3; i--) {
    const l = lines[i].trim();
    if (!l) continue;
    seen++;
    if (l.length <= 80 && SIGNOFF_RE.test(l)) {
      lines.splice(i);
      flags.push('signoff_removed');
      break;
    }
  }
  s = lines.join('\n').trim();
  if (s.length > settings.maxReplyChars) { s = s.slice(0, settings.maxReplyChars).replace(/\s+\S*$/, '') + '…'; flags.push('truncated'); }
  if (s.length < 40) { s = templateReply(lead, settings); flags.push('template_used'); }
  return { text: s, flags: Array.from(new Set(flags)) };
}

// Slack mrkdwn: escape so form text can't @channel or fake links.
function slackEscape(v) {
  return String(v === undefined || v === null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Returns the validated assessment or throws (the caller then uses ruleScore).
function parseClaudeResponse(resp) {
  if (!resp || typeof resp !== 'object') throw new Error('empty response');
  if (resp.error) {
    const e = resp.error;
    throw new Error('API error: ' + (typeof e === 'string' ? e : e.message || e.type || JSON.stringify(e)).slice(0, 200));
  }
  if (resp.stop_reason === 'max_tokens') throw new Error('response cut off (max_tokens): raise maxOutputTokens');
  const blocks = Array.isArray(resp.content) ? resp.content : [];
  const call = blocks.find((b) => b && b.type === 'tool_use' && b.name === LEAD_TOOL.name);
  if (!call || !call.input || typeof call.input !== 'object') throw new Error('no tool_use block in response');
  const a = call.input;

  const score = Number(a.score);
  if (!Number.isFinite(score)) throw new Error('score is not a number');
  const reasons = (Array.isArray(a.reasons) ? a.reasons : [])
    .filter((r) => typeof r === 'string' && r.trim())
    .map((r) => {
      let t = r.replace(URL_RE, '').replace(/\s+/g, ' ').trim().replace(/[.;]+$/, '');
      if (t.length > 160) t = t.slice(0, 160).replace(/\s+\S*$/, '') + '…';
      return t;
    })
    .slice(0, 4);

  return {
    score: Math.round(Math.max(0, Math.min(100, score))),
    intent: INTENTS.includes(a.intent) ? a.intent : 'other',
    budget_signal: LEVELS.includes(a.budget_signal) ? a.budget_signal : 'none',
    urgency: ['high', 'medium', 'low'].includes(a.urgency) ? a.urgency : 'low',
    reasons: reasons.length ? reasons : ['(model gave no reasons)'],
    suggested_reply: typeof a.suggested_reply === 'string' ? a.suggested_reply : '',
    truncated: resp.stop_reason === 'max_tokens',
    usage: resp.usage || null,
  };
}

function buildSlackText(out) {
  const head = {
    send_and_alert: ':fire: *Hot lead* (reply SENT automatically)',
    draft_and_alert: ':fire: *Hot lead* (reply drafted in Gmail: review and send)',
    review_alert: ':warning: *Lead needs a manual look* (no reply drafted)',
  }[out.action] || '*Lead*';
  const lines = [
    head,
    '*' + slackEscape(out.name || 'Unknown') + '* (' + slackEscape(out.company || 'no company') + ') score *' + out.score + '/100*',
    'Email: ' + slackEscape(out.email) + ' | Source: ' + slackEscape(out.source),
    'Why: ' + slackEscape(out.reasons_text),
  ];
  if (out.needs_review) lines.push('Review: ' + slackEscape(out.review_notes));
  lines.push('Message: ' + slackEscape(out.message.slice(0, 400)));
  if (out.email_body) lines.push('', 'Reply:', '>>> ' + slackEscape(out.email_body));
  return lines.join('\n');
}

function decide(ctx, resp, settings) {
  const lead = ctx.lead;
  const review = [];
  let assessment;
  let scoredBy;
  let aiError = '';

  if (ctx.skip_ai_reason) {
    assessment = ruleScore(lead, settings);
    scoredBy = 'rules (pre-filter)';
  } else {
    try {
      assessment = parseClaudeResponse(resp);
      scoredBy = 'ai';
      if (assessment.truncated) review.push('AI output was cut off');
    } catch (err) {
      aiError = String(err && err.message ? err.message : err);
      assessment = ruleScore(lead, settings);
      scoredBy = 'rules (AI fallback)';
      review.push('AI unavailable, scored by rules');
    }
  }

  let score = assessment.score;
  const reasons = assessment.reasons.slice();

  // Code-level cross-checks: the model cannot talk its way into "hot".
  if (lead.injection_suspected) {
    score = Math.min(score, 10);
    reasons.unshift('Form text tries to instruct the AI (possible prompt injection)');
    review.push('Possible prompt injection: check by hand before replying');
  }
  if (['spam', 'vendor_pitch', 'job_seeker'].includes(assessment.intent)) score = Math.min(score, settings.warmThreshold - 1);

  let tier = tierFromScore(score, settings);
  if (assessment.intent === 'spam' && !lead.injection_suspected) tier = 'spam';

  // Clean the reply BEFORE deciding the action: anything we had to strip
  // means a human must look at it, so auto-send is off for this lead.
  let reply = { text: '', flags: [] };
  if (!lead.injection_suspected && (tier === 'hot' || tier === 'warm')) {
    reply = sanitizeReply(assessment.suggested_reply, lead, settings);
    const serious = reply.flags.filter((f) => f !== 'template_used' && f !== 'signoff_removed');
    if (serious.length) review.push('Reply was cleaned: ' + serious.join(', '));
  }

  let action = 'log_only';
  if (lead.injection_suspected) action = 'review_alert'; // a person decides; nothing AI-written goes out
  else if (tier === 'hot') action = settings.autoSendHotReplies && review.length === 0 ? 'send_and_alert' : 'draft_and_alert';
  else if (tier === 'warm') action = 'draft';

  const signature = '\n\n' + settings.senderName + '\n' + settings.brandName;
  const out = {
    lead_id: lead.lead_id,
    received_at: lead.received_at,
    name: lead.name,
    email: lead.email,
    company: lead.company,
    website: lead.website,
    source: lead.source,
    message: lead.message,
    score,
    tier,
    intent: assessment.intent,
    budget_signal: assessment.budget_signal,
    urgency: assessment.urgency,
    reasons: reasons.slice(0, 4),
    reasons_text: reasons.slice(0, 4).join('; '),
    scored_by: scoredBy,
    ai_error: aiError,
    needs_review: review.length > 0,
    review_notes: review.join('; '),
    action,
    email_to: lead.email, // always the submitter, never an address chosen by the model
    email_subject: 'Re: your enquiry' + (lead.company ? ' – ' + lead.company : ''),
    email_body: reply.text ? reply.text + signature : '',
    status: { log_only: 'logged', review_alert: 'needs_review', draft: 'draft_ready', draft_and_alert: 'draft_ready', send_and_alert: 'replied' }[action],
    tokens_in: assessment.usage ? assessment.usage.input_tokens : 0,
    tokens_out: assessment.usage ? assessment.usage.output_tokens : 0,
  };
  out.slack_text = buildSlackText(out);
  return out;
}
// @n8n-end

module.exports = { decide, parseClaudeResponse, sanitizeReply, slackEscape };
