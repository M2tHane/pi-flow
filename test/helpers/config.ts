import { readFileSync } from 'node:fs';
import path from 'node:path';

export const TEMPLATE_YAML = readFileSync(path.join(import.meta.dirname, '../../templates/workflow.yaml'), 'utf8');

/** 模板已填入核实过的 serena、codegraph 工具名，测试直接使用；并发保持 2，测试中的调度顺序不随模板默认值变化 */
/** 自动派发关闭：测试显式调用 engine.next，派发顺序可控；自动派发有单独的测试 */
/** 逐任务审查开启、阶段末审查关闭：大量测试依赖"提交 → 审查 → 验证 → 合并"的旧路径；直接合并有单独的测试（DIRECT_YAML） */
export const TEST_YAML = TEMPLATE_YAML.replace(/^  max_parallel: 3 .*$/m, '  max_parallel: 2').replace(/^  auto_dispatch: true .*$/m, '  auto_dispatch: false')
  .replace(/^  per_task: false .*$/m, '  per_task: true').replace(/^  stage_end: true .*$/m, '  stage_end: false');
