// Generate a 96x96 PNG with three vertical stripes: red | green | blue.
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'

const W = 96, H = 96
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

const raw = Buffer.alloc(H * (1 + W * 3))
for (let y = 0; y < H; y++) {
  const row = y * (1 + W * 3)
  raw[row] = 0 // filter none
  for (let x = 0; x < W; x++) {
    const px = row + 1 + x * 3
    const third = Math.floor(x / (W / 3))
    raw[px] = third === 0 ? 255 : 0
    raw[px + 1] = third === 1 ? 255 : 0
    raw[px + 2] = third === 2 ? 255 : 0
  }
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4)
ihdr[8] = 8; ihdr[9] = 2 // 8-bit, truecolor
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
])
writeFileSync('/home/sumer/Workspaces/Chat/1/llm-claude-code/probe-stripes.png', png)
console.log('bytes:', png.length)
console.log('base64 length:', png.toString('base64').length)
