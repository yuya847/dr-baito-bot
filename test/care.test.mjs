import test from 'node:test';
import assert from 'node:assert/strict';
import { titleTimes, busyOf, mismatches, eventLine, aroundText } from '../src/schedule.mjs';
import { afterShifts, applyNudges, briefNotes, careNotices, eveningBrief } from '../src/care.mjs';
import { conflicts, conflictText } from '../src/scout.mjs';
import { toEvent } from '../src/lib/google.mjs';
import { restCheck } from '../src/rest.mjs';

const T = (s) => Date.parse(`${s}+09:00`);
const timed = (title, s, e, o = {}) => ({ start: T(s), end: T(e), allDay: false, busy: true, title, ...o });
const allDay = (title, date, o = {}) => ({ start: T(`${date}T00:00:00`), end: T(`${date}T00:00:00`) + 864e5, allDay: true, busy: false, title, ...o });

test('件名の時刻を読む（範囲・時刻1つ・全角）。単位のない「9-17」や日付は読まない', () => {
  assert.deepEqual(titleTimes('ABクリニック渋谷 10:00〜19:00 8万'), { from: '10:00', to: '19:00' });
  assert.deepEqual(titleTimes('中央病院 8時15分〜17時'), { from: '08:15', to: '17:00' });
  assert.deepEqual(titleTimes('当直 17:00〜翌9:00'), { from: '17:00', to: '09:00' });
  assert.deepEqual(titleTimes('中央病院 ８：１５～１７：００'), { from: '08:15', to: '17:00' });
  assert.deepEqual(titleTimes('11:40 みなと研修会'), { from: '11:40' });
  assert.equal(titleTimes('外来 9-17'), null);
  assert.equal(titleTimes('10/28 外来'), null);
  assert.equal(titleTimes(undefined), null);
});

test('Google の予定を件名・場所・メモつきで読む（「空き」表示・辞退も残し、印を付ける）', () => {
  const e = toEvent({ id: 'ev1', etag: '"1"', summary: '外来', location: '船橋駅', description: '<b>持ち物</b>&nbsp;白衣', start: { dateTime: '2026-10-31T09:00:00+09:00' }, end: { dateTime: '2026-10-31T12:00:00+09:00' } });
  assert.deepEqual(e, { start: T('2026-10-31T09:00:00'), end: T('2026-10-31T12:00:00'), allDay: false, busy: true, title: '外来', location: '船橋駅', note: '持ち物 白衣', id: 'ev1', cal: 'primary', primary: true, etag: '"1"' });
  // 変更・削除してよいかの材料：共有カレンダー・招待・ほかの参加者・繰り返し
  const shared = toEvent({ id: 'ev2', summary: '佐藤外勤', recurringEventId: 'r', organizer: { self: false }, attendees: [{ self: true }, { email: 'a@example.com' }], start: { date: '2026-11-02' }, end: { date: '2026-11-03' } }, { id: 'cal2', summary: '医局Dr不在日' });
  assert.deepEqual([shared.cal, shared.calName, shared.primary, shared.recurring, shared.invited, shared.guests], ['cal2', '医局Dr不在日', undefined, true, true, 1]);
  assert.equal(toEvent({ summary: '佐藤不在', start: { date: '2026-10-31' }, end: { date: '2026-11-01' }, transparency: 'transparent' }).busy, false);
  assert.equal(toEvent({ summary: '会議', start: { dateTime: '2026-10-31T09:00:00+09:00' }, end: { dateTime: '2026-10-31T10:00:00+09:00' }, attendees: [{ self: true, responseStatus: 'declined' }] }).declined, true);
  assert.equal(toEvent({ status: 'cancelled', start: { date: '2026-10-31' } }), null);
});

test('件名にだけ時刻がある終日予定・登録と違う時刻は、件名の時間もふさぐ（重なりには数えない）', () => {
  const evs = [
    allDay('中央病院 8:15〜17:00', '2026-11-08'),
    allDay('佐藤不在', '2026-11-08'),
    timed('ABクリニック渋谷 10:00〜19:00 8万', '2026-11-11T10:00:00', '2026-11-11T19:00:00'),
    timed('会議 13:00-14:00', '2026-11-12T13:00:00', '2026-11-12T14:00:00', { busy: false, declined: true }),
  ];
  const busy = busyOf(evs);
  assert.deepEqual(busy.map((b) => [b.title, b.fromTitle || false]), [['中央病院 8:15〜17:00', true], ['ABクリニック渋谷 10:00〜19:00 8万', false]]);
  assert.equal(busy[0].start, T('2026-11-08T08:15:00'));
  assert.equal(conflicts([...busy, timed('外来', '2026-11-08T09:00:00', '2026-11-08T12:00:00')], T('2026-11-01T00:00:00')).length, 0);
});

test('件名と登録の時刻の食い違いを一度だけ確かめる', () => {
  const now = T('2026-11-05T09:00:00');
  const m = mismatches([
    timed('11:40 みなと研修会', '2026-11-07T10:00:00', '2026-11-07T11:00:00'),
    timed('あおば大救命センター見学8:00', '2026-11-06T08:00:00', '2026-11-06T15:00:00'),
    allDay('中央病院 8:15〜17:00', '2026-11-08'),
    allDay('【暫定・AM／時刻未定】病棟当番', '2026-11-08', { busy: true }),
  ], now);
  assert.equal(m.length, 2);
  assert.match(m[0].text, /11\/7\(土\)の「11:40 みなと研修会」は、件名では 11:40 ですが、カレンダーには 10:00〜11:00 で入っています。どちらが正しいですか？/);
  assert.match(m[1].text, /終日の予定で、時刻（08:15〜17:00）が件名にだけ書いてあります/);
});

test('重なりの知らせに件名を付ける', () => {
  const c = conflicts([timed('中央病院 日勤', '2026-10-28T08:15:00', '2026-10-28T17:00:00'), timed('さくらクリニック', '2026-10-28T08:45:00', '2026-10-28T12:45:00')], T('2026-10-20T09:00:00'));
  assert.match(conflictText(c[0]), /「中央病院 日勤」08:15〜17:00 と 「さくらクリニック」08:45〜12:45 の予定が両方入っています/);
});

test('確定した勤務が終わったら感想を聞く（カレンダーの「勤務確定」も。暫定・古いものは聞かない）', () => {
  const now = T('2026-10-30T19:00:00');
  const events = [
    timed('【勤務確定】こもれびクリニック 内科午後外来（自社求人）', '2026-10-30T14:00:00', '2026-10-30T18:00:00'),
    timed('【暫定】みどり台病院 勤務', '2026-10-30T08:00:00', '2026-10-30T17:00:00'),
    timed('勤務確定 上野 外来', '2026-10-29T10:00:00', '2026-10-29T19:00:00'), // 24時間前に終わった
  ];
  const a = afterShifts({ events, now });
  assert.equal(a.length, 1);
  assert.equal(a[0].subject, 'こもれびクリニック 内科午後外来（自社求人）');
  assert.match(a[0].text, /お疲れさまでした。今日のこもれびクリニック 内科午後外来（自社求人）はどうでしたか？/);
  // 控えにも同じ勤務があれば1回だけ
  const shifts = [{ uid: 'feed:1', status: 'confirmed', start: T('2026-10-30T14:00:00'), end: T('2026-10-30T18:00:00'), area: '東京都墨田区', work: '内科外来' }];
  assert.equal(afterShifts({ events, shifts, now }).length, 1);
});

test('カレンダーに入れた候補で応募の記録がないまま3日以内なら「応募は済みましたか？」', () => {
  const now = T('2026-11-07T09:00:00');
  const jobs = new Map([['feed:5052687', { uid: 'feed:5052687', data: { date: '2026-11-09', startTime: '09:30', endTime: '13:15', city: '板橋区', siteLabel: '自社求人' } }]]);
  const n = applyNudges({ added: ['feed:5052687'], jobs, now });
  assert.match(n[0].text, /11\/9\(月\) 09:30〜の板橋区（自社求人）を「バイト候補」でカレンダーに入れてありますが、応募は済みましたか？/);
  assert.equal(applyNudges({ added: ['feed:5052687'], shifts: [{ uid: 'feed:5052687' }], jobs, now }).length, 0);
  assert.equal(applyNudges({ added: ['feed:5052687'], jobs, now: T('2026-11-05T09:00:00') }).length, 0);
});

test('送ったものは二度出さない（care の知らせ・質問）', async () => {
  const now = T('2026-11-05T09:00:00');
  const events = [timed('11:40 みなと研修会', '2026-11-07T10:00:00', '2026-11-07T11:00:00')];
  const r1 = await careNotices({ now, events, busy: busyOf(events), jobs: new Map(), sentKeys: new Set() });
  assert.equal(r1.items.length, 1);
  const r2 = await careNotices({ now, events, busy: busyOf(events), jobs: new Map(), sentKeys: new Set([r1.items[0].key]) });
  assert.equal(r2.items.length, 0);
});

test('前夜のひとことの材料：重なり（30分の予定も）・当直明け・記録した勤務', async () => {
  const from = T('2026-11-02T00:00:00');
  const busy = busyOf([
    timed('中央病院 当直', '2026-11-01T17:00:00', '2026-11-02T09:00:00'),
    timed('あおば大救命センター見学8:00', '2026-11-02T08:00:00', '2026-11-02T15:00:00'),
    timed('打ち合わせ', '2026-11-02T13:00:00', '2026-11-02T13:30:00', { location: 'https://us02web.zoom.us/j/1' }),
  ]);
  const notes = await briefNotes({ events: [], busy, from, to: from + 864e5 });
  assert.ok(notes.some((n) => /「あおば大救命センター見学8:00」と「打ち合わせ」が 13:00〜13:30 で重なっている/.test(n)), notes.join('\n'));
  assert.ok(notes.some((n) => /前夜に当直「中央病院 当直」（〜09:00）/.test(n)), notes.join('\n'));
});

test('前夜のひとこと：20時以降に1回。本人の予定がない日は AI を呼ばない。言うことがなければ送らない', async () => {
  const events = [allDay('佐藤不在', '2026-10-31'), allDay('田中外勤終日', '2026-10-31')];
  let calls = 0;
  const call = async (_k, req) => { calls += 1; call.req = req; return call.out; };
  const base = { events, busy: busyOf(events), settings: { name: '山田' }, apiKey: 'k', sentKeys: new Set(), call };
  assert.equal(await eveningBrief({ ...base, now: T('2026-10-30T19:45:00') }), null);
  assert.equal(await eveningBrief({ ...base, now: T('2026-10-30T20:00:00') }), null);
  assert.equal(calls, 0);

  const own = [...events, allDay('【暫定・AM／時刻未定】みどり台病院 病棟当番', '2026-10-31', { busy: true }), timed('会食', '2026-10-31T19:00:00', '2026-10-31T20:00:00')];
  call.out = { send: true, text: '明日は午前にみどり台病院の病棟当番（時刻未定）、19時から会食です。当番の時刻が決まったらカレンダーに入れておくと、バイトの候補が正確になります。' };
  const b = await eveningBrief({ ...base, events: own, busy: busyOf(own), now: T('2026-10-30T20:15:00') });
  assert.equal(b.key, 'brief#2026-10-31');
  assert.match(b.text, /病棟当番/);
  assert.match(call.req.user, /本人の名前: 山田/);
  assert.match(call.req.user, /<schedule>\n10\/31\(土\) 終日 佐藤不在 ［空き表示］/);
  assert.match(call.req.system, /他の先生の予定には触れない/);
  // 一度送ったら（送らないと決めた日も）その日は二度呼ばない
  assert.equal(await eveningBrief({ ...base, events: own, busy: busyOf(own), now: T('2026-10-30T20:30:00'), sentKeys: new Set([b.key]) }), null);
  call.out = { send: false, text: '' };
  assert.deepEqual(await eveningBrief({ ...base, events: own, busy: busyOf(own), now: T('2026-10-30T21:00:00') }), { key: 'brief#2026-10-31', date: '2026-10-31', text: null });
});

test('AI に見せる予定の1行・求人の前後の予定', () => {
  assert.equal(eventLine(allDay('佐藤不在', '2026-10-31')), '10/31(土) 終日 佐藤不在 ［空き表示］');
  assert.equal(eventLine(timed('外来', '2026-10-31T09:00:00', '2026-10-31T12:00:00', { location: '船橋駅', note: '白衣' })), '10/31(土) 09:00-12:00 外来 ＠船橋駅 ／メモ: 白衣');
  const busy = busyOf([timed('外来', '2026-10-31T09:00:00', '2026-10-31T12:00:00'), timed('会食', '2026-10-31T19:00:00', '2026-10-31T21:00:00')]);
  assert.equal(aroundText(busy, { start: T('2026-10-31T13:00:00'), end: T('2026-10-31T17:00:00') }), '前: 09:00-12:00 外来／後: 19:00- 会食');
  assert.equal(aroundText(busy, { start: T('2026-11-01T13:00:00'), end: T('2026-11-01T17:00:00') }), undefined);
});

test('件名に「当直」とあれば当直として前後を見る', () => {
  const busy = [timed('中央病院 当直', '2026-11-08T17:00:00', '2026-11-08T23:30:00')];
  const r = restCheck({ start: T('2026-11-09T09:00:00'), end: T('2026-11-09T12:00:00') }, busy);
  assert.match(r.lines[0], /前夜に当直「中央病院 当直」（〜23:30）/);
});
