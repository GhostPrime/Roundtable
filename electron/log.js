// Tiny append-only file logger for the main process. One line per event:
//   2026-06-12T18:04:11.512Z [call] → Claude (cli/claude.cmd) msgs=4
// Lives in Electron's userData folder (shown via the 📜 Log button).
// Rotates once at ~1 MB: current file becomes roundtable.log.old.

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 1024 * 1024;
let logPath = null;

function initLog(app) {
  try {
    logPath = path.join(app.getPath('userData'), 'roundtable.log');
    log('app', `started v${app.getVersion()} (electron ${process.versions.electron}, ${process.platform})`);
  } catch { /* logging must never break the app */ }
}

function log(tag, msg) {
  if (!logPath) return;
  try {
    try {
      if (fs.statSync(logPath).size > MAX_BYTES) {
        const old = logPath + '.old';
        try { fs.unlinkSync(old); } catch { /* none yet */ }
        fs.renameSync(logPath, old);
      }
    } catch { /* no file yet */ }
    fs.appendFileSync(logPath, `${new Date().toISOString()} [${tag}] ${msg}\n`, 'utf8');
  } catch { /* never throw from the logger */ }
}

function getLogPath() {
  return logPath;
}

module.exports = { initLog, log, getLogPath };
