export interface TokenUsage {
  input: number
  output: number
  reasoning: number
  cache: {
    read: number
    write: number
  }
}

export interface ModelRef {
  providerID: string
  id: string
  variant?: string
}

export interface RateRecord {
  at: number
  sessionID: string
  messageID: string
  agent: string
  model: ModelRef
  directory?: string
  tokens: TokenUsage
  finish: string
  duration: {
    generation: number
    total: number
  }
  rate: {
    output: number
    total: number
  }
}

export interface BuildRecordInput {
  endedAt: number
  startedAt: number
  streamedAt?: number
  sessionID: string
  messageID: string
  agent: string
  model: ModelRef
  directory?: string
  tokens: TokenUsage
  finish: string
}

export interface Bucket {
  start: number
  steps: number
  output: number
  tokens: number
  generation: number
  total: number
}

export interface SummaryOptions {
  hours: number
  bucketMinutes: number
  now?: number
}

export const RATE_WINDOWS = [
  { key: "1m", minutes: 1 },
  { key: "10m", minutes: 10 },
  { key: "30m", minutes: 30 },
  { key: "1h", minutes: 60 },
  { key: "1d", minutes: 1440 },
] as const

export type RateWindowKey = (typeof RATE_WINDOWS)[number]["key"]

export interface ModelUsage {
  model: string
  tokens: number
  steps: number
}

export interface SessionAverages {
  recent30: number
  session: number
  windows: Record<RateWindowKey, number>
  models: ModelUsage[]
}

export interface RateAverages {
  sessions: Record<string, SessionAverages>
}

const BUCKETS = [1, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440]
const MINUTE = 60_000

export function totalTokens(tokens: TokenUsage): number {
  return (
    tokens.input +
    tokens.output +
    tokens.reasoning +
    tokens.cache.read +
    tokens.cache.write
  )
}

export function buildRecord(input: BuildRecordInput): RateRecord {
  const generation = Math.max(1, (input.streamedAt ?? input.endedAt) - input.startedAt)
  const total = Math.max(1, input.endedAt - input.startedAt)

  return {
    at: input.endedAt,
    sessionID: input.sessionID,
    messageID: input.messageID,
    agent: input.agent,
    model: input.model,
    directory: input.directory,
    tokens: input.tokens,
    finish: input.finish,
    duration: { generation, total },
    rate: {
      output: (input.tokens.output * 1000) / generation,
      total: (totalTokens(input.tokens) * 1000) / total,
    },
  }
}

export function aggregate(records: readonly RateRecord[], bucketMs: number): Bucket[] {
  const size = Math.max(1, bucketMs)
  const buckets = new Map<number, Bucket>()

  for (const record of records) {
    const start = Math.floor(record.at / size) * size
    let bucket = buckets.get(start)
    if (!bucket) {
      bucket = { start, steps: 0, output: 0, tokens: 0, generation: 0, total: 0 }
      buckets.set(start, bucket)
    }
    bucket.steps += 1
    bucket.output += record.tokens.output
    bucket.tokens += totalTokens(record.tokens)
    bucket.generation += record.duration.generation
    bucket.total += record.duration.total
  }

  return [...buckets.values()].sort((a, b) => a.start - b.start)
}

export function autoBucketMinutes(hours: number): number {
  const target = (hours * 60) / 24
  return BUCKETS.find((bucket) => bucket >= target) ?? BUCKETS[BUCKETS.length - 1]
}

export function averageRates(records: readonly RateRecord[]): RateAverages {
  const bySession = new Map<string, RateRecord[]>()
  for (const record of records) {
    const list = bySession.get(record.sessionID) ?? []
    list.push(record)
    bySession.set(record.sessionID, list)
  }

  const sessions: Record<string, SessionAverages> = {}
  for (const [sessionID, list] of bySession) {
    list.sort((a, b) => a.at - b.at)
    const windows = {} as Record<RateWindowKey, number>
    for (const { key, minutes } of RATE_WINDOWS) {
      windows[key] = activeWindowRate(list, minutes)
    }
    sessions[sessionID] = {
      recent30: outputRate(list.slice(-30)),
      session: outputRate(list),
      windows,
      models: modelUsages(list),
    }
  }

  return { sessions }
}

function outputRate(records: readonly RateRecord[]): number {
  let output = 0
  let generation = 0
  for (const record of records) {
    output += record.tokens.output
    generation += record.duration.generation
  }
  return generation > 0 ? (output * 1000) / generation : 0
}

function activeWindowRate(records: readonly RateRecord[], minutes: number): number {
  const limit = minutes * MINUTE
  let output = 0
  let generation = 0
  // shortcut: the step that crosses the limit is counted whole, so a window can exceed its limit by one step.
  for (let i = records.length - 1; i >= 0; i--) {
    output += records[i].tokens.output
    generation += records[i].duration.generation
    if (generation >= limit) break
  }
  return generation > 0 ? (output * 1000) / generation : 0
}

function modelUsages(records: readonly RateRecord[]): ModelUsage[] {
  const models = new Map<string, ModelUsage>()
  for (const record of records) {
    const key = `${record.model.providerID}/${record.model.id}`
    const usage = models.get(key) ?? { model: record.model.id, tokens: 0, steps: 0 }
    usage.tokens += totalTokens(record.tokens)
    usage.steps += 1
    models.set(key, usage)
  }
  return [...models.values()].sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model))
}

export function formatSummary(records: readonly RateRecord[], options: SummaryOptions): string {
  const now = options.now ?? Date.now()
  const cutoff = now - options.hours * 60 * MINUTE
  const selected = records.filter((record) => record.at >= cutoff)
  const window = `last ${formatWindow(options.hours)}`

  if (selected.length === 0) {
    return `Token rate · ${window}\n\nNo completed model steps recorded yet.`
  }

  const output = selected.reduce((sum, record) => sum + record.tokens.output, 0)
  const tokens = selected.reduce((sum, record) => sum + totalTokens(record.tokens), 0)
  const generation = selected.reduce((sum, record) => sum + record.duration.generation, 0)
  const total = selected.reduce((sum, record) => sum + record.duration.total, 0)
  const steps = selected.length
  const buckets = aggregate(selected, options.bucketMinutes * MINUTE)

  const lines = [
    `Token rate · ${window} · ${steps} step${steps === 1 ? "" : "s"} · output ${rate(output, generation)} tok/s · total ${rate(tokens, total)} tok/s`,
    "",
    `${"Time".padEnd(16)}${"Steps".padStart(6)}${"Output tok/s".padStart(13)}${"Total tok/s".padStart(13)}${"Tokens".padStart(9)}`,
  ]

  for (const bucket of buckets) {
    lines.push(
      `${timeLabel(bucket.start).padEnd(16)}${String(bucket.steps).padStart(6)}${rate(bucket.output, bucket.generation).padStart(13)}${rate(bucket.tokens, bucket.total).padStart(13)}${formatTokens(bucket.tokens).padStart(9)}`,
    )
  }

  return lines.join("\n")
}

function rate(tokens: number, duration: number): string {
  return duration > 0 ? ((tokens * 1000) / duration).toFixed(1) : "0.0"
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(Math.round(value))
}

function formatWindow(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}m`
  if (hours % 24 === 0 && hours !== 24) return `${hours / 24}d`
  return `${hours}h`
}

function timeLabel(value: number): string {
  const date = new Date(value)
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function pad(value: number): string {
  return String(value).padStart(2, "0")
}
