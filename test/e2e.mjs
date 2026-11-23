// End-to-end test inside a real n8n instance (no Google/Slack accounts needed).
//   N8N_BIN=/path/to/n8n node test/e2e.mjs            # AI up (mock)
//   N8N_BIN=/path/to/n8n MOCK_MODE=down node test/e2e.mjs   # AI down -> rules fallback
// Imports a test copy of the workflow where Google Sheets/Gmail/Slack/Respond nodes are
// disabled (they pass data through), the trigger is manual, sample leads are injected,
// and the sheet lookup is simulated so the duplicate check runs too.
import { spawn, execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildLeadWorkflow } from '../scripts/build-workflow.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const N8N = process.env.N8N_BIN || 'n8n';
const MODE = process.env.MOCK_MODE || 'ok';
const PORT = 8787 + (MODE === 'ok' ? 0 : MODE === 'down' ? 1 : 2);
const samples = JSON.parse(readFileSync(path.join(ROOT, 'samples', 'leads.json'), 'utf8'));

// ---- build the sandbox copy of the workflow
const wf = buildLeadWorkflow({ variant: 'test', mockBaseUrl: `http://127.0.0.1:${PORT}` });
wf.id = 'e2eLeadQualifier01';
wf.nodes.push({
  id: 'samples', name: 'Load sample leads', type: 'n8n-nodes-base.code', typeVersion: 2, position: [0, 300],
  parameters: { mode: 'runOnceForAllItems', jsCode: `return ${JSON.stringify(samples)}.map((s) => ({ json: { body: s.body, label: s.label } }));` },
});
wf.connections['Run test'] = { main: [[{ node: 'Load sample leads', type: 'main', index: 0 }]] };
wf.connections['Load sample leads'] = { main: [[{ node: '⚙️ Settings', type: 'main', index: 0 }]] };
// Simulated Google Sheets lookup: a lead id already seen in this run counts as "already in the sheet".
const lookup = wf.nodes.find((n) => n.name === 'Find lead in sheet');
Object.assign(lookup, {
  type: 'n8n-nodes-base.code', typeVersion: 2, disabled: false,
  parameters: { mode: 'runOnceForAllItems', jsCode:
    'const seen = new Set();\n' +
    'return $input.all().map((item, i) => {\n' +
    '  const id = item.json.lead.lead_id;\n' +
    '  const row = seen.has(id) ? { lead_id: id, status: "draft_ready" } : {};\n' +
    '  seen.add(id);\n' +
    '  return { json: row, pairedItem: { item: i } };\n' +
    '});' },
});

const dir = mkdtempSync(path.join(tmpdir(), 'lead-e2e-'));
const wfFile = path.join(dir, 'workflow.json');
writeFileSync(wfFile, JSON.stringify(wf, null, 2));

const env = { ...process.env, N8N_USER_FOLDER: dir, N8N_DIAGNOSTICS_ENABLED: 'false', N8N_RUNNERS_ENABLED: 'true', N8N_LOG_LEVEL: 'info' } // execute prints its result at info level;

// ---- run
const mock = spawn(process.execPath, [path.join(ROOT, 'mock', 'mock-claude.mjs')], { env: { ...process.env, MOCK_MODE: MODE, MOCK_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => mock.stdout.once('data', r));

let raw;
try {
  execFileSync(N8N, ['import:workflow', `--input=${wfFile}`], { env, stdio: 'pipe' });
  raw = execFileSync(N8N, ["execute", `--id=${wf.id}`], { env, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).toString();
} finally {
  mock.kill();
}

// n8n prints log lines, then 'Execution was successful:', a ==== line, then the JSON.
const json = raw.slice(raw.indexOf('{', raw.indexOf('====')), raw.lastIndexOf('}') + 1);
const data = JSON.parse(json).data;
const runData = data.resultData.runData;
// A node with two inputs (e.g. the guard: from the AI call and from the pre-filter) runs once per input.
const out = (name, output = 0) => (runData[name] || []).flatMap((run) => run?.data?.main?.[output] || []).map((i) => i.json);
if (data.resultData.error) { console.error('Execution error:', data.resultData.error.message); process.exit(1); }

const results = out('Score guard & reply');
const rejected = out('Valid lead?', 1);
const duplicates = out('New lead?', 1);

console.log(`\nMock AI mode: ${MODE}\n`);
console.log('score  tier   action           scored_by            review  lead');
for (const r of results) {
  console.log(`${String(r.score).padStart(5)}  ${r.tier.padEnd(5)}  ${r.action.padEnd(15)}  ${r.scored_by.padEnd(19)}  ${r.needs_review ? 'yes' : 'no '}     ${r.name} <${r.email}>`);
}
console.log(`\nRejected as invalid: ${rejected.map((r) => r.lead.email).join(', ') || 'none'}`);
console.log(`Stopped as duplicate: ${duplicates.map((r) => r.lead.email).join(', ') || 'none'}`);
const routed = ['send_and_alert', 'draft_and_alert', 'draft', 'review_alert'].map((k, i) => `${k}=${out('Route by action', i).length}`).join(' ');
console.log(`Routed: ${routed}`);
const hot = results.find((r) => r.tier === 'hot');
if (hot) console.log(`\nHot lead email draft to ${hot.email_to}:\n---\n${hot.email_body}\n---`);
const tokens = results.reduce((s, r) => s + r.tokens_in + r.tokens_out, 0);
console.log(`AI calls: ${out('Claude: score lead').length}, mock tokens used: ${tokens}`);

// ---- assertions
const by = (email) => results.find((r) => r.email === email);
const checks = [
  ['every valid, non-duplicate lead was scored', results.length === 6],
  ['invalid email rejected', rejected.length === 1],
  ['duplicate submission stopped before AI/email', duplicates.length === 1 && duplicates[0].lead.email === 'maria@brightdental.example'],
  ['SEO spam never reached the AI', by('offers@rankpro-seo.example').scored_by === 'rules (pre-filter)'],
  ['honeypot bot logged as spam', by('john.smith@mailinator.example').tier === 'spam'],
  ['prompt injection contained (no AI reply, human pinged)', by('eve@corp-procurement.example').action === 'review_alert' && by('eve@corp-procurement.example').email_body === ''],
  ['routing reads the guard output through the Sheets step', out('Route by action', 1).length === 1 && out('Route by action', 3).length === 1],
  ['Slack text is escaped and built for alerts', results.filter((r) => r.action !== 'log_only' && r.action !== 'draft').every((r) => r.slack_text && !r.slack_text.includes('<!'))],
  ['student is not a sales lead', ['cold', 'spam'].includes(by('jamie.chen.2027@gmail.com').tier)],
  ['strong lead still routed for follow-up', ['hot', 'warm'].includes(by('maria@brightdental.example').tier)],
  ['no reply ever contains a link', results.every((r) => !/https?:\/\/|www\./.test(r.email_body))],
];
if (MODE === 'ok') {
  checks.push(['strong lead is hot with draft + Slack alert', by('maria@brightdental.example').action === 'draft_and_alert']);
  checks.push(['AI scored the real leads', by('tom@northstar-logistics.example').scored_by === 'ai']);
} else {
  checks.push(['AI failure fell back to rules, nothing dropped', by('tom@northstar-logistics.example').scored_by === 'rules (AI fallback)']);
  checks.push(['fallback leads flagged for review', by('maria@brightdental.example').needs_review === true]);
}
let failed = 0;
console.log('');
for (const [name, ok] of checks) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failed++; }
process.exit(failed ? 1 : 0);
