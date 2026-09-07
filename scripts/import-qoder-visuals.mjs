// Development-only asset import. Does not execute or modify the reference app.
import { openSync, readSync, closeSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const archive = process.argv[2] ?? '/Applications/QoderWork CN.app/Contents/Resources/app.asar'
const output = fileURLToPath(new URL('../src/assets/qoder/', import.meta.url))
const fd = openSync(archive, 'r')
const header = Buffer.alloc(16)
readSync(fd, header, 0, 16, 0)
const json = Buffer.alloc(header.readUInt32LE(12))
readSync(fd, json, 0, json.length, 16)
const assets = JSON.parse(json.toString()).files.out.files.renderer.files.assets.files
const name = Object.keys(assets).find((key) => /^index-.*\.js$/.test(key))
const entry = assets[name]
const bytes = Buffer.alloc(entry.size)
readSync(fd, bytes, 0, bytes.length, 8 + header.readUInt32LE(4) + Number(entry.offset))
closeSync(fd)
const source = bytes.toString()
// Standalone SVGs do not inherit the host document's theme variables.
const palette = { 'primary': '#93e5a2', 'primary-active': '#76c88c', 'primary-border': '#ceefdb', 'border': '#d9d9d9', 'border-secondary': '#e5e5e5', 'border-tertiary': '#efefef', 'bg-base': '#fff', 'bg-elevated': '#f8f8f8', 'fill': '#e4e4e4', 'fill-quaternary': '#f6f6f6', 'info-border': '#afe0f8', 'text': '#333', 'warning-hover': '#ffe58f' }
mkdirSync(output, { recursive: true })
for (const [symbol, filename] of [['$ae', 'connectors.svg'], ['Ane', 'presentation.svg'], ['Ene', 'infographic.svg'], ['Ine', 'research.svg']]) {
  const start = source.indexOf(`${symbol}=\`<svg`)
  if (start < 0) throw new Error(`Reference asset not found: ${symbol}`)
  const value = source.slice(start + symbol.length + 2, source.indexOf('</svg>', start) + 6)
  if (/<script|<foreignObject|onload=|javascript:/i.test(value)) throw new Error('Unexpected active SVG content')
  const standalone = value.replace(/\s(data-[\w-]+)(?=\s|\/?>)/g, ' $1=""').replace(/var\(--color-([\w-]+)\)/g, (match, token) => {
    if (!palette[token]) throw new Error(`Missing SVG theme color: ${token}`)
    return palette[token]
  })
  writeFileSync(`${output}/${filename}`, standalone)
  console.log(filename, Buffer.byteLength(value))
}
for (const [symbol, filename] of [['Qde', 'expert-body.gif'], ['Wde', 'expert-hand.gif']]) {
  const match = source.match(new RegExp(`${symbol}="(https://img\\.alicdn\\.com/[^" ]+)"`))
  if (!match) throw new Error(`Reference image not found: ${symbol}`)
  const response = await fetch(match[1])
  if (!response.ok) throw new Error(`Asset download failed: ${response.status}`)
  const data = Buffer.from(await response.arrayBuffer())
  writeFileSync(`${output}/${filename}`, data)
  console.log(filename, data.length, match[1])
}
