# token-rate

记录 OpenCode 每次模型请求的 token 速率，并在 TUI 状态栏、侧边栏和斜杠命令里查看。

## 记录什么

每次 `session.step.ended` 写一条 JSONL：

- `rate.output`：输出 token / 生成耗时（tok/s）。生成耗时从请求发出算到响应体结束。
- `rate.total`：全部 token（input + output + reasoning + cache read/write）/ 整步耗时（tok/s）。
- 同时保留 tokens、模型、agent、目录、结束原因和两个耗时，方便以后重新聚合。

只有成功完成的请求会记录；失败、被中断的请求不写入，避免重试导致重复计数。

## 安装

```sh
cd token-rate
npm install
```

在 `~/.config/opencode/opencode.jsonc` 的 `plugins` 中加入插件目录（绝对路径）：

```jsonc
{
  "plugins": [
    { "package": "/absolute/path/to/token-rate" }
  ]
}
```

也可以把整个目录放到项目的 `.opencode/plugins/token-rate/`，OpenCode 会自动加载。配置保存后 OpenCode 会自动重载，不需要重启。

数据默认写入：

```text
~/.local/share/opencode/token-rate/YYYY-MM-DD.jsonl
```

设置了 `XDG_DATA_HOME` 时使用 `$XDG_DATA_HOME/opencode/token-rate/`。也可以在插件配置里覆盖：

```jsonc
{
  "plugins": [
    {
      "package": "/absolute/path/to/token-rate",
      "options": { "directory": "/custom/data/dir" }
    }
  ]
}
```

## 使用

### 状态栏

当前会话每完成一次请求，`prompt.footer.status` 显示：

```text
30.0 tok/s · 1m 28.4
```

左边是最近一次请求的输出速率，右边是最近 60 秒按生成耗时加权的平均输出速率。

### 侧边栏

会话侧边栏也会显示当前会话速率和 Go 用量：

```text
Token rate
30.0 tok/s · 1m 28.4
Go usage
rolling  █░░░░░░░░░   4.0%
weekly   ██░░░░░░░░  14.0%
monthly  ████░░░░░░  36.0% LIMITED
```

整个区域带一圈实心边框，用量条目带 10 格进度条。

Go 用量在插件加载时和每次请求结束后刷新。没有 Console 登录或没有 Go 订阅时，侧边栏只显示速率。

### `/token-rate`

```text
/token-rate            # 最近 24 小时，每小时一行
/token-rate 30m
/token-rate 6h
/token-rate 7d
```

输出示例：

```text
Token rate · last 24h · 37 steps · output 31.4 tok/s · total 12.8 tok/s

Time             Steps Output tok/s  Total tok/s   Tokens
11-03 14:00          4         38.2         15.1     24.1k
11-03 15:00          7         29.5         11.4     18.7k
```

时间桶会根据查询范围自动选择（最多约 24 行），速率按桶内总 token / 总耗时加权。

### `/go-usage`

查询当前 OpenCode Console 工作区的 OpenCode Go 用量：

```text
Workspace: my-workspace

rolling    15.7%  ok      resets in 2h 5m
weekly     42.1%  ok      resets in 3d 4h
monthly    68.9%  ok      resets in 12d
```

该接口依赖 OpenCode Console 工作区登录。只配置了 `opencode-go` API key、没有 Console 登录时，命令会提示未登录，而不是报错。

## 数据文件

一行一条记录：

```json
{"at":1793713498545,"sessionID":"ses_...","messageID":"msg_...","agent":"plan","model":{"providerID":"opencode-go","id":"deepseek-v4.1-flash"},"directory":"/path","tokens":{"input":658,"output":142,"reasoning":0,"cache":{"read":91904,"write":0}},"finish":"tool-calls","duration":{"generation":1976,"total":1988},"rate":{"output":71.9,"total":46631.4}}
```

文件按本地日期切分，追加写入。多个 OpenCode 进程同时写同一个日文件时依赖操作系统追加写的原子性；一般单服务进程使用没有问题。

## 开发

```sh
npm test        # 速率计算、聚合和格式化
npm run typecheck
```

已知取舍：

- 插件热重载时正在进行的请求没有开始时间，会跳过该请求。
- 查询时会扫描数据目录下所有 JSONL 文件；历史很大时再迁移到 SQLite。
- `/go-usage` 使用 OpenCode 的 experimental usage 接口，接口变化时可能需要跟进。
