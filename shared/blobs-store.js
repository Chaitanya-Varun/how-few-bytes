// Netlify Blobs store for the serverless deployment. Rooms are JSON blobs written with
// conditional writes (etag match, or must-be-new), so two players acting at once can't
// overwrite each other; the handler retries the loser.
export function blobsStore(store) {
	return {
		async getRoom(code) {
			const key = `room/${code}`;
			const r = await store.getWithMetadata(key, { type: "json", consistency: "strong" });
			if (!r) return null;
			if (r.etag) return { room: r.data, version: r.etag };
			// The local Blobs emulator sends no ETag on reads. Take it from a listing first, then
			// read again: if a write lands in between, the stale etag makes our write fail and retry
			const { blobs } = await store.list({ prefix: key });
			const etag = blobs.find((b) => b.key === key)?.etag ?? null;
			const data = await store.get(key, { type: "json", consistency: "strong" });
			return data ? { room: data, version: etag } : null;
		},
		async putRoom(code, room, version) {
			const opts = version ? { onlyIfMatch: version } : { onlyIfNew: true };
			const res = await store.setJSON(`room/${code}`, room, opts);
			return res?.modified !== false;
		},
		async putImage(key, bytes) {
			await store.set(key, bytes);
		},
		async getImage(key) {
			const b = await store.get(key, { type: "arrayBuffer", consistency: "strong" });
			return b ? new Uint8Array(b) : null;
		},
	};
}
