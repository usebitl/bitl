import { afterEach, describe, expect, it } from 'vitest';
import { detectLang, messages, t } from '../src/i18n.js';

describe('언어 결정', () => {
  it('BITL_LANG 이 가장 먼저', () => {
    expect(detectLang({ BITL_LANG: 'en', LANG: 'ko_KR.UTF-8' }, 'ko-KR')).toBe('en');
    expect(detectLang({ BITL_LANG: 'ko', LANG: 'en_US.UTF-8' }, 'en-US')).toBe('ko');
    expect(detectLang({ BITL_LANG: ' KO ' }, 'en-US')).toBe('ko');
  });

  it('BITL_LANG 이 ko·en 이 아니면 무시', () => {
    expect(detectLang({ BITL_LANG: 'ja', LANG: 'ko_KR.UTF-8' }, 'en-US')).toBe('ko');
  });

  it('LC_ALL → LC_MESSAGES → LANG 순서', () => {
    expect(detectLang({ LC_ALL: 'en_US.UTF-8', LANG: 'ko_KR.UTF-8' }, 'ko-KR')).toBe('en');
    expect(detectLang({ LC_MESSAGES: 'ko_KR.UTF-8', LANG: 'en_US.UTF-8' }, 'en-US')).toBe('ko');
    expect(detectLang({ LANG: 'ko_KR.UTF-8' }, 'en-US')).toBe('ko');
    expect(detectLang({ LANG: 'de_DE.UTF-8' }, 'ko-KR')).toBe('en');
  });

  it('C·POSIX 로캘은 언어 정보가 없어 다음으로', () => {
    expect(detectLang({ LC_ALL: 'C', LANG: 'ko_KR.UTF-8' }, 'en-US')).toBe('ko');
    expect(detectLang({ LANG: 'C.UTF-8' }, 'ko-KR')).toBe('ko');
    expect(detectLang({ LANG: 'POSIX' }, 'en-US')).toBe('en');
  });

  it('환경 변수가 없으면 운영체제 로캘 (Windows)', () => {
    expect(detectLang({}, 'ko-KR')).toBe('ko');
    expect(detectLang({}, 'en-US')).toBe('en');
    expect(detectLang({}, 'ja-JP')).toBe('en');
  });
});

describe('사전', () => {
  it('en 은 ko 의 키를 빠짐없이, 빈 값 없이 가진다', () => {
    expect(Object.keys(messages.en).sort()).toEqual(Object.keys(messages.ko).sort());
    for (const [k, v] of Object.entries(messages.en)) expect(v.trim(), k).not.toBe('');
  });

  it('en 에 한글이 남아 있지 않다', () => {
    for (const [k, v] of Object.entries(messages.en)) expect(v, k).not.toMatch(/[가-힣]/);
  });

  it('값 자리({name})가 두 언어에서 같다', () => {
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

  it('값을 끼워 넣고, 언어를 따른다', () => {
    process.env.BITL_LANG = 'en';
    expect(t('install.unchanged', { file: '/a/b' })).toBe('No change: /a/b');
    process.env.BITL_LANG = 'ko';
    expect(t('install.unchanged', { file: '/a/b' })).toBe('변경 없음: /a/b');
  });

  it('JSON 같은 중괄호는 그대로 둔다', () => {
    process.env.BITL_LANG = 'en';
    expect(t('login.unreachableHint', { origin: 'https://x' })).toContain('{"ok":true}');
  });
});
