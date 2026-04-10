import { webkit } from 'playwright';
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
  const browser = await webkit.launch();
  const page = await browser.newPage({ viewport: { width: 800, height: 500 } });

  // Capture console errors
  page.on('console', msg => console.log('BROWSER:', msg.type(), msg.text()));
  page.on('pageerror', err => console.log('PAGE ERROR:', err.message));

  await page.goto(`http://localhost:${PORT}`);

  // Wait for test done or timeout after 15s, take screenshot either way
  try {
    await page.waitForFunction(() => window.__TEST_DONE__ === true, { timeout: 15000 });
  } catch {
    console.log('WARNING: __TEST_DONE__ not set, taking screenshot anyway');
  }
  await page.waitForTimeout(2000);

  const screenshotPath = join(ROOT, 'tests/visual/box-drawing-result.png');
  await page.screenshot({ path: screenshotPath, fullPage: false });
  console.log(`Screenshot saved: ${screenshotPath}`);

  try {
    const status = await page.$eval('#status', el => el.textContent);
    console.log('Status:', status);
  } catch {}

  await browser.close();
  server.close();
});
