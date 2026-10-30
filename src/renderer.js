import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import RFB from '@novnc/novnc';
import { classicIcon } from './classic-icons.js';
import uiReference from './ui-reference.json';
import { configurationMarkup } from './classic-settings.js';
import { createHighlighter } from '../lib/highlight.cjs';
import './styles.css';

const paths = {
  plus: '<path d="M12 5v14M5 12h14"/>', close: '<path d="m6 6 12 12M18 6 6 18"/>',
  minus: '<path d="M5 12h14"/>', maximize: '<rect x="5" y="5" width="14" height="14" rx="1"/>',
  terminal: '<path d="m5 7 5 5-5 5m8 0h6"/><rect x="2.5" y="3.5" width="19" height="17" rx="3"/>',
  folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  'folder-plus': '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M12 10v7m-3-3.5h6"/>',
  route: '<circle cx="6" cy="5" r="2"/><circle cx="18" cy="19" r="2"/><path d="M8 5h8a4 4 0 0 1 0 8H8a4 4 0 0 0 0 8h8M6 7v10"/>',
  code: '<path d="m8 7-5 5 5 5m8-10 5 5-5 5m-2-14-4 18"/>',
  activity: '<path d="M2 12h5l3-8 4 16 3-8h5"/>',
  import: '<path d="M12 3v12m-4-4 4 4 4-4M5 15v5h14v-5"/>',
  export: '<path d="M12 15V3m-4 4 4-4 4 4M5 15v5h14v-5"/>',
  upload: '<path d="M12 16V4m-4 4 4-4 4 4M4 16v4h16v-4"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4"/>',
  settings: '<path d="m9 3-.7 3-2.7 1-2.8-.8-1.3 3L4 11v3l-2.5 1.8 1.3 3 2.8-.8 2.7 1L9 22h6l.7-3 2.7-1 2.8.8 1.3-3L20 14v-3l2.5-1.8-1.3-3-2.8.8-2.7-1L15 3Z" transform="translate(0 -1) scale(.95)"/><circle cx="11.5" cy="11" r="3"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v.1"/>',
  split: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
  broadcast: '<path d="M6 5a9 9 0 0 0 0 14M18 5a9 9 0 0 1 0 14M9 8a5 5 0 0 0 0 8m6-8a5 5 0 0 1 0 8"/><circle cx="12" cy="12" r="1.5"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1"/>',
  shield: '<path d="m12 2 8 3v6c0 5-4 8-8 11-4-3-8-6-8-11V5Z"/><path d="m8 12 3 3 5-6"/>',
  server: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.1M7 17.5h.1m4-11h6m-6 11h6"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8m-4-4v4"/>',
  up: '<path d="M12 20V4m-6 6 6-6 6 6"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8m-8 4h6"/>',
  edit: '<path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 15Z"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  play: '<path d="m8 4 13 8-13 8Z"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l4 2"/>',
  link: '<path d="m10 13 4-4m-7 5-2 2a3 3 0 0 0 4 4l4-4a3 3 0 0 0 0-4m-2-2a3 3 0 0 1 0-4l4-4a3 3 0 0 1 4 4l-2 2"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
};
const svg = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.terminal}</svg>`;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const id = () => globalThis.crypto.randomUUID();
const state = { sessions: [], settings: { theme: 'dark', fontSize: 14, fontFamily: 'Cascadia Code, Consolas, monospace', scrollback: 10000 }, macros: [], tunnels: [], terminals: new Map(), order: [], active: null, home: true, layout: 1, broadcast: false, files: false, filePath: '', fileParent: '', fileId: null, capabilities: {}, buffered: new Map(), exited: new Map(), appName: 'Termora', platform: 'win32', version: '0.1.0', fileRequest: 0 };
let bridge;
const detachedMode = location.hash === '#detached';
let modalCleanup = null;
let contextMenu = null;

function icons(root = document) {
  $$('[data-classic]', root).forEach(node => { node.innerHTML = classicIcon(node.dataset.classic); });
  $$('[data-icon]', root).forEach((node) => { node.innerHTML = svg(node.dataset.icon); node.removeAttribute('data-icon'); });
}
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function iconNode(name) { const node = element('span', 'inline-icon'); node.innerHTML = svg(name); return node; }
function toast(message, error = false) {
  const node = element('div', `toast${error ? ' error' : ''}`);
  node.append(iconNode(error ? 'info' : 'check'), element('span', '', message));
  $('#toasts').append(node);
  setTimeout(() => node.remove(), error ? 8500 : 4500);
}
function message(error) { return error?.message || String(error); }
function handle(action) { return async (event) => { try { await action(event); } catch (error) { toast(message(error), true); } }; }
function on(selector, event, action, root = document) { $(selector, root)?.addEventListener(event, handle(action)); }
function typeIcon(type) { return ['rdp', 'vnc'].includes(type) ? 'monitor' : ['ssh', 'sftp', 'ftp', 'ftps'].includes(type) ? 'server' : type === 'wsl' ? 'code' : 'terminal'; }
function sessionTitle(session) { return session.name || session.label || (session.type === 'local' ? (state.platform === 'darwin' ? 'Local terminal' : session.shell === 'cmd' ? 'Command Prompt' : 'PowerShell') : session.type === 'wsl' ? 'Linux / WSL' : session.host || session.path || 'Terminal'); }
function capability(name) { const value = state.capabilities[name]; return typeof value === 'object' ? value.available !== false : value !== false; }
function saveButton(button, busy) { button.disabled = busy; button.classList.toggle('loading', busy); }
function errorInDialog(error) { const node = $('.dialog-error'); if (node) { node.textContent = message(error); node.classList.add('error-box'); } else toast(message(error), true); }
function modal({ title, subtitle = '', icon = 'terminal', body = '', footer = '', wide = false, bodyClass = '' }) {
  closeModal();
  const dialog = $('#app-dialog');
  dialog.classList.remove('session-dialog','ssh-session-dialog','session-chooser','configuration-dialog','services-dialog','tunnels-dialog','macros-dialog');
  dialog.style.width = wide ? '760px' : '620px';
  $('#dialog-content').innerHTML = `<header class="dialog-header"><div class="dialog-heading-icon">${svg(icon)}</div><div><h2 class="dialog-title">${escapeHtml(title)}</h2><p class="dialog-subtitle">${escapeHtml(subtitle)}</p></div><button class="icon-button" id="dialog-close" aria-label="Close dialog">×</button></header><div class="dialog-body ${bodyClass}"><div class="dialog-error" role="alert"></div>${body}</div>${footer ? `<footer class="dialog-footer">${footer}</footer>` : ''}`;
  on('#dialog-close', 'click', closeModal);
  on('#dialog-cancel', 'click', closeModal);
  dialog.showModal();
  return dialog;
}
function closeModal() {
  if (modalCleanup) { const cleanup = modalCleanup; modalCleanup = null; cleanup(); }
  if ($('#app-dialog').open) $('#app-dialog').close();
}
function confirmAction(title, description, label = 'Continue', danger = false) {
  return new Promise((resolve) => {
    modal({ title, subtitle: description, icon: 'info', body: '', footer: `<button class="button secondary" id="dialog-cancel">Cancel</button><button class="button ${danger ? 'danger' : 'primary'}" id="confirm-action">${escapeHtml(label)}</button>` });
    let settled = false;
    modalCleanup = () => { if (!settled) resolve(false); };
    on('#confirm-action', 'click', () => { settled = true; closeModal(); resolve(true); });
  });
}
function promptValue(title, label, initial = '') {
  return new Promise((resolve) => {
    modal({ title, icon: 'edit', body: `<form id="prompt-form"><div class="field"><label for="prompt-value">${escapeHtml(label)}</label><input id="prompt-value" value="${escapeHtml(initial)}" required autocomplete="off"></div></form>`, footer: '<button class="button secondary" id="dialog-cancel">Cancel</button><button class="button primary" type="submit" form="prompt-form">Save</button>' });
    let settled = false;
    modalCleanup = () => { if (!settled) resolve(null); };
    on('#prompt-form', 'submit', (event) => { event.preventDefault(); const value = $('#prompt-value').value.trim(); if (!value) return; settled = true; closeModal(); resolve(value); });
    $('#prompt-value').select();
  });
}
const collapsedFolders = new Set();
let selectedSessionId = null;
const sessionGlyphs = { ssh: 'ssh', sftp: 'sftp', ftp: 'ftp', ftps: 'ftp', telnet: 'telnet', rdp: 'rdp', vnc: 'vnc', serial: 'serial', local: 'shell', wsl: 'shell', rsh: 'rsh', rlogin: 'rsh', mosh: 'mosh', xdmcp: 'xdmcp', file: 'browser', browser: 'browser', s3: 's3' };
function sessionGlyph(type) { return sessionGlyphs[type] || 'shell'; }
function treeRow(level, expander, glyph, label, title) {
  const row = element('div', `session-row level-${level}`); row.tabIndex = 0; row.setAttribute('role', 'treeitem'); row.title = title;
  const icon = element('span', 'session-type-icon'); icon.innerHTML = classicIcon(glyph);
  row.append(element('span', 'session-expander', expander), icon, element('span', 'session-row-name', label));
  return row;
}
function sessionTreeRow(session, level) {
  const row = treeRow(level, '', sessionGlyph(session.type), sessionTitle(session), `${sessionTitle(session)}${session.host ? ` · ${session.username ? `${session.username}@` : ''}${session.host}` : ''}`);
  const select = () => { selectedSessionId = session.id; $$('#sessions-list .session-row.selected').forEach(node => node.classList.remove('selected')); row.classList.add('selected'); };
  row.classList.toggle('selected', session.id === selectedSessionId);
  row.addEventListener('click', select);
  row.addEventListener('dblclick', handle(() => connect(session)));
  row.addEventListener('keydown', handle(event => { if (event.key === 'Enter') return connect(session); if (event.key === 'Delete') return deleteSavedSession(session); if (event.key === 'F2') return sessionDialog(session); }));
  row.addEventListener('contextmenu', (event) => { event.preventDefault(); select(); showContextMenu(event.clientX, event.clientY, [
    ['Execute', 'session', () => connect(session)], null,
    ['Edit session', 'edit', () => sessionDialog(session)], ['Duplicate session', 'duplicate', () => duplicateSavedSession(session)], ['Delete session', 'remove', () => deleteSavedSession(session)], null,
    ['New session', 'add', () => sessionDialog()],
  ], true); });
  return row;
}
// Group launch: open each session in turn, reporting failures without stopping.
async function launchSessions(sessions) {
  let failed = 0;
  for (const session of sessions) { try { await connect(session); } catch (error) { failed++; toast(`${sessionTitle(session)}: ${message(error)}`, true); } }
  toast(failed ? `Opened ${sessions.length - failed} of ${sessions.length} sessions.` : `Opened ${sessions.length} sessions.`, Boolean(failed));
}
async function duplicateSavedSession(session) {
  const copy = { ...session, id: id(), name: `${sessionTitle(session)} (copy)`, lastUsed: 0 };
  const index = state.sessions.findIndex(s => s.id === session.id);
  const next = [...state.sessions]; next.splice(index + 1, 0, copy);
  state.sessions = await bridge.saveSessions(next); selectedSessionId = copy.id; renderSessions();
}
async function deleteSavedSession(session) {
  const confirmed = await confirmAction('Delete this connection?', `“${sessionTitle(session)}” will be removed from saved sessions. Open terminals will stay connected.`, 'Delete connection', true); if (!confirmed) return;
  state.sessions = await bridge.saveSessions(state.sessions.filter(s => s.id !== session.id)); renderSessions(); toast('Connection deleted.');
}
function renderSessions() {
  const query = $('#session-filter').value.toLowerCase().trim();
  const sessions = state.sessions.filter(s => [s.name, s.host, s.username, s.group, s.folder, s.type].join(' ').toLowerCase().includes(query));
  $('#session-count').textContent = state.sessions.length;
  $('#theme-chooser').classList.toggle('hidden', state.sessions.length > 0);
  $('#home-session-search').classList.toggle('hidden', state.sessions.length === 0);
  $('.recent-header').classList.toggle('hidden', state.sessions.length === 0);
  // MobaXterm-style tree: "User sessions" is the root, bookmark folders nest
  // under it, and unfiled sessions sit directly below the folders.
  const list = $('#sessions-list'); list.replaceChildren(); list.setAttribute('role', 'tree');
  if (!sessions.length && query) list.append(element('div', 'sidebar-empty', 'No matching sessions.'));
  const folders = new Map(), loose = [];
  sessions.forEach((session) => { const folder = session.group || session.folder; if (!folder) { loose.push(session); return; } if (!folders.has(folder)) folders.set(folder, []); folders.get(folder).push(session); });
  folders.forEach((items, name) => {
    const open = Boolean(query) || !collapsedFolders.has(name);
    const folder = treeRow(1, open ? '▾' : '▸', 'files', name, `${name} (${items.length})`); folder.classList.add('session-folder'); folder.setAttribute('aria-expanded', String(open));
    const toggle = () => { if (collapsedFolders.has(name)) collapsedFolders.delete(name); else collapsedFolders.add(name); renderSessions(); };
    folder.addEventListener('click', (event) => { if (event.target.closest('.session-expander')) toggle(); });
    folder.addEventListener('dblclick', toggle);
    folder.addEventListener('keydown', (event) => { if (event.key === 'Enter' || (event.key === 'ArrowLeft' && open) || (event.key === 'ArrowRight' && !open)) toggle(); });
    folder.addEventListener('contextmenu', (event) => { event.preventDefault(); showContextMenu(event.clientX, event.clientY, [
      [`Open all ${items.length} sessions`, 'session', () => launchSessions(items)], null,
      [open ? 'Collapse folder' : 'Expand folder', 'files', toggle], ['New session', 'add', () => sessionDialog(null, null, { group: name })],
    ], true); });
    list.append(folder);
    if (open) items.forEach(session => list.append(sessionTreeRow(session, 2)));
  });
  loose.forEach(session => list.append(sessionTreeRow(session, 1)));
  const home = $('#home-sessions'); home.replaceChildren();
  $('#saved-subtitle').textContent = '';
  if (!state.sessions.length) {
    home.replaceChildren();
    on('#empty-create', 'click', () => sessionDialog());
  } else {
    state.sessions.slice(0, 9).forEach(session => {
      const row = element('div', 'home-session-row'); row.tabIndex = 0; row.setAttribute('role', 'button'); const glyph = element('span', 'inline-icon'); glyph.innerHTML = classicIcon(sessionGlyph(session.type)); row.append(glyph, element('span', 'home-session-name', sessionTitle(session)), element('span', 'home-session-host', session.host ? `${session.username ? `${session.username}@` : ''}${session.host}` : session.cwd || 'Local machine'), element('span', 'session-tag', String(session.type || 'local').toUpperCase()));
      const edit = element('button', 'icon-button'); edit.innerHTML = svg('edit'); edit.setAttribute('aria-label', `Edit ${sessionTitle(session)}`); edit.addEventListener('click', event => { event.stopPropagation(); sessionDialog(session); }); row.append(edit);
      row.addEventListener('click', handle(() => connect(session))); row.addEventListener('keydown', handle(event => { if (event.key === 'Enter') return connect(session); })); home.append(row);
    });
  }
}
const protocols = [ ['ssh','SSH','server'], ['telnet','Telnet','terminal'], ['rsh','Rsh','terminal'], ['xdmcp','Xdmcp','monitor'], ['rdp','RDP','monitor'], ['vnc','VNC','monitor'], ['ftp','FTP','folder'], ['sftp','SFTP','folder'], ['serial','Serial','link'], ['file','File','folder'], ['local','Shell','terminal'], ['browser','Browser','monitor'], ['mosh','Mosh','terminal'], ['s3','Aws S3','server'], ['wsl','WSL','code'] ];
const previewProtocols = new Set();
const protocolTitles = {ssh:'SSH',telnet:'Telnet',rsh:'Rsh',xdmcp:'Xdmcp',rdp:'Rdp',vnc:'Vnc',ftp:'Ftp',sftp:'Sftp',serial:'Serial',file:'File/folder',local:'Shell',browser:'Browser',mosh:'Mosh',s3:'Aws S3',wsl:'WSL'};
function unavailableOptions(labels) {
  return `<div class="reference-options">${labels.map(value=>`<label class="checkbox-field unavailable-option" title="Not implemented in Termora"><input type="checkbox" disabled>${escapeHtml(String(typeof value==='string'?value:value.label).replace(/MobaXterm/g,'Termora'))}</label>`).join('')}</div>`;
}
function shellOptions(selected = 'powershell') {
  if(state.platform === 'darwin') return '<option value="login">Login shell (zsh / bash)</option>';
  return `<option value="powershell" ${selected!=='cmd'?'selected':''}>Windows PowerShell</option><option value="cmd" ${selected==='cmd'?'selected':''}>Command Prompt</option>`;
}
function sessionDialog(existing = null, initialType = null, seed = {}) {
  let selected = existing?.type === 'ftps' || initialType === 'ftps' ? 'ftp' : existing?.type || initialType;
  const values = { ...seed, ...(existing || {}) };
  if(existing?.type==='ftps'||initialType==='ftps')values.secure=true;
  modal({ title: existing ? 'Edit connection' : 'Create a connection', subtitle: 'Give your next session a place to call home.', icon: 'server', body: `<div class="protocol-picker" id="protocol-picker">${protocols.map(([value, label, icon]) => `<button type="button" class="protocol-option${selected === value ? ' selected' : ''}" data-protocol="${value}">${svg(icon)}${label}</button>`).join('')}</div><form id="session-form"><div id="session-fields"></div><div class="divider"></div><div class="field-row"><div class="field"><label for="connection-name">Session name</label><input id="connection-name" placeholder="e.g. Production server" value="${escapeHtml(existing?.name || '')}" maxlength="120"></div><div class="field"><label for="connection-group">Folder</label><input id="connection-group" value="${escapeHtml(existing?.group || existing?.folder || seed.group || '')}" placeholder="My sessions" maxlength="80"></div></div><label class="checkbox-field"><input id="connection-save" type="checkbox" checked>Save this connection · passwords are never saved</label></form>`, footer: `${existing ? '<button class="text-button text-danger" id="delete-session">Delete session</button>' : '<span class="footer-message">Credentials stay in memory.</span>'}<button class="button secondary" id="save-session-only">Save session</button><button class="button primary" type="submit" form="session-form" id="connect-session">Connect ${svg('link')}</button>` });
  $('#app-dialog').classList.add('session-dialog');
  $('#save-session-only').type='button';
  $('#app-dialog').style.width = '864px';
  $('.dialog-title').textContent = existing ? 'Edit session' : 'Session settings';
  $('.dialog-subtitle').textContent = '';
  $$('.protocol-option').forEach(button => {
    if(previewProtocols.has(button.dataset.protocol)){button.classList.add('preview-protocol');button.title='View settings layout. Connections of this type are not implemented in Termora.';}
    const icon = button.querySelector('svg');
    if(icon) icon.outerHTML = classicIcon(({local:'shell',wsl:'rdp',file:'browser'})[button.dataset.protocol]||button.dataset.protocol);
  });
  const capture = () => { $$('[data-field]', $('#session-fields')).forEach(input => { values[input.dataset.field] = input.type === 'checkbox' ? input.checked : input.value; }); };
  const field = (key, label, placeholder = '', type = 'text', extra = '') => `<div class="field${key === 'port' ? ' port-field' : ''}"><label for="conn-${key}">${label}</label><input id="conn-${key}" data-field="${key}" type="${type}" placeholder="${placeholder}" value="${escapeHtml(values[key] ?? '')}" ${extra}></div>`;
  function renderFields() {
    // Keep common bookmark controls intact when switching away from an SSH tab.
    const form=$('#session-form');
    const bookmarkRow=$('#connection-name').closest('.field-row');
    const bookmarkSave=$('#connection-save').closest('.checkbox-field');
    form.append(bookmarkRow,bookmarkSave);
    $('.dialog-footer').append($('#save-session-only'));
    const choosing = !selected;
    $('#app-dialog').classList.toggle('session-chooser', choosing);
    bookmarkRow.classList.toggle('hidden', choosing);
    bookmarkSave.classList.toggle('hidden', choosing);
    $('#save-session-only').classList.toggle('hidden', choosing);
    $('#session-form > .divider')?.classList.toggle('hidden', choosing || selected === 'ssh');
    $('#app-dialog').classList.toggle('ssh-session-dialog',selected==='ssh');
    $('#connect-session').innerHTML='<span class="native-ok">✓</span> OK';
    if(!$('#session-cancel')){const cancel=element('button','button secondary');cancel.innerHTML='<span class="native-cancel">×</span> Cancel';cancel.id='session-cancel';cancel.addEventListener('click',closeModal);$('.dialog-footer').append(cancel);}
    if (choosing) {
      $('#session-fields').innerHTML = `<div class="session-choose-message">${classicIcon('session')}<span>Choose a session type...</span></div>`;
      $('#connect-session').disabled = true;
      return;
    }
    const network = ['ssh', 'sftp', 'telnet', 'rdp', 'vnc', 'ftp', 'ftps','rsh','xdmcp','mosh'].includes(selected);
    let html = '';
    if (previewProtocols.has(selected)) html += '<div class="protocol-unavailable" role="status">Settings preview · this connection type is not implemented in Termora.</div>';
    else if (!capability(selected) && !['ftp', 'ftps'].includes(selected)) html += `<div class="info-box warning">${selected === 'wsl' ? 'WSL is not available on this computer. Install a Linux distribution in Windows before opening this session.' : selected === 'xdmcp' ? 'XDMCP needs the VcXsrv X server. Install VcXsrv and restart Termora to enable this connection.' : `This protocol is not available in this environment. Check About & feature support for details.`}</div>`;
    if (network) {
      if (!values.port) values.port = ({ ssh:22, sftp:22, telnet:23, rdp:3389, vnc:5900, ftp:21, ftps:21, rsh:513, xdmcp:177, mosh:22 })[selected];
      html += `<div class="field-row">${field('host', 'Remote host', 'hostname or IP address', 'text', 'required autocomplete="off"')}${field('port', 'Port', '', 'number', 'min="1" max="65535" required')}</div>`;
      if (!['telnet','vnc','xdmcp'].includes(selected)) html += field('username', 'Username', selected === 'ftp' || selected === 'ftps' ? 'anonymous' : 'Your remote username', 'text', 'autocomplete="username"');
      if (['ssh','sftp','ftp','ftps','mosh'].includes(selected)) html += field('password', 'Password', 'Leave blank to use a key or SSH agent', 'password', 'autocomplete="new-password"');
      if (selected === 'vnc') html += `<div class="field-row">${field('password', 'VNC password', 'Only if the server asks for one', 'password', 'autocomplete="new-password"')}<div class="field"><label for="conn-vncViewer">Viewer</label><select id="conn-vncViewer" data-field="vncViewer"><option value="embedded">Embedded viewer (in a tab)</option><option value="external" ${values.vncViewer === 'external' ? 'selected' : ''} ${capability('vncExternal') ? '' : 'disabled'}>External viewer${capability('vncExternal') ? '' : ' (not installed)'}</option></select></div></div><label class="checkbox-field"><input type="checkbox" id="conn-viewOnly" data-field="viewOnly" ${values.viewOnly ? 'checked' : ''}>View only (do not send keyboard and mouse)</label>`;
      if (selected === 'mosh') html += `<div class="field"><label for="conn-privateKeyPath">Private key <span class="muted">optional</span></label><div class="input-with-button"><input id="conn-privateKeyPath" data-field="privateKeyPath" value="${escapeHtml(values.privateKeyPath || '')}" placeholder="Select an OpenSSH private key"><button type="button" class="button secondary" id="browse-key">Browse…</button></div></div><div class="field-row">${field('moshServer', 'mosh-server command', 'mosh-server')}${field('moshPorts', 'UDP ports', 'Any, or e.g. 60000:61000')}${field('moshLocale', 'Remote locale', 'en_US.UTF-8')}</div><div class="info-box">Termora signs in over SSH (port above), starts mosh-server on the remote host, then switches to encrypted UDP. mosh-server must be installed there and its UDP port must be reachable.</div>`;
      if (selected === 'ssh' || selected === 'sftp') {
        html += `<div class="field"><label for="conn-privateKeyPath">Private key <span class="muted">optional</span></label><div class="input-with-button"><input id="conn-privateKeyPath" data-field="privateKeyPath" value="${escapeHtml(values.privateKeyPath || '')}" placeholder="Select an OpenSSH private key"><button type="button" class="button secondary" id="browse-key">Browse…</button></div></div>${field('passphrase', 'Key passphrase', 'Only if your private key is encrypted', 'password', 'autocomplete="new-password"')}`;
        const check = (key, label, title = '') => `<label class="checkbox-field" title="${escapeHtml(title)}"><input type="checkbox" id="conn-${key}" data-field="${key}" ${values[key] ? 'checked' : ''}>${label}</label>`;
        html += `<div class="ssh-real-options">`;
        if (selected === 'ssh') html += `${check('x11', 'X11-Forwarding', 'Relay remote X applications to the local X server (VcXsrv)')}<label class="inline-number">Display <input type="number" id="conn-x11Display" data-field="x11Display" min="0" max="63" value="${Number(values.x11Display) || 0}"></label>`;
        html += `${check('compression', 'Compression')}${check('agentForward', 'Forward SSH agent', 'Let the server use your local SSH agent keys')}</div>`;
        if (selected === 'ssh') html += `<div class="field-row">${field('startupCommand', 'Execute command', 'Runs after login, e.g. htop')}<div class="field"><label for="conn-browserProtocol">SSH-browser type</label><select id="conn-browserProtocol" data-field="browserProtocol"><option value="sftp">SFTP protocol</option><option value="scp" ${values.browserProtocol === 'scp' ? 'selected' : ''}>SCP (transfers only)</option></select></div></div>`;
        html += `<div id="ssh-gateway-fields" class="ssh-gateway-fields"><p class="field-hint">Connect through an SSH jump host. Leave the host empty for a direct connection.</p><div class="field-row">${field('gatewayHost', 'Gateway host', 'jump.example.com', 'text', 'autocomplete="off"')}${field('gatewayPort', 'Port', '22', 'number', 'min="1" max="65535"')}</div><div class="field-row">${field('gatewayUsername', 'Gateway username', 'Same as session username')}${field('gatewayPassword', 'Gateway password', 'Blank for key or agent', 'password', 'autocomplete="new-password"')}</div><div class="field"><label for="conn-gatewayPrivateKeyPath">Gateway private key <span class="muted">optional</span></label><div class="input-with-button"><input id="conn-gatewayPrivateKeyPath" data-field="gatewayPrivateKeyPath" value="${escapeHtml(values.gatewayPrivateKeyPath || '')}"><button type="button" class="button secondary" id="browse-gateway-key">Browse…</button></div></div></div>`;
      }
      if (selected === 'rsh') html += `${field('startupCommand', 'Remote command', 'Leave empty for an interactive rlogin session')}<div class="info-box warning">Rlogin and rsh are unencrypted and trust-based. Use them only on networks you control.</div>`;
      if (['ssh','sftp','ftp','ftps','vnc','mosh'].includes(selected)) html += state.vault?.available ? `<label class="checkbox-field"><input type="checkbox" id="conn-savePassword" data-field="savePassword" ${values.savePassword ? 'checked' : ''}>Save password (encrypted for your Windows account)</label>` : '<p class="field-hint">Saved passwords are unavailable: Windows credential encryption is not accessible.</p>';
      if (selected === 'telnet') html += '<div class="info-box warning">Telnet sends your data without encryption. Use it only with equipment and networks you trust.</div>';
      const option = (key, label, checked) => `<label class="checkbox-field"><input type="checkbox" id="conn-${key}" data-field="${key}" ${checked ? 'checked' : ''}>${label}</label>`;
      const choice = (key, label, items) => `<div class="field"><label for="conn-${key}">${label}</label><select id="conn-${key}" data-field="${key}">${items.map(([value, text]) => `<option value="${value}" ${String(values[key] ?? items[0][0]) === value ? 'selected' : ''}>${text}</option>`).join('')}</select></div>`;
      if (selected === 'rdp') html += `<div class="field-row">${field('domain', 'Domain', 'Optional')}${choice('rdpSize', 'Resolution', [['fit', 'Fit to window (dynamic)'], ['fullscreen', 'Full screen'], ['1024x768', '1024 × 768'], ['1280x720', '1280 × 720'], ['1280x1024', '1280 × 1024'], ['1366x768', '1366 × 768'], ['1600x900', '1600 × 900'], ['1920x1080', '1920 × 1080'], ['2560x1440', '2560 × 1440']])}</div><div class="field-row">${field('rdpGateway', 'RD Gateway', 'Optional gateway host')}${choice('rdpAudio', 'Remote audio', [['local', 'Play on this computer'], ['remote', 'Leave on remote computer'], ['none', 'Do not play']])}</div><div class="ssh-real-options">${option('rdpClipboard', 'Clipboard', values.rdpClipboard !== false)}${option('rdpDrives', 'Local drives', values.rdpDrives)}${option('rdpPrinters', 'Printers', values.rdpPrinters)}${option('rdpMultimon', 'Use all monitors', values.rdpMultimon)}${option('rdpMicrophone', 'Microphone', values.rdpMicrophone)}${option('rdpAdmin', 'Administrator console', values.rdpAdmin)}</div><div class="info-box">${state.platform === 'darwin' ? 'Uses the RDP engine bundled in Termora. No Microsoft Windows App is required.' : 'Opens in the Windows Remote Desktop client with these settings. Windows asks for the password and can remember it.'}</div>`;
      if (selected === 'xdmcp') html += `<div class="field-row">${choice('xdmcpMode', 'Display', [['window', 'In a window'], ['fullscreen', 'Full screen']])}${choice('xdmcpSize', 'Window size', [['1280x800', '1280 × 800'], ['1024x768', '1024 × 768'], ['1600x900', '1600 × 900'], ['1920x1080', '1920 × 1080']])}<div class="field port-field"><label for="conn-xdmcpDisplay">X display</label><input id="conn-xdmcpDisplay" data-field="xdmcpDisplay" type="number" min="1" max="63" value="${Number(values.xdmcpDisplay) || 1}"></div></div><div class="info-box warning">XDMCP opens the remote login screen in the installed VcXsrv X server. The protocol is unencrypted; use it only on networks you trust.</div>`;
      if (selected === 'vnc') html += '<div class="info-box">The embedded viewer supports servers using no authentication or a VNC password. The password is checked by Termora itself and is not passed to the viewer.</div>';
      if (selected === 'ftp') html += `<div class="field-row"><label class="checkbox-field"><input data-field="secure" id="conn-secure" type="checkbox" ${values.secure?'checked':''}>Use TLS encryption (FTPS)</label><div class="field"><label for="conn-ftpsMode">FTPS mode</label><select id="conn-ftpsMode" data-field="ftpsMode"><option value="explicit">Explicit (AUTH TLS, port 21)</option><option value="implicit" ${values.ftpsMode === 'implicit' ? 'selected' : ''}>Implicit SSL (port 990)</option></select></div></div><div class="info-box warning">Plain FTP is not encrypted. Select FTPS or use SFTP over SSH for sensitive files.</div>`;
    } else if (selected === 'local' || selected === 'wsl') {
      if (selected === 'local') html += `<div class="field"><label for="conn-shell">Shell</label><select id="conn-shell" data-field="shell">${shellOptions(values.shell)}</select></div>`;
      html += `<div class="field"><label for="conn-cwd">Starting directory <span class="muted">optional</span></label><div class="input-with-button"><input id="conn-cwd" data-field="cwd" value="${escapeHtml(values.cwd || '')}" placeholder="${selected === 'wsl' ? 'Linux home directory' : escapeHtml(state.homePath || '')}">${selected !== 'wsl' ? '<button type="button" class="button secondary" id="browse-folder">Browse…</button>' : ''}</div></div>`;
      if (selected === 'wsl') html += field('distribution', 'Distribution', 'Default WSL distribution');
    } else if (selected === 'serial') {
      if(!values.baudRate)values.baudRate=115200;
      html += `<div class="field-row">${field('path','Serial port','COM3','text','required')}${field('baudRate','Baud rate','115200','number','min="50" max="4000000" required')}</div><div class="field-row"><div class="field"><label for="conn-dataBits">Data bits</label><select data-field="dataBits" id="conn-dataBits"><option value="8">8</option><option value="7">7</option><option value="6">6</option><option value="5">5</option></select></div><div class="field"><label for="conn-parity">Parity</label><select data-field="parity" id="conn-parity"><option value="none">None</option><option value="even">Even</option><option value="odd">Odd</option><option value="mark">Mark</option><option value="space">Space</option></select></div><div class="field"><label for="conn-stopBits">Stop bits</label><select data-field="stopBits" id="conn-stopBits"><option value="1">1</option><option value="2">2</option></select></div></div><button class="text-button" type="button" id="detect-ports">${svg('refresh')}Find serial ports</button><div id="serial-ports" class="field-hint"></div>`;
    } else if (selected === 'file') html += `<div class="field"><label for="conn-path">File/folder/URL</label><div class="input-with-button"><input id="conn-path" data-field="path" required value="${escapeHtml(values.path || '')}" placeholder="Folder, file or http(s) address"><button type="button" class="button secondary" id="browse-path">Browse…</button></div></div><p class="field-hint">Folders open in the file browser, files open with their Windows app and web addresses open in a browser window.</p>`;
    else if (selected === 'browser') html += `${field('path','URL','https://', 'text', 'required')}<p class="field-hint">Opens in a separate sandboxed browser window with its own cookies. Alt+← / Alt+→ go back and forward, F5 reloads.</p>`;
    else if(selected==='s3') html += `<div class="field-row">${field('host','Endpoint','s3.amazonaws.com or https://host:9000')}${field('region','Region','us-east-1')}</div><div class="field-row">${field('username','Access key ID','AKIA…','text','required autocomplete="off"')}${field('password','Secret access key','','password','autocomplete="new-password"')}</div>${field('path','Bucket','Optional · leave empty to list all buckets')}<label class="checkbox-field"><input type="checkbox" id="conn-pathStyle" data-field="pathStyle" ${values.pathStyle ? 'checked' : ''}>Path-style addressing (MinIO and most S3-compatible servers)</label>${state.vault?.available ? `<label class="checkbox-field"><input type="checkbox" id="conn-savePassword" data-field="savePassword" ${values.savePassword ? 'checked' : ''}>Save secret key (encrypted for your Windows account)</label>` : ''}`;
    $('#session-fields').innerHTML = html;
    layoutSession(bookmarkRow,bookmarkSave);
    if(selected==='serial'){['dataBits','stopBits','parity'].forEach(key=>{$(`#conn-${key}`).value=String(values[key]??({dataBits:8,stopBits:1,parity:'none'})[key]);});}
    const unavailable = previewProtocols.has(selected) || (!capability(selected) && !['ftp','ftps'].includes(selected));
    $('#connect-session').disabled = unavailable;
    $('#save-session-only').disabled = previewProtocols.has(selected);
    on('#browse-key', 'click', async () => { const path = await bridge.pickFile({kind:'key'}); if(path) $('#conn-privateKeyPath').value = path; });
    on('#conn-ftpsMode', 'change', () => { const port = $('#conn-port'); if (port && ['21', '990'].includes(port.value)) port.value = $('#conn-ftpsMode').value === 'implicit' ? '990' : '21'; });
    on('#browse-gateway-key', 'click', async () => { const path = await bridge.pickFile({kind:'key'}); if(path) $('#conn-gatewayPrivateKeyPath').value = path; });
    on('#browse-folder', 'click', async () => { const path = await bridge.pickFile({kind:'folder'}); if(path) $('#conn-cwd').value = path; });
    on('#browse-path', 'click', async () => { const path = await bridge.pickFile({kind:'folder'}); if(path) $('#conn-path').value = path; });
    on('#detect-ports', 'click', async () => { const ports = await bridge.listSerialPorts(); $('#serial-ports').textContent = ports.length ? ports.map(p => `${p.path}${p.manufacturer ? ` — ${p.manufacturer}` : ''}`).join(' · ') : 'No serial ports detected.'; });
  }
  function layoutSession(bookmarkRow,bookmarkSave){
    const fields=$('#session-fields');
    const icon=({local:'shell',file:'browser',wsl:'rdp'})[selected]||selected;
    const basic=element('fieldset',`session-basic-settings${selected==='ssh'?' ssh-basic-settings':''}`);basic.innerHTML=`<legend>${classicIcon(icon)} Basic ${escapeHtml(protocolTitles[selected])} settings</legend>`;
    const row=element('div',`session-basic-row${selected==='ssh'?' ssh-basic-row':''}`);
    const keys = selected==='serial'?['path','baudRate']:selected==='local'?['shell']:selected==='wsl'?['distribution']:['host','username','port','path'];
    for(const key of keys){const input=$(`#conn-${key}`);if(input){const wrapper=input.closest('.field');if(key==='host'&&selected==='ssh')wrapper.querySelector('label').textContent='Remote host *';row.append(wrapper);}}
    basic.append(row);
    if(selected==='ssh'){
      const user=$('#conn-username',basic).closest('.field');user.querySelector('label').innerHTML='<input type="checkbox" id="specify-username"> Specify username';
      $('#specify-username',user).checked=Boolean(values.username);$('#conn-username',user).disabled=!values.username;
      $('#specify-username',user).addEventListener('change',event=>{const enabled=event.target.checked;$('#conn-username').disabled=!enabled;if(!enabled){$('#conn-username').value='';values.username='';}else $('#conn-username').focus();});
    }
    const gatewayBlock=$('#ssh-gateway-fields',fields);if(gatewayBlock)gatewayBlock.remove();
    const advancedContent=[...fields.children];
    const notice=$('.protocol-unavailable',fields);if(notice)notice.remove();
    const auth=advancedContent.filter(node=>node!==notice&&!(node.classList.contains('field-row')&&!node.children.length));
    const tabs=element('div','session-setting-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','SSH settings');
    const content=element('div','session-settings-content');
    const overview=element('div','session-overview');overview.innerHTML=`<span>${escapeHtml(selected==='ssh'?'Secure Shell (SSH)':protocolTitles[selected])} session</span><span class="session-key-symbol">${classicIcon(icon)}</span>`;
    content.append(overview);
    const panes={};
    const definitions=[['advanced',icon,`Advanced ${protocolTitles[selected]} settings`],['terminal','settings','Terminal settings'],['network','servers','Network settings'],['bookmark','sessions','Bookmark settings']];
    for(const [key,icon,label]of definitions){
      const button=element('button','session-setting-tab');button.type='button';button.dataset.sessionTab=key;button.setAttribute('role','tab');button.setAttribute('aria-selected','false');button.innerHTML=`<span aria-hidden="true">${classicIcon(icon)}</span>${label}`;tabs.append(button);
      button.id=`session-tab-${key}`;button.setAttribute('aria-controls',`session-pane-${key}`);button.tabIndex=key==='advanced'?0:-1;
      const pane=element('section','session-settings-pane hidden');pane.id=`session-pane-${key}`;pane.dataset.settingsPane=key;pane.setAttribute('role','tabpanel');pane.setAttribute('aria-labelledby',button.id);content.append(pane);panes[key]=pane;
      button.addEventListener('click',()=>{$$('.session-setting-tab',tabs).forEach(tab=>{tab.classList.toggle('selected',tab===button);tab.setAttribute('aria-selected',String(tab===button));});overview.classList.add('hidden');Object.entries(panes).forEach(([name,p])=>p.classList.toggle('hidden',name!==key));});
    }
    panes.advanced.append(...auth);
    const supportedLabels=selected==='ftp'?['FTPS mode','Implicit SSL']:selected==='rdp'?['Smart sizing','Redirect clipboard','Redirect printers','Redirect microphone','Use multiple monitors']:selected==='vnc'?['View only']:['Use private key','X11-Forwarding','Compression'];
    const options=(uiReference.sessionOptions[selected]||[]).filter(option=>!supportedLabels.includes(option.label));
    const reference=element('div','advanced-reference');reference.innerHTML=unavailableOptions(options);panes.advanced.append(reference);
    if(previewProtocols.has(selected))$$('input,select,textarea',basic).forEach(input=>{input.disabled=true;});
    panes.terminal.innerHTML=`<h3 class="settings-group-title">Terminal defaults</h3><dl class="session-defaults"><dt>Font</dt><dd>${escapeHtml(state.settings.fontFamily)}</dd><dt>Font size</dt><dd>${Number(state.settings.fontSize)} px</dd><dt>Scrollback</dt><dd>${Number(state.settings.scrollback)} lines</dd></dl><p class="field-hint">These defaults are configured in the main Settings window.</p>`;
    if(gatewayBlock){panes.network.innerHTML='<fieldset class="native-group gateway-group"><legend>SSH gateway (jump host)</legend></fieldset><fieldset class="native-group"><legend>Proxy settings (experimental)</legend><div class="field-row"><label>Proxy type <select disabled><option>None</option></select></label><label>Host <input disabled></label><label>Port <input disabled size="5"></label></div></fieldset><p class="field-hint">HTTP/SOCKS proxies are not available in this build.</p>';$('.gateway-group',panes.network).append(gatewayBlock);}
    else panes.network.innerHTML='<p class="field-hint">No network options for this connection type.</p>';
    panes.bookmark.append(bookmarkRow,bookmarkSave,$('#save-session-only'));
    fields.replaceChildren(basic,tabs,content);if(notice)fields.append(notice);
    panes.bookmark.classList.add('bookmark-pane');
    const shortcut=element('button','button secondary bookmark-shortcut','Create a desktop shortcut to this session');shortcut.type='button';shortcut.id='create-shortcut';shortcut.disabled=previewProtocols.has(selected);shortcut.title='Saves the session, then puts a shortcut on your desktop that opens it in Termora';panes.bookmark.append(shortcut);
    shortcut.addEventListener('click',handle(async()=>{if(!$('#session-form').reportValidity())return;const current=config();await persist(current);const result=await bridge.createShortcut(current.id);toast(`Shortcut created: ${result.path}`);}));
    if(!options.length&&!auth.length)panes.advanced.append(element('p','field-hint','No additional settings for this connection type.'));
    tabs.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const buttons=$$('button',tabs),current=buttons.indexOf(document.activeElement);const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(current+(event.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length;buttons.forEach((button,index)=>button.tabIndex=index===next?0:-1);buttons[next].focus();buttons[next].click();});
    const divider=$('#session-form > .divider');if(divider)divider.classList.add('hidden');
  }
  renderFields();
  $$('.protocol-option').forEach(button => button.addEventListener('click', () => { capture(); const old = selected; selected = button.dataset.protocol; if (selected !== old) values.port = ''; $$('.protocol-option').forEach(item => item.classList.toggle('selected', item === button)); renderFields(); }));
  function config() {
    capture(); const result = { ...values, id: existing?.id || id(), type: selected, name: $('#connection-name').value.trim(), group: $('#connection-group').value.trim() || 'My sessions' };
    if(selected==='ftp'&&values.secure)result.type='ftps';
    if (values.port) result.port = Number(values.port);
    ['baudRate','dataBits','stopBits'].forEach(key => { if (values[key]) result[key] = Number(values[key]); });
    if (selected === 'serial' && !result.baudRate) result.baudRate = 115200;
    if (!result.name) result.name = sessionTitle(result);
    return result;
  }
  async function persist(config) {
    const { password, passphrase, gatewayPassword, gatewayPassphrase, ...saved } = config;
    const next = state.sessions.filter(session => session.id !== saved.id); next.push(saved);
    state.sessions = await bridge.saveSessions(next); renderSessions();
    // Secrets go to the main-process vault only when the user opted in.
    if (saved.savePassword && state.vault?.available) { await bridge.saveCredentials(saved.id, { password, passphrase, gatewayPassword, gatewayPassphrase }); if (!state.vault.saved.includes(saved.id)) state.vault.saved.push(saved.id); }
    else if (state.vault?.saved?.includes(saved.id)) { await bridge.forgetCredentials(saved.id); state.vault.saved = state.vault.saved.filter(item => item !== saved.id); }
  }
  on('#save-session-only', 'click', async () => { if (!$('#session-form').reportValidity()) return; try { await persist(config()); closeModal(); toast('Connection saved.'); } catch (error) { errorInDialog(error); } });
  on('#session-form', 'submit', async event => {
    event.preventDefault(); const current = config(); const save = $('#connection-save').checked; const button = $('#connect-session'); saveButton(button, true);
    try { if (save) await persist(current); await connect(current); closeModal(); } catch (error) { errorInDialog(error); } finally { saveButton(button, false); }
  });
  on('#delete-session', 'click', async () => { const confirmed = await confirmAction('Delete this connection?', `“${sessionTitle(existing)}” will be removed from saved sessions. Open terminals will stay connected.`, 'Delete connection', true); if (!confirmed) return; state.sessions = await bridge.saveSessions(state.sessions.filter(s => s.id !== existing.id)); renderSessions(); toast('Connection deleted.'); });
}

// Keyword highlighting keeps per-terminal escape-sequence state across chunks.
function terminalText(entry, data) {
  if (state.settings.highlight === false) return data;
  entry.highlighter ||= createHighlighter();
  return entry.highlighter(data);
}
function terminalTheme() {
  return { background:'#000000',foreground:'#c0c0c0',cursor:'#c0c0c0',selectionBackground:'#5b7299',black:'#000000',red:'#bb0000',green:'#00bb00',yellow:'#bbbb00',blue:'#0000bb',magenta:'#bb00bb',cyan:'#00bbbb',white:'#bbbbbb',brightBlack:'#555555',brightRed:'#ff5555',brightGreen:'#55ff55',brightYellow:'#ffff55',brightBlue:'#5555ff',brightMagenta:'#ff55ff',brightCyan:'#55ffff',brightWhite:'#ffffff' };
}
// noVNC talks to a WebSocket-like channel; this one carries the RFB stream over
// IPC to the main process, which owns the TCP connection and the password.
const vncChannels = new Map();
class VncChannel {
  constructor(id) { this.id = id; this.binaryType = 'arraybuffer'; this.protocol = ''; this.readyState = 'open'; this.onopen = null; this.onmessage = null; this.onerror = null; this.onclose = null; }
  send(data) { if (this.readyState !== 'open') return; const bytes = data instanceof Uint8Array ? data.slice() : new Uint8Array(data); bridge.writeVnc({ id: this.id, data: bytes }).catch(() => {}); }
  close() { if (this.readyState === 'closed') return; this.readyState = 'closed'; bridge.closeTerminal(this.id).catch(() => {}); this.onclose?.({ code: 1000, reason: '', wasClean: true }); }
  receive(data) { if (this.readyState !== 'open') return; const view = data instanceof Uint8Array ? data : new Uint8Array(data); this.onmessage?.({ data: view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) }); }
  ended() { if (this.readyState === 'closed') return; this.readyState = 'closed'; this.onclose?.({ code: 1000, reason: '', wasClean: true }); }
}
function mountVnc(entry) {
  const bar = element('div', 'vnc-toolbar'), view = element('div', 'vnc-view');
  view.tabIndex = 0; entry.pane.append(bar, view);
  const channel = new VncChannel(entry.id); vncChannels.set(entry.id, channel);
  const rfb = new RFB(view, channel, { shared: true });
  entry.rfb = rfb; rfb.scaleViewport = true; rfb.resizeSession = false; rfb.background = '#000000'; rfb.viewOnly = Boolean(entry.config.viewOnly);
  const status = element('span', 'vnc-status', 'Connecting…');
  const button = (label, title, action) => { const node = element('button', 'button secondary vnc-button', label); node.type = 'button'; node.title = title; node.addEventListener('click', handle(action)); bar.append(node); return node; };
  button('Ctrl+Alt+Del', 'Send Ctrl+Alt+Del to the remote desktop', () => rfb.sendCtrlAltDel());
  const fit = button('Fit to window', 'Scale the remote screen to the tab', () => { rfb.scaleViewport = !rfb.scaleViewport; fit.classList.toggle('active', rfb.scaleViewport); });
  fit.classList.add('active');
  const viewOnly = button('View only', 'Stop sending keyboard and mouse input', () => { rfb.viewOnly = !rfb.viewOnly; viewOnly.classList.toggle('active', rfb.viewOnly); });
  viewOnly.classList.toggle('active', rfb.viewOnly);
  button('Paste clipboard', 'Send the local clipboard text to the remote clipboard', async () => { const text = await bridge.readClipboard(); rfb.clipboardPasteFrom(text); toast('Clipboard sent to the remote desktop.'); });
  button('Full screen', 'Show this desktop full screen (Esc to leave)', () => entry.pane.requestFullscreen?.());
  bar.append(status);
  let desktopName = '';
  rfb.addEventListener('connect', () => { status.textContent = desktopName ? `Connected · ${desktopName}` : 'Connected'; entry.vncConnected = true; updateStatus(); rfb.focus(); });
  rfb.addEventListener('desktopname', event => { desktopName = String(event.detail.name || ''); if (entry.vncConnected && desktopName) status.textContent = `Connected · ${desktopName}`; });
  rfb.addEventListener('disconnect', event => { status.textContent = event.detail.clean ? 'Disconnected' : 'Connection lost'; });
  rfb.addEventListener('clipboard', event => { bridge.writeClipboard(String(event.detail.text || '')).catch(() => {}); });
  bridge.startVnc(entry.id).catch(error => toast(message(error), true));
}
async function connect(config) {
  if (['rdp','xdmcp'].includes(config.type) || (config.type === 'vnc' && config.vncViewer === 'external')) { await bridge.launchExternal(config); toast(`${config.type.toUpperCase()} client opened.`); return; }
  if (config.type === 'vnc') { $('#status-text').textContent = `Connecting to ${sessionTitle(config)}…`; try { await mountTerminal(await bridge.openVnc(config), config, true); } catch (error) { updateStatus(); throw error; } return; }
  if (config.type === 'browser' || (config.type === 'file' && /^https?:\/\//i.test(config.path || ''))) { await bridge.openBrowser({ url: config.path, title: config.name }); toast('Browser window opened.'); return; }
  if (config.type === 'file') {
    const result = await bridge.openPath(config.path);
    if (result.directory) { await showFiles(true); state.fileId = null; $('#file-heading-label').textContent = 'Local files'; $('#file-upload').disabled = true; await loadFiles(result.directory); }
    else if (result.opened) toast(`Opened ${result.opened.split(/[\\/]/).pop()}.`);
    return;
  }
  const fileOnly = ['sftp','ftp','ftps','s3'].includes(config.type);
  $('#status-text').textContent = `Connecting to ${sessionTitle(config)}…`;
  try {
    const result = fileOnly ? await bridge.openFiles(config) : await bridge.openTerminal({ ...config, cols:100, rows:30 });
    await mountTerminal(result, config, fileOnly);
  } catch(error) { updateStatus(); throw error; }
}
// Builds the tab, pane and xterm for an already-open backend session. Detached
// windows and reattached tabs pass the earlier screen text as history.
async function mountTerminal(result, config, fileOnly, history = '') {
  {
    const entry = { id:result.id, label:config.name || result.label || sessionTitle(config), kind:result.kind || config.type, config:{...config}, term:null, fit:null, search:null, ended:false, fileOnly };
    entry.pane = element('section', 'terminal-pane'); entry.pane.dataset.terminalId = entry.id;
    entry.pane.setAttribute('aria-label', `${entry.label} terminal`);
    const heading = element('div', 'terminal-pane-label'); heading.innerHTML = `${svg(typeIcon(config.type))}<span class="pane-title">${escapeHtml(entry.label)}</span><span class="dot"></span>`;
    const close = element('button','icon-button','×'); close.setAttribute('aria-label',`Close ${entry.label}`);close.addEventListener('click',handle(event=>{event.stopPropagation();return closeTerminal(entry.id);}));heading.append(close);entry.pane.append(heading);
    entry.pane.addEventListener('pointerdown', () => { if(state.active !== entry.id) { state.active=entry.id;for(const item of state.terminals.values())item.pane.classList.toggle('pane-active',item.id===entry.id);renderTabs();updateStatus();refreshFilesForActive(); } });
    if (config.type === 'vnc') mountVnc(entry);
    else if (fileOnly) {
      const empty = element('div', 'empty-pane'); empty.style.flex='1'; empty.innerHTML = `${svg('folder')}<p>${escapeHtml(entry.label)}</p><p>Connected using ${escapeHtml(config.type.toUpperCase())}.<br>Use the file browser to manage your remote files.</p>`;
      const browse = element('button','button primary','Browse remote files');browse.addEventListener('click',handle(()=>showFiles(true)));empty.append(browse);entry.pane.append(empty);
    } else {
      const host = element('div','terminal-host');entry.pane.append(host);
      const term = new Terminal({fontSize:Number(state.settings.fontSize)||14,fontFamily:state.settings.fontFamily||'Cascadia Code, Consolas, monospace',scrollback:Number(state.settings.scrollback)||10000,theme:terminalTheme(),cursorBlink:true,cursorStyle:'bar',allowTransparency:false,convertEol:false,windowsPty:config.type==='local'||config.type==='wsl'?{backend:'conpty'}:undefined});
      const fit = new FitAddon();const search = new SearchAddon();term.loadAddon(fit);term.loadAddon(search);entry.term=term;entry.fit=fit;entry.search=search;
      entry.host=host;
      term.onData(data => {
        recordMacroInput(entry, data);
        const recipients = state.broadcast ? [...state.terminals.values()].filter(t=>!t.ended && !t.fileOnly) : [entry];
        recipients.forEach(t=>bridge.writeTerminal({id:t.id,data}).catch(error=>toast(message(error),true)));
      });
      term.onResize(({cols,rows})=>{if(!entry.ended)bridge.resizeTerminal({id:entry.id,cols,rows}).catch(()=>{});if(state.active===entry.id)$('#terminal-dimensions').textContent=`${cols} × ${rows}`;});
      term.attachCustomKeyEventHandler(event=>{
        if(event.type!=='keydown')return true;
        if(event.ctrlKey&&event.shiftKey&&event.code==='KeyC'){copyTerminal(entry);return false;}
        if(event.ctrlKey&&event.shiftKey&&event.code==='KeyV'){pasteTerminal(entry);return false;}
        if(event.ctrlKey&&event.shiftKey&&event.code==='KeyF'){showSearch();return false;}
        if(event.ctrlKey&&event.code==='KeyN'){sessionDialog();return false;}
        if(event.ctrlKey&&event.shiftKey&&event.code==='KeyT'){connect({type:'local',shell:'powershell'}).catch(error=>toast(message(error),true));return false;}
        return true;
      });
      host.addEventListener('contextmenu',event=>{event.preventDefault();showContextMenu(event.clientX,event.clientY,[['Copy selection','copy',()=>copyTerminal(entry)],['Paste','file',()=>pasteTerminal(entry)],['Clear terminal','trash',()=>term.clear()],['Save terminal output…','export',()=>saveTerminalOutput(entry)]]);});
    }
    state.terminals.set(entry.id,entry);state.order.push(entry.id);state.active=entry.id;state.home=false;renderWorkspace();
    if(entry.term)entry.term.open(entry.host);
    if(history&&entry.term)entry.term.write(history.replace(/\r?\n/g,'\r\n'));
    const buffered = state.buffered.get(entry.id);if(buffered&&entry.term)entry.term.write(terminalText(entry,buffered));state.buffered.delete(entry.id);
    const exit = state.exited.get(entry.id);if(exit){terminalExited(exit);state.exited.delete(entry.id);}
    updateStatus();
    if(detachedMode){}else if(['ssh','sftp','ftp','ftps','s3'].includes(config.type)){state.filePath='';await showFiles(true);}else if(state.files)await refreshFilesForActive();
    requestAnimationFrame(()=>entry.term?.focus());
  }
}
function terminalHistory(entry) {
  if (!entry?.term) return '';
  const buffer = entry.term.buffer.active, lines = [];
  for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) || '');
  while (lines.length && !lines.at(-1)) lines.pop();
  return lines.join('\n') + (lines.length ? '\n' : '');
}
// Move a tab into its own window; the backend session keeps running.
async function detachTerminal(terminalId) {
  const entry = state.terminals.get(terminalId);
  if (!entry || entry.ended || entry.fileOnly) { toast('Select a connected terminal tab to detach.'); return; }
  await bridge.detachTerminal({ id: entry.id, label: entry.label, kind: entry.kind, config: entry.config, history: terminalHistory(entry) });
  dropTerminal(terminalId);
}
function dropTerminal(terminalId) {
  const entry = state.terminals.get(terminalId); if (!entry) return;
  entry.term?.dispose(); entry.pane.remove();
  state.terminals.delete(terminalId); state.order = state.order.filter(item => item !== terminalId);
  if (state.active === terminalId) state.active = state.order.at(-1) || null;
  if (!state.active) state.home = true;
  renderWorkspace(); updateStatus();
}
function terminalExited(event) {
  const entry = state.terminals.get(event.id);
  if(!entry){state.exited.set(event.id,event);return;}
  entry.ended=true;
  if(entry.term)entry.term.write(`\r\n\x1b[90m[Session ended${event.exitCode!==undefined?` · exit ${event.exitCode}`:''}${event.error?` · ${event.error}`:''}]\x1b[0m\r\n`);
  const dot=$('.terminal-pane-label .dot',entry.pane);if(dot)dot.style.background='var(--faint)';
  renderTabs();updateStatus();
}
async function closeTerminal(terminalId) {
  const entry=state.terminals.get(terminalId);if(!entry)return;
  await bridge.closeTerminal(terminalId);
  entry.term?.dispose();entry.pane.remove();entry.config.password='';entry.config.passphrase='';
  state.terminals.delete(terminalId);state.order=state.order.filter(item=>item!==terminalId);
  if(state.active===terminalId)state.active=state.order.at(-1)||null;
  if(!state.active)state.home=true;
  if(state.terminals.size<2)state.broadcast=false;
  renderWorkspace();await refreshFilesForActive();
}
function renderTabs() {
  const tabs=$('#tabs');$$('.terminal-tab',tabs).forEach(node=>node.remove());
  $('#overview-tab').classList.toggle('active',state.home);$('#overview-tab').setAttribute('aria-selected',String(state.home));
  $('#show-home').classList.toggle('active',state.home);
  state.order.forEach(terminalId=>{
    const entry=state.terminals.get(terminalId);if(!entry)return;
    const tab=element('div',`tab terminal-tab${!state.home&&state.active===terminalId?' active':''}${entry.ended?' tab-ended':''}`);tab.setAttribute('role','tab');tab.setAttribute('aria-selected',String(!state.home&&state.active===terminalId));tab.tabIndex=0;tab.title=entry.label;
    if(state.settings.ui?.tabNumbers)tab.append(element('span','tab-number',String(state.order.indexOf(terminalId)+1)));const tabIcon=element('span','terminal-tab-icon');tabIcon.innerHTML=classicIcon(({local:'shell',wsl:'rdp'})[entry.config.type]||entry.config.type);tab.append(tabIcon,element('span','tab-name',entry.label));
    const close=element('button','tab-close','×');close.title='Close session';close.setAttribute('aria-label',`Close ${entry.label}`);close.addEventListener('click',handle(event=>{event.stopPropagation();return closeTerminal(terminalId);}));tab.append(close);
    tab.addEventListener('click',()=>activate(terminalId));tab.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' ')activate(terminalId);});tab.addEventListener('contextmenu',event=>{event.preventDefault();showContextMenu(event.clientX,event.clientY,[['Rename tab…','edit',async()=>{const name=await promptValue('Rename this tab','Tab name',entry.label);if(name){entry.label=name;$('.pane-title',entry.pane).textContent=name;renderTabs();updateStatus();}}],['Duplicate session','copy',()=>connect({...entry.config})],['Detach tab','detach',()=>detachTerminal(terminalId)],['Reconnect','refresh',async()=>{activate(terminalId);await reconnectActive();}],['Close session','close',()=>closeTerminal(terminalId)]]);});tabs.append(tab);
  });
}
function activate(terminalId) { state.active=terminalId;state.home=false;renderWorkspace();refreshFilesForActive().catch(error=>toast(message(error),true));state.terminals.get(terminalId)?.term?.focus(); }
function renderWorkspace() {
  renderTabs();$('#home').classList.toggle('hidden',!state.home);const container=$('#terminal-container');container.classList.toggle('hidden',state.home);container.className=`terminal-container layout-${state.layout}${state.home?' hidden':''}`;container.replaceChildren();
  if(!state.home){
    const candidates=[state.active,...[...state.order].reverse().filter(item=>item!==state.active)].filter(Boolean).slice(0,state.layout);
    candidates.forEach(terminalId=>{const entry=state.terminals.get(terminalId);if(entry){entry.pane.classList.toggle('pane-active',state.active===terminalId);container.append(entry.pane);}});
    for(let i=candidates.length;i<state.layout;i++){const empty=element('div','empty-pane');empty.innerHTML=`${svg('terminal')}<p>A little room for another session.</p>`;const button=element('button','button secondary','Open terminal');button.addEventListener('click',handle(()=>connect({type:'local',shell:'powershell'})));empty.append(button);container.append(empty);}
  }
  $('#terminal-broadcast').classList.toggle('active',state.broadcast);$('#toolbar-multiexec').classList.toggle('active',state.broadcast);$('#broadcast-banner').classList.toggle('hidden',!state.broadcast||state.home);$('#layout-status').textContent=({1:'SINGLE PANE',2:'TWO PANES',4:'FOUR PANES'})[state.layout];
  updateStatus();requestAnimationFrame(fitVisible);
}
function fitVisible() { for(const entry of state.terminals.values())if(entry.pane.isConnected&&entry.pane.getBoundingClientRect().width>0){try{entry.fit?.fit();}catch{}} }
function updateStatus() {
  const entry=state.terminals.get(state.active);$('#status-text').textContent=state.home?'Ready':entry?.ended?'Session ended':entry?.label||'Ready';
  $('#status-session-count').textContent=`${state.terminals.size} open ${state.terminals.size===1?'session':'sessions'}`;
  $('#terminal-dimensions').textContent=!state.home&&entry?.term?`${entry.term.cols} × ${entry.term.rows}`:'';
  $('#status-dot').style.background=entry?.ended&&!state.home?'var(--faint)':'var(--accent)';
}
async function reconnectActive() {
  const entry=state.terminals.get(state.active);if(!entry){toast('Open a terminal first.');return;}
  const config={...entry.config};await closeTerminal(entry.id);await connect(config);
}
async function toggleBroadcast() {
  if(state.broadcast){state.broadcast=false;renderWorkspace();return;}
  const count=[...state.terminals.values()].filter(t=>!t.ended&&!t.fileOnly).length;
  if(count<2){toast('Open at least two terminals before broadcasting.');return;}
  if(await confirmAction('Send input to every terminal?',`Broadcast input will send every keystroke to all ${count} connected terminals, including terminals in other tabs. Verify the destinations before running commands.`,'Enable broadcast')){state.broadcast=true;renderWorkspace();}
}
function showSearch(){
  const entry=state.terminals.get(state.active);if(!entry?.term||state.home){toast('Open a terminal to search its output.');return;}
  modal({title:'Find...',icon:'search',body:`<form id="find-form"><label class="field">Text to find:<input id="find-text" value="${escapeHtml($('#terminal-search-input').value)}" required></label><div class="find-options"><label class="checkbox-field"><input type="checkbox" id="find-case" ${state.searchOptions?.caseSensitive?'checked':''}>Match case</label><label class="checkbox-field"><input type="checkbox" id="find-regex" ${state.searchOptions?.regex?'checked':''}>Regular expressions</label><label class="checkbox-field"><input type="checkbox" id="find-reverse">Reverse search</label></div></form>`,footer:'<button class="button primary" type="submit" form="find-form">Find</button><button class="button secondary" id="dialog-cancel">Close</button>'});
  on('#find-form','submit',event=>{event.preventDefault();const query=$('#find-text').value;$('#terminal-search-input').value=query;state.searchOptions={caseSensitive:$('#find-case').checked,regex:$('#find-regex').checked};const found=$('#find-reverse').checked?entry.search.findPrevious(query,state.searchOptions):entry.search.findNext(query,state.searchOptions);if(!found)errorInDialog(new Error('Text not found.'));else{$('.dialog-error').textContent='';$('.dialog-error').classList.remove('error-box');}});
  $('#find-text').select();
}
async function copyTerminal(entry){const selection=entry?.term?.getSelection();if(!selection){toast('Select terminal text to copy it.');return;}try{if(bridge.writeClipboard)await bridge.writeClipboard(selection);else await navigator.clipboard.writeText(selection);toast('Selection copied.');}catch(error){toast(message(error),true);}}
async function pasteTerminal(entry){try{const text=bridge.readClipboard?await bridge.readClipboard():await navigator.clipboard.readText();if(text&&entry?.term)entry.term.paste(text);}catch(error){toast(message(error),true);}}
function downloadText(name,text){const blob=new Blob([text],{type:'text/plain;charset=utf-8'});const url=URL.createObjectURL(blob);const anchor=document.createElement('a');anchor.href=url;anchor.download=name;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function saveTerminalOutput(entry){if(!entry?.term)return;const lines=[];const buffer=entry.term.buffer.active;for(let i=0;i<buffer.length;i++)lines.push(buffer.getLine(i)?.translateToString(true)||'');downloadText(`${entry.label.replace(/[^a-z0-9_-]/gi,'_')}.log`,lines.join('\n'));}

function showContextMenu(x,y,items,classic=false){
  closeContextMenu();
  function createMenu(entries,left,top,parent=null){
    const menu=element('div',`context-menu${classic?' classic-menu':''}`);menu.setAttribute('role','menu');
    const hideChild=()=>{menu.querySelector(':scope > .context-menu')?.remove();};
    for(const item of entries){
      if(!item){const line=element('div','menu-separator');line.setAttribute('role','separator');menu.append(line);continue;}
      const [label,icon,action,danger,children,shortcut]=item;
      const button=element('button',danger?'danger':'');button.type='button';button.setAttribute('role','menuitem');
      if(classic){const glyph=element('span','menu-classic-icon');glyph.innerHTML=icon?classicIcon(icon):'';button.append(glyph);}else button.append(iconNode(icon));
      button.append(element('span','menu-label',label));
      if(shortcut)button.append(element('span','menu-shortcut',shortcut));
      let openChild;
      if(children){button.classList.add('has-submenu');button.setAttribute('aria-haspopup','menu');button.append(element('span','submenu-arrow','▸'));openChild=()=>{hideChild();const box=button.getBoundingClientRect();return createMenu(children,box.right-2,box.top,menu);};button.addEventListener('mouseenter',openChild);button.addEventListener('click',()=>openChild().querySelector('button:not(:disabled)')?.focus());}
      else if(!action){button.disabled=true;button.title='Not available in this build.';button.addEventListener('mouseenter',hideChild);}
      else {button.addEventListener('mouseenter',hideChild);button.addEventListener('click',handle(async()=>{closeContextMenu();await action();}));}
      button.addEventListener('keydown',event=>{
        if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();event.stopPropagation();const buttons=[...menu.children].filter(node=>node.tagName==='BUTTON'&&!node.disabled);const index=buttons.indexOf(button),next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;buttons[next]?.focus();}
        if(event.key==='ArrowRight'&&openChild){event.preventDefault();event.stopPropagation();openChild().querySelector('button:not(:disabled)')?.focus();}
        if(event.key==='ArrowLeft'&&parent){event.preventDefault();event.stopPropagation();menu.remove();parent.querySelector('button.has-submenu:focus')?.focus();}
      });menu.append(button);
    }
    (parent||document.body).append(menu);const box=menu.getBoundingClientRect();menu.style.left=`${left+box.width>window.innerWidth-4?Math.max(2,parent?left-box.width-parent.getBoundingClientRect().width:window.innerWidth-box.width-4):left}px`;menu.style.top=`${Math.max(2,Math.min(top,window.innerHeight-box.height-4))}px`;return menu;
  }
  contextMenu=createMenu(items,x,y);
}
function closeContextMenu(){contextMenu?.remove();contextMenu=null;$$('.menu-button').forEach(button=>button.setAttribute('aria-expanded','false'));}
function activeFileId(){const entry=state.terminals.get(state.active);return !state.home&&entry&&!entry.ended&&['ssh','sftp','ftp','ftps','s3'].includes(entry.config.type)?entry.id:null;}
async function showFiles(open=!state.files){state.files=open;$('.sidebar-shell').classList.toggle('files-active',open);$('#file-sidebar').classList.toggle('hidden',!open);$('.session-sidebar').classList.toggle('hidden',open);$('#rail-files').classList.toggle('active',open);$('#rail-sessions').classList.toggle('active',!open);$('#toggle-files').classList.toggle('active',open);requestAnimationFrame(fitVisible);if(open)await refreshFilesForActive();}
async function refreshFilesForActive(){if(!state.files)return;const fileId=activeFileId();if(state.fileId!==fileId){state.fileId=fileId;state.filePath='';}const fileType=state.terminals.get(fileId)?.config.type;$('#file-heading-label').textContent=fileId?`${['ssh','sftp'].includes(fileType)?'SFTP':fileType==='s3'?'S3':'Remote'} files`:'Local files';$('#file-upload').disabled=!fileId;await loadFiles(state.filePath||undefined);}
function joinPath(base,name){const separator=state.fileId||base.includes('/')?'/':'\\';return base.endsWith(separator)?base+name:base+separator+name;}
function sizeString(bytes){if(bytes===undefined||bytes===null)return '';if(bytes<1024)return`${bytes} B`;if(bytes<1024**2)return`${(bytes/1024).toFixed(1)} KB`;if(bytes<1024**3)return`${(bytes/1024**2).toFixed(1)} MB`;return`${(bytes/1024**3).toFixed(1)} GB`;}
async function loadFiles(path){
  const request=++state.fileRequest;const fileId=state.fileId;const list=$('#file-entries');list.innerHTML='<div class="file-message">Reading directory…</div>';
  try{const result=await bridge.listFiles({id:fileId,path});if(request!==state.fileRequest)return;state.filePath=result.path;state.fileParent=result.parent;$('#file-path').value=result.path;list.replaceChildren();
    const entries=[...result.entries].sort((a,b)=>(b.type==='directory')-(a.type==='directory')||a.name.localeCompare(b.name));
    if(!entries.length)list.append(element('div','file-message','This folder is empty.'));
    entries.forEach(entry=>{const row=element('div',`file-row file-entry${entry.type==='directory'?' is-directory':''}`);row.tabIndex=0;row.title=`${entry.name}${entry.modified?`\nModified ${new Date(entry.modified).toLocaleString()}`:''}`;row.append(iconNode(entry.type==='directory'?'folder':'file'),element('span','file-name',entry.name),element('span','file-size',entry.type==='directory'?'':sizeString(entry.size)));
      const path=joinPath(result.path,entry.name);const open=()=>entry.type==='directory'?loadFiles(path):editFile(path,fileId);
      row.addEventListener('dblclick',handle(open));row.addEventListener('keydown',handle(event=>{if(event.key==='Enter')return open();}));
      const menu=element('button','icon-button file-menu','⋯');menu.setAttribute('aria-label',`Actions for ${entry.name}`);menu.addEventListener('click',event=>{event.stopPropagation();const bounds=menu.getBoundingClientRect();fileContext(entry,path,fileId,bounds.left,bounds.bottom);});row.append(menu);row.addEventListener('contextmenu',event=>{event.preventDefault();fileContext(entry,path,fileId,event.clientX,event.clientY);});list.append(row);
    });$('#file-foot').textContent=`${entries.length} ${entries.length===1?'item':'items'} · ${fileId?'Remote':'Local'} filesystem`;
  }catch(error){if(request!==state.fileRequest)return;list.replaceChildren(element('div','file-message error',message(error)));$('#file-foot').textContent='Directory could not be read.';}
}
function fileContext(entry,path,fileId,x,y){const items=[];items.push([entry.type==='directory'?'Open folder':'Edit text file',entry.type==='directory'?'folder':'edit',()=>entry.type==='directory'?loadFiles(path):editFile(path,fileId)]);if(fileId&&entry.type!=='directory')items.push(['Download…','download',async()=>{const result=await bridge.transfer({id:fileId,direction:'download',remotePath:path});if(!result?.cancelled)toast('Download finished.');}]);items.push(['Rename…','edit',async()=>{const name=await promptValue('Rename item','New name',entry.name);if(!name)return;if(/[\\/]/.test(name)){toast('Enter a name without path separators.',true);return;}await bridge.fileAction({id:fileId,action:'rename',path,newPath:joinPath(state.filePath,name)});await loadFiles(state.filePath);}]);items.push(['Delete…','trash',async()=>{await bridge.fileAction({id:fileId,action:'delete',path});await loadFiles(state.filePath);},true]);showContextMenu(x,y,items);}
async function editFile(path,fileId){const result=await bridge.readFile({id:fileId,path});modal({title:path.split(/[\\/]/).at(-1)||'Text editor',subtitle:path,icon:'file',wide:true,bodyClass:'editor-body',body:'<textarea id="file-editor" class="file-editor" aria-label="File contents" spellcheck="false"></textarea>',footer:'<span class="footer-message">Text editor · UTF-8</span><button class="button secondary" id="dialog-cancel">Close</button><button class="button primary" id="save-file">Save changes</button>'});$('#file-editor').value=result.content;on('#save-file','click',async()=>{const button=$('#save-file');saveButton(button,true);try{await bridge.writeFile({id:fileId,path,content:$('#file-editor').value});toast('File saved.');}catch(error){toast(message(error),true);}finally{saveButton(button,false);}});$('#file-editor').addEventListener('keydown',event=>{if(event.key==='Tab'){event.preventDefault();const input=event.target;input.setRangeText('  ',input.selectionStart,input.selectionEnd,'end');}if(event.ctrlKey&&event.key.toLowerCase()==='s'){event.preventDefault();$('#save-file').click();}});}

// Macro recording captures keystrokes sent to one terminal together with the
// pause before each one; playback replays them with the same timing.
const MAX_MACRO_DELAY = 60000;
function recordMacroInput(entry, data) {
  const recording = state.recording; if (!recording || recording.terminalId !== entry.id) return;
  const now = Date.now(), delay = Math.min(MAX_MACRO_DELAY, recording.steps.length ? now - recording.last : 0); recording.last = now;
  const previous = recording.steps.at(-1);
  if (previous && delay < 40 && previous.data.length < 4000) previous.data += data; else recording.steps.push({ data, delay });
  $('#macro-banner-text').textContent = `Recording macro · ${recording.steps.length} step${recording.steps.length === 1 ? '' : 's'}`;
}
function startMacroRecording() {
  const entry = state.terminals.get(state.active);
  if (!entry?.term || entry.ended || state.home) { toast('Select a connected terminal, then start recording.'); return; }
  closeModal(); state.recording = { terminalId: entry.id, steps: [], last: Date.now() };
  macroBanner('Recording macro · 0 steps', 'Stop recording', stopMacroRecording); entry.term.focus();
}
async function stopMacroRecording() {
  const recording = state.recording; state.recording = null; macroBanner();
  if (!recording?.steps.length) { toast('Nothing was recorded.'); return; }
  const name = await promptValue('Save recorded macro', 'Macro name', `Recorded macro ${state.macros.length + 1}`); if (!name) return;
  const macro = { id: id(), name, command: recording.steps.map(step => step.data).join('').replace(/\r/g, '\n'), appendEnter: false, steps: recording.steps };
  state.macros = await bridge.saveMacros([...state.macros, macro]); toast(`Saved “${name}” (${recording.steps.length} steps).`);
}
async function runMacro(macro) {
  const entry = state.terminals.get(state.active);
  if (!entry?.term || entry.ended || state.home) { toast('Select a connected terminal first.'); return; }
  if (state.macroRun) { toast('A macro is already running.'); return; }
  const steps = macro.steps?.length ? macro.steps : [{ data: (macro.command || macro.content || '').replace(/\r?\n/g, '\r') + (macro.appendEnter === false ? '' : '\r'), delay: 0 }];
  const run = { cancelled: false }; state.macroRun = run;
  macroBanner(`Running “${macro.name}”`, 'Stop macro', () => { run.cancelled = true; });
  try {
    for (const step of steps) {
      if (step.delay) await new Promise(resolve => setTimeout(resolve, Math.min(step.delay, MAX_MACRO_DELAY)));
      if (run.cancelled || entry.ended) break;
      await bridge.writeTerminal({ id: entry.id, data: step.data });
    }
    toast(run.cancelled ? `Stopped “${macro.name}”.` : `Ran “${macro.name}”.`);
  } finally { state.macroRun = null; macroBanner(); }
}
function macroBanner(text, action, onAction) {
  let banner = $('#macro-banner');
  if (!text) { banner?.remove(); return; }
  if (!banner) { banner = element('div', 'broadcast-banner macro-banner'); banner.id = 'macro-banner'; banner.innerHTML = `${classicIcon('macros')}<span id="macro-banner-text"></span><button id="macro-banner-action"></button>`; $('.main-workspace').append(banner); }
  $('#macro-banner-text').textContent = text; const button = $('#macro-banner-action'); button.textContent = action; button.onclick = onAction;
}
function macrosDialog(){
  modal({title:'Manage saved macros',subtitle:'Macros run in the active terminal.',icon:'code',body:'<div class="inline-actions"><span>Macros run in the active terminal.</span><button class="button secondary" id="record-macro">● Record new macro</button><button class="button secondary" id="add-macro">+ New macro</button></div><div id="macros-list" class="stack"></div>',footer:'<button class="button secondary" id="dialog-cancel">Close</button>'});
  $('#app-dialog').classList.add('macros-dialog');
  const list=$('#macros-list');if(!state.macros.length)list.innerHTML=`<div class="empty-state">${svg('code')}<p>No macros yet.<br>Save a command or a few lines you use often.</p></div>`;
  state.macros.forEach(macro=>{const card=element('div','item-card');const info=element('div','item-card-info');info.append(element('span','item-card-title',macro.name),element('span','item-card-description',macro.command||macro.content||''));const actions=element('div','item-card-actions');const run=element('button','icon-button');run.innerHTML=svg('play');run.title='Run macro';run.setAttribute('aria-label',`Run ${macro.name}`);run.addEventListener('click',handle(()=>{closeModal();return runMacro(macro);}));const edit=element('button','icon-button');edit.innerHTML=svg('edit');edit.setAttribute('aria-label',`Edit ${macro.name}`);edit.addEventListener('click',()=>macroEditor(macro));const remove=element('button','icon-button');remove.innerHTML=svg('trash');remove.setAttribute('aria-label',`Delete ${macro.name}`);remove.addEventListener('click',handle(async()=>{if(await confirmAction('Delete macro?',`“${macro.name}” will be removed.`,'Delete',true)){state.macros=await bridge.saveMacros(state.macros.filter(item=>item.id!==macro.id));macrosDialog();}}));actions.append(run,edit,remove);card.append(iconNode('code'),info,actions);list.append(card);});on('#add-macro','click',()=>macroEditor());on('#record-macro','click',startMacroRecording);
}
function macroEditor(existing){modal({title:existing?'Edit macro':'Create a macro',subtitle:'Commands are sent exactly as written. Review them before running.',icon:'code',body:`<form id="macro-form"><div class="field"><label for="macro-name">Name</label><input id="macro-name" value="${escapeHtml(existing?.name||'')}" required maxlength="120" placeholder="e.g. Check server status"></div><div class="field"><label for="macro-command">Commands</label><textarea id="macro-command" required placeholder="Enter commands, one per line…" spellcheck="false">${escapeHtml(existing?.command||existing?.content||'')}</textarea></div><label class="checkbox-field"><input id="macro-enter" type="checkbox" ${existing?.appendEnter!==false?'checked':''}>Send Enter after the last line</label></form>`,footer:'<button class="button secondary" id="macro-back">Back</button><button class="button primary" type="submit" form="macro-form">Save macro</button>'});on('#macro-back','click',macrosDialog);on('#macro-form','submit',async event=>{event.preventDefault();try{const macro={id:existing?.id||id(),name:$('#macro-name').value.trim(),command:$('#macro-command').value,appendEnter:$('#macro-enter').checked,...(existing?.steps&&$('#macro-command').value===existing.command?{steps:existing.steps}:{})};state.macros=await bridge.saveMacros([...state.macros.filter(m=>m.id!==macro.id),macro]);macrosDialog();toast('Macro saved.');}catch(error){errorInDialog(error);}});}

async function tunnelsDialog(){
  state.tunnels=await bridge.listTunnels();modal({title:'SSH tunnels',subtitle:'Graphical port forwarding tool',icon:'route',body:'<div class="inline-actions"><span>Listeners bind to 127.0.0.1.</span><button class="button secondary" id="add-tunnel">New SSH tunnel</button></div><div class="tunnel-table-header"><span>Name</span><span>Type</span><span>Forward port</span><span>Destination server</span><span>SSH server</span><span>Start/stop</span></div><div id="tunnels-list" class="stack"></div>',footer:'<button class="button secondary" id="dialog-cancel">Close</button>'});
  const list=$('#tunnels-list');if(!state.tunnels.length)list.innerHTML=`<div class="empty-state">${svg('route')}<p>No active tunnels.<br>Safely reach a remote service through SSH.</p></div>`;
  $('#app-dialog').classList.add('tunnels-dialog');
  state.tunnels.forEach(tunnel=>{const row=element('div','native-tunnel-row');const cells=[tunnel.name||tunnel.host||'SSH tunnel',tunnel.mode==='dynamic'?'Dynamic':tunnel.mode==='remote'?'Remote':'Local',String(tunnel.mode==='remote'?tunnel.remotePort:tunnel.localPort),tunnel.mode==='dynamic'?'SOCKS5':`${tunnel.remoteHost||'127.0.0.1'}:${tunnel.remotePort||tunnel.localPort}`,tunnel.host];for(const value of cells)row.append(element('span','',value));const stop=element('button','button secondary','Stop');stop.addEventListener('click',handle(async()=>{await bridge.closeTunnel(tunnel.id);await tunnelsDialog();toast('Tunnel stopped.');}));row.append(stop);list.append(row);});
  on('#add-tunnel','click',tunnelEditor);

}
function tunnelEditor(){
  const active=state.terminals.get(state.active)?.config;const ssh=active?.type==='ssh'?active:{};
  modal({title:'Create an SSH tunnel',subtitle:'Open a local route to a remote service.',icon:'route',body:`<form id="tunnel-form"><div class="field"><label for="tunnel-name">Name</label><input id="tunnel-name" placeholder="e.g. Production database" maxlength="120"></div><div class="field-row"><div class="field"><label for="tunnel-host">SSH host</label><input id="tunnel-host" required value="${escapeHtml(ssh.host||'')}" placeholder="bastion.example.com"></div><div class="field port-field"><label for="tunnel-port">SSH port</label><input id="tunnel-port" type="number" min="1" max="65535" value="${Number(ssh.port)||22}" required></div></div><div class="field-row"><div class="field"><label for="tunnel-username">Username</label><input id="tunnel-username" value="${escapeHtml(ssh.username||'')}" required autocomplete="username"></div><div class="field"><label for="tunnel-password">Password</label><input id="tunnel-password" type="password" autocomplete="new-password" placeholder="Or select a private key"></div></div><div class="field"><label for="tunnel-key">Private key · optional</label><div class="input-with-button"><input id="tunnel-key" value="${escapeHtml(ssh.privateKeyPath||'')}" placeholder="Path to private key"><button class="button secondary" type="button" id="tunnel-key-browse">Browse…</button></div></div><div class="field"><label for="tunnel-passphrase">Key passphrase · optional</label><input id="tunnel-passphrase" type="password" autocomplete="new-password"></div><div class="divider"></div><div class="field-row"><div class="field"><label for="tunnel-local-port">Local port</label><input id="tunnel-local-port" type="number" min="1" max="65535" required placeholder="5433"></div><div class="field"><label for="tunnel-remote-host">Remote destination</label><input id="tunnel-remote-host" required value="127.0.0.1"></div><div class="field port-field"><label for="tunnel-remote-port">Remote port</label><input id="tunnel-remote-port" type="number" min="1" max="65535" required placeholder="5432"></div></div></form>`,footer:'<button class="button secondary" id="tunnel-back">Back</button><button class="button primary" type="submit" form="tunnel-form" id="start-tunnel">Start tunnel</button>'});
  const modeField=element('div','field');modeField.innerHTML='<label for="tunnel-mode">Tunnel mode</label><select id="tunnel-mode"><option value="local">Local port forwarding</option><option value="remote">Remote / reverse forwarding</option><option value="dynamic">Dynamic SOCKS5 proxy</option></select><small id="tunnel-mode-help">A port on this computer connects to a remote destination through SSH.</small>';$('#tunnel-form').prepend(modeField);
  on('#tunnel-mode','change',()=>{const mode=$('#tunnel-mode').value;const dynamic=mode==='dynamic';$('#tunnel-remote-host').closest('.field').classList.toggle('hidden',mode!=='local');$('#tunnel-remote-port').closest('.field').classList.toggle('hidden',dynamic);$('#tunnel-remote-host').required=mode==='local';$('#tunnel-remote-port').required=!dynamic;$('label[for="tunnel-local-port"]').textContent=mode==='remote'?'Local destination port':'Local port';$('label[for="tunnel-remote-port"]').textContent=mode==='remote'?'Remote listening port':'Remote port';$('#tunnel-mode-help').textContent=mode==='dynamic'?'A local SOCKS5 proxy sends CONNECT traffic through the SSH server.':mode==='remote'?'A loopback port on the SSH server forwards to a local port on this computer.':'A port on this computer connects to a remote destination through SSH.';});
  on('#tunnel-back','click',tunnelsDialog);on('#tunnel-key-browse','click',async()=>{const path=await bridge.pickFile({kind:'key'});if(path)$('#tunnel-key').value=path;});on('#tunnel-form','submit',async event=>{event.preventDefault();const button=$('#start-tunnel');saveButton(button,true);try{await bridge.createTunnel({mode:$('#tunnel-mode').value,name:$('#tunnel-name').value.trim(),host:$('#tunnel-host').value.trim(),port:Number($('#tunnel-port').value),username:$('#tunnel-username').value.trim(),password:$('#tunnel-password').value,privateKeyPath:$('#tunnel-key').value.trim(),passphrase:$('#tunnel-passphrase').value,localHost:'127.0.0.1',localPort:Number($('#tunnel-local-port').value),remoteHost:$('#tunnel-mode').value==='remote'?'127.0.0.1':$('#tunnel-remote-host').value.trim(),remotePort:Number($('#tunnel-remote-port').value)||undefined});await tunnelsDialog();toast('Tunnel is listening.');}catch(error){errorInDialog(error);saveButton(button,false);}});
}

const serverServices=[['tftp','TFTP'],['ftp','FTP'],['http','HTTP'],['ssh','SSH/SFTP'],['telnet','Telnet'],['nfs','NFS'],['vnc','VNC'],['cron','Cron'],['iperf','Iperf'],['echo','TCP echo']];
const serverDefaults={http:{port:8080,text:'Read-only web server for one folder. Listens on 127.0.0.1.'},tftp:{port:6969,text:'Read-only TFTP (octet mode) for one folder, e.g. for network-boot images. Listens on 127.0.0.1.'},echo:{port:7777,text:'Returns every byte it receives. Useful for testing connectivity.'},ftp:{port:2121,text:'FTP or FTPS file server for one folder, with a username and password. Passive mode only.'},ssh:{port:2222,text:'SSH server giving a Windows shell, remote commands and SFTP access to one folder.'},telnet:{port:2323,text:'Telnet server giving a Windows shell after login. Unencrypted.'},iperf:{port:5201,text:'iperf3-compatible server for TCP bandwidth tests (normal and reverse mode).'},cron:{port:0,text:'Runs your scheduled commands while Termora is open.'}};
const availableServers=new Set(Object.keys(serverDefaults));
function serverSummary(server){
  const address=server.type==='cron'?'scheduler':`${server.host==='0.0.0.0'?'all interfaces':server.host}:${server.port}`;
  const details=[server.root,server.username&&`user ${server.username}`,server.writable===true&&'read/write',server.writable===false&&'read-only',server.tls&&`FTPS ${server.tls}`,server.fingerprint&&`host key ${server.fingerprint}`,server.certificate&&`certificate ${server.certificate}`,server.lastResult&&`last test ${(server.lastResult.bitsPerSecond/1e6).toFixed(1)} Mbit/s`].filter(Boolean);
  return {title:`${String(server.type).toUpperCase()} · ${address}`,description:details.join(' · ')||(server.type==='echo'?'TCP echo service':server.type==='cron'?'Scheduled jobs run while Termora is open':'')};
}
async function serversDialog(){
  const servers=await bridge.listServers();
  modal({title:'Termora network services',icon:'servers',wide:true,body:'<div class="services-layout"><nav class="services-navigation" aria-label="Network services"><h3>Network services</h3>'+serverServices.map(([type,label])=>`<button type="button" class="service-choice" data-service="${type}"><span class="service-indicator ${servers.some(server=>server.type===type)?'running':''}"></span>${label}<span class="service-state">${servers.some(server=>server.type===type)?'Running':'Stopped'}</span></button>`).join('')+'</nav><div class="services-detail"><div id="service-description"><h3>Welcome to Termora Network Services</h3><p>Select a server to view its settings.</p></div><div id="servers-list" class="stack"></div></div></div>',footer:'<button class="button secondary" id="add-server">Start server</button><button class="button primary" id="dialog-cancel">OK</button>'});
  $('#app-dialog').classList.add('services-dialog');
  function select(type){
    const label=serverServices.find(service=>service[0]===type)[1],available=availableServers.has(type);
    $$('.service-choice').forEach(button=>button.classList.toggle('selected',button.dataset.service===type));
    const running=servers.find(server=>server.type===type);
    $('#service-description').innerHTML=`<h3>${escapeHtml(label)} server settings</h3>${available?`<p>${escapeHtml(serverDefaults[type].text)}</p>${type==='cron'?'<button class="button secondary" id="configure-service">Scheduled jobs…</button>':'<button class="button secondary" id="configure-service">Configure and start</button>'}`:`<p class="field-hint">${type==='nfs'?'An NFS server is not included in Termora. Windows Server and WSL provide NFS servers.':'A VNC server is not included in Termora. Install a VNC server such as TightVNC to share this desktop.'}</p><fieldset class="native-group" disabled><legend>Server settings</legend><label class="field">Port<input disabled></label></fieldset>`}`;
    if(running&&type!=='cron')$('#service-description').append(element('p','field-hint',`Running: ${serverSummary(running).title}`));
    on('#configure-service','click',()=>type==='cron'?cronDialog():serverEditor(type));
  }
  $$('.service-choice').forEach(button=>button.addEventListener('click',()=>select(button.dataset.service)));
  const list=$('#servers-list');
  if(!servers.length)list.innerHTML='<p class="field-hint">No servers running.</p>';
  servers.forEach(server=>{const summary=serverSummary(server);const card=element('div','item-card');const info=element('div','item-card-info');info.append(element('span','item-card-title',summary.title),element('span','item-card-description',summary.description));const stop=element('button','button secondary','Stop');stop.addEventListener('click',handle(async()=>{await bridge.stopServer(server.id);await serversDialog();toast('Server stopped.');}));card.append(iconNode('server'),info,stop);list.append(card);});
  on('#add-server','click',()=>serverEditor());
}

function serverEditor(initialType='http'){
  const types=[['http','HTTP · read-only folder'],['tftp','TFTP · read-only files'],['ftp','FTP / FTPS'],['ssh','SSH / SFTP'],['telnet','Telnet'],['iperf','iperf3 bandwidth'],['echo','TCP echo']];
  modal({title:'Start a server',subtitle:'Runs until you stop it or close Termora.',icon:'server',body:`<form id="server-form"><div class="field"><label for="server-type">Server type</label><select id="server-type">${types.map(([value,label])=>`<option value="${value}">${label}</option>`).join('')}</select></div><p class="field-hint" id="server-help"></p>
    <div class="field" id="server-root-field"><label for="server-root" id="server-root-label">Directory to serve</label><div class="input-with-button"><input id="server-root" placeholder="Choose a directory"><button class="button secondary" type="button" id="server-root-browse">Browse…</button></div></div>
    <div class="field-row" id="server-login-fields"><div class="field"><label for="server-username">Username</label><input id="server-username" autocomplete="off" maxlength="64" value="termora"></div><div class="field"><label for="server-password">Password</label><input id="server-password" type="password" autocomplete="new-password" minlength="8" maxlength="256" placeholder="At least 8 characters"></div></div>
    <div class="field-row"><div class="field port-field"><label for="server-port">Port</label><input id="server-port" type="number" min="0" max="65535" required><small>0 picks a free port.</small></div><div class="field" id="server-shell-field"><label for="server-shell">Shell</label><select id="server-shell">${shellOptions()}</select></div><div class="field" id="server-tls-field"><label for="server-tls">Encryption</label><select id="server-tls"><option value="explicit">FTPS · explicit (AUTH TLS)</option><option value="implicit">FTPS · implicit SSL</option><option value="none">None · plain FTP</option></select></div></div>
    <label class="checkbox-field" id="server-writable-field"><input type="checkbox" id="server-writable" checked>Allow uploads, renames and deletes</label>
    <label class="checkbox-field" id="server-listen-field"><input type="checkbox" id="server-listen">Allow connections from other computers (all network interfaces)</label>
    <div class="info-box warning hidden" id="server-warning"></div></form>`,footer:'<button class="button secondary" id="server-back">Back</button><button class="button primary" type="submit" form="server-form" id="start-server">Start server</button>'});
  const show=(selector,visible)=>$(selector).classList.toggle('hidden',!visible);
  const update=(resetPort=true)=>{
    const type=$('#server-type').value,login=['ftp','ssh','telnet'].includes(type);
    $('#server-help').textContent=serverDefaults[type].text;
    show('#server-root-field',['http','tftp','ftp','ssh','telnet'].includes(type));
    $('#server-root').required=['http','tftp','ftp'].includes(type);
    $('#server-root-label').textContent=type==='ssh'?'SFTP root folder · optional (empty disables SFTP)':type==='telnet'?'Starting folder · optional':'Directory to serve';
    show('#server-login-fields',login);$('#server-password').required=login;$('#server-username').required=login;
    show('#server-shell-field',['ssh','telnet'].includes(type));show('#server-tls-field',type==='ftp');
    show('#server-writable-field',['ftp','ssh'].includes(type));show('#server-listen-field',['ftp','ssh','telnet','iperf'].includes(type));
    if(resetPort)$('#server-port').value=String(type==='ftp'&&$('#server-tls').value==='implicit'?990:serverDefaults[type].port);
    const exposed=$('#server-listen').checked&&!$('#server-listen-field').classList.contains('hidden');
    const warning=type==='telnet'?'Telnet sends the password and everything you type without encryption.':type==='ftp'&&$('#server-tls').value==='none'?'Plain FTP sends the password and files without encryption.':exposed?'Other computers on your network will be able to reach this server. Windows Firewall may ask for permission.':'';
    $('#server-warning').textContent=warning+(exposed&&warning&&!warning.startsWith('Other')?' Other computers on your network will be able to reach it.':'');show('#server-warning',Boolean(warning));
  };
  $('#server-type').value=availableServers.has(initialType)&&initialType!=='cron'?initialType:'http';update();
  on('#server-type','change',()=>update());on('#server-listen','change',()=>update(false));on('#server-tls','change',()=>{const port=$('#server-port');if(['2121','21','990'].includes(port.value))port.value=$('#server-tls').value==='implicit'?'990':'2121';update(false);});
  on('#server-back','click',serversDialog);on('#server-root-browse','click',async()=>{const path=await bridge.pickFile({kind:'folder'});if(path)$('#server-root').value=path;});
  on('#server-form','submit',async event=>{event.preventDefault();const button=$('#start-server');saveButton(button,true);const type=$('#server-type').value;
    try{const server=await bridge.startServer({type,root:$('#server-root').value.trim()||undefined,port:Number($('#server-port').value),username:$('#server-username').value.trim(),password:$('#server-password').value,shell:$('#server-shell').value,tls:$('#server-tls').value,writable:$('#server-writable').checked,listen:$('#server-listen').checked?'all':'local'});await serversDialog();toast(`${type.toUpperCase()} server listening on port ${server.port}.`);}catch(error){errorInDialog(error);saveButton(button,false);}});
}

async function cronDialog(){
  const [{jobs,results},servers]=await Promise.all([bridge.listCronJobs(),bridge.listServers()]);
  state.cronJobs=jobs;const running=servers.find(server=>server.type==='cron');
  modal({title:'Scheduled jobs',subtitle:'Cron-style commands that run while Termora is open.',icon:'clock',wide:true,body:`<div class="inline-actions"><span>${running?'<span class="dot green-dot"></span> Scheduler running':'<span class="dot amber-dot"></span> Scheduler stopped · jobs do not run on schedule'}</span><button class="button secondary" id="toggle-cron">${running?'Stop scheduler':'Start scheduler'}</button><button class="button secondary" id="add-cron">New job</button></div><div id="cron-list" class="stack"></div>`,footer:'<button class="button secondary" id="cron-back">Back</button><button class="button primary" id="dialog-cancel">Close</button>'});
  const list=$('#cron-list');
  if(!jobs.length)list.innerHTML=`<div class="empty-state">${svg('clock')}<p>No scheduled jobs yet.<br>Run a backup script every night or a health check every five minutes.</p></div>`;
  jobs.forEach(job=>{const result=results[job.id];const card=element('div','item-card');const info=element('div','item-card-info');
    info.append(element('span','item-card-title',`${job.enabled?'':'⏸ '}${job.name}`),element('span','item-card-description',`${job.schedule} · ${job.command}`));
    if(result)info.append(element('span','item-card-description',`Last run ${new Date(result.finished).toLocaleString()} · exit ${result.exitCode}${result.output?` · ${result.output.trim().split(/\r?\n/).pop().slice(0,120)}`:''}`));
    const actions=element('div','item-card-actions');
    const run=element('button','icon-button');run.innerHTML=svg('play');run.title='Run now';run.setAttribute('aria-label',`Run ${job.name} now`);run.addEventListener('click',handle(async()=>{saveButton(run,true);const outcome=await bridge.runCronJob(job.id);if(outcome.skipped)toast('That job is still running.');else{toast(`${job.name} finished with exit code ${outcome.exitCode}.`);}await cronDialog();}));
    const edit=element('button','icon-button');edit.innerHTML=svg('edit');edit.setAttribute('aria-label',`Edit ${job.name}`);edit.addEventListener('click',()=>cronEditor(job));
    const remove=element('button','icon-button');remove.innerHTML=svg('trash');remove.setAttribute('aria-label',`Delete ${job.name}`);remove.addEventListener('click',handle(async()=>{if(await confirmAction('Delete job?',`“${job.name}” will no longer run.`,'Delete',true)){await bridge.saveCronJobs(state.cronJobs.filter(item=>item.id!==job.id));await cronDialog();}}));
    actions.append(run,edit,remove);card.append(iconNode('clock'),info,actions);list.append(card);});
  on('#add-cron','click',()=>cronEditor());on('#cron-back','click',serversDialog);
  on('#toggle-cron','click',handle(async()=>{if(running)await bridge.stopServer(running.id);else await bridge.startServer({type:'cron'});await cronDialog();}));
}
function cronEditor(existing){
  modal({title:existing?'Edit scheduled job':'New scheduled job',subtitle:state.platform==='darwin'?'Commands run with your macOS account.':'Commands run with your Windows account, without a window.',icon:'clock',body:`<form id="cron-form"><div class="field"><label for="cron-name">Name</label><input id="cron-name" maxlength="120" value="${escapeHtml(existing?.name||'')}" placeholder="e.g. Nightly backup"></div><div class="field-row"><div class="field"><label for="cron-schedule">Schedule</label><input id="cron-schedule" required spellcheck="false" value="${escapeHtml(existing?.schedule||'0 2 * * *')}" placeholder="minute hour day month weekday"><small id="cron-help">minute hour day month weekday · e.g. */5 * * * * (every 5 minutes), 0 9 * * 1-5 (weekdays 09:00), @daily</small></div><div class="field"><label for="cron-shell">Shell</label><select id="cron-shell">${shellOptions(existing?.shell)}</select></div></div><div class="field"><label for="cron-command">Command</label><textarea id="cron-command" required spellcheck="false" placeholder="e.g. robocopy C:\\Work D:\\Backup /MIR">${escapeHtml(existing?.command||'')}</textarea></div><label class="checkbox-field"><input type="checkbox" id="cron-enabled" ${existing?.enabled===false?'':'checked'}>Enabled</label></form>`,footer:'<button class="button secondary" id="cron-editor-back">Back</button><button class="button primary" type="submit" form="cron-form">Save job</button>'});
  on('#cron-editor-back','click',cronDialog);
  on('#cron-form','submit',async event=>{event.preventDefault();try{const job={id:existing?.id||id(),name:$('#cron-name').value.trim(),schedule:$('#cron-schedule').value.trim(),command:$('#cron-command').value.trim(),shell:$('#cron-shell').value,enabled:$('#cron-enabled').checked};state.cronJobs=await bridge.saveCronJobs([...(state.cronJobs||[]).filter(item=>item.id!==job.id),job]);await cronDialog();toast('Job saved.');}catch(error){errorInDialog(error);}});
}

function toolsDialog(){
  let selected='ping';modal({title:'Network tools',subtitle:'A few useful answers, without leaving your workspace.',icon:'activity',body:`<div class="tool-picker"><button class="tool-option selected" data-tool="ping">Ping</button><button class="tool-option" data-tool="dns">DNS lookup</button><button class="tool-option" data-tool="trace">Traceroute</button><button class="tool-option" data-tool="ports">TCP port check</button><button class="tool-option" data-tool="scan">Port scanner</button></div><form id="tool-form"><div class="field-row"><div class="field"><label for="tool-host">Host</label><input id="tool-host" placeholder="hostname or IP address" required autocomplete="off"></div><div class="field port-field hidden" id="tool-port-field"><label for="tool-port">Port</label><input id="tool-port" type="number" min="1" max="65535" value="22"></div><div class="field hidden" id="tool-ports-field"><label for="tool-ports">Ports</label><input id="tool-ports" value="21-23,25,53,80,110,135,139,143,443,445,993,995,1433,3306,3389,5432,5900,8080" spellcheck="false" autocomplete="off"><small>Up to 4096 ports: numbers and ranges such as 1-1024.</small></div></div></form><pre id="tool-output" class="tool-output" aria-live="polite">Choose a tool and enter a host to get started.</pre>`,footer:'<span class="footer-message">Runs from this computer. Scan only hosts you are allowed to test.</span><button class="button secondary" id="dialog-cancel">Close</button><button class="button primary" type="submit" form="tool-form" id="run-tool">Run check</button>'});
  const x11=element('div','inline-actions');const x11Label=element('span','','External X11 server · SSH sessions with X11-Forwarding display here');const x11Button=element('button','text-button');x11Button.innerHTML=`${svg('monitor')}Start X11 server`;x11Button.disabled=!capability('x11');x11Button.title=capability('x11')?'Launch the installed X11 server':'Install VcXsrv to enable this launcher';x11Button.addEventListener('click',handle(async()=>{await bridge.launchExternal({type:'x11'});toast('X11 server launcher started.');}));x11.append(x11Label,x11Button);$('.tool-picker').after(x11);
  $$('.tool-option').forEach(button=>button.addEventListener('click',()=>{selected=button.dataset.tool;$$('.tool-option').forEach(item=>item.classList.toggle('selected',item===button));$('#tool-port-field').classList.toggle('hidden',selected!=='ports');$('#tool-ports-field').classList.toggle('hidden',selected!=='scan');$('#run-tool').textContent=selected==='scan'?'Start scan':'Run check';}));
  on('#tool-form','submit',async event=>{event.preventDefault();const button=$('#run-tool');const output=$('#tool-output');saveButton(button,true);output.textContent=selected==='scan'?'Scanning…':'Running…';try{const result=await bridge.runTool({tool:selected,host:$('#tool-host').value.trim(),port:Number($('#tool-port').value),ports:$('#tool-ports').value});if(output.isConnected)output.textContent=typeof result==='string'?result:result.output||JSON.stringify(result,null,2);}catch(error){if(output.isConnected)output.textContent=message(error);}finally{saveButton(button,false);}});
}
function applySettings(){document.body.classList.toggle('theme-light',state.settings.theme==='light');const view=state.settings.ui||{};document.body.classList.toggle('sidebar-right',view.sidebarSide==='right');document.body.classList.toggle('sidebar-hidden',Boolean(view.sidebarHidden));document.body.classList.toggle('chrome-menu-only',view.chrome==='menu');document.body.classList.toggle('chrome-toolbar-only',view.chrome==='toolbar');document.body.classList.toggle('toolbar-standard',view.toolbarStyle==='standard');document.body.classList.toggle('toolbar-small',view.toolbarStyle==='small');document.body.classList.toggle('tabs-square',view.roundedTabs===false);document.body.classList.toggle('tabs-no-close',view.tabClose===false);for(const entry of state.terminals.values())if(entry.term){entry.term.options.theme=terminalTheme();entry.term.options.fontSize=Number(state.settings.fontSize)||14;entry.term.options.fontFamily=state.settings.fontFamily||'Cascadia Code, Consolas, monospace';entry.term.options.scrollback=Number(state.settings.scrollback)||10000;}requestAnimationFrame(fitVisible);}
function settingsDialog(initialTab = 'General') {
  modal({title:'Configuration',icon:'settings',body:configurationMarkup(state.settings,{vault:state.vault,logDirectory:state.logDirectory,x11Installed:capability('x11')}),bodyClass:'configuration-body',footer:'<button class="button primary" type="submit" form="settings-form">OK</button><button class="button secondary" id="dialog-cancel">Cancel</button>'});
  $('#app-dialog').classList.add('configuration-dialog');
  const tabs=$$('[data-config-tab]');
  const select=name=>{tabs.forEach(button=>{const active=button.dataset.configTab===name;button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;});$$('[data-config-pane]').forEach(pane=>pane.classList.toggle('hidden',pane.dataset.configPane!==name));};
  tabs.forEach(button=>button.addEventListener('click',()=>select(button.dataset.configTab)));
  $('.configuration-tabs').addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const current=tabs.indexOf(document.activeElement),index=event.key==='Home'?0:event.key==='End'?tabs.length-1:(current+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;tabs[index].focus();select(tabs[index].dataset.configTab);});
  select(typeof initialTab==='string'?initialTab:'General');
  on('#configuration-sessions','click',()=>{closeModal();showFiles(false);});
  on('#configuration-import','click',()=>{closeModal();return importSessions();});
  on('#configuration-export','click',async()=>{const result=await bridge.exportSessions();if(!result.cancelled)toast('Sessions exported.');});
  on('#settings-log-browse','click',async()=>{const folder=await bridge.pickFile({kind:'logs'});if(folder)$('#settings-log-directory').value=folder;});
  on('#settings-forget-passwords','click',async()=>{if(!await confirmAction('Forget saved passwords?','Every saved password and key passphrase will be deleted. Sessions stay saved.','Forget passwords',true))return;for(const sessionId of [...state.vault.saved])await bridge.forgetCredentials(sessionId);state.vault.saved=[];state.sessions=await bridge.saveSessions(state.sessions.map(s=>({...s,savePassword:false})));toast('Saved passwords deleted.');settingsDialog('Security');});
  on('#settings-form','submit',async event=>{event.preventDefault();try{
    const ui={...state.settings.ui,sidebarSide:$('#settings-sidebar-side').value,chrome:$('#settings-chrome').value,toolbarStyle:$('#settings-toolbar-style').value};
    $$('[data-view-setting]').forEach(input=>ui[input.dataset.viewSetting]=input.checked);
    const settings={...state.settings,theme:$('#settings-theme').value,fontFamily:$('#settings-font').value.trim(),fontSize:Number($('#settings-size').value),scrollback:Number($('#settings-scrollback').value),ui,logging:{enabled:$('#settings-logging').checked,directory:$('#settings-log-directory').value.trim()},highlight:$('#settings-highlight').checked,x11:{display:Number($('#settings-x11-display').value),mode:$('#settings-x11-mode').value,clipboard:$('#settings-x11-clipboard').checked,noAccessControl:$('#settings-x11-ac').checked}};
    state.settings=await bridge.saveSettings(settings);applySettings();renderTabs();closeModal();toast('Settings saved.');
  }catch(error){errorInDialog(error);}});
}
function shortcutsDialog(){modal({title:'Keyboard shortcuts',icon:'settings',body:'<table class="native-table"><thead><tr><th>Action</th><th>Shortcut</th></tr></thead><tbody>'+[['New session','Ctrl + N'],['New local terminal','Ctrl + Shift + T'],['Find in terminal','Ctrl + Shift + F'],['Copy selection','Ctrl + Shift + C'],['Paste into terminal','Ctrl + Shift + V'],['Next tab','Ctrl + Tab'],['Previous tab','Ctrl + Shift + Tab'],['Font size','Ctrl + / −']].map(([action,key])=>`<tr><td>${action}</td><td>${key}</td></tr>`).join('')+'</tbody></table>',footer:'<button class="button primary" id="dialog-cancel">OK</button>'});}

function aboutDialog(){const features=[[state.platform==='darwin'?'Local login shell':'Local PowerShell / CMD','local'],['SSH + SFTP','ssh'],['Linux / WSL','wsl'],['Telnet','telnet'],['Serial terminal','serial'],['FTP / FTPS files','ftp'],['Native RDP launcher','rdp'],['External VNC launcher','vnc'],['External X11 server','x11']];modal({title:'About your workspace',subtitle:'Independent terminal and remote-session workstation.',icon:'info',body:`<div class="about-intro"><span class="brand-mark">›_</span><div><h3>termora<span class="text-accent">.</span></h3><p>Version ${escapeHtml(state.version)}<br>Built to make your connections feel at home.</p></div></div><div class="info-box">This is an independent implementation. MobaXterm’s proprietary components, plugins, icons, licensing, and full feature parity are not included. Feature coverage is tracked in the project documentation.</div><h3 class="subheading">Available on this computer</h3><div class="support-grid">${features.map(([label,key])=>`<div class="support-row"><span>${label}</span><span class="support-state${capability(key)?'':' missing'}">${capability(key)?'Available':'Not installed'}</span></div>`).join('')}</div><p class="field-hint">Split terminals, broadcast input, saved sessions, macros, text editing, SSH tunnels, and network tools are included. Remote desktop and X11 integrations use separately installed tools. Saved connection passwords are never persisted.</p>`,footer:'<button class="button secondary" id="dialog-cancel">Close</button>'});}
async function finishSessionImport(result) {
  if (!result || result.cancelled) return;
  if (Array.isArray(result)) state.sessions = result;
  else if (Array.isArray(result.sessions)) state.sessions = result.sessions;
  else { const data = await bridge.bootstrap(); state.sessions = data.sessions || state.sessions; }
  renderSessions();
  toast(result.imported !== undefined ? `${result.imported} ${result.imported === 1 ? 'session' : 'sessions'} imported.` : `${state.sessions.length} saved sessions available.`);
  if (result.warnings?.length) modal({title:'Sessions imported',subtitle:'A few details about this import.',icon:'import',body:result.warnings.map(warning=>`<div class="info-box warning">${escapeHtml(warning)}</div>`).join(''),footer:'<button class="button primary" id="dialog-cancel">Done</button>'});
}
function unlockImportDialog(result) {
  modal({ title: 'Unlock MobaXterm backup', subtitle: result.fileName, icon: 'import',
    body: '<form id="import-unlock-form"><label class="field">Export / master password<input id="import-password" type="password" autocomplete="off" required maxlength="4096"></label><p>Enter the password used to protect this backup. Only supported sessions and folders will be imported. Saved passwords and application settings are excluded.</p></form>',
    footer: '<button class="button secondary" id="dialog-cancel">Cancel</button><button class="button primary" id="import-unlock" type="submit" form="import-unlock-form">Unlock and import</button>' });
  const input = $('#import-password'), button = $('#import-unlock');
  let completed = false, dismissed = false;
  modalCleanup = () => { dismissed = true; input.value = ''; if (!completed) bridge.importSessions({ token: result.token, cancel: true }).catch(() => {}); };
  on('#import-unlock-form', 'submit', async event => {
    event.preventDefault();
    if (button.disabled) return;
    saveButton(button, true);
    try {
      const pending = bridge.importSessions({ token: result.token, password: input.value });
      input.value = '';
      const imported = await pending;
      if (dismissed) return;
      completed = true; closeModal(); await finishSessionImport(imported);
    } catch (error) { if (!dismissed) { errorInDialog(error); input.focus(); } }
    finally { saveButton(button, false); }
  });
  input.focus();
}
async function importSessions() {
  const result = await bridge.importSessions();
  if (result?.needsPassword) unlockImportDialog(result);
  else await finishSessionImport(result);
}

async function selectTheme(theme){
  state.settings=await bridge.saveSettings({...state.settings,theme});applySettings();
  $$('.theme-choice').forEach(button=>{button.classList.toggle('selected',button.dataset.theme===theme);button.classList.toggle('active',button.dataset.theme===theme);button.setAttribute('aria-pressed',String(button.dataset.theme===theme));});
}
function menuItems(name){
  const local=()=>connect({type:'local',shell:'powershell'});
  const home=()=>{state.home=true;renderWorkspace();};
  const sessions=()=>showFiles(false);
  const rename=async()=>{const entry=state.terminals.get(state.active);if(!entry)return;const name=await promptValue('Set tab title','Tab title',entry.label);if(name){entry.label=name;$('.pane-title',entry.pane).textContent=name;renderTabs();updateStatus();}};
  const duplicate=()=>{const entry=state.terminals.get(state.active);if(entry)return connect({...entry.config});};
  const view=(key,value)=>async()=>{state.settings=await bridge.saveSettings({...state.settings,ui:{...state.settings.ui,[key]:value}});applySettings();renderTabs();};
  const split=(count,horizontal=false)=>()=>{state.layout=count;document.body.classList.toggle('split-horizontal',horizontal);if(state.active)state.home=false;renderWorkspace();};
  const menus={
    terminal:[['Open new tab','add',local],['Close current tab','remove',()=>state.active?closeTerminal(state.active):undefined],null,['Set tab title','edit',rename],['Detach','detach',()=>detachTerminal(state.active)],['Save terminal text','save',()=>saveTerminalOutput(state.terminals.get(state.active))],['Print terminal text','print',null],['Find in terminal','search',showSearch],['Find next','findnext',()=>{if($('#terminal-search-input').value)$('#search-next').click();else showSearch();}],null,['Duplicate current tab','duplicate',duplicate],['Write commands on all terminals','multiexec',toggleBroadcast],null,['Quit','exit',()=>bridge.windowAction('close')]],
    sessions:[['New session','session',()=>sessionDialog()],['Manage my sessions','sessions',sessions],null,['Import sessions...','import',importSessions],['Export sessions...','export',async()=>{const result=await bridge.exportSessions();if(result&&!result.cancelled)toast('Sessions exported.');}]],
    view:[['Single terminal mode','shell',split(1)],['2 terminals mode (vertical split)','split',split(2)],['2 terminals mode (horizontal split)','split',split(2,true)],['4 terminals mode','split',split(4)],null,['Compact mode','fullscreen',view('toolbarStyle','small')],['Fullscreen mode','fullscreen',()=>bridge.windowAction('fullscreen')],['Iconify Termora','remove',()=>bridge.windowAction('minimize')],null,['Show menu bar','',view('chrome','menu')],['Show buttons bar','',view('chrome','toolbar')],['Show both','',view('chrome','both')],null,['Small buttons','',view('toolbarStyle','small')],['Standard buttons','',view('toolbarStyle','standard')],['Standard buttons with captions','',view('toolbarStyle','captions')],null,['Terminal zoom','add',()=>{state.settings.fontSize=Math.min(32,state.settings.fontSize+1);applySettings();}],['Terminal unzoom','remove',()=>{state.settings.fontSize=Math.max(9,state.settings.fontSize-1);applySettings();}],null,['Show/hide sidebar','files',view('sidebarHidden',!state.settings.ui?.sidebarHidden)],['Put sidebar on the left','',view('sidebarSide','left')],['Put sidebar on the right','',view('sidebarSide','right')],null,['Show tab numbers','',view('tabNumbers',!state.settings.ui?.tabNumbers)],['Show close button','',view('tabClose',state.settings.ui?.tabClose===false)],null,['Toggle light/dark theme','settings',()=>selectTheme(state.settings.theme==='light'?'dark':'light')]],
    xserver:[['Start X server','xserver',()=>bridge.launchExternal({type:'x11'})],['XDMCP session','xdmcp',()=>sessionDialog(null,'xdmcp')]],
    tools:[['System','settings',null,false,[['List hardware devices','',null],['List installed software','',null],['List running processes','',null],...(state.platform==='darwin'?[['Local terminal','shell',local]]:[['Command Prompt','shell',()=>connect({type:'local',shell:'cmd'})],['Windows PowerShell','shell',local]])]],['Office','file',null,false,[['Text editor','file',()=>showFiles(true)],['Compare files','',null],['Ascii table','',null]]],['Network','servers',null,false,[['Network services','servers',serversDialog],['SSH tunnels (port forwarding)','tunneling',tunnelsDialog],['SSH key generator','ssh',null],['Network tools','tools',toolsDialog],['Network scanner','',null],['Ports scanner','',null],['Network packets capture','',null]]],['Remote sessions','session',null,false,protocols.map(([type,label])=>[label,({local:'shell'})[type]||type,()=>sessionDialog(null,type)])]],
    games:[['Terminal games','games',null,false,['Soliterm','Termwalk','Ctris','Sudoku','Nimesweeper','Ninvaders','Greed','Typespeed'].map(label=>[label,'',null])],...['Netwalk','Mines','Solo','Guess','Map','Untangle','Tux consolesaver'].map(label=>[label,'games',null])],
    settings:[['Configuration','settings',()=>settingsDialog()],['Keyboard shortcuts','shell',shortcutsDialog],['Key mapping','',null],null,['Import configuration','import',importSessions],['Export configuration','export',null],['Reset configuration','',null],null,['Manage shared sessions','sessions',null],null,['Edit session presets','session',null]],
    macros:[state.recording?['Stop recording macro','macros',stopMacroRecording]:['Record new macro','macros',startMacroRecording],['Manage saved macros','macros',macrosDialog],null,['Saved macros','macros',null,false,state.macros.length?state.macros.map(m=>[m.name,'macros',()=>runMacro(m)]):[['No saved macros','',null]]],['Create new empty macro','add',()=>macroEditor()]],
    help:[['Keyboard shortcuts','shell',shortcutsDialog],['Feature support','help',aboutDialog],null,['About Termora','help',aboutDialog]],
  };
  return menus[name]||[];
}
function openApplicationMenu(button,name){
  const box=button.getBoundingClientRect();showContextMenu(box.left,box.bottom,menuItems(name),true);
  $$('.menu-button').forEach(item=>item.setAttribute('aria-expanded',String(item===button)));
}
function quickConnect(value){
  const target=value.trim();if(!target)return;
  let seed;
  try{const url=new URL(target.includes('://')?target:`ssh://${target}`);if(url.protocol!=='ssh:')throw new Error();seed={host:url.hostname.replace(/^\[|\]$/g,''),username:decodeURIComponent(url.username),port:Number(url.port)||22};}
  catch{toast('Use hostname, user@hostname, or user@hostname:port.',true);return;}
  sessionDialog(null,'ssh',seed);
}
function bindEvents(){
  $$('.menu-button[data-menu]').forEach(button=>{button.setAttribute('aria-haspopup','menu');button.setAttribute('aria-expanded','false');button.addEventListener('click',()=>openApplicationMenu(button,button.dataset.menu));button.addEventListener('mouseenter',()=>{if(contextMenu)openApplicationMenu(button,button.dataset.menu);});button.addEventListener('keydown',event=>{if(event.key==='ArrowDown'){event.preventDefault();openApplicationMenu(button,button.dataset.menu);contextMenu.querySelector('button:not(:disabled)')?.focus();}});});
  on('#toolbar-view','click',event=>openApplicationMenu(event.currentTarget,'view'));
  on('#toolbar-sessions','click',()=>showFiles(false));on('#rail-sessions','click',()=>showFiles(false));
  on('#rail-files','click',()=>showFiles(true));on('#rail-tools','click',toolsDialog);
  on('#toolbar-split','click',()=>$('#terminal-split').click());on('#toolbar-multiexec','click',toggleBroadcast);
  on('#toolbar-fullscreen','click',()=>bridge.windowAction('maximize'));on('#toolbar-exit','click',()=>bridge.windowAction('close'));
  on('#toolbar-help','click',aboutDialog);on('#home-settings','click',settingsDialog);
  on('#toolbar-import','click',importSessions);on('#toolbar-export','click',async()=>{const result=await bridge.exportSessions();if(result&&!result.cancelled)toast('Sessions exported.');});
  on('#toolbar-xserver','click',()=>bridge.launchExternal({type:'x11'}));
  on('#quick-connect-form','submit',event=>{event.preventDefault();quickConnect($('#quick-connect').value);});
  on('#quick-connect','input',()=>{$('#session-filter').value=$('#quick-connect').value;renderSessions();});
  on('#home-session-search','input',()=>{$('#session-filter').value=$('#home-session-search').value;renderSessions();});
  $$('.theme-choice').forEach(button=>button.addEventListener('click',handle(()=>selectTheme(button.dataset.theme))));
  on('#window-minimize','click',()=>bridge.windowAction('minimize'));on('#window-maximize','click',()=>bridge.windowAction('maximize'));on('#window-close','click',()=>bridge.windowAction('close'));
  ['#new-session','#sidebar-add','#hero-connect','#tab-add','#card-ssh'].forEach(selector=>on(selector,'click',()=>sessionDialog()));
  ['#quick-local','#hero-local','#card-powershell'].forEach(selector=>on(selector,'click',()=>connect({type:'local',shell:'powershell'})));
  on('#card-wsl','click',()=>capability('wsl')?connect({type:'wsl'}):sessionDialog(null,'wsl'));on('#card-rdp','click',()=>sessionDialog(null,'rdp'));
  ['#show-home','#overview-tab'].forEach(selector=>on(selector,'click',()=>{state.home=true;renderWorkspace();if(state.files)refreshFilesForActive();}));
  on('#session-filter','input',renderSessions);on('#toggle-files','click',()=>showFiles());on('#close-files','click',()=>showFiles(false));
  on('#open-settings','click',settingsDialog);on('#show-coverage','click',aboutDialog);on('#open-macros','click',macrosDialog);on('#open-tunnels','click',tunnelsDialog);on('#open-tools','click',toolsDialog);on('#open-servers','click',serversDialog);
  ['#import-sessions','#home-import'].forEach(selector=>on(selector,'click',importSessions));on('#export-sessions','click',async()=>{const result=await bridge.exportSessions();if(result&&!result.cancelled)toast('Sessions exported.');});
  on('#terminal-split','click',()=>{state.layout=state.layout===1?2:state.layout===2?4:1;if(!state.terminals.size){toast('Open a terminal to use split panes.');return;}state.home=false;renderWorkspace();});
  on('#terminal-broadcast','click',toggleBroadcast);on('#broadcast-stop','click',()=>{state.broadcast=false;renderWorkspace();});on('#terminal-reconnect','click',reconnectActive);on('#terminal-find','click',showSearch);
  on('#search-close','click',()=>{$('#terminal-search').classList.add('hidden');state.terminals.get(state.active)?.term?.focus();});
  const find=(previous=false)=>{const entry=state.terminals.get(state.active);const query=$('#terminal-search-input').value;if(query&&entry?.search)(previous?entry.search.findPrevious(query,state.searchOptions):entry.search.findNext(query,state.searchOptions));};on('#search-next','click',()=>find());on('#search-prev','click',()=>find(true));on('#terminal-search-input','keydown',event=>{if(event.key==='Enter'){event.preventDefault();find(event.shiftKey);}if(event.key==='Escape')$('#search-close').click();});
  on('#file-path-form','submit',event=>{event.preventDefault();return loadFiles($('#file-path').value.trim());});on('#file-up','click',()=>loadFiles(state.fileParent||state.filePath));on('#file-refresh','click',()=>loadFiles(state.filePath));
  on('#file-new-folder','click',async()=>{const name=await promptValue('Create a folder','Folder name');if(!name)return;if(/[\\/]/.test(name)){toast('Enter a folder name without path separators.',true);return;}await bridge.fileAction({id:state.fileId,action:'mkdir',path:joinPath(state.filePath,name)});await loadFiles(state.filePath);});
  on('#file-upload','click',async()=>{if(!state.fileId)return;const result=await bridge.transfer({id:state.fileId,direction:'upload',remotePath:state.filePath});if(result&&!result.cancelled)toast('Upload finished.');await loadFiles(state.filePath);});
  document.addEventListener('pointerdown',event=>{if(contextMenu&&!contextMenu.contains(event.target))closeContextMenu();});
  document.addEventListener('keydown',handle(async event=>{
    if(event.key==='Escape'){closeContextMenu();if($('#app-dialog').open)closeModal();return;}
    if($('#app-dialog').open)return;
    if(event.ctrlKey&&event.code==='Tab'){event.preventDefault();if(state.order.length){const current=state.order.indexOf(state.active),next=(current+(event.shiftKey?-1:1)+state.order.length)%state.order.length;activate(state.order[next]);}return;}
    if(event.ctrlKey&&!event.shiftKey&&event.code==='KeyN'){event.preventDefault();if(!event.defaultPrevented||!$('#app-dialog').open)sessionDialog();}
    if(event.ctrlKey&&event.shiftKey&&event.code==='KeyT'){event.preventDefault();if(!event.target.closest('.xterm'))await connect({type:'local',shell:'powershell'});}
    if(event.ctrlKey&&event.shiftKey&&event.code==='KeyF'){event.preventDefault();showSearch();}
    if(event.ctrlKey&&['Equal','Minus','NumpadAdd','NumpadSubtract'].includes(event.code)){event.preventDefault();const next=Number(state.settings.fontSize)+(event.code==='Equal'||event.code==='NumpadAdd'?1:-1);state.settings.fontSize=Math.max(9,Math.min(32,next));applySettings();await bridge.saveSettings(state.settings);}
  }));
  $('#app-dialog').addEventListener('cancel',event=>{event.preventDefault();closeModal();});
  window.addEventListener('resize',()=>requestAnimationFrame(fitVisible));
  new ResizeObserver(()=>requestAnimationFrame(fitVisible)).observe($('#terminal-container'));
}
async function initialize(){
  icons();$('#window-minimize').innerHTML=svg('minus');$('#window-maximize').innerHTML=svg('maximize');$('#window-close').innerHTML=svg('close');$('#home-date').textContent=new Date().toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'}).toUpperCase();
  bridge=window.bridge;
  if(!bridge){$('#status-text').textContent='Desktop connection unavailable';$('#status-dot').style.background='var(--danger)';toast('Open Termora through the desktop launcher to use terminal and file features.',true);return;}
  bridge.onTerminalData(event=>{const entry=state.terminals.get(event.id);if(entry?.term)entry.term.write(terminalText(entry,event.data));else if(!entry)state.buffered.set(event.id,((state.buffered.get(event.id)||'')+event.data).slice(-1024*1024));});bridge.onTerminalExit(event=>{vncChannels.get(event.id)?.ended();vncChannels.delete(event.id);terminalExited(event);});bridge.onVncData(({id,data})=>vncChannels.get(id)?.receive(data));
  const data=await bridge.bootstrap();Object.assign(state,{sessions:data.sessions||[],settings:{...state.settings,...data.settings},macros:data.macros||[],tunnels:data.tunnels||[],homePath:data.homePath||'',capabilities:data.capabilities||{},appName:data.appName||'Termora',platform:data.platform||'win32',version:data.version||'0.1.0',vault:data.vault||{available:false,saved:[]},logDirectory:data.logDirectory||''});
  $('#app-version').textContent=`TERMORA ${state.version}`;$('#wsl-status').innerHTML=`<span class="dot amber-dot"></span>${capability('wsl')?'WINDOWS SUBSYSTEM':'REQUIRES WSL'}`;
  applySettings();bindEvents();renderSessions();renderWorkspace();
  if(detachedMode)await initializeDetached();
  else {
    bridge.onTerminalAttach(payload=>{mountTerminal({id:payload.id,label:payload.label,kind:payload.kind},{...payload.config,name:payload.label},false,payload.history).then(()=>toast(`“${payload.label}” reattached.`)).catch(error=>toast(message(error),true));});
    // Desktop shortcuts name a saved session; only saved sessions can be opened this way.
    const launch=sessionId=>{const session=state.sessions.find(item=>item.id===sessionId);if(session)connect(session).catch(error=>toast(message(error),true));else toast('The session for this shortcut no longer exists.',true);};
    bridge.onSessionLaunch(launch);const pending=await bridge.launchRequest();if(pending)launch(pending);
    bridge.onCronResult(result=>{const job=(state.cronJobs||[]).find(item=>item.id===result.id);if(result.exitCode!==0)toast(`Scheduled job “${job?.name||'job'}” failed with exit code ${result.exitCode}.`,true);});
    state.cronJobs=data.cronJobs||[];
  }
}
// A detached window shows a single terminal with a Reattach control.
async function initializeDetached(){
  document.body.classList.add('detached-mode');
  const info=await bridge.detachedInfo();
  document.title=`${info.label} — Termora`;$('.brand span:last-child').textContent=info.label;
  const reattach=element('button','detach-reattach','⇤ Reattach to main window');reattach.id='reattach-tab';
  reattach.addEventListener('click',handle(async()=>{const entry=state.terminals.get(info.id);await bridge.reattachTerminal({label:entry?.label||info.label,history:terminalHistory(entry)});}));
  $('.titlebar-right').prepend(reattach);
  await mountTerminal({id:info.id,label:info.label,kind:info.kind},{...info.config,name:info.label},false,info.history);
}
initialize().catch(error=>{toast(`Could not open workspace: ${message(error)}`,true);$('#status-text').textContent='Workspace could not be loaded';});
