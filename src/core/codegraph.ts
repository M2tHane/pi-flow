// codegraph CLI 封装（colbymchenry/codegraph 1.6.0 已核实：sync -q）。
// 只在主工作区使用（索引在 <root>/.codegraph）。第五轮起合并时一律跑全量测试，不再用 affected 选测试。
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const BIN = () => process.env['PI_FLOW_CODEGRAPH_BIN'] ?? 'codegraph';

function run(args: string[], cwd: string, timeoutMs = 120_000): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(BIN(), args, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      resolve({ code: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0, stdout: String(stdout) });
    });
  });
}

export const codegraphIndexed = (root: string) => existsSync(path.join(root, '.codegraph'));

/** 合并后同步索引；失败忽略 */
export async function codegraphSync(root: string): Promise<void> {
  if (!codegraphIndexed(root)) return;
  await run(['sync', '-q', root], root);
}
