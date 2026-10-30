// Settings for the Windows Remote Desktop client (.rdp files) and the VcXsrv
// X server (local X display and XDMCP sessions).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateHost, validPort } = require('./state.cjs');

const RDP_SIZES = new Set(['fit', 'fullscreen', '1024x768', '1280x720', '1280x1024', '1366x768', '1600x900', '1920x1080', '2560x1440']);
function plain(value, label, max = 256) {
  const text = String(value ?? '').trim();
  if (/[\r\n\0]/.test(text) || text.length > max) throw new Error(`${label} contains characters that cannot be used.`);
  return text;
}

// Builds .rdp file text; every value is validated so no setting line can be injected.
function buildRdpFile(config = {}) {
  const host = validateHost(config.host), port = validPort(config.port, 3389);
  const size = RDP_SIZES.has(config.rdpSize) ? config.rdpSize : 'fit';
  const username = plain(config.username, 'Username', 160), domain = plain(config.domain, 'Domain', 160);
  const lines = [`full address:s:${host}:${port}`, `screen mode id:i:${size === 'fullscreen' ? 2 : 1}`];
  if (/^\d+x\d+$/.test(size)) { const [width, height] = size.split('x'); lines.push(`desktopwidth:i:${width}`, `desktopheight:i:${height}`); }
  if (size === 'fit') lines.push('dynamic resolution:i:1', 'smart sizing:i:1');
  if (username) lines.push(`username:s:${domain ? `${domain}\\${username}` : username}`);
  lines.push(`use multimon:i:${config.rdpMultimon ? 1 : 0}`, `redirectclipboard:i:${config.rdpClipboard === false ? 0 : 1}`, `redirectprinters:i:${config.rdpPrinters ? 1 : 0}`, `drivestoredirect:s:${config.rdpDrives ? '*' : ''}`);
  lines.push(`audiomode:i:${({ local: 0, remote: 1, none: 2 })[config.rdpAudio] ?? 0}`, `audiocapturemode:i:${config.rdpMicrophone ? 1 : 0}`);
  if (config.rdpAdmin) lines.push('administrative session:i:1');
  if (config.rdpGateway) lines.push(`gatewayhostname:s:${validateHost(config.rdpGateway)}`, 'gatewayusagemethod:i:1', 'gatewaycredentialssource:i:4', 'gatewayprofileusagemethod:i:1', 'promptcredentialonce:i:1');
  else lines.push('gatewayusagemethod:i:4');
  lines.push('authentication level:i:2', 'prompt for credentials:i:0', 'autoreconnection enabled:i:1');
  return lines.join('\r\n') + '\r\n';
}

// mstsc reads UTF-16LE .rdp files; the file is removed once the client has started.
function writeRdpFile(config, directory = path.join(os.tmpdir(), 'termora-rdp')) {
  fs.mkdirSync(directory, { recursive: true });
  const name = String(config.name || config.host || 'session').replace(/[^\w.-]+/g, '_').slice(0, 60);
  const file = path.join(directory, `${name}-${crypto.randomBytes(4).toString('hex')}.rdp`);
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(buildRdpFile(config), 'utf16le')]), { mode: 0o600 });
  return file;
}

function x11Settings(settings = {}) {
  return { display: Math.max(0, Math.min(63, Math.floor(Number(settings.display) || 0))), mode: ['multiwindow', 'fullscreen', 'windowed'].includes(settings.mode) ? settings.mode : 'multiwindow', clipboard: settings.clipboard !== false, noAccessControl: Boolean(settings.noAccessControl) };
}

// Local X display for SSH X11 forwarding.
function xServerArgs(settings) {
  const x = x11Settings(settings);
  const args = [`:${x.display}`, x.mode === 'fullscreen' ? '-fullscreen' : x.mode === 'windowed' ? '-screen' : '-multiwindow'];
  if (x.mode === 'windowed') args.push('0', '1280x800');
  args.push(x.clipboard ? '-clipboard' : '-noclipboard', '-wgl');
  if (x.noAccessControl) args.push('-ac');
  return args;
}

// XDMCP: VcXsrv asks the remote display manager for a login screen.
function xdmcpArgs(config = {}, settings = {}) {
  const host = validateHost(config.host), port = validPort(config.port, 177);
  const display = Math.max(0, Math.min(63, Math.floor(Number(config.xdmcpDisplay ?? (x11Settings(settings).display + 1)) || 1)));
  const args = [`:${display}`, '-query', host, '-once'];
  if (port !== 177) args.push('-port', String(port));
  args.push(config.xdmcpMode === 'fullscreen' ? '-fullscreen' : '-screen', ...(config.xdmcpMode === 'fullscreen' ? [] : ['0', /^\d{3,4}x\d{3,4}$/.test(config.xdmcpSize || '') ? config.xdmcpSize : '1280x800']));
  args.push(x11Settings(settings).clipboard ? '-clipboard' : '-noclipboard', '-wgl');
  return args;
}

module.exports = { buildRdpFile, writeRdpFile, xServerArgs, xdmcpArgs, x11Settings, RDP_SIZES };
