# @clinic/trace-event-parser

Fast streaming parser for Node.js trace events.

```
npm install @clinic/trace-event-parser
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

You can also use JSONStream to parse trace events, but
this only has to find the event boundaries and hands the events to `JSON.parse`
to achieve a much higher throughput.

## Benchmark

Compare the streaming parser with per-event and whole-document `JSON.parse` using:

```sh
npm run benchmark
```

By default, it parses 10,000 generated events and runs each benchmark for one
second. Set `EVENT_COUNT` or `BENCH_TIME` (milliseconds) to change those values.
Each case runs twice: with only the common event fields, and with the nested
`args.data` objects that `async_hooks` traces contain.

## License

Apache-2.0
