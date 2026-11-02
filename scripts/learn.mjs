// 学びの確認と取り込み。
//   node scripts/learn.mjs                 … 覚えていること・返し方の反省を表示
//   node scripts/learn.mjs import <file>   … 別の会話の記録（dot との抜粋など）から学んで保存（--dry で保存せず表示だけ）
//   node scripts/learn.mjs relearn         … 保存済みの LINE の記録（直近30往復）をもう一度読み直して学ぶ
// 過去の操作依頼（応募・取消・メール送信など）は実行も記録もしない。
import { readFile } from 'node:fs/promises';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { createDynamoStore, createFileStore } from '../src/lib/store.mjs';
import { learnFromTranscript, learnFromTurn } from '../src/learn.mjs';
import { getMemory } from '../src/memory.mjs';

process.env.AWS_REGION ||= 'ap-northeast-1';
const [cmd, file] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const dry = process.argv.includes('--dry');
const outs = (await new CloudFormationClient({}).send(new DescribeStacksCommand({ StackName: 'dr-baito-bot' }))).Stacks[0].Outputs;
const out = (k) => outs.find((o) => o.OutputKey === k).OutputValue;
const cloud = await createDynamoStore(out('TableName'));
const store = dry ? createFileStore(new URL('../.data/learn-dry.json', import.meta.url).pathname) : cloud;
const secrets = JSON.parse((await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: out('SecretArn') }))).SecretString);

if (cmd === 'import') {
  const text = await readFile(file, 'utf8');
  const r = await learnFromTranscript({ apiKey: secrets.ANTHROPIC_API_KEY, store, text, src: 'dot' });
  console.log(`取り込み: 覚えたこと${r.facts}件・反省${r.lessons}件${dry ? '（--dry：保存していません）' : ''}`);
} else if (cmd === 'relearn') {
  const log = (await cloud.getState('assistant:log')) || [];
  for (let i = 0; i < log.length; i += 1) {
    if (log[i].cmd) continue;
    const r = await learnFromTurn({ apiKey: secrets.ANTHROPIC_API_KEY, store, turn: log[i], history: log.slice(0, i), now: log[i].at });
    if (r.facts || r.lessons) console.log(`「${log[i].user.slice(0, 30)}」→ ${r.facts}件・反省${r.lessons}件`);
  }
}

const { facts, lessons } = await getMemory(store);
console.log('\n覚えていること:');
for (const f of facts) console.log(`  [${f.kind}] ${f.subject ? `${f.subject}：` : ''}${f.text}${f.date ? `（${f.date}）` : ''}  ←${f.src}`);
console.log('\n返し方の反省:');
for (const l of lessons) console.log(`  ・${l.text}  ←${l.src}`);
