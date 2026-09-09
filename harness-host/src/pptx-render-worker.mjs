import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const PptxGenJS = require('pptxgenjs')
const MAX_INPUT_BYTES = 8 * 1024 * 1024
const MAX_OUTPUT_BYTES = 25 * 1024 * 1024

async function main() {
  const chunks = []
  let inputBytes = 0
  for await (const chunk of process.stdin) {
    inputBytes += chunk.length
    if (inputBytes > MAX_INPUT_BYTES) throw new Error('输入超过 8 MiB 限制')
    chunks.push(chunk)
  }
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  const slides = validatePayload(payload)
  const presentation = new PptxGenJS()
  presentation.layout = 'LAYOUT_WIDE'
  presentation.author = '小胤'
  presentation.subject = payload.title || '小胤生成演示文稿'
  presentation.theme = { headFontFace: 'Microsoft YaHei', bodyFontFace: 'Microsoft YaHei', lang: 'zh-CN' }
  for (const item of slides) {
    const slide = presentation.addSlide()
    slide.background = { color: 'F7FAF8' }
    slide.addShape(presentation.ShapeType.rect, { x: 0, y: 0, w: 0.16, h: 7.5, fill: { color: '4F9366' }, line: { color: '4F9366' } })
    slide.addText(item.title, { x: 0.65, y: 0.55, w: 11.7, h: 0.7, fontFace: 'Microsoft YaHei', fontSize: 27, bold: true, color: '202522', margin: 0 })
    if (item.bullets.length > 0) {
      slide.addText(item.bullets.map((text) => ({ text, options: { bullet: { indent: 18 }, breakLine: true } })), {
        x: 0.75, y: 1.65, w: 11.6, h: 4.9, fontFace: 'Microsoft YaHei', fontSize: 18, color: '3F4741', breakLine: false,
        margin: 0.08, paraSpaceAfterPt: 14, valign: 'top',
      })
    }
    if (item.speakerNotes) slide.addNotes(item.speakerNotes)
  }
  const raw = await presentation.write({ outputType: 'nodebuffer' })
  const output = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
  if (output.length === 0 || output.length > MAX_OUTPUT_BYTES) throw new Error('输出文件大小无效')
  process.stdout.write(output)
}

function validatePayload(value) {
  if (!value || typeof value !== 'object' || typeof value.title !== 'string' || value.title.length > 500
      || !Array.isArray(value.slides) || value.slides.length === 0 || value.slides.length > 100) {
    throw new Error('PPTX 输入无效')
  }
  for (const slide of value.slides) {
    if (!slide || typeof slide !== 'object' || typeof slide.title !== 'string' || slide.title.length === 0 || slide.title.length > 500
        || !Array.isArray(slide.bullets) || slide.bullets.length > 30
        || slide.bullets.some((item) => typeof item !== 'string' || item.length > 2_000)
        || slide.speakerNotes !== undefined && (typeof slide.speakerNotes !== 'string' || slide.speakerNotes.length > 10_000)) {
      throw new Error('PPTX 幻灯片输入无效')
    }
  }
  return value.slides
}

main().catch((error) => {
  process.stderr.write(error instanceof Error ? error.message : 'PPTX 生成失败')
  process.exitCode = 1
})
