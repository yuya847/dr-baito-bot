// 各サイトの表記ゆれを 1 つのスキーマに寄せるためのパーサ群。

export const PREF_NAMES = [
  null,
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
  '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
  '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県',
  '岐阜県', '静岡県', '愛知県', '三重県',
  '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県',
  '鳥取県', '島根県', '岡山県', '広島県', '山口県',
  '徳島県', '香川県', '愛媛県', '高知県',
  '福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
];

export const PREF_CODE = new Map(PREF_NAMES.map((n, i) => [n, i]).filter(([n]) => n));

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

/** 住所文字列から都道府県と市区町村を切り出す。 */
export function splitAddress(address = '') {
  const text = String(address).trim();
  if (/オンライン|在宅|リモート/.test(text)) return { pref: 'オンライン', city: '', address: text };
  const pref = PREF_NAMES.slice(1).find((p) => text.startsWith(p)) || '';
  const rest = pref ? text.slice(pref.length) : text;
  const m = rest.match(/^(.+?[市区町村郡])/);
  return { pref, city: m ? m[1] : '', address: text };
}

/**
 * 給与表記をパースする。
 * 例: "一回 50,000円" / "時給 11,000円" / "日給100,000円～120,000円"
 */
export function parsePay(text = '') {
  const raw = String(text).replace(/\s+/g, ' ').trim();
  if (!raw) return { payType: 'unknown', payAmount: null, payMax: null, payText: '' };

  const amounts = [...raw.matchAll(/([\d,]+)\s*(?:万)?円/g)].map((m) => {
    const n = Number(m[1].replace(/,/g, ''));
    return /万円/.test(m[0]) ? n * 10000 : n;
  }).filter((n) => Number.isFinite(n) && n > 0);

  let payType = 'once';
  if (/時給|時間給|時間当た?り/.test(raw)) payType = 'hourly'; // 「12,000円 1時間当り」のような書き方も時給
  else if (/日給|1日|一日/.test(raw)) payType = 'daily';
  else if (/月給/.test(raw)) payType = 'monthly';

  return {
    payType,
    payAmount: amounts.length ? Math.min(...amounts) : null,
    payMax: amounts.length ? Math.max(...amounts) : null,
    payText: raw,
  };
}

/** "2026/09/08(火)" "2026年9月8日" "9/8" などを YYYY-MM-DD にする。 */
export function parseDate(text = '', today = new Date()) {
  const raw = String(text).trim();
  let m = raw.match(/(\d{4})[/年-](\d{1,2})[/月-](\d{1,2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);

  m = raw.match(/(\d{1,2})[/月-](\d{1,2})/);
  if (m) {
    const [mo, d] = [+m[1], +m[2]];
    // 年の記載がない場合は「今日以降で最も近い同月日」を採用する。
    const year = new Date(today.getFullYear(), mo - 1, d) < startOfDay(today)
      ? today.getFullYear() + 1
      : today.getFullYear();
    return iso(year, mo, d);
  }
  return '';
}

function iso(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function weekdayOf(dateStr) {
  if (!dateStr) return '';
  // 日付だけを UTC として曜日を取る（Lambda は UTC で動くので、+09:00 の getDay() だと前日の曜日になる）
  const d = new Date(`${dateStr}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? '' : WEEKDAYS[d.getUTCDay()];
}

/** "08:30-13:30" "9:00〜17:00" "17:00-翌9:00" を開始/終了/実働時間にする。 */
export function parseTimeRange(text = '') {
  const raw = String(text).replace(/[：]/g, ':').replace(/\s/g, '');
  const m = raw.match(/(翌)?(\d{1,2}):?(\d{2})?\s*[-~〜–ー]\s*(翌)?(\d{1,2}):?(\d{2})?/);
  if (!m) return { startTime: '', endTime: '', hours: null };

  const start = +m[2] * 60 + (+(m[3] || 0));
  let end = +m[5] * 60 + (+(m[6] || 0));
  if (m[4] || end <= start) end += 24 * 60; // 翌日にまたぐ勤務
  return {
    startTime: hhmm(start % (24 * 60)),
    endTime: hhmm(end % (24 * 60)),
    hours: Math.round(((end - start) / 60) * 100) / 100,
  };
}

function hhmm(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

/** 日給・一回いくらの案件も時給換算して横並び比較できるようにする。 */
export function hourlyRate({ payType, payAmount, hours }) {
  if (!payAmount) return null;
  if (payType === 'hourly') return payAmount;
  if (!hours || hours <= 0) return null;
  return Math.round(payAmount / hours);
}

/** 3サイトに同じ案件が出ているかを寄せるためのキー。 */
export function dupKey(job) {
  const pay = job.payAmount ? Math.round(job.payAmount / 1000) : 'x';
  return [job.date, job.startTime, job.endTime, job.city || job.pref, pay].join('|');
}

export function splitDepartments(text = '') {
  return String(text)
    .split(/[,、\/／・]\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 各アダプタが集めた生データを共通スキーマに整える。 */
export function normalizeJob(raw) {
  const { pref, city, address } = raw.pref
    ? { pref: raw.pref, city: raw.city || '', address: raw.address || '' }
    : splitAddress(raw.address || raw.location || '');
  const pay = parsePay(raw.payText || '');
  const time = parseTimeRange(raw.timeText || '');
  // サイト側が実働時間（休憩控除後）を明示している場合はそちらを優先する
  if (Number.isFinite(raw.hours) && raw.hours > 0) time.hours = raw.hours;
  const date = raw.date || parseDate(raw.dateText || '');

  const job = {
    site: raw.site,
    siteLabel: raw.siteLabel,
    id: String(raw.id),
    uid: `${raw.site}:${raw.id}`,
    title: (raw.title || '').replace(/\s+/g, ' ').trim(),
    facility: (raw.facility || '').trim(),
    url: raw.url,
    date,
    weekday: weekdayOf(date),
    ...time,
    ...pay,
    pref,
    city,
    address,
    departments: Array.isArray(raw.departments) ? raw.departments : splitDepartments(raw.departmentsText || ''),
    workOutline: (raw.workOutline || '').trim(),
    facilityType: (raw.facilityType || '').trim(),
    note: (raw.note || '').trim(),
    access: (raw.access || '').trim(),
    // アプリで開くリンク（あれば）。カードの「アプリで開く」と返事の下のリンクに使う
    ...(raw.appUrl ? { appUrl: String(raw.appUrl) } : {}),
    // 取り込み口ごとの差分判定用データ。共通処理では使わない
    ...(raw.raw ? { raw: raw.raw } : {}),
    updatedText: (raw.updatedText || '').trim(),
  };
  job.hourlyRate = hourlyRate(job);
  // 時給案件も「その日いくらもらえるか」で並べられるように総額を出す
  job.totalPay = job.payType === 'hourly' && job.hours
    ? Math.round(job.payAmount * job.hours)
    : job.payAmount;
  job.dupKey = dupKey(job);
  job.searchText = [
    job.title, job.facility, job.address, job.departments.join(' '),
    job.workOutline, job.facilityType, job.note, job.payText,
  ].join(' ');
  return job;
}
