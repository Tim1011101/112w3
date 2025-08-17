// text-vector.js
// Vector (SVG) PDF content renderer with selectable text, no external libs.

(function() {
  // Matrix utils (a b c d e f)
  function multiplyMatrix(m1, m2) {
    return [
      m1[0] * m2[0] + m1[2] * m2[1],
      m1[1] * m2[0] + m1[3] * m2[1],
      m1[0] * m2[2] + m1[2] * m2[3],
      m1[1] * m2[2] + m1[3] * m2[3],
      m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
      m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
    ];
  }

  function transformPoint(x, y, matrix) {
    return [
      matrix[0] * x + matrix[2] * y + matrix[4],
 matrix[1] * x + matrix[3] * y + matrix[5]
    ];
  }

  function toHex(n) {
    const v = Math.max(0, Math.min(255, Math.round(n * 255)));
    const hex = v.toString(16);
    return hex.length < 2 ? "0" + hex : hex;
  }

  const identity = [1, 0, 0, 1, 0, 0];

  class RenderLayer {
    constructor(container, zIndex, pageWidth, pageHeight) {
      this.pageWidth = pageWidth;
      this.pageHeight = pageHeight;

      this.div = document.createElement('div');
      this.div.className = 'layer';
      this.div.style.zIndex = zIndex;
      container.appendChild(this.div);

      this.svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      this.svg.setAttribute("width", pageWidth);
      this.svg.setAttribute("height", pageHeight);
      this.svg.setAttribute("viewBox", `0 0 ${pageWidth} ${pageHeight}`);
      this.svg.setAttribute("preserveAspectRatio", "xMinYMin meet");
      this.svg.style.position = "absolute";
      this.div.appendChild(this.svg);

      this.currentPathData = "";
      this.currentFill = "#000000";
      this.currentStroke = "#000000";
      this.segments = [];
      this.textFragment = document.createDocumentFragment();
    }

    pdfYToSvgY(y) {
      return this.pageHeight - y;
    }

    moveTo(x, y) {
      const svgY = this.pdfYToSvgY(y);
      this.currentPathData += `M ${x} ${svgY} `;
    }

    lineTo(x, y) {
      const svgY = this.pdfYToSvgY(y);
      this.currentPathData += `L ${x} ${svgY} `;
    }

    curveTo(x1, y1, x2, y2, x3, y3) {
      const svgY1 = this.pdfYToSvgY(y1);
      const svgY2 = this.pdfYToSvgY(y2);
      const svgY3 = this.pdfYToSvgY(y3);
      this.currentPathData += `C ${x1} ${svgY1} ${x2} ${svgY2} ${x3} ${svgY3} `;
    }

    closePath() {
      this.currentPathData += "Z ";
    }

    fillPath() {
      if (this.currentPathData.trim() !== "") {
        this.segments.push({
          d: this.currentPathData.trim(),
                           type: "fill",
                           color: this.currentFill
        });
        this.currentPathData = "";
      }
    }

    strokePath() {
      if (this.currentPathData.trim() !== "") {
        this.segments.push({
          d: this.currentPathData.trim(),
                           type: "stroke",
                           color: this.currentStroke
        });
        this.currentPathData = "";
      }
    }

    setFillColor(r, g, b) {
      this.currentFill = "#" + toHex(r) + toHex(g) + toHex(b);
    }

    setStrokeColor(r, g, b) {
      this.currentStroke = "#" + toHex(r) + toHex(g) + toHex(b);
    }

    renderPaths() {
      for (let seg of this.segments) {
        const pathElem = document.createElementNS("http://www.w3.org/2000/svg", "path");
        pathElem.setAttribute("d", seg.d);
        if (seg.type === "fill") {
          pathElem.setAttribute("fill", seg.color);
          pathElem.setAttribute("stroke", "none");
        } else if (seg.type === "stroke") {
          pathElem.setAttribute("stroke", seg.color);
          pathElem.setAttribute("fill", "none");
        }
        this.svg.appendChild(pathElem);
      }
      if (this.textFragment.childNodes.length > 0) {
        this.svg.appendChild(this.textFragment);
      }
    }

    addText(element) {
      this.textFragment.appendChild(element);
    }
  }

  // Tokenizer (supports (), [], numbers, operators)
  function tokenize(input) {
    let tokens = [];
    let i = 0;
    while (i < input.length) {
      if (/\s/.test(input[i])) {
        i++;
        continue;
      }
      if (input[i] === '(') {
        let str = "";
        i++;
        let depth = 1;
        while (i < input.length && depth > 0) {
          if (input[i] === '\\') {
            if (i + 1 < input.length) {
              let nextChar = input[i + 1];
              if (nextChar === '\\') str += "\\";
              else if (nextChar === 'n') str += "\n";
              else str += nextChar;
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
        tokens.push({ type: "string", value: str });
        continue;
      }
      if (input[i] === '[') {
        let arrStr = "";
        i++;
        let depth = 1;
        while (i < input.length && depth > 0) {
          if (input[i] === '[') {
            depth++;
            arrStr += '[';
            i++;
          } else if (input[i] === ']') {
            depth--;
            if (depth > 0) arrStr += ']';
            i++;
          } else {
            arrStr += input[i];
            i++;
          }
        }
        tokens.push({ type: "array", value: arrStr.trim() });
        continue;
      }
      if (input[i] === '<' && input[i + 1] !== '<') {
        let hex = "";
        i++;
        while (i < input.length && input[i] !== '>') {
          hex += input[i];
          i++;
        }
        if (i < input.length && input[i] === '>') i++;
        tokens.push({ type: "hexstring", value: "<" + hex + ">" });
        continue;
      }
      let token = "";
      while (i < input.length && !/\s/.test(input[i]) &&
        input[i] !== '(' && input[i] !== '[' && input[i] !== ')') {
        token += input[i];
        i++;
        }
        if (!isNaN(token)) tokens.push({ type: "number", value: parseFloat(token) });
        else tokens.push({ type: "operator", value: token });
    }
    return tokens;
  }

  function computeContentBBox(container) {
    const svgs = container.querySelectorAll('.layer svg');
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let valid = false;
    svgs.forEach(svg => {
      Array.from(svg.children).forEach(child => {
        try {
          const bbox = child.getBBox();
          if (isFinite(bbox.x) && isFinite(bbox.y) &&
            isFinite(bbox.width) && isFinite(bbox.height) &&
            bbox.width > 0 && bbox.height > 0) {
            minX = Math.min(minX, bbox.x);
          minY = Math.min(minY, bbox.y);
          maxX = Math.max(maxX, bbox.x + bbox.width);
          maxY = Math.max(maxY, bbox.y + bbox.height);
          valid = true;
            }
        } catch (_) { /* ignore */ }
      });
    });
    if (!valid) {
      return { x: 0, y: 0, width: 612, height: 792 };
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  function updateViewportScale(container, wrapper) {
    const bbox = computeContentBBox(container);

    const availableWidth = wrapper.clientWidth;
    const availableHeight = wrapper.clientHeight;
    const maxViewportPercentage = 0.9;

    const targetWidth = availableWidth * maxViewportPercentage;
    const targetHeight = availableHeight * maxViewportPercentage;

    let contentWidth, contentHeight;
    if (bbox.width === 0 || bbox.height === 0 ||
      !isFinite(bbox.width) || !isFinite(bbox.height)) {
      contentWidth = 612;
    contentHeight = 792;
      } else {
        const margin = 20;
        contentWidth = bbox.width + margin * 2;
        contentHeight = bbox.height + margin * 2;
      }

      const scaleFactor = Math.min(targetWidth / contentWidth, targetHeight / contentHeight);

      const translateX = (availableWidth - contentWidth * scaleFactor) / 2 - bbox.x * scaleFactor + 10;
      const translateY = (availableHeight - contentHeight * scaleFactor) / 2 - bbox.y * scaleFactor + 10;

      container.style.transformOrigin = 'top left';
      container.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scaleFactor})`;
  }

  function removeEmptyLayers(container) {
    const layers = container.querySelectorAll('.layer');
    layers.forEach(layer => {
      const svg = layer.querySelector('svg');
      if (!svg || svg.children.length === 0) {
        layer.remove();
      }
    });
  }

  async function renderImage(opts, xref, container, x, y, width, height) {
    const { xrefEntries, objects, fileBytes } = opts;

    console.log(`Rendering image with xref: ${xref}`);

    const entry = xrefEntries.get(xref);
    if (!entry || entry.type !== 'in-use') {
      console.warn(`Image XRef entry ${xref} not found or not in-use`);
      return;
    }

    const obj = objects.get(`${entry.num} ${entry.gen}`);
    if (!obj) {
      console.warn(`Image object ${entry.num} ${entry.gen} not found`);
      return;
    }

    if (!obj.processed) {
      console.log(`Processing stream for object ${entry.num} ${entry.gen}`);
      await extractAndDecodeStream(obj, fileBytes);
      obj.processed = true;
    }

    if (!obj.decoded || !obj.dict.includes('/Subtype /Image') || !obj.dict.includes('/Filter /DCTDecode')) {
      console.warn(`Object ${entry.num} ${entry.gen} is not a valid DCTDecode image`);
      return;
    }

    const img = document.createElement('img');
    img.src = `data:image/jpeg;base64,${btoa(String.fromCharCode.apply(null, new Uint8Array(obj.decoded)))}`;
    img.style.position = 'absolute';
    img.style.left = `${x}px`;
    img.style.top = `${y}px`;
    img.style.width = `${width}px`;
    img.style.height = `${height}px`;

    container.appendChild(img);
    console.log(`Image rendered successfully: ${img.src}`);
  }

  async function renderPage(opts, outputContainer, viewportWrapper) {
    const content = opts.content || '';
    const pageWidth = Math.max(1, Math.floor(opts.width || 612));
    const pageHeight = Math.max(1, Math.floor(opts.height || 792));
    const fontCache = opts.fontCache || new Map();
    const xrefEntries = opts.xrefEntries || new Map();
    const objects = opts.objects || new Map();
    const fileBytes = opts.fileBytes || new Uint8Array();

    outputContainer.innerHTML = '';

    let globalTransform = identity.slice();
    let textTransform = identity.slice();
    let stateStack = [];
    let currentFont = "sans-serif";
    let currentFontSize = 12;
    let currentColor = "#000000";
    let initialTextOrigin = [0, 0];
    let currentLayer = null;
    let layerCounter = 0;
    let layers = [];

    function newLayer() {
      currentLayer = new RenderLayer(outputContainer, layerCounter++, pageWidth, pageHeight);
      layers.push(currentLayer);
    }
    newLayer();

    const tokens = tokenize(content);
    let i = 0;
    let inTextObject = false;

    while (i < tokens.length) {
      const token = tokens[i];

      if (token.type === "operator" && (token.value === "BT" || token.value === "q")) {
        newLayer();
      }

      if (token.type === "operator" && (token.value === "rg" || token.value === "RG")) {
        if (i >= 3 &&
          tokens[i-3].type === "number" &&
          tokens[i-2].type === "number" &&
          tokens[i-1].type === "number") {
          let r = tokens[i-3].value;
        let g = tokens[i-2].value;
        let b = tokens[i-1].value;
        if (token.value === "rg") {
          currentColor = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
          currentLayer.setFillColor(r, g, b);
        } else {
          currentLayer.setStrokeColor(r, g, b);
        }
          }
          i++;
          continue;
      }

      if (token.type === "operator" && token.value === "m") {
        if (i >= 2 &&
          tokens[i-2].type === "number" &&
          tokens[i-1].type === "number") {
          let [x, y] = [tokens[i-2].value, tokens[i-1].value];
        let [tx, ty] = transformPoint(x, y, globalTransform);
        currentLayer.moveTo(tx, ty);
          }
          i++;
          continue;
      }

      if (token.type === "operator" && token.value === "l") {
        if (i >= 2 &&
          tokens[i-2].type === "number" &&
          tokens[i-1].type === "number") {
          let [x, y] = [tokens[i-2].value, tokens[i-1].value];
        let [tx, ty] = transformPoint(x, y, globalTransform);
        currentLayer.lineTo(tx, ty);
          }
          i++;
          continue;
      }

      if (token.type === "operator" && token.value === "c") {
        if (i >= 6 &&
          tokens[i-6].type === "number" &&
          tokens[i-5].type === "number" &&
          tokens[i-4].type === "number" &&
          tokens[i-3].type === "number" &&
          tokens[i-2].type === "number" &&
          tokens[i-1].type === "number") {
          let [x1, y1] = [tokens[i-6].value, tokens[i-5].value];
        let [x2, y2] = [tokens[i-4].value, tokens[i-3].value];
        let [x3, y3] = [tokens[i-2].value, tokens[i-1].value];

        let [tx1, ty1] = transformPoint(x1, y1, globalTransform);
        let [tx2, ty2] = transformPoint(x2, y2, globalTransform);
        let [tx3, ty3] = transformPoint(x3, y3, globalTransform);

        currentLayer.curveTo(tx1, ty1, tx2, ty2, tx3, ty3);
          }
          i++;
          continue;
      }

      if (token.type === "operator" && token.value === "h") {
        currentLayer.closePath();
        i++;
        continue;
      }

      if (token.type === "operator" && (token.value === "f" || token.value === "f*")) {
        currentLayer.fillPath();
        i++;
        continue;
      }

      if (token.type === "operator" && token.value === "S") {
        currentLayer.strokePath();
        i++;
        continue;
      }

      if (token.type === "operator" && token.value === "BT") {
        inTextObject = true;
        textTransform = identity.slice();
        initialTextOrigin = [0, 0];
        i++;
        continue;
      }

      if (token.type === "operator" && token.value === "ET") {
        inTextObject = false;
        i++;
        continue;
      }

      if (inTextObject) {
        if (token.type === "operator" && token.value === "Tf") {
          if (i >= 2 &&
            tokens[i-2].type === "string" &&
            tokens[i-1].type === "number") {
            let fontName = tokens[i-2].value;
          if (fontName[0] === "/") fontName = fontName.substring(1);
          const size = tokens[i-1].value;
            if (fontCache && fontCache.has(fontName)) {
              const info = fontCache.get(fontName);
              currentFont = (info.name || fontName).replace(/^[A-Z]{6}\+/, '');
            } else {
              currentFont = fontName;
            }
            currentFontSize = size;
            } else if (i >= 2 &&
              tokens[i-2].type === "operator" &&
              tokens[i-1].type === "number") {
              let fontName = tokens[i-2].value;
            if (fontName[0] === "/") fontName = fontName.substring(1);
            const size = tokens[i-1].value;
              if (fontCache && fontCache.has(fontName)) {
                const info = fontCache.get(fontName);
                currentFont = (info.name || fontName).replace(/^[A-Z]{6}\+/, '');
              } else {
                currentFont = fontName;
              }
              currentFontSize = size;
              }
              i++;
              continue;
        }

        if (token.type === "operator" && token.value === "Tm") {
          if (i >= 6) {
            textTransform = [
              tokens[i-6].value, tokens[i-5].value,
              tokens[i-4].value, tokens[i-3].value,
              tokens[i-2].value, tokens[i-1].value
            ];
            initialTextOrigin = [textTransform[4], textTransform[5]];
          }
          i++;
          continue;
        }

        if (token.type === "operator" &&
          (token.value === "Td" || token.value === "TD")) {
          if (i >= 2 &&
            tokens[i-2].type === "number" &&
            tokens[i-1].type === "number") {
            let dx = tokens[i-2].value;
          let dy = tokens[i-1].value;
        textTransform = multiplyMatrix(textTransform, [1, 0, 0, 1, dx, dy]);
        if (token.value === "TD") {
          initialTextOrigin = [textTransform[4], textTransform[5]];
        }
            }
            i++;
            continue;
          }

          if (token.type === "operator" && token.value === "Tj") {
            if (i >= 1 && (tokens[i-1].type === "string" || tokens[i-1].type === "hexstring")) {
              let txt = tokens[i-1].type === "hexstring"
                ? decodeHexString(tokens[i-1].value, fontCache.get(currentFont))
                : tokens[i-1].value;
              let effective = multiplyMatrix(globalTransform, textTransform);
              let tx = effective[4],
                ty = effective[5],
                a = effective[0],
                b = effective[1];
              let scale = Math.hypot(a, b) || 1;
              let angleDeg = -Math.atan2(b, a) * 180 / Math.PI;
              let svgY = currentLayer.pdfYToSvgY(ty);
              const textElem = document.createElementNS("http://www.w3.org/2000/svg", "text");
              textElem.setAttribute("x", tx);
              textElem.setAttribute("y", svgY);
              textElem.setAttribute("transform", `rotate(${angleDeg}, ${tx}, ${svgY})`);
              textElem.setAttribute("font-family", currentFont);
              textElem.setAttribute("font-size", `${currentFontSize * scale}px`);
              textElem.setAttribute("fill", currentColor);
              textElem.textContent = txt;
              currentLayer.addText(textElem);
            }
            i++;
            continue;
          }

          if (token.type === "operator" && token.value === "TJ") {
            if (i >= 1 && tokens[i-1].type === "array") {
              let effective = multiplyMatrix(globalTransform, textTransform);
              let tx = effective[4],
              ty = effective[5],
              a = effective[0],
              b = effective[1];
              let scale = Math.hypot(a, b) || 1;
              let angleDeg = -Math.atan2(b, a) * 180 / Math.PI;
              let svgY = currentLayer.pdfYToSvgY(ty);
              const arrContent = tokens[i-1].value;
              const regex = /(\([^\)]*(?:\\\)[^\)]*)*\))|(<[^>]+>)|([-+]?\d+(\.\d+)?)/g;
              let match, segments = [];
              let currentDx = 0;
              while ((match = regex.exec(arrContent)) !== null) {
                if (match[1]) {
                  let txt = match[1].slice(1, -1);
                  txt = txt.replace(/\\\(/g, "(")
                    .replace(/\\\)/g, ")")
                    .replace(/\\\\/g, "\\");
                  segments.push({ text: txt, dx: currentDx });
                  currentDx = 0;
                } else if (match[2]) {
                  let txt = decodeHexString(match[2], fontCache.get(currentFont));
                  segments.push({ text: txt, dx: currentDx });
                  currentDx = 0;
                } else if (match[3]) {
                  let adjustment = parseFloat(match[3]);
                  let dxShift = -(adjustment / 1000) * currentFontSize * scale;
                  currentDx += dxShift;
                }
              }
              let mergedText = "";
              const threshold = 1;
              segments.forEach(seg => {
                if (Math.abs(seg.dx) < threshold) {
                  mergedText += seg.text;
                } else {
                  if (seg.dx > threshold) {
                    mergedText += " " + seg.text;
                  } else {
                    mergedText += seg.text;
                  }
                }
              });
              let textElem = document.createElementNS("http://www.w3.org/2000/svg", "text");
              textElem.setAttribute("x", tx);
              textElem.setAttribute("y", svgY);
              textElem.setAttribute("transform", `rotate(${angleDeg}, ${tx}, ${svgY})`);
              textElem.setAttribute("font-family", currentFont);
              textElem.setAttribute("font-size", `${currentFontSize * scale}px`);
              textElem.setAttribute("fill", currentColor);
              let tspan = document.createElementNS("http://www.w3.org/2000/svg", "tspan");
              tspan.textContent = mergedText;
              textElem.appendChild(tspan);
              currentLayer.addText(textElem);
            }
            i++;
            continue;
          }

          if (token.type === "operator" && token.value === "'") {
            textTransform[4] = initialTextOrigin[0];
            textTransform[5] = initialTextOrigin[1] - currentFontSize;
            if (i >= 1 && (tokens[i-1].type === "string" || tokens[i-1].type === "hexstring")) {
              let txt = tokens[i-1].type === "hexstring"
                ? decodeHexString(tokens[i-1].value, fontCache.get(currentFont))
                : tokens[i-1].value;
              let effective = multiplyMatrix(globalTransform, textTransform);
              let tx = effective[4],
                ty = effective[5],
                a = effective[0],
                b = effective[1];
              let scale = Math.hypot(a, b) || 1;
              let angleDeg = -Math.atan2(b, a) * 180 / Math.PI;
              let svgY = currentLayer.pdfYToSvgY(ty);
              let textElem = document.createElementNS("http://www.w3.org/2000/svg", "text");
              textElem.setAttribute("x", tx);
              textElem.setAttribute("y", svgY);
              textElem.setAttribute("transform", `rotate(${angleDeg}, ${tx}, ${svgY})`);
              textElem.setAttribute("font-family", currentFont);
              textElem.setAttribute("font-size", `${currentFontSize * scale}px`);
              textElem.setAttribute("fill", currentColor);
              textElem.textContent = txt;
              currentLayer.addText(textElem);
            }
            i++;
            continue;
          }
      }

      if (token.type === "operator" && token.value === "Do") {
        if (i >= 1 && tokens[i-1].type === "string") {
          let xref = tokens[i-1].value;
          if (xref.startsWith("/")) {
            xref = xref.substring(1);
          }

          let effective = globalTransform;
          let x = effective[4];
          let y = effective[5];
          let width = 1;
          let height = 1;

          console.log(`Rendering image with xref: ${xref} at position (${x}, ${y})`);

          await renderImage({
            xrefEntries,
            objects,
            fileBytes
          }, parseInt(xref), currentLayer.div, x, currentLayer.pdfYToSvgY(y), width, height);
        }
        i++;
        continue;
      }

      if (token.type === "operator" && token.value === "q") {
        stateStack.push({
          globalT: globalTransform.slice(),
                        textT: textTransform.slice(),
                        currentFont,
                        currentFontSize,
                        currentColor,
                        initialTextOrigin: initialTextOrigin.slice()
        });
        i++;
        continue;
      }

      if (token.type === "operator" && token.value === "Q") {
        let state = stateStack.pop();
        if (state) {
          globalTransform = state.globalT;
          textTransform = state.textT;
          currentFont = state.currentFont;
          currentFontSize = state.currentFontSize;
          currentColor = state.currentColor;
          initialTextOrigin = state.initialTextOrigin;
        }
        newLayer();
        i++;
        continue;
      }

      if (token.type === "operator" && token.value === "cm") {
        if (i >= 6) {
          let matrix = [
            tokens[i-6].value, tokens[i-5].value,
            tokens[i-4].value, tokens[i-3].value,
            tokens[i-2].value, tokens[i-1].value
          ];
          globalTransform = multiplyMatrix(globalTransform, matrix);
        }
        i++;
        continue;
      }

      i++;
    }

    function parseColor(op, args) {
      if (op === 'rg') return `rgb(${args.map(v => v*255).join(',')})`;
      if (op === 'g')  return `rgb(${args[0]*255},${args[0]*255},${args[0]*255})`;
      return '#000'; // fallback
    }

    function decodeHexString(hexStr, font) {
      const hex = hexStr.slice(1, -1).replace(/\s+/g, "");
      const bytes = [];
      for (let i = 0; i < hex.length; i += 2) {
        const h = hex.substr(i, 2);
        if (h.length < 2) break;
        bytes.push(parseInt(h, 16));
      }
      const encoding = font?.encodingMap || {};
      const twoByte = bytes.length % 2 === 0 && bytes.some((b, idx) => idx % 2 === 0 && b === 0);
      let text = '';
      if (twoByte) {
        for (let i = 0; i < bytes.length; i += 2) {
          const code = (bytes[i] << 8) | bytes[i + 1];
          text += encoding[code] || String.fromCharCode(code);
        }
      } else {
        for (let b of bytes) {
          text += encoding[b] || String.fromCharCode(b);
        }
      }
      return text;
    }

    function renderText(ctx, font, hexStr, x, y, color) {
      const text = decodeHexString(hexStr, font);
      const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
      t.setAttribute("x", x);
      t.setAttribute("y", y);
      t.setAttribute("fill", color);
      t.textContent = text;
      ctx.appendChild(t);
    }


    layers.forEach(layer => layer.renderPaths());
    removeEmptyLayers(outputContainer);
    updateViewportScale(outputContainer, viewportWrapper);

    let resizeTimeout;
    function onResize() {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => updateViewportScale(outputContainer, viewportWrapper), 50);
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
