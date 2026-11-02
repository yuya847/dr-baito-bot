import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { rankJobs, relaxedScore } from '../src/rank.mjs';
import { verifySignature, safeUrl, jobBubble, confirmAdd } from '../src/lib/line.mjs';
import { isQuiet } from '../src/assistant.mjs';

const job = (o) => {
  const d = { uid: `feed:${o.id}`, site: 'feed', siteLabel: '自社求人', date: '2026-10-24', weekday: '土', startTime: '09:00', endTime: '13:00', hours: 4, pref: '東京都', city: '葛飾区', workOutline: '外来', searchText: '', url: 'https://jobs.example.com/jobs/1', ...o };
  return { job: { uid: d.uid, data: d }, interval: { start: Date.parse(`${d.date}T${d.startTime}:00+09:00`) } };
};

test('時給重視なら高い順・下限や避けたい業務は外す', () => {
  const hits = [job({ id: 1, hourlyRate: 10000 }), job({ id: 2, hourlyRate: 15000, startTime: '10:00' }), job({ id: 3, hourlyRate: 20000, startTime: '11:00', searchText: '救急車対応' }), job({ id: 4, hourlyRate: 8000, startTime: '12:00' })];
  const r = rankJobs(hits, { priorities: ['pay'], minHourly: 9000, excludeKeywords: ['救急車'] }).map((h) => h.job.data.id);
  assert.deepEqual(r, [2, 1]);
});

test('立地重視なら指定の市区町村が先・ゆとり重視なら健診が先', () => {
  const hits = [job({ id: 1, hourlyRate: 20000, city: '八王子市', startTime: '10:00' }), job({ id: 2, hourlyRate: 10000, city: '船橋市', pref: '千葉県' })];
  assert.equal(rankJobs(hits, { priorities: ['location'], areas: [{ pref: '千葉県', city: '船橋市' }] })[0].job.data.id, 2);
  const h2 = [job({ id: 1, hourlyRate: 15000, searchText: '救急車対応・Walk-in' }), job({ id: 2, hourlyRate: 12000, startTime: '10:00', searchText: '健診（院内）' })];
  assert.equal(rankJobs(h2, { priorities: ['relaxed', 'pay'] })[0].job.data.id, 2);
  assert.ok(relaxedScore('※患者数：60～70名程/コマ') < 0);
});

test('同じ日・同じ時間・同じ業務の似た求人は1件にまとめる', () => {
  const hits = [job({ id: 1, hourlyRate: 15000, city: '江戸川区' }), job({ id: 2, hourlyRate: 14000, city: '品川区' })];
  assert.equal(rankJobs(hits, { priorities: ['pay'] }).length, 1);
});

test('LINE の署名確認', () => {
  const body = Buffer.from('{"events":[]}');
  const sig = createHmac('sha256', 'sec').update(body).digest('base64');
  assert.ok(verifySignature('sec', body, sig));
  assert.ok(!verifySignature('sec', body, 'AAAA'));
  assert.ok(!verifySignature('', body, sig));
});

test('カードのリンクは求人サイトだけ・カレンダー追加は確認を挟む', () => {
  assert.equal(safeUrl('https://evil.example.com/x'), null);
  assert.equal(safeUrl('http://jobs.example.com/x'), null);
  const b = jobBubble(job({ id: 9, url: 'https://evil.example.com/' }).job, '理由');
  assert.ok(!JSON.stringify(b).includes('evil'));
  const c = confirmAdd(job({ id: 9 }).job);
  assert.deepEqual(c.template.actions.map((a) => a.data), ['addok|feed:9', 'addno']);
});

test('1〜7時はプッシュしない', () => {
  assert.ok(isQuiet(Date.parse('2026-10-17T01:00:00+09:00')));
  assert.ok(isQuiet(Date.parse('2026-10-17T06:59:00+09:00')));
  assert.ok(!isQuiet(Date.parse('2026-10-17T07:00:00+09:00')));
  assert.ok(!isQuiet(Date.parse('2026-10-17T00:30:00+09:00')));
});

import { cleanPlace, transitMinutes, travelFor } from '../src/travel.mjs';

test('予定の場所から検索語を作る（Google の住所表記・オンラインは除外）', () => {
  assert.deepEqual(cleanPlace('中央総合病院, 日本、〒104-0061 東京都中央区銀座１−１−１'),
    { q: '東京都中央区銀座１−１−１', addr: true, label: '中央総合病院', raw: '中央総合病院, 東京都中央区銀座１−１−１' });
  assert.equal(cleanPlace('〇〇クリニック（東京都墨田区押上1-1-2）').q, '東京都墨田区押上1-1-2');
  assert.equal(cleanPlace('〇〇クリニック（東京都墨田区押上1-1-2）').label, '〇〇クリニック');
  assert.equal(cleanPlace('日本、千葉県船橋市本町1-2-3').label, '船橋市本町1-2-3');
  assert.deepEqual(cleanPlace('船橋駅'), { q: '船橋駅', addr: false, label: '船橋駅', raw: '船橋駅' });
  assert.equal(cleanPlace('みどり台病院').addr, false);
  assert.equal(cleanPlace('https://zoom.us/j/123'), null);
  assert.equal(cleanPlace('Google Meet'), null);
});

test('移動時間の目安は距離に応じて増え、10分単位', () => {
  assert.equal(transitMinutes(0), 20);
  assert.equal(transitMinutes(20), 60);
  assert.ok(transitMinutes(40) > transitMinutes(20));
});

test('前後の予定に場所がなければ移動の目安は出さない', async () => {
  const job = { data: { pref: '千葉県', city: '船橋市', address: '千葉県船橋市' } };
  const busy = [{ start: 0, end: 3600e3 }];
  assert.equal(await travelFor(job, { start: 7200e3, end: 10800e3 }, busy), null);
});

test('「17時以降」「12時まで」は必ず守る（点数ではなく絞り込み）', () => {
  const mk = (uid, s, e, rate) => ({ job: { data: { uid, date: '2026-10-20', startTime: s, endTime: e, hourlyRate: rate, searchText: '' } }, interval: { start: 0, end: 0 } });
  const hits = [mk('a', '09:00', '12:00', 20000), mk('b', '15:00', '17:00', 18000), mk('c', '17:00', '21:00', 12000), mk('d', '18:00', '08:00', 10000)];
  const late = rankJobs(hits, { priorities: ['pay', 'time'], earliestStart: '17:00' }).map((h) => h.job.data.uid);
  assert.deepEqual(late.sort(), ['c', 'd']);
  const am = rankJobs(hits, { priorities: ['pay'], latestEnd: '12:00' }).map((h) => h.job.data.uid);
  assert.deepEqual(am, ['a']);
});

import { appendPay, payChange, payChangeText, parseQuiet, inQuiet, mergeFacts, mergeLessons } from '../src/memory.mjs';
import { diffJobs } from '../src/tick.mjs';

test('報酬の観測：上書きせず残し、前回比を金額と%で出す（通常額比は出さない）', () => {
  const d1 = { uid: 'feed:5040703', date: '2026-10-21', payAmount: 32000, totalPay: null, hourlyRate: 32000, note: '交通費: 上限2,000円' };
  const [first] = diffJobs([{ ...d1, site: 'feed' }], new Map(), '2026-10-18T22:10:00Z');
  assert.equal(first.payLog.length, 1);
  const known = new Map([[first.uid, { ...first, fp: 'x' }]]);
  const [second] = diffJobs([{ ...d1, site: 'feed', payAmount: 40000, note: '交通費: 上限4,000円' }], known, '2026-10-19T09:40:00Z');
  assert.equal(second.payLog.length, 2);
  assert.deepEqual({ diff: payChange(second).diff, pct: payChange(second).pct }, { diff: 8000, pct: 25 });
  const t = payChangeText(second);
  assert.match(t, /前回比 ＋8,000円／＋25%/);
  assert.match(t, /10\/19 07:10 32,000円 → 10\/19 18:40 40,000円/);
  assert.doesNotMatch(t, /通常/);
  // 額が同じなら観測を増やさない
  assert.equal(appendPay(second, { ...d1, payAmount: 40000, note: '交通費: 上限4,000円' }, '2026-10-19T10:00:00Z').length, 2);
});

test('通知を送らない時間帯は本人が決める', () => {
  assert.deepEqual(parseQuiet('22時〜7時'), { quiet: { from: 22, to: 7 } });
  assert.deepEqual(parseQuiet('0時から8時は送らないで'), { quiet: { from: 0, to: 8 } });
  assert.deepEqual(parseQuiet('1時〜7時（標準）'), { quiet: { from: 1, to: 7 } });
  assert.deepEqual(parseQuiet('いつでもOK'), { quiet: null });
  assert.equal(parseQuiet('通知してほしい'), null);
  const at = (h) => Date.parse(`2026-10-20T${String(h).padStart(2, '0')}:30:00+09:00`);
  assert.ok(inQuiet(at(23), { from: 22, to: 7 }) && inQuiet(at(6), { from: 22, to: 7 }) && !inQuiet(at(7), { from: 22, to: 7 }));
  assert.ok(!inQuiet(at(3), null));
  assert.ok(isQuiet(at(3)) && !isQuiet(at(12)));
});

test('学んだことは同じ対象なら新しいほうで置き換える（本人の訂正を優先）', () => {
  let f = mergeFacts([], [{ kind: 'engagement', subject: 'さくらクリニック 10/28', text: '勤務確定' }], 't1');
  f = mergeFacts(f, [{ kind: 'engagement', subject: 'さくらクリニック 10/28', text: '本人が取消済み' }], 't2');
  assert.equal(f.length, 1);
  assert.equal(f[0].text, '本人が取消済み');
  const l = mergeLessons(mergeLessons([], ['時刻の指定は必ず守る'], 't1'), ['時刻の指定は必ず守る', ''], 't2');
  assert.equal(l.length, 1);
});

test('「当直だけ」は必ず守る', () => {
  const night = job({ id: 1, hourlyRate: 6000, startTime: '17:00', endTime: '09:00' });
  night.interval.end = night.interval.start + 16 * 3600e3;
  const day = job({ id: 2, hourlyRate: 15000, startTime: '13:00' });
  day.interval.end = day.interval.start + 4 * 3600e3;
  assert.deepEqual(rankJobs([night, day], { priorities: ['pay'], shift: 'night' }).map((h) => h.job.data.id), [1]);
  assert.deepEqual(rankJobs([night, day], { priorities: ['pay'], shift: 'day' }).map((h) => h.job.data.id), [2]);
});
