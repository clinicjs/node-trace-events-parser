const tape = require('tape')
const parser = require('./')

tape('basic', function (t) {
  const parse = parser()
  const expected = [{a: true, b: {}}, {a: false, b: {}}]

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
  const expected = [{a: true, b: {}}, {a: false, b: {}}]
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
