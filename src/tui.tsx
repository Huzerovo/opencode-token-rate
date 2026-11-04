import { Plugin } from "@opencode/plugin/tui"
import {
  autoBucketMinutes,
  buildRecord,
  formatTokens,
  RATE_WINDOWS,
  type ModelRef,
  type ModelUsage,
  type RateAverages,
} from "./rate.ts"
import { TokenRateRpc } from "./rpc.ts"

const BAR_FILLED = "━".repeat(200)
const BAR_EMPTY = "─".repeat(200)
const RULE = "─".repeat(200)

interface LiveState {
  bySession: Record<string, number>
  averages?: RateAverages
  usage: UsageView | null
}

interface UsageMeterView {
  percent: number
  limited: boolean
}

interface UsageView {
  rolling: UsageMeterView
  weekly: UsageMeterView
  monthly: UsageMeterView
}

interface Meter {
  percent: number
  limited: boolean
  resetsAt: number
}

interface PendingStep {
  startedAt: number
  streamedAt?: number
  agent: string
  model: ModelRef
  directory?: string
}

export default Plugin.define({
  id: "token-rate.tui",
  setup(context) {
    const [live, updateLive] = context.storage.memory<LiveState>("live", {
      initial: { bySession: {}, usage: null },
    })
    const pending = new Map<string, PendingStep>()
    let usageSequence = 0
    let averagesSequence = 0

    const stopStarted = context.data.on("session.step.started", (event) => {
      pending.set(`${event.data.sessionID}:${event.data.assistantMessageID}`, {
        startedAt: event.created,
        agent: event.data.agent,
        model: event.data.model,
        directory: event.location?.directory,
      })
    })

    const stopStreamed = context.data.on("session.step.streamed", (event) => {
      const entry = pending.get(`${event.data.sessionID}:${event.data.assistantMessageID}`)
      if (entry) entry.streamedAt = event.created
    })

    const stopFailed = context.data.on("session.step.failed", (event) => {
      pending.delete(`${event.data.sessionID}:${event.data.assistantMessageID}`)
    })

    const refreshUsage = async () => {
      const sequence = ++usageSequence
      try {
        const response = await context.client.experimental.usage.limits({
          location: context.location ?? context.data.location.default(),
        })
        if (sequence !== usageSequence) return
        const go = response.data?.go
        updateLive((draft) => {
          draft.usage = go
            ? {
                rolling: { percent: go.rolling.percent, limited: go.rolling.limited },
                weekly: { percent: go.weekly.percent, limited: go.weekly.limited },
                monthly: { percent: go.monthly.percent, limited: go.monthly.limited },
              }
            : null
        })
      } catch {
        // Keep the last known usage; /go-usage surfaces errors when the user asks for them.
      }
    }

    const refreshAverages = async () => {
      const sequence = ++averagesSequence
      try {
        const result = (await context.client.rpc(TokenRateRpc).averages({})) as RateAverages
        if (sequence !== averagesSequence) return
        updateLive((draft) => {
          draft.averages = result
        })
      } catch {
        // Keep the last known rates; /token-rate surfaces errors when the user asks for them.
      }
    }

    void refreshUsage()
    void refreshAverages()

    const stopEnded = context.data.on("session.step.ended", (event) => {
      const { sessionID, assistantMessageID } = event.data
      const key = `${sessionID}:${assistantMessageID}`
      const entry = pending.get(key)
      pending.delete(key)
      if (!entry) return

      const record = buildRecord({
        endedAt: event.created,
        startedAt: entry.startedAt,
        streamedAt: entry.streamedAt,
        sessionID,
        messageID: assistantMessageID,
        agent: entry.agent,
        model: entry.model,
        directory: event.location?.directory ?? entry.directory,
        tokens: event.data.tokens,
        finish: event.data.finish,
      })

      updateLive((draft) => {
        draft.bySession[sessionID] = record.rate.output
      })
      void refreshUsage()
      void refreshAverages()
    })

    const section = (title: string, tone: "faint" | "muted") => (
      <box flexDirection="row">
        <text fg={context.theme.text[tone]}>{`${title} `}</text>
        <box flexGrow={1} flexBasis={0} minWidth={0}>
          <text wrapMode="none" fg={context.theme.border.base}>{RULE}</text>
        </box>
      </box>
    )

    const UsageRow = (props: { label: string; meter: UsageMeterView }) => {
      const parts = usageParts(props.meter.percent)
      const stage = props.meter.limited ? "error" : parts.stage
      const filled = Math.max(parts.percent, 0.01)
      const empty = Math.max(100 - parts.percent, 0.01)
      const right = parts.percent >= 100 ? "LIMIT" : `${parts.percent.toFixed(1)}%`
      return (
        <box flexDirection="row">
          <text width={9} fg={context.theme.text.base}>{props.label}</text>
          <box flexGrow={1} flexDirection="row">
            <box flexGrow={filled} flexBasis={0} minWidth={parts.percent > 0 ? 1 : 0}>
              <text wrapMode="none" fg={context.theme.text.feedback[stage].base}>{BAR_FILLED}</text>
            </box>
            <box flexGrow={empty} flexBasis={0} minWidth={0}>
              <text wrapMode="none" fg={context.theme.text.faint}>{BAR_EMPTY}</text>
            </box>
          </box>
          <text width={7} textAlign="right" fg={context.theme.text.base}>{right}</text>
        </box>
      )
    }

    const rateRow = (label: string, value: number | undefined) => (
      <box flexDirection="row" justifyContent="space-between">
        <text fg={context.theme.text.base}>{label}</text>
        <text fg={context.theme.text.base}>{value === undefined ? "—" : `${value.toFixed(1)} tok/s`}</text>
      </box>
    )

    const modelRow = (usage: ModelUsage) => {
      const name = usage.model.length > 19 ? `${usage.model.slice(0, 18)}…` : usage.model
      return (
        <box flexDirection="row" justifyContent="space-between">
          <text fg={context.theme.text.base}>{name}</text>
          <text fg={context.theme.text.base}>{formatTokens(usage.tokens)}</text>
        </box>
      )
    }

    const removeSlot = context.ui.slot({
      append: "prompt.footer.status",
      render: ({ sessionID }) => {
        const value = sessionID ? live.bySession[sessionID] : undefined
        const stats = sessionID ? live.averages?.sessions[sessionID] : undefined
        return value === undefined
          ? null
          : <text fg={context.theme.text.base}>{`${value.toFixed(1)} tok/s · 30c ${fixed(stats?.recent30)} · ses ${fixed(stats?.session)}`}</text>
      },
    })

    const removeSidebar = context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => {
        const value = sessionID ? live.bySession[sessionID] : undefined
        const stats = sessionID ? live.averages?.sessions[sessionID] : undefined
        const usage = live.usage
        if (value === undefined && !stats && !usage) return null

        return (
          <box flexDirection="column" border borderStyle="single" borderColor={context.theme.text.faint} paddingX={1}>
            {value !== undefined || stats ? (
              <>
                <text fg={context.theme.text.muted}>Token rate</text>
                {section("By calls", "faint")}
                {rateRow("now", value)}
                {rateRow("30c", stats?.recent30)}
                {rateRow("session", stats?.session)}
                {section("By active time", "faint")}
                {RATE_WINDOWS.map(({ key }) => rateRow(key, stats?.windows[key]))}
              </>
            ) : null}
            {stats && stats.models.length > 0 ? (
              <>
                {section("Models", "muted")}
                {stats.models.slice(0, 5).map((model) => modelRow(model))}
                {stats.models.length > 5 ? (
                  <text fg={context.theme.text.faint}>{`+${stats.models.length - 5} more`}</text>
                ) : null}
              </>
            ) : null}
            {usage ? (
              <>
                {section("Go usage", "muted")}
                <UsageRow label="rolling" meter={usage.rolling} />
                <UsageRow label="weekly" meter={usage.weekly} />
                <UsageRow label="monthly" meter={usage.monthly} />
              </>
            ) : null}
          </box>
        )
      },
    })

    const summary = async (input?: string) => {
      const span = parseSpan(input)
      if ("error" in span) {
        await context.ui.dialog.alert({ title: "Token rate", message: span.error })
        return
      }

      try {
        const result = await context.client.rpc(TokenRateRpc).summary({
          hours: span.hours,
          bucketMinutes: autoBucketMinutes(span.hours),
        })
        const text = (result as { text?: unknown }).text
        await context.ui.dialog.alert({
          title: "Token rate",
          message: typeof text === "string" ? text : "No data.",
        })
      } catch (error) {
        context.ui.toast.show({
          title: "Token rate",
          message: error instanceof Error ? error.message : String(error),
          variant: "error",
        })
      }
    }

    const goUsage = async () => {
      try {
        const location = context.location ?? context.data.location.default()
        const response = await context.client.experimental.usage.limits({ location })
        const data = response.data
        if (!data) {
          await context.ui.dialog.alert({
            title: "OpenCode Go usage",
            message: "OpenCode Console is not signed in for this location. Sign in to Console to read Go usage.",
          })
          return
        }

        const name = data.workspace.name ?? data.workspace.id
        if (!data.go) {
          await context.ui.dialog.alert({
            title: "OpenCode Go usage",
            message: `Workspace: ${name}\n\nNo OpenCode Go subscription in this workspace.`,
          })
          return
        }

        const message = [
          `Workspace: ${name}`,
          "",
          meterLine("rolling", data.go.rolling),
          meterLine("weekly", data.go.weekly),
          meterLine("monthly", data.go.monthly),
          "",
          data.workspace.usageURL,
        ].join("\n")

        await context.ui.dialog.alert({ title: "OpenCode Go usage", message })
      } catch (error) {
        context.ui.toast.show({
          title: "OpenCode Go usage",
          message: error instanceof Error ? error.message : String(error),
          variant: "error",
        })
      }
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "token-rate.summary",
          title: "Token rate summary",
          group: "Token rate",
          palette: true,
          slash: { name: "token-rate", arguments: true },
          run: summary,
        },
        {
          id: "token-rate.go-usage",
          title: "OpenCode Go usage",
          group: "Token rate",
          palette: true,
          slash: { name: "go-usage" },
          run: goUsage,
        },
      ],
    }))

    return () => {
      stopStarted()
      stopStreamed()
      stopFailed()
      stopEnded()
      removeSlot()
      removeSidebar()
    }
  },
})

function parseSpan(input: string | undefined): { hours: number } | { error: string } {
  const value = input?.trim()
  if (!value) return { hours: 24 }

  const match = /^(\d+(?:\.\d+)?)\s*([mhd])$/i.exec(value)
  if (!match) return { error: "Usage: /token-rate [30m|6h|24h|7d]" }

  const amount = Number(match[1])
  if (!(amount > 0)) return { error: "Usage: /token-rate [30m|6h|24h|7d]" }

  const unit = match[2].toLowerCase()
  return { hours: unit === "m" ? amount / 60 : unit === "h" ? amount : amount * 24 }
}

function fixed(value: number | undefined): string {
  return value === undefined ? "—" : value.toFixed(1)
}

function usageParts(percent: number): {
  percent: number
  stage: "success" | "warning" | "error"
} {
  const value = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0
  return {
    percent: value,
    stage: value >= 90 ? "error" : value >= 70 ? "warning" : "success",
  }
}

function meterLine(label: string, meter: Meter): string {
  return `${label.padEnd(9)} ${meter.percent.toFixed(1).padStart(5)}%  ${(meter.limited ? "LIMITED" : "ok").padEnd(7)} resets in ${until(meter.resetsAt)}`
}

function until(timestamp: number, now = Date.now()): string {
  const ms = timestamp - now
  if (!Number.isFinite(ms) || ms <= 0) return "now"

  const minutes = Math.ceil(ms / 60_000)
  if (minutes < 60) return `${minutes}m`

  const hours = Math.floor(minutes / 60)
  if (hours < 48) {
    const rest = minutes % 60
    return rest ? `${hours}h ${rest}m` : `${hours}h`
  }

  const days = Math.floor(hours / 24)
  const rest = hours % 24
  return rest ? `${days}d ${rest}h` : `${days}d`
}
