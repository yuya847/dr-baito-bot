// 先回りの知らせ：15分おきに見て、本人に意味のある変化があるときだけ LINE で送る。何もなければ何も送らない。
//   1. 予定の重なり（件名つきで知らせる）
//   2. 気にしていた求人（カレンダーに入れた候補・会話で確かめた求人）が巡回で見えなくなった
//   3. 空きに合う求人の大きな増額（前回比 +10% 以上）
//   4. 条件に合う新着
// 3・4（求人の知らせ）は合わせて3時間に1回・最大3件。そのとき見送った分も「知らせ済み」にして、少しずつ何度も送らない。
// 1・2 はすぐ送る。
// 同じ知らせは二度出さない（assistant:sentkeys）。通知を送らない時間帯（本人が決める）は送らず、次の回に回す。
import { payChange } from './memory.mjs';
import { jobPitch } from './lib/line.mjs';

const DAY = 864e5;
export const NEW_EVERY_MS = 3 * 3600e3;
const PAY_UP_PCT = 10;
const MAX_JOBS = 3;

const hm = (ms) => new Date(ms).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });
const day = (ms) => new Date(ms).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', weekday: 'short' });
const dateOf = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);

/** 時刻の決まった予定どうしの重なり（どちらも1時間以上・これからの予定）。[{ key, a, b }] */
export function conflicts(busy, now) {
  // 件名の時刻でふさいだ区間（fromTitle）は元の予定の写しなので数えない（食い違いは schedule.mjs の mismatches で聞く）
  const timed = busy.filter((b) => !b.allDay && !b.fromTitle && b.end - b.start >= 3600e3 && b.start > now && b.start < now + 30 * DAY).sort((x, y) => x.start - y.start);
  const out = [];
  for (let i = 0; i < timed.length; i += 1) {
    for (let j = i + 1; j < timed.length && timed[j].start < timed[i].end; j += 1) {
      const a = timed[i], b = timed[j];
      // 同じ時間の予定が2つ（別カレンダーへの写しなど）は重なりとみなさない
      if (a.start === b.start && a.end === b.end) continue;
      out.push({ key: `conflict#${a.start}-${a.end}#${b.start}-${b.end}`, a, b });
    }
  }
  return out;
}

const named = (x) => `${x.title ? `「${x.title.slice(0, 24)}」` : ''}${hm(x.start)}〜${hm(x.end)}`;
export const conflictText = ({ a, b }) =>
  `${day(a.start)}の予定が重なっています。${named(a)} と ${named(b)} の予定が両方入っています。どちらかは変更・取消済みでしょうか？`;

/**
 * 知らせることを集める（送るかどうかの判断まで。送るのは呼び出し側）。
 * in = { now, busy, hits（空きに合う求人を条件で並べたもの）, jobs, watched: [uid], sentKeys: Set, sentNew: Set, lastNewAt, hasPrefs }
 */
export function collect({ now, busy, hits, jobs, watched, sentKeys, sentNew, lastNewAt = 0, hasPrefs }) {
  const items = [];
  for (const c of conflicts(busy, now)) if (!sentKeys.has(c.key)) items.push({ kind: 'conflict', key: c.key, text: conflictText(c) });

  const today = dateOf(now);
  for (const uid of watched) {
    const j = jobs.get(uid);
    const d = j?.data || j;
    if (!j?.missingSince || !d || d.date < today) continue;
    const key = `gone#${uid}`;
    if (!sentKeys.has(key)) items.push({ kind: 'gone', key, uid, text: `気にしていた ${d.date.slice(5).replace('-', '/')} ${d.city || d.pref}の求人（${d.siteLabel}）が、巡回で見えなくなりました。募集終了の可能性があります。` });
  }

  const jobsOut = [];
  const payKeys = [];
  const jobsOk = now - lastNewAt >= NEW_EVERY_MS;
  for (const h of jobsOk ? hits : []) {
    const j = h.job;
    const c = payChange(j);
    if (!c || c.pct < PAY_UP_PCT || Date.parse(c.toAt) < now - DAY) continue;
    const key = `pay#${j.uid}#${c.to}`;
    if (sentKeys.has(key)) continue;
    payKeys.push(key);
    if (jobsOut.length < MAX_JOBS) jobsOut.push({ kind: 'pay', key, uid: j.uid, pct: c.pct });
  }

  const newOk = hasPrefs && jobsOk;
  let fresh = 0;
  if (newOk) {
    for (const h of hits) {
      if (jobsOut.length >= MAX_JOBS) break;
      const uid = h.job.uid;
      if (sentNew.has(uid) || jobsOut.some((x) => x.uid === uid)) continue;
      jobsOut.push({ kind: 'new', key: `new#${uid}`, uid });
      fresh += 1;
    }
  }
  return { items, jobs: jobsOut, fresh, payKeys };
}

const pitchOf = (x, jobs) => { const j = jobs.get(x.uid); return j ? jobPitch(j) : null; };
const upOf = (x) => (x.kind === 'pay' ? `📈 増額＋${x.pct}% ` : '');

/**
 * 1通目の文。重なり・募集終了を先に、そのあと求人。求人は通知の1行目で中身がわかるように、1件目を
 * 「💰 4時間で4.8万円！ 11/8(土) 横浜市・内視鏡検査」と金額と時間から書き、2件目からはカードの番号つきで1行ずつ。
 * jobs（uid → 求人）がなければ件数だけ
 */
export function headline({ items, jobs }, data = new Map()) {
  const lines = items.map((x) => x.text);
  const ps = jobs.map((x) => pitchOf(x, data));
  if (jobs.length && ps.every(Boolean)) {
    const [p, x] = [ps[0], jobs[0]];
    const rest = jobs.slice(1).map((y, i) => `${i + 2}番 ${upOf(y)}${ps[i + 1].date} ${ps[i + 1].main}　${[ps[i + 1].place, ps[i + 1].work].filter(Boolean).join('・')}`);
    lines.push([
      `${x.kind === 'pay' ? upOf(x).trim() : '💰'} ${p.main}！ ${p.date} ${[p.place, p.work].filter(Boolean).join('・')}`,
      [p.time, p.hourly ? `（${p.hourly}）` : ''].join(''),
      ...rest,
    ].filter(Boolean).join('\n'));
  } else if (jobs.length) {
    const up = jobs.filter((x) => x.kind === 'pay').length;
    const nw = jobs.filter((x) => x.kind === 'new').length;
    lines.push([up ? `空きに合う求人で増額が${up}件` : '', nw ? `新しく合う求人が${nw}件` : ''].filter(Boolean).join('、') + 'あります。');
  }
  return lines.join('\n\n');
}

/** カードの代わりの文（通知とトーク一覧に出る）。「1番 11/8(土) 4時間で4.8万円 横浜市」を1件1行で */
export function cardsAlt({ jobs }, data = new Map()) {
  return jobs.map((x, i) => { const p = pitchOf(x, data); return p ? `${i + 1}番 ${upOf(x)}${p.date} ${p.main} ${p.place}` : null; }).filter(Boolean).join('\n') || '求人のカード';
}
