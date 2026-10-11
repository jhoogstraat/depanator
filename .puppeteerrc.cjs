const { join } = require('node:path');
module.exports = {
  cacheDirectory: join(__dirname, '.depanator', 'puppeteer'),
  'chrome-headless-shell': { skipDownload: true },
};
