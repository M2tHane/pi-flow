// 崩溃测试用的引擎进程：在独立的 node 进程中运行引擎（真实 pi 子进程），由测试 SIGKILL。
// 用法：node crash-driver.ts <项目目录> <角色设置 JSON>
import path from 'node:path';
import { Engine } from '../../src/core/dispatcher.ts';
import { StateStore } from '../../src/core/state-store.ts';
import { loadConfig } from '../../src/core/config.ts';
import { PiLauncher } from '../../src/pi-adapter/launcher.ts';

const [dir, settingsJson] = process.argv.slice(2);
const ROOT = path.join(import.meta.dirname, '../..');
const config = loadConfig(path.join(dir!, 'workflow.yaml'));
const store = new StateStore(dir!, { limits: config.limits });
const engine = new Engine({
  root: dir!, store, config, launcher: new PiLauncher(),
  roleSettings: () => JSON.parse(settingsJson!),
  packageAgentsDir: [path.join(ROOT, 'agents'), path.join(ROOT, 'test/fixtures/agents')].join(path.delimiter),
  subagentExtension: path.join(ROOT, 'src/pi-adapter/subagent.ts'),
  extraExtensions: () => [path.join(ROOT, 'test/fixtures/fake-llm/provider.ts')],
  onError: (e) => process.stderr.write(`engine error: ${String(e)}\n`),
});
const flow = store.readState().active_flow!;
await engine.next(flow);
process.stdout.write('dispatched\n');
setInterval(() => {}, 1 << 30);
