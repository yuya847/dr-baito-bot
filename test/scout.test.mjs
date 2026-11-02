import test from 'node:test';
import assert from 'node:assert/strict';
import { cardsAlt, collect, conflicts, headline, NEW_EVERY_MS } from '../src/scout.mjs';
import { jobBubble, jobPitch, man, span } from '../src/lib/line.mjs';
import { normalizeJob, parsePay } from '../src/lib/normalize.mjs';

const T = (s) => Date.parse(`2026-10-28T${s}:00+09:00`);
const now = Date.parse('2026-10-20T09:00:00+09:00');
const job = (uid, o = {}) => ({ job: { uid, data: { uid, date: '2026-10-25', city: '船橋市', siteLabel: '自社求人' }, ...o } });
const base = { now, busy: [], hits: [], jobs: new Map(), watched: [], sentKeys: new Set(), sentNew: new Set(), lastNewAt: 0, hasPrefs: true };

test('予定の重なりを先に知らせる（時刻だけ・同じ時間の写しは除く）', () => {
  const busy = [{ start: T('08:15'), end: T('17:00') }, { start: T('08:45'), end: T('12:45') }, { start: T('19:00'), end: T('20:00') }, { start: T('19:00'), end: T('20:00') }];
  const c = conflicts(busy, now);
  assert.equal(c.length, 1);
  const r = collect({ ...base, busy });
  assert.match(r.items[0].text, /予定が重なっています。08:15〜17:00 と 08:45〜12:45/);
  assert.match(r.items[0].text, /変更・取消済みでしょうか/);
  // 一度知らせたら二度目は出さない
  assert.equal(collect({ ...base, busy, sentKeys: new Set([r.items[0].key]) }).items.length, 0);
});

test('気にしていた求人が見えなくなったら知らせる', () => {
  const j = { uid: 'feed:1', data: { date: '2026-10-21', city: '大和市', siteLabel: '自社求人' }, missingSince: '2026-10-19T16:06:00Z' };
  const r = collect({ ...base, jobs: new Map([['feed:1', j]]), watched: ['feed:1'] });
  assert.match(r.items[0].text, /10\/21 大和市の求人（自社求人）が、巡回で見えなくなりました。募集終了の可能性/);
});

test('増額・新着は3時間に1回・最大3件。変化がなければ何も出さない', () => {
  const up = (uid) => job(uid, { payLog: [{ at: '2026-10-19T22:00:00Z', amount: 32000 }, { at: '2026-10-20T00:00:00Z', amount: 40000 }] });
  const hits = [up('a'), up('b'), up('c'), up('d'), job('e')];
  const r = collect({ ...base, hits });
  assert.equal(r.jobs.length, 3);
  assert.equal(r.payKeys.length, 4); // 見送った分も知らせ済みにする
  assert.match(headline(r), /増額が3件/);
  assert.equal(collect({ ...base, hits, lastNewAt: now - NEW_EVERY_MS + 60e3 }).jobs.length, 0);
  assert.equal(collect({ ...base }).items.length + collect({ ...base }).jobs.length, 0);
});

test('通知は件数ではなく中身から：1件目を「4時間で4.8万円！」と金額・時間・日付・場所で、2件目からは番号つきで1行ずつ', () => {
  const mk = (id, o) => normalizeJob({ site: 'feed', siteLabel: '自社求人', id, address: '神奈川県横浜市', ...o });
  const data = new Map([
    ['feed:1', { uid: 'feed:1', data: mk('1', { payText: '一回 48,000円', dateText: '2026/11/08', timeText: '09:00-13:00', workOutline: '内視鏡検査（健診）,健診' }) }],
    ['feed:2', { uid: 'feed:2', data: mk('2', { payText: '時給 15,000円', dateText: '2026/11/09', timeText: '09:00-17:30', workOutline: '外来', address: '【最初】東京都品川区' }) }],
    ['feed:3', { uid: 'feed:3', data: mk('3', { payText: '一回 90,000円', dateText: '2026/11/15', timeText: '17:00-翌9:00', workOutline: '救急車対応, 病棟管理' }) }],
  ]);
  const found = { items: [], jobs: [{ kind: 'new', uid: 'feed:1' }, { kind: 'pay', uid: 'feed:2', pct: 15 }, { kind: 'new', uid: 'feed:3' }] };
  const h = headline(found, data);
  assert.equal(h.split('\n')[0], '💰 4時間で4.8万円！ 11/8(日) 横浜市・内視鏡検査（健診）');
  assert.match(h, /^9:00〜13:00（時給1.2万円）$/m);
  assert.match(h, /^2番 📈 増額＋15% 11\/9\(月\) 8時間半で12.75万円　品川区・外来$/m);
  assert.match(h, /^3番 11\/15\(日\) 16時間で9万円　横浜市・当直・救急車対応$/m);
  assert.equal(cardsAlt(found, data).split('\n')[0], '1番 11/8(日) 4時間で4.8万円 横浜市');
  // 重なりなどの知らせは先に。求人の中身がわからないときは件数だけ
  assert.match(headline({ ...found, items: [{ text: '予定が重なっています。' }] }, data), /^予定が重なっています。\n\n💰 4時間で/);
  assert.match(headline(found), /増額が1件、新しく合う求人が2件あります/);
  // カードにも同じ見出しを大きく
  assert.equal(jobBubble(data.get('feed:1'), '', null, 1).body.contents[1].text, '💰 4時間で4.8万円');
});

test('金額・時間の書き方と、「1時間当り」は時給', () => {
  assert.deepEqual([man(8000), man(45000), man(67500), man(58430), man(240000)], ['8,000円', '4.5万円', '6.75万円', '約5.8万円', '24万円']);
  assert.deepEqual([span(4), span(4.5), span(3.75), span(0.5), span(null)], ['4時間', '4時間半', '3時間45分', '30分', '']);
  assert.equal(parsePay('12,000円 1時間当り （税込）').payType, 'hourly');
  assert.equal(parsePay('40,000円 1回当り （税込）').payType, 'once');
  const d = normalizeJob({ site: 'feed', id: '9', payText: '12,000円 1時間当り （税込）', hours: 3.75, dateText: '2026年11月21日', timeText: '9:00-13:00', address: '埼玉県さいたま市大宮区' });
  assert.equal(jobPitch(d).main, '3時間45分で4.5万円');
  // 時給で時間がわからないものは総額にしない
  assert.equal(jobPitch({ payType: 'hourly', payAmount: 12000, totalPay: 12000, hours: null }).main, '時給1.2万円');
});
