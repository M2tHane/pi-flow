# pi-flow

把"个人开发一个中型项目"的工作流固化为 Pi 插件。开发中，完整说明见 M8。

> 逃生口：单文件、几十行以内的小改动，直接用 pi 更划算。

## 配置角色的模型与思考级别：`/flow-config`

在 Pi 中输入 `/flow-config`，选择"设置各角色的模型与思考级别"，依次选择角色、模型（列出你在 Pi 中已配置的可用模型）、思考级别（只列出该模型支持的级别）。设置保存在 `~/.pi/agent/pi-flow.json`，优先于项目 `workflow.yaml` 中的模型档位。

没有交互界面时（`pi -p`、JSON 模式）使用子命令：

```
/flow-config show                                   查看各角色当前设置及来源
/flow-config models                                 列出可用模型及支持的思考级别
/flow-config set reviewer Workbuddy/glm-5.3-flash high
/flow-config set scout default low                  模型用 workflow.yaml 默认，只改思考级别
/flow-config unset reviewer                         回到 workflow.yaml 默认
/flow-config unset all
```
