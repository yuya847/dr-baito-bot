// 1回の起動で1つの取り込み口の一覧を1ページだけ進める巡回処理。
// 2分おきに呼ばれ、都道府県×ページを順に回って一巡する（元の実装では、求人サイトの robots の Crawl-Delay: 60 を守るためこの速さにしていた）。
// 一巡し終えたときに、その周回で一度も見かけなかった求人へ missingSince を付ける（＝掲載終了の可能性。断定はしない）。
import { createClient } from './lib/http.mjs';
import { appendPay } from './memory.mjs';

/** 通知の要否を決める重要な項目だけの指紋。表記ゆれや取得時刻では変わらないようにする。 */
export function fingerprint(j) {
  return JSON.stringify([j.date, j.startTime, j.endTime, j.hours, j.payType, j.payAmount, j.totalPay, j.address, j.workOutline, j.note]);
}

/** 取得した求人を前回の状態と突き合わせ、新着・変更・再掲載だけを書き込み対象として返す。 */
export function diffJobs(fetched, known, now) {
  const writes = [];
  for (const job of fetched) {
    const { searchText, ...data } = job; // 検索用の連結文字列は保存しない
    const fp = fingerprint(job);
    const prev = known.get(job.uid);
    if (!prev) {
      writes.push({ uid: job.uid, site: job.site, data, fp, firstSeenAt: now, changedAt: now, change: 'new', payLog: appendPay(null, data, now) });
    } else if (prev.fp !== fp) {
      // 報酬が変わったら観測として残す（前回比を出すため。上書きで消さない）
      writes.push({ ...prev, data, fp, changedAt: now, change: 'changed', prevData: prev.data, missingSince: undefined, payLog: appendPay(prev, data, now) });
    } else if (prev.missingSince) {
      writes.push({ ...prev, data, missingSince: undefined, change: 'reappeared', changedAt: now });
    }
  }
  return writes;
}

/** 一巡で一度も見かけなかった求人に missingSince を付ける（掲載終了の可能性。断定はしない）。 */
async function markMissing({ store, known, seen, now }) {
  const gone = [...known.values()]
    .filter((j) => !seen.has(j.uid) && !j.missingSince)
    .map((j) => ({ ...j, missingSince: now, change: 'missing', changedAt: now }));
  if (gone.length) await store.putJobs(gone);
  return gone.length;
}

export async function tick({ mod, store, config, secrets, log = () => {}, now = new Date().toISOString() }) {
  const prefs = config.prefs.length ? config.prefs : [null];
  const cursorKey = `cursor#${mod.site}`;
  const sessionKey = `session#${mod.site}`;
  let cursor = await store.getState(cursorKey);
  if (!cursor) cursor = { prefIdx: 0, page: 1, lastPage: 1, cycleStartedAt: now, seen: [] };

  const client = createClient({ origin: mod.origin, cookies: (await store.getState(sessionKey)) || {} });
  const known = await store.getJobs(mod.site);
  const prefCode = prefs[cursor.prefIdx];

  const { jobs, lastPage } = await mod.fetchPage({ client, prefCode, page: cursor.page, known, config, secrets });
  const writes = diffJobs(jobs, known, now);
  if (writes.length) await store.putJobs(writes);
  await store.putState(sessionKey, client.exportCookies());

  const seen = new Set(cursor.seen);
  for (const j of jobs) seen.add(j.uid);
  log(`${mod.label} 都道府県${prefCode ?? '全国'} p${cursor.page}/${Math.min(lastPage, config.maxPagesPerPref)}: ${jobs.length}件（新着${writes.filter((w) => w.change === 'new').length}・変更${writes.filter((w) => w.change === 'changed').length}）`);

  // 次の位置へ進める
  const lastAllowed = Math.min(lastPage, config.maxPagesPerPref);
  if (cursor.page < lastAllowed && jobs.length) {
    cursor = { ...cursor, page: cursor.page + 1, seen: [...seen] };
  } else if (cursor.prefIdx + 1 < prefs.length) {
    cursor = { ...cursor, prefIdx: cursor.prefIdx + 1, page: 1, seen: [...seen] };
  } else {
    const gone = await markMissing({ store, known, seen, now });
    log(`${mod.label} 一巡完了（${seen.size}件、見えなくなった求人${gone}件）`);
    cursor = null;
  }
  await store.putState(cursorKey, cursor);
  return { fetched: jobs.length, writes: writes.length, cycleDone: cursor === null };
}
