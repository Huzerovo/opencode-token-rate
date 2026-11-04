import { Plugin } from "@opencode/plugin/tui"
import { autoBucketMinutes, buildRecord, type ModelRef } from "./rate.ts"
import { TokenRateRpc } from "./rpc.ts"

interface LiveState {
  bySession: Record<string, { rate: number; average: number }>
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
    const samples = new Map<string, Array<{ at: number; output: number; generation: number }>>()
    let usageSequence = 0

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

    void refreshUsage()

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

      const recent = (samples.get(sessionID) ?? []).filter((sample) => sample.at >= record.at - 60_000)
      recent.push({
        at: record.at,
        output: record.tokens.output,
        generation: record.duration.generation,
      })
      samples.set(sessionID, recent)

      const output = recent.reduce((sum, sample) => sum + sample.output, 0)
      const generation = recent.reduce((sum, sample) => sum + sample.generation, 0)
      const average = generation > 0 ? (output * 1000) / generation : record.rate.output

      updateLive((draft) => {
        draft.bySession[sessionID] = { rate: record.rate.output, average }
      })
      void refreshUsage()
    })

    const removeSlot = context.ui.slot({
      append: "prompt.footer.status",
      render: ({ sessionID }) => {
        const value = sessionID ? live.bySession[sessionID] : undefined
        return value
          ? <text fg={context.theme.text.base}>{`${value.rate.toFixed(1)} tok/s · 1m ${value.average.toFixed(1)}`}</text>
          : null
      },
    })

    const removeSidebar = context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => {
        const value = sessionID ? live.bySession[sessionID] : undefined
        const usage = live.usage
        if (!value && !usage) return null

        return (
          <box flexDirection="column" border borderStyle="single" borderColor={context.theme.border.base} paddingX={1}>
            {value ? (
              <>
                <text fg={context.theme.text.muted}>Token rate</text>
                <text fg={context.theme.text.base}>{`${value.rate.toFixed(1)} tok/s · 1m ${value.average.toFixed(1)}`}</text>
              </>
            ) : null}
            {usage ? (
              <>
                <text fg={context.theme.text.muted}>Go usage</text>
                <text fg={context.theme.text.base}>{usageLine("rolling", usage.rolling)}</text>
                <text fg={context.theme.text.base}>{usageLine("weekly", usage.weekly)}</text>
                <text fg={context.theme.text.base}>{usageLine("monthly", usage.monthly)}</text>
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

function usageLine(label: string, meter: UsageMeterView): string {
  return `${label.padEnd(8)} ${progressBar(meter.percent)} ${meter.percent.toFixed(1).padStart(5)}%${meter.limited ? " LIMITED" : ""}`
}

function progressBar(percent: number): string {
  const value = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0
  const filled = Math.ceil(value / 10)
  return `${"█".repeat(filled)}${"░".repeat(10 - filled)}`
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
