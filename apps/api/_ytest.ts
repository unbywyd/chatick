// Проверка протокола: два "клиента" правят один документ через наш сервер.
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { writeSyncStep1, writeUpdate, readSyncMessage } from 'y-protocols/sync'
import WebSocket from 'ws'

const [,, token, docId, base] = process.argv
const URL = `${base}/yjs?token=${encodeURIComponent(token!)}&doc=${docId}`

function client(name: string, onSync: (c: any) => void) {
  const doc = new Y.Doc()
  const ws = new WebSocket(URL)
  ws.binaryType = 'arraybuffer'
  let synced = false
  const send = (d: Uint8Array) => ws.readyState === 1 && ws.send(d, { binary: true })
  doc.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin === 'remote') return
    const e = encoding.createEncoder(); encoding.writeVarUint(e, 0); writeUpdate(e, u); send(encoding.toUint8Array(e))
  })
  ws.on('open', () => {
    const e = encoding.createEncoder(); encoding.writeVarUint(e, 0); writeSyncStep1(e, doc); send(encoding.toUint8Array(e))
  })
  ws.on('message', (data: Buffer) => {
    const dec = decoding.createDecoder(new Uint8Array(data))
    if (decoding.readVarUint(dec) !== 0) return
    const reply = encoding.createEncoder(); encoding.writeVarUint(reply, 0)
    readSyncMessage(dec, reply, doc, 'remote')
    if (encoding.length(reply) > 1) send(encoding.toUint8Array(reply))
    if (!synced) { synced = true; onSync({ doc, ws, name }) }
  })
  ws.on('error', (e: Error) => console.log(name, 'ERR', e.message))
  ws.on('close', (c: number) => console.log(name, 'closed', c))
  return { doc, ws }
}

const A = client('A', (a) => {
  a.doc.getText('t').insert(0, 'hello from A. ')
  console.log('A wrote')
  setTimeout(() => {
    const B = client('B', (b) => {
      console.log('B sees after sync:', JSON.stringify(b.doc.getText('t').toString()))
      b.doc.getText('t').insert(b.doc.getText('t').length, 'and B too.')
      setTimeout(() => {
        console.log('A now sees:', JSON.stringify(a.doc.getText('t').toString()))
        console.log('B now sees:', JSON.stringify(b.doc.getText('t').toString()))
        const ok = a.doc.getText('t').toString() === b.doc.getText('t').toString()
        console.log(ok ? 'CONVERGED OK' : 'DIVERGED!!')
        process.exit(ok ? 0 : 1)
      }, 700)
    })
  }, 500)
})
setTimeout(() => { console.log('TIMEOUT'); process.exit(2) }, 12000)
