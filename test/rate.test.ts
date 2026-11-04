import assert from "node:assert/strict"
import test from "node:test"
import {
  aggregate,
  autoBucketMinutes,
  buildRecord,
  formatSummary,
  type RateRecord,
  type TokenUsage,
} from "../src/rate.ts"

const usage = (output: number): TokenUsage => ({
  input: 1000,
  output,
  reasoning: 0,
  cache: { read: 2000, write: 0 },
})

function makeRecord(
  endedAt: number,
  output: number,
  generation: number,
  total: number,
): RateRecord {
  return buildRecord({
    endedAt,
    startedAt: endedAt - total,
    streamedAt: endedAt - (total - generation),
    sessionID: "ses_test",
    messageID: `msg_${endedAt}`,
    agent: "build",
    model: { providerID: "opencode", id: "test" },
    tokens: usage(output),
    finish: "stop",
  })
}

test("buildRecord separates generation from total duration", () => {
  const record = buildRecord({
    endedAt: 10_000,
    startedAt: 0,
    streamedAt: 8_000,
    sessionID: "ses_test",
    messageID: "msg_test",
    agent: "build",
    model: { providerID: "opencode", id: "test" },
    tokens: usage(100),
    finish: "stop",
  })

  assert.equal(record.duration.generation, 8_000)
  assert.equal(record.duration.total, 10_000)
  assert.equal(record.rate.output, 12.5)
  assert.equal(record.rate.total, 310)
})

test("buildRecord falls back to the completed time and never divides by zero", () => {
  const record = buildRecord({
    endedAt: 500,
    startedAt: 500,
    sessionID: "ses_test",
    messageID: "msg_test",
    agent: "build",
    model: { providerID: "opencode", id: "test" },
    tokens: usage(0),
    finish: "stop",
  })

  assert.equal(record.duration.generation, 1)
  assert.equal(record.duration.total, 1)
  assert.ok(Number.isFinite(record.rate.output))
})

test("aggregate sums tokens and durations per bucket", () => {
  const first = makeRecord(10_000, 100, 2_000, 4_000)
  const second = makeRecord(20_000, 50, 4_000, 8_000)
  const buckets = aggregate([first, second], 60_000)

  assert.equal(buckets.length, 1)
  assert.equal(buckets[0].steps, 2)
  assert.equal(buckets[0].output, 150)
  assert.equal(buckets[0].tokens, 6150)
  assert.equal(buckets[0].generation, 6_000)
  assert.equal(buckets[0].total, 12_000)
})

test("formatSummary reports weighted averages and no-data state", () => {
  const records = [makeRecord(10_000, 100, 2_000, 4_000), makeRecord(20_000, 50, 4_000, 8_000)]
  const text = formatSummary(records, { hours: 24, bucketMinutes: 60, now: 30_000 })

  assert.match(text, /2 steps/)
  assert.match(text, /output 25\.0 tok\/s/)
  assert.match(text, /total 512\.5 tok\/s/)
  assert.match(text, /Output tok\/s/)
  assert.match(text, /6\.2k/)

  assert.match(formatSummary([], { hours: 24, bucketMinutes: 60 }), /No completed model steps/)
})

test("autoBucketMinutes keeps the table near 24 rows", () => {
  assert.equal(autoBucketMinutes(0.5), 5)
  assert.equal(autoBucketMinutes(24), 60)
  assert.equal(autoBucketMinutes(24 * 7), 720)
})
