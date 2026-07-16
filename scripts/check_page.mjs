import { chromium } from '/Users/mikelun/Work/lizard-minecraft/node_modules/playwright/index.mjs';
import { writeFileSync } from 'fs';

const browser = await chromium.launch({
  headless: false, // need non-headless for WebGL
  args: [
    '--enable-webgl',
    '--use-gl=egl',
    '--enable-gpu',
    '--no-sandbox',
    '--disable-web-security'
  ]
});

const context = await browser.newContext({
  viewport: { width: 1280, height: 720 }
});

const page = await context.newPage();

// Collect console messages
const consoleLogs = [];
const consoleErrors = [];

page.on('console', msg => {
  const text = msg.text();
  consoleLogs.push({ type: msg.type(), text });
  if (text.includes('[AllObjects]')) {
    console.log(`[AllObjects] MSG: ${text}`);
  }
});

page.on('pageerror', err => {
  consoleErrors.push(err.message);
  console.log(`PAGE ERROR: ${err.message}`);
});

console.log('Navigating to http://localhost:5173...');
await page.goto('http://localhost:5173', { waitUntil: 'networkidle', timeout: 30000 });

// Wait for the game to initialize and load
console.log('Waiting for game to load (10 seconds)...');
await page.waitForTimeout(10000);

// Take first screenshot
await page.screenshot({ path: '/tmp/minecraft_screenshot_1.png' });
console.log('Screenshot 1 taken');

// Read HUD text from the DOM or canvas
// Try to get text from any HUD element
const hudInfo = await page.evaluate(() => {
  // Look for HUD elements
  const hudElements = document.querySelectorAll('[id*="hud"], [class*="hud"], [id*="fps"], [class*="fps"]');
  const texts = [];
  hudElements.forEach(el => texts.push(el.textContent));

  // Also check for any overlay divs
  const allDivs = document.querySelectorAll('div, span, p');
  allDivs.forEach(el => {
    const text = el.textContent.trim();
    if (text && (text.includes('FPS') || text.includes('fps') || text.includes('Draw') || text.includes('Triangle'))) {
      texts.push(text);
    }
  });

  return texts;
});

console.log('HUD elements found:', hudInfo);

// Print all [AllObjects] logs
console.log('\n=== ALL CONSOLE LOGS ===');
consoleLogs.forEach(log => {
  if (log.text.includes('[AllObjects]') || log.type === 'error' || log.text.includes('Error')) {
    console.log(`[${log.type}] ${log.text}`);
  }
});

console.log('\n=== [AllObjects] MESSAGES ===');
const allObjectsMsgs = consoleLogs.filter(l => l.text.includes('[AllObjects]'));
if (allObjectsMsgs.length === 0) {
  console.log('No [AllObjects] messages found');
} else {
  allObjectsMsgs.forEach(m => console.log(m.text));
}

console.log('\n=== JS ERRORS ===');
if (consoleErrors.length === 0) {
  console.log('No JS errors');
} else {
  consoleErrors.forEach(e => console.log(e));
}

console.log('\n=== ERROR CONSOLE MSGS ===');
const errorMsgs = consoleLogs.filter(l => l.type === 'error');
errorMsgs.forEach(m => console.log(m.text));

// Try clicking canvas to lock pointer (won't actually lock in headless but let's try)
const canvas = await page.$('canvas');
if (canvas) {
  console.log('\nCanvas found, clicking...');
  try {
    await canvas.click();
    await page.waitForTimeout(1000);
  } catch(e) {
    console.log('Click error:', e.message);
  }
}

// Press WASD keys to move
console.log('Pressing WASD to move...');
await page.keyboard.down('w');
await page.waitForTimeout(500);
await page.keyboard.up('w');
await page.keyboard.down('a');
await page.waitForTimeout(500);
await page.keyboard.up('a');
await page.waitForTimeout(2000);

// Take second screenshot after movement
await page.screenshot({ path: '/tmp/minecraft_screenshot_2.png' });
console.log('Screenshot 2 taken');

// Print all console logs for reference
console.log('\n=== ALL CONSOLE LOGS (last 50) ===');
consoleLogs.slice(-50).forEach(l => console.log(`[${l.type}] ${l.text}`));

await browser.close();
