# my-dsh

DeepSeek Harness（DSH）的看板插件原型。它把会话按事项收拢，再加一个叫 my dsh 的助理：能回答问题，把活派给事项里的会话，跟进进度，有事要你处理时主动说。

## 现在能用的

0.0.1 是骨架：左栏多一个“看板”入口，看板页列出进行中的事项。事项存在 DSH 数据目录下的 my-dsh/matters.json（默认 ~/.dsh/my-dsh/）。

## 接下来要做的

- 看板页：上半是进行中的事项、已归档和按天的回顾，下半是和 my dsh 的对话。
- my dsh：一条配了插件工具的会话。它只读不改，改文件、跑命令都派给事项里的会话；会话要你处理、事项停滞和每天简报时主动说。
- 事项分大小：大事项按需开一条主对话来管它的会话，小事项只有看板。
- 会话自动归进事项。每个自动做的决定都写原因，能撤回。

## 安装开发版

需要 DSH 0.2.2-rc.1 或之后的 0.2.x。

```bash
npm install
npm run build
dsh plugin --profile <profile> add link:/path/to/my-dsh
```

重启这个 profile，左栏就有“看板”。建议先装进单独的 profile 试，不要直接装进日常用的那个。

## 开发

```bash
npm run check
```

依次跑类型检查、测试和打包。

## 许可

MIT
