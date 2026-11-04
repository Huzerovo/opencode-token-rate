# opencode-token-rate

记录 OpenCode 每次模型请求的 token 速率，并在 TUI 状态栏、侧边栏和斜杠命令中查看。也支持查询 OpenCode Go 订阅用量。

## 安装

从 GitHub 通过 git 安装：

```sh
opencode plugin add git+https://github.com/Huzerovo/opencode-token-rate.git
```

安装后 OpenCode 会自动加载。该命令会安装插件并写入全局 OpenCode 配置；如果侧边栏没有出现，运行：

```sh
opencode service restart
```

## 使用

- 状态栏：显示本次、最近 30 次和本会话平均输出速率。
- 侧边栏：显示当前会话速率、全局速率（最近 30 次和全部记录）、分模型 token 用量和 Go 用量。
- `/token-rate [30m|6h|24h|7d]`：查看历史速率汇总，默认最近 24 小时。
- `/go-usage`：查看当前 OpenCode Console 工作区的 Go 用量。

速率按模型生成耗时加权；`1m` / `10m` / `30m` / `1h` / `1d` 只计算会话实际生成时间，不包含空闲等待。

## 注意事项

- `/go-usage` 和侧边栏的 Go 用量需要登录 OpenCode Console 工作区。只配置 `opencode-go` API key 时接口会返回空数据，命令会提示未登录。
- 数据默认写入 `~/.local/share/opencode/token-rate/YYYY-MM-DD.jsonl`。设置了 `XDG_DATA_HOME` 时写入 `$XDG_DATA_HOME/opencode/token-rate/`。
- 全局速率统计同一数据目录下所有项目的记录；不同项目使用不同数据目录时不会合并。
- 只记录成功完成的模型请求；失败或被中断的请求不会写入。
- 查询时会扫描数据目录下的 JSONL 文件，历史很大时性能会下降。
- 插件热重载时正在进行的请求没有开始时间，会被跳过。
- Go 用量使用 OpenCode 的 experimental usage 接口，接口变化时可能需要更新插件。

## 开发

```sh
npm install
npm test
npm run typecheck
```
