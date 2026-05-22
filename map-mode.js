// ===== Map Mode (AI Rooftop Detection + Manual Pins) =====
(function () {
    let map, drawnItems, buildingMarkers;
    let currentArea = null, manualMode = false;
    let manualPins = [];   // { marker, latlng }
    let detectedCount = 0;
    let mapInitialized = false;
    let detecting = false;
    let eraserMode = false;

    function initMap() {
        if (mapInitialized) return;
        mapInitialized = true;

        map = L.map('map').setView([13.7563, 100.5018], 15);

        L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
            { attribution: 'Esri', maxZoom: 19 }).addTo(map);

        drawnItems = new L.FeatureGroup().addTo(map);
        buildingMarkers = new L.FeatureGroup().addTo(map);

        const drawControl = new L.Control.Draw({
            position: 'topright',
            draw: {
                polygon: { shapeOptions: { color: '#f59e0b', weight: 3, fillOpacity: 0.1 } },
                rectangle: { shapeOptions: { color: '#f59e0b', weight: 3, fillOpacity: 0.1 } },
                circle: { shapeOptions: { color: '#f59e0b', weight: 3, fillOpacity: 0.1 } },
                polyline: false, marker: false, circlemarker: false
            },
            edit: { featureGroup: drawnItems, remove: true }
        });
        map.addControl(drawControl);

        map.on(L.Draw.Event.CREATED, e => {
            drawnItems.clearLayers(); buildingMarkers.clearLayers(); detectedCount = 0;
            currentArea = e.layer; drawnItems.addLayer(currentArea);
            document.getElementById('btn-count').disabled = false;
            updateCounter();
        });

        // --- Search ---
        setupSearch();

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
            if (eraserMode) toggleEraser(); // turn off eraser first
            manualMode = !manualMode;
            const btn = document.getElementById('btn-manual');
            btn.classList.toggle('active', manualMode);
            btn.textContent = manualMode ? '📌 ปักหมุด (กำลังใช้ — คลิกแผนที่)' : '📌 เปิดโหมดปักหมุด';
            map.getContainer().style.cursor = manualMode ? 'crosshair' : '';
            document.getElementById('btn-undo-map').style.display = manualMode ? 'block' : 'none';
            showStatus(manualMode ? 'คลิกหลังคา = เพิ่มหมุด (🟡) | คลิกหมุดเดิม = ลบ' : '');
        });

        document.getElementById('btn-eraser-map').addEventListener('click', toggleEraser);

        document.getElementById('btn-clear-ai-map').addEventListener('click', () => {
            buildingMarkers.clearLayers();
            detectedCount = 0;
            updateCounter(); updateResults();
            showStatus('ลบหมุด AI ทั้งหมดแล้ว');
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
            currentArea = null; detectedCount = 0; eraserMode = false;
            document.getElementById('btn-eraser-map').classList.remove('active');
            document.getElementById('btn-eraser-map').textContent = '🧹 โหมดลบหมุด AI';
            document.getElementById('btn-count').disabled = true;
            document.getElementById('results-panel').style.display = 'none';
            document.getElementById('map-pin-counter').style.display = 'none';
        });

        document.getElementById('avg-people-map').addEventListener('change', updateResults);
    }

    function toggleEraser() {
        if (manualMode) {
            // Turn off manual mode first
            manualMode = false;
            document.getElementById('btn-manual').classList.remove('active');
            document.getElementById('btn-manual').textContent = '📌 เปิดโหมดปักหมุด';
        }
        eraserMode = !eraserMode;
        const btn = document.getElementById('btn-eraser-map');
        btn.classList.toggle('active', eraserMode);
        btn.textContent = eraserMode ? '🧹 ลบหมุด (กำลังใช้ — คลิกหมุด)' : '🧹 โหมดลบหมุด AI';
        map.getContainer().style.cursor = eraserMode ? 'crosshair' : '';
        showStatus(eraserMode ? 'คลิกหมุด 🟢 เพื่อลบ (โหมดลบ)' : '');

        // Toggle click handlers on AI markers
        buildingMarkers.eachLayer(marker => {
            if (eraserMode) {
                marker._eraserHandler = function () {
                    buildingMarkers.removeLayer(marker);
                    detectedCount = Math.max(0, detectedCount - 1);
                    updateCounter(); updateResults();
                };
                marker.on('click', marker._eraserHandler);
                // Make cursor pointer on hover
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
    // ========================
    async function detectFromMap() {
        if (!currentArea || detecting) return;
        detecting = true;

        const btn = document.getElementById('btn-count');
        btn.disabled = true;
        btn.textContent = '⏳ กำลังตรวจจับ...';

        const bar = document.getElementById('map-progress-bar');
        const fill = document.getElementById('map-progress-fill');
        const pText = document.getElementById('map-progress-text');
        bar.style.display = 'block';
        fill.style.width = '0%';
        pText.textContent = 'เตรียมจับภาพ...';

        buildingMarkers.clearLayers();
        detectedCount = 0;

        try {
            const bounds = currentArea.getBounds();
            const zoom = map.getZoom();

            // Recommend zoom level
            if (zoom < 15) {
                showStatus('⚠️ แนะนำ zoom เข้าไปอีก (ระดับ 16-19) เพื่อความแม่นยำ');
            }

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
                showStatus('⚠️ พื้นที่ใหญ่เกินไป — กรุณา zoom เข้าหรือวาดพื้นที่เล็กลง');
                resetDetectBtn();
                return;
            }

            // --- Step 2: Download & stitch tiles ---
            pText.textContent = `โหลด tile 0/${totalTiles}`;
            fill.style.width = '5%';

            const stitchCanvas = document.createElement('canvas');
            stitchCanvas.width = tilesW * tileSize;
            stitchCanvas.height = tilesH * tileSize;
            const sCtx = stitchCanvas.getContext('2d');

            const tileUrlTemplate = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
            let loaded = 0;

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
                            pText.textContent = `โหลด tile ${loaded}/${totalTiles}`;
                            fill.style.width = (5 + (loaded / totalTiles) * 20) + '%';
                            resolve(true);
                        };
                        tileImg.onerror = () => { loaded++; resolve(false); };
                        tileImg.src = url;
                    }));
                }
            }

            await Promise.all(loadPromises);

            // --- Step 3: Crop to area bounds ---
            pText.textContent = 'ตัดภาพพื้นที่...';
            fill.style.width = '28%';

            const cropX = Math.round(nwPoint.x - minTX * tileSize);
            const cropY = Math.round(nwPoint.y - minTY * tileSize);
            const cropW = Math.max(1, Math.round(sePoint.x - nwPoint.x));
            const cropH = Math.max(1, Math.round(sePoint.y - nwPoint.y));

            const cropCanvas = document.createElement('canvas');
            cropCanvas.width = cropW;
            cropCanvas.height = cropH;
            const cCtx = cropCanvas.getContext('2d');
            cCtx.drawImage(stitchCanvas, -cropX, -cropY);

            const imageData = cCtx.getImageData(0, 0, cropW, cropH);

            // --- Step 4: Build area mask for circles ---
            let areaMask = null;
            if (currentArea instanceof L.Circle) {
                areaMask = new Uint8Array(cropW * cropH);
                const center = currentArea.getLatLng();
                const centerPx = map.project(center, zoom);
                const cxLocal = centerPx.x - nwPoint.x;
                const cyLocal = centerPx.y - nwPoint.y;

                // Convert radius (meters) to pixels
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
            }

            // --- Step 5: Run AI detector ---
            pText.textContent = 'กำลังตรวจจับหลังคา...';
            fill.style.width = '30%';

            await new Promise(resolve => setTimeout(resolve, 50)); // Let UI update

            const sensitivity = parseInt(document.getElementById('map-sensitivity').value) || 5;
            const minArea = getAutoMinArea(zoom);
            const maxArea = getAutoMaxArea(zoom);

            const results = RooftopDetector.detect(imageData, cropW, cropH, {
                sensitivity,
                minArea,
                maxArea,
                areaMask
            }, (pct, msg) => {
                const overall = 30 + pct * 0.65;
                fill.style.width = overall + '%';
                pText.textContent = msg;
            });

            // --- Step 6: Convert pixel coords → lat/lng → map markers ---
            pText.textContent = `ปักหมุด ${results.length} จุด...`;
            fill.style.width = '96%';

            detectedCount = 0;
            results.forEach(r => {
                const globalPx = L.point(nwPoint.x + r.x, nwPoint.y + r.y);
                const latlng = map.unproject(globalPx, zoom);

                // Extra check for circle containment
                if (currentArea instanceof L.Circle) {
                    if (currentArea.getLatLng().distanceTo(latlng) > currentArea.getRadius()) return;
                }

                detectedCount++;
                L.marker(latlng, {
                    icon: L.divIcon({ className: 'map-marker', iconSize: [10, 10], iconAnchor: [5, 5] })
                }).addTo(buildingMarkers);
            });

            fill.style.width = '100%';
            pText.textContent = `เสร็จสิ้น! พบ ${detectedCount} หลังคา`;

            updateCounter();
            updateResults();
            showStatus(`ตรวจจับพบ ${detectedCount} หลังคา — ปักหมุดเพิ่มได้ถ้าตกหล่น`);

        } catch (e) {
            console.error('Detection error:', e);
            showStatus('เกิดข้อผิดพลาด: ' + e.message);
        }

        resetDetectBtn();
    }

    function resetDetectBtn() {
        detecting = false;
        const btn = document.getElementById('btn-count');
        btn.disabled = !currentArea;
        btn.textContent = '🤖 ตรวจจับหลังคาอัตโนมัติ';
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
    //  Supports: Google Maps URL, coordinates, place name
    // ========================
    function setupSearch() {
        const input = document.getElementById('map-search');
        const btn = document.getElementById('btn-search');
        const resultsEl = document.getElementById('search-results');
        let searchTimeout = null;

        // Open Google Maps in new tab
        document.getElementById('btn-open-gmaps').addEventListener('click', () => {
            const c = map.getCenter();
            const z = map.getZoom();
            window.open(`https://www.google.com/maps/@${c.lat},${c.lng},${z}z`, '_blank');
        });

        async function doSearch() {
            const query = input.value.trim();
            if (!query) { resultsEl.classList.remove('show'); return; }

            // --- Try 1: Google Maps full URL (has coordinates) ---
            const gmResult = parseGoogleMapsUrl(query);
            if (gmResult) {
                goToLocation(gmResult.lat, gmResult.lng, gmResult.zoom, 'Google Maps URL');
                resultsEl.classList.remove('show');
                return;
            }

            // --- Try 2: Shortened Google Maps URL (goo.gl / maps.app.goo.gl) ---
            if (isShortGoogleUrl(query)) {
                // Open the short URL in a new tab → Google will redirect to full URL
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

            // --- Try 3: Raw coordinates (lat, lng) ---
            const coordResult = parseCoordinates(query);
            if (coordResult) {
                goToLocation(coordResult.lat, coordResult.lng, 17, 'พิกัด');
                resultsEl.classList.remove('show');
                return;
            }

            // --- Try 4: Text search via Nominatim ---
            searchNominatim(query);
        }

        function parseGoogleMapsUrl(text) {
            // Format: @lat,lng,zoomz
            let m = text.match(/@(-?\d+\.?\d*),(-?\d+\.?\d*),(\d+\.?\d*)z/);
            if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]), zoom: Math.round(parseFloat(m[3])) };

            // Format: /place/.../@lat,lng
            m = text.match(/@(-?\d+\.?\d*),(-?\d+\.?\d*)/);
            if (m && text.includes('google')) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]), zoom: 17 };

            // Format: ?q=lat,lng or &ll=lat,lng
            m = text.match(/[?&](?:q|ll|center)=(-?\d+\.?\d*),(-?\d+\.?\d*)/);
            if (m) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]), zoom: 17 };

            // Format: maps/dir/lat,lng
            m = text.match(/maps\/.*?(-?\d+\.\d{4,}),(-?\d+\.\d{4,})/);
            if (m && text.includes('google')) return { lat: parseFloat(m[1]), lng: parseFloat(m[2]), zoom: 17 };

            return null;
        }

        function isShortGoogleUrl(text) {
            return /maps\.app\.goo\.gl|goo\.gl\/maps/.test(text);
        }

        function parseCoordinates(text) {
            // "13.7563, 100.5018" or "13.7563 100.5018"
            const m = text.match(/^(-?\d+\.?\d*)[,\s]+(-?\d+\.?\d*)$/);
            if (m) {
                const a = parseFloat(m[1]), b = parseFloat(m[2]);
                // Validate lat/lng ranges
                if (Math.abs(a) <= 90 && Math.abs(b) <= 180) return { lat: a, lng: b };
                if (Math.abs(b) <= 90 && Math.abs(a) <= 180) return { lat: b, lng: a };
            }
            return null;
        }

        function goToLocation(lat, lng, zoom, source) {
            zoom = Math.min(Math.max(zoom, 10), 19);
            map.flyTo([lat, lng], zoom, { duration: 1.5 });
            showStatus(`📍 ไปยังพิกัด ${lat.toFixed(4)}, ${lng.toFixed(4)} (${source})`);
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
                        map.flyTo([lat, lon], zoom, { duration: 1.5 });
                        input.value = name;
                        resultsEl.classList.remove('show');
                        showStatus(`📍 ไปยัง: ${name}`);
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

        // Auto-detect paste (Google Maps URL, short URL, or coords → go immediately)
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
            // Don't auto-search URLs/coordinates — those go on Enter/paste
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
