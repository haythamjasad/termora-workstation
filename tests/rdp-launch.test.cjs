const test = require('node:test');
const assert = require('node:assert/strict');
const { startRdpClient, rdpFailure } = require('../lib/rdp-launch.cjs');

test('RDP launch rejects early connection failure without exposing client diagnostics', async () => {
  await assert.rejects(startRdpClient(process.execPath, ['-e', "console.error('private-fixture ERRCONNECT_CONNECT_FAILED');process.exit(141)"], { startupTimeout: 1000 }), error => /could not reach/.test(error.message) && !error.message.includes('private-fixture'));
});
test('RDP launch reports failures occurring after startup', { timeout: 4000 }, async () => {
  let notify;
  const failure = new Promise(resolve => { notify = resolve; });
  const result = await startRdpClient(process.execPath, ['-e', "setTimeout(()=>{console.error('ERRCONNECT_LOGON_FAILURE');process.exit(142)},200)"], { startupTimeout: 30, onFailure: notify });
  assert.equal(result.ok, true);
  assert.match(await failure, /sign-in failed/);
});
test('RDP cancellation and normal disconnect do not report a failed connection', async () => {
  assert.equal(rdpFailure('ERRCONNECT_CONNECT_CANCELLED', 145), null);
  assert.equal(rdpFailure('', 0), null);
  const result = await startRdpClient(process.execPath, ['-e', 'process.exit(0)'], { startupTimeout: 1000 });
  assert.equal(result.cancelled, true);
});
test('RDP dependency and spawn errors are actionable and do not expose raw output', async () => {
  assert.match(rdpFailure('OpenSSL LEGACY provider failed to load', 145), /authentication libraries/);
  await assert.rejects(startRdpClient('/__termora_missing_rdp_fixture__', []), /could not start/);
});
