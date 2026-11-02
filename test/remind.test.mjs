import test from 'node:test';
import assert from 'node:assert/strict';
import { shiftFrom, setShift, dueReminders, reminderLines, reminderRoute } from '../src/remind.mjs';
import { reminderCarousel } from '../src/lib/line.mjs';

const T = (s) => Date.parse(`${s}+09:00`);
const job = { uid: 'feed:5074799', data: { uid: 'feed:5074799', id: '5074799', site: 'feed', siteLabel: '自社求人', date: '2026-10-28', startTime: '09:00', endTime: '13:00', pref: '千葉県', city: '柏市', address: '千葉県柏市柏1-1-1', workOutline: '内視鏡', url: 'https://jobs.example.com/jobs/5074799', appUrl: 'https://app.example.com/jobs/5074799' } };

test('前日20時以降に1回、出発の1時間前ごろに1回。送ったものは二度出さない', async () => {
  const shifts = setShift([], shiftFrom(job, 'applied', T('2026-10-26T10:00:00')), T('2026-10-26T10:00:00'));
  const sent = new Set();
  assert.equal((await dueReminders({ now: T('2026-10-27T17:00:00'), shifts, sentKeys: sent })).length, 0);
  const eve = await dueReminders({ now: T('2026-10-27T20:15:00'), shifts, sentKeys: sent });
  assert.equal(eve[0].kind, 'eve');
  const lines = reminderLines(eve[0]);
  assert.match(lines[0], /明日 10\/28\(水\) 09:00〜13:00　千葉県柏市｜内視鏡/);
  assert.match(lines.at(-1), /確定の連絡がなければ/);
  sent.add(eve[0].key);
  assert.equal((await dueReminders({ now: T('2026-10-27T21:00:00'), shifts, sentKeys: sent })).length, 0);
  // 出発地が分からないときは「2時間前に出る」とみなし、その1時間前（6:00）から
  assert.equal((await dueReminders({ now: T('2026-10-28T05:45:00'), shifts, sentKeys: sent })).length, 0);
  const go = await dueReminders({ now: T('2026-10-28T06:05:00'), shifts, sentKeys: sent });
  assert.equal(go[0].kind, 'go');
  assert.match(reminderLines(go[0])[0], /^⏰ 今日 09:00〜13:00/);
  // 出発地なし＝今いる場所からの経路
  assert.equal(reminderRoute(go[0]), 'https://www.google.com/maps/dir/?api=1&destination=%E5%8D%83%E8%91%89%E7%9C%8C%E6%9F%8F%E5%B8%82%E6%9F%8F1-1-1&travelmode=transit');
  process.env.JOB_HOSTS = 'app.example.com';
  const card = reminderCarousel([{ lines: reminderLines(go[0]), route: reminderRoute(go[0]), shift: go[0].shift }]);
  delete process.env.JOB_HOSTS;
  assert.deepEqual(card.contents.contents[0].footer.contents.map((b) => b.action.label), ['経路を見る', 'アプリで開く']);
});

test('取消した勤務はリマインドしない。同じ求人は置き換え', async () => {
  const now = T('2026-10-27T19:00:00');
  let shifts = setShift([], shiftFrom(job, 'applied', now), now);
  shifts = setShift(shifts, shiftFrom(job, 'cancelled', now), now);
  assert.equal(shifts.length, 1);
  assert.equal((await dueReminders({ now, shifts, sentKeys: new Set() })).length, 0);
});
