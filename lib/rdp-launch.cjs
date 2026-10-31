const { spawn } = require('node:child_process');

function rdpFailure(output, code, signal) {
  if (/LEGACY provider failed|NTLM support not available|Failed to initialize digest md4/i.test(output)) return 'The bundled RDP authentication libraries could not load. Reinstall the complete Termora Mac build.';
  const reason = output.match(/ERRCONNECT_[A-Z0-9_]+/g)?.at(-1);
  if (reason === 'ERRCONNECT_CONNECT_CANCELLED') return null;
  if (reason === 'ERRCONNECT_CONNECT_FAILED') return 'RDP could not reach the server. Check the host, port, VPN connection, and Remote Desktop service.';
  if (reason === 'ERRCONNECT_LOGON_FAILURE' || reason === 'ERRCONNECT_AUTHENTICATION_FAILED') return 'RDP sign-in failed. Check the username, domain, password, and remote access permissions.';
  if (reason) return `RDP connection failed (${reason}).`;
  if (signal || code >= 128) return `The RDP client stopped unexpectedly (${signal || `exit ${code}`}).`;
  return null;
}

// Keep stderr private: only fixed descriptions and protocol error codes reach
// the renderer. Never return client diagnostics, credentials, or process args.
function startRdpClient(executable, args, { env = process.env, onFailure, startupTimeout = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false, timer, output = '';
    const child = spawn(executable, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env });
    const capture = data => { output = (output + data.toString()).slice(-65536); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    child.once('spawn', () => {
      child.unref();
      timer = setTimeout(() => { settled = true; resolve({ ok: true, launched: 'rdp', external: true }); }, startupTimeout);
    });
    child.once('error', () => {
      clearTimeout(timer);
      const error = new Error('The bundled RDP client could not start. Check the complete app installation and executable permissions.');
      if (!settled) { settled = true; reject(error); } else onFailure?.(error.message);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      const failure = rdpFailure(output, code, signal);
      if (!settled) {
        settled = true;
        if (failure) reject(new Error(failure));
        else resolve({ ok: true, cancelled: true, launched: 'rdp', external: true });
      } else if (failure) onFailure?.(failure);
    });
  });
}
module.exports = { startRdpClient, rdpFailure };
