const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Writable, Readable } = require('node:stream');
const { operation } = require('./terminals.cjs');
const { splitPath } = require('./s3.cjs');
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
function cleanPath(value) { if (typeof value !== 'string' || !value || value.includes('\0') || value.length > 32768) throw new Error('Invalid file path.'); return value; }
function textContent(buffer) { if (buffer.includes(0)) throw new Error('This file appears to be binary. The editor supports UTF-8 text files.'); return buffer.toString('utf8'); }
class FileManager {
  constructor(terminals) { this.terminals = terminals; }
  connection(id) { if (!id) return null; const state = this.terminals.session(id); if (!state.sftp && !state.ftp && !state.s3 && !(state.transfer === 'scp' && state.client)) { if (state.kind === 'local' || state.kind === 'wsl') return null; throw new Error(state.sftpError || 'This connection does not support file browsing.'); } return state; }
  browsable(id) { const connection = this.connection(id); if (connection && !connection.sftp && !connection.ftp && !connection.s3) throw new Error(`${connection.sftpError ? `${connection.sftpError}. ` : ''}This server has no SFTP subsystem; use SCP upload and download.`); return connection; }
  async list({ id, path: requested } = {}) {
    const connection = this.browsable(id);
    if (!connection) {
      const current = requested ? path.resolve(cleanPath(requested)) : os.homedir();
      const records = await fs.readdir(current, { withFileTypes: true });
      const entries = await Promise.all(records.map(async record => {
        let stat; try { stat = await fs.lstat(path.join(current, record.name)); } catch {}
        return { name: record.name, type: record.isDirectory() ? 'directory' : record.isSymbolicLink() ? 'symlink' : 'file', size: stat?.size || 0, modified: stat?.mtimeMs || 0 };
      }));
      return { path: current, parent: path.dirname(current), entries: order(entries) };
    }
    if (connection.s3) {
      const current = requested ? path.posix.normalize(cleanPath(requested)).replace(/(.)\/+$/, '$1') : connection.bucket ? `/${connection.bucket}` : '/';
      const { bucket, key } = splitPath(current);
      if (!bucket) return { path: '/', parent: '/', entries: order((await connection.s3.listBuckets()).map(b => ({ name: b.name, type: 'directory', size: 0, modified: b.created }))) };
      const prefix = key ? `${key}/` : '';
      const { folders, files } = await connection.s3.list(bucket, prefix);
      const entries = [...folders.map(folder => ({ name: folder.slice(prefix.length).replace(/\/$/, ''), type: 'directory', size: 0, modified: 0 })),
        ...files.filter(file => file.key !== prefix).map(file => ({ name: file.key.slice(prefix.length), type: 'file', size: file.size, modified: file.modified }))];
      return { path: current, parent: path.posix.dirname(current), entries: order(entries.filter(entry => entry.name)) };
    }
    if (connection.sftp) {
      const current = requested ? path.posix.normalize(cleanPath(requested)) : await operation(connection.sftp, 'realpath', '.');
      const records = await operation(connection.sftp, 'readdir', current);
      return { path: current, parent: path.posix.dirname(current), entries: order(records.filter(f => f.filename !== '.' && f.filename !== '..').map(f => ({ name: f.filename, type: f.attrs.isDirectory() ? 'directory' : f.attrs.isSymbolicLink() ? 'symlink' : 'file', size: f.attrs.size, modified: f.attrs.mtime * 1000 }))) };
    }
    const current = requested ? path.posix.normalize(cleanPath(requested)) : await connection.ftp.pwd();
    const records = await connection.ftp.list(current);
    return { path: current, parent: path.posix.dirname(current), entries: order(records.map(f => ({ name: f.name, type: f.isDirectory ? 'directory' : f.isSymbolicLink ? 'symlink' : 'file', size: f.size || 0, modified: f.modifiedAt?.getTime() || 0 }))) };
  }
  async action({ id, action, path: target, newPath }) {
    cleanPath(target); const connection = this.browsable(id);
    if (!['mkdir', 'rename', 'delete'].includes(action)) throw new Error('Unsupported file operation.');
    if (action === 'rename') cleanPath(newPath);
    if (!connection) {
      if (action === 'mkdir') await fs.mkdir(target);
      if (action === 'rename') { try { await fs.lstat(newPath); throw new Error('The destination already exists.'); } catch (e) { if (e.code !== 'ENOENT') throw e; } await fs.rename(target, newPath); }
      if (action === 'delete') { const stat = await fs.lstat(target); if (stat.isDirectory()) await fs.rmdir(target); else await fs.unlink(target); }
    } else if (connection.s3) {
      const { bucket, key } = s3Object(target);
      if (action === 'mkdir') { if (await this.s3Exists(connection.s3, bucket, key)) throw new Error('The destination already exists.'); await connection.s3.put(bucket, `${key}/`, ''); }
      if (action === 'rename') {
        const destination = s3Object(newPath);
        if (await connection.s3.head(bucket, key) === null) throw new Error('Only files can be renamed in S3; folders are key prefixes.');
        if (await this.s3Exists(connection.s3, destination.bucket, destination.key)) throw new Error('The destination already exists.');
        await connection.s3.copy(bucket, key, destination.bucket, destination.key); await connection.s3.remove(bucket, key);
      }
      if (action === 'delete') {
        if (await connection.s3.head(bucket, key) !== null) await connection.s3.remove(bucket, key);
        else {
          // A folder is deleted only when nothing but its marker object remains.
          const { folders, files } = await connection.s3.list(bucket, `${key}/`);
          if (folders.length || files.some(file => file.key !== `${key}/`)) throw new Error('The folder is not empty.');
          await connection.s3.remove(bucket, `${key}/`);
        }
      }
    } else if (connection.sftp) {
      if (action === 'mkdir') await operation(connection.sftp, 'mkdir', target);
      if (action === 'rename') { try { await operation(connection.sftp, 'lstat', newPath); throw new Error('The destination already exists.'); } catch (e) { if (e.code !== 2) throw e; } await operation(connection.sftp, 'rename', target, newPath); }
      if (action === 'delete') { const stat = await operation(connection.sftp, 'lstat', target); await operation(connection.sftp, stat.isDirectory() ? 'rmdir' : 'unlink', target); }
    } else {
      if (action === 'mkdir') { const original = await connection.ftp.pwd(); try { await connection.ftp.ensureDir(target); } finally { await connection.ftp.cd(original); } }
      if (action === 'rename') { if (await this.ftpExists(connection.ftp, newPath)) throw new Error('The destination already exists.'); await connection.ftp.rename(target, newPath); }
      if (action === 'delete') {
        const entry = (await connection.ftp.list(path.posix.dirname(target))).find(f => f.name === path.posix.basename(target));
        if (entry?.isDirectory) throw new Error('Delete directories with SFTP or locally; FTP directory deletion is disabled to avoid recursive removal.');
        await connection.ftp.remove(target);
      }
    }
    return { ok: true };
  }
  async s3Exists(s3, bucket, key) {
    if (await s3.head(bucket, key) !== null) return true;
    const { folders, files } = await s3.list(bucket, `${key}/`);
    return folders.length > 0 || files.length > 0;
  }
  async ftpExists(ftp, target) { return (await ftp.list(path.posix.dirname(target))).some(f => f.name === path.posix.basename(target)); }
  async read({ id, path: target }) {
    cleanPath(target); const connection = this.browsable(id); let content;
    if (!connection) {
      if ((await fs.stat(target)).size > MAX_TEXT_BYTES) throw new Error('The text editor supports files up to 2 MiB.');
      content = await fs.readFile(target);
    } else if (connection.s3) {
      const { bucket, key } = s3Object(target);
      const head = await connection.s3.head(bucket, key);
      if (!head) throw new Error('File not found.');
      if (head.size > MAX_TEXT_BYTES) throw new Error('The text editor supports files up to 2 MiB.');
      content = await connection.s3.get(bucket, key);
    } else if (connection.sftp) {
      if ((await operation(connection.sftp, 'stat', target)).size > MAX_TEXT_BYTES) throw new Error('The text editor supports files up to 2 MiB.');
      content = await operation(connection.sftp, 'readFile', target);
    } else {
      if (await connection.ftp.size(target) > MAX_TEXT_BYTES) throw new Error('The text editor supports files up to 2 MiB.');
      const chunks = []; let length = 0;
      const writable = new Writable({ write(chunk, encoding, callback) { length += chunk.length; if (length > MAX_TEXT_BYTES) return callback(new Error('File grew beyond the 2 MiB editor limit.')); chunks.push(chunk); callback(); } });
      await connection.ftp.downloadTo(writable, target); content = Buffer.concat(chunks);
    }
    if (content.length > MAX_TEXT_BYTES) throw new Error('File grew beyond the 2 MiB editor limit.');
    return { path: target, content: textContent(content) };
  }
  async write({ id, path: target, content }) {
    cleanPath(target);
    if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_TEXT_BYTES) throw new Error('The text editor supports files up to 2 MiB.');
    const connection = this.browsable(id);
    if (!connection) await fs.writeFile(target, content, 'utf8');
    else if (connection.s3) { const { bucket, key } = s3Object(target); await connection.s3.put(bucket, key, content); }
    else if (connection.sftp) await operation(connection.sftp, 'writeFile', target, content);
    else await connection.ftp.uploadFrom(Readable.from([content]), target);
    return { ok: true, path: target };
  }
  async upload(id, localPath, remotePath, { overwrite = false } = {}) {
    cleanPath(localPath); cleanPath(remotePath); const connection = this.connection(id);
    if (!overwrite) {
      if (connection?.sftp) { try { await operation(connection.sftp, 'lstat', remotePath); throw new Error('Destination exists. Rename it or choose another name before uploading.'); } catch (e) { if (e.code !== 2) throw e; } }
      else if (connection?.ftp) { if (await this.ftpExists(connection.ftp, remotePath)) throw new Error('Destination exists. Rename it before uploading.'); }
      else if (connection?.s3) { const { bucket, key } = s3Object(remotePath); if (await connection.s3.head(bucket, key) !== null) throw new Error('Destination exists. Rename it before uploading.'); }
    }
    if (connection?.s3) { const { bucket, key } = s3Object(remotePath); await connection.s3.upload(bucket, key, localPath); return { ok: true, path: remotePath }; }
    if (connection?.transfer === 'scp') return this.terminals.scpUpload(id, localPath, remotePath);
    if (connection?.sftp) await operation(connection.sftp, 'fastPut', localPath, remotePath);
    else if (connection?.ftp) await connection.ftp.uploadFrom(localPath, remotePath);
    else await fs.copyFile(localPath, remotePath, overwrite ? 0 : require('node:fs').constants.COPYFILE_EXCL);
    return { ok: true, path: remotePath };
  }
  async download(id, remotePath, localPath) {
    cleanPath(remotePath); cleanPath(localPath); const connection = this.connection(id);
    if (connection?.s3) { const { bucket, key } = s3Object(remotePath); await connection.s3.download(bucket, key, localPath); return { ok: true, path: localPath }; }
    if (connection?.transfer === 'scp') return this.terminals.scpDownload(id, remotePath, localPath);
    if (connection?.sftp) await operation(connection.sftp, 'fastGet', remotePath, localPath);
    else if (connection?.ftp) await connection.ftp.downloadTo(localPath, remotePath);
    else await fs.copyFile(remotePath, localPath);
    return { ok: true, path: localPath };
  }
}
// An object path inside a bucket; the bucket list itself has no objects.
function s3Object(target) { const parts = splitPath(path.posix.normalize(target)); if (!parts.bucket || !parts.key) throw new Error('Choose an object inside a bucket.'); return parts; }
function order(entries) { return entries.sort((a, b) => (a.type !== 'directory') - (b.type !== 'directory') || a.name.localeCompare(b.name, undefined, { numeric: true })); }
module.exports = { FileManager, MAX_TEXT_BYTES, cleanPath, textContent, order };
