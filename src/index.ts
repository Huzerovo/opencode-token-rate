import { appendFile, mkdir, readFile, readdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Plugin } from "@opencode/plugin"
import { TokenRateRpc } from "./rpc.ts"
import {
  averageRates,
  buildRecord,
  formatSummary,
  type ModelRef,
  type RateRecord,
} from "./rate.ts"

const EVENT_TYPES = [
  "session.step.started",
  "session.step.streamed",
  "session.step.ended",
  "session.step.failed",
] as const

export default Plugin.define({
  id: "token-rate",
  async setup(ctx) {
    const directory = dataDirectory(ctx)
    await mkdir(directory, { recursive: true })

    const pending = new Map<
      string,
      {
        startedAt: number
        streamedAt?: number
        agent: string
        model: ModelRef
        directory?: string
      }
    >()
    const controller = new AbortController()
    let writes = Promise.resolve()

    const persist = (record: RateRecord) => {
      const file = path.join(directory, `${dayStamp(record.at)}.jsonl`)
      writes = writes
        .then(() => appendFile(file, `${JSON.stringify(record)}\n`, "utf8"))
        .catch((error) => console.error(`[token-rate] failed to write ${file}`, error))
    }

    const consume = async () => {
      for await (const event of ctx.event.subscribe({
        types: EVENT_TYPES,
        signal: controller.signal,
      })) {
        const { sessionID, assistantMessageID } = event.data
        const key = `${sessionID}:${assistantMessageID}`

        if (event.type === "session.step.started") {
          pending.set(key, {
            startedAt: event.created,
            agent: event.data.agent,
            model: event.data.model,
            directory: event.location?.directory,
          })
          continue
        }

        if (event.type === "session.step.streamed") {
          const entry = pending.get(key)
          if (entry) entry.streamedAt = event.created
          continue
        }

        if (event.type === "session.step.failed") {
          pending.delete(key)
          continue
        }

        const entry = pending.get(key)
        pending.delete(key)
        // shortcut: a step already running when the plugin reloads has no start time, so it is skipped.
        if (!entry) continue

        persist(
          buildRecord({
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
          }),
        )
      }
    }

    consume().catch((error) => {
      if (!controller.signal.aborted) console.error("[token-rate] event stream failed", error)
    })

    const registration = await ctx.rpc.register(TokenRateRpc, {
      summary: async (input) => {
        const query = (input ?? {}) as { hours?: unknown; bucketMinutes?: unknown }
        const hours = positive(query.hours, 24)
        const bucketMinutes = positive(query.bucketMinutes, 60)
        // shortcut: every summary scans all JSONL files; move to SQLite when history grows large.
        await writes
        const records = await readRecords(directory)
        return {
          text: formatSummary(records, { hours, bucketMinutes, now: Date.now() }),
        }
      },
      averages: async () => {
        // shortcut: averages scans all JSONL after every step; move to SQLite or in-memory aggregates when history grows.
        await writes
        return averageRates(await readRecords(directory))
      },
    })

    return async () => {
      controller.abort()
      await registration.dispose()
      await writes
    }
  },
})

function dataDirectory(ctx: {
  options: Readonly<Record<string, unknown>>
  location: { directory: string }
}): string {
  const configured = ctx.options.directory
  if (typeof configured === "string" && configured.length > 0) {
    return path.resolve(ctx.location.directory, configured)
  }
  const root = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share")
  return path.join(root, "opencode", "token-rate")
}

async function readRecords(directory: string): Promise<RateRecord[]> {
  let names: string[]
  try {
    names = await readdir(directory)
  } catch {
    return []
  }

  const records: RateRecord[] = []
  for (const name of names.filter((item) => item.endsWith(".jsonl")).sort()) {
    let text: string
    try {
      text = await readFile(path.join(directory, name), "utf8")
    } catch {
      continue
    }
    for (const line of text.split("\n")) {
      const record = parseRecord(line)
      if (record) records.push(record)
    }
  }
  return records
}

function parseRecord(line: string): RateRecord | undefined {
  if (!line.trim()) return
  try {
    const value = JSON.parse(line) as Partial<RateRecord>
    const tokens = value.tokens
    const duration = value.duration
    if (
      typeof value.at !== "number" ||
      !Number.isFinite(value.at) ||
      !tokens ||
      typeof tokens.input !== "number" ||
      typeof tokens.output !== "number" ||
      typeof tokens.reasoning !== "number" ||
      !tokens.cache ||
      typeof tokens.cache.read !== "number" ||
      typeof tokens.cache.write !== "number" ||
      !duration ||
      typeof duration.generation !== "number" ||
      typeof duration.total !== "number"
    ) {
      return
    }
    return value as RateRecord
  } catch {
    return
  }
}

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback
}

function dayStamp(value: number): string {
  const date = new Date(value)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function pad(value: number): string {
  return String(value).padStart(2, "0")
}
