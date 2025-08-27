// text-vector.js
// Updated to integrate font parsing and handling for composite fonts like Type0/CIDFontType2.
// Includes font.js logic inline for simplicity.
// Handles hex strings in tokenizer, nested dicts in parser, pre-loads fonts from page resources.
// Decodes text using ToUnicode for composite fonts, handles TJ with sub-tokens.

(function() {

  /* ========= Font parsing logic (from font.js, integrated) ========= */

  // Tokenize for dicts (enhanced for nested, hex, etc.)
  function tokenizeDict(input) {
    let tokens = [],
      i = 0;
    while (i < input.length) {
      if (/\s/.test(input[i])) {
        i++;
        continue;
      }
      if (input[i] === '/') {
        let name = '/';
        i++;
        while (i < input.length && !/\s/.test(input[i]) && input[i] !== '/' && input[i] !== '[' && input[i] !== ']' && input[i] !== '<' && input[i] !== '>' && input[i] !== '(' && input[i] !== ')') {
          name += input[i];
          i++;
        }
        tokens.push({ type: 'name', value: name });
        continue;
      }
      if (input[i] === '(') {
        let str = '',
          depth = 1;
        i++;
        while (i < input.length && depth > 0) {
          if (input[i] === '\\') {
            i++;
            if (i < input.length) {
              const next = input[i];
              if (next === 'n') str += '\n';
              else if (next === '\\') str += '\\';
              else if (next === '(') str += '(';
              else if (next === ')') str += ')';
              else str += next;
              i++;
            }
          } else if (input[i] === '(') {
            depth++;
            str += '(';
            i++;
          } else if (input[i] === ')') {
            depth--;
            if (depth > 0) str += ')';
            i++;
          } else {
            str += input[i];
            i++;
          }
        }
        tokens.push({ type: 'string', value: str });
        continue;
      }
      if (input[i] === '<' && i + 1 < input.length && input[i + 1] === '<') {
        tokens.push({ type: 'dict_start', value: '<<' });
        i += 2;
        continue;
      }
      if (input[i] === '>' && i + 1 < input.length && input[i + 1] === '>') {
        tokens.push({ type: 'dict_end', value: '>>' });
        i += 2;
        continue;
      }
      if (input[i] === '<' && (i + 1 < input.length && input[i + 1] !== '<')) {
        let hex = '';
        i++;
        while (i < input.length && input[i] !== '>') {
          if (!/\s/.test(input[i])) hex += input[i];
          i++;
        }
        i++;
        if (hex.length % 2 === 1) hex += '0';
        const bytes = new Uint8Array(hex.length / 2);
        for (let k = 0; k < hex.length; k += 2) {
          bytes[k / 2] = parseInt(hex.substr(k, 2), 16);
        }
        tokens.push({ type: 'hexstring', bytes: bytes });
        continue;
      }
      if (input[i] === '[') {
        let subInput = '';
        let depth = 1;
        i++;
        while (i < input.length && depth > 0) {
          if (input[i] === '[') depth++;
          else if (input[i] === ']') depth--;
          if (depth > 0) subInput += input[i];
          i++;
        }
        const arrTokens = tokenizeDict(subInput.trim());
        tokens.push({ type: 'array', value: arrTokens });
        continue;
      }
      let tok = '';
      while (i < input.length && !/\s/.test(input[i]) && input[i] !== '/' && input[i] !== '[' && input[i] !== ']' && input[i] !== '<' && input[i] !== '>' && input[i] !== '(' && input[i] !== ')') {
        tok += input[i];
        i++;
      }
      if (tok === 'true' || tok === 'false') {
        tokens.push({ type: 'boolean', value: tok === 'true' });
      } else if (!isNaN(tok)) {
        tokens.push({ type: 'number', value: parseFloat(tok) });
      } else if (tok) {
        tokens.push({ type: 'operator', value: tok });
      }
    }
    return tokens;
  }

  // Parse dict tokens, recursive for nested
  function parseDictTokens(tokens) {
    const dict = new Map();
    let j = 0;
    while (j < tokens.length) {
      if (tokens[j].type === 'name') {
        const key = tokens[j].value.slice(1);
        j++;
        if (j >= tokens.length) break;
        let valToken = tokens[j];
        if (valToken.type === 'dict_start') {
          j++;
          const subTokens = [];
          let depth = 1;
          while (j < tokens.length && depth > 0) {
            if (tokens[j].type === 'dict_start') depth++;
            else if (tokens[j].type === 'dict_end') depth--;
            subTokens.push(tokens[j]);
            j++;
          }
          const subDict = parseDictTokens(subTokens);
          dict.set(key, { type: 'dict', value: subDict });
        } else if (valToken.type === 'array') {
          dict.set(key, { type: 'array', value: valToken.value });
          j++;
        } else if (valToken.type === 'number') {
          j++;
          if (j < tokens.length && tokens[j].type === 'number' && j + 1 < tokens.length && tokens[j].value === 'R' && tokens[j+1].type === 'operator') {
            dict.set(key, { type: 'ref', num: valToken.value, gen: tokens[j].value });
            j += 2;
          } else {
            dict.set(key, valToken);
          }
        } else {
          dict.set(key, valToken);
          j++;
        }
      } else j++;
    }
    return dict;
  }

  // Parse CMap
  function parseCMap(cmapStr) {
    const charMap = new Map();
    const lines = cmapStr.split(/\r?\n/);
    let inBfchar = false;
    let inBfrange = false;
    let inCodespace = false;
    let codeLength = 2;
    for (let line of lines) {
      line = line.trim();
      if (!line) continue;
      if (line === 'beginbfchar') { inBfchar = true; continue; }
      if (line === 'endbfchar') { inBfchar = false; continue; }
      if (line === 'beginbfrange') { inBfrange = true; continue; }
      if (line === 'endbfrange') { inBfrange = false; continue; }
      if (line === 'begincodespacerange') { inCodespace = true; continue; }
      if (line === 'endcodespacerange') { inCodespace = false; continue; }
      if (inCodespace) {
        const match = line.match(/<([0-9A-Fa-f]+)> <([0-9A-Fa-f]+)>/);
        if (match) codeLength = match[1].length / 2;
      }
      if (inBfchar) {
        const match = line.match(/<([0-9A-Fa-f]+)> <([0-9A-Fa-f]+)>/);
        if (match) charMap.set(parseInt(match[1], 16), String.fromCharCode(parseInt(match[2], 16)));
      }
      if (inBfrange) {
        const match = line.match(/<([0-9A-Fa-f]+)> <([0-9A-Fa-f]+)> <([0-9A-Fa-f]+)>/);
        if (match) {
          const start = parseInt(match[1], 16);
          const end = parseInt(match[2], 16);
          let base = parseInt(match[3], 16);
          for (let cid = start; cid <= end; cid++) {
            charMap.set(cid, String.fromCharCode(base++));
          }
        }
      }
    }
    return {
      map: charMap,
      codeLength,
      getUnicode: function(cid) { return this.map.get(cid) || '\ufffd'; }
    };
  }

  // Parse widths
  function parseWidths(wArrayTokens) {
    const widths = new Map();
    let idx = 0;
    while (idx < wArrayTokens.length) {
      if (wArrayTokens[idx].type !== 'number') {
        idx++;
        continue;
      }
      const first = wArrayTokens[idx++].value;
      if (wArrayTokens[idx].type === 'array') {
        const arr = wArrayTokens[idx++].value;
        let cid = first;
        for (let wt of arr) {
          if (wt.type === 'number') widths.set(cid++, wt.value);
        }
      } else if (wArrayTokens[idx].type === 'number' && idx + 1 < wArrayTokens.length && wArrayTokens[idx + 1].type === 'number') {
        const last = wArrayTokens[idx++].value;
        const width = wArrayTokens[idx++].value;
        for (let cid = first; cid <= last; cid++) widths.set(cid, width);
      }
    }
    return widths;
  }

  // Load font
  async function loadFont(fontRef, objects, fontCache) {
    if (fontCache.has(fontRef)) return fontCache.get(fontRef);
    const fontObj = objects.get(fontRef);
    if (!fontObj || !fontObj.dict) return null;
    const dictTokens = tokenizeDict(fontObj.dict);
    const fontDict = parseDictTokens(dictTokens);
    if (fontDict.get('Type')?.value !== 'Font') return null;
    const subtype = fontDict.get('Subtype')?.value;
    const baseFontVal = fontDict.get('BaseFont');
    let baseFont = baseFontVal ? baseFontVal.value : 'sans-serif';
    let fontFamily = baseFont.replace(/^[A-Z]{6}\+/, '');
    let fontUrl = null;
    let toUnicode = null;
    let widths = new Map();
    let dw = 1000;
    let codeLength = subtype === 'Type0' ? 2 : 1;
    let isComposite = subtype === 'Type0';
    const tuEntry = fontDict.get('ToUnicode');
    if (tuEntry && tuEntry.type === 'ref') {
      const tuRef = `${tuEntry.num} ${tuEntry.gen}`;
      const tuObj = objects.get(tuRef);
      if (tuObj && tuObj.decoded) {
        const cmapStr = new TextDecoder().decode(new Uint8Array(tuObj.decoded));
        toUnicode = parseCMap(cmapStr);
        codeLength = toUnicode.codeLength;
      }
    }
    let fontFormat = 'truetype';
    if (subtype === 'Type0') {
      const descFonts = fontDict.get('DescendantFonts');
      if (descFonts && descFonts.type === 'array' && descFonts.value.length) {
        const descVal = descFonts.value[0];
        const descRef = descVal.type === 'ref' ? `${descVal.num} ${descVal.gen}` : (descFonts.value.length >= 3 && descFonts.value[2].value === 'R' ? `${descFonts.value[0].value} ${descFonts.value[1].value}` : null);
        if (descRef) {
          const descObj = objects.get(descRef);
          if (descObj && descObj.dict) {
            const descTokens = tokenizeDict(descObj.dict);
            const descDict = parseDictTokens(descTokens);
            const cidSubtype = descDict.get('Subtype')?.value;
            dw = descDict.get('DW')?.value || 1000;
            const wVal = descDict.get('W');
            if (wVal && wVal.type === 'array') widths = parseWidths(wVal.value);
            const fdVal = descDict.get('FontDescriptor');
            if (fdVal && fdVal.type === 'ref') {
              const fdRef = `${fdVal.num} ${fdVal.gen}`;
              const fdObj = objects.get(fdRef);
              if (fdObj && fdObj.dict) {
                const fdTokens = tokenizeDict(fdObj.dict);
                const fdDict = parseDictTokens(fdTokens);
                let ffKey = cidSubtype === 'CIDFontType2' ? 'FontFile2' : (cidSubtype === 'CIDFontType0' ? 'FontFile3' : null);
                if (ffKey) {
                  fontFormat = cidSubtype === 'CIDFontType2' ? 'truetype' : 'opentype';
                  const ffVal = fdDict.get(ffKey);
                  if (ffVal && ffVal.type === 'ref') {
                    const ffRef = `${ffVal.num} ${ffVal.gen}`;
                    const ffObj = objects.get(ffRef);
                    if (ffObj && ffObj.decoded) {
                      const fontData = new Uint8Array(ffObj.decoded);
                      const blob = new Blob([fontData], { type: `font/${fontFormat}` });
                      fontUrl = URL.createObjectURL(blob);
                      const styleId = `font-${fontRef.replace(' ', '-')}`;
                      if (!document.getElementById(styleId)) {
                        const style = document.createElement('style');
                        style.id = styleId;
                        style.textContent = `@font-face { font-family: "${fontFamily}"; src: url(${fontUrl}) format('${fontFormat}'); }`;
                        document.head.appendChild(style);
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    } // Add handling for simple fonts if needed
    const cachedFont = {
      fontFamily,
      url: fontUrl,
      isComposite,
      codeLength,
      toUnicode,
      widths,
      dw
    };
    fontCache.set(fontRef, cachedFont);
    return cachedFont;
  }

  /* ========= Updated decodePdfString with full escapes ========= */
  function decodePdfString(inner) {
    let out = '';
    for (let i = 0; i < inner.length; i++) {
      let ch = inner[i];
      if (ch === '\\') {
        i++;
        if (i >= inner.length) break;
        const n = inner[i];
        if (/[0-7]/.test(n)) {
          let oct = n;
          i++;
          if (i < inner.length && /[0-7]/.test(inner[i])) {
            oct += inner[i];
            i++;
            if (i < inner.length && /[0-7]/.test(inner[i])) {
              oct += inner[i];
            } else i--;
          } else i--;
          out += String.fromCharCode(parseInt(oct, 8));
        } else if (n === 'n') out += '\n';
        else if (n === 'r') out += '\r';
        else if (n === 't') out += '\t';
        else if (n === 'b') out += '\b';
        else if (n === 'f') out += '\f';
        else if (n === '\\') out += '\\';
        else if (n === '(') out += '(';
        else if (n === ')') out += ')';
        else if (n === '\n' || n === '\r') {
          // skip
        } else out += n;
      } else {
        out += ch;
      }
    }
    return out;
  }

  /* ========= Text decoding helper ========= */
  function getTextFromToken(token, cachedFont) {
    let bytes;
    if (token.type === 'hexstring') {
      bytes = token.bytes;
    } else if (token.type === 'string') {
      const str = decodePdfString(token.value);
      bytes = new Uint8Array(str.length);
      for (let j = 0; j < str.length; j++) {
        bytes[j] = str.charCodeAt(j) & 0xff;
      }
    } else {
      return '';
    }
    if (cachedFont && cachedFont.isComposite) {
      let text = '';
      const cl = cachedFont.codeLength;
      for (let j = 0; j < bytes.length; j += cl) {
        let cid = 0;
        for (let k = 0; k < cl; k++) {
          cid = (cid << 8) | (bytes[j + k] || 0);
        }
        text += cachedFont.toUnicode ? cachedFont.toUnicode.getUnicode(cid) : String.fromCharCode(cid);
      }
      return text;
    } else {
      // For simple fonts, approximate
      return String.fromCharCode(...bytes);
    }
  }

  /* ========= Original code with updates ========= */

  // Math & Color utilities...
  function multiplyMatrix(m1, m2) {
    return [
      m1[0] * m2[0] + m1[2] * m2[1], m1[1] * m2[0] + m1[3] * m2[1],
      m1[0] * m2[2] + m1[2] * m2[3], m1[1] * m2[2] + m1[3] * m2[3],
      m1[0] * m2[4] + m1[2] * m2[5] + m1[4], m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
    ];
  }

  function translationMatrix(dx, dy) {
    return [1, 0, 0, 1, dx, dy];
  }

  function transformPoint(x, y, matrix) {
    return [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]];
  }
  const identity = [1, 0, 0, 1, 0, 0];

  function cmykToRgb(c, m, y, k) {
    const r = (1 - c) * (1 - k);
    const g = (1 - m) * (1 - k);
    const b = (1 - y) * (1 - k);
    return [r, g, b];
  }

  // Tokenizer updated to handle hexstrings and recursive arrays
  function tokenize(input) {
    let tokens = [],
      i = 0;
    while (i < input.length) {
      if (/\s/.test(input[i])) {
        i++;
        continue;
      }
      if (input[i] === '(') {
        let str = '',
          depth = 1;
        i++;
        while (i < input.length && depth > 0) {
          if (input[i] === '\\') {
            if (i + 1 < input.length) {
              const next = input[i + 1];
              if (next === '\\') str += '\\';
              else if (next === 'n') str += '\n';
              else str += next;
              i += 2;
            } else i++;
          } else if (input[i] === '(') {
            depth++;
            str += '(';
            i++;
          } else if (input[i] === ')') {
            depth--;
            if (depth > 0) str += ')';
            i++;
          } else {
            str += input[i];
            i++;
          }
        }
        tokens.push({
          type: 'string',
          value: str
        });
        continue;
      }
      if (input[i] === '<' && i + 1 < input.length && input[i + 1] !== '<') {
        let hex = '';
        i++;
        while (i < input.length && input[i] !== '>') {
          if (!/\s/.test(input[i])) hex += input[i];
          i++;
        }
        i++;
        if (hex.length % 2 === 1) hex += '0';
        const bytes = new Uint8Array(hex.length / 2);
        for (let k = 0; k < hex.length; k += 2) {
          bytes[k / 2] = parseInt(hex.substr(k, 2), 16);
        }
        tokens.push({ type: 'hexstring', bytes });
        continue;
      }
      if (input[i] === '[') {
        let subInput = '';
        let depth = 1;
        i++;
        while (i < input.length && depth > 0) {
          if (input[i] === '[') depth++;
          else if (input[i] === ']') depth--;
          if (depth > 0) subInput += input[i];
          i++;
        }
        const arrTokens = tokenize(subInput.trim());
        tokens.push({ type: 'array', value: arrTokens });
        continue;
      }
      let tok = '';
      while (i < input.length && !/\s/.test(input[i]) && input[i] !== '(' && input[i] !== '[' && input[i] !== '<' && input[i] !== '>') {
        tok += input[i];
        i++;
      }
      if (tok.length === 0) {
        i++;
        continue;
      }
      if (!isNaN(tok)) tokens.push({
        type: 'number',
        value: parseFloat(tok)
      });
      else tokens.push({
        type: 'operator',
        value: tok
      });
    }
    return tokens;
  }

  // RenderLayer...
  class RenderLayer {
    constructor(container, zIndex, pageHeight) {
      this.pageHeight = pageHeight;
      this.div = document.createElement('div');
      this.div.className = 'layer';
      this.div.style.zIndex = zIndex;
      container.appendChild(this.div);
      this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      this.svg.setAttribute('width', '100%');
      this.svg.setAttribute('height', '100%');
      this.svg.style.position = 'absolute';
      this.div.appendChild(this.svg);
      this.currentPathData = '';
      this.segments = [];
      this.textFragment = document.createDocumentFragment();
    }
    // moveTo, lineTo, curveTo, rect, closePath, addPathSegment, clearPath, addTextElement, renderAll - same as original
    moveTo(x, y) {
      const svgY = this.pageHeight - y;
      this.currentPathData += `M ${x} ${svgY} `;
    }
    lineTo(x, y) {
      const svgY = this.pageHeight - y;
      this.currentPathData += `L ${x} ${svgY} `;
    }
    curveTo(x1, y1, x2, y2, x3, y3) {
      const h = this.pageHeight;
      this.currentPathData += `C ${x1} ${h - y1} ${x2} ${h - y2} ${x3} ${h - y3} `;
    }
    rect(x, y, w, h) {
      const svgY = this.pageHeight - y - h;
      this.currentPathData += `M ${x} ${svgY} L ${x + w} ${svgY} L ${x + w} ${svgY + h} L ${x} ${svgY + h} Z `;
    }
    closePath() {
      this.currentPathData += 'Z ';
    }
    addPathSegment(type, options) {
      if (this.currentPathData.trim() !== '') {
        this.segments.push({
          d: this.currentPathData.trim(),
          type,
          ...options
        });
      }
    }
    clearPath() {
      this.currentPathData = '';
    }
    addTextElement(elem) {
      this.textFragment.appendChild(elem);
    }
    renderAll() {
      for (const seg of this.segments) {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', seg.d);
        if (seg.type === 'fill') {
          path.setAttribute('fill', seg.color);
          path.setAttribute('stroke', 'none');
        } else {
          path.setAttribute('fill', 'none');
          path.setAttribute('stroke', seg.color);
          if (seg.width !== undefined) path.setAttribute('stroke-width', seg.width);
          if (seg.cap !== undefined) path.setAttribute('stroke-linecap', seg.cap);
          if (seg.join !== undefined) path.setAttribute('stroke-linejoin', seg.join);
          if (seg.miter !== undefined) path.setAttribute('stroke-miterlimit', seg.miter);
          if (seg.dash && seg.dash.array.length > 0) {
            path.setAttribute('stroke-dasharray', seg.dash.array.join(' '));
            path.setAttribute('stroke-dashoffset', seg.dash.phase);
          }
        }
        this.svg.appendChild(path);
      }
      if (this.textFragment.childNodes.length) this.svg.appendChild(this.textFragment);
    }
  }

  // removeEmptyLayers, computeContentBBox, updateCanvasScale - same
  function removeEmptyLayers(container) {
    container.querySelectorAll('.layer').forEach(layer => {
      const svg = layer.querySelector('svg');
      if (!svg || svg.children.length === 0) layer.remove();
    });
  }

  function computeContentBBox(container, defaultWidth, defaultHeight) {
    const svgs = container.querySelectorAll('.layer svg');
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, ok = false;
    svgs.forEach(svg => {
      Array.from(svg.children).forEach(ch => {
        try {
          const b = ch.getBBox();
          if (isFinite(b.x) && isFinite(b.y) && b.width > 0 && b.height > 0) {
            minX = Math.min(minX, b.x);
            minY = Math.min(minY, b.y);
            maxX = Math.max(maxX, b.x + b.width);
            maxY = Math.max(maxY, b.y + b.height);
            ok = true;
          }
        } catch (e) {}
      });
    });
    return ok ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY } : { x: 0, y: 0, width: defaultWidth, height: defaultHeight };
  }

  function updateCanvasScale(container, wrapper, defaultWidth, defaultHeight) {
    const bbox = computeContentBBox(container, defaultWidth, defaultHeight);
    const availableWidth = wrapper.clientWidth, availableHeight = wrapper.clientHeight;
    const margin = 24;
    const contentW = bbox.width + margin * 2, contentH = bbox.height + margin * 2;
    const scale = Math.min((availableWidth - 8) / contentW, (availableHeight - 8) / contentH);
    const translateX = (availableWidth - contentW * scale) / 2 - bbox.x * scale + margin;
    const translateY = (availableHeight - contentH * scale) / 2 - bbox.y * scale + margin;
    container.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
  }

  // renderImage - same, can be updated similarly for resource resolution if needed
  async function renderImage(opts, xref, container, x, y, width, height) {
    const { xrefEntries, objects, fileBytes } = opts;
    const entry = xrefEntries.get(xref);
    if (!entry || entry.type !== 'in-use') {
      console.warn(`Image XRef entry ${xref} not found or not in-use`);
      return;
    }
    const obj = objects.get(`${entry.num} ${entry.gen}`);
    if (!obj || !obj.processed || !obj.decoded || !obj.dict || !obj.dict.includes('/Subtype /Image') || !obj.dict.includes('/Filter /DCTDecode')) {
      console.warn(`Image object for XRef ${xref} is not a valid, processed JPEG image.`);
      return;
    }
    try {
      const img = document.createElement('img');
      img.src = `data:image/jpeg;base64,${btoa(String.fromCharCode.apply(null, new Uint8Array(obj.decoded)))}`;
      img.style.position = 'absolute';
      img.style.left = `${x}px`;
      img.style.top = `${y}px`;
      img.style.width = `${width}px`;
      img.style.height = `${height}px`;
      container.appendChild(img);
    } catch (error) {
      console.error(`Error rendering image: ${error.message}`);
    }
  }

  // renderPage updated
  async function renderPage(opts, outputContainer, viewportWrapper) {
    const content = opts.content || '';
    const pageWidth = Math.max(1, Math.floor(opts.width || 612));
    const pageHeight = Math.max(1, Math.floor(opts.height || 792));
    const fontCache = opts.fontCache || new Map();
    const objects = opts.objects || new Map();
    const pageDict = opts.pageDict || ''; // Add pageDict to opts

    // Load fonts from resources
    const fontMap = new Map();
    if (pageDict && objects.size > 0) {
      const pageTokens = tokenizeDict(pageDict);
      const pageD = parseDictTokens(pageTokens);
      let resVal = pageD.get('Resources');
      let resD;
      if (resVal.type === 'ref') {
        const resRef = `${resVal.num} ${resVal.gen}`;
        const resObj = objects.get(resRef);
        if (resObj && resObj.dict) {
          const resTokens = tokenizeDict(resObj.dict);
          resD = parseDictTokens(resTokens);
        }
      } else if (resVal.type === 'dict') {
        resD = resVal.value;
      }
      if (resD) {
        let fontVal = resD.get('Font');
        let fontSubDict;
        if (fontVal.type === 'dict') fontSubDict = fontVal.value;
        if (fontSubDict) {
          const fontPromises = [];
          for (let [key, val] of fontSubDict) {
            if (val.type === 'ref') {
              const fRef = `${val.num} ${val.gen}`;
              fontMap.set('/' + key, fRef);
              fontPromises.push(loadFont(fRef, objects, fontCache));
            }
          }
          await Promise.all(fontPromises);
        }
      }
    }

    // Engine state...
    let globalTransform = identity.slice();
    let textTransform = identity.slice();
    let stateStack = [];
    let currentFont = 'sans-serif',
      currentFontSize = 12,
      currentTextScale = 1.0;
    let currentFillRGB = [0, 0, 0];
    let currentVectorFill = '#000000',
      currentVectorStroke = '#000000';
    let currentLineWidth = 1.0,
      currentLineCap = 'butt',
      currentLineJoin = 'miter',
      currentMiterLimit = 10.0;
    let currentDashPattern = { array: [], phase: 0 };
    let initialTextOrigin = [0, 0];
    let layers = [], currentLayer = null;
    let inText = false;
    let currentStrokeCS = 'DeviceRGB', currentNonStrokeCS = 'DeviceRGB';

    outputContainer.innerHTML = '';
    layers = [];
    currentLayer = new RenderLayer(outputContainer, layers.length, pageHeight);
    layers.push(currentLayer);

    const tokens = tokenize(content);

    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.type === 'operator' && (t.value === 'BT' || t.value === 'q')) {
        currentLayer = new RenderLayer(outputContainer, layers.length, pageHeight);
        layers.push(currentLayer);
      }

      // Colors - same

      
if (t.type === 'operator') {
  const colorOp = t.value;

  // --- Device shortcuts ---
  if (colorOp === 'rg' || colorOp === 'RG' || colorOp === 'g' || colorOp === 'G' || colorOp === 'k' || colorOp === 'K') {
    let r = 0, g = 0, b = 0, isStroke = (colorOp === 'RG' || colorOp === 'G' || colorOp === 'K');
    if (colorOp === 'rg' || colorOp === 'RG') {
      if (i >= 3) [r, g, b] = [tokens[i - 3].value, tokens[i - 2].value, tokens[i - 1].value];
      if (isStroke) currentStrokeCS = 'DeviceRGB'; else currentNonStrokeCS = 'DeviceRGB';
    } else if (colorOp === 'g' || colorOp === 'G') {
      if (i >= 1) {
        const gr = tokens[i - 1].value;
        [r, g, b] = [gr, gr, gr];
      }
      if (isStroke) currentStrokeCS = 'DeviceGray'; else currentNonStrokeCS = 'DeviceGray';
    } else if (colorOp === 'k' || colorOp === 'K') {
      if (i >= 4) {
        const C = tokens[i - 4].value, M = tokens[i - 3].value, Y = tokens[i - 2].value, K = tokens[i - 1].value;
        r = 1 - Math.min(1, C + K);
        g = 1 - Math.min(1, M + K);
        b = 1 - Math.min(1, Y + K);
      }
      if (isStroke) currentStrokeCS = 'DeviceCMYK'; else currentNonStrokeCS = 'DeviceCMYK';
    }
    const toHex = (n) => Math.round(n * 255).toString(16).padStart(2, '0');
    const hexColor = '#' + toHex(r) + toHex(g) + toHex(b);
    if (isStroke) {
      currentVectorStroke = hexColor;
    } else {
      currentFillRGB = [r, g, b];
      currentVectorFill = hexColor;
    }
    // Do not return; allow other ops in same token to evaluate
  }

  // --- Color space selection ---
  if (colorOp === 'cs' || colorOp === 'CS') {
    const csNameTok = i >= 1 ? tokens[i - 1] : null;
    const name = (csNameTok && (csNameTok.type === 'name' || csNameTok.type === 'operator')) ? String(csNameTok.value).replace(/^\//, '') : 'DeviceRGB';
    if (colorOp === 'cs') currentNonStrokeCS = name; else currentStrokeCS = name;
  }

  // --- Generic color values for current color spaces ---
  if (colorOp === 'sc' || colorOp === 'SC' || colorOp === 'scn' || colorOp === 'SCN') {
    // pull preceding numeric operands
    const nums = [];
    let k2 = i - 1;
    while (k2 >= 0 && tokens[k2].type === 'number') { nums.unshift(tokens[k2].value); k2--; }
    const isStroke2 = (colorOp === 'SC' || colorOp === 'SCN');
    const cs = isStroke2 ? currentStrokeCS : currentNonStrokeCS;
    let r=0,g=0,b=0;
    if (cs === 'DeviceGray' && nums.length>=1) {
      // Single gray component applies equally to R/G/B
      r = g = b = nums[0];
    } else if (cs === 'DeviceRGB' && nums.length>=3) {
      // Standard RGB color space
      r = nums[0];
      g = nums[1];
      b = nums[2];
    } else if (cs === 'DeviceCMYK' && nums.length>=4) {
      // Convert CMYK components to RGB via simple subtraction model
      const C = nums[0], M = nums[1], Y = nums[2], K = nums[3];
      r = 1 - Math.min(1, C + K);
      g = 1 - Math.min(1, M + K);
      b = 1 - Math.min(1, Y + K);
    } else if (nums.length >= 3) {
      // Unknown or named color space: assume RGB for up to first 3 numeric values
      r = nums[0];
      g = nums[1];
      b = nums[2];
    }
    const toHex = (n) => Math.round(n * 255).toString(16).padStart(2, '0');
    const hexColor = '#' + toHex(r) + toHex(g) + toHex(b);
    if (isStroke2) currentVectorStroke = hexColor;
    else { currentFillRGB = [r,g,b]; currentVectorFill = hexColor; }
  }
}

      // Vector path ops
      if (t.type === 'operator') {
        const op = t.value;
        if (op === 'm' && i >= 2) {
          const [x, y] = transformPoint(tokens[i - 2].value, tokens[i - 1].value, globalTransform);
          currentLayer.moveTo(x, y);
          continue;
        }
        if (op === 'l' && i >= 2) {
          const [x, y] = transformPoint(tokens[i - 2].value, tokens[i - 1].value, globalTransform);
          currentLayer.lineTo(x, y);
          continue;
        }
        if (op === 'c' && i >= 6) {
          const [x1, y1] = transformPoint(tokens[i - 6].value, tokens[i - 5].value, globalTransform);
          const [x2, y2] = transformPoint(tokens[i - 4].value, tokens[i - 3].value, globalTransform);
          const [x3, y3] = transformPoint(tokens[i - 2].value, tokens[i - 1].value, globalTransform);
          currentLayer.curveTo(x1, y1, x2, y2, x3, y3);
          continue;
        }
        if (op === 're' && i >= 4) {
          const [x, y] = transformPoint(tokens[i - 4].value, tokens[i - 3].value, globalTransform);
          const w = tokens[i - 2].value * Math.abs(globalTransform[0]);
          const h = tokens[i - 1].value * Math.abs(globalTransform[3]);
          currentLayer.rect(x, y, w, h);
          continue;
        }
        if (op === 'h') {
          currentLayer.closePath();
          continue;
        }
        if (op === 'f' || op === 'f*') {
          currentLayer.addPathSegment('fill', { color: currentVectorFill });
          currentLayer.clearPath();
          continue;
        }
        if (op === 'S') {
          currentLayer.addPathSegment('stroke', { color: currentVectorStroke, width: currentLineWidth, cap: currentLineCap, join: currentLineJoin, miter: currentMiterLimit, dash: currentDashPattern });
          currentLayer.clearPath();
          continue;
        }
        if (op === 's') {
          currentLayer.closePath();
          currentLayer.addPathSegment('stroke', { color: currentVectorStroke, width: currentLineWidth, cap: currentLineCap, join: currentLineJoin, miter: currentMiterLimit, dash: currentDashPattern });
          currentLayer.clearPath();
          continue;
        }
        if (op === 'B') {
          currentLayer.addPathSegment('fill', { color: currentVectorFill });
          currentLayer.addPathSegment('stroke', { color: currentVectorStroke, width: currentLineWidth, cap: currentLineCap, join: currentLineJoin, miter: currentMiterLimit, dash: currentDashPattern });
          currentLayer.clearPath();
          continue;
        }
        if (op === 'n') {
          currentLayer.clearPath();
          continue;
        }
      }

      // Graphics state - same
      if (t.type === 'operator') {
        const op = t.value;
        if (op === 'w' && i >= 1) {
          currentLineWidth = tokens[i - 1].value;
          continue;
        }
        if (op === 'J' && i >= 1) {
          currentLineCap = ['butt', 'round', 'square'][tokens[i - 1].value] || 'butt';
          continue;
        }
        if (op === 'j' && i >= 1) {
          currentLineJoin = ['miter', 'round', 'bevel'][tokens[i - 1].value] || 'miter';
          continue;
        }
        if (op === 'M' && i >= 1) {
          currentMiterLimit = tokens[i - 1].value;
          continue;
        }
        if (op === 'd' && i >= 2 && tokens[i - 2].type === 'array') {
          currentDashPattern.array = tokens[i - 2].value.map(t => t.type === 'number' ? t.value : 0);
          currentDashPattern.phase = tokens[i - 1].value;
          continue;
        }
      }

      // Text - updated for Tf, Tj, TJ
      if (t.type === 'operator' && t.value === 'BT') {
        inText = true;
        textTransform = identity.slice();
        initialTextOrigin = [0, 0];
        continue;
      }
      if (t.type === 'operator' && t.value === 'ET') {
        inText = false;
        continue;
      }

      if (inText) {
        if (t.type === 'operator' && t.value === 'Tf' && i >= 2) {
          currentFontSize = tokens[i - 1].value;
          const fontToken = tokens[i - 2];
          let fn = fontToken.type === 'operator' || fontToken.type === 'name' ? fontToken.value : '/Unknown';
          if (!fn.startsWith('/')) fn = '/' + fn;
          const fontRef = fontMap.get(fn);
          const cachedFont = fontRef ? fontCache.get(fontRef) : null;
          currentFont = cachedFont ? cachedFont.fontFamily : fn.slice(1);
          continue;
        }
        if (t.type === 'operator' && t.value === 'Tm' && i >= 6) {
          textTransform = [tokens[i - 6].value, tokens[i - 5].value, tokens[i - 4].value, tokens[i - 3].value, tokens[i - 2].value, tokens[i - 1].value];
          initialTextOrigin = [textTransform[4], textTransform[5]];
          continue;
        }
        if (t.type === 'operator' && (t.value === 'Td' || t.value === 'TD') && i >= 2) {
          const dx = tokens[i - 2].value, dy = tokens[i - 1].value;
          textTransform = multiplyMatrix(textTransform, translationMatrix(dx, dy));
          if (t.value === 'TD') {
            initialTextOrigin = [textTransform[4], textTransform[5]];
          }
          continue;
        }
        if (t.type === 'operator' && t.value === 'Tz' && i >= 1) {
          currentTextScale = tokens[i - 1].value / 100.0;
          continue;
        }
        if (t.type === 'operator' && t.value === "Tj" && i >= 1) {
          const token = tokens[i - 1];
          if (token.type === 'string' || token.type === 'hexstring') {
            emitText(token);
          }
          continue;
        }
        if (t.type === 'operator' && t.value === "TJ" && i >= 1) {
          const arrToken = tokens[i - 1];
          if (arrToken.type === 'array') {
            emitTJ(arrToken.value);
          }
          continue;
        }
        if (t.type === 'operator' && t.value === "'" && i >= 1) {
          textTransform[4] = initialTextOrigin[0];
          textTransform[5] -= currentFontSize;
          initialTextOrigin[1] -= currentFontSize;
          const token = tokens[i - 1];
          if (token.type === 'string' || token.type === 'hexstring') {
            emitText(token);
          }
          continue;
        }
      }

      // State stack - same
      if (t.type === 'operator' && t.value === 'q') {
        stateStack.push({
          g: globalTransform.slice(),
          t: textTransform.slice(),
          f: currentFont,
          fs: currentFontSize,
          ts: currentTextScale,
          fill: [...currentFillRGB],
          o: [...initialTextOrigin],
          vecFill: currentVectorFill,
          vecStroke: currentVectorStroke,
          lw: currentLineWidth,
          lc: currentLineCap,
          lj: currentLineJoin,
          ml: currentMiterLimit,
          dp: { ...currentDashPattern },
          strokeCS: currentStrokeCS,
          nonStrokeCS: currentNonStrokeCS
        });
        continue;
      }
      if (t.type === 'operator' && t.value === 'Q') {
        const s = stateStack.pop();
        if (s) {
          globalTransform = s.g;
          textTransform = s.t;
          currentFont = s.f;
          currentFontSize = s.fs;
          currentTextScale = s.ts;
          currentFillRGB = s.fill;
          initialTextOrigin = s.o;
          currentVectorFill = s.vecFill;
          currentVectorStroke = s.vecStroke;
          currentLineWidth = s.lw;
          currentLineCap = s.lc;
          currentLineJoin = s.lj;
          currentMiterLimit = s.ml;
          currentDashPattern = s.dp;
          if (s.strokeCS) currentStrokeCS = s.strokeCS;
          if (s.nonStrokeCS) currentNonStrokeCS = s.nonStrokeCS;
        }
        currentLayer = new RenderLayer(outputContainer, layers.length, pageHeight);
        layers.push(currentLayer);
        continue;
      }
      if (t.type === 'operator' && t.value === 'cm' && i >= 6) {
        const m = [tokens[i - 6].value, tokens[i - 5].value, tokens[i - 4].value, tokens[i - 3].value, tokens[i - 2].value, tokens[i - 1].value];
        globalTransform = multiplyMatrix(globalTransform, m);
        continue;
      }

      // Image - log for now, can update similar to fonts
      if (t.type === 'operator' && t.value === 'Do') {
        if (i >= 1 && (tokens[i - 1].type === 'operator' || tokens[i - 1].type === 'name')) {
          // For an external XObject invocation via Do, the referenced name may
          // correspond to an image or form. Image decoding is handled in image.js.
          // We do not log here to avoid cluttering the console.
        }
        continue;
      }
    }

    // Helpers updated
    function currentEffectiveTransform() {
      const scaleMat = [currentTextScale, 0, 0, 1, 0, 0];
      const scaledTextMat = multiplyMatrix(scaleMat, textTransform);
      return multiplyMatrix(globalTransform, scaledTextMat);
    }

    function emitText(token) {
      const eff = currentEffectiveTransform();
      const tx = eff[4], ty = eff[5], a = eff[0], bVal = eff[1];
      const scale = Math.hypot(a, bVal) || 1;
      const angleDeg = -Math.atan2(bVal, a) * 180 / Math.PI;
      const svgY = pageHeight - ty;
      const textElem = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      textElem.setAttribute('x', tx);
      textElem.setAttribute('y', svgY);
      textElem.setAttribute('transform', `rotate(${angleDeg}, ${tx}, ${svgY})`);
      textElem.setAttribute('font-family', currentFont);
      textElem.setAttribute('font-size', (currentFontSize * scale) + 'px');
      // Apply fill based on current non-stroking color.  Clamp values to [0,255] to produce valid CSS rgb().
      const [r, g, b] = currentFillRGB;
      const to255 = v => Math.max(0, Math.min(255, Math.round(v * 255)));
      textElem.setAttribute('fill', `rgb(${to255(r)},${to255(g)},${to255(b)})`);
      // Extract glyphs and append the element to the layer.  The actual string conversion is performed via fontCache.
      const txt = getTextFromToken(token, fontCache.get(fontMap.get(currentFont) || null)); // Approximate currentFont to ref
      currentLayer.addTextElement(textElem);
      textElem.textContent = txt;
    }

    function emitTJ(arrTokens) {
      const eff = currentEffectiveTransform();
      const tx = eff[4], ty = eff[5], a = eff[0], bVal = eff[1];
      const scale = Math.hypot(a, bVal) || 1;
      const angleDeg = -Math.atan2(bVal, a) * 180 / Math.PI;
      const svgY = pageHeight - ty;
      const textElem = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      textElem.setAttribute('x', tx);
      textElem.setAttribute('y', svgY);
      textElem.setAttribute('transform', `rotate(${angleDeg}, ${tx}, ${svgY})`);
      textElem.setAttribute('font-family', currentFont);
      textElem.setAttribute('font-size', (currentFontSize * scale) + 'px');
      const [r, g, b] = currentFillRGB;
      const to255 = v => Math.max(0, Math.min(255, Math.round(v * 255)));
      textElem.setAttribute('fill', `rgb(${to255(r)},${to255(g)},${to255(b)})`);
      let currentTspan = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
      for (const subToken of arrTokens) {
        if (subToken.type === 'number') {
          const adjust = subToken.value;
          const dxShift = -(adjust / 1000) * currentFontSize * scale * currentTextScale;
          if (currentTspan.textContent) textElem.appendChild(currentTspan);
          const kerningSpan = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
          kerningSpan.setAttribute('dx', dxShift);
          textElem.appendChild(kerningSpan);
          currentTspan = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
        } else if (subToken.type === 'string' || subToken.type === 'hexstring') {
          const txt = getTextFromToken(subToken, fontCache.get(fontMap.get(currentFont) || null));
          currentTspan.textContent += txt;
        }
      }
      if (currentTspan.textContent) textElem.appendChild(currentTspan);
      currentLayer.addTextElement(textElem);
    }

    // Finalize
    for (const L of layers) L.renderAll();
    removeEmptyLayers(outputContainer);
    updateCanvasScale(outputContainer, viewportWrapper, pageWidth, pageHeight);

    let resizeTimeout;
    function onResize() {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => updateCanvasScale(outputContainer, viewportWrapper, pageWidth, pageHeight), 50);
    }
    window.addEventListener('resize', onResize, { passive: true });

    return {
      dispose() {
        window.removeEventListener('resize', onResize);
      }
    };
  }

  window.renderPage = renderPage;
})();
