// LINE Messaging API：Webhook の署名確認・返信・プッシュ・求人カード（Flex）。
import { weekdayOf } from './normalize.mjs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { payChangeText } from '../memory.mjs';
import { routeUrl } from '../travel.mjs';

const API = 'https://api.line.me/v2/bot';
// カードのリンクにしてよいのは自社の求人ページ・アプリのリンクのドメインだけ（求人文に紛れた別サイトの URL は出さない）。
// JOB_HOSTS にカンマ区切りで書く（例 jobs.example.com,app.example.com）
const jobHosts = () => (process.env.JOB_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean);

export function verifySignature(channelSecret, rawBody, signature) {
  if (!channelSecret || !signature) return false;
  const want = createHmac('sha256', channelSecret).update(rawBody).digest();
  const got = Buffer.from(String(signature), 'base64');
  return got.length === want.length && timingSafeEqual(got, want);
}

async function call(token, path, body) {
  const r = await fetch(API + path, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`LINE ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  // 返信・プッシュは sentMessages（送ったメッセージの id）を返す。引用返信の元をたどるのに使う
  return r.json().catch(() => ({}));
}

/** 今月の送信数と上限（無料プランは200通。プッシュだけ数える・返信は数えない）。{ limit: 数か null（上限なし）, used } */
export async function quota(token) {
  const get = async (path) => {
    const r = await fetch(API + path, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`LINE ${path}: ${r.status}`);
    return r.json();
  };
  const [q, c] = await Promise.all([get('/message/quota'), get('/message/quota/consumption')]);
  return { limit: q.type === 'limited' ? q.value : null, used: c.totalUsage ?? 0 };
}

export const reply = (token, replyToken, messages) => call(token, '/message/reply', { replyToken, messages: messages.slice(0, 5) });
export const push = (token, to, messages) => call(token, '/message/push', { to, messages: messages.slice(0, 5) });
/** 「入力中…」の表示（考えている間）。失敗しても本処理は続ける */
export const loading = (token, chatId, seconds = 20) => call(token, '/chat/loading/start', { chatId, loadingSeconds: seconds }).catch(() => {});

export const text = (t, quick) => ({ type: 'text', text: String(t).slice(0, 4900), ...(quick ? { quickReply: quick } : {}) });

export const quickReplies = (labels) => ({
  items: labels.map((l) => ({ type: 'action', action: { type: 'message', label: l.slice(0, 20), text: l } })),
});

export function safeUrl(u) {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && jobHosts().includes(x.hostname) ? x.toString() : null;
  } catch { return null; }
}

/**
 * 求人をアプリで開くリンク（求人データの appUrl。JOB_HOSTS のドメインの https だけ）。無ければカードは「求人を見る」になる。
 * 元の実装での注意：アプリのユニバーサルリンクを LINE から直接 Safari で開くと、アプリに渡らず App Store に回ることがあった。
 * そのときは別のドメインに中継ページを置き、そこで1回押してもらう（README の「知っておくとよいこと」）
 */
export const appUrl = (d) => (d.appUrl ? safeUrl(d.appUrl) : null);

/** 紹介した求人の「1番 ID S1001」とアプリのリンク（appUrl がある求人だけ）。返事の文の下に付ける */
export function jobLinks(items) {
  return items.map(({ job, no }) => { const d = job.data || job; const u = appUrl(d); return u ? `${no ? `${no}番 ` : ''}ID ${d.id}\n${u}` : null; }).filter(Boolean).join('\n');
}

export const fmtDate = (d) => {
  const [, m, day] = (d.date || '').split('-').map(Number);
  return `${m}/${day}(${weekdayOf(d.date)}) ${d.startTime}〜${d.endTime}${d.endTime <= d.startTime ? '（翌）' : ''}`;
};

/** 金額を「4.8万円」「6.75万円」「8,000円」に（100円未満の端数がある額は「約」をつけて丸める） */
export function man(n) {
  if (!n) return '';
  if (n < 10000) return `${n.toLocaleString('ja-JP')}円`;
  return n % 100 === 0 ? `${+(n / 10000).toFixed(2)}万円` : `約${+(n / 10000).toFixed(1)}万円`;
}

/** 実働時間を「4時間」「4時間半」「3時間45分」に */
export function span(h) {
  const min = Math.round((h || 0) * 60);
  const H = Math.floor(min / 60), M = min % 60;
  if (!min) return '';
  if (!H) return `${M}分`;
  return M === 0 ? `${H}時間` : M === 30 ? `${H}時間半` : `${H}時間${M}分`;
}

const PREF = /^(北海道|東京都|京都府|大阪府|.{2,3}県)/;
const clock = (t) => (t || '').replace(/^0(\d)/, '$1');

/**
 * 求人の売り文句の材料（通知の1行目・カードの見出し）。
 * { main: '4時間で4.8万円', hourly: '時給1.2万円', date: '11/8(土)', time: '9:00〜13:00', place: '横浜市', work: '内視鏡検査' }
 */
export function jobPitch(job) {
  const d = job.data || job;
  const len = span(d.hours);
  const upTo = d.payMax > d.payAmount ? '〜' : '';
  // 時給で時間がわからないものは総額を出さない（時給をそのまま総額に見せない）
  const main = d.payType === 'hourly' && !len && d.payAmount ? `時給${man(d.payAmount)}${upTo}`
    : d.totalPay || d.payAmount ? `${len ? `${len}で` : ''}${man(d.totalPay || d.payAmount)}${upTo}`
      : (d.payText || '報酬はサイトで確認').slice(0, 20);
  const [, m, day] = (d.date || '').split('-').map(Number);
  const night = d.startTime && d.endTime && d.endTime <= d.startTime;
  let work = (d.workOutline || '').split(/[,、，\s]/).find(Boolean)?.slice(0, 14) || '';
  if (night && !/当直|宿直|夜/.test(work)) work = work ? `当直・${work}` : '当直';
  return {
    main,
    hourly: d.hourlyRate ? `時給${man(d.hourlyRate)}` : '',
    date: m ? `${m}/${day}(${weekdayOf(d.date)})` : '',
    time: d.startTime ? `${clock(d.startTime)}〜${night ? '翌' : ''}${clock(d.endTime)}` : '',
    place: (d.city || d.pref || '').replace(/【[^】]*】/g, '').replace(PREF, '') || d.pref || '',
    work,
  };
}

/** travel は travel.mjs の travelFor の結果（前後の予定の場所からの移動の目安）か null */
export function jobBubble(job, reason, travel, no, rest) {
  const d = job.data || job;
  const url = safeUrl(d.url);
  const pay = [d.payText, d.hourlyRate && d.payType !== 'hourly' ? `（時給換算 ${d.hourlyRate.toLocaleString('ja-JP')}円）` : ''].join('');
  const rows = [
    { type: 'text', text: `${no ? `${no}番　` : ''}${fmtDate(d)}`, weight: 'bold', size: 'md', wrap: true },
    { type: 'text', text: `💰 ${jobPitch(d).main}`, weight: 'bold', size: 'lg', color: '#0b7a3e', wrap: true },
    { type: 'text', text: `${d.pref}${d.city}｜${(d.workOutline || d.title || '').slice(0, 60)}`, size: 'sm', wrap: true },
    ...(d.departments?.length ? [{ type: 'text', text: `🩺 ${d.departments.slice(0, 4).join('・')}`, size: 'xs', color: '#555555', wrap: true }] : []),
    { type: 'text', text: pay.slice(0, 80) || '報酬はサイトで確認', size: 'sm', color: '#0b7a3e', wrap: true },
  ];
  const change = payChangeText(job);
  if (change) rows.push({ type: 'text', text: `${change.startsWith('前回比 ＋') ? '📈' : '📉'} ${change}`, size: 'xs', color: '#0b7a3e', wrap: true });
  if (d.access) rows.push({ type: 'text', text: d.access.slice(0, 60), size: 'xs', color: '#666666', wrap: true });
  if (reason) rows.push({ type: 'text', text: `💡 ${reason}`, size: 'xs', color: '#b35c00', wrap: true });
  for (const t of rest?.lines || []) rows.push({ type: 'text', text: t, size: 'xs', color: '#8e44ad', wrap: true });
  for (const t of travel?.lines || []) rows.push({ type: 'text', text: t, size: 'xs', color: travel.tight ? '#c0392b' : '#1f5f8b', wrap: true });
  const app = appUrl(d);
  rows.push({ type: 'text', text: `${d.siteLabel || d.site}${app ? `　ID ${d.id}` : ''}`, size: 'xxs', color: '#999999' });
  const buttons = [];
  if (app) buttons.push({ type: 'button', style: 'primary', height: 'sm', action: { type: 'uri', label: 'アプリで開く', uri: app } });
  else if (url) buttons.push({ type: 'button', style: 'primary', height: 'sm', action: { type: 'uri', label: '求人を見る', uri: url } });
  if (travel?.route) buttons.push({ type: 'button', style: 'link', height: 'sm', action: { type: 'uri', label: '経路を見る', uri: routeUrl(travel.route.from, travel.route.to) } });
  buttons.push({ type: 'button', style: 'secondary', height: 'sm', action: { type: 'postback', label: 'カレンダーに追加', data: `add|${d.uid}`, displayText: 'カレンダーに追加' } });
  return {
    type: 'bubble', size: 'kilo',
    body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: rows },
    footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: buttons },
  };
}

/** quick はカードの下に出すボタン（クイックリプライは最後のメッセージにしか出ないため、カードのあとに何も続かないときに付ける） */
export function jobCarousel(items, altText, quick) {
  return {
    type: 'flex', altText: altText.slice(0, 400), contents: { type: 'carousel', contents: items.map((x) => jobBubble(x.job, x.reason, x.travel, x.no, x.rest)) },
    ...(quick ? { quickReply: quick } : {}),
  };
}

/** カレンダーへ書く前の確認（「追加する」を押したときだけ書き込む） */
export function confirmAdd(job, { ask = 'カレンダーに追加しますか？', yes = '追加する', no = 'やめる', quick } = {}) {
  const d = job.data || job;
  return {
    type: 'template', altText: ask,
    ...(quick ? { quickReply: quick } : {}),
    template: {
      type: 'confirm',
      text: `${ask}\n${fmtDate(d)}\n${d.pref}${d.city}｜${(d.workOutline || d.title || '').slice(0, 40)}`.slice(0, 240),
      actions: [
        { type: 'postback', label: yes, data: `addok|${d.uid}`, displayText: yes },
        { type: 'postback', label: no, data: 'addno', displayText: no },
      ],
    },
  };
}

const tokyo = (ms, o) => new Date(ms).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', ...o });
/** 「10/30(金) 14:00〜15:00」「10/30(金) 終日」 */
export function eventWhen(ev) {
  const day = (ms) => `${tokyo(ms, { month: 'numeric', day: 'numeric' })}(${tokyo(ms, { weekday: 'short' })})`;
  const t = (ms) => tokyo(ms, { hour: '2-digit', minute: '2-digit' });
  if (ev.allDay) return `${day(ev.start)} 終日`;
  const sameDay = tokyo(ev.start, { dateStyle: 'short' }) === tokyo(ev.end - 1, { dateStyle: 'short' });
  return `${day(ev.start)} ${t(ev.start)}〜${sameDay ? '' : `${day(ev.end)} `}${t(ev.end)}`;
}

/** バイト以外の予定をカレンダーに入れるかの確認（押されたときだけ書き込む） */
export function confirmEvent(id, ev) {
  return {
    type: 'template', altText: 'カレンダーに入れますか？',
    template: {
      type: 'confirm',
      text: `カレンダーに入れますか？\n${eventWhen(ev)}\n${ev.title}${ev.location ? `（${ev.location}）` : ''}`.slice(0, 240),
      actions: [
        { type: 'postback', label: '入れる', data: `evok|${id}`, displayText: '入れる' },
        { type: 'postback', label: 'やめる', data: `evno|${id}`, displayText: 'やめる' },
      ],
    },
  };
}

/** 既存の予定を変える・消す前の確認（押されたときだけ書き込む）。ed = edit.mjs の案 */
export function confirmEdit(id, ed, { ask } = {}) {
  const del = ed.op === 'delete';
  const head = ask || (del ? 'この予定を削除しますか？' : 'この予定を変更しますか？');
  const b = ed.before, a = ed.after;
  const lines = [head, `${eventWhen(b)} ${b.title || '（件名なし）'}`];
  if (!del) {
    const ch = [];
    if (a.start !== b.start || a.end !== b.end || a.allDay !== b.allDay) ch.push(eventWhen(a));
    if (a.title !== b.title) ch.push(`件名「${a.title}」`);
    if (a.location !== b.location) ch.push(a.location ? `場所「${a.location}」` : '場所を消す');
    lines.push(`→ ${ch.join('・')}`);
  }
  if (ed.recurring) lines.push('（繰り返しの予定のうち、この日の1回だけ）');
  if (ed.calName) lines.push(`（共有カレンダー「${ed.calName}」）`);
  const yes = del ? '削除する' : '変更する';
  return {
    type: 'template', altText: head,
    template: {
      type: 'confirm',
      text: lines.join('\n').slice(0, 240),
      actions: [
        { type: 'postback', label: yes, data: `edok|${id}`, displayText: yes },
        { type: 'postback', label: 'やめる', data: `edno|${id}`, displayText: 'やめる' },
      ],
    },
  };
}

/** 変更・削除のあとの「元に戻す」ボタン */
export const undoQuick = (id) => ({ items: [{ type: 'action', action: { type: 'postback', label: '元に戻す', data: `edundo|${id}`, displayText: '元に戻す' } }] });

/** リマインドのカード（経路・アプリのボタンつき）。items = [{ lines, route, shift }] */
export function reminderCarousel(items) {
  const bubble = ({ lines, route, shift }) => {
    const app = appUrl(shift);
    const web = safeUrl(shift.url);
    return {
      type: 'bubble', size: 'kilo',
      body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
        ...lines.map((t, i) => ({ type: 'text', text: t, wrap: true, size: i ? 'xs' : 'sm', weight: i ? 'regular' : 'bold', color: i ? '#444444' : '#111111' })),
        { type: 'text', text: `${shift.siteLabel || shift.site}${app ? `　ID ${shift.id}` : ''}`, size: 'xxs', color: '#999999' },
      ] },
      footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
        { type: 'button', style: 'primary', height: 'sm', action: { type: 'uri', label: '経路を見る', uri: route } },
        ...(app ? [{ type: 'button', style: 'link', height: 'sm', action: { type: 'uri', label: 'アプリで開く', uri: app } }]
          : web ? [{ type: 'button', style: 'link', height: 'sm', action: { type: 'uri', label: '求人を見る', uri: web } }] : []),
      ] },
    };
  };
  return { type: 'flex', altText: items[0].lines[0].slice(0, 400), contents: { type: 'carousel', contents: items.slice(0, 10).map(bubble) } };
}

/** 「応募した／確定した」を押せる返事のボタン（postback なので AI を通さずに記録する） */
export const statusQuick = (uid) => ({
  items: [['応募した', 'applied'], ['確定した', 'confirmed']].map(([label, st]) => ({ type: 'action', action: { type: 'postback', label, data: `eng|${uid}|${st}`, displayText: label } })),
});

/** 勤務の感想を押せるボタン（postback なので AI を通さずに体験として覚える） */
export const FEEDBACK = [['楽だった', 'easy'], ['ふつう', 'ok'], ['大変だった', 'hard'], ['また行きたい', 'again'], ['もう行かない', 'never']];
export const feedbackQuick = (id) => ({
  items: FEEDBACK.map(([label, code]) => ({ type: 'action', action: { type: 'postback', label, data: `fb|${id}|${code}`, displayText: label } })),
});
