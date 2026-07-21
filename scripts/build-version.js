// Generates a date-based build number and runs electron-builder with it.
// Semantic version stays in package.json ("version"); this only sets the
// buildVersion, so every build is uniquely stamped, e.g.
//   version 0.1.0, buildVersion 0.1.0.2026052814  (YYYYMMDDHH)
//
// Platform comes from the first CLI arg: --win (default) or --mac.
// Building --mac only works on macOS (Apple toolchain requirement).
const { execSync } = require('node:child_process');
const pkg = require('../package.json');

const arg = process.argv[2] || '--win';
const platform = arg === '--mac' ? '--mac' : '--win';

const d = new Date();
const p = (n, w = 2) => String(n).padStart(w, '0');
const stamp =
  `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
  `${p(d.getHours())}${p(d.getMinutes())}`;

// electron-builder wants buildVersion as a numeric-ish string; append the
// stamp to the semantic version's numeric core.
const buildVersion = `${pkg.version}.${stamp}`;

console.log(`Building ${pkg.productName || pkg.name}`);
console.log(`  platform     : ${platform}`);
console.log(`  version      : ${pkg.version}`);
console.log(`  buildVersion : ${buildVersion}`);

// --publish never: in CI, electron-builder sees the git tag and tries to
// publish to GitHub itself (fails without GH_TOKEN). The workflow's
// action-gh-release step handles publishing instead.
execSync(`electron-builder ${platform} --publish never -c.buildVersion=${buildVersion}`, {
  stdio: 'inherit',
  env: process.env,
});
