// ===== Survey Database (Phase 1: local IndexedDB) =====
// Copyright (c) 2025-2026 Kanyarat Saosomphop. All rights reserved.
// Stores one record per counting session. Storage-agnostic API so it can later
// be swapped for a cloud database (Supabase) without changing the app code.
//
// Record shape:
// {
//   id, created_at, updated_at,
//   label,                              // property / area name
//   center: { lat, lon }, zoom,
//   method,                             // 'open_buildings' | 'osm' | 'pixel' | 'manual' | 'mixed'
//   buildings_total, buildings_auto, buildings_manual,
//   people_per_household, population,
//   areas: [ {type:'circle',lat,lon,radius} | {type:'polygon',latlngs:[[lat,lon],...]} ],
//   points: [ [lat, lon, 'auto'|'manual'], ... ],
//   notes
// }
const SurveyDB = (function () {
    const DB_NAME = 'rooftop-survey';
    const STORE = 'surveys';
    const VERSION = 1;
    let _db = null;

    function open() {
        return new Promise((resolve, reject) => {
            if (_db) return resolve(_db);
            const req = indexedDB.open(DB_NAME, VERSION);
            req.onupgradeneeded = e => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    const s = db.createObjectStore(STORE, { keyPath: 'id' });
                    s.createIndex('updated_at', 'updated_at');
                }
            };
            req.onsuccess = e => { _db = e.target.result; resolve(_db); };
            req.onerror = e => reject(e.target.error);
        });
    }

    function tx(mode, fn) {
        return open().then(db => new Promise((resolve, reject) => {
            const t = db.transaction(STORE, mode);
            const store = t.objectStore(STORE);
            let out;
            const r = fn(store);
            if (r) r.onsuccess = () => { out = r.result; };
            t.oncomplete = () => resolve(out);
            t.onerror = e => reject(e.target.error);
        }));
    }

    function uid() {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }

    return {
        // Insert or update. New records get id + created_at; updated_at always refreshed.
        async save(rec) {
            const now = new Date().toISOString();
            if (!rec.id) { rec.id = uid(); rec.created_at = now; }
            rec.updated_at = now;
            await tx('readwrite', s => s.put(rec));
            return rec;
        },
        // All records, newest-updated first.
        async list() {
            const all = await tx('readonly', s => s.getAll());
            return (all || []).sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
        },
        async get(id) { return tx('readonly', s => s.get(id)); },
        async remove(id) { return tx('readwrite', s => s.delete(id)); },
        async clear() { return tx('readwrite', s => s.clear()); },

        // Backup / restore / migration helpers
        async exportAll() { return this.list(); },
        async importAll(records) {
            for (const r of records) { if (r && r.id) await tx('readwrite', s => s.put(r)); }
            return records.length;
        }
    };
})();

window.SurveyDB = SurveyDB;
