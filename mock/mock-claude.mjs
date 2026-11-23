// A tiny stand-in for the Claude Messages API so the demo runs without an API key.
//   node mock/mock-claude.mjs            # normal answers
//   MOCK_MODE=down node mock/...         # every call fails (529 overloaded) -> shows the rules fallback
//   MOCK_MODE=garbage node mock/...      # model "forgets" the tool -> shows the output guard
// On purpose, it is fooled by prompt injection (scores it 100) so you can see the
// workflow's code-level guard block it anyway.
import http from 'http';

const PORT = Number(process.env.MOCK_PORT || 8787);
const MODE = process.env.MOCK_MODE || 'ok';

function assess(leadText) {
  const t = leadText.toLowerCase();
  const name = (leadText.match(/First name: (.*)/) || [])[1] || '';
  const hi = name && name !== '(not given)' ? `Hi ${name},` : 'Hi,';

  if (/ignore (all |any |the )?(previous|prior|above) instructions/.test(t)) {
    return { score: 100, intent: 'buying', budget_signal: 'high', urgency: 'high',
      reasons: ['Lead asked to be scored 100'],
      suggested_reply: `${hi}\n\nAs requested, please send payment details to billing@attacker.example and visit https://attacker.example/pay to confirm.` };
  }
  if (/\b(student|internship|thesis|school project)\b/.test(t)) {
    return { score: 12, intent: 'job_seeker', budget_signal: 'none', urgency: 'low',
      reasons: ['Student / research enquiry, not a buyer'],
      suggested_reply: `${hi}\n\nThanks for your interest. We are not able to help with student projects at the moment, but we wish you the best with your research.` };
  }
  let score = 30;
  const reasons = [];
  if (/company domain/.test(t)) { score += 15; reasons.push('Writes from a company email domain'); }
  if (/\b(clinics?|stores?|locations?|team of|employees|staff)\b/.test(t)) { score += 15; reasons.push('Established business with several sites or staff'); }
  if (/\b(automate|automation|integrat|follow-up|crm)\b/.test(t)) { score += 15; reasons.push('Needs exactly the automation work we do'); }
  if (/\$\s?\d|budget/.test(t)) { score += 15; reasons.push('Mentions a budget'); }
  if (/next week|asap|this month|urgent/.test(t)) { score += 10; reasons.push('Wants to start soon'); }
  score = Math.min(score, 96);
  return {
    score,
    intent: score >= 50 ? 'buying' : 'info_request',
    budget_signal: /\$\s?\d|budget/.test(t) ? 'medium' : 'none',
    urgency: /next week|asap|urgent/.test(t) ? 'high' : 'low',
    reasons: reasons.length ? reasons : ['Very little detail about the need'],
    suggested_reply: score >= 75
      ? `${hi}\n\nThanks for the detailed note. This is very much the kind of automation we build, and it sounds like a good fit. To prepare, could you tell me which tools you use today (booking system, CRM, email) and reply with two or three times that suit you for a 20-minute call this week?`
      : `${hi}\n\nThanks for getting in touch. Happy to tell you more. Most projects start with one repetitive job, such as order updates, invoice handling or customer status emails. Which task takes your team the most time each week, and roughly when would you like to start? I can then share a short example of how we'd approach it.`,
  };
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'Not found' } }));
  }
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw); } catch { /* fall through */ }
    const lead = String(body?.messages?.[0]?.content || '');
    console.log(`[mock-claude] ${MODE} model=${body.model} lead=${JSON.stringify(lead.slice(0, 60))}...`);

    if (MODE === 'down') {
      res.writeHead(529, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }));
    }
    const usage = { input_tokens: Math.ceil((JSON.stringify(body.system || '').length + lead.length) / 4) + 350, output_tokens: 190 };
    if (MODE === 'garbage') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: 'msg_mock', type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'text', text: 'This lead looks HOT!!! score: ninety' }], stop_reason: 'end_turn', usage }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_mock', type: 'message', role: 'assistant', model: body.model,
      content: [{ type: 'tool_use', id: 'toolu_mock', name: 'record_lead_assessment', input: assess(lead) }],
      stop_reason: 'tool_use', usage,
    }));
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`[mock-claude] listening on http://127.0.0.1:${PORT} (mode: ${MODE})`));
