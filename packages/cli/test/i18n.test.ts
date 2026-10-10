import { afterEach, describe, expect, it } from 'vitest';
import { detectLang, messages, t } from '../src/i18n.js';

describe('language selection', () => {
  it('BITL_LANG comes first', () => {
    expect(detectLang({ BITL_LANG: 'en', LANG: 'ko_KR.UTF-8' }, 'ko-KR')).toBe('en');
    expect(detectLang({ BITL_LANG: 'ko', LANG: 'en_US.UTF-8' }, 'en-US')).toBe('ko');
    expect(detectLang({ BITL_LANG: ' KO ' }, 'en-US')).toBe('ko');
  });

  it('ignores BITL_LANG other than ko/en', () => {
    expect(detectLang({ BITL_LANG: 'ja', LANG: 'ko_KR.UTF-8' }, 'en-US')).toBe('ko');
  });

  it('LC_ALL → LC_MESSAGES → LANG order', () => {
    expect(detectLang({ LC_ALL: 'en_US.UTF-8', LANG: 'ko_KR.UTF-8' }, 'ko-KR')).toBe('en');
    expect(detectLang({ LC_MESSAGES: 'ko_KR.UTF-8', LANG: 'en_US.UTF-8' }, 'en-US')).toBe('ko');
    expect(detectLang({ LANG: 'ko_KR.UTF-8' }, 'en-US')).toBe('ko');
    expect(detectLang({ LANG: 'de_DE.UTF-8' }, 'ko-KR')).toBe('en');
  });

  it('C/POSIX locales carry no language, so falls through', () => {
    expect(detectLang({ LC_ALL: 'C', LANG: 'ko_KR.UTF-8' }, 'en-US')).toBe('ko');
    expect(detectLang({ LANG: 'C.UTF-8' }, 'ko-KR')).toBe('ko');
    expect(detectLang({ LANG: 'POSIX' }, 'en-US')).toBe('en');
  });

  it('uses the OS locale when env vars are absent (Windows)', () => {
    expect(detectLang({}, 'ko-KR')).toBe('ko');
    expect(detectLang({}, 'en-US')).toBe('en');
    expect(detectLang({}, 'ja-JP')).toBe('en');
  });
});

describe('dictionary', () => {
  it('en has every ko key, with no empty values', () => {
    expect(Object.keys(messages.en).sort()).toEqual(Object.keys(messages.ko).sort());
    for (const [k, v] of Object.entries(messages.en)) expect(v.trim(), k).not.toBe('');
  });

  it('en contains no Korean', () => {
    for (const [k, v] of Object.entries(messages.en)) expect(v, k).not.toMatch(/[가-힣]/);
  });

  it('placeholders ({name}) match across both languages', () => {
    const slots = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const k of Object.keys(messages.ko) as (keyof typeof messages.ko)[]) expect(slots(messages.en[k]), k).toEqual(slots(messages.ko[k]));
  });
});

describe('t()', () => {
  const saved = process.env.BITL_LANG;
  afterEach(() => {
    if (saved === undefined) delete process.env.BITL_LANG;
    else process.env.BITL_LANG = saved;
  });

  it('fills in values and follows the language', () => {
    process.env.BITL_LANG = 'en';
    expect(t('install.unchanged', { file: '/a/b' })).toBe('No change: /a/b');
    process.env.BITL_LANG = 'ko';
    expect(t('install.unchanged', { file: '/a/b' })).toBe('변경 없음: /a/b');
  });

  it('leaves JSON-like braces alone', () => {
    process.env.BITL_LANG = 'en';
    expect(t('login.unreachableHint', { origin: 'https://x' })).toContain('{"ok":true}');
  });
});
