// Tiny JSON store for agent configs, kept in Electron's userData folder so
// it persists across restarts and survives app updates.
const fs = require('fs');
const path = require('path');

function filePath(app) {
  return path.join(app.getPath('userData'), 'agents.json');
}

function loadAgents(app) {
  try {
    const raw = fs.readFileSync(filePath(app), 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveAgents(app, agents) {
  fs.writeFileSync(filePath(app), JSON.stringify(agents, null, 2), 'utf8');
  return agents;
}

module.exports = { loadAgents, saveAgents };
