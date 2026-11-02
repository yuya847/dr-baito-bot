import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPage } from '../src/sites/feed.mjs';
import { diffJobs, fingerprint } from '../src/tick.mjs';

test('自社求人の取り込み口：JSON を共通の形に整える。URL が無ければ架空の求人', async () => {
  const seen = [];
  process.env.JOBS_FEED_URL = 'https://api.example.com/doctor-jobs';
  const fetchImpl = async (u, o) => { seen.push([String(u), o.headers.authorization]); return { ok: true, json: async () => ({ lastPage: 3, jobs: [
    { id: 'A1', url: 'https://jobs.example.com/jobs/A1', appUrl: 'https://app.example.com/jobs/A1', date: '2026-11-20', timeText: '09:00-12:00', payText: '時給 12,000円', address: '東京都港区芝5-1-1', departmentsText: '内科、小児科' },
    { url: 'https://jobs.example.com/jobs/no-id' },
  ] }) }; };
  const r = await fetchPage({ prefCode: 13, page: 2, secrets: { JOBS_FEED_TOKEN: 't' }, fetchImpl });
  delete process.env.JOBS_FEED_URL;
  assert.deepEqual(seen, [['https://api.example.com/doctor-jobs?pref=13&page=2', 'Bearer t']]);
  assert.equal(r.lastPage, 3);
  assert.equal(r.jobs.length, 1); // id の無い求人は取り込まない
  const [j] = r.jobs;
  assert.deepEqual([j.uid, j.payType, j.hours, j.totalPay, j.pref, j.city, j.departments, j.appUrl], ['feed:A1', 'hourly', 3, 36000, '東京都', '港区', ['内科', '小児科'], 'https://app.example.com/jobs/A1']);
  const sample = await fetchPage({ page: 1, now: new Date('2026-11-02T00:00:00Z') });
  assert.equal(sample.jobs.length, 4);
  assert.equal(sample.jobs[0].date, '2026-11-05');
  assert.equal((await fetchPage({ page: 2 })).jobs.length, 0);
});

test('差分: 新着・変更・変化なし・再掲載', () => {
  const now = '2026-10-15T00:00:00Z';
  const a = { uid: 'feed:1', site: 'feed', date: '2026-11-01', payAmount: 50000 };
  const b = { uid: 'feed:2', site: 'feed', date: '2026-11-02', payAmount: 60000 };
  const c = { uid: 'feed:3', site: 'feed', date: '2026-11-03', payAmount: 70000 };
  const known = new Map([
    ['feed:2', { uid: 'feed:2', fp: fingerprint({ ...b, payAmount: 55000 }), data: b }],
    ['feed:3', { uid: 'feed:3', fp: fingerprint(c), data: c, missingSince: '2026-10-14T00:00:00Z' }],
  ]);
  const w = diffJobs([a, b, c], known, now);
  assert.deepEqual(w.map((x) => [x.uid, x.change]), [['feed:1', 'new'], ['feed:2', 'changed'], ['feed:3', 'reappeared']]);
  assert.equal(w[2].missingSince, undefined);
  assert.equal(diffJobs([c], new Map([['feed:3', { uid: 'feed:3', fp: fingerprint(c), data: c }]]), now).length, 0);
});

test('曜日は実行環境のタイムゾーンに左右されない', async () => {
  const { weekdayOf } = await import('../src/lib/normalize.mjs');
  assert.equal(weekdayOf('2026-10-23'), '金');
  assert.equal(weekdayOf('2026-10-18'), '日');
});
