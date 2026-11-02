import * as feed from './feed.mjs';

// 求人の取り込み口。巡回（tick.mjs）が2分おきに1ページずつ呼ぶ。
// 元の実装はここに求人サイトごとの取り込みを並べていた。この写しでは自社の求人データを読む feed だけを置く。
export const SITES = { feed };
