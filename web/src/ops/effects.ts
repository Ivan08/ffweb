/**
 * Effects: what can be done to the picture without moving anything in time.
 *
 * They compose into a single filter chain, so applying seven of them still
 * costs one re-encode — the whole reason a chain exists, since the tool this
 * replaced re-encoded once per operation and three adjustments meant three
 * generations of loss.
 *
 * The rule that keeps the rest of the model honest: **nothing here may change
 * the length or the timing of the result.** Speed, reversal and repeats are
 * properties of a clip instead, so that an overlay asking to appear "from 3s to
 * 7s" can trust that those seconds mean what the timeline shows. A registry
 * test enforces it.
 */

import { bool, evenOrAuto, num, str, type OpDef } from '../core/ops'

export const EFFECTS: OpDef[] = [
  {
    id: 'resizecompress',
    group: 'transform',
    icon: 'Scaling',
    chainable: true,
    batchable: true,
    extraInputs: 0,
    requires: { filters: ['scale'] },
    params: [
      {
        key: 'mode',
        kind: 'select',
        default: 'height',
        options: [
          { value: 'height' },
          { value: 'width' },
          { value: 'exact' },
          { value: 'percent' },
        ],
      },
      { key: 'width', kind: 'number', default: 1280, min: 2, max: 15360, step: 2 },
      { key: 'height', kind: 'number', default: 720, min: 2, max: 8640, step: 2 },
      { key: 'percent', kind: 'slider', default: 50, min: 5, max: 200, step: 5, unit: '%' },
    ],
    filters: (p, ctx) => {
      const mode = str(p, 'mode', 'height')
      if (mode === 'percent') {
        const scale = num(p, 'percent', 100) / 100
        const width = ctx.source?.width ? Math.round(ctx.source.width * scale) : 0
        // Deriving only the width and letting ffmpeg round the height keeps the
        // aspect ratio exact even for odd source dimensions.
        return { video: [`scale=${evenOrAuto(width)}:-2:flags=lanczos`] }
      }
      if (mode === 'width') return { video: [`scale=${evenOrAuto(num(p, 'width'))}:-2:flags=lanczos`] }
      if (mode === 'height') return { video: [`scale=-2:${evenOrAuto(num(p, 'height'))}:flags=lanczos`] }
      return {
        video: [`scale=${evenOrAuto(num(p, 'width'))}:${evenOrAuto(num(p, 'height'))}:flags=lanczos`],
      }
    },
  },
  {
    id: 'crop',
    group: 'transform',
    icon: 'Crop',
    chainable: true,
    // Crop rectangles are chosen against one specific frame, so applying the
    // same numbers to a mixed-resolution batch produces nonsense.
    batchable: false,
    extraInputs: 0,
    requires: { filters: ['crop'] },
    params: [
      { key: 'x', kind: 'number', default: 0, min: 0, step: 2 },
      { key: 'y', kind: 'number', default: 0, min: 0, step: 2 },
      { key: 'w', kind: 'number', default: 0, min: 2, step: 2 },
      { key: 'h', kind: 'number', default: 0, min: 2, step: 2 },
    ],
    filters: (p, ctx) => {
      const w = num(p, 'w') || ctx.source?.width || 0
      const h = num(p, 'h') || ctx.source?.height || 0
      if (!w || !h) return {}
      return { video: [`crop=${evenOrAuto(w)}:${evenOrAuto(h)}:${num(p, 'x')}:${num(p, 'y')}`] }
    },
  },
  {
    id: 'rotate',
    group: 'transform',
    icon: 'RotateCw',
    chainable: true,
    batchable: true,
    extraInputs: 0,
    requires: { filters: ['transpose'] },
    params: [
      {
        key: 'angle',
        kind: 'select',
        default: '90',
        options: [{ value: '90' }, { value: '180' }, { value: '270' }, { value: '0' }],
      },
      { key: 'hflip', kind: 'toggle', default: false },
      { key: 'vflip', kind: 'toggle', default: false },
    ],
    filters: (p) => {
      const video: string[] = []
      switch (str(p, 'angle', '90')) {
        case '90':
          video.push('transpose=1')
          break
        case '180':
          video.push('transpose=1', 'transpose=1')
          break
        case '270':
          video.push('transpose=2')
          break
      }
      if (bool(p, 'hflip')) video.push('hflip')
      if (bool(p, 'vflip')) video.push('vflip')
      return { video }
    },
  },
  {
    id: 'pad',
    group: 'transform',
    icon: 'RectangleHorizontal',
    chainable: true,
    batchable: true,
    extraInputs: 0,
    requires: { filters: ['pad'] },
    params: [
      {
        key: 'aspect',
        kind: 'select',
        default: '16:9',
        options: [
          { value: '16:9' },
          { value: '9:16' },
          { value: '1:1' },
          { value: '4:5' },
          { value: '4:3' },
        ],
      },
      { key: 'color', kind: 'text', default: 'black', placeholder: 'black' },
    ],
    filters: (p, ctx) => {
      const [aw, ah] = str(p, 'aspect', '16:9').split(':').map(Number)
      const sourceWidth = ctx.source?.width ?? 1920
      const sourceHeight = ctx.source?.height ?? 1080
      // Grow the frame to the target aspect rather than shrinking it, so
      // padding never costs resolution.
      const targetWidth = Math.max(sourceWidth, Math.round((sourceHeight * aw) / ah))
      const targetHeight = Math.max(sourceHeight, Math.round((sourceWidth * ah) / aw))
      const w = evenOrAuto(targetWidth)
      const h = evenOrAuto(targetHeight)
      const color = str(p, 'color', 'black') || 'black'
      return {
        video: [
          `scale=${w}:${h}:force_original_aspect_ratio=decrease`,
          `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=${color}`,
        ],
      }
    },
  },
  {
    id: 'adjust',
    group: 'look',
    icon: 'SlidersHorizontal',
    chainable: true,
    batchable: true,
    extraInputs: 0,
    requires: { filters: ['eq'] },
    params: [
      { key: 'brightness', kind: 'slider', default: 0, min: -1, max: 1, step: 0.05 },
      { key: 'contrast', kind: 'slider', default: 1, min: 0, max: 3, step: 0.05 },
      { key: 'saturation', kind: 'slider', default: 1, min: 0, max: 3, step: 0.05 },
      { key: 'gamma', kind: 'slider', default: 1, min: 0.1, max: 3, step: 0.05 },
      { key: 'grayscale', kind: 'toggle', default: false },
    ],
    filters: (p) => {
      const parts = [
        `brightness=${num(p, 'brightness', 0)}`,
        `contrast=${num(p, 'contrast', 1)}`,
        `saturation=${bool(p, 'grayscale') ? 0 : num(p, 'saturation', 1)}`,
        `gamma=${num(p, 'gamma', 1)}`,
      ]
      return { video: [`eq=${parts.join(':')}`] }
    },
  },
  {
    id: 'denoise',
    group: 'look',
    icon: 'Sparkles',
    chainable: true,
    batchable: true,
    extraInputs: 0,
    requires: { filters: ['hqdn3d'] },
    params: [
      {
        key: 'strength',
        kind: 'select',
        default: 'medium',
        options: [{ value: 'light' }, { value: 'medium' }, { value: 'strong' }],
      },
    ],
    filters: (p) => {
      switch (str(p, 'strength', 'medium')) {
        case 'light':
          return { video: ['hqdn3d=2:2:3:3'] }
        case 'strong':
          return { video: ['hqdn3d=10:10:15:15'] }
        default:
          return { video: ['hqdn3d=4:4:6:6'] }
      }
    },
  },
  {
    id: 'sharpenblur',
    group: 'look',
    icon: 'Focus',
    chainable: true,
    batchable: true,
    extraInputs: 0,
    requires: { filters: ['unsharp'] },
    params: [
      {
        key: 'mode',
        kind: 'select',
        default: 'sharpen',
        options: [{ value: 'sharpen' }, { value: 'blur' }],
      },
      { key: 'amount', kind: 'slider', default: 1, min: 0.1, max: 3, step: 0.1 },
    ],
    filters: (p) => {
      const amount = num(p, 'amount', 1)
      if (str(p, 'mode', 'sharpen') === 'blur') return { video: [`gblur=sigma=${amount.toFixed(2)}`] }
      return { video: [`unsharp=5:5:${amount.toFixed(2)}:5:5:0`] }
    },
  },
]
