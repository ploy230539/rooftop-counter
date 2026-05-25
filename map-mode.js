// ===== Map Mode (AI Rooftop Detection + Manual Pins) =====
(function () {
    let map, drawnItems, buildingMarkers;
    let manualMode = false;
    let manualPins = [];   // { marker, latlng }
    let detectedCount = 0;
    let mapInitialized = false;
    let detecting = false;
    let eraserMode = false;
    let searchPin = null;      // Red pin from URL/search
    let radiusCircle = null;   // Radius circle around search pin
    let freehandMode = false;
    let activeLayer = 'road';  // 'road' or 'satellite'
    let freehandPoints = [];
    let freehandPolyline = null;
    let drawControl = null;

    function initMap() {
        if (mapInitialized) return;
        mapInitialized = true;

        map = L.map('map').setView([13.7563, 100.5018], 15);

        // Road map (default) — OpenStreetMap
        const roadMap = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; OpenStreetMap contributors',
            maxZoom: 19,
            crossOrigin: 'anonymous'
        });

        // Satellite — Esri World Imagery
        const satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
            attribution: 'Esri',
            maxZoom: 19,
            crossOrigin: 'anonymous'
        });

        // Default to road map
        roadMap.addTo(map);

        // Track active layer
        map.on('baselayerchange', e => {
            activeLayer = e.name.includes('ดาวเทียม') ? 'satellite' : 'road';
        });

        // Layer switcher control
        L.control.layers({
            '🗺️ แผนที่ถนน': roadMap,
            '🛰️ ดาวเทียม': satellite
        }, null, { position: 'topleft', collapsed: false }).addTo(map);

        drawnItems = new L.FeatureGroup().addTo(map);
        buildingMarkers = new L.FeatureGroup().addTo(map);

        drawControl = new L.Control.Draw({
            position: 'topright',
            draw: {
                polygon: { shapeOptions: { color: '#f59e0b', weight: 3, fillOpacity: 0.15 } },
                rectangle: { shapeOptions: { color: '#f59e0b', weight: 3, fillOpacity: 0.15 } },
                circle: { shapeOptions: { color: '#f59e0b', weight: 3, fillOpacity: 0.15 } },
                polyline: false, marker: false, circlemarker: false
            },
            edit: { featureGroup: drawnItems, remove: true }
        });
        map.addControl(drawControl);

        // When a Leaflet Draw tool is clicked, deactivate freehand/manual/eraser
        // Use DOM click on toolbar (more reliable than draw:drawstart when other modes are active)
        const drawToolbar = map.getContainer().querySelector('.leaflet-draw');
        if (drawToolbar) {
            drawToolbar.addEventListener('mousedown', e => {
                if (e.target.closest('.leaflet-draw-draw-polygon, .leaflet-draw-draw-rectangle, .leaflet-draw-draw-circle')) {
                    deactivateAllModes();
                }
            }, true);
        }
        map.on('draw:drawstart', deactivateAllModes);

        // Multiple areas: ADD new area, don't clear old ones
        map.on(L.Draw.Event.CREATED, e => {
            drawnItems.addLayer(e.layer);
            // New undetected area → enable detect button
            document.getElementById('btn-count').disabled = false;
            document.getElementById('btn-count').textContent = '🤖 ตรวจจับหลังคาอัตโนมัติ';
            updateAreaCount();
        });

        // When areas are deleted via the edit control
        map.on(L.Draw.Event.DELETED, () => {
            updateAreaCount();
            if (drawnItems.getLayers().length === 0) {
                document.getElementById('btn-count').disabled = true;
            }
        });

        // --- Freehand drawing ---
        setupFreehand();

        // --- Search ---
        setupSearch();

        // --- Radius slider ---
        setupRadiusSlider();

        // Map click → manual pin
        map.on('click', e => {
            if (!manualMode) return;

            // Check if clicked near an existing manual pin → remove it
            const clickPt = map.latLngToContainerPoint(e.latlng);
            for (let i = manualPins.length - 1; i >= 0; i--) {
                const pinPt = map.latLngToContainerPoint(manualPins[i].latlng);
                if (clickPt.distanceTo(pinPt) < 18) {
                    map.removeLayer(manualPins[i].marker);
                    manualPins.splice(i, 1);
                    updateCounter(); updateResults();
                    return;
                }
            }

            // Add new manual pin
            const marker = L.marker(e.latlng, {
                icon: L.divIcon({
                    className: 'map-marker-manual',
                    iconSize: [14, 14],
                    iconAnchor: [7, 7]
                })
            }).addTo(map);

            marker.on('click', function (ev) {
                L.DomEvent.stopPropagation(ev);
                const idx = manualPins.findIndex(p => p.marker === marker);
                if (idx >= 0) {
                    map.removeLayer(marker);
                    manualPins.splice(idx, 1);
                    updateCounter(); updateResults();
                }
            });

            manualPins.push({ marker, latlng: e.latlng });
            updateCounter(); updateResults();
        });

        // Buttons
        document.getElementById('btn-count').addEventListener('click', detectFromMap);

        document.getElementById('btn-manual').addEventListener('click', () => {
            const wasManual = manualMode;
            deactivateAllModes();
            cancelLeafletDraw();
            if (!wasManual) {
                manualMode = true;
                const btn = document.getElementById('btn-manual');
                btn.classList.add('active');
                btn.textContent = '📌 ปักหมุด (กำลังใช้ — คลิกแผนที่)';
                map.getContainer().style.cursor = 'crosshair';
                document.getElementById('btn-undo-map').style.display = 'block';
                showStatus('คลิกหลังคา = เพิ่มหมุด (🟡) | คลิกหมุดเดิม = ลบ');
            }
        });

        document.getElementById('btn-eraser-map').addEventListener('click', toggleEraser);

        document.getElementById('btn-clear-ai-map').addEventListener('click', () => {
            buildingMarkers.clearLayers();
            detectedCount = 0;
            // Reset all areas so they can be re-detected
            drawnItems.getLayers().forEach(a => {
                a._detected = false;
                if (a.setStyle) a.setStyle({ color: '#f59e0b', fillColor: '#f59e0b' });
            });
            document.getElementById('btn-count').disabled = drawnItems.getLayers().length === 0;
            document.getElementById('btn-count').textContent = '🤖 ตรวจจับหลังคาอัตโนมัติ';
            updateCounter(); updateResults();
            showStatus('ลบหมุด AI ทั้งหมดแล้ว — กดตรวจจับใหม่ได้');
        });

        document.getElementById('btn-undo-map').addEventListener('click', () => {
            if (manualPins.length === 0) return;
            const last = manualPins.pop();
            map.removeLayer(last.marker);
            updateCounter(); updateResults();
        });

        document.getElementById('btn-clear-map').addEventListener('click', () => {
            drawnItems.clearLayers(); buildingMarkers.clearLayers();
            manualPins.forEach(p => map.removeLayer(p.marker));
            manualPins = [];
            detectedCount = 0; eraserMode = false;
            // Remove radius circle regardless of lock
            if (radiusCircle) { map.removeLayer(radiusCircle); radiusCircle = null; }
            // Reset radius UI
            const slider = document.getElementById('radius-slider');
            const lockBtn = document.getElementById('btn-lock-radius');
            const clearBtn = document.getElementById('btn-clear-radius');
            if (slider) slider.disabled = false;
            if (lockBtn) lockBtn.style.display = 'block';
            if (clearBtn) clearBtn.style.display = 'none';

            document.getElementById('btn-eraser-map').classList.remove('active');
            document.getElementById('btn-eraser-map').textContent = '🧹 โหมดลบหมุด AI';
            document.getElementById('btn-count').disabled = true;
            document.getElementById('btn-count').textContent = '🤖 ตรวจจับหลังคาอัตโนมัติ';
            document.getElementById('results-panel').style.display = 'none';
            document.getElementById('map-pin-counter').style.display = 'none';
            updateAreaCount();
        });

        document.getElementById('avg-people-map').addEventListener('change', updateResults);
    }

    // ========================
    //  Area count display
    // ========================
    function updateAreaCount() {
        const count = drawnItems.getLayers().length;
        const el = document.getElementById('area-count');
        if (el) {
            el.textContent = count > 0 ? `วาดแล้ว ${count} พื้นที่` : '';
        }
    }

    // ========================
    //  Freehand Drawing
    // ========================
    function setupFreehand() {
        const btn = document.getElementById('btn-freehand');
        if (!btn) return;
        btn.addEventListener('click', toggleFreehand);
    }

    function cancelLeafletDraw() {
        if (!drawControl) return;
        const cancelBtn = document.querySelector('.leaflet-draw-actions a[title="Cancel drawing"]') ||
                          document.querySelector('.leaflet-draw-actions li:last-child a');
        if (cancelBtn) cancelBtn.click();
    }

    function deactivateAllModes() {
        if (freehandMode) {
            freehandMode = false;
            const fbtn = document.getElementById('btn-freehand');
            fbtn.classList.remove('active');
            fbtn.textContent = '✏️ วาดอิสระ (Free Hand)';
            map.dragging.enable();
            map.off('mousedown', freehandStart);
            map.off('mousemove', freehandDraw);
            map.off('mouseup', freehandEnd);
            if (freehandPolyline) { map.removeLayer(freehandPolyline); freehandPolyline = null; }
            freehandPoints = [];
        }
        if (manualMode) {
            manualMode = false;
            const mbtn = document.getElementById('btn-manual');
            mbtn.classList.remove('active');
            mbtn.textContent = '📌 เปิดโหมดปักหมุด';
            document.getElementById('btn-undo-map').style.display = 'none';
        }
        if (eraserMode) {
            eraserMode = false;
            const ebtn = document.getElementById('btn-eraser-map');
            ebtn.classList.remove('active');
            ebtn.textContent = '🧹 โหมดลบหมุด AI';
            buildingMarkers.eachLayer(marker => {
                if (marker._eraserHandler) {
                    marker.off('click', marker._eraserHandler);
                    delete marker._eraserHandler;
                }
                if (marker._icon) marker._icon.style.cursor = '';
            });
        }
        map.getContainer().style.cursor = '';
        showStatus('');
    }

    function toggleFreehand() {
        const wasFreehand = freehandMode;
        deactivateAllModes();
        cancelLeafletDraw();

        if (!wasFreehand) {
            freehandMode = true;
            const btn = document.getElementById('btn-freehand');
            btn.classList.add('active');
            btn.textContent = '✏️ กำลังวาด... (ลากเมาส์แล้วปล่อย)';
            map.getContainer().style.cursor = 'crosshair';
            map.dragging.disable();
            map.on('mousedown', freehandStart);
            showStatus('กดเมาส์ค้าง แล้วลากวาดพื้นที่ → ปล่อยเพื่อปิดรูป');
        }
    }

    function freehandStart(e) {
        freehandPoints = [e.latlng];
        if (freehandPolyline) { map.removeLayer(freehandPolyline); }
        freehandPolyline = L.polyline(freehandPoints, {
            color: '#f59e0b', weight: 3, dashArray: '6,4'
        }).addTo(map);
        map.on('mousemove', freehandDraw);
        map.on('mouseup', freehandEnd);
    }

    function freehandDraw(e) {
        freehandPoints.push(e.latlng);
        freehandPolyline.addLatLng(e.latlng);
    }

    function freehandEnd() {
        map.off('mousemove', freehandDraw);
        map.off('mouseup', freehandEnd);
        if (freehandPolyline) { map.removeLayer(freehandPolyline); freehandPolyline = null; }

        if (freehandPoints.length < 5) {
            showStatus('วาดน้อยเกินไป — ลองลากให้ยาวขึ้น');
            freehandPoints = [];
            return;
        }

        // Simplify: keep every Nth point
        const simplified = [];
        const step = Math.max(1, Math.floor(freehandPoints.length / 80));
        for (let i = 0; i < freehandPoints.length; i += step) {
            simplified.push(freehandPoints[i]);
        }
        // Close the polygon
        simplified.push(simplified[0]);

        const polygon = L.polygon(simplified, {
            color: '#f59e0b', weight: 3, fillOpacity: 0.15, fillColor: '#f59e0b'
        });

        drawnItems.addLayer(polygon);
        document.getElementById('btn-count').disabled = false;
        document.getElementById('btn-count').textContent = '🤖 ตรวจจับหลังคาอัตโนมัติ';
        updateAreaCount();
        showStatus('เพิ่มพื้นที่วาดอิสระแล้ว — วาดเพิ่มหรือกดตรวจจับ');
        freehandPoints = [];
    }

    // ========================
    //  Radius Circle from Search Pin
    //  Stays visible as reference boundary while drawing areas inside
    // ========================
    function setupRadiusSlider() {
        const slider = document.getElementById('radius-slider');
        const label = document.getElementById('radius-label');
        const lockBtn = document.getElementById('btn-lock-radius');
        const clearBtn = document.getElementById('btn-clear-radius');
        if (!slider || !lockBtn) return;

        function formatRadius(m) {
            return m >= 1000 ? (m / 1000).toFixed(1) + ' กม.' : m + ' ม.';
        }

        slider.addEventListener('input', () => {
            const val = parseInt(slider.value);
            label.textContent = formatRadius(val);

            // Update live preview circle (only if not locked)
            if (searchPin && !(radiusCircle && radiusCircle._locked)) {
                const center = searchPin.getLatLng();
                if (radiusCircle) map.removeLayer(radiusCircle);
                radiusCircle = L.circle(center, {
                    radius: val,
                    color: '#3b82f6', weight: 3,
                    fillColor: '#3b82f6', fillOpacity: 0.05,
                    dashArray: '12,8'
                }).addTo(map);
                radiusCircle._locked = false;
            }
        });

        // Lock radius — keeps it visible as a permanent reference boundary
        lockBtn.addEventListener('click', () => {
            if (!searchPin) {
                showStatus('⚠️ ค้นหาสถานที่ก่อน แล้วจึงกำหนดรัศมี');
                return;
            }

            const val = parseInt(slider.value);
            const center = searchPin.getLatLng();

            // Remove old circle, create a bold reference circle
            if (radiusCircle) map.removeLayer(radiusCircle);
            radiusCircle = L.circle(center, {
                radius: val,
                color: '#ef4444', weight: 3,
                fillColor: '#ef4444', fillOpacity: 0.03,
                dashArray: '15,10',
                interactive: false  // can't accidentally click/drag it
            }).addTo(map);
            radiusCircle._locked = true;

            // Disable slider while locked
            slider.disabled = true;
            lockBtn.style.display = 'none';
            clearBtn.style.display = 'block';

            // Fit map to see the full radius
            map.fitBounds(radiusCircle.getBounds(), { padding: [30, 30] });
            showStatus(`🔴 ล็อครัศมี ${formatRadius(val)} — วาดพื้นที่ย่อยข้างในได้เลย`);
        });

        // Clear radius reference
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                if (radiusCircle) { map.removeLayer(radiusCircle); radiusCircle = null; }
                slider.disabled = false;
                lockBtn.style.display = 'block';
                clearBtn.style.display = 'none';
                showStatus('ลบวงรัศมีแล้ว');
            });
        }
    }

    function toggleEraser() {
        const wasEraser = eraserMode;
        deactivateAllModes();
        cancelLeafletDraw();

        if (!wasEraser) {
            eraserMode = true;
            const btn = document.getElementById('btn-eraser-map');
            btn.classList.add('active');
            btn.textContent = '🧹 ลบหมุด (กำลังใช้ — คลิกหมุด)';
            map.getContainer().style.cursor = 'crosshair';
            showStatus('คลิกหมุด 🟢 เพื่อลบ (โหมดลบ)');
        }

        // Toggle click handlers on AI markers
        buildingMarkers.eachLayer(marker => {
            if (eraserMode) {
                marker._eraserHandler = function () {
                    buildingMarkers.removeLayer(marker);
                    detectedCount = Math.max(0, detectedCount - 1);
                    updateCounter(); updateResults();
                };
                marker.on('click', marker._eraserHandler);
                if (marker._icon) marker._icon.style.cursor = 'pointer';
            } else {
                if (marker._eraserHandler) {
                    marker.off('click', marker._eraserHandler);
                    delete marker._eraserHandler;
                }
                if (marker._icon) marker._icon.style.cursor = '';
            }
        });
    }

    // ========================
    //  AI Detection from Map Tiles
    //  - Only detects in NEW (unprocessed) areas
    //  - Keeps existing markers from old areas
    // ========================
    async function detectFromMap() {
        const allAreas = drawnItems.getLayers();
        if (allAreas.length === 0 || detecting) return;

        // Find only areas that haven't been detected yet
        const newAreas = allAreas.filter(a => !a._detected);
        if (newAreas.length === 0) {
            showStatus('ทุกพื้นที่ตรวจจับแล้ว — วาดพื้นที่ใหม่เพื่อตรวจจับเพิ่ม');
            return;
        }

        detecting = true;

        const btn = document.getElementById('btn-count');
        btn.disabled = true;
        btn.textContent = '⏳ กำลังตรวจจับ...';

        const bar = document.getElementById('map-progress-bar');
        const fill = document.getElementById('map-progress-fill');
        const pText = document.getElementById('map-progress-text');
        bar.style.display = 'block';
        fill.style.width = '0%';

        // DON'T clear old markers — keep results from previous areas

        try {
            const zoom = map.getZoom();

            if (zoom < 15) {
                showStatus('⚠️ แนะนำ zoom เข้าไปอีก (ระดับ 16-19) เพื่อความแม่นยำ');
            }

            let newDetected = 0;

            for (let areaIdx = 0; areaIdx < newAreas.length; areaIdx++) {
                const currentArea = newAreas[areaIdx];
                const areaLabel = `พื้นที่ ${areaIdx + 1}/${newAreas.length}`;
                pText.textContent = `${areaLabel}: เตรียมจับภาพ...`;

                const areaProgressBase = (areaIdx / newAreas.length) * 100;
                const areaProgressSpan = (1 / newAreas.length) * 100;

                const bounds = currentArea.getBounds();

                // --- Step 1: Calculate tile range ---
                const nwPoint = map.project(bounds.getNorthWest(), zoom);
                const sePoint = map.project(bounds.getSouthEast(), zoom);

                const tileSize = 256;
                const minTX = Math.floor(nwPoint.x / tileSize);
                const minTY = Math.floor(nwPoint.y / tileSize);
                const maxTX = Math.floor(sePoint.x / tileSize);
                const maxTY = Math.floor(sePoint.y / tileSize);

                const tilesW = maxTX - minTX + 1;
                const tilesH = maxTY - minTY + 1;
                const totalTiles = tilesW * tilesH;

                if (totalTiles > 120) {
                    showStatus(`⚠️ ${areaLabel} ใหญ่เกินไป — ข้าม`);
                    continue;
                }

                // --- Step 2: Download & stitch tiles ---
                pText.textContent = `${areaLabel}: โหลด tile 0/${totalTiles}`;
                fill.style.width = (areaProgressBase + areaProgressSpan * 0.05) + '%';

                const stitchCanvas = document.createElement('canvas');
                stitchCanvas.width = tilesW * tileSize;
                stitchCanvas.height = tilesH * tileSize;
                const sCtx = stitchCanvas.getContext('2d');

                const useRoadMap = (activeLayer === 'road');
                const tileUrlTemplate = useRoadMap
                    ? 'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png'
                    : 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
                let loaded = 0;
                let tileFails = 0;

                const loadPromises = [];
                for (let ty = minTY; ty <= maxTY; ty++) {
                    for (let tx = minTX; tx <= maxTX; tx++) {
                        const url = tileUrlTemplate
                            .replace('{z}', zoom)
                            .replace('{y}', ty)
                            .replace('{x}', tx);
                        const drawX = (tx - minTX) * tileSize;
                        const drawY = (ty - minTY) * tileSize;

                        loadPromises.push(new Promise(resolve => {
                            const tileImg = new Image();
                            tileImg.crossOrigin = 'anonymous';
                            tileImg.onload = () => {
                                sCtx.drawImage(tileImg, drawX, drawY);
                                loaded++;
                                pText.textContent = `${areaLabel}: โหลด tile ${loaded}/${totalTiles}`;
                                fill.style.width = (areaProgressBase + areaProgressSpan * (0.05 + (loaded / totalTiles) * 0.2)) + '%';
                                resolve(true);
                            };
                            tileImg.onerror = () => { loaded++; tileFails++; resolve(false); };
                            tileImg.src = url;
                        }));
                    }
                }

                await Promise.all(loadPromises);

                // --- Step 3: Crop to area bounds ---
                pText.textContent = `${areaLabel}: ตัดภาพพื้นที่...`;
                fill.style.width = (areaProgressBase + areaProgressSpan * 0.28) + '%';

                const cropX = Math.round(nwPoint.x - minTX * tileSize);
                const cropY = Math.round(nwPoint.y - minTY * tileSize);
                const cropW = Math.max(1, Math.round(sePoint.x - nwPoint.x));
                const cropH = Math.max(1, Math.round(sePoint.y - nwPoint.y));

                const cropCanvas = document.createElement('canvas');
                cropCanvas.width = cropW;
                cropCanvas.height = cropH;
                const cCtx = cropCanvas.getContext('2d');
                cCtx.drawImage(stitchCanvas, -cropX, -cropY);

                if (tileFails === totalTiles) {
                    showStatus(`⚠️ ${areaLabel}: โหลด tile ไม่ได้ — ลองซูมเข้า/ออก แล้วลองใหม่`);
                    continue;
                }

                let imageData;
                try {
                    imageData = cCtx.getImageData(0, 0, cropW, cropH);
                } catch (corsErr) {
                    console.error('Canvas CORS error:', corsErr);
                    showStatus('⚠️ ไม่สามารถอ่านข้อมูล tile ได้ (CORS) — กด Ctrl+Shift+R รีโหลดหน้าแล้วลองใหม่');
                    continue;
                }

                // --- Step 4: Build area mask ---
                // ALWAYS build areaMask for all shape types (circle, polygon, rectangle)
                const areaMask = new Uint8Array(cropW * cropH);

                if (currentArea instanceof L.Circle) {
                    const center = currentArea.getLatLng();
                    const centerPx = map.project(center, zoom);
                    const cxLocal = centerPx.x - nwPoint.x;
                    const cyLocal = centerPx.y - nwPoint.y;

                    const radiusM = currentArea.getRadius();
                    const offsetLng = radiusM / (6378137 * Math.cos(center.lat * Math.PI / 180)) * (180 / Math.PI);
                    const edgePx = map.project(L.latLng(center.lat, center.lng + offsetLng), zoom);
                    const radiusPx = Math.abs(edgePx.x - centerPx.x);

                    for (let y = 0; y < cropH; y++) {
                        for (let x = 0; x < cropW; x++) {
                            if (Math.hypot(x - cxLocal, y - cyLocal) <= radiusPx) {
                                areaMask[y * cropW + x] = 1;
                            }
                        }
                    }
                } else if (currentArea instanceof L.Polygon) {
                    // Works for both Polygon and Rectangle (Rectangle extends Polygon)
                    const latlngs = currentArea.getLatLngs()[0]; // outer ring
                    const polyPx = latlngs.map(ll => {
                        const pt = map.project(ll, zoom);
                        return { x: pt.x - nwPoint.x, y: pt.y - nwPoint.y };
                    });

                    for (let y = 0; y < cropH; y++) {
                        for (let x = 0; x < cropW; x++) {
                            if (pointInPolygon(x, y, polyPx)) {
                                areaMask[y * cropW + x] = 1;
                            }
                        }
                    }
                } else {
                    // Fallback: fill entire crop area
                    areaMask.fill(1);
                }

                // --- Step 5: Run detector ---
                pText.textContent = `${areaLabel}: กำลังตรวจจับหลังคา...`;
                fill.style.width = (areaProgressBase + areaProgressSpan * 0.30) + '%';

                await new Promise(resolve => setTimeout(resolve, 50));

                const sensitivity = parseInt(document.getElementById('map-sensitivity').value) || 5;
                let results;

                if (useRoadMap) {
                    // Road map mode: detect brown/beige building blocks from OSM tiles
                    results = RooftopDetector.detectBlocks(imageData, cropW, cropH, areaMask, sensitivity, (pct, msg) => {
                        const overall = areaProgressBase + areaProgressSpan * (0.30 + pct * 0.0065);
                        fill.style.width = Math.min(overall, areaProgressBase + areaProgressSpan * 0.95) + '%';
                        pText.textContent = `${areaLabel}: ${msg}`;
                    });
                } else {
                    // Satellite mode: use full AI rooftop detector
                    const minArea = getAutoMinArea(zoom);
                    const maxArea = getAutoMaxArea(zoom);
                    results = RooftopDetector.detect(imageData, cropW, cropH, {
                        sensitivity, minArea, maxArea, areaMask
                    }, (pct, msg) => {
                        const overall = areaProgressBase + areaProgressSpan * (0.30 + pct * 0.0065);
                        fill.style.width = Math.min(overall, areaProgressBase + areaProgressSpan * 0.95) + '%';
                        pText.textContent = `${areaLabel}: ${msg}`;
                    });
                }

                // --- Step 6: Convert pixel coords → lat/lng → map markers ---
                // STRICT: only accept results whose centroid pixel is INSIDE areaMask
                pText.textContent = `${areaLabel}: ปักหมุด ${results.length} จุด...`;

                let areaDetected = 0;
                results.forEach(r => {
                    // Check centroid pixel is inside the drawn area mask
                    const px = Math.round(r.x);
                    const py = Math.round(r.y);
                    if (px >= 0 && px < cropW && py >= 0 && py < cropH) {
                        if (!areaMask[py * cropW + px]) return; // OUTSIDE area → skip
                    }

                    const globalPx = L.point(nwPoint.x + r.x, nwPoint.y + r.y);
                    const latlng = map.unproject(globalPx, zoom);

                    areaDetected++;
                    detectedCount++;
                    const marker = L.marker(latlng, {
                        icon: L.divIcon({ className: 'map-marker', iconSize: [10, 10], iconAnchor: [5, 5] })
                    }).addTo(buildingMarkers);
                    marker._areaLayer = currentArea; // link marker to its area
                });

                // Mark this area as detected
                currentArea._detected = true;
                currentArea._detectedCount = areaDetected;
                // Change area style to show it's been processed
                if (currentArea.setStyle) {
                    currentArea.setStyle({ color: '#10b981', fillColor: '#10b981' });
                }
            }

            fill.style.width = '100%';
            pText.textContent = `เสร็จสิ้น! พบเพิ่ม ${newDetected || detectedCount} หลังคา (รวม ${detectedCount})`;

            updateCounter();
            updateResults();
            showStatus(`ตรวจจับเสร็จ — รวม ${detectedCount} หลังคา จาก ${allAreas.filter(a => a._detected).length} พื้นที่`);

        } catch (e) {
            console.error('Detection error:', e);
            showStatus('เกิดข้อผิดพลาด: ' + e.message);
        }

        resetDetectBtn();
    }

    // Ray casting point-in-polygon test
    function pointInPolygon(x, y, polygon) {
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

    function resetDetectBtn() {
        detecting = false;
        const btn = document.getElementById('btn-count');
        // Enable if there are any undetected areas
        const hasNew = drawnItems.getLayers().some(a => !a._detected);
        btn.disabled = !hasNew;
        btn.textContent = hasNew ? '🤖 ตรวจจับหลังคาอัตโนมัติ' : '✅ ตรวจจับครบทุกพื้นที่แล้ว';
        setTimeout(() => {
            document.getElementById('map-progress-bar').style.display = 'none';
        }, 1500);
    }

    // Auto-calculate min/max roof area based on zoom level
    function getAutoMinArea(zoom) {
        if (zoom >= 19) return 150;
        if (zoom >= 18) return 100;
        if (zoom >= 17) return 70;
        if (zoom >= 16) return 50;
        if (zoom >= 15) return 30;
        return 20;
    }

    function getAutoMaxArea(zoom) {
        if (zoom >= 19) return 40000;
        if (zoom >= 18) return 25000;
        if (zoom >= 17) return 15000;
        if (zoom >= 16) return 10000;
        if (zoom >= 15) return 6000;
        return 3000;
    }

    // ========================
    //  Smart Location Search
    // ========================
    function setupSearch() {
        const input = document.getElementById('map-search');
        const btn = document.getElementById('btn-search');
        const resultsEl = document.getElementById('search-results');
        let searchTimeout = null;

        document.getElementById('btn-open-gmaps').addEventListener('click', () => {
            const c = map.getCenter();
            const z = map.getZoom();
            window.open(`https://www.google.com/maps/@${c.lat},${c.lng},${z}z`, '_blank');
        });

        async function doSearch() {
            const query = input.value.trim();
            if (!query) { resultsEl.classList.remove('show'); return; }

            const gmResult = parseGoogleMapsUrl(query);
            if (gmResult) {
                let placeName = 'Google Maps URL';
                const placeMatch = query.match(/\/place\/([^/@]+)/);
                if (placeMatch) {
                    try { placeName = decodeURIComponent(placeMatch[1]).replace(/\+/g, ' '); } catch(e) {}
                }
                goToLocation(gmResult.lat, gmResult.lng, gmResult.zoom, placeName);
                resultsEl.classList.remove('show');
                return;
            }

            if (isShortGoogleUrl(query)) {
                window.open(query, '_blank');
                resultsEl.innerHTML = `
                    <div class="search-item" style="cursor:default; background:#1e3a5f; border:1px solid #3b82f6;">
                        <div class="search-name">📋 ขั้นตอน:</div>
                        <div class="search-detail" style="color:#94a3b8; line-height:1.8; margin-top:4px;">
                            1. แท็บ Google Maps เปิดแล้ว<br>
                            2. <b style="color:#f59e0b">คัดลอก URL จาก address bar</b> (URL ยาวๆ)<br>
                            3. กลับมาวางที่ช่องนี้
                        </div>
                    </div>`;
                resultsEl.classList.add('show');
                input.value = '';
                input.setAttribute('placeholder', 'วาง URL เต็มจาก Google Maps ที่นี่...');
                return;
            }

            const coordResult = parseCoordinates(query);
            if (coordResult) {
                goToLocation(coordResult.lat, coordResult.lng, 17, 'พิกัด');
                resultsEl.classList.remove('show');
                return;
            }

            searchNominatim(query);
        }

        function parseGoogleMapsUrl(text) {
            if (!text.includes('google.com/maps') && !text.includes('maps.google')) return null;

            let zoom = 17;
            const zoomMatch = text.match(/@[^,]+,[^,]+,(\d+\.?\d*)z/);
            if (zoomMatch) zoom = Math.round(parseFloat(zoomMatch[1]));

            const lat3d = text.match(/!3d(-?\d+\.?\d+)/);
            const lng4d = text.match(/!4d(-?\d+\.?\d+)/);
            if (lat3d && lng4d) {
                return { lat: parseFloat(lat3d[1]), lng: parseFloat(lng4d[1]), zoom };
            }

            let m = text.match(/[?&](?:q|ll|center)=(-?\d+\.?\d*),(-?\d+\.?\d*)/);
            if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]), zoom };

            m = text.match(/@(-?\d+\.?\d*),(-?\d+\.?\d*)/);
            if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]), zoom };

            return null;
        }

        function isShortGoogleUrl(text) {
            return /maps\.app\.goo\.gl|goo\.gl\/maps/.test(text);
        }

        function parseCoordinates(text) {
            const m = text.match(/^(-?\d+\.?\d*)[,\s]+(-?\d+\.?\d*)$/);
            if (m) {
                const a = parseFloat(m[1]), b = parseFloat(m[2]);
                if (Math.abs(a) <= 90 && Math.abs(b) <= 180) return { lat: a, lng: b };
                if (Math.abs(b) <= 90 && Math.abs(a) <= 180) return { lat: b, lng: a };
            }
            return null;
        }

        function goToLocation(lat, lng, zoom, source) {
            zoom = Math.min(Math.max(zoom, 10), 19);

            if (searchPin) { map.removeLayer(searchPin); searchPin = null; }
            // Only remove radius circle if not locked
            if (radiusCircle && !radiusCircle._locked) {
                map.removeLayer(radiusCircle); radiusCircle = null;
            }

            searchPin = L.marker([lat, lng], {
                icon: L.icon({
                    iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-red.png',
                    shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
                    iconSize: [25, 41],
                    iconAnchor: [12, 41],
                    popupAnchor: [1, -34],
                    shadowSize: [41, 41]
                })
            }).addTo(map);
            searchPin.bindPopup(`📍 <b>${source}</b><br>${lat.toFixed(5)}, ${lng.toFixed(5)}`).openPopup();

            map.flyTo([lat, lng], zoom, { duration: 1.5 });
            showStatus(`📍 ไปยังพิกัด ${lat.toFixed(4)}, ${lng.toFixed(4)} (${source})`);

            // Show radius panel & reset UI if not locked
            const radiusPanel = document.getElementById('radius-panel');
            if (radiusPanel) radiusPanel.style.display = 'block';

            if (!radiusCircle || !radiusCircle._locked) {
                const slider = document.getElementById('radius-slider');
                if (slider) {
                    slider.disabled = false;
                    const lockBtn = document.getElementById('btn-lock-radius');
                    const clearBtn = document.getElementById('btn-clear-radius');
                    if (lockBtn) lockBtn.style.display = 'block';
                    if (clearBtn) clearBtn.style.display = 'none';

                    const val = parseInt(slider.value);
                    radiusCircle = L.circle([lat, lng], {
                        radius: val,
                        color: '#3b82f6', weight: 3,
                        fillColor: '#3b82f6', fillOpacity: 0.05,
                        dashArray: '12,8'
                    }).addTo(map);
                    radiusCircle._locked = false;
                }
            }
        }

        function searchNominatim(query) {
            resultsEl.innerHTML = '<div class="search-loading">🔍 กำลังค้นหา...</div>';
            resultsEl.classList.add('show');

            fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=6&accept-language=th,en`, {
                headers: { 'User-Agent': 'RooftopCounterApp/1.0' }
            })
            .then(r => r.json())
            .then(data => {
                if (!data.length) {
                    resultsEl.innerHTML = '<div class="search-loading">ไม่พบสถานที่ — ลองวาง URL จาก Google Maps แทน</div>';
                    return;
                }
                resultsEl.innerHTML = '';
                data.forEach(place => {
                    const item = document.createElement('div');
                    item.className = 'search-item';
                    const parts = place.display_name.split(',');
                    const name = parts[0].trim();
                    const detail = parts.slice(1, 4).join(',').trim();
                    item.innerHTML = `<div class="search-name">📍 ${name}</div><div class="search-detail">${detail}</div>`;
                    item.addEventListener('click', () => {
                        const lat = parseFloat(place.lat);
                        const lon = parseFloat(place.lon);
                        let zoom = 16;
                        if (place.boundingbox) {
                            const bb = place.boundingbox.map(Number);
                            const span = Math.max(bb[1] - bb[0], bb[3] - bb[2]);
                            if (span > 1) zoom = 10;
                            else if (span > 0.1) zoom = 13;
                            else if (span > 0.01) zoom = 15;
                            else zoom = 17;
                        }
                        goToLocation(lat, lon, zoom, name);
                        input.value = name;
                        resultsEl.classList.remove('show');
                    });
                    resultsEl.appendChild(item);
                });
            })
            .catch(() => {
                resultsEl.innerHTML = '<div class="search-loading">เกิดข้อผิดพลาด — ลองวาง Google Maps URL แทน</div>';
            });
        }

        btn.addEventListener('click', doSearch);
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); doSearch(); }
        });

        input.addEventListener('paste', () => {
            setTimeout(() => {
                input.setAttribute('placeholder', 'วาง Google Maps URL, พิกัด, หรือชื่อสถานที่...');
                const val = input.value.trim();
                if (parseGoogleMapsUrl(val) || parseCoordinates(val) || isShortGoogleUrl(val)) {
                    doSearch();
                }
            }, 100);
        });

        input.addEventListener('input', () => {
            clearTimeout(searchTimeout);
            const q = input.value.trim();
            if (q.length >= 3 && !q.includes('google') && !q.includes('goo.gl') && !q.match(/^-?\d+\.?\d*[,\s]/)) {
                searchTimeout = setTimeout(doSearch, 800);
            } else {
                resultsEl.classList.remove('show');
            }
        });

        document.addEventListener('click', e => {
            if (!e.target.closest('.search-box') && !e.target.closest('.search-results') && !e.target.closest('#btn-open-gmaps')) {
                resultsEl.classList.remove('show');
            }
        });
    }

    // ========================
    //  UI helpers
    // ========================
    function updateCounter() {
        const total = detectedCount + manualPins.length;
        const el = document.getElementById('map-pin-counter');
        if (total > 0) {
            el.style.display = 'block';
            let text = `หลังคา: ${total}`;
            if (detectedCount > 0 && manualPins.length > 0) {
                text += ` (AI ${detectedCount} + มือ ${manualPins.length})`;
            } else if (manualPins.length > 0) {
                text += ` (มือ ${manualPins.length})`;
            }
            el.textContent = text;
        } else {
            el.style.display = 'none';
        }
    }

    function updateResults() {
        const total = detectedCount + manualPins.length;
        if (total === 0) {
            document.getElementById('results-panel').style.display = 'none';
            return;
        }
        const avg = parseFloat(document.getElementById('avg-people-map').value) || 3.5;
        document.getElementById('result-houses').textContent = total.toLocaleString() + ' หลัง';
        document.getElementById('result-population').textContent = Math.round(total * avg).toLocaleString() + ' คน';
        document.getElementById('result-source').textContent =
            detectedCount > 0 && manualPins.length > 0 ? `AI ${detectedCount} + มือ ${manualPins.length}` :
            detectedCount > 0 ? `AI ตรวจจับ (${detectedCount})` : `ปักหมุดเอง (${manualPins.length})`;
        document.getElementById('results-panel').style.display = 'block';
    }

    function showStatus(msg) {
        const el = document.getElementById('map-status');
        el.textContent = msg;
        el.classList.toggle('show', !!msg);
        if (msg) setTimeout(() => el.classList.remove('show'), 5000);
    }

    // ========================
    //  Tab switching
    // ========================
    document.addEventListener('DOMContentLoaded', () => {
        document.getElementById('tab-image').addEventListener('click', () => {
            document.getElementById('tab-image').classList.add('active');
            document.getElementById('tab-map').classList.remove('active');
            document.getElementById('image-mode').style.display = 'flex';
            document.getElementById('map-mode').style.display = 'none';
            document.getElementById('image-controls').style.display = 'block';
            document.getElementById('map-controls').style.display = 'none';
        });
        document.getElementById('tab-map').addEventListener('click', () => {
            document.getElementById('tab-map').classList.add('active');
            document.getElementById('tab-image').classList.remove('active');
            document.getElementById('map-mode').style.display = 'block';
            document.getElementById('image-mode').style.display = 'none';
            document.getElementById('map-controls').style.display = 'block';
            document.getElementById('image-controls').style.display = 'none';
            initMap();
            setTimeout(() => map && map.invalidateSize(), 100);
        });
    });
})();
