// Generates the n8n workflow JSON from src/, so the Code nodes and the tested
// code can never drift apart.
//   node scripts/build-workflow.mjs          -> workflow/*.json
// The e2e test imports buildLeadWorkflow({ variant: 'test' }).
import { createRequire } from 'module';
import { writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(import.meta.url);
const { nodeCode } = require('./inline.cjs');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const N = {
  webhook: 'Lead form webhook',
  settings: '⚙️ Settings',
  normalize: 'Normalize & validate',
  isValid: 'Valid lead?',
  reject: 'Respond 400 (invalid)',
  accept: 'Respond 202 (accepted)',
  lookup: 'Find lead in sheet',
  dedupe: 'Dedupe check',
  isNew: 'New lead?',
  reserve: 'Reserve row (processing)',
  request: 'Build Claude request',
  needsAi: 'Needs AI?',
  claude: 'Claude: score lead',
  guard: 'Score guard & reply',
  log: 'Log to Google Sheets',
  route: 'Route by action',
  send: 'Gmail: send reply',
  draftHot: 'Gmail: draft reply (hot)',
  draftWarm: 'Gmail: draft reply (warm)',
  slack: 'Slack: hot lead alert',
};

const SHEET_COLUMNS = [
  'lead_id', 'received_at', 'name', 'email', 'company', 'website', 'source', 'message',
  'score', 'tier', 'intent', 'budget_signal', 'urgency', 'reasons_text', 'scored_by',
  'needs_review', 'review_notes', 'action', 'status', 'ai_error', 'tokens_in', 'tokens_out',
];

const sheetDoc = { __rl: true, mode: 'url', value: 'https://docs.google.com/spreadsheets/d/YOUR_SHEET_ID/edit' };
const sheetTab = { __rl: true, mode: 'name', value: 'Leads' };

function sheetColumns(value) {
  return {
    mappingMode: 'defineBelow',
    value,
    matchingColumns: ['lead_id'],
    schema: SHEET_COLUMNS.map((c) => ({
      id: c, displayName: c, required: false, defaultMatch: c === 'lead_id', display: true,
      type: 'string', canBeUsedToMatch: true, removed: !(c in value),
    })),
  };
}
const G = (field) => `={{ $('Score guard & reply').item.json.${field} }}`;

function code(name, body, { parameters = {}, ...extra } = {}) {
  return {
    name,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    parameters: { mode: 'runOnceForEachItem', ...parameters, jsCode: body },
    ...extra,
  };
}

function ifNode(name, leftValue, operator, rightValue) {
  return {
    name,
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [{ id: name.replace(/\W/g, '').toLowerCase(), leftValue, rightValue, operator }],
        combinator: 'and',
      },
      options: {},
    },
  };
}

const respond = (name, code, body) => ({
  name,
  type: 'n8n-nodes-base.respondToWebhook',
  typeVersion: 1.1,
  parameters: { respondWith: 'json', responseBody: body, options: { responseCode: code } },
});


export function buildLeadWorkflow({ variant = 'prod', mockBaseUrl = 'http://127.0.0.1:8787' } = {}) {
  const test = variant === 'test';

  const settingsBody = nodeCode('settings') + '\n\n' +
    (test ? `SETTINGS.anthropicBaseUrl = ${JSON.stringify(mockBaseUrl)};\n` : '') +
    '// Pass only the form body on. Headers (which carry the webhook secret) are dropped here.\n' +
    'return { json: { settings: SETTINGS, body: $json.body || {} } };';

  const nodes = [
    test
      ? { name: 'Run test', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} }
      : {
          name: N.webhook,
          type: 'n8n-nodes-base.webhook',
          typeVersion: 2,
          webhookId: 'a7b6f0d2-3c1e-4f5a-9b8c-lead00000001',
          parameters: {
            httpMethod: 'POST',
            path: 'lead',
            authentication: 'headerAuth', // shared secret header: stops strangers running up your AI bill
            responseMode: 'responseNode',
            options: {},
          },
        },
    code(N.settings, settingsBody),
    code(N.normalize, nodeCode('normalize') + '\n\n' +
      'const r = normalizeLead($json.body, new Date().toISOString());\n' +
      'return { json: { ...r, settings: $json.settings } };'),
    ifNode(N.isValid, '={{ $json.valid }}', { type: 'boolean', operation: 'true', singleValue: true }, ''),
    respond(N.reject, 400, '={{ { "status": "rejected", "errors": $json.errors } }}'),
    respond(N.accept, 202, '={{ { "status": "accepted", "lead_id": $json.lead.lead_id } }}'),
    {
      name: N.lookup,
      type: 'n8n-nodes-base.googleSheets',
      typeVersion: 4.5,
      alwaysOutputData: true,
      retryOnFail: true,
      maxTries: 3,
      waitBetweenTries: 1000,
      onError: 'continueRegularOutput', // lookup down -> treat as "not a duplicate", never lose the lead
      parameters: {
        operation: 'read',
        documentId: sheetDoc,
        sheetName: sheetTab,
        filtersUI: { values: [{ lookupColumn: 'lead_id', lookupValue: '={{ $json.lead.lead_id }}' }] },
        options: {},
      },
    },
    code(N.dedupe,
      '// Webhook retries / double submits must not create a second row or a second email.\n' +
      '// Runs once for all items and does not rely on paired-item data: the sheet lookup\n' +
      '// emits one empty item (or an error item) when nothing is found.\n' +
      `const leads = $('${N.isValid}').all(0);\n` +
      'const rows = $input.all();\n' +
      'return leads.map((l, idx) => {\n' +
      '  const { lead_id: id, email } = l.json.lead;\n' +
      '  const mine = rows.filter((r) => (r.pairedItem && typeof r.pairedItem.item === "number" ? r.pairedItem.item === idx : true));\n' +
      '  const isDuplicate = mine.some((r) => r.json && r.json.lead_id === id && (!r.json.email || String(r.json.email).toLowerCase() === email));\n' +
      '  return { json: { ...l.json, is_duplicate: isDuplicate }, pairedItem: { item: idx } };\n' +
      '});',
      { parameters: { mode: 'runOnceForAllItems' } }),
    ifNode(N.isNew, '={{ $json.is_duplicate }}', { type: 'boolean', operation: 'false', singleValue: true }, ''),
    {
      // Claim the lead id in the sheet straight away, so a second click a few seconds
      // later is caught by the duplicate check while the first one is still with the AI.
      name: N.reserve,
      type: 'n8n-nodes-base.googleSheets',
      typeVersion: 4.5,
      retryOnFail: true,
      maxTries: 3,
      waitBetweenTries: 1000,
      onError: 'continueRegularOutput',
      parameters: {
        operation: 'appendOrUpdate',
        documentId: sheetDoc,
        sheetName: sheetTab,
        columns: sheetColumns({
          lead_id: '={{ $json.lead.lead_id }}',
          received_at: '={{ $json.lead.received_at }}',
          name: '={{ $json.lead.name }}',
          email: '={{ $json.lead.email }}',
          status: 'processing',
        }),
        options: { cellFormat: 'RAW' },
      },
    },
    code(N.request, nodeCode('request') + '\n\n' +
      `const ctx = $('${N.dedupe}').item.json; // the sheet node above replaced $json with the row\n` +
      'const lead = ctx.lead;\n' +
      'const skip = isObviousSpam(lead); // obvious spam never costs an API call\n' +
      'return { json: { lead, settings: ctx.settings, skip_ai_reason: skip, claude_request: skip ? null : buildClaudeRequest(lead, ctx.settings) } };'),
    ifNode(N.needsAi, '={{ $json.skip_ai_reason }}', { type: 'string', operation: 'empty', singleValue: true }, ''),
    {
      name: N.claude,
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      retryOnFail: true,
      maxTries: 3,
      waitBetweenTries: 2000,
      onError: 'continueRegularOutput', // an API failure becomes data; the guard falls back to rules
      parameters: {
        method: 'POST',
        url: '={{ $json.settings.anthropicBaseUrl }}/v1/messages',
        ...(test
          ? { authentication: 'none' }
          : { authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' }), // Header Auth: name x-api-key
        sendHeaders: true,
        headerParameters: { parameters: [{ name: 'anthropic-version', value: '2023-06-01' }] },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify($json.claude_request) }}',
        options: { timeout: 30000 },
      },
    },
    code(N.guard, nodeCode('guard') + '\n\n' +
      '// Items arrive either from the AI call (API response) or straight from the pre-filter.\n' +
      'const fromPrefilter = Boolean($json.lead);\n' +
      `const ctx = fromPrefilter ? $json : $('${N.request}').item.json;\n` +
      'const resp = fromPrefilter ? null : $json;\n' +
      'return { json: { ...decide(ctx, resp, ctx.settings), slack_channel: ctx.settings.slackChannel } };'),
    {
      name: N.log,
      type: 'n8n-nodes-base.googleSheets',
      typeVersion: 4.5,
      retryOnFail: true,
      maxTries: 3,
      waitBetweenTries: 2000,
      onError: 'continueRegularOutput', // a Sheets hiccup must not stop the reply/alert
      parameters: {
        operation: 'appendOrUpdate',
        documentId: sheetDoc,
        sheetName: sheetTab,
        columns: sheetColumns(Object.fromEntries(SHEET_COLUMNS.map((c) => [c, `={{ $json.${c} }}`]))),
        options: { cellFormat: 'RAW' }, // RAW: a message starting with "=" is stored as text, never run as a formula
      },
    },
    {
      name: N.route,
      type: 'n8n-nodes-base.switch',
      typeVersion: 3.2,
      parameters: {
        rules: {
          values: ['send_and_alert', 'draft_and_alert', 'draft', 'review_alert'].map((a) => ({
            conditions: {
              options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
              conditions: [{ leftValue: G('action'), rightValue: a, operator: { type: 'string', operation: 'equals' } }],
              combinator: 'and',
            },
            renameOutput: true,
            outputKey: a,
          })),
        },
        options: {},
      },
    },
    {
      name: N.send,
      type: 'n8n-nodes-base.gmail',
      typeVersion: 2.1,
      parameters: {
        sendTo: G('email_to'),
        subject: G('email_subject'),
        emailType: 'text',
        message: G('email_body'),
        options: { appendAttribution: false },
      },
    },
    ...[N.draftHot, N.draftWarm].map((name) => ({
      name,
      type: 'n8n-nodes-base.gmail',
      typeVersion: 2.1,
      parameters: {
        resource: 'draft',
        subject: G('email_subject'),
        emailType: 'text',
        message: G('email_body'),
        options: { sendTo: G('email_to') },
      },
    })),
    {
      name: N.slack,
      type: 'n8n-nodes-base.slack',
      typeVersion: 2.2,
      parameters: {
        select: 'channel',
        channelId: { __rl: true, mode: 'name', value: G('slack_channel') },
        text: G('slack_text'), // built and escaped in the guard node
        otherOptions: { includeLinkToWorkflow: false },
      },
    },
  ];

  if (test) {
    // Sandbox has no Google/Slack accounts: those nodes pass data straight through when disabled.
    for (const n of nodes) {
      if ([N.reject, N.accept, N.lookup, N.reserve, N.log, N.send, N.draftHot, N.draftWarm, N.slack].includes(n.name)) n.disabled = true;
    }
  }

  const trigger = test ? 'Run test' : N.webhook;
  const link = (from, ...targets) => ({ [from]: { main: targets.map((t) => (Array.isArray(t) ? t : [t]).map((node) => ({ node, type: 'main', index: 0 }))) } });
  const connections = Object.assign(
    link(trigger, N.settings),
    link(N.settings, N.normalize),
    link(N.normalize, N.isValid),
    link(N.isValid, N.accept, N.reject),            // output 0 = true, 1 = false
    link(N.accept, N.lookup),
    link(N.lookup, N.dedupe),
    link(N.dedupe, N.isNew),
    link(N.isNew, N.reserve, []),                   // duplicates stop here
    link(N.reserve, N.request),
    link(N.request, N.needsAi),
    link(N.needsAi, N.claude, N.guard),             // true = call AI, false = pre-filtered
    link(N.claude, N.guard),
    link(N.guard, N.log),                           // log first: a Gmail/Slack failure can't lose the lead
    link(N.log, N.route),
    link(N.route, [N.send, N.slack], [N.draftHot, N.slack], N.draftWarm, N.slack),
  );

  // Left-to-right layout so the canvas reads like the README diagram.
  const columns = [
    [trigger], [N.settings], [N.normalize], [N.isValid], [N.accept, N.reject], [N.lookup], [N.dedupe], [N.isNew], [N.reserve],
    [N.request], [N.needsAi], [N.claude], [N.guard], [N.log], [N.route], [N.send, N.draftHot, N.draftWarm, N.slack],
  ];
  columns.forEach((col, x) => col.forEach((name, y) => {
    const node = nodes.find((n) => n.name === name);
    node.position = [x * 240, y * 200 - (col.length - 1) * 100];
    node.id = 'n' + String(x).padStart(2, '0') + String(y);
  }));

  return {
    name: test ? 'AI Lead Qualifier (sandbox test)' : 'AI Lead Qualification & Follow-up',
    nodes,
    connections,
    settings: { executionOrder: 'v1', saveDataErrorExecution: 'all' },
    pinData: {},
  };
}

export function buildErrorWorkflow() {
  return {
    name: 'AI Lead Qualifier – error alerts',
    nodes: [
      { id: 'e1', name: 'On workflow error', type: 'n8n-nodes-base.errorTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      {
        id: 'e2',
        name: 'Slack: workflow failed',
        type: 'n8n-nodes-base.slack',
        typeVersion: 2.2,
        position: [260, 0],
        parameters: {
          select: 'channel',
          channelId: { __rl: true, mode: 'name', value: '#sales-leads' },
          text: '=Lead workflow failed at node *{{ $json.execution.lastNodeExecuted }}*: {{ $json.execution.error.message }}\nExecution: {{ $json.execution.url }}\nCheck the Leads sheet: the lead may need manual follow-up.',
          otherOptions: { includeLinkToWorkflow: false },
        },
      },
    ],
    connections: { 'On workflow error': { main: [[{ node: 'Slack: workflow failed', type: 'main', index: 0 }]] } },
    settings: { executionOrder: 'v1' },
    pinData: {},
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(path.join(ROOT, 'workflow'), { recursive: true });
  writeFileSync(path.join(ROOT, 'workflow', 'ai-lead-qualifier.json'), JSON.stringify(buildLeadWorkflow(), null, 2) + '\n');
  writeFileSync(path.join(ROOT, 'workflow', 'error-alerts.json'), JSON.stringify(buildErrorWorkflow(), null, 2) + '\n');
  console.log('Wrote workflow/ai-lead-qualifier.json and workflow/error-alerts.json');
}
