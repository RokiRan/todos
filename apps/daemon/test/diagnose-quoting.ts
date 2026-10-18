import { quoteForCmd } from '../src/drivers/driver.js';

const spec =
  'Create a new file src/version.ts with exactly this content: ' +
  'export const bumpMajor = (v: string): string => { const [maj] = v.split("."); ' +
  'return String(Number(maj) + 1); };';

const q = quoteForCmd(spec);
console.log('原文双引号数:', (spec.match(/"/g) ?? []).length);
console.log('转义后双引号数:', (q.match(/"/g) ?? []).length);
console.log('转义结果:\n' + q);
