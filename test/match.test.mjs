import test from 'node:test';
import assert from 'node:assert/strict';
import { ANYTIME, expandWindows, freeSlots, matchJobs } from '../src/match.mjs';
import { toBusy as tb } from '../src/lib/google.mjs';

const t = (s) => Date.parse(`${s}:00+09:00`);
const sat = { days: [6], from: '08:00', to: '20:00' };
const from = t('2026-10-17T00:00'); // 土曜

test('空のカレンダーでも、勤務できる枠の外は空きにしない', () => {
  const w = expandWindows([sat], { from, days: 7 });
  assert.equal(w.length, 1);
  assert.deepEqual(w[0], { start: t('2026-10-17T08:00'), end: t('2026-10-17T20:00') });
});

test('予定の前後60分を余白として引く', () => {
  const w = expandWindows([sat], { from, days: 1 });
  const s = freeSlots(w, [{ start: t('2026-10-17T12:00'), end: t('2026-10-17T13:00') }]);
  assert.deepEqual(s, [
    { start: t('2026-10-17T08:00'), end: t('2026-10-17T11:00') },
    { start: t('2026-10-17T14:00'), end: t('2026-10-17T20:00') },
  ]);
});

test('空きにすっぽり収まる求人だけ・時刻不明や掲載終了の可能性は除く', () => {
  const slots = [{ start: t('2026-10-17T08:00'), end: t('2026-10-17T11:00') }];
  const jobs = [
    { uid: 'a', data: { date: '2026-10-17', startTime: '09:00', endTime: '11:00' } },
    { uid: 'b', data: { date: '2026-10-17', startTime: '09:00', endTime: '12:00' } },
    { uid: 'c', data: { date: '2026-10-17', startTime: '', endTime: '' } },
    { uid: 'd', missingSince: 'x', data: { date: '2026-10-17', startTime: '09:00', endTime: '10:00' } },
  ];
  assert.deepEqual(matchJobs(jobs, slots, { now: from }).map((h) => h.job.uid), ['a']);
});

test('当直（翌日にまたがる）', () => {
  const w = expandWindows([{ days: [6], from: '17:00', to: '09:00' }], { from, days: 1 });
  const hits = matchJobs([{ uid: 'n', data: { date: '2026-10-17', startTime: '17:30', endTime: '08:30' } }], w, { now: from });
  assert.equal(hits.length, 1);
});

test('「空き」表示の予定（終日も）と辞退した予定は避けない・「予定あり」の終日予定は避ける', () => {
  assert.equal(tb({ start: { date: '2026-10-17' }, end: { date: '2026-10-18' }, transparency: 'transparent' }), null);
  assert.ok(tb({ start: { date: '2026-10-17' }, end: { date: '2026-10-18' } }));
  assert.equal(tb({ start: { dateTime: '2026-10-17T10:00:00+09:00' }, end: { dateTime: '2026-10-17T11:00:00+09:00' }, transparency: 'transparent' }), null);
  assert.equal(tb({ start: { dateTime: '2026-10-17T10:00:00+09:00' }, end: { dateTime: '2026-10-17T11:00:00+09:00' }, attendees: [{ self: true, responseStatus: 'declined' }] }), null);
});

test('既定（ANYTIME）は終日空き：予定と余白に重ならなければ深夜・当直も提案', () => {
  const from = Date.parse('2026-10-19T00:00:00+09:00');
  const w = expandWindows(ANYTIME, { from, days: 2 });
  assert.equal(w.length, 1);
  const busy = [{ start: Date.parse('2026-10-19T09:00:00+09:00'), end: Date.parse('2026-10-19T17:00:00+09:00') }];
  const slots = freeSlots(w, busy);
  const jobs = [
    { date: '2026-10-19', startTime: '17:30', endTime: '22:00' }, // 余白60分にかかる
    { date: '2026-10-19', startTime: '18:00', endTime: '09:00' }, // 当直：OK
    { date: '2026-10-19', startTime: '07:30', endTime: '08:30' }, // 余白にかかる
    { date: '2026-10-19', startTime: '03:00', endTime: '07:00' }, // 早朝：OK
  ];
  const hits = matchJobs(jobs, slots, { now: from - 1 }).map((h) => h.job.startTime);
  assert.deepEqual(hits, ['03:00', '18:00']);
});

import { restCheck, isNight } from '../src/rest.mjs';

test('当直：明けの予定・前夜の当直を見て注意を付ける', () => {
  const T = (s) => Date.parse(`${s}+09:00`);
  const job = { start: T('2026-10-24T17:00:00'), end: T('2026-10-25T09:00:00') };
  assert.ok(isNight(job));
  const nextMorning = [{ start: T('2026-10-25T10:00:00'), end: T('2026-10-25T12:00:00') }];
  const r = restCheck(job, nextMorning);
  assert.match(r.lines[0], /当直明けの10:00から予定あり（明けから約1時間）/);
  assert.equal(r.penalty, 2);
  assert.equal(restCheck(job, []).penalty, 0);
  // 前夜が当直の日勤
  const prevNight = [{ start: T('2026-10-23T17:15:00'), end: T('2026-10-24T08:30:00') }];
  const day = { start: T('2026-10-24T13:00:00'), end: T('2026-10-24T17:00:00') };
  assert.match(restCheck(day, prevNight).lines[0], /前夜に当直らしき予定（〜08:30）。当直明け約5時間後の勤務/);
  // 連続の当直
  assert.match(restCheck(job, prevNight).lines[0], /連続の当直/);
  // 日中の短い予定は当直とみなさない
  assert.equal(restCheck(day, [{ start: T('2026-10-24T09:00:00'), end: T('2026-10-24T11:00:00') }]).penalty, 0);
});
