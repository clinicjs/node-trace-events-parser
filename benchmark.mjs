import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { Bench } from 'tinybench'
import parser from './index.js'

const eventCount = Number(process.env.EVENT_COUNT) || 10_000
const benchTime = Number(process.env.BENCH_TIME) || 1_000
const chunkSize = Number(process.env.CHUNK_SIZE) || 64 * 1024

function event (index, args) {
  return {
    pid: 1,
    tid: index % 4,
    ts: index * 1_000,
    ph: 'X',
    cat: 'node',
    name: 'benchmark',
    dur: 20,
    args
  }
}

function createInput (createArgs) {
  const events = Array.from({ length: eventCount }, (_, index) => event(index, createArgs(index)))
  return Buffer.from(JSON.stringify({ traceEvents: events }))
}

const inputs = {
  'common fields': createInput((index) => ({
    node: 'benchmark',
    executionAsyncId: index,
    triggerAsyncId: index - 1
  })),
  // Every fourth event carries nested args, like async_hooks events in real traces.
  'nested args': createInput((index) => index % 4 === 0
    ? { data: { executionAsyncId: index, triggerAsyncId: index - 1 } }
    : { node: 'benchmark' })
}

function * chunks (buffer, size) {
  for (let offset = 0; offset < buffer.length; offset += size) {
    yield buffer.subarray(offset, offset + size)
  }
}

async function parseWithStream (input) {
  let count = 0
  const sink = new Writable({
    objectMode: true,
    write (event, encoding, callback) {
      count++
      callback()
    }
  })

  await pipeline(
    Readable.from(chunks(input, chunkSize)),
    parser(),
    sink
  )

  if (count !== eventCount) throw new Error(`Parser emitted ${count} of ${eventCount} events`)
}

function parseWithJson (input) {
  let count = 0
  for (const event of JSON.parse(input).traceEvents) {
    if (event) count++
  }
  if (count !== eventCount) throw new Error(`JSON.parse returned ${count} of ${eventCount} events`)
}

function parseEventsIndividually (eventSources) {
  let count = 0
  for (const source of eventSources) {
    JSON.parse(source)
    count++
  }
  if (count !== eventCount) throw new Error(`JSON.parse returned ${count} of ${eventCount} events`)
}

const bench = new Bench({ name: 'Node.js trace event parsing', time: benchTime })
for (const [name, input] of Object.entries(inputs)) {
  const eventSources = JSON.parse(input).traceEvents.map((event) => JSON.stringify(event))
  console.log(`${name}: ${eventCount} events; input size: ${(input.length / 1024).toFixed(1)} KiB`)
  bench
    .add(`parser, ${name} (${chunkSize / 1024} KiB chunks)`, () => parseWithStream(input))
    .add(`JSON.parse per event, ${name}`, () => parseEventsIndividually(eventSources))
    .add(`JSON.parse, ${name} (whole document)`, () => parseWithJson(input))
}

await bench.run()
console.table(bench.table())
