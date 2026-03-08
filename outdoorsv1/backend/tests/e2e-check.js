import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, '..', 'src', 'index.js');

console.log('Starting server...');
const server = spawn('node', [serverPath], {
  cwd: join(__dirname, '..'),
  stdio: ['pipe', 'pipe', 'pipe'],
});

let serverOutput = '';
server.stdout.on('data', (d) => { serverOutput += d.toString(); });
server.stderr.on('data', (d) => { serverOutput += d.toString(); });

async function test(label, url) {
  try {
    const res = await fetch(url);
    const text = await res.text();
    const ok = res.status < 400;
    console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label} (HTTP ${res.status}, ${text.length} bytes)`);
    return { ok, status: res.status, length: text.length, text };
  } catch (e) {
    console.log(`  FAIL ${label}: ${e.message}`);
    return { ok: false };
  }
}

setTimeout(async () => {
  console.log('\nServer output:');
  console.log(serverOutput);
  console.log('\nRunning endpoint tests:');

  const results = [];
  results.push(await test('Dashboard HTML', 'http://localhost:3457/'));
  results.push(await test('Socket.IO client', 'http://localhost:3457/socket.io/socket.io.js'));
  results.push(await test('main.js', 'http://localhost:3457/src/main.js'));
  results.push(await test('styles.css', 'http://localhost:3457/src/styles.css'));
  results.push(await test('/api/status', 'http://localhost:3457/api/status'));
  results.push(await test('/api/config', 'http://localhost:3457/api/config'));

  // QR endpoint: 404 is expected when no QR has been generated yet
  const qr = await test('/api/qr', 'http://localhost:3457/api/qr');
  console.log(`  INFO /api/qr returns 404 when no QR scanned yet (expected)`);

  // Check specific content
  const status = await fetch('http://localhost:3457/api/status').then(r => r.json());
  console.log(`\n  Connection status: ${status.status}`);

  const html = results[0]?.text || '';
  console.log(`  HTML has qr-image tag: ${html.includes('id="qr-image"')}`);
  console.log(`  HTML loads socket.io: ${html.includes('socket.io.js')}`);
  console.log(`  HTML loads main.js: ${html.includes('src/main.js')}`);

  const mainJs = results[2]?.text || '';
  console.log(`  main.js has qr handler: ${mainJs.includes("socket.on('qr'")}`);
  console.log(`  main.js uses img src: ${mainJs.includes('qrImage.src')}`);

  const passed = results.filter(r => r.ok).length;
  console.log(`\nResults: ${passed}/${results.length} endpoints OK`);

  server.kill();
  process.exit(passed === results.length ? 0 : 1);
}, 7000);
