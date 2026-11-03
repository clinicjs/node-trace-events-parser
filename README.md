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
this uses a specialised parser to achive a much higher throughput.

## Benchmark

Run the parser benchmark against `JSON.parse` with:

```sh
npm run benchmark
```

By default, it parses 10,000 generated events and runs each benchmark for one
second. Set `EVENT_COUNT` or `BENCH_TIME` (milliseconds) to change those values.

## License

Apache-2.0
