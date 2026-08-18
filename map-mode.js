// ===== Map Mode (AI Rooftop Detection + Manual Pins) =====
// Copyright (c) 2025-2026 Kanyarat Saosomphop. All rights reserved.
(function () {
    let map, drawnItems, buildingMarkers;
    let manualMode = false;
    let manualPins = [];   // { marker, latlng }
    let detectedCount = 0;
    let mapInitialized = false;
    let detecting = false;
    let eraserMode = false;
    let eraseAreaMode = false;
    let searchPin = null;      // Red pin from URL/search
    let radiusCircle = null;   // Radius circle around search pin
    let freehandMode = false;
    let activeLayer = 'road';  // 'road' or 'satellite'
    let freehandPoints = [];
    let freehandPolyline = null;
    let drawControl = null;

    // Undo stack: 'area' | 'pin' | { type:'detection', count:N }
    let undoStackMap = [];

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

        // Labels overlay — shows street/soi names on top of satellite
        map.createPane('labels');
        map.getPane('labels').style.zIndex = 650;
        map.getPane('labels').style.pointerEvents = 'none';
        const labels = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png', {
            attribution: '&copy; OpenStreetMap &copy; CARTO',
            maxZoom: 19,
            pane: 'labels'
        });

        // Default to road map
        roadMap.addTo(map);

        // Track active layer — auto-toggle labels via checkbox click
        map.on('baselayerchange', e => {
            activeLayer = e.name.includes('ดาวเทียม') ? 'satellite' : 'road';
            const cb = document.querySelector('.leaflet-control-layers input[type="checkbox"]');
            if (activeLayer === 'satellite') {
                if (cb && !cb.checked) cb.click();
            } else {
                if (cb && cb.checked) cb.click();
            }
        });

        // Layer switcher control
        L.control.layers({
            '🗺️ แผนที่ถนน': roadMap,
            '🛰️ ดาวเทียม': satellite
        }, {
            '🏷️ ชื่อถนน/ซอย': labels
        }, { position: 'topleft', collapsed: false }).addTo(map);

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
            undoStackMap.push('area');
            document.getElementById('btn-count').disabled = false;
            document.getElementById('btn-count').textContent = '🤖 ตรวจจับหลังคาอัตโนมัติ';
            updateAreaCount(); updateUndoMap();
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
            undoStackMap.push('pin');
            updateCounter(); updateResults();
        });

        // Buttons
        document.getElementById('btn-count').addEventListener('click', detectFromMap);
        const btnOsm = document.getElementById('btn-osm');
        if (btnOsm) btnOsm.addEventListener('click', countBuildingsOSM);
        const btnOb = document.getElementById('btn-ob');
        if (btnOb) btnOb.addEventListener('click', countBuildingsOB);

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
                showStatus('คลิกหลังคา = เพิ่มหมุด (🟡) | คลิกหมุดเดิม = ลบ');
            }
        });

        document.getElementById('btn-eraser-map').addEventListener('click', toggleEraser);

        document.getElementById('btn-clear-ai-map').addEventListener('click', () => {
            buildingMarkers.clearLayers();
            detectedCount = 0;
            // Remove detection entries from undo stack
            undoStackMap = undoStackMap.filter(u => u !== 'pin' || true).filter(u => typeof u === 'string');
            // Reset all areas so they can be re-detected
            drawnItems.getLayers().forEach(a => {
                a._detected = false;
                if (a.setStyle) a.setStyle({ color: '#f59e0b', fillColor: '#f59e0b' });
            });
            document.getElementById('btn-count').disabled = drawnItems.getLayers().length === 0;
            document.getElementById('btn-count').textContent = '🤖 ตรวจจับหลังคาอัตโนมัติ';
            updateCounter(); updateResults(); updateUndoMap();
            showStatus('ลบหมุด AI ทั้งหมดแล้ว — กดตรวจจับใหม่ได้');
        });

        document.getElementById('btn-undo-map').addEventListener('click', () => {
            if (undoStackMap.length === 0) return;
            const last = undoStackMap.pop();
            if (last === 'area') {
                // Remove last drawn area
                const layers = drawnItems.getLayers();
                if (layers.length > 0) {
                    drawnItems.removeLayer(layers[layers.length - 1]);
                    updateAreaCount();
                    if (drawnItems.getLayers().length === 0) {
                        document.getElementById('btn-count').disabled = true;
                    }
                }
            } else if (last === 'pin') {
                if (manualPins.length > 0) {
                    const p = manualPins.pop();
                    map.removeLayer(p.marker);
                }
            } else if (typeof last === 'object' && last.type === 'detection') {
                // Remove last N AI markers
                const layers = buildingMarkers.getLayers();
                let toRemove = last.count;
                for (let i = layers.length - 1; i >= 0 && toRemove > 0; i--) {
                    buildingMarkers.removeLayer(layers[i]);
                    detectedCount = Math.max(0, detectedCount - 1);
                    toRemove--;
                }
                // Reset _detected flag on all areas so they can be re-detected
                drawnItems.getLayers().forEach(a => {
                    a._detected = false;
                    if (a.setStyle) a.setStyle({ color: '#f59e0b', fillColor: '#f59e0b' });
                });
                // Re-enable detect button
                const btn = document.getElementById('btn-count');
                btn.disabled = drawnItems.getLayers().length === 0;
                btn.textContent = '🤖 ตรวจจับหลังคาอัตโนมัติ';
            }
            updateCounter(); updateResults(); updateUndoMap();
        });

        // Erase area mode
        document.getElementById('btn-erase-area-map').addEventListener('click', () => {
            const wasEraseArea = eraseAreaMode;
            deactivateAllModes();
            cancelLeafletDraw();
            if (!wasEraseArea) {
                eraseAreaMode = true;
                const btn = document.getElementById('btn-erase-area-map');
                btn.classList.add('active');
                btn.textContent = '🧹 คลิกวงที่ต้องการลบ...';
                map.getContainer().style.cursor = 'crosshair';
                showStatus('คลิกบนวงพื้นที่ที่ต้องการลบ');

                // Add click handler on each drawn area
                drawnItems.eachLayer(layer => {
                    layer._eraseAreaHandler = function () {
                        drawnItems.removeLayer(layer);
                        // Remove one 'area' from undo stack
                        for (let i = undoStackMap.length - 1; i >= 0; i--) {
                            if (undoStackMap[i] === 'area') { undoStackMap.splice(i, 1); break; }
                        }
                        updateAreaCount(); updateUndoMap();
                        if (drawnItems.getLayers().length === 0) {
                            document.getElementById('btn-count').disabled = true;
                        }
                        showStatus('ลบวงพื้นที่แล้ว');
                    };
                    layer.on('click', layer._eraseAreaHandler);
                    if (layer._path) layer._path.style.cursor = 'pointer';
                });
            }
        });

        document.getElementById('btn-clear-map').addEventListener('click', () => {
            drawnItems.clearLayers(); buildingMarkers.clearLayers();
            manualPins.forEach(p => map.removeLayer(p.marker));
            manualPins = [];
            detectedCount = 0; eraserMode = false; undoStackMap = [];
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

        // Sensitivity: live value + auto re-detect (pixel detection only — OSM ignores it)
        const mSensEl = document.getElementById('map-sensitivity');
        const mSensVal = document.getElementById('map-sensitivity-val');
        if (mSensEl && mSensVal) {
            mSensEl.addEventListener('input', () => { mSensVal.textContent = mSensEl.value; });
            mSensEl.addEventListener('change', () => {
                mSensVal.textContent = mSensEl.value;
                if (detecting) return;
                // Only re-run when there are areas detected via pixel detection
                const pixelAreas = drawnItems.getLayers().filter(a => a._detected && a._detectSource === 'pixel');
                if (pixelAreas.length === 0) return;
                // Clear AI markers, reset areas, re-run pixel detection with new sensitivity
                buildingMarkers.clearLayers();
                detectedCount = 0;
                undoStackMap = undoStackMap.filter(u => typeof u === 'string');
                drawnItems.getLayers().forEach(a => {
                    a._detected = false;
                    if (a.setStyle) a.setStyle({ color: '#f59e0b', fillColor: '#f59e0b' });
                });
                document.getElementById('btn-count').disabled = drawnItems.getLayers().length === 0;
                updateCounter(); updateResults(); updateUndoMap();
                showStatus('ปรับความไวเป็น ' + mSensEl.value + ' — กำลังนับใหม่...');
                detectFromMap();
            });
        }

        // --- Survey database (Phase 1: local) ---
        const sSave = document.getElementById('btn-survey-save');
        if (sSave) sSave.addEventListener('click', saveSurvey);
        const sExp = document.getElementById('btn-survey-export');
        if (sExp) sExp.addEventListener('click', exportSurveys);
        const sImp = document.getElementById('btn-survey-import');
        if (sImp) sImp.addEventListener('click', () => document.getElementById('survey-import-file').click());
        const sImpFile = document.getElementById('survey-import-file');
        if (sImpFile) sImpFile.addEventListener('change', importSurveys);
        renderSurveyList();
    }

    // ========================
    //  Survey database — capture / list / backup counting sessions
    // ========================
    function currentSurveyMethod() {
        const sources = new Set();
        drawnItems.eachLayer(a => { if (a._detectSource) sources.add(a._detectSource); });
        if (sources.size === 1) return [...sources][0];
        if (sources.size > 1) return 'mixed';
        if (manualPins.length && !detectedCount) return 'manual';
        return detectedCount ? 'unknown' : 'manual';
    }

    function collectSurveyAreas() {
        const areas = [];
        drawnItems.eachLayer(a => {
            if (a instanceof L.Circle) {
                const c = a.getLatLng();
                areas.push({ type: 'circle', lat: c.lat, lon: c.lng, radius: a.getRadius() });
            } else if (a instanceof L.Polygon) {
                areas.push({ type: 'polygon', latlngs: a.getLatLngs()[0].map(p => [p.lat, p.lng]) });
            }
        });
        return areas;
    }

    function collectSurveyPoints() {
        const pts = [];
        buildingMarkers.eachLayer(m => { const ll = m.getLatLng(); pts.push([+ll.lat.toFixed(6), +ll.lng.toFixed(6), 'auto']); });
        manualPins.forEach(p => pts.push([+p.latlng.lat.toFixed(6), +p.latlng.lng.toFixed(6), 'manual']));
        return pts;
    }

    async function saveSurvey() {
        const total = detectedCount + manualPins.length;
        if (total === 0) { showStatus('ยังไม่มีข้อมูลให้บันทึก — กดนับก่อน'); return; }
        const pph = parseFloat(document.getElementById('avg-people-map').value) || 3.5;
        const center = map.getCenter();
        const rec = {
            label: document.getElementById('survey-label').value.trim() || ('ทำเล ' + new Date().toLocaleDateString('th-TH')),
            notes: document.getElementById('survey-notes').value.trim(),
            center: { lat: +center.lat.toFixed(6), lon: +center.lng.toFixed(6) },
            zoom: map.getZoom(),
            method: currentSurveyMethod(),
            buildings_total: total,
            buildings_auto: detectedCount,
            buildings_manual: manualPins.length,
            people_per_household: pph,
            population: Math.round(total * pph),
            areas: collectSurveyAreas(),
            points: collectSurveyPoints()
        };
        try {
            await SurveyDB.save(rec);
            document.getElementById('survey-label').value = '';
            document.getElementById('survey-notes').value = '';
            showStatus(`🗄️ บันทึกแล้ว: ${rec.label} — ${rec.buildings_total} หลัง / ~${rec.population} คน`);
            renderSurveyList();
        } catch (e) {
            console.error('save survey', e);
            showStatus('บันทึกไม่สำเร็จ: ' + e.message);
        }
    }

    async function renderSurveyList() {
        const el = document.getElementById('survey-list');
        if (!el) return;
        let recs = [];
        try { recs = await SurveyDB.list(); } catch (e) { el.innerHTML = ''; return; }
        if (recs.length === 0) {
            el.innerHTML = '<div style="color:#64748b;font-size:0.78rem">ยังไม่มีข้อมูลที่บันทึก</div>';
            return;
        }
        el.innerHTML = `<div style="font-size:0.78rem;color:#94a3b8;margin-bottom:4px">เก็บไว้ ${recs.length} ทำเล</div>` +
            recs.map(r => {
                const d = new Date(r.updated_at);
                const date = d.toLocaleDateString('th-TH') + ' ' + d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
                return `<div class="survey-item" data-id="${r.id}" data-lat="${r.center.lat}" data-lon="${r.center.lon}" data-zoom="${r.zoom || 16}"
                    style="display:flex;align-items:center;gap:6px;padding:6px 4px;border-bottom:1px solid rgba(148,163,184,0.15)">
                    <div style="flex:1;min-width:0">
                        <div style="font-weight:600;font-size:0.82rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${r.label}</div>
                        <div style="font-size:0.72rem;color:#94a3b8">${r.buildings_total} หลัง · ~${r.population} คน · ${date}</div>
                    </div>
                    <button class="survey-go" title="ไปที่ทำเล" style="background:none;border:none;cursor:pointer;font-size:1rem">📍</button>
                    <button class="survey-del" title="ลบ" style="background:none;border:none;cursor:pointer;font-size:1rem">🗑️</button>
                </div>`;
            }).join('');

        el.querySelectorAll('.survey-item').forEach(item => {
            const id = item.dataset.id;
            item.querySelector('.survey-go').addEventListener('click', () => {
                map.flyTo([parseFloat(item.dataset.lat), parseFloat(item.dataset.lon)], parseInt(item.dataset.zoom) || 16);
            });
            item.querySelector('.survey-del').addEventListener('click', async () => {
                await SurveyDB.remove(id);
                renderSurveyList();
                showStatus('ลบทำเลออกจากฐานข้อมูลแล้ว');
            });
        });
    }

    async function exportSurveys() {
        const recs = await SurveyDB.exportAll();
        if (recs.length === 0) { showStatus('ยังไม่มีข้อมูลให้ export'); return; }
        const blob = new Blob([JSON.stringify(recs, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'rooftop-surveys-' + new Date().toISOString().slice(0, 10) + '.json';
        document.body.appendChild(a); a.click();
        setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 800);
        showStatus(`⬇️ Export ${recs.length} ทำเลแล้ว — เก็บไฟล์ไว้ backup`);
    }

    async function importSurveys(e) {
        const file = e.target.files[0];
        if (!file) return;
        try {
            const recs = JSON.parse(await file.text());
            if (!Array.isArray(recs)) throw new Error('รูปแบบไฟล์ไม่ถูกต้อง');
            const n = await SurveyDB.importAll(recs);
            renderSurveyList();
            showStatus(`⬆️ นำเข้า ${n} ทำเลแล้ว`);
        } catch (err) {
            showStatus('นำเข้าไม่สำเร็จ: ' + err.message);
        }
        e.target.value = '';
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

    function updateUndoMap() {
        document.getElementById('btn-undo-map').style.display = undoStackMap.length > 0 ? 'block' : 'none';
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
        if (eraseAreaMode) {
            eraseAreaMode = false;
            const eabtn = document.getElementById('btn-erase-area-map');
            eabtn.classList.remove('active');
            eabtn.textContent = '🧹 ยางลบวง';
            drawnItems.eachLayer(layer => {
                if (layer._eraseAreaHandler) {
                    layer.off('click', layer._eraseAreaHandler);
                    delete layer._eraseAreaHandler;
                }
                if (layer._path) layer._path.style.cursor = '';
            });
        }
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
        undoStackMap.push('area');
        document.getElementById('btn-count').disabled = false;
        document.getElementById('btn-count').textContent = '🤖 ตรวจจับหลังคาอัตโนมัติ';
        updateAreaCount(); updateUndoMap();
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
    //  Google Open Buildings — count from pre-tiled static data
    //  Tiles live in /buildings/{tx}_{ty}.json (0.01° grid). We only fetch the
    //  few tiles that overlap the requested area, so a count loads ~300 KB total.
    // ========================
    const OB_TILE = 0.01;   // must match the tiler that produced the files

    async function countBuildingsOB() {
        if (detecting) return;
        detecting = true;

        const btn = document.getElementById('btn-ob');
        btn.disabled = true;
        btn.textContent = '⏳ กำลังโหลดข้อมูลอาคาร...';

        const bar = document.getElementById('ob-progress-bar');
        const fill = document.getElementById('ob-progress-fill');
        const pText = document.getElementById('ob-progress-text');
        bar.style.display = 'block';
        fill.style.width = '8%';
        pText.textContent = 'หาช่องข้อมูล...';

        try {
            // Same region logic as OSM: drawn areas → locked radius → viewport
            const allAreas = drawnItems.getLayers();
            let regions;
            if (allAreas.length > 0) {
                const newAreas = allAreas.filter(a => !a._detected);
                if (newAreas.length === 0) { showStatus('ทุกพื้นที่นับแล้ว — วาดพื้นที่ใหม่'); resetOBBtn(); return; }
                regions = newAreas.map(a => ({ area: a, bounds: a.getBounds() }));
            } else if (radiusCircle && radiusCircle._locked) {
                regions = [{ area: radiusCircle, bounds: radiusCircle.getBounds() }];
            } else {
                regions = [{ area: null, bounds: map.getBounds() }];
            }

            let totalNew = 0;

            for (let i = 0; i < regions.length; i++) {
                const { area, bounds } = regions[i];
                const label = regions.length > 1 ? `พื้นที่ ${i + 1}/${regions.length}` : 'พื้นที่';

                const km2 = approxAreaKm2(bounds);
                if (km2 > 60) { showStatus(`⚠️ ${label} กว้างเกินไป (~${Math.round(km2)} ตร.กม.) — ซูมเข้า/วาดให้เล็กลง`); continue; }

                const s = bounds.getSouth(), w = bounds.getWest(), n = bounds.getNorth(), e = bounds.getEast();

                // Which tiles overlap this area?
                const txMin = Math.floor(w / OB_TILE), txMax = Math.floor(e / OB_TILE);
                const tyMin = Math.floor(s / OB_TILE), tyMax = Math.floor(n / OB_TILE);
                const tiles = [];
                for (let tx = txMin; tx <= txMax; tx++)
                    for (let ty = tyMin; ty <= tyMax; ty++)
                        tiles.push([tx, ty]);

                if (tiles.length > 400) { showStatus(`⚠️ ${label} กว้างเกินไป`); continue; }

                pText.textContent = `${label}: โหลด ${tiles.length} ช่อง...`;

                // Fetch only the overlapping tiles (404 = no data there)
                let loaded = 0;
                const pts = [];
                await Promise.all(tiles.map(([tx, ty]) =>
                    fetch(`buildings/${tx}_${ty}.json`)
                        .then(r => r.ok ? r.json() : [])
                        .catch(() => [])
                        .then(arr => {
                            for (const p of arr) pts.push(p);
                            loaded++;
                            fill.style.width = (10 + (i / regions.length) * 80 + (loaded / tiles.length) * 15) + '%';
                        })
                ));

                // Filter to the exact area and drop markers
                let added = 0;
                for (const [lat, lon] of pts) {
                    if (area) {
                        if (!latLngInArea(L.latLng(lat, lon), area)) continue;
                    } else {
                        if (lat < s || lat > n || lon < w || lon > e) continue;
                    }
                    L.marker([lat, lon], {
                        icon: L.divIcon({ className: 'map-marker', iconSize: [10, 10], iconAnchor: [5, 5] })
                    }).addTo(buildingMarkers)._areaLayer = area;
                    added++;
                }

                detectedCount += added;
                totalNew += added;

                if (area && area !== radiusCircle) {
                    area._detected = true;
                    area._detectSource = 'ob';
                    area._detectedCount = added;
                    if (area.setStyle) area.setStyle({ color: '#10b981', fillColor: '#10b981' });
                }
            }

            fill.style.width = '100%';

            if (totalNew > 0) undoStackMap.push({ type: 'detection', count: totalNew });
            updateCounter(); updateResults(); updateUndoMap();

            if (totalNew === 0) {
                showStatus('ไม่พบข้อมูล Open Buildings ในพื้นที่นี้ — ตอนนี้มีเฉพาะโซนบางพลี/บางนา (นำร่อง)');
            } else {
                showStatus(`🛰️ Open Buildings: พบ ${totalNew} หลัง (รวมทั้งหมด ${detectedCount})`);
            }
        } catch (err) {
            console.error('OB error:', err);
            showStatus('⚠️ โหลดข้อมูลไม่ได้: ' + err.message);
        }

        resetOBBtn();
    }

    function resetOBBtn() {
        detecting = false;
        const btn = document.getElementById('btn-ob');
        btn.disabled = false;
        btn.textContent = '🛰️ นับจาก Open Buildings';
        setTimeout(() => {
            const b = document.getElementById('ob-progress-bar');
            if (b) b.style.display = 'none';
        }, 1500);
    }

    // ========================
    //  OSM Overpass — count REAL building footprints
    //  Pulls actual building geometry from OpenStreetMap instead of
    //  guessing from pixels. Far more accurate where data exists.
    // ========================
    async function countBuildingsOSM() {
        if (detecting) return;
        detecting = true;

        const btn = document.getElementById('btn-osm');
        btn.disabled = true;
        btn.textContent = '⏳ กำลังดึงข้อมูลอาคาร...';

        const bar = document.getElementById('osm-progress-bar');
        const fill = document.getElementById('osm-progress-fill');
        const pText = document.getElementById('osm-progress-text');
        bar.style.display = 'block';
        fill.style.width = '8%';
        pText.textContent = 'เชื่อมต่อ OpenStreetMap...';

        try {
            // --- Decide which region(s) to query ---
            // Priority: drawn (undetected) areas → locked radius → current viewport
            const allAreas = drawnItems.getLayers();
            let regions;
            if (allAreas.length > 0) {
                const newAreas = allAreas.filter(a => !a._detected);
                if (newAreas.length === 0) {
                    showStatus('ทุกพื้นที่นับแล้ว — วาดพื้นที่ใหม่เพื่อนับเพิ่ม');
                    resetOsmBtn(); return;
                }
                regions = newAreas.map(a => ({ area: a, bounds: a.getBounds() }));
            } else if (radiusCircle && radiusCircle._locked) {
                regions = [{ area: radiusCircle, bounds: radiusCircle.getBounds() }];
            } else {
                regions = [{ area: null, bounds: map.getBounds() }];
            }

            let totalNew = 0;

            for (let i = 0; i < regions.length; i++) {
                const { area, bounds } = regions[i];
                const label = regions.length > 1 ? `พื้นที่ ${i + 1}/${regions.length}` : 'พื้นที่';

                // Guard against querying an enormous area
                const km2 = approxAreaKm2(bounds);
                if (km2 > 60) {
                    showStatus(`⚠️ ${label} กว้างเกินไป (~${Math.round(km2)} ตร.กม.) — ซูมเข้าหรือวาดพื้นที่ให้เล็กลง`);
                    continue;
                }

                pText.textContent = `${label}: ดึงข้อมูลอาคาร...`;
                fill.style.width = (10 + (i / regions.length) * 80) + '%';

                const s = bounds.getSouth(), w = bounds.getWest(), n = bounds.getNorth(), e = bounds.getEast();
                const query =
                    `[out:json][timeout:60];` +
                    `(way["building"](${s},${w},${n},${e});` +
                    `relation["building"](${s},${w},${n},${e}););` +
                    `out center;`;

                const elements = await overpassFetch(query);

                let added = 0;
                for (const el of elements) {
                    const c = el.center || (el.type === 'node' ? { lat: el.lat, lon: el.lon } : null);
                    if (!c) continue;
                    const latlng = L.latLng(c.lat, c.lon);
                    // Keep only buildings whose centroid falls inside the drawn area
                    if (area && !latLngInArea(latlng, area)) continue;

                    const marker = L.marker(latlng, {
                        icon: L.divIcon({ className: 'map-marker', iconSize: [10, 10], iconAnchor: [5, 5] })
                    }).addTo(buildingMarkers);
                    marker._areaLayer = area;
                    added++;
                }

                detectedCount += added;
                totalNew += added;

                if (area && area !== radiusCircle) {
                    area._detected = true;
                    area._detectSource = 'osm';
                    area._detectedCount = added;
                    if (area.setStyle) area.setStyle({ color: '#10b981', fillColor: '#10b981' });
                }
            }

            fill.style.width = '100%';
            pText.textContent = `เสร็จ! พบ ${totalNew} อาคาร`;

            if (totalNew > 0) undoStackMap.push({ type: 'detection', count: totalNew });

            updateCounter(); updateResults(); updateUndoMap();

            if (totalNew === 0) {
                showStatus('ไม่พบอาคารใน OpenStreetMap สำหรับพื้นที่นี้ — อาจยังไม่มีคนแมป ลองใช้ตรวจจับจากภาพแทน');
            } else {
                showStatus(`🏢 OpenStreetMap: พบ ${totalNew} อาคาร (รวมทั้งหมด ${detectedCount} หลัง)`);
            }
        } catch (err) {
            console.error('OSM error:', err);
            showStatus('⚠️ ดึงข้อมูล OSM ไม่ได้: ' + err.message + ' — ลองใหม่อีกครั้งใน 1-2 นาที');
        }

        resetOsmBtn();
    }

    // Try multiple Overpass mirrors for reliability
    async function overpassFetch(query) {
        const endpoints = [
            'https://overpass-api.de/api/interpreter',
            'https://overpass.kumi.systems/api/interpreter',
            'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
        ];
        let lastErr;
        for (const ep of endpoints) {
            try {
                const res = await fetch(ep, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: 'data=' + encodeURIComponent(query)
                });
                if (!res.ok) { lastErr = new Error('HTTP ' + res.status); continue; }
                const json = await res.json();
                return json.elements || [];
            } catch (e) { lastErr = e; }
        }
        throw lastErr || new Error('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้');
    }

    function resetOsmBtn() {
        detecting = false;
        const btn = document.getElementById('btn-osm');
        btn.disabled = false;
        btn.textContent = '🏢 นับอาคารจาก OSM';
        setTimeout(() => {
            const bar = document.getElementById('osm-progress-bar');
            if (bar) bar.style.display = 'none';
        }, 1500);
    }

    // Approx area of a lat/lng bounds in km²
    function approxAreaKm2(bounds) {
        const s = bounds.getSouth(), n = bounds.getNorth(), w = bounds.getWest(), e = bounds.getEast();
        const h = map.distance(L.latLng(s, w), L.latLng(n, w)) / 1000;
        const wid = map.distance(L.latLng(s, w), L.latLng(s, e)) / 1000;
        return h * wid;
    }

    // Is a latlng inside a drawn area (circle / polygon / rectangle)?
    function latLngInArea(latlng, area) {
        if (area instanceof L.Circle) {
            return map.distance(latlng, area.getLatLng()) <= area.getRadius();
        }
        if (area instanceof L.Polygon) {
            return pointInPolygonLL(latlng, area.getLatLngs()[0]);
        }
        return true;
    }

    function pointInPolygonLL(p, ring) {
        let inside = false;
        const x = p.lng, y = p.lat;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const xi = ring[i].lng, yi = ring[i].lat;
            const xj = ring[j].lng, yj = ring[j].lat;
            if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
                inside = !inside;
            }
        }
        return inside;
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
                currentArea._detectSource = 'pixel';
                currentArea._detectedCount = areaDetected;
                // Change area style to show it's been processed
                if (currentArea.setStyle) {
                    currentArea.setStyle({ color: '#10b981', fillColor: '#10b981' });
                }
            }

            fill.style.width = '100%';
            pText.textContent = `เสร็จสิ้น! พบ ${detectedCount} หลังคา`;

            // Push detection as single undo-able action
            if (detectedCount > 0) {
                undoStackMap.push({ type: 'detection', count: detectedCount });
            }

            updateCounter();
            updateResults();
            updateUndoMap();
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
        const sSave = document.getElementById('btn-survey-save');
        if (sSave) sSave.disabled = total === 0;
        updateUndoMap();
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
