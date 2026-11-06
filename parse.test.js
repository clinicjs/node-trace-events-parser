const test = require('node:test')
const parser = require('./')

function sample () {
  return {
    pid: 42,
    tid: Date.now(),
    name: Math.random().toString(),
    args: {
      executionAsyncId: Date.now()
    }
  }
}

function sampleWithUnsupportedProperty () {
  const value = sample()
  return {
    pid: value.pid,
    tid: value.tid,
    name: value.name,
    unsupported: true,
    args: value.args
  }
}

function stringify (samples) {
  return JSON.stringify({ traceEvents: samples })
}

async function parseSamples (t, input, expected, options) {
  const parse = parser(options)
  const done = new Promise((resolve, reject) => {
    parse
      .on('data', function (data) {
        t.assert.deepStrictEqual(data, expected.shift())
      })
      .on('error', reject)
      .on('end', resolve)
  })

  if (Array.isArray(input)) {
    for (const chunk of input) parse.write(chunk)
  } else {
    parse.write(input)
  }
  parse.end()
  await done
  return expected.length
}

test('basic nested', async function (t) {
  t.plan(3)
  const expected = [sample(), sample()]
  const remaining = await parseSamples(t, stringify(expected.slice()), expected)
  t.assert.strictEqual(remaining, 0)
})

test('chunked nested', async function (t) {
  t.plan(3)
  const expected = [sample(), sample()]
  const testData = stringify(expected.slice())
  const remaining = await parseSamples(t, Array.from(testData, char => char), expected, { decodeStrings: false })
  t.assert.strictEqual(remaining, 0)
})

test('basic', async function (t) {
  t.plan(3)
  const expected = [sample(), sample()]
  const remaining = await parseSamples(t, stringify(expected.slice()), expected)
  t.assert.strictEqual(remaining, 0)
})

test('chunked', async function (t) {
  t.plan(3)
  const expected = [sample(), sample()]
  const testData = stringify(expected.slice())
  const remaining = await parseSamples(t, Array.from(testData, char => char), expected)
  t.assert.strictEqual(remaining, 0)
})

test('retains unsupported properties for an event before a delimiter', async function (t) {
  t.plan(3)
  const expected = [sampleWithUnsupportedProperty(), sample()]
  const remaining = await parseSamples(t, stringify(expected.slice()), expected)
  t.assert.strictEqual(remaining, 0)
})

test('retains unsupported properties for the final event', async function (t) {
  t.plan(2)
  const expected = [sampleWithUnsupportedProperty()]
  const remaining = await parseSamples(t, stringify(expected.slice()), expected)
  t.assert.strictEqual(remaining, 0)
})

test('accepts an empty traceEvents array', async function (t) {
  const parse = parser()
  let count = 0

  parse.on('data', function () {
    count++
  })

  const done = new Promise((resolve, reject) => {
    parse.on('error', reject)
    parse.on('end', resolve)
  })

  parse.write(stringify([]))
  parse.write(Buffer.alloc(0))
  parse.end()
  await done
  t.assert.strictEqual(count, 0)
})

test('preserves multi-byte UTF-8 characters split across Buffer chunks', async function (t) {
  t.plan(4)
  const expected = [
    { name: 'café', args: { executionAsyncId: 1 } },
    { name: '漢', args: { executionAsyncId: 2 } },
    { name: '💩', args: { executionAsyncId: 3 } }
  ]
  const input = Buffer.from(stringify(expected))
  const chunks = Array.from(input, (_, index) => input.subarray(index, index + 1))
  const remaining = await parseSamples(t, chunks, expected)
  t.assert.strictEqual(remaining, 0)
})

test('scans input chunks larger than one mebibyte in bounded pieces', async function (t) {
  const expected = [{ name: 'large', args: { payload: 'x'.repeat(1024 * 1024) } }]
  const remaining = await parseSamples(t, stringify(expected.slice()), expected)
  t.assert.strictEqual(remaining, 0)
})

test('replaces invalid UTF-8 bytes when decoding trace events', async function (t) {
  t.plan(2)
  const expected = [{ name: 'f�oo', args: { executionAsyncId: 1 } }]
  const input = Buffer.from(stringify([{ name: 'fooo', args: { executionAsyncId: 1 } }]))
  const name = input.indexOf(Buffer.from('"fooo"'))
  input[name + 2] = 0xf5
  const chunks = Array.from(input, (_, index) => input.subarray(index, index + 1))
  const remaining = await parseSamples(t, chunks, expected)
  t.assert.strictEqual(remaining, 0)
})

test('emits every final event when events have no args', async function (t) {
  t.plan(3)
  const expected = [{ name: 'first' }, { name: 'second' }]
  const remaining = await parseSamples(t, stringify(expected.slice()), expected)
  t.assert.strictEqual(remaining, 0)
})

test('does not treat a delimiter inside a string as an event boundary', async function (t) {
  t.plan(3)
  const expected = [
    { name: 'first', args: { executionAsyncId: 1 } },
    { name: 'second', args: { name: 'before "}}, after' } }
  ]
  const remaining = await parseSamples(t, stringify(expected.slice()), expected)
  t.assert.strictEqual(remaining, 0)
})

test('reports an incomplete event at end of input', async function (t) {
  const parse = parser()
  const error = new Promise((resolve) => parse.once('error', resolve))
  parse.end('{"traceEvents":[{"name":"unfinished"')
  t.assert.match((await error).message, /Incomplete trace event/)
})

test('rejects incomplete or malformed trace documents', async function (t) {
  const inputs = [
    '{"traceEvents":[',
    '{"traceEvents":[{"name":"complete event"}]',
    '{"traceEvents":[garbage]}',
    '{"traceEvents":[{"name":"one"}{"name":"two"}]}',
    '{"traceEvents":[]}x',
    '{"traceEvents":[\u00a0{"name":"event"}]}',
    '{"traceEvents":[]x}',
    '{"traceEvents":[,]}',
    '{"traceEvents":[{"name":"one"},]}',
    '{"traceEvents":[{"pid":}]}',
    '{"traceEvents":[{"pid":01}]}',
    '{"traceEvents":[{"pid":1 "tid":2}]}',
    '{"traceEvents":[{"name":"raw\nnewline"}]}'
  ]

  for (const input of inputs) {
    const parse = parser()
    const result = new Promise((resolve) => {
      parse.on('data', function () {})
      parse.once('error', resolve)
      parse.once('end', () => resolve(null))
    })

    parse.end(input)
    t.assert.ok(await result instanceof Error, `expected an error for ${input}`)
  }
})

test('emits an error for malformed JSON after a valid event', async function (t) {
  const expected = { name: 'valid' }
  const input = '{"traceEvents":[' + JSON.stringify(expected) + ', {"x":"x"]}},]}'
  const { events, error } = await collect(Array.from(input, char => char))

  t.assert.deepStrictEqual(events, [expected])
  t.assert.ok(error instanceof SyntaxError)
})

test('rejects content after the closing trace document object', async function (t) {
  const inputs = [
    ['{"traceEvents":[]}]'],
    ['{"traceEvents":[]}]]'],
    ['{"traceEvents":[{"name":"one"}]}]'],
    ['{"traceEvents":[{"name":"one"}]}', ']'],
    ['{"traceEvents":[]} \n]'],
    ['{"traceEvents":[]}x'],
    ['{"traceEvents":[]},'],
    ['{"traceEvents":[]}}']
  ]

  for (const chunks of inputs) {
    const parse = parser()
    const result = new Promise((resolve) => {
      parse.on('data', function () {})
      parse.once('error', resolve)
      parse.once('end', () => resolve(null))
    })

    for (const chunk of chunks) parse.write(chunk)
    parse.end()
    const error = await result
    t.assert.ok(error instanceof SyntaxError, `expected an error for ${chunks.join('')}`)
    t.assert.match(error.message, /Unexpected content after trace document/)
  }
})

test('accepts whitespace after the closing trace document object', async function (t) {
  t.plan(2)
  const expected = [{ name: 'one' }]
  const remaining = await parseSamples(t, '{"traceEvents":[{"name":"one"}]} \r\n\t', expected)
  t.assert.strictEqual(remaining, 0)
})

test('accepts whitespace between trace events and document delimiters', async function (t) {
  t.plan(2)
  const expected = [{ name: 'spaced' }]
  const input = '{"traceEvents":[ \n { "name": "spaced" } ]\n}'
  const remaining = await parseSamples(t, input, expected)
  t.assert.strictEqual(remaining, 0)
})

test('parses empty string values in events', async function (t) {
  t.plan(4)
  const expected = [
    { name: '', args: { executionAsyncId: 1 } },
    { name: 'with empty arg', args: { name: '' } },
    { name: 'next' }
  ]
  const remaining = await parseSamples(t, stringify(expected.slice()), expected)
  t.assert.strictEqual(remaining, 0)
})

/**
 * Collect everything a parser emits for the given chunks.
 *
 * @param {Array<string|Buffer>} chunks Chunks to write in order.
 * @returns {Promise<{ events: object[], error: Error|null }>} Parser outcome.
 */
function collect (chunks) {
  const parse = parser()
  const events = []
  const outcome = new Promise((resolve) => {
    parse.on('data', (event) => events.push(event))
    parse.once('error', (error) => resolve({ events, error }))
    parse.once('end', () => resolve({ events, error: null }))
  })

  for (const chunk of chunks) parse.write(chunk)
  parse.end()
  return outcome
}

function isBatchParse (call) {
  return typeof call.arguments[0] === 'string' && call.arguments[0].startsWith('[')
}

test('parses the events between the first and last separator of a chunk at once', async function (t) {
  const expected = Array.from({ length: 1000 }, (_, index) => ({ name: 'event', args: { index } }))
  const parse = t.mock.method(JSON, 'parse')

  const { events, error } = await collect([stringify(expected)])

  t.assert.strictEqual(error, null)
  t.assert.deepStrictEqual(events, expected)
  // The first and last event are scanned; every other event shares one call.
  t.assert.strictEqual(parse.mock.callCount(), 3)
})

test('completes an event spanning chunks before batching the next chunk', async function (t) {
  const expected = Array.from({ length: 200 }, (_, index) => ({ name: 'event', args: { index } }))
  const input = stringify(expected)
  const middle = Math.floor(input.length / 2)

  const { events, error } = await collect([input.slice(0, middle), input.slice(middle)])

  t.assert.strictEqual(error, null)
  t.assert.deepStrictEqual(events, expected)
})

test('keeps events intact when a separator appears inside an event', async function (t) {
  const inputs = [
    [{ name: '},{' }, { name: 'b' }, { name: 'c' }, { name: 'd' }],
    [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: '},{' }],
    [{ name: 'a' }, { name: '},{' }, { name: 'c' }, { name: 'd' }],
    [{ name: 'a' }, { args: [{ x: 1 }, { x: 2 }] }, { name: 'c' }, { name: 'd' }],
    [{ args: [{ x: 1 }, { x: 2 }] }, { args: [{ x: 3 }, { x: 4 }] }, { name: 'c' }]
  ]

  for (const expected of inputs) {
    const { events, error } = await collect([stringify(expected)])
    t.assert.strictEqual(error, null)
    t.assert.deepStrictEqual(events, expected)
  }
})

test('rejects non-object values between events in a batch', async function (t) {
  for (const value of ['1', 'null', '[]', '"text"', 'true']) {
    const input = `{"traceEvents":[{"a":1},{"b":2},${value},{"c":3},{"d":4}]}`
    const { error } = await collect([input])
    t.assert.ok(error instanceof SyntaxError, `expected an error for ${value}`)
    t.assert.match(error.message, /Unexpected content in trace events/)
  }
})

test('stops trying to batch after repeated failures', async function (t) {
  // The last separator is inside the final event, so the batch cannot parse.
  const chunk = '{"name":"a"},{"name":"b"},{"args":[{"x":1},{"x":2}]},'
  const chunks = ['{"traceEvents":[', ...Array.from({ length: 50 }, () => chunk)]
  chunks.push('{"name":"last"}]}')
  const parse = t.mock.method(JSON, 'parse')

  const { events, error } = await collect(chunks)

  t.assert.strictEqual(error, null)
  t.assert.strictEqual(events.length, 151)
  t.assert.strictEqual(parse.mock.calls.filter(isBatchParse).length, 4)
})

test('batches again after a success resets the failure count', async function (t) {
  const failing = '{"name":"a"},{"name":"b"},{"args":[{"x":1},{"x":2}]},'
  const plain = '{"name":"plain"},'.repeat(4)
  const chunks = ['{"traceEvents":[']
  for (let i = 0; i < 10; i++) chunks.push(failing, plain)
  chunks.push('{"name":"last"}]}')
  const parse = t.mock.method(JSON, 'parse')

  const { error } = await collect(chunks)

  t.assert.strictEqual(error, null)
  // Plain chunks succeed in between, so every one of the 20 chunks is attempted.
  t.assert.strictEqual(parse.mock.calls.filter(isBatchParse).length, 20)
})

test('whole chunks match byte-at-a-time parsing on mutated documents', async function (t) {
  // mulberry32: deterministic, so a failure reproduces on every run.
  let state = 0x9e3779b9
  const random = (limit) => {
    state = (state + 0x6d2b79f5) | 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) % limit
  }
  const strings = ['x', 'a},{b', '},{', '\\', '"', '{', '}', 'ü💩']
  const noise = ['},{', '}', '{', '"', '\\', ',', ']', ']}', '1', 'null', '[]', '{}', ' ', '\n', '},{"a":1},{']
  const value = (depth) => {
    switch (random(depth > 2 ? 4 : 7)) {
      case 0: return random(1000)
      case 1: return strings[random(strings.length)]
      case 2: return null
      case 3: return true
      case 4: return { key: value(depth + 1), other: value(depth + 1) }
      case 5: return [value(depth + 1), { nested: value(depth + 1) }, { nested: 1 }]
      default: return {}
    }
  }

  let accepted = 0
  let rejected = 0
  for (let run = 0; run < 600; run++) {
    const events = Array.from({ length: random(12) }, (_, index) => ({ index, value: value(0) }))
    let text = stringify(events)
    for (let mutations = random(3); mutations > 0; mutations--) {
      const position = 16 + random(Math.max(1, text.length - 16))
      const inserted = noise[random(noise.length)]
      text = random(2)
        ? text.slice(0, position) + inserted + text.slice(position)
        : text.slice(0, position) + text.slice(position + 1 + random(4))
    }

    const input = Buffer.from(text)
    const bytewise = await collect(Array.from(input, (_, index) => input.subarray(index, index + 1)))
    const whole = await collect([input])

    t.assert.strictEqual(whole.error?.message, bytewise.error?.message, text)
    if (bytewise.error) rejected++
    else {
      accepted++
      t.assert.deepStrictEqual(whole.events, bytewise.events, text)
    }
  }

  t.assert.ok(accepted > 100, `only ${accepted} documents were accepted`)
  t.assert.ok(rejected > 100, `only ${rejected} documents were rejected`)
})
