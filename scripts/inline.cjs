// Extracts the @n8n-begin/@n8n-end blocks from src/ files.
// Used by the build script (to write Code nodes) AND by the tests (to load
// exactly the code that ends up inside n8n).
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');

// Which source files make up each Code node, in order.
const NODE_SOURCES = {
  settings: ['settings.js'],
  normalize: ['normalize.js'],
  request: ['rules.js', 'request.js'],
  guard: ['rules.js', 'request.js', 'guard.js'],
};

function block(file) {
  const text = fs.readFileSync(path.join(SRC, file), 'utf8');
  const m = text.match(/\/\/ @n8n-begin\n([\s\S]*?)\/\/ @n8n-end/);
  if (!m) throw new Error('No @n8n-begin/@n8n-end block in ' + file);
  return m[1].trim();
}

function nodeCode(name) {
  return NODE_SOURCES[name].map(block).join('\n\n');
}

// Evaluate a node's code and return the named functions/constants (tests only).
function load(name, exportNames) {
  const code = nodeCode(name) + '\nreturn { ' + exportNames.join(', ') + ' };';
  return new Function(code)();
}

module.exports = { nodeCode, load, NODE_SOURCES };
