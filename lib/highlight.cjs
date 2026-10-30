// Streaming keyword highlighter for terminal output. Only plain text printed
// with the default foreground colour is changed; escape sequences pass through
// untouched (including ones split across chunks), text a program coloured
// itself is left alone, and full-screen (alternate buffer) programs are skipped.
const RULES = [
  { color: 91, pattern: /\b(?:errors?|fail(?:ed|ure|s)?|fatal|denied|refused|critical|panic|exception|unreachable|timed out)\b/gi },
  { color: 93, pattern: /\b(?:warn(?:ing|ings)?|deprecated|caution)\b/gi },
  { color: 92, pattern: /\b(?:success(?:ful|fully)?|succeeded|passed|done|completed|OK)\b/g },
  { color: 96, pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g },
];
const ESC = '\x1b';

function colorize(text) {
  const marks = [];
  for (const { color, pattern } of RULES) {
    pattern.lastIndex = 0;
    for (let match; (match = pattern.exec(text));) {
      const start = match.index, end = start + match[0].length;
      if (!marks.some(mark => start < mark.end && end > mark.start)) marks.push({ start, end, color });
    }
  }
  if (!marks.length) return text;
  marks.sort((a, b) => a.start - b.start);
  let out = '', last = 0;
  for (const mark of marks) { out += text.slice(last, mark.start) + `${ESC}[${mark.color}m${text.slice(mark.start, mark.end)}${ESC}[39m`; last = mark.end; }
  return out + text.slice(last);
}

// Returns the end index of the escape sequence starting at `start`, or -1 when incomplete.
function escapeEnd(data, start) {
  const kind = data[start + 1];
  if (kind === undefined) return -1;
  if (kind === '[') { for (let i = start + 2; i < data.length; i++) { const code = data.charCodeAt(i); if (code >= 0x40 && code <= 0x7e) return i + 1; } return -1; }
  if (kind === ']' || kind === 'P' || kind === '_' || kind === '^') {
    for (let i = start + 2; i < data.length; i++) { if (data[i] === '\x07') return i + 1; if (data[i] === ESC && data[i + 1] === '\\') return i + 2; if (data[i] === ESC && data[i + 1] === undefined) return -1; }
    return -1;
  }
  if ('()*+'.includes(kind)) return data[start + 2] === undefined ? -1 : start + 3;
  return start + 2;
}

function createHighlighter() {
  let pending = '', colored = false, alternate = false;
  function track(sequence) {
    if (/^\x1b\[\?(?:1049|1047|47)[hl]$/.test(sequence)) alternate = sequence.endsWith('h');
    const sgr = /^\x1b\[([\d;:]*)m$/.exec(sequence);
    if (sgr) {
      // Any explicit foreground/background colour marks text as program-coloured until reset.
      const params = sgr[1] === '' ? ['0'] : sgr[1].split(/[;:]/);
      for (const value of params) { const n = Number(value); if (n === 0 || n === 39) colored = false; else if ((n >= 30 && n <= 38) || (n >= 90 && n <= 97)) colored = true; }
    }
  }
  return function transform(chunk) {
    const data = pending + chunk; pending = '';
    let out = '', text = '';
    const flush = () => { if (text) { out += colored || alternate ? text : colorize(text); text = ''; } };
    for (let i = 0; i < data.length;) {
      if (data[i] !== ESC) { text += data[i]; i++; continue; }
      const end = escapeEnd(data, i);
      if (end < 0) { if (data.length - i > 4096) { text += data.slice(i); break; } flush(); pending = data.slice(i); return out; }
      flush();
      const sequence = data.slice(i, end); track(sequence); out += sequence; i = end;
    }
    flush();
    return out;
  };
}

module.exports = { createHighlighter, colorize, RULES };
