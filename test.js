const tape = require('tape')
const parser = require('./')

tape('basic nested', function (t) {
  const parse = parser()
  const expected = [{ a: true, b: {} }, { a: false, b: { c: {} } }]
  const testData = '{"traceEvents":[{"a":true,"b":{}},{"a":false,"b":{"c":{}}}]}'
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
  const expected = [{ a: true, b: {} }, { a: false, b: { c: {} } }]
  const testData = '{"traceEvents":[{"a":true,"b":{}},{"a":false,"b":{"c":{}}}]}'
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
  const expected = [{ a: true, b: {} }, { a: false, b: {} }]

  parse.write('{"traceEvents":[{"a":true,"b":{}},{"a":false,"b":{}}]}')
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
  const expected = [{ a: true, b: {} }, { a: false, b: {} }]
  const s = '{"traceEvents":[{"a":true,"b":{}},{"a":false,"b":{}}]}'

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
