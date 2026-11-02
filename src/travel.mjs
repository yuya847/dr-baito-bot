// カレンダーの前後の予定に「場所」が書いてあれば、そこから求人先までの移動の目安を出す。
// 位置は国土地理院の住所検索・OpenPOI の駅データ（どちらもキー不要）で調べ、直線距離から公共交通の所要時間をざっくり見積もる。
// 予定の場所は保存しない（Lambda のメモリ上で住所→座標だけ使い回す）。位置を調べるサービスには場所の文字列だけを送る。
const GSI = 'https://msearch.gsi.go.jp/address-search/AddressSearch';
const POI = 'https://api.openpoiapi.com/v1/search';
const NEAR_HOURS = 12; // 前後12時間以内の予定だけを見る

const PREF = '(?:東京都|北海道|京都府|大阪府|[^\\s,、（()）]{2,3}県)';
const PREF_ADDR = new RegExp(`${PREF}[^\\s,、（()）]+`);
const CITY_ADDR = /[^\s,、（()）]{1,6}[市区町村郡][^\s,、（()）]*/;

/**
 * 予定の場所の文字列から { q: 位置を調べる語, label: カードに出す短い名前, raw: 経路検索に渡す文字列 } を作る。
 * 例「中央総合病院, 日本、〒104-0061 東京都中央区銀座１−１−１」「〇〇クリニック（東京都墨田区押上1-1-2）」「船橋駅」。
 * オンライン会議・URL は null
 */
export function cleanPlace(s = '') {
  const t = String(s).replace(/\s+/g, ' ').trim();
  if (!t || /^https?:/i.test(t) || /zoom|google ?meet|meet\.google|teams|webex|オンライン|web会議|電話/i.test(t)) return null;
  const raw = t.replace(/日本[、,]\s*/g, '').replace(/〒?\d{3}-?\d{4}\s*/g, '').trim();
  const name = raw.split(/[,、（(]/)[0].trim();
  const addr = (raw.match(PREF_ADDR) || raw.match(CITY_ADDR) || [])[0] || null;
  const label = (name && name !== addr ? name : (addr || '').replace(new RegExp(`^${PREF}`), '') || addr || name).slice(0, 14);
  return { q: addr || name, addr: Boolean(addr), label, raw };
}

const cache = new Map();
/** 住所は国土地理院の住所検索、「〇〇駅」は OpenPOI の駅データ（国土数値情報）で位置を調べる。施設名だけのときは調べない（見当違いを避ける） */
export async function geocode(place) {
  if (!place?.q) return null;
  const key = `${place.addr ? 'a' : 'n'}:${place.q}`;
  if (cache.has(key)) return cache.get(key);
  let hit = null;
  try {
    if (place.addr) {
      const r = await fetch(`${GSI}?q=${encodeURIComponent(place.q)}`, { signal: AbortSignal.timeout(4000) });
      const f = (r.ok ? await r.json() : [])[0];
      if (f) hit = { lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], coarse: !/\d|丁目|番/.test(f.properties?.title || '') };
    } else if (/駅$/.test(place.q)) {
      const r = await fetch(`${POI}?q=${encodeURIComponent(place.q)}&limit=5`, { signal: AbortSignal.timeout(4000) });
      const f = ((r.ok ? await r.json() : {}).results || []).find((x) => x.category === 'station' && x.name === place.q);
      if (f) hit = { lng: f.lng, lat: f.lat, coarse: false };
    }
  } catch { /* 調べられなければ目安なし（経路のボタンだけ出す） */ }
  if (cache.size > 2000) cache.clear();
  cache.set(key, hit);
  return hit;
}

export function km(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** 公共交通のざっくりした所要時間（分）：乗り換え・徒歩の15分＋道のりを直線の1.3倍・平均時速43kmとみる。10分単位で切り上げ */
export function transitMinutes(distKm) {
  return Math.ceil((15 + distKm * 1.8) / 10) * 10;
}

export const routeUrl = (from, to) =>
  `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(from)}&destination=${encodeURIComponent(to)}&travelmode=transit`;

const hm = (ms) => new Date(ms).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });

/**
 * 求人1件の前後の予定（場所つき）からの移動の目安。
 * busy は busyIntervals の結果（件名・場所つき）。interval は求人の勤務時間 { start, end }。
 * 返り値 { lines: ['前の予定 13:00まで（銀座）から約40分 → 間に合いそう'], route: { from, to }, tight } か null
 */
export async function travelFor(job, interval, busy) {
  const d = job.data || job;
  const dest = d.address || `${d.pref}${d.city}`;
  const near = NEAR_HOURS * 3600e3;
  const prev = busy.filter((b) => !b.allDay && !b.fromTitle && b.location && b.end <= interval.start && interval.start - b.end <= near).pop();
  const next = busy.find((b) => !b.allDay && !b.fromTitle && b.location && b.start >= interval.end && b.start - interval.end <= near);
  if (!prev && !next) return null;
  const jobPos = await geocode({ q: dest, addr: true });
  const lines = [];
  let route = null;
  let tight = false;
  for (const [ev, dir] of [[prev, 'prev'], [next, 'next']]) {
    if (!ev) continue;
    const place = cleanPlace(ev.location);
    if (!place) continue;
    const label = ev.title ? `${ev.title.slice(0, 10)}・${place.label}` : place.label;
    const pos = await geocode(place);
    const gap = Math.round((dir === 'prev' ? interval.start - ev.end : ev.start - interval.end) / 60000);
    let est = '';
    if (pos && jobPos) {
      const min = transitMinutes(km(pos, jobPos));
      const ok = min <= gap;
      if (!ok) tight = true;
      est = `約${min}分${jobPos.coarse || pos.coarse ? '（市の中心からの目安）' : ''} → ${ok ? '間に合いそう' : '⚠ 間に合わないかも'}`;
    } else {
      est = '所要時間は経路で確認';
    }
    lines.push(dir === 'prev'
      ? `🚃 前の予定（${hm(ev.end)}まで・${label}）から${est}`
      : `🚃 次の予定（${hm(ev.start)}〜・${label}）まで${est}`);
    if (!route) route = dir === 'prev' ? { from: place.raw, to: dest } : { from: dest, to: place.raw };
  }
  return lines.length ? { lines, route, tight } : null;
}
