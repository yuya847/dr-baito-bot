// 設定は環境変数から読む（Lambda では template.yaml の Parameters、手元では .env）。

/** LINE で名乗る名前（AI への指示にも使う） */
export const BOT_NAME = process.env.BOT_NAME || '医師バイト秘書';

export function loadConfig(env = process.env) {
  return {
    prefs: (env.PREFS ?? '13,14,12,11').split(',').map((s) => s.trim()).filter(Boolean).map(Number),
    maxPagesPerPref: Number(env.MAX_PAGES_PER_PREF ?? 8),
    requestDelayMs: Number(env.REQUEST_DELAY_MS ?? 3000),
  };
}
