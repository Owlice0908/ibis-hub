import { chromium } from 'playwright';
// Use system Chrome on Windows via WSL if Playwright's bundled Chromium
// lacks system libraries.
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, extname } from 'path';

const ROOT = process.cwd();
const PORT = 9876;

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
};

// Simple static file server
const server = createServer((req, res) => {
  const path = join(ROOT, req.url === '/' ? '/tests/visual/box-drawing-test.html' : req.url);
  if (existsSync(path)) {
    const ext = extname(path);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(readFileSync(path));
  } else {
    res.writeHead(404);
    res.end('Not found: ' + path);
  }
});

server.listen(PORT, async () => {
  console.log(`Server on http://localhost:${PORT}`);
  // Try system Chrome (Windows via WSL) if bundled Chromium fails
  let browser;
  try {
    browser = await chromium.launch();
  } catch {
    browser = await chromium.launch({
      executablePath: '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
    });
  }
  const page = await browser.newPage({ viewport: { width: 800, height: 500 } });

  await page.goto(`http://localhost:${PORT}`);

  // Wait for xterm to finish rendering
  await page.waitForFunction(() => window.__TEST_DONE__ === true, { timeout: 10000 });
  // Extra time for xterm to paint
  await page.waitForTimeout(1000);

  const screenshotPath = join(ROOT, 'tests/visual/box-drawing-result.png');
  await page.screenshot({ path: screenshotPath, fullPage: false });
  console.log(`Screenshot saved: ${screenshotPath}`);

  // Read status text
  const status = await page.$eval('#status', el => el.textContent);
  console.log('Status:', status);

  await browser.close();
  server.close();
});
