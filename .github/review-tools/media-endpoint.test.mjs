import assert from 'node:assert/strict'
import { test } from 'node:test'
import route from '../../src/api/loadMedia.ts'

async function request(query) {
  let response
  const req = {}
  const res = {}
  const nodelink = { options: { api: { media: { musicbrainz: { enabled: false }, fanart: { enabled: false } } } } }
  await route.handler(nodelink, req, res, (_req, _res, body, status) => {
    response = { body, status }
  }, new URL('http://localhost/v4/loadmedia?' + query))
  return response
}
test('metadata route rejects missing, repeated and conflicting identifiers', async () => {
  for (const query of ['', 'isrc=USABC1234567&isrc=USABC1234567', 'isrc=USABC1234567&workMbid=invalid', 'recordingMbid=invalid', 'isrc=invalid']) {
    assert.equal((await request(query)).status, 400, query)
  }
})
test('external metadata remains opt-in and disabled providers perform no lookup', async () => {
  assert.equal((await request('isrc=USABC1234567')).status, 503)
  assert.equal((await request('artistMbid=123e4567-e89b-42d3-a456-426614174000')).status, 503)
})
