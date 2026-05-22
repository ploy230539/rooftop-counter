// ===== Rooftop Detector v2 =====
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
