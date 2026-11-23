// Deterministic rules shared by two Code nodes:
//  - spam pre-filter (skip the LLM entirely, saves money)
//  - fallback scoring when the LLM is down, slow or returns garbage
// Inlined by scripts/build-workflow.mjs; keep dependency-free.

// @n8n-begin
// Only clear vendor pitches ("we offer X to you"), so a buyer who merely mentions
// SEO or web design still reaches the AI.
const SPAM_PATTERNS = [
  /\b(we|i) (offer|provide|sell|can (get|give|help) you)\b.{0,80}\b(seo|backlinks?|guest posts?|link building|page ?#?1|first page|traffic)\b/i,
  /\b(casino|crypto (investment|signals)|forex signals|loan offer|viagra)\b/i,
  /\bwe can (increase|boost|double) your (traffic|sales|ranking|followers)\b/i,
  /\b(price list|rate card)\b.{0,40}\b(seo|backlinks?|guest posts?)\b|\b(seo|backlinks?|guest posts?)\b.{0,60}\b(price list|rate card)\b/i,
];

const BUDGET_PATTERNS = [/\$\s?\d/, /\b\d+\s?k\b/i, /\bbudget\b/i, /\b(usd|eur|gbp)\b/i];
const URGENCY_PATTERNS = [/\b(asap|urgent|this week|next week|by (monday|tuesday|wednesday|thursday|friday|end of))\b/i, /\bdeadline\b/i];
const INTENT_PATTERNS = [/\b(looking for|need (a|an|help|someone)|want to (hire|automate|build)|quote|proposal|pricing|how much)\b/i];
const JOB_SEEKER_PATTERNS = [/\b(internship|job opening|my (cv|resume)|hiring\?|are you hiring|student project)\b/i];

function isObviousSpam(lead) {
  if (lead.honeypot_filled) return 'honeypot field filled (bot)';
  if (SPAM_PATTERNS.some((re) => re.test(lead.message))) return 'matches known spam / vendor-pitch pattern';
  return '';
}

function tierFromScore(score, settings) {
  if (score >= settings.hotThreshold) return 'hot';
  if (score >= settings.warmThreshold) return 'warm';
  return 'cold';
}

function templateReply(lead, settings) {
  const hi = lead.first_name ? 'Hi ' + lead.first_name + ',' : 'Hi,';
  return (
    hi + '\n\n' +
    'Thanks for reaching out to ' + settings.brandName + '. We received your message and ' +
    'someone from the team will get back to you within one business day.\n\n' +
    'If it helps us prepare, feel free to reply with a bit more detail about what you would like to achieve and your timeline.'
  );
}

// Transparent, explainable scoring used when the AI is unavailable.
function ruleScore(lead, settings) {
  const reasons = [];
  let score = 20;

  const spam = isObviousSpam(lead);
  if (spam) {
    return { score: 0, intent: 'spam', budget_signal: 'none', urgency: 'low', reasons: [spam], suggested_reply: '' };
  }
  if (JOB_SEEKER_PATTERNS.some((re) => re.test(lead.message))) {
    return { score: 10, intent: 'job_seeker', budget_signal: 'none', urgency: 'low',
      reasons: ['Looks like a job / internship enquiry, not a buyer'], suggested_reply: templateReply(lead, settings) };
  }

  if (!lead.is_free_email) { score += 20; reasons.push('Uses a company email domain'); }
  if (lead.website) { score += 10; reasons.push('Provided a company website'); }
  if (lead.message.length >= 120) { score += 10; reasons.push('Detailed message'); }
  if (INTENT_PATTERNS.some((re) => re.test(lead.message))) { score += 15; reasons.push('Clear buying intent in message'); }
  const hasBudget = BUDGET_PATTERNS.some((re) => re.test(lead.message));
  if (hasBudget) { score += 15; reasons.push('Mentions budget'); }
  const urgent = URGENCY_PATTERNS.some((re) => re.test(lead.message));
  if (urgent) { score += 10; reasons.push('Mentions a timeline'); }
  if (lead.source === 'referral') { score += 10; reasons.push('Came from a referral'); }

  score = Math.max(0, Math.min(100, score));
  return {
    score,
    intent: score >= 50 ? 'buying' : 'other',
    budget_signal: hasBudget ? 'medium' : 'none',
    urgency: urgent ? 'high' : 'low',
    reasons: reasons.slice(0, 4),
    suggested_reply: templateReply(lead, settings),
  };
}
// @n8n-end

module.exports = { isObviousSpam, ruleScore, tierFromScore, templateReply };
