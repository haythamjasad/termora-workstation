// Small Amazon S3 client (AWS Signature Version 4) for the S3 file browser.
// Works with AWS and S3-compatible servers such as MinIO.
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const { pipeline } = require('node:stream/promises');

const EMPTY_HASH = crypto.createHash('sha256').update('').digest('hex');
const MAX_RESPONSE = 32 * 1024 * 1024;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => crypto.createHmac('sha256', key).update(value).digest();
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const encodePath = value => value.split('/').map(encode).join('/');

function sign({ method, host, path, query = {}, headers = {}, payloadHash = EMPTY_HASH, region, service = 's3', accessKeyId, secretAccessKey, date = new Date() }) {
  const amzDate = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''), day = amzDate.slice(0, 8);
  const all = { host, 'x-amz-date': amzDate };
  for (const [key, value] of Object.entries(headers)) all[key.toLowerCase()] = value;
  const names = Object.keys(all).sort();
  const canonicalHeaders = names.map(name => `${name}:${String(all[name]).trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalQuery = Object.keys(query).map(key => [encode(key), encode(String(query[key]))]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, value]) => `${key}=${value}`).join('&');
  const canonicalRequest = [method, path, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(stringToSign).digest('hex');
  const { host: _host, ...sent } = all;
  return { signature, query: canonicalQuery, headers: { ...sent, authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` } };
}

const xmlText = value => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');
const tag = (xml, name) => { const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml); return match ? xmlText(match[1]) : ''; };
const blocks = (xml, name) => [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'g'))].map(match => match[1]);

class S3Client {
  constructor({ endpoint, region, accessKeyId, secretAccessKey, pathStyle } = {}) {
    this.region = String(region || 'us-east-1').trim();
    if (!/^[a-z0-9-]{2,40}$/.test(this.region)) throw new Error('Enter an AWS region such as us-east-1.');
    const raw = String(endpoint || '').trim() || `s3.${this.region}.amazonaws.com`;
    this.url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!['http:', 'https:'].includes(this.url.protocol) || this.url.username || this.url.password) throw new Error('Enter the S3 endpoint as a host name or http(s) URL.');
    if (!accessKeyId || !secretAccessKey) throw new Error('Enter the access key ID and the secret access key.');
    this.accessKeyId = String(accessKeyId).trim(); this.secretAccessKey = String(secretAccessKey);
    this.pathStyle = pathStyle ?? !this.url.hostname.endsWith('amazonaws.com');
  }
  target(bucket, key = '') {
    // Dotted bucket names break virtual-host TLS, so they always use path style.
    if (bucket && !this.pathStyle && !bucket.includes('.')) return { host: `${bucket}.${this.url.host}`, path: '/' + encodePath(key) };
    return { host: this.url.host, path: '/' + (bucket ? `${encode(bucket)}${key ? '/' + encodePath(key) : ''}` : '') };
  }
  request(method, bucket, key, { query = {}, body, file, headers = {}, output } = {}) {
    return new Promise((resolve, reject) => {
      const { host, path } = this.target(bucket, key);
      let length = 0, payloadHash = EMPTY_HASH;
      if (body !== undefined) { body = Buffer.from(body); length = body.length; payloadHash = sha256(body); }
      else if (file) { length = fs.statSync(file).size; payloadHash = 'UNSIGNED-PAYLOAD'; }
      const extra = { ...headers, 'x-amz-content-sha256': payloadHash, ...(['PUT', 'POST'].includes(method) ? { 'content-length': String(length) } : {}) };
      const signed = sign({ method, host, path, query, headers: extra, payloadHash, region: this.region, accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey });
      const transport = this.url.protocol === 'http:' ? http : https;
      const request = transport.request({ protocol: this.url.protocol, hostname: bucket && host !== this.url.host ? host.replace(/:\d+$/, '') : this.url.hostname, port: this.url.port || undefined, method, path: path + (signed.query ? `?${signed.query}` : ''), headers: { host, ...signed.headers }, timeout: 30000 }, async response => {
        try {
          if (output && response.statusCode < 300) { await pipeline(response, fs.createWriteStream(output, { flags: 'wx' })); resolve({ status: response.statusCode, headers: response.headers }); return; }
          const chunks = []; let size = 0;
          for await (const chunk of response) { size += chunk.length; if (size > MAX_RESPONSE) throw new Error('S3 response is too large.'); chunks.push(chunk); }
          const data = Buffer.concat(chunks);
          if (response.statusCode >= 300) {
            const text = data.toString('utf8');
            const code = tag(text, 'Code') || `HTTP ${response.statusCode}`, message = tag(text, 'Message');
            reject(Object.assign(new Error(`S3 ${code}${message ? `: ${message}` : ''}`), { status: response.statusCode, code }));
            return;
          }
          resolve({ status: response.statusCode, headers: response.headers, body: data });
        } catch (error) { reject(error); }
      });
      request.on('timeout', () => request.destroy(new Error('S3 request timed out.')));
      request.on('error', reject);
      if (file) fs.createReadStream(file).on('error', error => request.destroy(error)).pipe(request);
      else request.end(body);
    });
  }
  async listBuckets() {
    const { body } = await this.request('GET', '', '');
    return blocks(body.toString('utf8'), 'Bucket').map(xml => ({ name: tag(xml, 'Name'), created: Date.parse(tag(xml, 'CreationDate')) || 0 }));
  }
  // One directory level: common prefixes become folders, objects become files.
  async list(bucket, prefix = '') {
    const folders = [], files = [];
    let token = '';
    for (let page = 0; page < 10; page++) {
      const query = { 'list-type': '2', delimiter: '/', prefix, ...(token ? { 'continuation-token': token } : {}) };
      const xml = (await this.request('GET', bucket, '', { query })).body.toString('utf8');
      for (const block of blocks(xml, 'CommonPrefixes')) folders.push(tag(block, 'Prefix'));
      for (const block of blocks(xml, 'Contents')) files.push({ key: tag(block, 'Key'), size: Number(tag(block, 'Size')) || 0, modified: Date.parse(tag(block, 'LastModified')) || 0 });
      token = tag(xml, 'IsTruncated') === 'true' ? tag(xml, 'NextContinuationToken') : '';
      if (!token) break;
    }
    return { folders, files };
  }
  async head(bucket, key) {
    try { const { headers } = await this.request('HEAD', bucket, key); return { size: Number(headers['content-length']) || 0 }; }
    catch (error) { if (error.status === 404) return null; throw error; }
  }
  async get(bucket, key) { return (await this.request('GET', bucket, key)).body; }
  download(bucket, key, output) { return this.request('GET', bucket, key, { output }); }
  put(bucket, key, body) { return this.request('PUT', bucket, key, { body }); }
  upload(bucket, key, file) { return this.request('PUT', bucket, key, { file }); }
  remove(bucket, key) { return this.request('DELETE', bucket, key); }
  copy(fromBucket, fromKey, bucket, key) { return this.request('PUT', bucket, key, { body: '', headers: { 'x-amz-copy-source': `/${encode(fromBucket)}/${encodePath(fromKey)}` } }); }
}

// "/bucket/a/b" -> { bucket: 'bucket', key: 'a/b' }
function splitPath(value) {
  const parts = String(value || '/').split('/').filter(Boolean);
  return { bucket: parts[0] || '', key: parts.slice(1).join('/') };
}

module.exports = { S3Client, sign, splitPath, encodePath };
