import { readFileSync } from 'node:fs';
import path from 'node:path';

export const TEMPLATE_YAML = readFileSync(path.join(import.meta.dirname, '../../templates/workflow.yaml'), 'utf8');

/** 模板已填入核实过的 serena、codegraph 工具名，测试直接使用；并发保持 2，测试中的调度顺序不随模板默认值变化 */
export const TEST_YAML = TEMPLATE_YAML.replace(/^  max_parallel: 3 .*$/m, '  max_parallel: 2');
