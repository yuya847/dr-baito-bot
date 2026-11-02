// LINE の友だちと、Google を連携した本人とを結びつける6桁のコードを出す（10分有効）。
// 表示されたコードを、医師バイトBot の LINE に送る。使い方: node scripts/line-link.mjs
import { randomInt } from 'node:crypto';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { createDynamoStore } from '../src/lib/store.mjs';

const REGION = 'ap-northeast-1';
process.env.AWS_REGION ||= REGION;
const outs = (await new CloudFormationClient({ region: REGION }).send(new DescribeStacksCommand({ StackName: 'dr-baito-bot' }))).Stacks[0].Outputs;
const store = await createDynamoStore(outs.find((o) => o.OutputKey === 'TableName').OutputValue);
const code = String(randomInt(0, 1e6)).padStart(6, '0');
await store.putState('line:linkcode', { code, exp: Date.now() + 10 * 60_000 });
console.log(`連携コード: ${code}（10分有効）\nこの6桁を、医師バイトBot の LINE に送ってください。`);
const url = outs.find((o) => o.OutputKey === 'LineWebhookUrl')?.OutputValue;
if (url) console.log(`（Webhook URL: ${url}）`);
