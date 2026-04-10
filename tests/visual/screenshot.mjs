import { webkit } from 'playwright';
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = join(fileURLToPath(import.meta.url), '..');
const DIST = join(__dirname, 'dist');
const PORT = 9876;
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
};

const server = createServer((req, res) => {
  const path = join(DIST, req.url === '/' ? 'index.html' : req.url);
  if (existsSync(path)) {
    res.writeHead(200, { 'Content-Type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(readFileSync(path));
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

server.listen(PORT, async () => {
  console.log(`Serving built test at http://localhost:${PORT}`);
  const browser = await webkit.launch();
  const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
  page.on('console', msg => console.log('BROWSER:', msg.type(), msg.text()));
  page.on('pageerror', err => console.log('PAGE ERROR:', err.message));

  await page.goto(`http://localhost:${PORT}`);
  try {
    await page.waitForFunction(() => window.__TEST_DONE__ === true, { timeout: 15000 });
    console.log('Test completed successfully');
  } catch {
    console.log('WARNING: __TEST_DONE__ not set, taking screenshot anyway');
  }
  await page.waitForTimeout(2000);

  const screenshotPath = join(__dirname, 'box-drawing-result.png');
  await page.screenshot({ path: screenshotPath });
  console.log(`Screenshot saved: ${screenshotPath}`);

  try {
    const status = await page.$eval('#status', el => el.textContent);
    console.log('Status:', status);
  } catch {}

  await browser.close();
  server.close();
});
