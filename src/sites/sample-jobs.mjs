// 動きを確かめるための架空の求人（施設名・住所・金額はすべて作り物）。日付は今日から数えて決める。
const jstDate = (now, plusDays) => new Date(now.getTime() + 9 * 3600e3 + plusDays * 86400e3).toISOString().slice(0, 10);

export function sampleJobs(now = new Date()) {
  return [
    { id: 'S1001', url: 'https://jobs.example.com/jobs/S1001', title: '内科外来（午前）', facility: 'みなと内科クリニック', date: jstDate(now, 3),
      timeText: '09:00-12:00', payText: '一回 45,000円', address: '東京都港区芝5-1-1', departmentsText: '内科', workOutline: '外来・健診結果説明', note: '交通費: 全額支給' },
    { id: 'S1002', url: 'https://jobs.example.com/jobs/S1002', title: '予防接種', facility: 'さくら小児科', date: jstDate(now, 5),
      timeText: '18:00-20:00', payText: '時給 15,000円', address: '東京都世田谷区三軒茶屋2-1-1', departmentsText: '小児科、内科', workOutline: '予防接種・問診' },
    { id: 'S1003', url: 'https://jobs.example.com/jobs/S1003', title: '当直（寝当直）', facility: 'みどり台病院', date: jstDate(now, 7),
      timeText: '17:00-翌09:00', payText: '一回 70,000円', address: '神奈川県横浜市港北区新横浜1-1-1', departmentsText: '内科', workOutline: '病棟当直・救急車なし', note: '仮眠室あり' },
    { id: 'S1004', url: 'https://jobs.example.com/jobs/S1004', title: '健診', facility: 'ひまわり健診センター', date: jstDate(now, 9),
      timeText: '08:30-12:30', payText: '時給 12,000円', hours: 4, address: '千葉県船橋市本町1-1-1', departmentsText: '健診', workOutline: '健診（診察・問診）' },
  ];
}
