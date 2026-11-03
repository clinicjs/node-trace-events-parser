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

async function parseSamples (t, input, expected) {
  const parse = parser()
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
  const remaining = await parseSamples(t, Array.from(testData, char => char), expected)
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

test('uses JSON fallback for an event before a delimiter', async function (t) {
  t.plan(3)
  const expected = [sampleWithUnsupportedProperty(), sample()]
  const remaining = await parseSamples(t, stringify(expected.slice()), expected)
  t.assert.strictEqual(remaining, 0)
})

test('uses JSON fallback for the final event', async function (t) {
  t.plan(2)
  const expected = [sampleWithUnsupportedProperty()]
  const remaining = await parseSamples(t, stringify(expected.slice()), expected)
  t.assert.strictEqual(remaining, 0)
})
