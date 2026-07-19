// ===== Rooftop Detector v2 =====
// Copyright (c) 2025-2026 Kanyarat Saosomphop. All rights reserved.
// Pure JavaScript computer vision for detecting rooftops in satellite imagery
// v2: Edge-aware dilation + component splitting for dense housing

const RooftopDetector = {

    detect(imageData, width, height, options, onProgress) {
        const {
            sensitivity = 5,         // 1-10
            minArea = 80,
            maxArea = 15000,
            areaMask = null,         // Uint8Array — 1 = inside area, 0 = outside (null = whole image)
        } = options;

        const pixels = imageData.data;
        const total = width * height;

        // --- Step 1: Color classification ---
        onProgress(3, 'วิเคราะห์สีพิกเซล...');
        const mask = new Uint8Array(total);

        // Sensitivity adjusts thresholds
        const greenThresh = 0.25 + (sensitivity - 5) * 0.03;
        const darkThresh = 30 + (5 - sensitivity) * 4;
        const brightThresh = 240 - (sensitivity - 5) * 5;
        const varianceThresh = 600 + (10 - sensitivity) * 150;

        for (let i = 0; i < total; i++) {
            // Skip pixels outside the drawn area
            if (areaMask && !areaMask[i]) continue;

            const idx = i * 4;
            const r = pixels[idx], g = pixels[idx + 1], b = pixels[idx + 2];

            const maxC = Math.max(r, g, b);
            const minC = Math.min(r, g, b);
            const lum = (r + g + b) / 3;

            // Skip very dark pixels (roads, shadows, water)
            if (lum < darkThresh) continue;

            // Skip very bright pixels (clouds, glare)
            if (lum > brightThresh && maxC - minC < 20) continue;

            // Skip green pixels (vegetation)
            const saturation = maxC > 0 ? (maxC - minC) / maxC : 0;
            const greenRatio = g / (r + g + b + 1);
            if (greenRatio > greenThresh && saturation > 0.15 && g > r && g > b) continue;

            // Skip blue pixels (water, pools)
            const blueRatio = b / (r + g + b + 1);
            if (blueRatio > 0.42 && b > r && b > g && saturation > 0.2) continue;

            // This pixel could be a rooftop
            mask[i] = 1;
        }

        // --- Step 2: Edge detection (Sobel gradient) ---
        onProgress(10, 'ตรวจจับขอบอาคาร...');
        const edges = this.sobelEdges(pixels, width, height, sensitivity);

        // --- Step 3: Local variance filter ---
        onProgress(20, 'วิเคราะห์ texture...');
        const refined = new Uint8Array(total);
        const winSize = 3;

        for (let y = winSize; y < height - winSize; y++) {
            for (let x = winSize; x < width - winSize; x++) {
                const ci = y * width + x;
                if (!mask[ci]) continue;

                // Calculate local color variance in a small window
                let sumR = 0, sumG = 0, sumB = 0;
                let sumR2 = 0, sumG2 = 0, sumB2 = 0;
                let n = 0;

                for (let dy = -winSize; dy <= winSize; dy++) {
                    for (let dx = -winSize; dx <= winSize; dx++) {
                        const ni = (y + dy) * width + (x + dx);
                        const nidx = ni * 4;
                        const pr = pixels[nidx], pg = pixels[nidx + 1], pb = pixels[nidx + 2];
                        sumR += pr; sumG += pg; sumB += pb;
                        sumR2 += pr * pr; sumG2 += pg * pg; sumB2 += pb * pb;
                        n++;
                    }
                }

                const varR = sumR2 / n - (sumR / n) ** 2;
                const varG = sumG2 / n - (sumG / n) ** 2;
                const varB = sumB2 / n - (sumB / n) ** 2;
                const totalVar = varR + varG + varB;

                // Rooftops have lower variance (more uniform color) than vegetation
                if (totalVar < varianceThresh) {
                    refined[ci] = 1;
                }
            }
        }

        // --- Step 4: Morphological operations (edge-aware) ---
        onProgress(35, 'ปรับปรุง mask...');

        // Erosion: remove isolated pixels
        let cleaned = this.erode(refined, width, height, 1);
        onProgress(42, 'เชื่อมต่อพื้นที่ (ไม่ข้ามขอบอาคาร)...');

        // Edge-aware dilation: connect nearby regions WITHOUT crossing building edges
        cleaned = this.dilateEdgeAware(cleaned, edges, width, height, 2);

        // One more erosion to refine edges
        cleaned = this.erode(cleaned, width, height, 1);

        // --- Step 5: Connected component labeling ---
        onProgress(52, 'ค้นหากลุ่มอาคาร...');
        const { labels, count } = this.connectedComponents(cleaned, width, height);

        // --- Step 6: Collect component info (single pass) ---
        onProgress(60, 'วิเคราะห์กลุ่มอาคาร...');
        const compInfo = [];
        for (let id = 0; id <= count; id++) {
            compInfo[id] = { area: 0, sumX: 0, sumY: 0, minX: Infinity, minY: Infinity, maxX: 0, maxY: 0 };
        }
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const id = labels[y * width + x];
                if (!id) continue;
                const c = compInfo[id];
                c.area++;
                c.sumX += x; c.sumY += y;
                if (x < c.minX) c.minX = x;
                if (x > c.maxX) c.maxX = x;
                if (y < c.minY) c.minY = y;
                if (y > c.maxY) c.maxY = y;
            }
        }

        // --- Step 7: Filter, split oversized, and build results ---
        onProgress(70, 'กรองและแยกอาคาร...');

        const components = [];

        for (let id = 1; id <= count; id++) {
            const c = compInfo[id];
            if (c.area < minArea) continue;

            const bboxW = c.maxX - c.minX + 1;
            const bboxH = c.maxY - c.minY + 1;

            // ---- OVERSIZED: try to split merged buildings ----
            if (c.area > maxArea) {
                onProgress(72, `แยกก้อนใหญ่ #${id} (${c.area} px)...`);
                const subs = this.splitComponent(labels, id, c, width, height, minArea);

                for (const sub of subs) {
                    if (sub.area < minArea) continue;
                    const sbw = sub.maxX - sub.minX + 1;
                    const sbh = sub.maxY - sub.minY + 1;
                    const rect = sub.area / (sbw * sbh);
                    if (rect < 0.2) continue;
                    const aspect = Math.max(sbw, sbh) / Math.min(sbw, sbh);
                    if (aspect > 10) continue;

                    // Sample average color from centroid area
                    const cx = Math.round(sub.sumX / sub.area);
                    const cy = Math.round(sub.sumY / sub.area);
                    const col = this.sampleColor(pixels, width, height, cx, cy, 4);

                    components.push({
                        x: cx, y: cy,
                        area: sub.area,
                        bbox: { x: sub.minX, y: sub.minY, w: sbw, h: sbh },
                        rectangularity: Math.round(rect * 100),
                        color: col
                    });
                }
                continue;
            }

            // ---- Normal size: check shape ----
            const rectangularity = c.area / (bboxW * bboxH);
            if (rectangularity < 0.25) continue;

            const aspect = Math.max(bboxW, bboxH) / Math.min(bboxW, bboxH);
            if (aspect > 8) continue;

            // Calculate average color
            let avgR = 0, avgG = 0, avgB = 0;
            for (let y = c.minY; y <= c.maxY; y++) {
                for (let x = c.minX; x <= c.maxX; x++) {
                    if (labels[y * width + x] === id) {
                        const pidx = (y * width + x) * 4;
                        avgR += pixels[pidx]; avgG += pixels[pidx + 1]; avgB += pixels[pidx + 2];
                    }
                }
            }

            components.push({
                x: Math.round(c.sumX / c.area),
                y: Math.round(c.sumY / c.area),
                area: c.area,
                bbox: { x: c.minX, y: c.minY, w: bboxW, h: bboxH },
                rectangularity: Math.round(rectangularity * 100),
                color: { r: Math.round(avgR / c.area), g: Math.round(avgG / c.area), b: Math.round(avgB / c.area) }
            });
        }

        onProgress(95, `พบ ${components.length} หลังคา...`);

        // Sort by area (largest first for labeling)
        components.sort((a, b) => b.area - a.area);

        onProgress(100, 'เสร็จสิ้น!');
        return components;
    },

    // ========================
    //  Sobel Edge Detection
    // ========================
    sobelEdges(pixels, w, h, sensitivity) {
        // Convert to grayscale
        const gray = new Float32Array(w * h);
        for (let i = 0; i < w * h; i++) {
            const idx = i * 4;
            gray[i] = pixels[idx] * 0.299 + pixels[idx + 1] * 0.587 + pixels[idx + 2] * 0.114;
        }

        const edges = new Uint8Array(w * h);
        // Lower threshold at higher sensitivity → detect finer edges → better separation
        const threshold = 35 - (sensitivity - 5) * 2;

        for (let y = 1; y < h - 1; y++) {
            for (let x = 1; x < w - 1; x++) {
                const i = y * w + x;
                // Sobel 3×3 kernels
                const gx = -gray[i - w - 1] + gray[i - w + 1]
                         - 2 * gray[i - 1] + 2 * gray[i + 1]
                         - gray[i + w - 1] + gray[i + w + 1];
                const gy = -gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1]
                         + gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1];
                const mag = Math.sqrt(gx * gx + gy * gy);
                if (mag > threshold) edges[i] = 1;
            }
        }

        // Dilate edges by 1px to widen barriers
        return this.dilate(edges, w, h, 1);
    },

    // ========================
    //  Edge-Aware Dilation
    // ========================
    // Dilates mask but does NOT expand INTO edge pixels (they act as barriers)
    dilateEdgeAware(mask, edges, w, h, iterations) {
        let current = mask;
        for (let iter = 0; iter < iterations; iter++) {
            const next = new Uint8Array(w * h);
            for (let y = 1; y < h - 1; y++) {
                for (let x = 1; x < w - 1; x++) {
                    const i = y * w + x;
                    // Edge pixel = barrier → keep existing value but don't spread into
                    if (edges[i]) {
                        if (current[i]) next[i] = 1;
                        continue;
                    }
                    if (current[i] ||
                        current[i - 1] || current[i + 1] ||
                        current[i - w] || current[i + w] ||
                        current[i - w - 1] || current[i - w + 1] ||
                        current[i + w - 1] || current[i + w + 1]) {
                        next[i] = 1;
                    }
                }
            }
            current = next;
        }
        return current;
    },

    // ========================
    //  Component Splitting
    // ========================
    // For oversized components: progressively erode to separate merged buildings
    splitComponent(labels, compId, compInfo, imgW, imgH, minArea) {
        const c = compInfo;
        const pad = 2;
        const lw = (c.maxX - c.minX + 1) + pad * 2;
        const lh = (c.maxY - c.minY + 1) + pad * 2;

        // Extract this component into a local mask
        const localMask = new Uint8Array(lw * lh);
        for (let y = c.minY; y <= c.maxY; y++) {
            for (let x = c.minX; x <= c.maxX; x++) {
                if (labels[y * imgW + x] === compId) {
                    localMask[(y - c.minY + pad) * lw + (x - c.minX + pad)] = 1;
                }
            }
        }

        // Try progressive erosion levels until we get a good split
        let bestSubs = null;
        for (let eLv = 2; eLv <= 7; eLv++) {
            const eroded = this.erode(localMask, lw, lh, eLv);
            const sub = this.connectedComponents(eroded, lw, lh);

            if (sub.count >= 2) {
                // Collect sub-component info, mapped back to global coords
                const subs = [];
                const subData = [];
                for (let sid = 0; sid <= sub.count; sid++) {
                    subData[sid] = { area: 0, sumX: 0, sumY: 0, minX: Infinity, minY: Infinity, maxX: 0, maxY: 0 };
                }

                for (let ly = 0; ly < lh; ly++) {
                    for (let lx = 0; lx < lw; lx++) {
                        const sid = sub.labels[ly * lw + lx];
                        if (!sid) continue;
                        const s = subData[sid];
                        const gx = lx + c.minX - pad;
                        const gy = ly + c.minY - pad;
                        s.area++;
                        s.sumX += gx; s.sumY += gy;
                        if (gx < s.minX) s.minX = gx;
                        if (gx > s.maxX) s.maxX = gx;
                        if (gy < s.minY) s.minY = gy;
                        if (gy > s.maxY) s.maxY = gy;
                    }
                }

                for (let sid = 1; sid <= sub.count; sid++) {
                    if (subData[sid].area >= minArea / 3) {
                        subs.push(subData[sid]);
                    }
                }

                if (subs.length >= 2) {
                    bestSubs = subs;
                    break;
                }
            }
        }

        if (bestSubs) return bestSubs;

        // Couldn't split → return as-is (will be filtered later if too large, or accepted)
        return [{
            area: c.area, sumX: c.sumX, sumY: c.sumY,
            minX: c.minX, minY: c.minY, maxX: c.maxX, maxY: c.maxY
        }];
    },

    // ========================
    //  Utility: Sample color
    // ========================
    sampleColor(pixels, w, h, cx, cy, radius) {
        let r = 0, g = 0, b = 0, n = 0;
        for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
                const px = cx + dx, py = cy + dy;
                if (px >= 0 && px < w && py >= 0 && py < h) {
                    const idx = (py * w + px) * 4;
                    r += pixels[idx]; g += pixels[idx + 1]; b += pixels[idx + 2];
                    n++;
                }
            }
        }
        return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
    },

    // ========================
    //  Morphological erosion
    // ========================
    erode(mask, w, h, iterations) {
        let current = mask;
        for (let iter = 0; iter < iterations; iter++) {
            const next = new Uint8Array(w * h);
            for (let y = 1; y < h - 1; y++) {
                for (let x = 1; x < w - 1; x++) {
                    const i = y * w + x;
                    if (current[i] &&
                        current[i - 1] && current[i + 1] &&
                        current[i - w] && current[i + w]) {
                        next[i] = 1;
                    }
                }
            }
            current = next;
        }
        return current;
    },

    // ========================
    //  Morphological dilation
    // ========================
    dilate(mask, w, h, iterations) {
        let current = mask;
        for (let iter = 0; iter < iterations; iter++) {
            const next = new Uint8Array(w * h);
            for (let y = 1; y < h - 1; y++) {
                for (let x = 1; x < w - 1; x++) {
                    const i = y * w + x;
                    if (current[i] ||
                        current[i - 1] || current[i + 1] ||
                        current[i - w] || current[i + w] ||
                        current[i - w - 1] || current[i - w + 1] ||
                        current[i + w - 1] || current[i + w + 1]) {
                        next[i] = 1;
                    }
                }
            }
            current = next;
        }
        return current;
    },

    // ========================
    //  Building Block Detector (for map screenshot images)
    //  Detects gray rectangular building blocks from Google Maps / OSM screenshots
    // ========================
    detectBlocks(imageData, w, h, areaMask, sensitivity, onProgress) {
        const pixels = imageData.data;
        const total = w * h;

        onProgress(4, 'วิเคราะห์สีอาคารอัตโนมัติ...');

        // --- Step 0: Auto-calibrate the building gray from the image histogram ---
        // Adapts to Google Maps / OSM / any light map theme instead of fixed thresholds
        const cal = this.calibrateBlockColors(pixels, w, h, areaMask);

        // Sensitivity nudges the calibrated band wider/narrower
        const sAdj = sensitivity - 5;
        const lumLow  = cal.lumLow  - sAdj * 4;
        const lumHigh = cal.lumHigh + sAdj * 1.5;
        const maxSat  = cal.maxSat  + sAdj * 0.015;

        onProgress(10, 'จับพิกเซลอาคาร...');

        // Step 1: Identify building-colored pixels (gray blocks)
        const mask = new Uint8Array(total);
        for (let i = 0; i < total; i++) {
            if (areaMask && !areaMask[i]) continue;

            const idx = i * 4;
            const r = pixels[idx], g = pixels[idx + 1], b = pixels[idx + 2];
            const lum = (r + g + b) / 3;

            if (lum < lumLow || lum > lumHigh) continue;

            const maxC = Math.max(r, g, b);
            const minC = Math.min(r, g, b);
            const sat = maxC > 0 ? (maxC - minC) / maxC : 0;

            // Buildings are low-saturation gray — reject colorful pixels
            if (sat > maxSat) continue;

            // Skip obvious green (parks, vegetation)
            const greenDom = g - Math.max(r, b);
            if (greenDom > 6 && sat > 0.06) continue;

            // Skip obvious blue (roads/water are slightly blue in Google/OSM)
            const blueDom = b - Math.max(r, g);
            if (blueDom > 6 && sat > 0.06) continue;

            mask[i] = 1;
        }

        // --- Step 2: Edge detection to separate touching buildings ---
        // Google draws thin borders/gaps between adjacent buildings; use them as barriers
        onProgress(26, 'ตรวจหาขอบอาคาร (แยกหลังที่ติดกัน)...');
        const edges = this.sobelEdges(pixels, w, h, sensitivity + 2);

        // Carve the mask along edges so a row of touching buildings splits into pieces
        const carved = new Uint8Array(total);
        for (let i = 0; i < total; i++) {
            if (mask[i] && !edges[i]) carved[i] = 1;
        }

        onProgress(36, 'ลบจุดรบกวน...');
        // Light erosion — drop isolated 1px specks (text edges, anti-aliasing)
        const cleaned = this.erode(carved, w, h, 1);

        onProgress(46, 'จัดกลุ่มอาคาร...');

        // Step 3: Connected component labeling
        const { labels, count: labelCount } = this.connectedComponents(cleaned, w, h);

        onProgress(62, `พบ ${labelCount} กลุ่ม — กรองขนาด...`);

        // Step 4: Collect component info
        const compInfo = [];
        for (let id = 0; id <= labelCount; id++) {
            compInfo[id] = { area: 0, sumX: 0, sumY: 0, minX: Infinity, minY: Infinity, maxX: 0, maxY: 0 };
        }
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const id = labels[y * w + x];
                if (!id) continue;
                const c = compInfo[id];
                c.area++;
                c.sumX += x; c.sumY += y;
                if (x < c.minX) c.minX = x;
                if (x > c.maxX) c.maxX = x;
                if (y < c.minY) c.minY = y;
                if (y > c.maxY) c.maxY = y;
            }
        }

        onProgress(72, 'กรอง/แยกอาคาร...');

        // Step 5: Filter by size/shape, split oversized merged blocks
        const minBuildingArea = 12;
        const maxBuildingArea = 50000;
        const results = [];

        const pushResult = (c) => {
            const bw = c.maxX - c.minX + 1;
            const bh = c.maxY - c.minY + 1;
            if (c.area < minBuildingArea) return;
            const rect = c.area / (bw * bh);
            if (rect < 0.35) return;                    // not blocky enough
            const aspect = Math.max(bw, bh) / Math.min(bw, bh);
            if (aspect > 7) return;                     // long thin road strip
            results.push({
                x: Math.round(c.sumX / c.area),
                y: Math.round(c.sumY / c.area),
                area: c.area,
                bbox: { x: c.minX, y: c.minY, w: bw, h: bh }
            });
        };

        for (let id = 1; id <= labelCount; id++) {
            const c = compInfo[id];
            if (c.area < minBuildingArea) continue;

            // Oversized solid block = still-merged buildings → try to split
            if (c.area > maxBuildingArea) {
                const subs = this.splitComponent(labels, id, c, w, h, minBuildingArea);
                subs.forEach(pushResult);
                continue;
            }
            pushResult(c);
        }

        onProgress(95, `พบ ${results.length} อาคาร`);
        onProgress(100, 'เสร็จสิ้น!');
        return results;
    },

    // ========================
    //  Auto-calibrate building color from image histogram
    //  Finds the "building gray" peak sitting just below the white background peak,
    //  so thresholds adapt to Google / OSM / any light map theme automatically.
    // ========================
    calibrateBlockColors(pixels, w, h, areaMask) {
        const fallback = { lumLow: 160, lumHigh: 236, maxSat: 0.18 };
        const hist = new Float32Array(256);
        const step = Math.max(1, Math.floor((w * h) / 200000)); // sample for speed
        let n = 0;

        for (let i = 0; i < w * h; i += step) {
            if (areaMask && !areaMask[i]) continue;
            const idx = i * 4;
            const r = pixels[idx], g = pixels[idx + 1], b = pixels[idx + 2];
            const maxC = Math.max(r, g, b), minC = Math.min(r, g, b);
            const sat = maxC > 0 ? (maxC - minC) / maxC : 0;
            if (sat > 0.16) continue;                   // gray pixels only
            const lum = (r + g + b) / 3;
            hist[Math.min(255, Math.round(lum))]++; n++;
        }
        if (n < 50) return fallback;

        // Smooth the histogram (±2 window)
        const sm = new Float32Array(256);
        for (let i = 0; i < 256; i++) {
            let s = 0, c = 0;
            for (let k = -2; k <= 2; k++) { const j = i + k; if (j >= 0 && j < 256) { s += hist[j]; c++; } }
            sm[i] = s / c;
        }

        // Background (white) peak in the bright range
        let bgP = 248, bgV = -1;
        for (let i = 236; i < 256; i++) if (sm[i] > bgV) { bgV = sm[i]; bgP = i; }

        // Building peak: strongest gray peak clearly below the background
        const hi = Math.max(170, bgP - 6);
        let bP = 215, bV = -1;
        for (let i = 150; i < hi; i++) if (sm[i] > bV) { bV = sm[i]; bP = i; }

        // No distinct building peak → conservative fallback bounded by background
        if (bV < bgV * 0.03) {
            return { lumLow: 160, lumHigh: Math.min(236, bgP - 4), maxSat: 0.18 };
        }

        // Upper bound = valley between building peak and white background
        let valley = bP, valV = Infinity;
        for (let i = bP; i <= bgP; i++) if (sm[i] < valV) { valV = sm[i]; valley = i; }

        // Lower bound = valley below the building peak (or a fixed offset)
        let loValley = Math.max(120, bP - 45), loV = Infinity;
        for (let i = Math.max(120, bP - 70); i < bP; i++) if (sm[i] < loV) { loV = sm[i]; loValley = i; }

        return {
            lumLow: Math.max(110, loValley),
            lumHigh: Math.min(bgP - 2, valley + 2),
            maxSat: 0.18
        };
    },

    // ========================
    //  Connected component labeling (BFS flood fill)
    // ========================
    connectedComponents(mask, w, h) {
        const labels = new Int32Array(w * h);
        let currentLabel = 0;

        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const i = y * w + x;
                if (mask[i] && !labels[i]) {
                    currentLabel++;
                    const queue = [i];
                    labels[i] = currentLabel;
                    let head = 0;

                    while (head < queue.length) {
                        const ci = queue[head++];
                        const cx = ci % w, cy = (ci - cx) / w;

                        const neighbors = [
                            cy > 0 ? ci - w : -1,
                            cy < h - 1 ? ci + w : -1,
                            cx > 0 ? ci - 1 : -1,
                            cx < w - 1 ? ci + 1 : -1,
                        ];

                        for (const ni of neighbors) {
                            if (ni >= 0 && mask[ni] && !labels[ni]) {
                                labels[ni] = currentLabel;
                                queue.push(ni);
                            }
                        }
                    }
                }
            }
        }

        return { labels, count: currentLabel };
    }
};
