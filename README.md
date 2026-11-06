# @clinic/trace-events-parser

Fast streaming parser for Node.js trace events.

```
npm install @clinic/trace-events-parser
```

## Usage

```js
const parser = require('@clinic/trace-events-parser')
const fs = require('fs')

fs.createReadStream('node_trace.log')
  .pipe(parser())
  .on('data', function (data) {
    console.log('traceEvent:', data)
  })
```

The parser extracts event boundaries incrementally and emits parsed event
objects without retaining the complete trace document in memory. Compact runs
of adjacent events may be parsed in batches for better throughput.

Node.js 22 or newer is required.

## Benchmark

Compare the streaming parser with per-event and whole-document `JSON.parse` using:

```sh
npm run benchmark
```

By default, it parses 10,000 generated events and runs each benchmark for one
second. Set `EVENT_COUNT` or `BENCH_TIME` (milliseconds) to change those values.
The benchmark covers two workloads: common event fields and nested `args.data`
objects like those found in `async_hooks` traces.

## License

Apache-2.0
