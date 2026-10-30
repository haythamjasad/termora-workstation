const test = require('node:test');
const assert = require('node:assert/strict');
const { createHighlighter, colorize } = require('../lib/highlight.cjs');

test('keywords and IPv4 addresses are coloured with default-foreground resets', () => {
  assert.equal(colorize('Build failed: 2 errors'), 'Build \x1b[91mfailed\x1b[39m: 2 \x1b[91merrors\x1b[39m');
  assert.equal(colorize('warning: deprecated'), '\x1b[93mwarning\x1b[39m: \x1b[93mdeprecated\x1b[39m');
  assert.equal(colorize('Ping 10.0.0.254 OK'), 'Ping \x1b[96m10.0.0.254\x1b[39m \x1b[92mOK\x1b[39m');
  assert.equal(colorize('ok terror 999.1.1.1 errorless'), 'ok terror 999.1.1.1 errorless');
});

test('escape sequences pass through intact, including ones split across chunks', () => {
  const transform = createHighlighter();
  const out = transform('\x1b[1') + transform('mbold error\x1b]0;title error') + transform('\x07 done');
  assert.equal(out, '\x1b[1mbold \x1b[91merror\x1b[39m\x1b]0;title error\x07 \x1b[92mdone\x1b[39m');
});

test('text a program coloured itself is left alone until the colour resets', () => {
  const transform = createHighlighter();
  assert.equal(transform('\x1b[32merror inside green\x1b[0m then error'), '\x1b[32merror inside green\x1b[0m then \x1b[91merror\x1b[39m');
  assert.equal(transform('\x1b[38;5;196mfatal\x1b[39m fatal'), '\x1b[38;5;196mfatal\x1b[39m \x1b[91mfatal\x1b[39m');
});

test('full-screen programs on the alternate buffer are not highlighted', () => {
  const transform = createHighlighter();
  assert.equal(transform('\x1b[?1049herror in vim\x1b[?1049l error after'), '\x1b[?1049herror in vim\x1b[?1049l \x1b[91merror\x1b[39m after');
});
