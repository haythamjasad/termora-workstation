'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildRdpFile, writeRdpFile, xServerArgs, xdmcpArgs } = require('../lib/remote-desktop.cjs');
const { sanitizeSessions } = require('../lib/state.cjs');

test('RDP files carry the chosen display, redirection and gateway settings', () => {
  const text = buildRdpFile({ host: 'desk.example.com', port: 3390, username: 'ana', domain: 'LAB', rdpSize: '1920x1080', rdpMultimon: true, rdpDrives: true, rdpPrinters: false, rdpAudio: 'remote', rdpMicrophone: true, rdpAdmin: true, rdpGateway: 'gw.example.com' });
  const lines = text.trim().split('\r\n');
  for (const line of ['full address:s:desk.example.com:3390', 'screen mode id:i:1', 'desktopwidth:i:1920', 'desktopheight:i:1080', 'username:s:LAB\\ana', 'use multimon:i:1', 'redirectclipboard:i:1', 'redirectprinters:i:0', 'drivestoredirect:s:*', 'audiomode:i:1', 'audiocapturemode:i:1', 'administrative session:i:1', 'gatewayhostname:s:gw.example.com', 'gatewayusagemethod:i:1']) assert.ok(lines.includes(line), line);
  const fit = buildRdpFile({ host: '10.0.0.5', rdpClipboard: false });
  assert.match(fit, /full address:s:10\.0\.0\.5:3389/); assert.match(fit, /dynamic resolution:i:1/); assert.match(fit, /redirectclipboard:i:0/); assert.match(fit, /gatewayusagemethod:i:4/);
  assert.match(buildRdpFile({ host: 'h', rdpSize: 'fullscreen' }), /screen mode id:i:2/);
  assert.doesNotMatch(fit, /password/i);
});

test('RDP settings cannot inject extra lines and the file is UTF-16 with a BOM', t => {
  assert.throws(() => buildRdpFile({ host: 'h', username: 'ana\r\nalternate shell:s:cmd.exe' }), /Username/);
  assert.throws(() => buildRdpFile({ host: 'bad host' }), /hostname/);
  assert.throws(() => buildRdpFile({ host: 'h', rdpGateway: 'gw\nx' }), /hostname/);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'termora-rdp-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = writeRdpFile({ host: 'desk', name: 'My desk' }, directory);
  const bytes = fs.readFileSync(file);
  assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe]);
  assert.match(bytes.subarray(2).toString('utf16le'), /^full address:s:desk:3389\r\n/);
});

test('X server and XDMCP arguments follow the X11 settings', () => {
  assert.deepEqual(xServerArgs({}), [':0', '-multiwindow', '-clipboard', '-wgl']);
  assert.deepEqual(xServerArgs({ display: 2, mode: 'fullscreen', clipboard: false, noAccessControl: true }), [':2', '-fullscreen', '-noclipboard', '-wgl', '-ac']);
  assert.deepEqual(xServerArgs({ mode: 'windowed' }), [':0', '-screen', '0', '1280x800', '-clipboard', '-wgl']);
  assert.deepEqual(xdmcpArgs({ host: 'unix.example.com', xdmcpDisplay: 3, xdmcpSize: '1600x900' }), [':3', '-query', 'unix.example.com', '-once', '-screen', '0', '1600x900', '-clipboard', '-wgl']);
  assert.deepEqual(xdmcpArgs({ host: 'h', port: 1777, xdmcpMode: 'fullscreen', xdmcpDisplay: 1 }), [':1', '-query', 'h', '-once', '-port', '1777', '-fullscreen', '-clipboard', '-wgl']);
  assert.throws(() => xdmcpArgs({ host: '-query evil' }), /hostname/);
});

test('saved sessions keep the RDP, VNC and XDMCP options', () => {
  const [rdp, xdmcp, vnc] = sanitizeSessions([
    { type: 'rdp', host: 'desk', rdpSize: '1366x768', rdpDrives: true, rdpClipboard: false, rdpAudio: 'none', domain: 'LAB', rdpGateway: 'gw' },
    { type: 'xdmcp', host: 'unix', xdmcpMode: 'fullscreen', xdmcpDisplay: 70 },
    { type: 'vnc', host: 'pi', vncViewer: 'external', viewOnly: true },
  ]);
  assert.equal(rdp.rdpSize, '1366x768'); assert.equal(rdp.rdpDrives, true); assert.equal(rdp.rdpClipboard, false); assert.equal(rdp.rdpAudio, 'none'); assert.equal(rdp.domain, 'LAB');
  assert.equal(xdmcp.port, 177); assert.equal(xdmcp.xdmcpMode, 'fullscreen'); assert.equal(xdmcp.xdmcpDisplay, 63);
  assert.equal(vnc.vncViewer, 'external'); assert.equal(vnc.viewOnly, true);
});
