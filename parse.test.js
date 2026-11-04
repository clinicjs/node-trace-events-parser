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
