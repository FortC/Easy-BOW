/**
 * EasyBow OCR Worker —— 在隐藏窗口的渲染进程中运行 PP-OCR ONNX 推理（WASM，免费离线）。
 * 通信：主进程 send('ocr:run', {id, png, regions?}) → 本页计算 → invoke('ocr:result', {id, ...})
 */
/* global ort */

;(function () {
  'use strict'

  var REC_H = 48
  var REC_W_BUCKETS = [320, 640, 960, 1280]
  var detSession = null
  var recSession = null
  var keys = null

  ort.env.wasm.numThreads = 1 // file:// 环境无 COOP/COEP，禁用多线程
  ort.env.wasm.wasmPaths = new URL('./ort/', location.href).href

  // ---------- PNG 解码（浏览器原生） ----------
  async function decodePng(bytes) {
    var blob = new Blob([bytes], { type: 'image/png' })
    var bmp = await createImageBitmap(blob)
    var cv = new OffscreenCanvas(bmp.width, bmp.height)
    var ctx = cv.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(bmp, 0, 0)
    var data = ctx.getImageData(0, 0, bmp.width, bmp.height)
    var w = data.width
    var h = data.height
    bmp.close()
    return { w: w, h: h, data: data.data }
  }

  // ---------- 双线性缩放 RGBA ----------
  function resizeRgba(src, tw, th) {
    if (src.w === tw && src.h === th) return src.data
    var out = new Uint8ClampedArray(tw * th * 4)
    for (var y = 0; y < th; y++) {
      var sy = Math.min(src.h - 1, (y * src.h) / th)
      var y0 = Math.floor(sy)
      var y1 = Math.min(src.h - 1, y0 + 1)
      var fy = sy - y0
      for (var x = 0; x < tw; x++) {
        var sx = Math.min(src.w - 1, (x * src.w) / tw)
        var x0 = Math.floor(sx)
        var x1 = Math.min(src.w - 1, x0 + 1)
        var fx = sx - x0
        var o = (y * tw + x) * 4
        for (var c = 0; c < 4; c++) {
          var p00 = src.data[(y0 * src.w + x0) * 4 + c]
          var p01 = src.data[(y0 * src.w + x1) * 4 + c]
          var p10 = src.data[(y1 * src.w + x0) * 4 + c]
          var p11 = src.data[(y1 * src.w + x1) * 4 + c]
          out[o + c] = (p00 * (1 - fx) + p01 * fx) * (1 - fy) + (p10 * (1 - fx) + p11 * fx) * fy
        }
      }
    }
    return out
  }

  function cropRgba(src, x0, y0, cw, ch) {
    var w = Math.max(1, Math.round(cw))
    var h = Math.max(1, Math.round(ch))
    var out = new Uint8ClampedArray(w * h * 4)
    for (var y = 0; y < h; y++) {
      var sy = Math.min(src.h - 1, y0 + y)
      for (var x = 0; x < w; x++) {
        var sx = Math.min(src.w - 1, x0 + x)
        var si = (sy * src.w + sx) * 4
        var oi = (y * w + x) * 4
        out[oi] = src.data[si]
        out[oi + 1] = src.data[si + 1]
        out[oi + 2] = src.data[si + 2]
        out[oi + 3] = src.data[si + 3]
      }
    }
    return { w: w, h: h, data: out }
  }

  function toGray(r, g, b) {
    return 0.299 * r + 0.587 * g + 0.114 * b
  }

  // ---------- det：ImageNet 归一化 + DB 后处理 ----------
  function detTensor(img) {
    var ratio = Math.min(1, 960 / Math.max(img.w, img.h))
    var rw = Math.max(32, Math.round((img.w * ratio) / 32) * 32)
    var rh = Math.max(32, Math.round((img.h * ratio) / 32) * 32)
    var data = resizeRgba(img, rw, rh)
    var mean = [0.485, 0.456, 0.406]
    var std = [0.229, 0.224, 0.225]
    var f32 = new Float32Array(3 * rh * rw)
    var p = 0
    for (var c = 0; c < 3; c++) {
      for (var y = 0; y < rh; y++) {
        for (var x = 0; x < rw; x++) {
          var i = (y * rw + x) * 4
          f32[p++] = (data[i + c] / 255 - mean[c]) / std[c]
        }
      }
    }
    return { tensor: new ort.Tensor('float32', f32, [1, 3, rh, rw]), rw: rw, rh: rh, ratio: ratio }
  }

  function detBoxes(prob, pw, ph, ratio, origW, origH) {
    var TH = 0.3
    var bin = new Uint8Array(pw * ph)
    for (var i = 0; i < prob.length; i++) bin[i] = prob[i] > TH ? 1 : 0
    // 3x3 膨胀合并断笔
    var dil = new Uint8Array(pw * ph)
    for (var y = 0; y < ph; y++) {
      for (var x = 0; x < pw; x++) {
        var v = 0
        for (var dy = -1; dy <= 1 && !v; dy++) {
          for (var dx = -1; dx <= 1; dx++) {
            var ny = y + dy
            var nx = x + dx
            if (ny >= 0 && ny < ph && nx >= 0 && nx < pw && bin[ny * pw + nx]) {
              v = 1
              break
            }
          }
        }
        dil[y * pw + x] = v
      }
    }
    // BFS 连通域
    var visited = new Uint8Array(pw * ph)
    var boxes = []
    var queue = new Int32Array(pw * ph)
    for (var start = 0; start < dil.length; start++) {
      if (!dil[start] || visited[start]) continue
      var head = 0
      var tail = 0
      queue[tail++] = start
      visited[start] = 1
      var minX = pw
      var minY = ph
      var maxX = 0
      var maxY = 0
      var count = 0
      while (head < tail) {
        var cur = queue[head++]
        var cy = (cur / pw) | 0
        var cx = cur % pw
        count++
        if (cx < minX) minX = cx
        if (cx > maxX) maxX = cx
        if (cy < minY) minY = cy
        if (cy > maxY) maxY = cy
        var nbrs = [cur - 1, cur + 1, cur - pw, cur + pw]
        for (var k = 0; k < 4; k++) {
          var n2 = nbrs[k]
          if (n2 < 0 || n2 >= dil.length || visited[n2] || !dil[n2]) continue
          if (Math.abs((n2 % pw) - cx) > 1) continue
          visited[n2] = 1
          queue[tail++] = n2
        }
      }
      if (count < 6) continue
      if (maxX - minX < 2 || maxY - minY < 2) continue
      var pad = 6
      boxes.push({
        x0: Math.max(0, Math.round(minX / ratio) - pad),
        y0: Math.max(0, Math.round(minY / ratio) - pad),
        x1: Math.min(origW, Math.round(maxX / ratio) + pad),
        y1: Math.min(origH, Math.round(maxY / ratio) + pad)
      })
    }
    boxes.sort(function (a, b) {
      return a.y0 - b.y0 || a.x0 - b.x0
    })
    return boxes
  }

  // ---------- rec：[-1,1] 归一化 + CTC 贪心 ----------
  function recText(crop) {
    if (crop.w < 4 || crop.h < 4) return ''
    var rh = REC_H
    var rw = Math.round((crop.w * rh) / crop.h)
    rw = Math.max(16, Math.min(REC_W_BUCKETS[REC_W_BUCKETS.length - 1], rw))
    var bucket = REC_W_BUCKETS.find(function (b) {
      return b >= rw
    })
    if (!bucket) bucket = REC_W_BUCKETS[REC_W_BUCKETS.length - 1]
    var data = resizeRgba(crop, rw, rh)
    var f32 = new Float32Array(3 * rh * bucket)
    var p = 0
    for (var c = 0; c < 3; c++) {
      for (var y = 0; y < rh; y++) {
        for (var x = 0; x < bucket; x++) {
          var i = (y * rw + x) * 4
          var v = x < rw ? data[i + c] : 255
          f32[p++] = (v / 255 - 0.5) / 0.5
        }
      }
    }
    var input = new ort.Tensor('float32', f32, [1, 3, rh, bucket])
    var feeds = {}
    feeds[recSession.inputNames[0]] = input
    return recSession.run(feeds).then(function (out) {
      var t = out[recSession.outputNames[0]]
      var logits = t.data
      var dims = t.dims
      var T = dims.length === 3 ? dims[1] : Math.round(logits.length / (keys.length + 2))
      var C = dims.length === 3 ? dims[2] : keys.length + 2
      var text = ''
      var prev = -1
      for (var tt = 0; tt < T; tt++) {
        var best = 0
        var bestV = -Infinity
        var off = tt * C
        for (var cc = 0; cc < C; cc++) {
          var val = logits[off + cc]
          if (val > bestV) {
            bestV = val
            best = cc
          }
        }
        if (best !== 0 && best !== prev) {
          if (best <= keys.length) text += keys[best - 1]
          else text += ' '
        }
        prev = best
      }
      return text.trim()
    })
  }

  /** 小区域直接 rec（按钮标签），深浅底自适应反色 */
  function recRegionText(full, rect) {
    var pad = 4
    var crop = cropRgba(full, Math.max(0, rect.x - pad), Math.max(0, rect.y - pad), rect.w + pad * 2, rect.h + pad * 2)
    var dark = 0
    var light = 0
    for (var i = 0; i < crop.data.length; i += 16) {
      var g = toGray(crop.data[i], crop.data[i + 1], crop.data[i + 2])
      if (g < 100) dark++
      else if (g > 170) light++
    }
    var invert = dark > light
    for (var j = 0; j < crop.data.length; j += 4) {
      var gg = toGray(crop.data[j], crop.data[j + 1], crop.data[j + 2])
      if (invert) gg = 255 - gg
      crop.data[j] = gg
      crop.data[j + 1] = gg
      crop.data[j + 2] = gg
    }
    return recText(crop)
  }

  // ---------- 顶层 API ----------
  async function recognizeFullPage(bytes) {
    var img = await decodePng(bytes)
    if (img.w < 8 || img.h < 8) return ''
    var dt = detTensor(img)
    var feeds = {}
    feeds[detSession.inputNames[0]] = dt.tensor
    var out = await detSession.run(feeds)
    var prob = out[detSession.outputNames[0]].data
    var boxes = detBoxes(prob, dt.rw, dt.rh, dt.ratio, img.w, img.h)
    // {y, text} 成对承载：空识别的框直接不参与行合并——
    // 此前 lines 只在非空时 push、合并却按 boxes 下标取，任一框识别为空后
    // 文本与 y 全部错位，整页 OCR 顺序/分行错乱（复核报告 P0-2）
    var items = []
    for (var i = 0; i < Math.min(boxes.length, 120); i++) {
      var b = boxes[i]
      var crop = cropRgba(img, b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0)
      var t = await recText(crop)
      if (t) items.push({ y: (b.y0 + b.y1) / 2, text: t })
    }
    // 按 y 合并成行
    var merged = []
    var lastY = -99
    for (var k = 0; k < items.length; k++) {
      var y = Math.round(items[k].y)
      if (Math.abs(y - lastY) <= 8 && merged.length) {
        merged[merged.length - 1] += ' ' + items[k].text
      } else {
        merged.push(items[k].text)
        lastY = y
      }
    }
    return merged.join('\n')
  }

  async function recognizeRegions(bytes, rects) {
    var img = await decodePng(bytes)
    var out = []
    for (var i = 0; i < rects.length; i++) {
      try {
        var t = await recRegionText(img, rects[i])
        out.push(t ? t.slice(0, 30) : null)
      } catch (e) {
        out.push(null)
      }
    }
    return out
  }

  // ---------- IPC ----------
  window.__ocrBridge.onRun(async function (msg) {
    var id = msg.id
    try {
      if (msg.init) {
        keys = new TextDecoder('utf-8')
          .decode(msg.keys)
          .split('\n')
          .map(function (l) {
            return l.replace(/\r$/, '')
          })
          .filter(function (l) {
            return l.length > 0
          })
        detSession = await ort.InferenceSession.create(msg.det, { executionProviders: ['wasm'] })
        recSession = await ort.InferenceSession.create(msg.rec, { executionProviders: ['wasm'] })
        window.__ocrBridge.result({ id: id, ok: true })
        return
      }
      if (!detSession) {
        window.__ocrBridge.result({ id: id, error: 'OCR 未初始化' })
        return
      }
      if (msg.regions) {
        var labels = await recognizeRegions(new Uint8Array(msg.png), msg.regions)
        window.__ocrBridge.result({ id: id, labels: labels })
      } else {
        var text = await recognizeFullPage(new Uint8Array(msg.png))
        window.__ocrBridge.result({ id: id, text: text })
      }
    } catch (e) {
      window.__ocrBridge.result({ id: id, error: String((e && e.message) || e) })
    }
  })

  window.__ocrBridge.ready()
})()
