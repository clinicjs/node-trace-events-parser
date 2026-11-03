import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { Bench } from 'tinybench'
import parser from './index.js'

const eventCount = Number(process.env.EVENT_COUNT) || 10_000
const benchTime = Number(process.env.BENCH_TIME) || 1_000
const chunkSize = Number(process.env.CHUNK_SIZE) || 64 * 1024

const events = Array.from({ length: eventCount }, (_, index) => ({
  pid: 1,
  tid: index % 4,
  ts: index * 1_000,
  ph: 'X',
  cat: 'node',
  name: 'benchmark',
  dur: 20,
  args: {
    node: 'benchmark',
    executionAsyncId: index,
    triggerAsyncId: index - 1
  }
}))
const input = Buffer.from(JSON.stringify({ traceEvents: events }))

function * chunks (buffer, size) {
  for (let offset = 0; offset < buffer.length; offset += size) {
    yield buffer.subarray(offset, offset + size)
  }
}

async function parseWithStream () {
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

function parseWithJson () {
  let count = 0
  for (const event of JSON.parse(input).traceEvents) {
    if (event) count++
  }
  if (count !== eventCount) throw new Error(`JSON.parse returned ${count} of ${eventCount} events`)
}

const bench = new Bench({ name: 'Node.js trace event parsing', time: benchTime })
bench
  .add(`parser (${chunkSize / 1024} KiB chunks)`, parseWithStream)
  .add('JSON.parse (whole document)', parseWithJson)

console.log(`Events per run: ${eventCount}; input size: ${(input.length / 1024).toFixed(1)} KiB`)
await bench.run()
console.table(bench.table())
