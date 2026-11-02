// 予定の読み方：件名に書かれた時刻、件名と登録の食い違い、AI や LINE に出すときの1行、求人の前後の予定。
// 10/30〜 本人の方針で予定の件名・場所・説明の先頭も読む。中身は保存せず、その場の判断と返事にだけ使う。
// 件名・説明は他人の招待で書かれることもあるので、AI にはデータとして渡す（中の指示には従わせない）。
const H = 3600e3;

const hm = (ms) => new Date(ms).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });
const day = (ms) => new Date(ms).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', weekday: 'short' });
export const jstDate = (ms) => new Date(ms + 9 * H).toISOString().slice(0, 10);

// 「8:15〜17:00」「8時15分-17時」「9時から17時」。「9-17」のように単位のないものは読まない（日付・番号と紛れるため）
const T = '([01]?\\d|2[0-3])(?::([0-5]\\d)|時(?:([0-5]?\\d)分?)?)';
const RANGE = new RegExp(`${T}\\s*(?:[〜~\\-－ー–]|から)\\s*(?:翌\\s*)?${T}`);
const ONE = /(?<![\d:])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])/g;
const pad = (h, m) => `${String(h).padStart(2, '0')}:${String(m || 0).padStart(2, '0')}`;

/** 件名の時刻。{ from, to }（範囲）か { from }（時刻1つ）か null */
export function titleTimes(title) {
  const s = String(title || '').normalize('NFKC');
  const m = s.match(RANGE);
  if (m) return { from: pad(m[1], m[2] ?? m[3]), to: pad(m[4], m[5] ?? m[6]) };
  const one = [...s.matchAll(ONE)];
  return one.length === 1 ? { from: pad(one[0][1], one[0][2]) } : null;
}

/** 件名の時刻範囲を、その予定の日付の区間に（日をまたぐなら翌日まで）。範囲がなければ null */
export function titleSpan(e) {
  const t = titleTimes(e.title);
  if (!t?.to) return null;
  const date = jstDate(e.start);
  const start = Date.parse(`${date}T${t.from}:00+09:00`);
  let end = Date.parse(`${date}T${t.to}:00+09:00`);
  if (end <= start) end += 24 * H;
  return { start, end };
}

/**
 * 照合に使う「予定あり」の区間。listEvents の結果から busy のものと、
 * 件名に時刻があるのに終日予定になっている・登録の時刻と違う予定の「件名の時間」（fromTitle）を足す。
 * どちらが正しいか分かるまでは両方の時間をふさぐ（設計書 5）。
 */
export function busyOf(events) {
  const out = [];
  for (const e of events) {
    const { busy, note, declined, ...b } = e;
    if (busy) out.push(b);
    const span = !declined && (busy || e.allDay) ? titleSpan(e) : null;
    if (span && (e.allDay || span.start !== e.start || span.end !== e.end)) out.push({ ...b, ...span, allDay: false, fromTitle: true });
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * 件名の時刻と登録の食い違い（これからの days 日）。[{ key, date, text }]
 * 終日予定に時刻が書いてある／時刻つきの予定で件名の時刻と違う、を一度だけ確かめる。
 */
export function mismatches(events, now, { days = 14 } = {}) {
  const out = [];
  for (const e of events) {
    if (e.declined || e.start < now - 12 * H || e.start > now + days * 24 * H) continue;
    if (!e.busy && !e.allDay) continue;
    const t = titleTimes(e.title);
    if (!t) continue;
    const key = `titletime#${jstDate(e.start)}#${e.title}`;
    const name = `${day(e.start)}の「${e.title}」`;
    // 本人のカレンダーの予定なら、返信ひとつで直せる（edit.mjs。確認ボタンを押したときだけ書く）
    const fixable = e.primary && !e.invited && !e.guests;
    if (e.allDay) {
      if (!t.to) continue;
      out.push({ key, date: jstDate(e.start), text: `${name}は終日の予定で、時刻（${t.from}〜${t.to}）が件名にだけ書いてあります。バイトの候補はこの時間を避けて出します。${fixable ? '「時刻つきに直して」と返信すれば直します。' : '時刻つきの予定に直しておくと確実です。'}` });
    } else if (t.from !== hm(e.start) || (t.to && t.to !== hm(e.end))) {
      out.push({ key, date: jstDate(e.start), text: `${name}は、件名では ${t.to ? `${t.from}〜${t.to}` : t.from} ですが、カレンダーには ${hm(e.start)}〜${hm(e.end)} で入っています。どちらが正しいですか？${t.to ? '（分かるまで両方の時間を避けて候補を出します）' : ''}${fixable ? '件名のほうなら「件名の時刻に直して」と返信してください。' : ''}` });
    }
  }
  return out;
}

/** AI に見せる予定の1行（「10/31(土) 09:00-12:00 外来 ＠墨田区… ／メモ: …」）。free は「空き」表示か辞退 */
export function eventLine(e, { withNote = true } = {}) {
  const when = e.allDay ? `${day(e.start)} 終日` : `${day(e.start)} ${hm(e.start)}-${hm(e.end)}`;
  const tags = [e.declined ? '辞退' : !e.busy ? '空き表示' : ''].filter(Boolean);
  return [when, e.title || '（件名なし）', tags.length ? `［${tags.join('・')}］` : '', e.location ? `＠${e.location.slice(0, 60)}` : '', withNote && e.note ? `／メモ: ${e.note.slice(0, 120)}` : ''].filter(Boolean).join(' ');
}

/** 求人の勤務区間 iv と同じ日の前後の予定（件名つき）を一言で。「前: 09:00-12:00 外来／後: 19:00- 会食」。なければ undefined */
export function aroundText(busy, iv) {
  if (!iv) return undefined;
  const d = jstDate(iv.start);
  const same = busy.filter((b) => !b.fromTitle && (b.allDay ? jstDate(b.start) === d : jstDate(b.start) === d || jstDate(b.end - 1) === d));
  const prev = same.filter((b) => !b.allDay && b.end <= iv.start).pop();
  const next = same.find((b) => !b.allDay && b.start >= iv.end);
  const allDay = same.filter((b) => b.allDay).map((b) => b.title).filter(Boolean);
  const parts = [
    allDay.length ? `終日: ${allDay.join('、').slice(0, 40)}` : '',
    prev ? `前: ${hm(prev.start)}-${hm(prev.end)} ${(prev.title || '予定').slice(0, 20)}` : '',
    next ? `後: ${hm(next.start)}- ${(next.title || '予定').slice(0, 20)}` : '',
  ].filter(Boolean);
  return parts.length ? parts.join('／') : undefined;
}
