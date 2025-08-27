// image.js — PDF image rendering (XObjects + inline) under text, no counter-scaling
// Requires: window.renderPage (your text/vector renderer) + fflate (unzlibSync)

(() => {
  const prevRender = window.renderPage;
  const TD = new TextDecoder('latin1');
  const TE = new TextEncoder();

  // ---------- small utils ----------
  function findBytes(hay, needle, start = 0) {
    const n = typeof needle === 'string' ? TE.encode(needle) : needle;
    for (let i = start; i <= hay.length - n.length; i++) {
      let ok = true;
      for (let j = 0; j < n.length; j++) if (hay[i + j] !== n[j]) { ok = false; break; }
      if (ok) return i;
    }
    return -1;
  }

  function extractDictAndStream(objectBytes) {
    let dictStart = -1;
    for (let i = 0; i < objectBytes.length - 1; i++) {
      if (objectBytes[i] === 60 && objectBytes[i + 1] === 60) { dictStart = i; break; } // "<<"
    }
    if (dictStart === -1) return { dictStr: null, streamStart: -1, streamEnd: -1 };

    // find matching ">>"
    let nest = 0, dictEnd = -1;
    for (let i = dictStart + 2; i < objectBytes.length - 1; i++) {
      if (objectBytes[i] === 60 && objectBytes[i + 1] === 60) { nest++; i++; }
      else if (objectBytes[i] === 62 && objectBytes[i + 1] === 62) {
        if (nest === 0) { dictEnd = i + 2; break; }
        nest--; i++;
      }
    }
    if (dictEnd === -1) return { dictStr: null, streamStart: -1, streamEnd: -1 };
    const dictStr = TD.decode(objectBytes.slice(dictStart, dictEnd));

    // stream…endstream
    const sOff = findBytes(objectBytes, 'stream', dictEnd);
    if (sOff === -1) return { dictStr, streamStart: -1, streamEnd: -1 };
    let streamStart = sOff + 6;
    while (streamStart < objectBytes.length) {
      const b = objectBytes[streamStart];
      if (b === 13 || b === 10 || b === 32) streamStart++; else break; // skip EOL/space
    }
    const eOff = findBytes(objectBytes, 'endstream', streamStart);
    if (eOff === -1) return { dictStr, streamStart, streamEnd: -1 };
    let streamEnd = eOff;
    while (streamEnd > streamStart) {
      const b = objectBytes[streamEnd - 1];
      if (b === 13 || b === 10 || b === 32) streamEnd--; else break;
    }
    return { dictStr, streamStart, streamEnd };
  }

  function parseNameArray(src, key) {
    const m = src.match(new RegExp(`/${key}\\s*\\[([^\\]]+)\\]`));
    if (!m) return null;
    const out = []; const re = /\/([A-Za-z0-9]+)\b/g; let mm;
    while ((mm = re.exec(m[1]))) out.push(mm[1]);
    return out;
  }
  function parseName(src, key) {
    const m = src.match(new RegExp(`/${key}\\s*/([A-Za-z0-9]+)\\b`));
    return m ? m[1] : null;
  }
  function parseNumber(src, key) {
    const m = src.match(new RegExp(`/${key}\\s+(-?\\d+(?:\\.\\d+)?)\\b`));
    return m ? +m[1] : null;
  }

  // ---------- content tokenizer (q/Q/cm/Do + BI/ID/EI) ----------
  function tokenizeContent(content) {
    const bytes = TE.encode(content || '');
    const txt = content || '';
    const tokens = [];
    let i = 0, len = txt.length;

    function skipWs() { while (i < len && /[\s\f]/.test(txt[i])) i++; }
    function readWord() { skipWs(); let j = i; while (j < len && !/[\s\f]/.test(txt[j])) j++; const w = txt.slice(i, j); i = j; return w; }

    while (i < len) {
      skipWs(); if (i >= len) break;

      if (txt.slice(i, i + 2) === 'BI') {
        i += 2;
        const idPos = txt.indexOf('ID', i); if (idPos === -1) break;
        const dictStr = txt.slice(i, idPos).trim();
        i = idPos + 2; if (i < len && /\s/.test(txt[i])) i++;
        const bytesStart = i; // latin1 index == byte index
        const endIdx = findBytes(bytes, TE.encode('EI'), bytesStart);
        if (endIdx === -1) break;
        const bin = bytes.slice(bytesStart, endIdx);
        tokens.push({ op: 'BI', args: [dictStr] });
        tokens.push({ op: 'INLINE', args: [bin] });
        tokens.push({ op: 'EI', args: [] });
        i = endIdx + 2; continue;
      }

      const w = readWord(); if (!w) break;
      if (w === 'q' || w === 'Q') { tokens.push({ op: w, args: [] }); continue; }
      if (w === 'cm') {
        const back = txt.slice(0, i);
        const m = back.match(/(-?\d*\.?\d+(?:e[+-]?\d+)?)\s+(-?\d*\.?\d+(?:e[+-]?\d+)?)\s+(-?\d*\.?\d+(?:e[+-]?\d+)?)\s+(-?\d*\.?\d+(?:e[+-]?\d+)?)\s+(-?\d*\.?\d+(?:e[+-]?\d+)?)\s+(-?\d*\.?\d+(?:e[+-]?\d+)?)\s+cm\s*$/i);
        if (m) tokens.push({ op: 'cm', args: m.slice(1, 7).map(Number) });
        continue;
      }
      if (w === 'Do') {
        const back = txt.slice(0, i);
        const m = back.match(/\/([A-Za-z0-9._-]+)\s+Do\s*$/);
        if (m) tokens.push({ op: 'Do', args: [m[1]] });
        continue;
      }
    }
    return tokens;
  }

  // ---------- matrix math ----------
  function mult(a, b) {
    return [
      a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1],
 a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3],
 a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]
    ];
  }
  const I = [1,0,0,1,0,0];

  // ---------- decoding ----------
  function flateDecode(u8) { try { return fflate.unzlibSync(u8); } catch { return null; } }
  function buildImageDataFromFlate(u8, w, h, bpc, cs) {
    if (bpc !== 8) throw new Error('Only 8-bit supported for Flate');
    const out = new ImageData(w, h);
    if (cs === 'DeviceGray') {
      if (u8.length < w*h) throw new Error('Gray too short');
      for (let i=0,p=0;i<w*h;i++,p+=4){ const v=u8[i]; out.data[p]=v; out.data[p+1]=v; out.data[p+2]=v; out.data[p+3]=255; }
    } else {
      if (u8.length < w*h*3) throw new Error('RGB too short');
      for (let i=0,p=0,q=0;i<w*h;i++,p+=4,q+=3){ out.data[p]=u8[q]; out.data[p+1]=u8[q+1]; out.data[p+2]=u8[q+2]; out.data[p+3]=255; }
    }
    return out;
  }
  function readObjectByOffset(objNum, xrefEntries, fileBytes) {
    const x = xrefEntries && xrefEntries.get(objNum);
    if (!x || x.type !== 'in-use') return null;
    const off = x.offset >>> 0;
    const end = findBytes(fileBytes, 'endobj', off);
    if (end === -1) return null;
    return fileBytes.subarray(off, end + 6); // include 'endobj'
  }

  // JPEG loader with canvas→img fallback (handles CMYK/ICC)
  async function loadJPEGElement(url, W, H) {
    const img = new Image(); img.decoding = 'async'; img.src = url;
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('JPEG load error')); });
    try {
      const cnv = document.createElement('canvas'); cnv.width = W; cnv.height = H;
      const ctx = cnv.getContext('2d'); ctx.drawImage(img, 0, 0, W, H); ctx.getImageData(0, 0, 1, 1);
      return { el: cnv, w: W, h: H };
    } catch {
      return { el: img, w: W, h: H }; // CMYK/ICC fallback
    }
  }

  async function decodeImageObject(objKey, params) {
    const [numStr] = objKey.split(' ');
    const num = +numStr;
    const raw = readObjectByOffset(num, params.xrefEntries, params.fileBytes);
    if (!raw) return null;

    const { dictStr, streamStart, streamEnd } = extractDictAndStream(raw);
    if (!dictStr || streamStart < 0 || streamEnd < 0) return null;

    // Determine image dimensions. Some PDFs omit or provide invalid values for
    // Width/Height. Parse them if present, but guard against missing or
    // non-positive values. If either dimension is not a valid positive number,
    // we return null to skip decoding rather than throwing a DOMException.
    const W   = parseNumber(dictStr, 'Width')  || parseNumber(dictStr, 'W');
    const H   = parseNumber(dictStr, 'Height') || parseNumber(dictStr, 'H');
    if (typeof W !== 'number' || W <= 0 || typeof H !== 'number' || H <= 0) {
      // Log a warning for debugging but do not attempt to decode the image. Some
      // XObjects specify only a bounding box and are not meant to be treated
      // as images by our simple decoder.
      console.warn('decodeImageObject: skipping image with invalid dimensions', { objKey, W, H });
      return null;
    }
    const BPC = parseNumber(dictStr, 'BitsPerComponent') || parseNumber(dictStr, 'BPC') || 8;
    const CS  = parseName(dictStr, 'ColorSpace') || 'DeviceRGB';
    const filters = parseNameArray(dictStr, 'Filter') || (parseName(dictStr, 'Filter') ? [parseName(dictStr, 'Filter')] : []);
    const data = raw.subarray(streamStart, streamEnd);

    // JPEG
    if (filters.includes('DCTDecode')) {
      const isJPEG = data.length > 3 && data[0] === 0xFF && data[1] === 0xD8 && data[data.length-2] === 0xFF && data[data.length-1] === 0xD9;
      if (isJPEG) {
        const blob = new Blob([data], { type: 'image/jpeg' });
        const url = URL.createObjectURL(blob);
        try { return await loadJPEGElement(url, W, H); }
        finally { URL.revokeObjectURL(url); }
      }
      // if mislabeled, try flate below
    }

    // Flate (8-bit Gray/RGB)
    if (filters.length === 0 || (filters.length === 1 && filters[0] === 'FlateDecode')) {
      const u8 = flateDecode(data); if (!u8) return null;
      const cs = (CS === 'DeviceGray') ? 'DeviceGray' : 'DeviceRGB';
      const idata = buildImageDataFromFlate(u8, W, H, BPC, cs);
      const cnv = document.createElement('canvas'); cnv.width = W; cnv.height = H;
      cnv.getContext('2d').putImageData(idata, 0, 0);
      return { el: cnv, w: W, h: H };
    }

    console.warn('Image filter not implemented:', filters);
    return null;
  }

  async function decodeInlineImage(dictStr, bin) {
    const W = parseNumber(dictStr, 'W');
    const H = parseNumber(dictStr, 'H');
    const BPC = parseNumber(dictStr, 'BPC') || 8;
    const CS = parseName(dictStr, 'ColorSpace') || 'DeviceRGB';
    const filters = parseNameArray(dictStr, 'Filter') || (parseName(dictStr,'Filter') ? [parseName(dictStr,'Filter')] : []);
    if (!W || !H) return null;

    if (filters.includes('DCTDecode')) {
      const blob = new Blob([bin], { type: 'image/jpeg' });
      const url = URL.createObjectURL(blob);
      try { return await loadJPEGElement(url, W, H); }
      finally { URL.revokeObjectURL(url); }
    }

    if (filters.length === 0 || (filters.length === 1 && filters[0] === 'FlateDecode')) {
      const u8 = flateDecode(bin); if (!u8) return null;
      const cs = (CS === 'DeviceGray') ? 'DeviceGray' : 'DeviceRGB';
      const id = buildImageDataFromFlate(u8, W, H, BPC, cs);
      const cnv = document.createElement('canvas'); cnv.width = W; cnv.height = H;
      cnv.getContext('2d').putImageData(id, 0, 0);
      return { el: cnv, w: W, h: H };
    }
    return null;
  }

  // ---------- find current page's /XObject map ----------
  function findCurrentPageAndXObjects(params) {
    let pageObj = null;
    for (const [, obj] of params.objects.entries()) {
      if (!/\/Type\s*\/Page\b/.test(obj.dict || '')) continue;

      const cm = (obj.dict || '').match(/\/Contents\s*(?:(\d+)\s+(\d+)\s+R|\[([\s\S]*?)\])/);
      let decoded = '';
      if (cm) {
        if (cm[1] && cm[2]) {
          const key = `${cm[1]} ${cm[2]}`; const co = params.objects.get(key);
          if (co && co.decoded) decoded = co.decoded.trim();
        } else if (cm[3]) {
          const refs = cm[3].match(/(\d+)\s+(\d+)\s+R/g) || [];
          for (const r of refs) {
            const m = r.match(/(\d+)\s+(\d+)\s+R/);
            const key = `${m[1]} ${m[2]}`; const co = params.objects.get(key);
            if (co && co.decoded) decoded += co.decoded.trim() + '\n';
          }
        }
      }
      if (decoded && decoded.trim() === (params.content || '').trim()) { pageObj = obj; break; }
    }
    if (!pageObj) return { pageObj: null, xobjs: null };

    const resMatch = (pageObj.dict || '').match(/\/Resources\s*(?:(\d+)\s+(\d+)\s+R|<<([\s\S]*?)>>)/);
    let resDict = '';
    if (resMatch) {
      if (resMatch[1] && resMatch[2]) {
        const rkey = `${resMatch[1]} ${resMatch[2]}`; const ro = params.objects.get(rkey);
        resDict = ro ? (ro.dict || '') : '';
      } else {
        resDict = resMatch[0];
      }
    }
    const xoMatch = resDict && resDict.match(/\/XObject\s*<<([\s\S]*?)>>/);
    if (!xoMatch) return { pageObj, xobjs: null };

    const map = new Map();
    const entRe = /\/([A-Za-z0-9._-]+)\s+(\d+)\s+(\d+)\s+R/g; let m;
    while ((m = entRe.exec(xoMatch[1]))) map.set(m[1], `${m[2]} ${m[3]}`);
    return { pageObj, xobjs: map };
  }

  // ---------- DOM/layering ----------
  function makeImageLayer(outCont) {
    let imgLayer = outCont.querySelector('.image-layer');
    if (!imgLayer) {
      imgLayer = document.createElement('div');
      imgLayer.className = 'image-layer';
      imgLayer.style.pointerEvents = 'none';
      imgLayer.style.position = 'absolute';
      imgLayer.style.left = '0';
      imgLayer.style.top = '0';
      imgLayer.style.width = '100%';
      imgLayer.style.height = '100%';
      imgLayer.style.zIndex = '1'; // behind your text (2/4/5)
outCont.appendChild(imgLayer);
    } else {
      imgLayer.innerHTML = '';
    }
    return imgLayer;
  }

  // Apply PDF cm as-is; outer container can scale/translate for zoom/pan.
  // Do NOT touch canvas width/height here (that clears pixels).
  function placeEl(layer, el, W, H, mtx) {
    const [a, b, c, d, e, f] = mtx;
    const holder = document.createElement('div');
    holder.style.position = 'absolute';
    holder.style.left = '0';
    holder.style.top  = '0';
    holder.style.width  = '1px';
    holder.style.height = '1px';
    holder.style.transformOrigin = '0 0';
    holder.style.transform = `matrix(${a}, ${b}, ${c}, ${d}, ${e}, ${f})`;
    holder.style.willChange = 'transform';

    el.style.display = 'block';
    el.style.width   = '1px';
    el.style.height  = '1px';
    el.style.userSelect    = 'none';
    el.style.pointerEvents = 'none';

    holder.appendChild(el);
    layer.appendChild(holder);
  }

  // ---------- main wrapper ----------
  window.renderPage = async function renderPageWithImages(params, outCont, wrapper) {
    // 1) render text/vector first
    if (typeof prevRender === 'function') {
      await prevRender(params, outCont, wrapper);
    }

    // 2) prepare image layer
    const imgLayer = makeImageLayer(outCont);

    // 3) tokenize + resources
    const { xobjs } = findCurrentPageAndXObjects(params);
    const tokens = tokenizeContent(params.content || '');

    // 4) graphics state
    let ctm = [1,0,0,1,0,0];
    const stack = [];

    // IMPORTANT: do NOT add extra y-flip here if your text layer already flipped.
    // If your text didn't flip coordinates, you can enable one page-level flip:
    // const pageH = params.pageHeight || 0;
    // ctm = mult(ctm, [1,0,0,-1,0,pageH]);

    for (let t = 0; t < tokens.length; t++) {
      const tok = tokens[t];
      switch (tok.op) {
        case 'q': stack.push(ctm.slice()); break;
        case 'Q': ctm = stack.length ? stack.pop() : [1,0,0,1,0,0]; break;
        case 'cm': ctm = mult(ctm, tok.args); break;

        case 'Do': {
          if (!xobjs) break;
          const name = tok.args[0];
          const key = xobjs.get(name);
          if (!key) break;

          let element = null, iw = 0, ih = 0;
          const obj = params.objects.get(key);

          if (obj && /\/Subtype\s*\/Image\b/.test(obj.dict || '')) {
            const W = parseNumber(obj.dict || '', 'Width') || parseNumber(obj.dict || '', 'W');
            const H = parseNumber(obj.dict || '', 'Height') || parseNumber(obj.dict || '', 'H');
            const BPC = parseNumber(obj.dict || '', 'BitsPerComponent') || 8;
            const cs = parseName(obj.dict || '', 'ColorSpace') || 'DeviceRGB';
            const filters = parseNameArray(obj.dict || '', 'Filter') || (parseName(obj.dict || '', 'Filter') ? [parseName(obj.dict || '', 'Filter')] : []);

            if (filters.length === 0 || (filters.length === 1 && filters[0] === 'FlateDecode')) {
              if (obj.decoded) {
                // decoded is latin1 string of raw samples
                const u8 = new Uint8Array(obj.decoded.length);
                for (let i = 0; i < obj.decoded.length; i++) u8[i] = obj.decoded.charCodeAt(i) & 255;
                const idata = buildImageDataFromFlate(u8, W, H, BPC, (cs === 'DeviceGray') ? 'DeviceGray' : 'DeviceRGB');
                const cnv = document.createElement('canvas'); cnv.width = W; cnv.height = H;
                cnv.getContext('2d').putImageData(idata, 0, 0);
                element = cnv; iw = W; ih = H;
              } else {
                const got = await decodeImageObject(key, params);
                if (got) { element = got.el; iw = got.w; ih = got.h; }
              }
            } else {
              const got = await decodeImageObject(key, params);
              if (got) { element = got.el; iw = got.w; ih = got.h; }
            }
          } else {
            const got = await decodeImageObject(key, params);
            if (got) { element = got.el; iw = got.w; ih = got.h; }
          }

          if (element) placeEl(imgLayer, element, iw, ih, ctm.slice());
          break;
        }

        case 'BI': {
          if (t + 1 < tokens.length && tokens[t + 1].op === 'INLINE') {
            const dictStr = tok.args[0];
            const bin = tokens[t + 1].args[0];
            const got = await decodeInlineImage(dictStr, bin);
            if (got) placeEl(imgLayer, got.el, got.w, got.h, ctm.slice());
          }
          break;
        }
      }
    }
  };
})();
