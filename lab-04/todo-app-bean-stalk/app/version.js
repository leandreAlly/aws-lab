const fs = require('node:fs');
const path = require('node:path');

function readBuildInfo() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'build-info.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function getVersionInfo() {
  const { version } = require('./package.json');
  const build = readBuildInfo();

  return {
    version,
    versionLabel: build.versionLabel || 'local-dev',
    commit: build.commit || 'unknown',
    builtAt: build.builtAt || null,
    environment: process.env.NODE_ENV || 'development',
  };
}

module.exports = { getVersionInfo };
