// 从 src/core/schemas.ts 生成 schemas/*.schema.json，供外部工具与文档使用。
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { SCHEMAS } from '../src/core/schemas.ts';

const outDir = path.join(import.meta.dirname, '..', 'schemas');
for (const [name, schema] of Object.entries(SCHEMAS)) {
  const doc = { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: `pi-flow/${name}.schema.json`, ...JSON.parse(JSON.stringify(schema)) };
  writeFileSync(path.join(outDir, `${name}.schema.json`), `${JSON.stringify(doc, null, 2)}\n`);
}
console.log(`已生成 ${Object.keys(SCHEMAS).length} 个 schema 到 ${outDir}`);
