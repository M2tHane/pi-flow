// codegraph CLI 封装（colbymchenry/codegraph 1.6.0 已核实：affected -j 输出 {changedFiles, affectedTests}；sync -q）。
// 只在主工作区使用（索引在 <root>/.codegraph）；不可用时返回 null，由调用方退回全量测试。
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

/** 受改动影响的测试文件；拿不到（未安装、未索引、出错、结果为空）返回 null */
export async function affectedTests(root: string, changed: string[]): Promise<string[] | null> {
  if (!codegraphIndexed(root) || !changed.length) return null;
  const r = await run(['affected', '-p', root, '-j', ...changed], root);
  if (r.code !== 0) return null;
  try {
    const j = JSON.parse(r.stdout) as { affectedTests?: unknown };
    const tests = Array.isArray(j.affectedTests) ? j.affectedTests.filter((x): x is string => typeof x === 'string') : [];
    return tests.length ? tests : null;
  } catch {
    return null;
  }
}

/** 合并后同步索引；失败忽略 */
export async function codegraphSync(root: string): Promise<void> {
  if (!codegraphIndexed(root)) return;
  await run(['sync', '-q', root], root);
}
