// Renders session.html to PNG frames for demo.mp4.
//
//   npm i --no-save playwright-core
//   node capture.mjs stills 0.6 3.5 12   # one PNG per second listed, for review
//   node capture.mjs frames 30           # every frame at 30 fps
//   ffmpeg -framerate 30 -i frames/f-%05d.png -vf "scale=1200:1200:flags=lanczos,format=yuv420p" \
//     -c:v libx264 -preset slow -crf 17 -movflags +faststart demo.mp4
//
// Mac only: the page uses SF Mono from Terminal.app, and the Chromium path is
// Playwright's cache. Set PAGE to render a different page.
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pageUrl = "file://" + path.join(here, process.env.PAGE ?? "session.html");
const exe = path.join(
  os.homedir(),
  "Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
);
const [mode, ...rest] = process.argv.slice(2);
const out = path.join(process.cwd(), mode);
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  args: ["--allow-file-access-from-files"],
});
const page = await browser.newPage({
  viewport: { width: 1200, height: 1200 },
  deviceScaleFactor: 2,
});
await page.goto(pageUrl);
await page.evaluate(() => window.ready);

if (mode === "stills") {
  for (const t of rest.map(Number)) {
    await page.evaluate((t) => window.seek(t), t);
    await page.screenshot({ path: path.join(out, `t-${t}.png`) });
  }
} else {
  const fps = Number(rest[0] ?? 30);
  const duration = await page.evaluate(() => window.duration);
  const n = Math.round(duration * fps);
  for (let i = 0; i < n; i++) {
    await page.evaluate((t) => window.seek(t), i / fps);
    await page.screenshot({ path: path.join(out, `f-${String(i).padStart(5, "0")}.png`) });
  }
  console.log(`${n} frames at ${fps} fps`);
}
await browser.close();
