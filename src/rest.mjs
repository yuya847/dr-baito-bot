// 当直の前後を考える：当直の求人なら「翌日（当直明け）に予定があるか」、どの求人でも「前夜が当直か」を見る。
// 8時間以上で日付をまたぐ／夕方以降に始まる予定と、件名に「当直・夜勤・宿直」とある予定を当直とみなす（件名がないときは「当直らしき予定」と書く）。
// 外すのではなく、注意書きを付けて順位を下げる（本人が承知で入れることもあるため）。
const H = 3600e3;
const NEAR = 14 * H; // 当直明けから14時間以内を「明けの予定」とみる

const jstHour = (ms) => new Date(ms + 9 * H).getUTCHours();
const jstDate = (ms) => new Date(ms + 9 * H).toISOString().slice(0, 10);
const hm = (ms) => new Date(ms).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });

const NIGHT_WORD = /当直|夜勤|宿直/;

/** 当直らしい区間か（8時間以上で、日付をまたぐか16時以降に始まる。件名に「当直」などがあれば6時間以上で当直とみる） */
export function isNight({ start, end, allDay, title }) {
  if (allDay) return false;
  if (NIGHT_WORD.test(title || '') && !/日直/.test(title) && end - start >= 6 * H) return true;
  if (end - start < 8 * H) return false;
  return jstDate(start) !== jstDate(end - 1) || jstHour(start) >= 16;
}
/** 「当直（中央病院 当直）」か「当直らしき予定」 */
const nightName = (b) => (b.title ? `当直「${b.title.slice(0, 20)}」` : '当直らしき予定');
const eventName = (b) => (b.title ? `「${b.title.slice(0, 20)}」` : '予定あり');

/** 求人の勤務区間 iv と予定 busy から、当直の前後の注意。{ lines, penalty }（何もなければ penalty 0） */
export function restCheck(iv, busy = []) {
  if (!iv) return { lines: [], penalty: 0 };
  const lines = [];
  let penalty = 0;
  const night = isNight(iv);

  // 前夜が当直（明けてから NEAR 以内に始まる勤務）
  const prev = busy.filter((b) => isNight(b) && b.end <= iv.start && iv.start - b.end <= NEAR).pop();
  if (prev) {
    const gap = (iv.start - prev.end) / H;
    lines.push(night
      ? `🌙 前夜も${nightName(prev)}（〜${hm(prev.end)}）。連続の当直になります`
      : `🌙 前夜に${nightName(prev)}（〜${hm(prev.end)}）。当直明け${gap < 1 ? 'すぐ' : `約${Math.round(gap)}時間後`}の勤務です`);
    penalty += night || gap < 4 ? 2 : 1;
  }

  // 当直の求人で、翌日（明け）に予定がある
  if (night) {
    const next = busy.find((b) => !b.allDay && b.start >= iv.end && b.start - iv.end <= NEAR);
    if (next) {
      const gap = (next.start - iv.end) / H;
      lines.push(`🌙 当直明けの${hm(next.start)}から${eventName(next)}（明けから${gap < 1 ? '1時間以内' : `約${Math.round(gap)}時間`}）`);
      penalty += gap < 3 ? 2 : 1;
    } else if (busy.some((b) => b.allDay && jstDate(b.start) === jstDate(iv.end))) {
      const a = busy.find((b) => b.allDay && jstDate(b.start) === jstDate(iv.end));
      lines.push(`🌙 当直明けの日に終日の${eventName(a)}`);
      penalty += 1;
    }
  }
  return { lines, penalty };
}
