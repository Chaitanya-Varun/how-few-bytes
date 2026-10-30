// In-memory store for the laptop server: rooms are JSON strings with a version counter, so
// every read hands back a fresh copy and stale writes are refused just like Netlify Blobs.
const ROOM_TTL_MS = 12 * 60 * 60 * 1000;

export function memoryStore() {
	const rooms = new Map(); // code -> { json, version, touched }
	const images = new Map(); // key -> Uint8Array

	function prune() {
		const cutoff = Date.now() - ROOM_TTL_MS;
		for (const [code, r] of rooms) {
			if (r.touched > cutoff) continue;
			rooms.delete(code);
			for (const k of images.keys()) if (k.startsWith(`img/${code}/`)) images.delete(k);
		}
	}

	return {
		async getRoom(code) {
			const r = rooms.get(code);
			return r ? { room: JSON.parse(r.json), version: r.version } : null;
		},
		async putRoom(code, room, version) {
			const cur = rooms.get(code);
			if (version === null ? cur : cur?.version !== version) return false;
			rooms.set(code, { json: JSON.stringify(room), version: (cur?.version ?? 0) + 1, touched: Date.now() });
			if (version === null) prune();
			return true;
		},
		async putImage(key, bytes) {
			images.set(key, bytes);
		},
		async getImage(key) {
			return images.get(key) ?? null;
		},
	};
}
