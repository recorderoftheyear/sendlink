import { describe, expect, it } from 'vitest';
import { displayUrl, extractUrl, validateUrl } from '../src/shared/url.js';

describe('validateUrl', () => {
  it.each([
    ['https://example.com', 'https://example.com/'],
    ['  http://example.com/a?b=1#c  ', 'http://example.com/a?b=1#c'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
    ['https://例え.jp/パス', 'https://xn--r8jz45g.jp/%E3%83%91%E3%82%B9'],
    ['http://192.168.1.10:8080/x', 'http://192.168.1.10:8080/x'],
  ])('accepts %s', (input, normalized) => {
    expect(validateUrl(input)).toEqual({ ok: true, url: normalized });
  });

  it.each([
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'file:///etc/passwd',
    'ftp://example.com',
    'chrome://settings',
    'intent://scan#Intent;end',
    'example.com',
    '//example.com',
    'https://exa mple.com',
    'https://example.com/\u0000',
    'https://a:b@example.com',
    'https://',
    null,
    {},
  ])('rejects %j', (input) => {
    expect(validateUrl(input).ok).toBe(false);
  });
});

describe('extractUrl', () => {
  it('pulls the URL out of shared text', () => {
    expect(extractUrl('Check this out https://youtu.be/abc?t=3 !')).toBe('https://youtu.be/abc?t=3');
    expect(extractUrl('(see https://reddit.com/r/x).')).toBe('https://reddit.com/r/x');
  });
  it('upgrades bare domains to https', () => {
    expect(extractUrl('youtube.com/watch?v=1')).toBe('https://youtube.com/watch?v=1');
  });
  it('returns null for plain text', () => {
    expect(extractUrl('hello world')).toBeNull();
    expect(extractUrl('')).toBeNull();
    expect(extractUrl(null)).toBeNull();
  });
  it('never turns a dangerous scheme into a valid URL', () => {
    expect(extractUrl('javascript:alert(1)')).toBeNull();
  });
});

describe('displayUrl', () => {
  it('strips the scheme and www, and truncates', () => {
    expect(displayUrl('https://www.youtube.com/watch?v=1')).toBe('youtube.com/watch?v=1');
    expect(displayUrl(`https://a.com/${'x'.repeat(100)}`, 20)).toHaveLength(20);
  });
});
