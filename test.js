const tape = require('tape')
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

function stringify (samples) {
  return JSON.stringify({traceEvents: samples})
}

tape('basic nested', function (t) {
  const parse = parser()
  const expected = [sample(), sample()]
  const testData = stringify(expected)
  parse.write(testData)
  parse.end()

  parse
    .on('data', function (data) {
      t.same(data, expected.shift())
    })
    .on('end', function () {
      t.same(expected.length, 0)
      t.end()
    })
})

tape('chunked nested', function (t) {
  const parse = parser()
  const expected = [sample(), sample()]
  const testData = stringify(expected)

  for (var i = 0; i < testData.length; i++) {
    parse.write(testData.slice(i, i + 1))
  }
  parse.end()

  parse
    .on('data', function (data) {
      t.same(data, expected.shift())
    })
    .on('end', function () {
      t.same(expected.length, 0)
      t.end()
    })
})

tape('basic', function (t) {
  const parse = parser()
  const expected = [sample(), sample()]

  parse.write(stringify(expected))
  parse.end()

  parse
    .on('data', function (data) {
      t.same(data, expected.shift())
    })
    .on('end', function () {
      t.same(expected.length, 0)
      t.end()
    })
})

tape('chunked', function (t) {
  const parse = parser()
  const expected = [sample(), sample()]
  const s = stringify(expected)

  for (var i = 0; i < s.length; i++) {
    parse.write(s.slice(i, i + 1))
  }
  parse.end()

  parse
    .on('data', function (data) {
      t.same(data, expected.shift())
    })
    .on('end', function () {
      t.same(expected.length, 0)
      t.end()
    })
})
