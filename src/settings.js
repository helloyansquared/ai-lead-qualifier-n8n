// The one place a client edits. Becomes the "⚙️ Settings" Code node.

// @n8n-begin
const SETTINGS = {
  // About the business (the AI scores leads against this)
  brandName: 'Acme Automation Studio',
  businessDescription: 'Custom AI automations and workflow integrations (n8n, CRM, email, AI chatbots) for small and mid-sized businesses.',
  idealCustomer: 'Owners or managers of small/mid-sized companies (5-200 staff) with a repetitive process to automate and a budget of $1,000+.',
  senderName: 'Alex from Acme',

  // Routing
  hotThreshold: 75,   // score >= this -> Slack alert + reply draft
  warmThreshold: 45,  // score >= this -> reply draft only
  autoSendHotReplies: false, // true = send hot replies automatically (only when nothing was flagged for review)

  // AI + cost control
  anthropicBaseUrl: 'https://api.anthropic.com', // the demo points this at the mock server
  model: 'claude-haiku-5-5',
  maxOutputTokens: 600,
  maxReplyChars: 1200,

  // Destinations
  slackChannel: '#sales-leads',
};
// @n8n-end

module.exports = { SETTINGS };
