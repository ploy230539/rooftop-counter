// ===== Image Mode with Auto-Detection + Area Drawing + Manual Pins =====
// Copyright (c) 2025-2026 Kanyarat Saosomphop. All rights reserved.
(function () {
    let canvas, ctx;
    let img = null;
    let panX = 0, panY = 0, scale = 1;
    let isPanning = false, panStart = { x: 0, y: 0 }, panStartOff = { x: 0, y: 0 };

    // Logical (CSS-pixel) viewport size + device pixel ratio for HiDPI crispness
    let viewW = 0, viewH = 0, dpr = 1;

    // Tool modes: null | 'edit' | 'eraser' | 'erase-area' | 'draw-circle' | 'draw-rect' | 'draw-freehand' | 'draw-polygon'
    let toolMode = null;

    // Markers: { x, y, auto:bool }
    let markers = [];
    let detecting = false;

    // Multiple areas (image coords)
    // Each: { type:'circle', cx, cy, r } | { type:'rect', x1, y1, x2, y2 } | { type:'polygon', points }
    let areas = [];
    let drawStart = null;
    let drawCurrent = null;

    // Undo stack: tracks action order
    // { type:'area' } | { type:'marker' } | { type:'detection', count:N }
    let undoStack = [];

    // Freehand drawing state
    let freehandPoints = [];
    let freehandDrawing = false;

    // Polygon (point-by-point) drawing state
    let polygonPoints = [];

    const MARKER_R = 7;

    function init() {
        canvas = document.getElementById('image-canvas');
        ctx = canvas.getContext('2d');

        // Upload
        const dropZone = document.getElementById('img-drop-zone');
        const fileInput = document.getElementById('img-upload');
        dropZone.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', e => { if (e.target.files[0]) loadFile(e.target.files[0]); });
        document.getElementById('btn-choose-file').addEventListener('click', e => { e.stopPropagation(); fileInput.click(); });
        dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
        dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
        dropZone.addEventListener('drop', e => {
            e.preventDefault(); dropZone.classList.remove('dragover');
            if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
        });

        // Canvas events
        canvas.addEventListener('mousedown', onDown);
        canvas.addEventListener('mousemove', onMove);
        canvas.addEventListener('mouseup', onUp);
        canvas.addEventListener('mouseleave', onUp);
        canvas.addEventListener('wheel', onWheel, { passive: false });
        canvas.addEventListener('dblclick', onDblClick);
        setupTouch();

        // Buttons
        document.getElementById('btn-detect').addEventListener('click', runDetection);
        document.getElementById('btn-edit').addEventListener('click', () => setTool(toolMode === 'edit' ? null : 'edit'));
        document.getElementById('btn-eraser').addEventListener('click', () => setTool(toolMode === 'eraser' ? null : 'eraser'));
        document.getElementById('btn-erase-area').addEventListener('click', () => setTool(toolMode === 'erase-area' ? null : 'erase-area'));
        document.getElementById('btn-draw-circle').addEventListener('click', () => setTool(toolMode === 'draw-circle' ? null : 'draw-circle'));
        document.getElementById('btn-draw-rect').addEventListener('click', () => setTool(toolMode === 'draw-rect' ? null : 'draw-rect'));
        document.getElementById('btn-draw-freehand').addEventListener('click', () => setTool(toolMode === 'draw-freehand' ? null : 'draw-freehand'));
        document.getElementById('btn-draw-polygon').addEventListener('click', () => setTool(toolMode === 'draw-polygon' ? null : 'draw-polygon'));
        document.getElementById('btn-clear-area').addEventListener('click', clearArea);

        document.getElementById('btn-undo').addEventListener('click', undo);
        document.getElementById('btn-clear-ai').addEventListener('click', () => {
            markers = markers.filter(m => !m.auto);
            undoStack = undoStack.filter(u => u.type === 'area' || u.type === 'marker');
            updateUI(); render();
        });
        document.getElementById('btn-clear-markers').addEventListener('click', () => {
            markers = []; areas = []; undoStack = [];
            updateUI(); updateAreaInfo(); render();
        });
        document.getElementById('btn-export').addEventListener('click', showReport);
        document.getElementById('modal-close').addEventListener('click', () => document.getElementById('report-modal').style.display = 'none');
        document.getElementById('btn-print').addEventListener('click', () => window.print());
        document.getElementById('btn-copy').addEventListener('click', () => {
            navigator.clipboard.writeText(document.getElementById('report-content').innerText);
        });
        document.getElementById('avg-people').addEventListener('change', updateUI);

        // Sensitivity: live value + auto re-detect so users can tune AFTER counting
        const sensEl = document.getElementById('sensitivity');
        const sensVal = document.getElementById('sensitivity-val');
        if (sensEl && sensVal) {
            sensEl.addEventListener('input', () => { sensVal.textContent = sensEl.value; });
            sensEl.addEventListener('change', () => {
                sensVal.textContent = sensEl.value;
                if (!img || detecting) return;
                // Only re-run if there was already an auto detection to compare against
                if (!markers.some(m => m.auto)) return;
                // Drop AI markers, reset areas, keep manual pins → re-detect with new value
                markers = markers.filter(m => !m.auto);
                undoStack = undoStack.filter(u => u.type !== 'detection');
                areas.forEach(a => a._detected = false);
                setHint('ปรับความไวเป็น ' + sensEl.value + ' — กำลังนับใหม่...');
                runDetection();
            });
        }

        window.addEventListener('resize', resizeCanvas);
    }

    // --- File loading ---
    function loadFile(file) {
        if (!file || !file.type.startsWith('image/')) return;
        document.getElementById('file-name').textContent = file.name;
        const reader = new FileReader();
        reader.onload = e => loadImageUrl(e.target.result);
        reader.readAsDataURL(file);
    }

    function loadImageUrl(url) {
        const image = new Image();
        image.onload = () => {
            img = image; markers = []; areas = []; undoStack = [];
            setTool(null);
            document.getElementById('img-drop-zone').style.display = 'none';
            document.getElementById('canvas-wrap').style.display = 'block';
            document.getElementById('btn-detect').disabled = false;
            requestAnimationFrame(() => { resizeCanvas(); fitImage(); updateUI(); updateAreaInfo(); setHint('วงพื้นที่ → กด ตรวจจับ หรือ ตรวจจับทั้งรูปเลย'); });
        };
        image.src = url;
    }
    window._imgLoadUrl = loadImageUrl;

    function resizeCanvas() {
        const wrap = document.getElementById('canvas-wrap');
        if (!wrap || wrap.style.display === 'none') return;
        const w = wrap.clientWidth, h = wrap.clientHeight;
        if (w > 0 && h > 0) {
            dpr = window.devicePixelRatio || 1;
            viewW = w; viewH = h;
            // CSS size stays logical; backing store is scaled up by DPR for sharpness
            canvas.style.width = w + 'px';
            canvas.style.height = h + 'px';
            canvas.width = Math.round(w * dpr);
            canvas.height = Math.round(h * dpr);
            render();
        }
    }

    function fitImage() {
        if (!img) return;
        scale = Math.min((viewW - 20) / img.width, (viewH - 20) / img.height, 2);
        panX = (viewW - img.width * scale) / 2;
        panY = (viewH - img.height * scale) / 2;
        render();
    }

    // --- Coordinates ---
    function c2i(cx, cy) { return { x: (cx - panX) / scale, y: (cy - panY) / scale }; }
    function i2c(ix, iy) { return { x: ix * scale + panX, y: iy * scale + panY }; }
    function evtPos(e) { const r = canvas.getBoundingClientRect(); return { x: (e.clientX || 0) - r.left, y: (e.clientY || 0) - r.top }; }

    // --- Tool mode ---
    function setTool(mode) {
        // Clean up freehand/polygon state when leaving
        if (toolMode === 'draw-freehand' && mode !== 'draw-freehand') {
            freehandPoints = []; freehandDrawing = false;
        }
        if (toolMode === 'draw-polygon' && mode !== 'draw-polygon') {
            polygonPoints = [];
        }
        toolMode = mode;
        // Update button states
        document.getElementById('btn-edit').classList.toggle('active', mode === 'edit');
        document.getElementById('btn-edit').textContent = mode === 'edit' ? '📌 ปักหมุด (กำลังใช้ — คลิกรูป)' : '📌 เปิดโหมดปักหมุดเอง';
        document.getElementById('btn-eraser').classList.toggle('active', mode === 'eraser');
        document.getElementById('btn-eraser').textContent = mode === 'eraser' ? '🧹 ลบหมุด (กำลังใช้ — คลิกหมุด)' : '🧹 โหมดลบหมุด AI';
        document.getElementById('btn-erase-area').classList.toggle('active', mode === 'erase-area');
        document.getElementById('btn-erase-area').textContent = mode === 'erase-area' ? '🧹 คลิกวงที่ต้องการลบ...' : '🧹 ยางลบวงพื้นที่';
        document.getElementById('btn-draw-circle').classList.toggle('active', mode === 'draw-circle');
        document.getElementById('btn-draw-rect').classList.toggle('active', mode === 'draw-rect');
        document.getElementById('btn-draw-freehand').classList.toggle('active', mode === 'draw-freehand');
        document.getElementById('btn-draw-freehand').textContent = mode === 'draw-freehand' ? '✏️ กำลังวาด... (ลากเมาส์แล้วปล่อย)' : '✏️ วาดอิสระ (Free Hand)';
        document.getElementById('btn-draw-polygon').classList.toggle('active', mode === 'draw-polygon');
        document.getElementById('btn-draw-polygon').textContent = mode === 'draw-polygon' ? '📐 กำลังต่อจุด... (ดับเบิลคลิกปิด)' : '📐 ต่อจุด (Polygon)';

        // Undo button visible when anything can be undone
        document.getElementById('btn-undo').style.display = undoStack.length > 0 ? 'block' : 'none';

        // Cursor
        const wrap = document.getElementById('canvas-wrap');
        wrap.classList.toggle('mode-edit', !!mode);

        // Hints
        const hints = {
            'edit': 'คลิกหลังคา = เพิ่มหมุด (🟡) | คลิกหมุดเดิม = ลบ',
            'eraser': 'คลิกหมุด 🟢 หรือ 🟡 เพื่อลบ (ไม่เพิ่มหมุดใหม่)',
            'erase-area': 'คลิกในวงพื้นที่ที่ต้องการลบ',
            'draw-circle': 'คลิกค้างแล้วลาก เพื่อวาดวงกลม',
            'draw-rect': 'คลิกค้างแล้วลาก เพื่อวาดสี่เหลี่ยม',
            'draw-freehand': 'กดเมาส์ค้าง แล้วลากวาดพื้นที่ → ปล่อยเพื่อปิดรูป',
            'draw-polygon': 'คลิกวางจุดทีละจุด → ดับเบิลคลิกหรือคลิกจุดแรกเพื่อปิดรูป',
        };
        setHint(mode ? hints[mode] : '');
    }

    // --- Mouse events ---
    function onDown(e) {
        if (!img) return;
        const pos = evtPos(e);

        // Erase-area mode — click inside an area to remove it
        if (toolMode === 'erase-area') {
            const ip = c2i(pos.x, pos.y);
            for (let i = areas.length - 1; i >= 0; i--) {
                if (pointInSingleArea(ip.x, ip.y, areas[i])) {
                    areas.splice(i, 1);
                    // Remove matching entry from undoStack
                    for (let j = undoStack.length - 1; j >= 0; j--) {
                        if (undoStack[j].type === 'area') { undoStack.splice(j, 1); break; }
                    }
                    updateAreaInfo(); updateUI(); render();
                    if (areas.length === 0) setHint('ลบวงพื้นที่ทั้งหมดแล้ว');
                    return;
                }
            }
            setHint('ไม่พบวงพื้นที่ตรงจุดที่คลิก');
            return;
        }

        // Eraser mode — only delete markers
        if (toolMode === 'eraser') {
            // Hit test in SCREEN pixels — fixed 14px radius regardless of zoom
            for (let i = markers.length - 1; i >= 0; i--) {
                const mp = i2c(markers[i].x, markers[i].y);
                if (Math.hypot(mp.x - pos.x, mp.y - pos.y) <= 14) {
                    markers.splice(i, 1); updateUI(); render(); return;
                }
            }
            return;
        }

        // Manual pin mode — add + delete
        if (toolMode === 'edit') {
            // Hit test in SCREEN pixels — must click within 12px of pin center
            for (let i = markers.length - 1; i >= 0; i--) {
                const mp = i2c(markers[i].x, markers[i].y);
                if (Math.hypot(mp.x - pos.x, mp.y - pos.y) <= 12) {
                    markers.splice(i, 1); updateUI(); render(); return;
                }
            }
            // No pin hit → add new pin
            const ip = c2i(pos.x, pos.y);
            if (ip.x >= 0 && ip.y >= 0 && ip.x <= img.width && ip.y <= img.height) {
                markers.push({ x: ip.x, y: ip.y, auto: false });
                undoStack.push({ type: 'marker' });
                updateUI(); render();
            }
            return;
        }

        // Polygon point-by-point mode
        if (toolMode === 'draw-polygon') {
            const ip = c2i(pos.x, pos.y);
            // If clicking near the first point → close polygon
            if (polygonPoints.length >= 3) {
                const fp = i2c(polygonPoints[0].x, polygonPoints[0].y);
                if (Math.hypot(fp.x - pos.x, fp.y - pos.y) <= 15) {
                    finalizePolygon();
                    return;
                }
            }
            polygonPoints.push(ip);
            render();
            if (polygonPoints.length === 1) setHint('จุดที่ 1 — คลิกเพิ่มจุดต่อไป');
            else setHint(`${polygonPoints.length} จุด — คลิกต่อ หรือ ดับเบิลคลิก/คลิกจุดแรกเพื่อปิดรูป`);
            return;
        }

        // Draw area modes
        if (toolMode === 'draw-circle' || toolMode === 'draw-rect') {
            drawStart = pos; drawCurrent = pos; return;
        }

        // Freehand drawing mode
        if (toolMode === 'draw-freehand') {
            freehandDrawing = true;
            const ip = c2i(pos.x, pos.y);
            freehandPoints = [ip];
            return;
        }

        // Pan
        isPanning = true;
        panStart = pos;
        panStartOff = { x: panX, y: panY };
        canvas.style.cursor = 'grabbing';
    }

    function onMove(e) {
        if (!img) return;
        const pos = evtPos(e);
        if (drawStart && (toolMode === 'draw-circle' || toolMode === 'draw-rect')) {
            drawCurrent = pos; render(); return;
        }
        if (freehandDrawing && toolMode === 'draw-freehand') {
            const ip = c2i(pos.x, pos.y);
            freehandPoints.push(ip);
            render(); return;
        }
        if (isPanning) {
            panX = panStartOff.x + pos.x - panStart.x;
            panY = panStartOff.y + pos.y - panStart.y;
            render();
        }
    }

    function onUp() {
        if (drawStart && drawCurrent && (toolMode === 'draw-circle' || toolMode === 'draw-rect')) {
            finalizeArea(); drawStart = null; drawCurrent = null; return;
        }
        if (freehandDrawing && toolMode === 'draw-freehand') {
            finalizeFreehand(); return;
        }
        isPanning = false; canvas.style.cursor = '';
    }

    function onDblClick(e) {
        if (toolMode === 'draw-polygon' && polygonPoints.length >= 3) {
            e.preventDefault();
            finalizePolygon();
        }
    }

    function finalizePolygon() {
        if (polygonPoints.length < 3) {
            setHint('ต้องวางอย่างน้อย 3 จุด');
            return;
        }
        // Close the polygon
        const pts = [...polygonPoints, polygonPoints[0]];
        areas.push({ type: 'polygon', points: pts });
        undoStack.push({ type: 'area' });
        polygonPoints = [];
        updateAreaInfo(); updateUI(); render();
        setTool(null);
        setHint(`วาดแล้ว ${areas.length} พื้นที่ — วาดเพิ่มหรือกด "ตรวจจับอัตโนมัติ"`);
    }

    function onWheel(e) {
        e.preventDefault(); if (!img) return;
        const pos = evtPos(e);
        const f = e.deltaY > 0 ? 0.85 : 1.18;
        const ns = Math.min(Math.max(scale * f, 0.05), 25);
        panX = pos.x - (pos.x - panX) * (ns / scale);
        panY = pos.y - (pos.y - panY) * (ns / scale);
        scale = ns; render();
    }

    // Touch support
    function setupTouch() {
        let lastT = [];
        canvas.addEventListener('touchstart', e => {
            e.preventDefault(); lastT = [...e.touches];
            if (e.touches.length === 1) onDown({ clientX: e.touches[0].clientX, clientY: e.touches[0].clientY });
        }, { passive: false });
        canvas.addEventListener('touchmove', e => {
            e.preventDefault();
            const t = [...e.touches];
            if (t.length === 1 && lastT.length === 1) {
                if (!toolMode) { panX += t[0].clientX - lastT[0].clientX; panY += t[0].clientY - lastT[0].clientY; render(); }
                else onMove({ clientX: t[0].clientX, clientY: t[0].clientY });
            } else if (t.length === 2 && lastT.length === 2) {
                const d1 = Math.hypot(lastT[0].clientX - lastT[1].clientX, lastT[0].clientY - lastT[1].clientY);
                const d2 = Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
                const mid = { x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 };
                const rect = canvas.getBoundingClientRect();
                const cx = mid.x - rect.left, cy = mid.y - rect.top;
                const ns = Math.min(Math.max(scale * d2 / d1, 0.05), 25);
                panX = cx - (cx - panX) * (ns / scale); panY = cy - (cy - panY) * (ns / scale); scale = ns; render();
            }
            lastT = t;
        }, { passive: false });
        canvas.addEventListener('touchend', e => { lastT = [...e.touches]; if (e.touches.length === 0) onUp(); });
    }

    // --- Area drawing ---
    function finalizeArea() {
        const s = c2i(drawStart.x, drawStart.y);
        const e2 = c2i(drawCurrent.x, drawCurrent.y);

        if (toolMode === 'draw-circle') {
            const r = Math.hypot(e2.x - s.x, e2.y - s.y);
            if (r < 5) return;
            areas.push({ type: 'circle', cx: s.x, cy: s.y, r });
        } else if (toolMode === 'draw-rect') {
            const x1 = Math.min(s.x, e2.x), y1 = Math.min(s.y, e2.y);
            const x2 = Math.max(s.x, e2.x), y2 = Math.max(s.y, e2.y);
            if (Math.abs(x2 - x1) < 5 || Math.abs(y2 - y1) < 5) return;
            areas.push({ type: 'rect', x1, y1, x2, y2 });
        }

        undoStack.push({ type: 'area' });
        updateAreaInfo(); updateUI();
        render();
        setTool(null);
        setHint(`วาดแล้ว ${areas.length} พื้นที่ — วาดเพิ่มหรือกด "ตรวจจับอัตโนมัติ"`);
    }

    function clearArea() {
        areas = [];
        undoStack = undoStack.filter(u => u.type !== 'area');
        updateAreaInfo(); updateUI(); render();
        setHint('ล้างวงพื้นที่ทั้งหมดแล้ว — ตรวจจับจะครอบคลุมทั้งรูป');
    }

    function finalizeFreehand() {
        freehandDrawing = false;
        if (freehandPoints.length < 5) {
            setHint('วาดน้อยเกินไป — ลองลากให้ยาวขึ้น');
            freehandPoints = [];
            render();
            return;
        }
        // Simplify: keep every Nth point
        const simplified = [];
        const step = Math.max(1, Math.floor(freehandPoints.length / 80));
        for (let i = 0; i < freehandPoints.length; i += step) {
            simplified.push(freehandPoints[i]);
        }
        simplified.push(simplified[0]); // close

        areas.push({ type: 'polygon', points: simplified });
        undoStack.push({ type: 'area' });
        freehandPoints = [];
        updateAreaInfo(); updateUI();
        render();
        setTool(null);
        setHint(`วาดแล้ว ${areas.length} พื้นที่ — วาดเพิ่มหรือกด "ตรวจจับอัตโนมัติ"`);
    }

    function pointInPolygonImg(x, y, polygon) {
        let inside = false;
        for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
            const xi = polygon[i].x, yi = polygon[i].y;
            const xj = polygon[j].x, yj = polygon[j].y;
            if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
                inside = !inside;
            }
        }
        return inside;
    }

    // Check if point is inside a single area
    function pointInSingleArea(ix, iy, a) {
        if (a.type === 'circle') return Math.hypot(ix - a.cx, iy - a.cy) <= a.r;
        if (a.type === 'rect') return ix >= a.x1 && ix <= a.x2 && iy >= a.y1 && iy <= a.y2;
        if (a.type === 'polygon') return pointInPolygonImg(ix, iy, a.points);
        return false;
    }

    // Check if point is inside ANY area (or true if no areas)
    function isInArea(ix, iy) {
        if (areas.length === 0) return true;
        return areas.some(a => pointInSingleArea(ix, iy, a));
    }

    function updateAreaInfo() {
        const el = document.getElementById('area-info');
        if (areas.length === 0) { el.textContent = ''; return; }
        const detected = areas.filter(a => a._detected).length;
        const pending = areas.length - detected;
        if (detected > 0 && pending > 0) {
            el.innerHTML = `วาดแล้ว ${areas.length} พื้นที่ (ตรวจจับแล้ว ${detected}, รอ ${pending})`;
        } else if (detected > 0) {
            el.innerHTML = `วาดแล้ว ${areas.length} พื้นที่ (ตรวจจับครบแล้ว ✅)`;
        } else {
            el.innerHTML = `วาดแล้ว ${areas.length} พื้นที่`;
        }
    }

    // --- Undo ---
    function undo() {
        if (undoStack.length === 0) return;
        const last = undoStack.pop();
        if (last.type === 'area') {
            if (areas.length > 0) areas.pop();
            updateAreaInfo();
        } else if (last.type === 'marker') {
            if (markers.length > 0) markers.pop();
        } else if (last.type === 'detection') {
            // Remove the last N auto markers
            let toRemove = last.count;
            for (let i = markers.length - 1; i >= 0 && toRemove > 0; i--) {
                if (markers[i].auto) { markers.splice(i, 1); toRemove--; }
            }
            // Reset _detected flag so areas can be re-detected
            areas.forEach(a => a._detected = false);
            updateAreaInfo();
        }
        updateUI(); render();
    }

    // --- Detection ---
    async function runDetection() {
        if (!img || detecting) return;

        // Find only NEW (undetected) areas
        const newAreas = areas.filter(a => !a._detected);
        const hasNewAreas = newAreas.length > 0;
        const hasNoAreas = areas.length === 0; // no areas at all → whole image

        if (!hasNewAreas && !hasNoAreas) {
            setHint('ทุกวงตรวจจับแล้ว — วาดวงใหม่เพื่อตรวจจับเพิ่ม');
            return;
        }

        detecting = true;
        const btn = document.getElementById('btn-detect');
        btn.disabled = true; btn.textContent = '⏳ กำลังตรวจจับ...';
        const bar = document.getElementById('progress-bar');
        const fill = document.getElementById('progress-fill');
        const text = document.getElementById('progress-text');
        bar.style.display = 'block';

        const off = document.createElement('canvas');
        off.width = img.width; off.height = img.height;
        off.getContext('2d').drawImage(img, 0, 0);
        const imageData = off.getContext('2d').getImageData(0, 0, img.width, img.height);

        const sensitivity = parseInt(document.getElementById('sensitivity').value);

        // Build area mask from NEW areas only (null = whole image)
        let areaMask = null;
        if (hasNewAreas) {
            areaMask = new Uint8Array(img.width * img.height);
            for (let y = 0; y < img.height; y++) {
                for (let x = 0; x < img.width; x++) {
                    if (newAreas.some(a => pointInSingleArea(x, y, a))) {
                        areaMask[y * img.width + x] = 1;
                    }
                }
            }
        }

        let newCount = 0;

        await new Promise(resolve => {
            setTimeout(() => {
                // Detect gray rectangular building blocks
                const results = RooftopDetector.detectBlocks(
                    imageData, img.width, img.height, areaMask, sensitivity,
                    (pct, msg) => { fill.style.width = pct + '%'; text.textContent = msg; }
                );

                // Append new results — skip duplicates near existing markers
                const dupDist = 8;
                for (const r of results) {
                    const isDup = markers.some(m =>
                        Math.abs(m.x - r.x) < dupDist && Math.abs(m.y - r.y) < dupDist
                    );
                    if (!isDup) {
                        markers.push({ x: r.x, y: r.y, auto: true, area: r.area, bbox: r.bbox });
                        newCount++;
                    }
                }
                resolve();
            }, 50);
        });

        // Mark new areas as detected
        newAreas.forEach(a => a._detected = true);

        // Push detection as single undo-able action
        if (newCount > 0) undoStack.push({ type: 'detection', count: newCount });

        btn.disabled = false; btn.textContent = '🤖 ตรวจจับหลังคาอัตโนมัติ';
        setTimeout(() => { bar.style.display = 'none'; }, 1200);
        detecting = false;

        const autoCount = markers.filter(m => m.auto).length;
        updateUI(); updateAreaInfo(); render();
        setHint(`พบใหม่ ${newCount} หลัง (รวม ${autoCount} หลัง)` + (hasNewAreas ? ` จาก ${newAreas.length} วงใหม่` : '') + ' — วาดพื้นที่ใหม่แล้วกดตรวจจับเพิ่มได้');
    }

    // --- Rendering ---
    function render() {
        if (!canvas || !ctx) return;
        // Base transform maps CSS-pixel coords → physical pixels (HiDPI crispness)
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, viewW, viewH);
        ctx.fillStyle = '#0f172a'; ctx.fillRect(0, 0, viewW, viewH);
        if (!img) return;

        // Image — disable smoothing when magnifying so pixels stay sharp, not blurry
        ctx.save(); ctx.translate(panX, panY); ctx.scale(scale, scale);
        ctx.imageSmoothingEnabled = scale < 1;
        ctx.drawImage(img, 0, 0); ctx.restore();

        // Dim outside drawn areas
        if (areas.length > 0) drawAreaOverlay();

        // Area being drawn (preview)
        if (drawStart && drawCurrent && (toolMode === 'draw-circle' || toolMode === 'draw-rect')) drawAreaPreview();
        if (freehandDrawing && freehandPoints.length > 1) drawFreehandPreview();
        if (toolMode === 'draw-polygon' && polygonPoints.length > 0) drawPolygonPreview();

        // Markers
        drawMarkers();
    }

    function drawAreaOverlay() {
        ctx.save();
        ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';

        // Full image rect, cut out all areas
        ctx.beginPath();
        const tl = i2c(0, 0), br = i2c(img.width, img.height);
        ctx.rect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);

        for (const a of areas) {
            if (a.type === 'circle') {
                const center = i2c(a.cx, a.cy);
                const rCanvas = a.r * scale;
                ctx.moveTo(center.x + rCanvas, center.y);
                ctx.arc(center.x, center.y, rCanvas, 0, Math.PI * 2, true);
            } else if (a.type === 'rect') {
                const p1 = i2c(a.x1, a.y1), p2 = i2c(a.x2, a.y2);
                ctx.rect(p2.x, p1.y, p1.x - p2.x, p2.y - p1.y);
            } else if (a.type === 'polygon' && a.points.length > 2) {
                const pts = a.points.map(p => i2c(p.x, p.y));
                ctx.moveTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
                for (const p of pts) ctx.lineTo(p.x, p.y);
                ctx.closePath();
            }
        }
        ctx.fill('evenodd');

        // Borders for each area
        ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 2.5; ctx.setLineDash([8, 4]);
        for (const a of areas) {
            if (a.type === 'circle') {
                const center = i2c(a.cx, a.cy);
                ctx.beginPath(); ctx.arc(center.x, center.y, a.r * scale, 0, Math.PI * 2); ctx.stroke();
            } else if (a.type === 'rect') {
                const p1 = i2c(a.x1, a.y1), p2 = i2c(a.x2, a.y2);
                ctx.strokeRect(p1.x, p1.y, p2.x - p1.x, p2.y - p1.y);
            } else if (a.type === 'polygon') {
                const pts = a.points.map(p => i2c(p.x, p.y));
                ctx.beginPath();
                ctx.moveTo(pts[0].x, pts[0].y);
                for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
                ctx.closePath(); ctx.stroke();
            }
        }
        ctx.restore();
    }

    function drawAreaPreview() {
        ctx.save();
        ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 2; ctx.setLineDash([6, 3]);
        ctx.fillStyle = 'rgba(245, 158, 11, 0.08)';

        if (toolMode === 'draw-circle') {
            const r = Math.hypot(drawCurrent.x - drawStart.x, drawCurrent.y - drawStart.y);
            ctx.beginPath(); ctx.arc(drawStart.x, drawStart.y, r, 0, Math.PI * 2);
            ctx.fill(); ctx.stroke();
        } else {
            const x = Math.min(drawStart.x, drawCurrent.x), y = Math.min(drawStart.y, drawCurrent.y);
            const w = Math.abs(drawCurrent.x - drawStart.x), h = Math.abs(drawCurrent.y - drawStart.y);
            ctx.fillRect(x, y, w, h); ctx.strokeRect(x, y, w, h);
        }
        ctx.restore();
    }

    function drawFreehandPreview() {
        if (freehandPoints.length < 2) return;
        ctx.save();
        ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
        ctx.beginPath();
        const first = i2c(freehandPoints[0].x, freehandPoints[0].y);
        ctx.moveTo(first.x, first.y);
        for (let i = 1; i < freehandPoints.length; i++) {
            const p = i2c(freehandPoints[i].x, freehandPoints[i].y);
            ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();
        ctx.restore();
    }

    function drawPolygonPreview() {
        if (polygonPoints.length === 0) return;
        ctx.save();

        const pts = polygonPoints.map(p => i2c(p.x, p.y));

        // Draw connecting lines
        ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.stroke();

        // Draw vertex dots
        ctx.setLineDash([]);
        for (let i = 0; i < pts.length; i++) {
            ctx.beginPath();
            ctx.arc(pts[i].x, pts[i].y, i === 0 ? 7 : 5, 0, Math.PI * 2);
            ctx.fillStyle = i === 0 ? '#3b82f6' : '#f59e0b';
            ctx.fill();
            ctx.strokeStyle = 'white'; ctx.lineWidth = 1.5;
            ctx.stroke();
        }

        // If ≥3 points, draw dashed closing line from last to first
        if (pts.length >= 3) {
            ctx.strokeStyle = 'rgba(59, 130, 246, 0.5)'; ctx.lineWidth = 1.5;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
            ctx.lineTo(pts[0].x, pts[0].y);
            ctx.stroke();

            // "Click to close" hint near first point
            ctx.setLineDash([]);
            ctx.fillStyle = 'rgba(59, 130, 246, 0.25)';
            ctx.beginPath(); ctx.arc(pts[0].x, pts[0].y, 15, 0, Math.PI * 2); ctx.fill();
        }

        ctx.restore();
    }

    function drawMarkers() {
        markers.forEach((m, i) => {
            const cp = i2c(m.x, m.y);
            const r = Math.max(4, Math.min(MARKER_R, MARKER_R * scale * 0.7));
            const isAuto = m.auto;

            ctx.save();
            // Dot
            ctx.beginPath(); ctx.arc(cp.x, cp.y, r, 0, Math.PI * 2);
            ctx.fillStyle = isAuto ? '#10b981' : '#f59e0b';
            ctx.fill(); ctx.strokeStyle = 'white'; ctx.lineWidth = 1.5; ctx.stroke();

            // Number
            if (scale > 0.25 && r >= 4) {
                ctx.fillStyle = 'white';
                ctx.font = `bold ${Math.max(7, Math.min(10, r * 1.2))}px sans-serif`;
                ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                ctx.fillText(i + 1, cp.x, cp.y);
            }
            ctx.restore();
        });
    }

    // --- UI ---
    function updateUI() {
        const total = markers.length;
        const auto = markers.filter(m => m.auto).length;
        const manual = total - auto;
        const avgP = parseFloat(document.getElementById('avg-people').value) || 3.5;

        // Undo button visible when anything can be undone
        document.getElementById('btn-undo').style.display = undoStack.length > 0 ? 'block' : 'none';

        document.getElementById('canvas-counter').textContent =
            `หลังคา: ${total}` + (manual > 0 && auto > 0 ? ` (อัตโนมัติ ${auto} + มือ ${manual})` : manual > 0 ? ` (มือ ${manual})` : '');

        if (total > 0) {
            document.getElementById('result-houses').textContent = total.toLocaleString() + ' หลัง';
            document.getElementById('result-population').textContent = Math.round(total * avgP).toLocaleString() + ' คน';
            document.getElementById('result-source').textContent =
                auto > 0 && manual > 0 ? `อัตโนมัติ ${auto} + มือ ${manual}` :
                auto > 0 ? `ตรวจจับอัตโนมัติ (${auto})` : `ปักหมุดเอง (${manual})`;
            document.getElementById('results-panel').style.display = 'block';
        }
    }

    function setHint(msg) {
        const el = document.getElementById('canvas-hint');
        el.textContent = msg; el.classList.toggle('show', !!msg);
    }

    // --- Report ---
    function showReport() {
        const total = markers.length, auto = markers.filter(m => m.auto).length, manual = total - auto;
        const avgP = document.getElementById('avg-people').value;
        const areaText = areas.length > 0 ? `${areas.length} พื้นที่` : 'ทั้งรูป';

        document.getElementById('report-content').innerHTML = `
            <p><strong>วันที่:</strong> ${new Date().toLocaleString('th-TH')}</p>
            <table>
                <tr><th>รายการ</th><th>ค่า</th></tr>
                <tr><td><strong>จำนวนหลังคาเรือน</strong></td><td><strong>${total} หลัง</strong></td></tr>
                <tr><td><strong>ประชากรโดยประมาณ</strong></td><td><strong>${Math.round(total * parseFloat(avgP))} คน</strong></td></tr>
                <tr><td>ตรวจจับอัตโนมัติ</td><td>${auto} หลัง</td></tr>
                <tr><td>ปักหมุดเอง</td><td>${manual} หลัง</td></tr>
                <tr><td>คน/หลังคาเรือน</td><td>${avgP}</td></tr>
                <tr><td>พื้นที่ตรวจจับ</td><td>${areaText}</td></tr>
                <tr><td>Sensitivity</td><td>${document.getElementById('sensitivity').value}/10</td></tr>
            </table>
            <p style="margin-top:10px;color:#94a3b8;font-size:0.78rem;">
                * 🟢 = ตรวจจับอัตโนมัติ &nbsp; 🟡 = ปักหมุดเอง<br>
                * ความแม่นยำขึ้นกับคุณภาพรูปและ zoom level
            </p>`;
        document.getElementById('report-modal').style.display = 'flex';
    }

    document.addEventListener('DOMContentLoaded', init);
})();
