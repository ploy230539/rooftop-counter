// ===== Cloud survey store (Phase 2: Supabase) =====
// Copyright (c) 2025-2026 Kanyarat Saosomphop. All rights reserved.
// Mirrors the SurveyDB API (save/list/remove/exportAll/importAll) but backed by a
// shared Supabase table, so the 2-person team shares one database across devices.
// Falls back silently (configured() === false) when not set up or SDK unavailable.
const CloudDB = (function () {
    let client = null;

    function cfg() { return window.CLOUD_CONFIG || {}; }

    // Ready only when config is filled AND the Supabase SDK loaded
    function configured() {
        const c = cfg();
        return !!(c.url && c.anonKey && window.supabase && window.supabase.createClient);
    }

    function getClient() {
        if (!configured()) return null;
        if (!client) client = window.supabase.createClient(cfg().url, cfg().anonKey);
        return client;
    }

    async function currentUser() {
        const c = getClient(); if (!c) return null;
        const { data } = await c.auth.getSession();
        return data && data.session ? data.session.user : null;
    }

    async function signIn(email, password) {
        const c = getClient(); if (!c) throw new Error('ยังไม่ได้ตั้งค่าคลาวด์');
        const { data, error } = await c.auth.signInWithPassword({ email, password });
        if (error) throw error;
        return data.user;
    }

    async function signOut() { const c = getClient(); if (c) await c.auth.signOut(); }

    function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

    async function save(rec) {
        const c = getClient(); if (!c) throw new Error('คลาวด์ไม่พร้อม');
        const now = new Date().toISOString();
        if (!rec.id) { rec.id = uid(); rec.created_at = now; }
        rec.updated_at = now;
        if (!rec.created_by) { const u = await currentUser(); if (u) rec.created_by = u.email; }
        const { error } = await c.from('surveys').upsert(rec);
        if (error) throw error;
        return rec;
    }

    async function list() {
        const c = getClient(); if (!c) return [];
        const { data, error } = await c.from('surveys').select('*').order('updated_at', { ascending: false });
        if (error) throw error;
        return data || [];
    }

    async function get(id) {
        const c = getClient(); if (!c) return null;
        const { data, error } = await c.from('surveys').select('*').eq('id', id).maybeSingle();
        if (error) throw error;
        return data;
    }

    async function remove(id) {
        const c = getClient(); if (!c) return;
        const { error } = await c.from('surveys').delete().eq('id', id);
        if (error) throw error;
    }

    async function importAll(records) {
        const c = getClient(); if (!c) return 0;
        if (!records.length) return 0;
        const { error } = await c.from('surveys').upsert(records);
        if (error) throw error;
        return records.length;
    }

    return {
        configured, currentUser, signIn, signOut,
        save, list, get, remove, exportAll: list, importAll
    };
})();

window.CloudDB = CloudDB;
