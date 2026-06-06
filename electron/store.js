// Tiny JSON store for agent configs and projects, kept in Electron's userData
// folder so it persists across restarts and survives app updates.
const fs = require('fs');
const path = require('path');

function agentsPath(app) {
  return path.join(app.getPath('userData'), 'agents.json');
}

function projectsPath(app) {
  return path.join(app.getPath('userData'), 'projects.json');
}

function loadAgents(app) {
  try {
    const raw = fs.readFileSync(agentsPath(app), 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveAgents(app, agents) {
  fs.writeFileSync(agentsPath(app), JSON.stringify(agents, null, 2), 'utf8');
  return agents;
}

function loadProjects(app) {
  try {
    const raw = fs.readFileSync(projectsPath(app), 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveProjects(app, projects) {
  fs.writeFileSync(projectsPath(app), JSON.stringify(projects, null, 2), 'utf8');
  return projects;
}

module.exports = { loadAgents, saveAgents, loadProjects, saveProjects };
