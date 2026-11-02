// Google カレンダーの読み書き。鍵（refresh token）は Secrets Manager から渡される。
// 10/30 本人の方針：予定の中身（件名・場所・説明の先頭）も読み、予定の確認への返事と「気づき」（重なり・移動・当直明け・前夜のひとこと）に使う。
// 読んだ中身は保存しない（その場で使うだけ）。件名や説明は他人の招待で書かれることもあるので、AI にはデータとして渡す。
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/calendar/v3';

export async function getAccessToken(secrets) {
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    body: new URLSearchParams({
      client_id: secrets.GOOGLE_CLIENT_ID, client_secret: secrets.GOOGLE_CLIENT_SECRET,
      refresh_token: secrets.GOOGLE_REFRESH_TOKEN, grant_type: 'refresh_token',
    }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`Google: アクセス許可を更新できません（${j.error || r.status}）。連携をやり直してください`);
  return j.access_token;
}

async function api(token, path, { method = 'GET', query, body, etag } = {}) {
  const url = new URL(API + path);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, v);
  const r = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}), ...(etag ? { 'if-match': etag } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) { const err = new Error(`Google Calendar ${method} ${path.replace(/\/events\/.*/, '/events/…')}: ${r.status}`); err.status = r.status; throw err; }
  return r.status === 204 ? null : r.json();
}

/** 自分が持っているカレンダー（祝日・誕生日・他人の共有は除く）。 */
export async function ownCalendars(token) {
  const r = await api(token, '/users/me/calendarList', { query: { minAccessRole: 'owner', fields: 'items(id,primary,selected,summary)' } });
  return (r.items || []).filter((c) => c.primary || c.selected);
}

const EVENT_FIELDS = 'id,etag,status,eventType,recurringEventId,organizer(self),transparency,start,end,attendees(self,responseStatus),summary,location,description';

/**
 * 期間内の予定（「空き」表示・辞退したものも含む）。{ start, end, allDay, busy, declined?, title, location, note, id, cal, … }
 * busy=false は Google で「空き」表示の予定か辞退した予定（照合では避けない）。note は説明の先頭（タグを除いて200字まで）。
 * q を渡すと件名・場所・説明などに言葉を含む予定だけ（Google の全文検索）
 */
export async function listEvents(token, { timeMin, timeMax, q }) {
  const out = [];
  for (const cal of await ownCalendars(token)) {
    let pageToken;
    do {
      const r = await api(token, `/calendars/${encodeURIComponent(cal.id)}/events`, {
        query: {
          timeMin, timeMax, q, singleEvents: 'true', orderBy: 'startTime', maxResults: '2500', pageToken,
          fields: `nextPageToken,items(${EVENT_FIELDS})`,
        },
      });
      for (const ev of r.items || []) {
        const e = toEvent(ev, cal);
        if (e) out.push(e);
      }
      pageToken = r.nextPageToken;
    } while (pageToken);
  }
  return out.sort((a, b) => a.start - b.start);
}

/** 期間内の「予定あり」区間（件名・場所つき）。照合・重なり・移動の目安に使う */
export async function busyIntervals(token, range) {
  return (await listEvents(token, range)).filter((e) => e.busy).map(({ busy, note, declined, ...b }) => b);
}

const clip = (s, n) => (s ? String(s).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n) : undefined) || undefined;

/**
 * 1件の予定を { start, end, allDay, busy, declined?, title, location, note } に。取り消された予定は null。
 * 変更・削除のために、どのカレンダーのどの予定か（id・cal・etag）と、変えてよいかの材料
 * （invited=他人が主催の招待、guests=本人以外の参加者の数、recurring=繰り返しの1回、kind=通常以外の種類）も付ける
 */
export function toEvent(ev, cal = { id: 'primary', primary: true }) {
  if (ev.status === 'cancelled' || !ev.start) return null;
  const me = (ev.attendees || []).find((a) => a.self);
  const allDay = Boolean(ev.start.date);
  const start = allDay ? Date.parse(`${ev.start.date}T00:00:00+09:00`) : Date.parse(ev.start.dateTime);
  const end = allDay ? Date.parse(`${ev.end.date}T00:00:00+09:00`) : Date.parse(ev.end.dateTime);
  // 10/17 本人の方針：Google 上で干渉しない予定（「空き」表示）は避けない。終日予定は「空き」表示が既定なので、
  // 休暇・当直明けなどで提案を止めたい日は、その終日予定を「予定あり」にしてもらう
  const declined = me?.responseStatus === 'declined';
  const busy = !declined && ev.transparency !== 'transparent';
  const guests = (ev.attendees || []).filter((a) => !a.self).length;
  return {
    start, end, allDay, busy, ...(declined ? { declined } : {}), title: clip(ev.summary, 80), location: clip(ev.location, 200), note: clip(ev.description, 200),
    id: ev.id, cal: cal.id, ...(cal.primary ? { primary: true } : { calName: cal.summary }), etag: ev.etag,
    ...(ev.recurringEventId ? { recurring: true } : {}), ...(ev.organizer && !ev.organizer.self ? { invited: true } : {}), ...(guests ? { guests } : {}),
    ...(ev.eventType && ev.eventType !== 'default' ? { kind: ev.eventType } : {}),
  };
}

/** 1件の予定を「予定あり」区間に変換する。Google の「空き」表示の予定と、自分が辞退した予定は空き扱い（null） */
export function toBusy(ev) {
  const e = toEvent(ev);
  if (!e?.busy) return null;
  const { busy, note, declined, ...b } = e;
  return b;
}

// 終日は日付で書く（終わりの日は含まない）。patch で終日⇔時刻つきを切り替えるときは、使わないほうを null で消す
const when = (ms, allDay, clear = false) => (allDay
  ? { date: new Date(ms + 9 * 3600e3).toISOString().slice(0, 10), ...(clear ? { dateTime: null, timeZone: null } : {}) }
  : { dateTime: new Date(ms).toISOString(), timeZone: 'Asia/Tokyo', ...(clear ? { date: null } : {}) });
const eventPath = (cal, id) => `/calendars/${encodeURIComponent(cal)}/events/${encodeURIComponent(id)}`;

/** 予定を書き込む。呼ぶのは本人が内容を確認して「追加する」を押したあとだけ（通知や AI の判断だけでは書かない）。 */
export async function insertEvent(token, { calendarId = 'primary', summary, description, location, start, end, allDay = false }) {
  return api(token, `/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: 'POST',
    query: { fields: 'id,htmlLink' },
    body: { summary, description, location, start: when(start, allDay), end: when(end, allDay) },
  });
}

/** 1件の予定（変更・削除の直前に、押すまでの間に変わっていないかを確かめる）。消えていれば null */
export async function getEvent(token, { cal, id }) {
  try {
    const ev = await api(token, eventPath(cal, id), { query: { fields: EVENT_FIELDS } });
    return ev.status === 'cancelled' ? null : ev;
  } catch (e) {
    if (e.status === 404 || e.status === 410) return null;
    throw e;
  }
}

/**
 * 予定を変える（件名・場所・時刻）。呼ぶのは本人が確認ボタン（変更する）を押したあとだけ。
 * etag が違えば（押すまでの間に誰かが変えていれば）Google が 412 を返して書かない。参加者には知らせない（参加者のいる予定はそもそも変えない）
 */
export async function patchEvent(token, { cal, id, etag }, { title, location, start, end, allDay }) {
  const body = {};
  if (title !== undefined) body.summary = title;
  if (location !== undefined) body.location = location || null;
  if (start !== undefined) { body.start = when(start, allDay, true); body.end = when(end, allDay, true); }
  return api(token, eventPath(cal, id), { method: 'PATCH', etag, query: { sendUpdates: 'none', fields: 'id,etag' }, body });
}

/** 予定を消す（Google カレンダーのゴミ箱に入る）。呼ぶのは本人が確認ボタン（削除する）を押したあとだけ */
export async function deleteEvent(token, { cal, id, etag }) {
  return api(token, eventPath(cal, id), { method: 'DELETE', etag, query: { sendUpdates: 'none' } });
}

/** 消した予定を戻す（「元に戻す」）。ゴミ箱にあるうちは、状態を confirmed に戻せば元の予定（id・メモ・通知）のまま戻る */
export async function restoreEvent(token, { cal, id }) {
  return api(token, eventPath(cal, id), { method: 'PATCH', query: { sendUpdates: 'none', fields: 'id,etag,status' }, body: { status: 'confirmed' } });
}
