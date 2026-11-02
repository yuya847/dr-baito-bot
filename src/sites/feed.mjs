// 自社の求人データを読む差し込み口。巡回（tick.mjs）から都道府県×ページの順に1ページずつ呼ばれる。
// JOBS_FEED_URL があればそこから JSON を取る（?pref=<JIS都道府県コード>&page=<1始まり>、JOBS_FEED_TOKEN があれば Bearer で送る）。
// 無ければ架空の求人（sample-jobs.mjs）を返す＝手元やデプロイ直後に動きを確かめる用。
// 返してもらう JSON：{ "jobs": [求人], "lastPage": 数 }。求人の項目は README の「求人データの形」。
import { normalizeJob } from '../lib/normalize.mjs';
import { sampleJobs } from './sample-jobs.mjs';

export const site = 'feed';
export const label = process.env.JOBS_LABEL || '自社求人';
export const origin = process.env.JOBS_FEED_URL ? new URL(process.env.JOBS_FEED_URL).origin : 'https://jobs.example.com';

export async function fetchPage({ prefCode, page, secrets = {}, fetchImpl = fetch, now = new Date() }) {
  const feed = process.env.JOBS_FEED_URL;
  let body;
  if (feed) {
    const u = new URL(feed);
    if (prefCode) u.searchParams.set('pref', String(prefCode));
    u.searchParams.set('page', String(page));
    const headers = { accept: 'application/json', ...(secrets.JOBS_FEED_TOKEN ? { authorization: `Bearer ${secrets.JOBS_FEED_TOKEN}` } : {}) };
    const r = await fetchImpl(u, { headers, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`${label}: 求人データを取れませんでした（${r.status}）`);
    body = await r.json();
  } else {
    // 見本は1ページだけ。都道府県ごとに呼ばれても同じ求人（uid が同じなので重ならない）
    body = { jobs: page === 1 ? sampleJobs(now) : [], lastPage: 1 };
  }
  const jobs = (body.jobs || []).filter((j) => j && j.id != null).map((j) => normalizeJob({ ...j, site, siteLabel: label }));
  return { jobs, lastPage: Number(body.lastPage) || 1 };
}
